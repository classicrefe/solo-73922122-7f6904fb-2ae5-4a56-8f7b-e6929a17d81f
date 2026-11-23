"use strict";
/*
 * Pure reconciliation/diff helpers shared by the page and by the Node-based
 * unit tests.  No DOM, no fetch: everything here is deterministic so the
 * interleaved-write rules can be tested without a browser.
 *
 * Model of the page:
 *   - every write (sample verdict or label-cut correction) gets a local,
 *     monotonically increasing ``order`` at submit time, and the request
 *     carries a ``req_id`` echoed back by the server;
 *   - the server returns, inside the same write transaction, the two
 *     immediately adjacent committed reports for that exact write
 *     (``before``/``after``) plus the shift ``epoch`` the write belongs to;
 *   - the main report always reflects the newest *current-epoch* state seen;
 *   - the "before/after" panel shows the write with the greatest submit order
 *     among receipts that arrived successfully (late receipts of older writes
 *     therefore never overwrite a newer comparison), and a receipt whose
 *     epoch is stale still renders, clearly marked as an old shift.
 */

const EMPTY = "未录入";
const DASH = "–";

function fmtNum(n) {
  if (n === null || n === undefined) return DASH;
  return Number(n).toLocaleString("zh-CN");
}

function segText(seg) {
  if (!seg) return null;
  return `#${fmtNum(seg.start)} – #${fmtNum(seg.end)}`;
}

// One ordered list of rows for every snapshot, including the pre-label state,
// so before and after always line up row for row.
function diffRows(summary) {
  if (!summary || !summary.initialized || summary.label_missing) {
    return [
      ["换标号", EMPTY],
      ["必错号段", DASH],
      ["仅部分切点错标", DASH],
      ["错标瓶数上下界", DASH],
      ["候选切点", DASH],
    ];
  }
  return [
    ["换标号", "#" + fmtNum(summary.label_cut)],
    ["必错号段", summary.must ? `${segText(summary.must)}（${fmtNum(summary.must.count)} 瓶）` : "无"],
    ["仅部分切点错标", summary.partial ? `${segText(summary.partial)}（${fmtNum(summary.partial.count)} 瓶）` : "无"],
    ["错标瓶数上下界", `${fmtNum(summary.bounds.min)} – ${fmtNum(summary.bounds.max)} 瓶`],
    ["候选切点", `#${fmtNum(summary.candidates.first)} – #${fmtNum(summary.candidates.last)}（${fmtNum(summary.candidates.count)} 个）`],
  ];
}

// Highlight only rows whose value actually differs between THIS write's own
// adjacent snapshots -- another window's edits are simply not present here.
function changedRowIndexes(before, after) {
  const left = diffRows(before);
  const right = diffRows(after);
  const indexes = new Set();
  for (let i = 0; i < right.length; i += 1) {
    if (left[i][1] !== right[i][1]) indexes.add(i);
  }
  return indexes;
}

function isFirstLabelEntry(before, after) {
  return Boolean(
    before && after &&
    (before.label_missing || !before.initialized) &&
    after.initialized && !after.label_missing
  );
}

function describeWrite(record) {
  if (!record) return "";
  if (record.kind === "label") {
    const to = `#${fmtNum(record.label_cut)}`;
    return isFirstLabelEntry(record.before, record.after)
      ? `首次补录换标号 → ${to}`
      : `更正换标号 → ${to}`;
  }
  const verdictText = { old: "旧配方", new: "新配方", pending: "待核" };
  return `#${fmtNum(record.bottle)} 留样补判 → ${verdictText[record.verdict] || record.verdict}`;
}

// Decide whether a receipt belongs to a shift the page has since left behind.
function isStaleEpoch(epoch, currentEpoch) {
  return Boolean(epoch && currentEpoch && epoch !== currentEpoch);
}

/*
 * Maintain the page's write bookkeeping.  ``state.pending`` maps req_id ->
 * {order, kind, ...}; ``state.records`` holds received successful receipts.
 */
function registerWrite(state, request) {
  state.seq += 1;
  const reqId = `w-${Date.now().toString(36)}-${state.seq}`;
  const entry = Object.assign({ order: state.seq, reqId: reqId }, request);
  state.pending.set(reqId, entry);
  return reqId;
}

function _recordFromResponse(state, payload, kind, requestMeta) {
  const pending = state.pending.get(payload.req_id) || requestMeta || {};
  // An unknown req_id (e.g. a receipt outliving a page reload) gets order 0 so
  // it can still render its own diff but never preempts a write started here.
  return {
    reqId: payload.req_id,
    order: typeof pending.order === "number" ? pending.order : 0,
    kind,
    bottle: pending.bottle,
    verdict: pending.verdict,
    label_cut: pending.label_cut,
    before: payload.before,
    after: payload.after || payload.summary,
    epoch: payload.epoch ||
      (payload.after && payload.after.state && payload.after.state.epoch) ||
      (payload.summary && payload.summary.state && payload.summary.state.epoch) ||
      "",
    receivedAt: Date.now(),
  };
}

// Apply a successful receipt.  Returns instructions for the caller:
//   report:      summary to render as the main report (or null to leave it),
//   record:      the stored comparison record,
//   showDiff:    whether this record is the one the diff panel must show,
//   staleEpoch:  the receipt belongs to an already replaced shift.
function acceptReceipt(state, payload, kind, currentEpoch) {
  const record = _recordFromResponse(state, payload, kind, null);
  state.pending.delete(record.reqId);
  state.records.push(record);
  if (state.records.length > 20) state.records.splice(0, state.records.length - 20);

  const stale = isStaleEpoch(record.epoch, currentEpoch);
  // Latest initiated write that has a successful receipt wins the panel.
  const maxOrder = state.records.reduce((m, r) => Math.max(m, r.order), -1);
  const showDiff = record.order === maxOrder;

  // Main report follows actual commit order: a late receipt for an older
  // commit (or one this page never registered, whose order fell back to 0)
  // must never roll the page back from a newer one.  The caller owns
  // state.report and applies this (non-null) snapshot itself.
  let report = null;
  if (!stale && record.order > 0 &&
      (!state.report || record.after.version >= state.report.version)) {
    report = record.after;
  }
  return { report, record, showDiff, staleEpoch: stale };
}

// A failed write never enters the comparison list; the committed report is
// only adopted when it still belongs to the current shift and is not older
// than what the page already shows.
function handleFailure(state, payload, currentEpoch) {
  state.pending.delete(payload && payload.req_id);
  if (!payload || !payload.summary) return { report: null, staleEpoch: false };
  const summary = payload.summary;
  const epoch = payload.epoch ||
    (summary.state && summary.state.epoch) || "";
  const stale = isStaleEpoch(epoch, currentEpoch);
  if (stale) return { report: null, staleEpoch: true };
  if (state.report && summary.version < state.report.version) {
    return { report: null, staleEpoch: false };
  }
  return { report: summary, staleEpoch: false };
}

// Reset/import/demo start a new shift on the page: old pending requests stay
// registered so their late receipts can still be classified by epoch.
function beginEpoch(state, summary) {
  const epoch = (summary && summary.state && summary.state.epoch) ||
    (summary && summary.epoch) || "";
  state.currentEpoch = epoch;
  state.records = [];
  state.report = summary;
  return epoch;
}

function latestRecord(state) {
  if (!state.records.length) return null;
  return state.records.reduce((a, b) => (a.order >= b.order ? a : b));
}

function createWriteState() {
  return { seq: 0, pending: new Map(), records: [], report: null, currentEpoch: "" };
}

const api = {
  EMPTY,
  fmtNum,
  segText,
  diffRows,
  changedRowIndexes,
  isFirstLabelEntry,
  describeWrite,
  isStaleEpoch,
  registerWrite,
  acceptReceipt,
  handleFailure,
  beginEpoch,
  latestRecord,
  createWriteState,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.RelabelDiff = api;
}

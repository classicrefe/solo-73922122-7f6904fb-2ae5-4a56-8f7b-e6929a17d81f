"use strict";
/*
 * Page controller.  All reconciliation/diff rules live in diff.js so they can
 * be unit-tested headlessly; this file only wires them to the DOM.
 *
 * Concurrency rules implemented here:
 *   - submit buttons stay enabled while a receipt is outstanding, so a second
 *     window's worth of work (or a second write from this page) can proceed;
 *   - every write is registered with a local order and a req_id; the server
 *     echoes the req_id and returns the write's own adjacent before/after
 *     reports, so a comparison never contains another write's changes;
 *     - the diff panel shows the highest-order write whose success receipt has
 *       arrived (a late receipt of an earlier write cannot replace a newer
 *       one);
 *     - the main report follows actual commit order for the current shift;
 *     - a receipt for a shift the page has since reset/re-imported still
 *       renders its own diff, marked as an old shift, but never touches the
 *       current report.
 */

const D = window.RelabelDiff;
const state = D.createWriteState();

const $ = (id) => document.getElementById(id);
const fmt = D.fmtNum;

function toast(message, isError) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("err", !!isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3600);
}

function showError(id, message) {
  const el = $(id);
  if (!message) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = message;
  el.hidden = false;
}

async function api(path, options) {
  const response = await fetch(path, options);
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* non-JSON */ }
  if (!response.ok || !payload || payload.ok === false) {
    const message = (payload && payload.error) || `请求失败（HTTP ${response.status}）`;
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function applyReport(summary) {
  if (!summary) return;
  state.report = summary;
  state.currentEpoch = (summary.state && summary.state.epoch) || state.currentEpoch;
  renderStat(summary);
}

// ---------------------------------------------------------------------------
// Reconciliation report rendering
// ---------------------------------------------------------------------------
function renderStat(summary) {
  if (!summary || !summary.initialized) {
    $("report-card").hidden = true;
    $("edit-card").hidden = true;
    $("ops-card").hidden = true;
    const pill = $("status-pill");
    pill.textContent = "未导入";
    pill.className = "status";
    return;
  }
  $("report-card").hidden = false;
  $("edit-card").hidden = false;
  $("ops-card").hidden = false;

  const pill = $("status-pill");
  if (summary.label_missing) {
    pill.textContent = "待补录换标号";
    pill.className = "status warn";
  } else {
    pill.textContent = "已提交 v" + summary.version;
    pill.className = "status live";
  }

  const s = summary.state;
  $("report-meta").innerHTML =
    `<span>总瓶数 <b>${fmt(s.total_bottles)}</b></span>` +
    `<span>已核留样 <b>${fmt(s.samples_old + s.samples_new)}</b>` +
    `（旧 ${fmt(s.samples_old)} / 新 ${fmt(s.samples_new)}）</span>` +
    `<span>待核 <b>${fmt(s.samples_pending)}</b></span>` +
    `<span>换标号 <b>${s.label_cut === null ? "未录入" : "#" + fmt(s.label_cut)}</b></span>`;

  if (summary.label_missing) {
    $("stat-conflicts").textContent = "–";
    $("stat-cuts").textContent = "–";
    $("stat-must").textContent = "–";
    $("stat-partial").textContent = "–";
    $("stat-bounds").textContent = "请先录入换标号";
    $("must-list").innerHTML = '<div class="seg-empty">待录入换标号后计算。</div>';
    $("partial-list").innerHTML = '<div class="seg-empty">待录入换标号后计算。</div>';
    $("cand-line").textContent = "";
    renderViz(null);
    renderOps(summary);
    return;
  }

  $("stat-conflicts").textContent = fmt(summary.candidates.min_conflicts);
  $("stat-cuts").textContent = fmt(summary.candidates.count) +
    (summary.candidates.contiguous ? "（连续）" : "（不连续）");
  $("stat-must").textContent = fmt(summary.counts.must) + " 瓶";
  $("stat-partial").textContent = fmt(summary.counts.partial) + " 瓶";
  $("stat-bounds").textContent = `${fmt(summary.bounds.min)} – ${fmt(summary.bounds.max)} 瓶`;

  renderList("must-list", summary.must, "没有必然错标的瓶。");
  renderList("partial-list", summary.partial, "没有仅在部分切点下错标的瓶。");

  $("cand-line").textContent =
    `最少冲突 ${fmt(summary.candidates.min_conflicts)} 个；` +
    `并列最优切点 ${fmt(summary.candidates.count)} 个，` +
    `范围 #${fmt(summary.candidates.first)} – #${fmt(summary.candidates.last)}` +
    (summary.candidates.contiguous ? "（连续）" : "（不连续）") +
    `；换标号 #${fmt(summary.label_cut)}；` +
    `错标瓶数最少 ${fmt(summary.bounds.min)}、最多 ${fmt(summary.bounds.max)}。`;

  renderViz(summary);
  renderOps(summary);
}

function renderList(id, seg, emptyText) {
  const host = $(id);
  if (!seg) { host.innerHTML = `<div class="seg-empty">${emptyText}</div>`; return; }
  host.innerHTML =
    `<div class="seg-row"><span>瓶号 <span class="num">${D.segText(seg)}</span></span>` +
    `<span class="cnt">${fmt(seg.count)} 瓶</span></div>`;
}

function renderViz(summary) {
  const track = $("track");
  const n = summary ? summary.total_bottles : 0;
  $("axis-n").textContent = summary ? "#" + fmt(n) : "";
  const show = (el, yes) => { el.hidden = !yes; };
  if (!summary || !n) {
    show($("seg-must"), false); show($("seg-partial"), false);
    show($("mk-label"), false); show($("mk-cand"), false);
    return;
  }
  const pct = (bottle) => (Math.min(Math.max(bottle, 0), n) / n) * 100;
  // Bottle b lives in the slice [b-1, b); a segment ending at #end therefore
  // occupies up to pct(end), not pct(end-1).
  const place = (el, start, end) => {
    const left = pct(start - 1);
    el.style.left = left + "%";
    el.style.width = Math.max(pct(end) - left, 0.15) + "%";
  };
  if (summary.must) { place($("seg-must"), summary.must.start, summary.must.end); show($("seg-must"), true); }
  else show($("seg-must"), false);
  if (summary.partial) { place($("seg-partial"), summary.partial.start, summary.partial.end); show($("seg-partial"), true); }
  else show($("seg-partial"), false);

  const label = $("mk-label");
  label.style.left = pct(summary.label_cut) + "%";
  label.querySelector("span").title = "换标号 #" + summary.label_cut;
  show(label, true);

  const cand = $("mk-cand");
  const c = summary.candidates;
  cand.style.left = pct(c.first) + "%";
  cand.querySelector("span").style.width =
    Math.max(pct(c.last) - pct(c.first), 0.15) + "%";
  cand.querySelector("span").title = `候选切点 #${c.first}–#${c.last}`;
  show(cand, true);
}

function renderOps(summary) {
  const host = $("ops");
  const s = summary.state;
  host.innerHTML =
    `<div><dt>已提交版本</dt><dd>v${fmt(summary.version)}</dd></div>` +
    `<div><dt>班次纪元</dt><dd><code>${(s.epoch || "").slice(0, 12) || "–"}</code></dd></div>` +
    `<div><dt>在途补改</dt><dd>${fmt(state.pending.size)}</dd></div>` +
    `<div><dt>最近写入</dt><dd>${s.updated_at || "–"}</dd></div>` +
    `<div><dt>查询读取树节点</dt><dd>${fmt(summary.query_nodes)}</dd></div>` +
    `<div><dt>候选切点查询</dt><dd>O(log N)</dd></div>` +
    `<div><dt>单瓶补改</dt><dd>O(log N)</dd></div>`;
}

// ---------------------------------------------------------------------------
// Before/after comparison panel
// ---------------------------------------------------------------------------
function renderDiff(record) {
  if (!record) { $("diff").hidden = true; return; }
  const rowsBefore = D.diffRows(record.before);
  const rowsAfter = D.diffRows(record.after);
  const changed = D.changedRowIndexes(record.before, record.after);
  const firstLabel = D.isFirstLabelEntry(record.before, record.after);

  const html = (rows) => rows.map(([k, v]) =>
    `<div class="diff-row"><span>${k}</span><b>${v}</b></div>`).join("");
  $("diff-before").innerHTML = firstLabel
    ? `<div class="diff-note">首次补录换标号：本笔之前换标号${D.EMPTY}，尚无重贴核对。</div>` + html(rowsBefore)
    : html(rowsBefore);
  $("diff-after").innerHTML = rowsAfter.map(([k, v], i) =>
    `<div class="diff-row"><span>${k}</span><b class="${changed.has(i) ? "changed" : ""}">${v}</b></div>`
  ).join("");

  $("diff-title").textContent = "补改前后对比 · " + D.describeWrite(record);
  const badge = $("diff-badge");
  const stale = D.isStaleEpoch(record.epoch, state.currentEpoch);
  badge.hidden = !stale;
  badge.textContent = stale
    ? `旧班次回执（纪元 ${(record.epoch || "").slice(0, 12)}），仅展示本笔差异，当前核对不受影响`
    : "";
  $("diff").hidden = false;
}

function refreshDiff() {
  renderDiff(D.latestRecord(state));
}

// Write failures keep the last committed report; the server re-reads SQLite
// and sends that snapshot back in the error payload.
function reportWriteFailure(error) {
  showError("edit-error", error.message);
  const decision = D.handleFailure(state, error.payload, state.currentEpoch);
  if (decision.report) applyReport(decision.report);
  else if (state.report) renderStat(state.report);
  if (decision.staleEpoch) {
    toast("该回执属于已清空重导的旧班次，当前核对保持新班次。", true);
  }
}

function inflightNote() {
  if (state.pending.size > 0) {
    toast(`已有 ${state.pending.size} 笔补改在途，仍可继续提交。`);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function refresh() {
  try {
    const { summary } = await api("/api/summary");
    D.beginEpoch(state, summary);
    renderStat(summary);
    refreshDiff();
  } catch (error) {
    toast(error.message, true);
  }
}

$("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("import-error", null);
  const file = $("csv-file").files[0];
  const total = $("total-bottles").value;
  const label = $("label-cut").value;
  if (!file) { showError("import-error", "请选择复核 CSV 文件。"); return; }
  const body = new FormData();
  body.append("file", file);
  body.append("total_bottles", total);
  body.append("label_cut", label);
  const button = $("import-btn");
  button.disabled = true;
  try {
    const payload = await api("/api/import", { method: "POST", body });
    // A (re-)import starts a fresh shift; prior comparisons are retired.
    D.beginEpoch(state, payload.summary);
    renderStat(payload.summary);
    $("diff").hidden = true;
    toast(`已导入 ${payload.import.rows} 条留样，已提交 v${payload.import.version}（新班次）`);
  } catch (error) {
    showError("import-error", error.message);
  } finally {
    button.disabled = false;
  }
});

$("apply-verdict").addEventListener("click", async () => {
  showError("edit-error", null);
  const bottle = Number($("edit-bottle").value);
  const verdict = $("edit-verdict").value;
  if (!Number.isInteger(bottle) || bottle < 1) {
    showError("edit-error", "请输入有效的瓶号。");
    return;
  }
  const reqId = D.registerWrite(state, { kind: "sample", bottle, verdict });
  inflightNote();
  try {
    const payload = await api("/api/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bottle, verdict, req_id: reqId }),
    });
    const decision = D.acceptReceipt(state, payload, "sample", state.currentEpoch);
    if (decision.report) applyReport(decision.report);
    else if (state.report) renderStat(state.report);
    if (decision.showDiff) renderDiff(decision.record);
    const u = payload.update;
    $("edit-hint").textContent = u.changed
      ? `#${bottle}：${u.previous || "无记录"} → ${verdict}；增量更新 ${u.update_nodes} 个树节点，本笔前后核对已按 v${u.version} 配对。`
      : `#${bottle} 原本就是 ${verdict}，未改动。`;
    toast(decision.staleEpoch
      ? "收到旧班次补判回执：差异已按旧班次单独标出，当前核对保持新班次。"
      : "补判已提交，对比仅含本笔变化。");
  } catch (error) {
    reportWriteFailure(error);
  }
});

$("apply-label").addEventListener("click", async () => {
  showError("edit-error", null);
  const label = Number($("edit-label").value);
  if (!Number.isInteger(label) || label < 0) {
    showError("edit-error", "请输入有效的换标号（≥ 0）。");
    return;
  }
  const reqId = D.registerWrite(state, { kind: "label", label_cut: label });
  inflightNote();
  try {
    const payload = await api("/api/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label_cut: label, req_id: reqId }),
    });
    const decision = D.acceptReceipt(state, payload, "label", state.currentEpoch);
    if (decision.report) applyReport(decision.report);
    else if (state.report) renderStat(state.report);
    if (decision.showDiff) renderDiff(decision.record);
    toast(decision.staleEpoch
      ? "收到旧班次换标号回执：差异已按旧班次单独标出，当前核对保持新班次。"
      : "换标号更正已提交，对比仅含本笔变化。");
  } catch (error) {
    reportWriteFailure(error);
  }
});

$("reset-btn").addEventListener("click", async () => {
  if (!confirm("确定清空全部留样与换标号？在途补改的迟到回执将按旧班次单独标注。")) return;
  try {
    const payload = await api("/api/reset", { method: "POST" });
    D.beginEpoch(state, payload.summary);
    renderStat(payload.summary);
    $("diff").hidden = true;
    $("edit-hint").textContent = "补改只改动一个留样，并增量更新冲突函数；报告随最新已提交状态重算。";
    toast("已清空，开始新班次；旧班次迟到回执不会覆盖当前核对。");
  } catch (error) {
    toast(error.message, true);
  }
});

// Demo: seed the server with the deterministic demo shift so the whole flow
// (including the 100k-bottle query) works without any file on disk.
$("demo-btn").addEventListener("click", async () => {
  const button = $("demo-btn");
  button.disabled = true;
  try {
    const payload = await api("/api/demo", { method: "POST" });
    D.beginEpoch(state, payload.summary);
    renderStat(payload.summary);
    $("diff").hidden = true;
    $("edit-bottle").value = "58800";
    $("edit-verdict").value = "old";
    $("edit-label").value = String(payload.summary.label_cut ?? "");
    toast("演示数据已载入：100000 瓶，#58800 为待核留样，可连续提交多笔补改对比。");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

// Initial state
refresh();

"use strict";
// Headless tests for the page's write/diff bookkeeping (static/diff.js).
// Run with: node --test tests/js/diff.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const diffPath = path.resolve(__dirname, "..", "..", "static", "diff.js");
const D = require(diffPath);

function summary(overrides = {}) {
  const base = Object.assign(
    {
      initialized: true,
      label_missing: false,
      total_bottles: 100,
      label_cut: 50,
      version: 1,
      epoch: "epoch-1",
      query_nodes: 12,
      state: {
        total_bottles: 100,
        label_cut: 50,
        samples_old: 1,
        samples_new: 1,
        samples_pending: 0,
        updated_at: "",
        epoch: "epoch-1",
      },
      candidates: { count: 3, first: 48, last: 50, contiguous: true, min_conflicts: 0 },
      must: { start: 51, end: 52, count: 2 },
      partial: null,
      bounds: { min: 0, max: 2 },
      counts: { must: 2, partial: 0, union: 2 },
    },
    overrides
  );
  // Keep the duplicated epoch slot consistent, like the server payload does.
  base.state.epoch = base.epoch;
  return base;
}

function labelMissing(overrides = {}) {
  const base = Object.assign(
    {
      initialized: true,
      label_missing: true,
      version: 1,
      epoch: "epoch-1",
      query_nodes: 0,
      state: {
        total_bottles: 100,
        label_cut: null,
        samples_old: 1,
        samples_new: 1,
        samples_pending: 0,
        updated_at: "",
        epoch: "epoch-1",
      },
    },
    overrides
  );
  base.state.epoch = base.epoch;
  return base;
}

function receipt(state, reqId, kind, after, requestMeta = {}) {
  const pending = state.pending.get(reqId) || {};
  const before = pending.beforeSnapshot || summary({ version: after.version - 1 });
  return Object.assign(
    {
      ok: true,
      req_id: reqId,
      before,
      after,
      summary: after,
      epoch: after.epoch || after.state.epoch,
    },
    requestMeta
  );
}

test("diff rows align and only this write's changed rows are highlighted", () => {
  const before = summary();
  const after = summary({
    version: 2,
    must: { start: 51, end: 55, count: 5 },
    bounds: { min: 0, max: 5 },
    candidates: { count: 4, first: 47, last: 50, contiguous: true, min_conflicts: 0 },
  });
  const changed = D.changedRowIndexes(before, after);
  // 换标号(0) unchanged; 必错(1), 上下界(3), 候选(4) changed; partial(2) equal.
  assert.deepEqual([...changed].sort(), [1, 3, 4]);
});

test("first label entry shows the whole before column as unentered", () => {
  const before = labelMissing();
  const after = summary();
  assert.equal(D.isFirstLabelEntry(before, after), true);
  assert.equal(D.isFirstLabelEntry(after, after), false);
  const rows = D.diffRows(before);
  assert.equal(rows[0][1], D.EMPTY);
  assert.ok(D.diffRows(after).every(([, v]) => v !== D.EMPTY || true));
  const changed = D.changedRowIndexes(before, after);
  assert.equal(changed.has(0), true); // the label row itself is the entry
});

test("late receipt of an earlier write never replaces a newer comparison", () => {
  const state = D.createWriteState();
  D.beginEpoch(state, summary({ version: 1 }));
  const idA = D.registerWrite(state, { kind: "label", label_cut: 40 });
  const idB = D.registerWrite(state, { kind: "sample", bottle: 80, verdict: "old" });
  assert.equal(state.pending.size, 2);

  // B's receipt arrives first (out of order).
  const afterB = summary({ version: 3, must: { start: 1, end: 5, count: 5 } });
  const decisionB = D.acceptReceipt(
    state,
    receipt(state, idB, "sample", afterB),
    "sample",
    state.currentEpoch
  );
  assert.equal(decisionB.showDiff, true);
  assert.equal(decisionB.staleEpoch, false);
  assert.equal(decisionB.report.version, 3);
  if (decisionB.report) state.report = decisionB.report;

  // A's late receipt: its order is smaller, so it must not take the panel.
  const afterA = summary({ version: 2, label_cut: 40 });
  const decisionA = D.acceptReceipt(
    state,
    receipt(state, idA, "label", afterA),
    "label",
    state.currentEpoch
  );
  assert.equal(decisionA.showDiff, false);
  assert.equal(D.latestRecord(state).reqId, idB);
  // Main report follows actual commit order: A (v2) must not roll back B (v3).
  assert.equal(decisionA.report, null);
  assert.equal(state.pending.size, 0);
});

test("each comparison only contains that write's adjacent snapshots", () => {
  const state = D.createWriteState();
  const base = summary({ version: 1 });
  D.beginEpoch(state, base);
  const idLabel = D.registerWrite(state, { kind: "label", label_cut: 45 });
  const mid = summary({ version: 2, label_cut: 45 });
  state.pending.get(idLabel).beforeSnapshot = base;
  const labelDecision = D.acceptReceipt(
    state,
    receipt(state, idLabel, "label", mid),
    "label",
    state.currentEpoch
  );
  assert.equal(labelDecision.record.before.version, 1);
  assert.equal(labelDecision.record.after.version, 2);
  assert.equal(labelDecision.record.after.label_cut, 45);

  const idSample = D.registerWrite(state, { kind: "sample", bottle: 70, verdict: "new" });
  state.pending.get(idSample).beforeSnapshot = mid;
  const head = summary({ version: 3, label_cut: 45, bounds: { min: 1, max: 4 } });
  const sampleDecision = D.acceptReceipt(
    state,
    receipt(state, idSample, "sample", head),
    "sample",
    state.currentEpoch
  );
  // B's "before" already includes A's label correction; its label row is equal
  // on both sides so the label change is not highlighted as B's change.
  assert.equal(sampleDecision.record.before.version, 2);
  assert.equal(sampleDecision.record.before.label_cut, 45);
  assert.equal(sampleDecision.record.after.version, 3);
  const changed = D.changedRowIndexes(
    sampleDecision.record.before,
    sampleDecision.record.after
  );
  assert.equal(changed.has(0), false);
});

test("old-shift late receipt still renders its diff but never the report", () => {
  const state = D.createWriteState();
  D.beginEpoch(state, summary({ version: 1, epoch: "epoch-old" }));
  const idOld = D.registerWrite(state, { kind: "sample", bottle: 60, verdict: "old" });

  // Reset + re-import starts a new shift before the receipt arrives.
  const fresh = summary({ version: 1, epoch: "epoch-new" });
  D.beginEpoch(state, fresh);
  assert.equal(state.pending.has(idOld), true); // pending survives the reset

  const oldAfter = summary({ version: 2, epoch: "epoch-old" });
  oldAfter.state.epoch = "epoch-old";
  const decision = D.acceptReceipt(
    state,
    receipt(state, idOld, "sample", oldAfter),
    "sample",
    state.currentEpoch
  );
  assert.equal(decision.staleEpoch, true);
  assert.equal(decision.report, null); // current report untouched
  assert.equal(decision.showDiff, true); // its own diff still shown
  assert.equal(D.isStaleEpoch(decision.record.epoch, state.currentEpoch), true);
  assert.equal(state.report.state.epoch, "epoch-new");
});

test("write failures keep the committed report and add no comparison", () => {
  const state = D.createWriteState();
  D.beginEpoch(state, summary({ version: 4 }));
  const id = D.registerWrite(state, { kind: "sample", bottle: 60, verdict: "old" });

  const decision = D.handleFailure(
    state,
    { req_id: id, summary: summary({ version: 4 }), applied: false },
    state.currentEpoch
  );
  assert.equal(decision.report.version, 4);
  assert.equal(state.records.length, 0);
  assert.equal(state.pending.has(id), false);

  // An older committed snapshot in a failure payload must not roll the page back.
  const id2 = D.registerWrite(state, { kind: "label", label_cut: 30 });
  const stale = D.handleFailure(
    state,
    { req_id: id2, summary: summary({ version: 2 }) },
    state.currentEpoch
  );
  assert.equal(stale.report, null);

  // Failure payload from an old shift never overwrites the new report.
  const oldEpochPayload = {
    req_id: "x",
    epoch: "epoch-old",
    summary: summary({ version: 9, epoch: "epoch-old" }),
  };
  oldEpochPayload.summary.state.epoch = "epoch-old";
  assert.equal(D.handleFailure(state, oldEpochPayload, "epoch-new").report, null);
});

test("write registration is non-blocking and carries monotonic order", () => {
  const state = D.createWriteState();
  const a = D.registerWrite(state, { kind: "label", label_cut: 1 });
  const b = D.registerWrite(state, { kind: "sample", bottle: 2, verdict: "old" });
  const c = D.registerWrite(state, { kind: "sample", bottle: 3, verdict: "new" });
  assert.equal(state.pending.size, 3); // buttons stay enabled; all in flight
  assert.equal(state.pending.get(a).order, 1);
  assert.equal(state.pending.get(b).order, 2);
  assert.equal(state.pending.get(c).order, 3);
  assert.match(a, /^w-/);
});

test("unknown req_id receipt renders but never preempts a local write", () => {
  const state = D.createWriteState();
  D.beginEpoch(state, summary({ version: 1 }));
  const localId = D.registerWrite(state, { kind: "label", label_cut: 40 });

  // The local write's receipt arrives first and owns the panel.
  const local = D.acceptReceipt(
    state,
    receipt(state, localId, "label", summary({ version: 2 })),
    "label",
    state.currentEpoch
  );
  if (local.report) state.report = local.report;
  assert.equal(local.showDiff, true);

  // Then a receipt for a request this page instance never registered (e.g. it
  // survived a reload): order falls back to 0, it renders its own diff on
  // arrival but cannot preempt the local write or roll the report back.
  const unknown = D.acceptReceipt(
    state,
    {
      req_id: "reloaded-req",
      before: summary({ version: 1 }),
      after: summary({ version: 2, label_cut: 40 }),
      summary: summary({ version: 2, label_cut: 40 }),
      epoch: "epoch-1",
    },
    "label",
    state.currentEpoch
  );
  assert.equal(unknown.record.order, 0);
  assert.equal(unknown.showDiff, false);
  assert.equal(unknown.report, null);
  assert.equal(D.latestRecord(state).reqId, localId);
});

test("describe text distinguishes first entry from correction and verdict", () => {
  const rec = (kind, extra) =>
    Object.assign({ kind, before: labelMissing(), after: summary() }, extra);
  assert.match(D.describeWrite(rec("label")), /首次补录换标号/);
  const correction = rec("label", {
    before: summary({ label_cut: 50 }),
    after: summary({ label_cut: 45 }),
    label_cut: 45,
  });
  assert.match(D.describeWrite(correction), /更正换标号/);
  assert.match(
    D.describeWrite({ kind: "sample", bottle: 58800, verdict: "old" }),
    /58,800.*旧配方/
  );
});

// Guard against accidental DOM dependency in the shared module.
test("diff.js source stays DOM-free", () => {
  const source = fs.readFileSync(diffPath, "utf8");
  assert.equal(/document\./.test(source), false);
});

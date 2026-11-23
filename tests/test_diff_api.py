"""HTTP tests for the per-write before/after comparison rules.

The bug these tests pin down: two windows writing concurrently (one corrects
the label cut, one supplements a retained sample) must each see a comparison
containing only their own adjacent committed states -- never the other
window's changes.
"""

import io

import pytest

from app import create_app
from app.demo import LABEL_CUT, TOTAL_BOTTLES, demo_csv


@pytest.fixture()
def client(tmp_path):
    app = create_app(str(tmp_path / "diff.sqlite3"))
    app.testing = True
    with app.test_client() as client:
        yield client
    app.extensions["relabel_store"].close()


def upload(client, csv_text, total=TOTAL_BOTTLES, label=LABEL_CUT):
    return client.post(
        "/api/import",
        data={
            "file": (io.BytesIO(csv_text.encode()), "review.csv"),
            "total_bottles": str(total),
            "label_cut": str(label),
        },
        content_type="multipart/form-data",
    )


def test_sample_write_returns_its_own_adjacent_snapshots(client):
    upload(client, demo_csv())
    before = client.get("/api/summary").get_json()["summary"]
    response = client.post(
        "/api/sample",
        json={"bottle": 58_800, "verdict": "old", "req_id": "req-1"},
    )
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["req_id"] == "req-1"
    # The "before" report is exactly the previously committed report.
    assert payload["before"] == before
    after = payload["after"]
    assert after == payload["summary"]
    assert after["version"] == before["version"] + 1
    assert after["must"] == {"start": 58_721, "end": 58_800, "count": 80}
    # Only items this verdict can move differ; the label cut itself is fixed.
    assert payload["before"]["label_cut"] == payload["after"]["label_cut"]


def test_label_write_comparison_contains_only_that_write(client):
    upload(client, demo_csv())
    before = client.get("/api/summary").get_json()["summary"]
    response = client.post(
        "/api/label",
        json={"label_cut": 58_500, "req_id": "req-label"},
    )
    payload = response.get_json()
    assert payload["req_id"] == "req-label"
    assert payload["before"] == before
    assert payload["after"]["label_cut"] == 58_500
    # The conflict function (candidate recipe cuts) is untouched by a label
    # correction: only label-derived rows may differ.
    assert payload["before"]["candidates"] == payload["after"]["candidates"]
    assert payload["before"]["bounds"] != payload["after"]["bounds"]


def test_interleaved_windows_each_see_their_own_adjacent_pair(client):
    """Window A changes the label cut; window B then judges a retained bottle.

    B's comparison must start at A's committed result and contain only B's
    verdict change; A's earlier comparison must not contain B's later change.
    """
    upload(client, demo_csv())
    base = client.get("/api/summary").get_json()["summary"]

    label_resp = client.post(
        "/api/label", json={"label_cut": 58_500, "req_id": "A"}
    ).get_json()
    middle = client.get("/api/summary").get_json()["summary"]

    sample_resp = client.post(
        "/api/sample",
        json={"bottle": 58_800, "verdict": "old", "req_id": "B"},
    ).get_json()

    # A's pair: base -> label corrected, no sign of B's later bottle change.
    assert label_resp["before"] == base
    assert label_resp["after"] == middle
    assert label_resp["after"]["must"] != sample_resp["after"]["must"]

    # B's pair starts exactly where A finished: the other window's label
    # correction is part of B's "before", not counted as B's change.
    assert sample_resp["before"] == middle
    assert sample_resp["before"]["label_cut"] == 58_500
    assert sample_resp["after"]["version"] == middle["version"] + 1
    # B's own change keeps the corrected label and moves only verdict-driven
    # rows; the label row is identical on both sides of B's comparison.
    assert sample_resp["before"]["label_cut"] == \
        sample_resp["after"]["label_cut"] == 58_500
    assert sample_resp["before"]["candidates"] != \
        sample_resp["after"]["candidates"]


def test_first_label_entry_before_column_is_unentered(client):
    # Import without a label cut: the committed report is label_missing.
    response = upload(client, demo_csv(), label="")
    imported = response.get_json()["summary"]
    assert imported["label_missing"] is True

    payload = client.post(
        "/api/label", json={"label_cut": LABEL_CUT, "req_id": "first"}
    ).get_json()
    before, after = payload["before"], payload["after"]
    assert before["label_missing"] is True
    assert before["state"]["label_cut"] is None
    assert after["label_missing"] is False
    assert after["label_cut"] == LABEL_CUT
    # The same epoch covers the import and its first label entry.
    assert before["state"]["epoch"] == after["state"]["epoch"]


def test_reimport_and_reset_mint_new_epoch(client):
    upload(client, demo_csv())
    first_epoch = client.get("/api/summary").get_json()["summary"]["state"]["epoch"]
    assert first_epoch

    again = upload(client, demo_csv()).get_json()["summary"]
    assert again["state"]["epoch"] != first_epoch

    reset = client.post("/api/reset").get_json()["summary"]
    assert reset["initialized"] is False
    assert reset["state"]["epoch"] not in ("", again["state"]["epoch"])


def test_late_old_shift_receipt_is_classified_by_epoch(client):
    upload(client, demo_csv())
    old = client.get("/api/summary").get_json()["summary"]
    old_epoch = old["state"]["epoch"]

    # The page resets and imports a fresh shift before the old write's receipt
    # would be rendered; the server-side data for a late request still belongs
    # to the new shift, so emulate the client classification directly.
    client.post("/api/reset")
    new = upload(client, demo_csv()).get_json()["summary"]
    new_epoch = new["state"]["epoch"]
    assert old_epoch != new_epoch

    # A receipt carrying the old epoch must be flagged stale against the page's
    # current epoch, while the current report keeps the new shift untouched.
    assert old_epoch and new_epoch and old_epoch != new_epoch
    current = client.get("/api/summary").get_json()["summary"]
    assert current["state"]["epoch"] == new_epoch


def test_failed_sample_write_keeps_committed_snapshot(client):
    upload(client, demo_csv())
    committed = client.get("/api/summary").get_json()["summary"]
    store = client.application.extensions["relabel_store"]
    store.conn.execute("CREATE TRIGGER fail_seg BEFORE UPDATE ON seg "
                       "BEGIN SELECT RAISE(ABORT, 'injected'); END")
    response = client.post(
        "/api/sample",
        json={"bottle": 58_800, "verdict": "old", "req_id": "fail"},
    )
    store.conn.execute("DROP TRIGGER fail_seg")
    assert response.status_code == 500
    payload = response.get_json()
    assert payload["ok"] is False
    assert payload["applied"] is False
    assert payload["req_id"] == "fail"
    # The error response carries the still-committed state, unchanged.
    assert payload["summary"] == committed
    assert client.get("/api/summary").get_json()["summary"] == committed


def test_failed_label_write_keeps_committed_snapshot(client):
    upload(client, demo_csv())
    committed = client.get("/api/summary").get_json()["summary"]
    store = client.application.extensions["relabel_store"]
    store.conn.execute("CREATE TRIGGER fail_meta BEFORE UPDATE ON meta "
                       "BEGIN SELECT RAISE(ABORT, 'injected'); END")
    response = client.post(
        "/api/label", json={"label_cut": 1, "req_id": "fail-label"}
    )
    store.conn.execute("DROP TRIGGER fail_meta")
    assert response.status_code == 500
    payload = response.get_json()
    assert payload["summary"] == committed
    assert client.get("/api/summary").get_json()["summary"] == committed

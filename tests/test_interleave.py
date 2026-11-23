"""Interleaved writes: each write's before/after snapshots must be exactly the
two adjacent committed reconciliation states for that write, even when two
"windows" interleave their submissions.
"""

import threading

from app.demo import LABEL_CUT, TOTAL_BOTTLES
from app.store import Store


def _demo_rows():
    from app.demo import demo_rows

    return demo_rows()


def test_each_write_returns_adjacent_snapshots_under_interleaving(tmp_path):
    store = Store(str(tmp_path / "interleave.sqlite3"))
    store.import_rows(TOTAL_BOTTLES, LABEL_CUT, _demo_rows())
    start = store.summary()
    assert start["version"] >= 1

    results = []
    errors = []

    def label_worker():
        try:
            info = store.set_label_cut(58_500)
            results.append(("label", info))
        except Exception as exc:  # pragma: no cover - failure path reporter
            errors.append(exc)

    def sample_worker():
        try:
            info = store.set_verdict(58_800, "old")
            results.append(("sample", info))
        except Exception as exc:  # pragma: no cover - failure path reporter
            errors.append(exc)

    t1 = threading.Thread(target=label_worker)
    t2 = threading.Thread(target=sample_worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    assert not errors

    assert len(results) == 2
    # Versions are consecutive and each pair is adjacent.
    infos = [info for _, info in results]
    versions = sorted(info["version"] for info in infos)
    assert versions[1] == versions[0] + 1
    for info in infos:
        assert info["after"]["version"] == info["version"]
        assert info["before"]["version"] == info["version"] - 1
        assert info["before"]["state"]["epoch"] == info["after"]["state"]["epoch"]

    # The earlier write's "after" is exactly the later write's "before":
    # nothing from another window can leak into either comparison.
    infos.sort(key=lambda i: i["version"])
    first, second = infos
    assert second["before"] == first["after"]
    assert first["before"]["version"] == start["version"]

    # Each snapshot is a real O(log N) report, never a replay of all bottles.
    for kind, info in results:
        assert 0 <= info["after"]["query_nodes"] < 400
        if kind == "sample":
            assert info["update_nodes"] < 200

    final = store.summary()
    assert final["version"] == versions[1]
    assert final == second["after"]
    store.close()


def test_snapshot_cost_is_sublinear_for_both_sizes(tmp_path):
    """The two in-transaction snapshots keep flat node counts as N grows."""
    from app.store import tree_size

    for n in (1_000, TOTAL_BOTTLES):
        store = Store(str(tmp_path / f"snap-{n}.sqlite3"))
        rows = [(b, "old" if b <= n // 2 else "new")
                for b in range(251, n + 1, 997)]
        store.import_rows(n, n // 2, rows)
        info = store.set_verdict(n // 2 + 5, "old")
        height = tree_size(n).bit_length()
        # Two reports, each O(height): allow a generous constant factor.
        assert info["after"]["query_nodes"] < 400
        assert info["before"]["query_nodes"] < 400
        assert info["update_nodes"] <= 4 * height
        store.close()

"""Browser app interactions without paid LLM calls or external chart requests."""
from pathlib import Path
from unittest.mock import MagicMock

import pytest


def test_stream_callback_preserves_finalization():
    from tradingagents.graph.trading_graph import TradingAgentsGraph
    graph = object.__new__(TradingAgentsGraph)
    graph.debug = False
    graph.config = {'portfolio_context': 'User holds 10 AMD shares'}
    graph.resolve_instrument_context = MagicMock(return_value="AMD")
    graph.propagator = MagicMock()
    graph.propagator.get_graph_args.return_value = {}
    graph.checkpoint_input = lambda state: state
    graph.graph = MagicMock()
    snapshots = [{"market_report": "Market evidence"}, {"final_trade_decision": "Rating: Hold"}]
    graph.graph.stream.return_value = (step for step in (((), "values", snapshot) for snapshot in snapshots))
    graph.record_decision = MagicMock()
    graph.clear_checkpoint_on_success = MagicMock()
    updates = []
    state, signal = graph._run_graph("AMD", "2026-10-16", on_update=updates.append)
    assert graph.propagator.create_initial_state.call_args.kwargs['portfolio_context'] == 'User holds 10 AMD shares'
    assert updates == snapshots
    assert state == {"market_report": "Market evidence", "final_trade_decision": "Rating: Hold"}
    assert signal == "Hold"
    graph.record_decision.assert_called_once_with("AMD", "2026-10-16", state)
    graph.clear_checkpoint_on_success.assert_called_once()


def test_portfolio_and_analysis(tmp_path, monkeypatch):
    pytest.importorskip("streamlit")
    from streamlit.testing.v1 import AppTest

    import webui.runtime as engine
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

    class FakeGraph:
        def __init__(self, *args, **kwargs):
            pass

        def propagate(self, ticker, day, **kwargs):
            state = {"market_report": f"Analysis of {ticker}", "final_trade_decision": "Hold"}
            kwargs["on_update"](state)
            return state, "Hold"

        def save_reports(self, *args):
            return tmp_path / "reports"

    monkeypatch.setattr(engine, "TradingAgentsGraph", FakeGraph)
    app = AppTest.from_file(Path(__file__).resolve().parents[1] / "webui/app.py").run(timeout=20)
    assert not app.exception
    app.text_input(key="ticker_input").set_value("MSFT").run()
    next(b for b in app.button if b.label == "Save").click().run()
    import json
    saved = tmp_path / ".tradingagents/webui/portfolio.json"
    assert "MSFT" in json.loads(saved.read_text())
    app.radio(key="saved_ticker").set_value("MSFT").run()
    assert app.text_input(key="ticker_input").value == "MSFT"
    next(b for b in app.button if b.label == "▶ Run analysis").click().run(timeout=20)
    assert not app.exception
    import time
    deadline = time.monotonic() + 10
    while not app.success and time.monotonic() < deadline:
        time.sleep(0.05)
        app.run()
    assert "MSFT: Hold" in app.success[0].value
    # A fresh browser session loads completed analysis from disk.
    refreshed = AppTest.from_file(Path(__file__).resolve().parents[1] / "webui/app.py").run(timeout=20)
    assert not refreshed.exception
    assert "MSFT: Hold" in refreshed.success[0].value
    assert any("Analysis of MSFT" in markdown.value for markdown in refreshed.markdown)
    next(b for b in app.button if b.label == "Remove").click().run()
    assert "MSFT" not in json.loads(saved.read_text())
    app.text_area[0].set_value("TSLA, amd, TSLA")
    next(b for b in app.button if b.label == "Save portfolio").click().run()
    assert json.loads(saved.read_text()) == ["TSLA", "AMD"]
    reopened = AppTest.from_file(Path(__file__).resolve().parents[1] / "webui/app.py").run(timeout=20)
    assert reopened.radio(key="saved_ticker").options == ["TSLA", "AMD"]
    assert "MSFT: Hold" in reopened.success[0].value


def test_history_survives_restart_and_keeps_separate_runs(tmp_path):
    from webui.runtime import RunManager
    from webui.storage import Store
    store = Store(tmp_path)
    config = {"llm_provider": "deepseek", "api_key": "never-save-this"}
    first = store.create("AMD", "2026-10-16", ["market"], config, "stock")
    store.update(first, state={"market_report": "saved evidence", "messages": ["private payload"]}, status="completed", signal="Hold")
    second = store.create("AMD", "2026-10-16", ["news"], config, "stock")
    restarted = Store(tmp_path)
    RunManager(restarted)
    assert len(restarted.history()) == 2
    assert restarted.get(first)["state"] == {"market_report": "saved evidence"}
    assert restarted.get(first)["status"] == "completed"
    assert restarted.get(second)["status"] == "interrupted"
    assert "api_key" not in restarted.get(first)["config"]


def test_bulk_portfolio_edit_is_durable_and_validated(tmp_path):
    from webui.storage import Store
    store = Store(tmp_path)
    store.write_portfolio(["msft", "AMD", "msft"])
    assert Store(tmp_path).read_portfolio() == ["MSFT", "AMD"]
    with pytest.raises(ValueError):
        store.write_portfolio(["bad ticker"])
    assert store.read_portfolio() == ["MSFT", "AMD"]
    store.write_portfolio([])
    assert Store(tmp_path).read_portfolio() == []


def test_refresh_reconnects_to_active_run(tmp_path, monkeypatch):
    pytest.importorskip("streamlit")
    import threading
    import time

    from streamlit.testing.v1 import AppTest

    import webui.runtime as runtime
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

    class SlowGraph:
        def __init__(self, *args, **kwargs):
            pass

        def propagate(self, *args, **kwargs):
            state = {"market_report": "Snapshot before refresh"}
            kwargs["on_update"](state)
            entered.set()
            release.wait(timeout=15)
            state["final_trade_decision"] = "Hold after refresh"
            return state, "Hold"

        def save_reports(self, *args):
            return tmp_path / "reports"

    monkeypatch.setattr(runtime, "TradingAgentsGraph", SlowGraph)
    path = Path(__file__).resolve().parents[1] / "webui/app.py"
    app = AppTest.from_file(path).run(timeout=20)
    try:
        next(b for b in app.button if b.label == "▶ Run analysis").click().run()
        assert entered.wait(timeout=5)
        refreshed = AppTest.from_file(path).run(timeout=20)
        assert not refreshed.exception
        assert any("Snapshot before refresh" in md.value for md in refreshed.markdown)
        assert any("Reconnects automatically" in info.value for info in refreshed.info)
        # A new browser cannot accidentally start a second worker.
        next(b for b in refreshed.button if b.label == "▶ Run analysis").click().run()
        assert any("Another analysis is running" in w.value for w in refreshed.warning)
    finally:
        release.set()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        refreshed.run()
        if refreshed.success:
            break
        time.sleep(.05)
    assert "Hold" in refreshed.success[0].value
    assert len(refreshed.selectbox(key="history_run").options) == 1

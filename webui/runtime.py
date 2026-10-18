"""Analysis workers outlive browser sessions; snapshots go straight to disk."""
import os
import threading

from langchain_core.callbacks import BaseCallbackHandler

from tradingagents.graph.trading_graph import TradingAgentsGraph


def safe_error(exc):
    message = f"{type(exc).__name__}: {exc}"
    for key, value in os.environ.items():
        if value and any(word in key.upper() for word in ("KEY", "TOKEN", "SECRET", "PASSWORD")):
            message = message.replace(value, "[redacted]")
    return message


class Activity(BaseCallbackHandler):
    def __init__(self, store, run_id):
        self.store, self.run_id = store, run_id

    def on_llm_start(self, serialized, prompts, **kwargs):
        self.store.update(self.run_id, activity="LLM request started")


class RunManager:
    def __init__(self, store, graph_factory=None):
        self.store = store
        self.graph_factory = graph_factory or TradingAgentsGraph
        self.lock = threading.Lock()
        self.active_id = None
        # No worker survives a server restart. Preserve its last snapshot.
        for record in store.history():
            if record["status"] == "running":
                store.update(record["id"], status="interrupted", error="Server restarted before this analysis finished. Start a new run to retry.")

    def start(self, ticker, day, analysts, config, asset_type):
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("Another analysis is running. Open it in history to follow its progress.")
        try:
            run_id = self.store.create(ticker, day, analysts, config, asset_type)
            self.active_id = run_id
            threading.Thread(target=self._run, args=(run_id, ticker, day, analysts, config.copy(), asset_type), daemon=True).start()
            return run_id
        except Exception:
            self.active_id = None
            self.lock.release()
            raise

    def _run(self, run_id, ticker, day, analysts, config, asset_type):
        try:
            seen = set()

            def update(state):
                self.store.update(run_id, state=state)
                for message in state.get("messages", []):
                    for call in getattr(message, "tool_calls", []):
                        identity = call.get("id") or repr(call)
                        if identity not in seen:
                            seen.add(identity)
                            self.store.update(run_id, activity=f"Tool: {call.get('name', 'tool')}")

            graph = self.graph_factory(analysts, config=config, callbacks=[Activity(self.store, run_id)])
            state, signal = graph.propagate(ticker, day, asset_type=asset_type, on_update=update)
            self.store.update(run_id, state=state)
            path = graph.save_reports(state, ticker)
            self.store.update(run_id, status="completed", signal=signal, report_path=str(path))
        except Exception as exc:
            self.store.update(run_id, status="failed", error=safe_error(exc))
        finally:
            self.active_id = None
            self.lock.release()

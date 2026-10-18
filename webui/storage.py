"""Local, transactional research history and atomic watchlist storage."""
import json
import re
import sqlite3
import tempfile
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

SYMBOL = re.compile(r"[A-Z0-9^][A-Z0-9.^=_:/-]{0,39}")
REPORT_KEYS = ("market_report", "sentiment_report", "news_report", "fundamentals_report", "investment_plan", "trader_investment_plan", "final_trade_decision", "investment_debate_state", "risk_debate_state", "company_of_interest", "trade_date", "portfolio_context")


def timestamp():
    return datetime.now(UTC).isoformat(timespec="seconds")


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.portfolio_path = self.root / "portfolio.json"
        self.database = self.root / "history.sqlite3"
        self.portfolio_lock = threading.RLock()
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, created_at TEXT NOT NULL, error TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, payload TEXT NOT NULL)")

    def get_setting(self, name):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM settings WHERE name=?", (name,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_setting(self, name, value):
        with self.connect() as db:
            db.execute("INSERT INTO settings VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload", (name, json.dumps(value)))

    def chat(self, run_id):
        with self.connect() as db:
            rows = db.execute("SELECT id, question, answer, status, error FROM chat_turns WHERE run_id=? ORDER BY rowid", (run_id,)).fetchall()
        return [{"id": r[0], "question": r[1], "answer": r[2], "status": r[3], "error": r[4]} for r in rows]

    def begin_turn(self, turn_id, run_id, question):
        with self.connect() as db:
            db.execute("INSERT INTO chat_turns(id,run_id,question,status,created_at) VALUES(?,?,?,?,?)", (turn_id, run_id, question, "streaming", timestamp()))

    def save_turn(self, turn_id, answer, status="streaming", error=None):
        with self.connect() as db:
            db.execute("UPDATE chat_turns SET answer=?,status=?,error=? WHERE id=?", (answer, status, error, turn_id))

    def recover_chat(self):
        with self.connect() as db:
            db.execute("UPDATE chat_turns SET status='interrupted', error='Server restarted during this response' WHERE status='streaming'")

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.database, timeout=30)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def create(self, ticker, day, analysts, config, asset_type):
        record = {"id": uuid4().hex, "created_at": timestamp(), "updated_at": timestamp(), "ticker": ticker, "day": day, "analysts": list(analysts), "asset_type": asset_type, "status": "running", "state": {}, "activity": [], "signal": None, "report_path": None, "error": None}
        # Never persist credentials or the caller's full configuration.
        record["config"] = {key: config.get(key) for key in ("llm_provider", "quick_think_llm", "deep_think_llm", "output_language", "max_debate_rounds", "max_risk_discuss_rounds")}
        if config.get('portfolio_context'):
            record['state']['portfolio_context'] = config['portfolio_context']
            record['holdings_snapshot'] = config.get('holdings_snapshot')
        with self.connect() as db:
            db.execute("INSERT INTO runs VALUES (?, ?, ?)", (record["id"], record["created_at"], json.dumps(record)))
        return record["id"]

    def get(self, run_id):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM runs WHERE id=?", (run_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def history(self):
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM runs ORDER BY created_at DESC, rowid DESC").fetchall()
        return [json.loads(row[0]) for row in rows]

    def update(self, run_id, *, state=None, activity=None, **fields):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise KeyError(run_id)
            record = json.loads(row[0])
            if state is not None:
                record["state"].update({key: state[key] for key in REPORT_KEYS if key in state})
            if activity is not None:
                record["activity"] = (record["activity"] + [activity])[-100:]
            record.update(fields, updated_at=timestamp())
            db.execute("UPDATE runs SET payload=? WHERE id=?", (json.dumps(record, default=str), run_id))

    def read_portfolio(self):
        with self.portfolio_lock:
            if not self.portfolio_path.exists():
                return ["AMD", "NVDA", "AAPL"]
            values = json.loads(self.portfolio_path.read_text())
            if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                raise ValueError("Portfolio must be a list of ticker strings")
            return values

    def write_portfolio(self, values):
        normalized = list(dict.fromkeys(value.strip().upper() for value in values if value.strip()))
        invalid = [value for value in normalized if not SYMBOL.fullmatch(value)]
        if invalid:
            raise ValueError("Invalid ticker: " + ", ".join(invalid))
        with self.portfolio_lock:
            with tempfile.NamedTemporaryFile(mode="w", dir=self.root, delete=False) as file:
                json.dump(normalized, file, indent=2)
                temporary = Path(file.name)
            try:
                temporary.replace(self.portfolio_path)
            finally:
                temporary.unlink(missing_ok=True)

    def save_ticker(self, ticker, remove=False):
        with self.portfolio_lock:
            values = self.read_portfolio()
            self.write_portfolio([value for value in values if value != ticker] if remove else values + [ticker])

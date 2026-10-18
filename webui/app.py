"""Local browser interface. Run: python -m streamlit run webui/app.py."""
import json
import re
import sys
from datetime import date
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tradingagents.default_config import DEFAULT_CONFIG
from webui.runtime import RunManager
from webui.storage import Store

st.set_page_config(page_title="TradingAgents", page_icon="📈", layout="wide")
REPORTS = {
    "market_report": "Market", "sentiment_report": "Sentiment",
    "news_report": "News", "fundamentals_report": "Fundamentals",
    "investment_plan": "Research decision", "trader_investment_plan": "Trader",
    "final_trade_decision": "Portfolio decision",
}
@st.cache_resource
def resources(root):
    store = Store(root)
    return store, RunManager(store)


store, manager = resources(str(Path.home() / ".tradingagents" / "webui"))
PORTFOLIO = store.portfolio_path
read_portfolio = store.read_portfolio
save_ticker = store.save_ticker


st.markdown("""<style>
[data-testid="stMainBlockContainer"] {padding:1rem 1.3rem 2rem; max-width:100%;}
[data-testid="stHeader"] {background:transparent; height:2rem;}
[data-testid="stAppDeployButton"] {display:none;}
h1 {font-size:1.35rem !important; letter-spacing:-.04em;}
h3 {font-size:1rem !important;}
[data-testid="stCaptionContainer"] {font-size:.75rem;}
[data-testid="stVerticalBlockBorderWrapper"] {border-radius:10px;}
[data-testid="stRadio"] label {padding:.45rem .35rem; border-bottom:1px solid #253044;}
[data-testid="stMetricValue"] {font-size:1.1rem;}
.terminal-brand {font-size:1.15rem;font-weight:750;letter-spacing:-.04em;color:#e8edf5;}
.terminal-kicker {font:11px monospace;letter-spacing:.14em;color:#8997ab;margin-bottom:7px;}
.terminal-top {display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #253044;padding:8px 0 18px;margin-bottom:16px;}
.terminal-badge {font:11px monospace;color:#5de4ba;border:1px solid #245b50;border-radius:5px;padding:6px 10px;}
</style><div class="terminal-top"><div><div class="terminal-kicker">MARKET INTELLIGENCE / LOCAL WORKSPACE</div><div class="terminal-brand">TradingAgents <span style="font-weight:400;color:#718096"> / Research terminal</span></div></div><div class="terminal-badge">● LOCAL ENGINE</div></div>""", unsafe_allow_html=True)

watchlist, workspace, settings_panel = st.columns([1, 3.5, 1.25], gap="medium")
with watchlist:
    with st.container(border=True):
        st.subheader("Watchlist")
        try:
            portfolio = read_portfolio()
        except (ValueError, OSError):
            st.error(f"Cannot read portfolio: {PORTFOLIO}")
            st.stop()

        def select_ticker():
            if st.session_state.saved_ticker:
                st.session_state.ticker_input = st.session_state.saved_ticker

        st.radio("Saved tickers", portfolio, index=None, key="saved_ticker", on_change=select_ticker, label_visibility="collapsed")
        st.divider()
        st.session_state.setdefault("ticker_input", "AMD")
        ticker = st.text_input("Analysis ticker / add ticker", key="ticker_input", placeholder="Add symbol, e.g. MSFT").strip().upper()
        valid = bool(re.fullmatch(r"[A-Z0-9^][A-Z0-9.^=_:/-]{0,39}", ticker))
        a, b = st.columns(2)
        if a.button("Save", disabled=not valid, use_container_width=True):
            save_ticker(ticker)
            st.rerun()
        if b.button("Remove", disabled=ticker not in portfolio, use_container_width=True):
            save_ticker(ticker, remove=True)
            st.rerun()
        st.caption(f"{len(portfolio)} saved symbols · Stored locally")
        with st.expander("Edit portfolio"):
            persisted_text = "\n".join(portfolio)
            if st.session_state.get("portfolio_editor_source") != persisted_text:
                st.session_state.portfolio_editor_text = persisted_text
                st.session_state.portfolio_editor_source = persisted_text
            with st.form("portfolio_editor"):
                edited = st.text_area("Portfolio tickers", key="portfolio_editor_text", help="One ticker per line, or separate with commas. Replace, add, remove, or reorder symbols.")
                if st.form_submit_button("Save portfolio"):
                    try:
                        store.write_portfolio(re.split(r"[\s,]+", edited))
                    except (ValueError, OSError) as exc:
                        st.error(str(exc))
                    else:
                        st.rerun()

    with st.container(border=True):
        st.caption("RESEARCH WORKSPACE")
        st.write("Watch → Analyze → Review")
        st.caption("Choose a symbol to open its chart. Run the analyst team to generate a research decision.")
        st.caption("Watch portfolio only. No broker connection.")

with settings_panel:
    with st.container(border=True):
        st.subheader("Analysis setup")
        st.caption("Configure the desk for this run")
        day = st.date_input("Analysis date", value=date.today(), max_value=date.today())
        analysts = st.multiselect("Analysts", ["market", "social", "news", "fundamentals"], default=["market", "news", "fundamentals"])
        depth = st.slider("Debate rounds", 1, 5, 1)
        with st.expander("Models & data", expanded=False):
            providers = ["deepseek", "openai", "anthropic", "google", "ollama", "openai_compatible"]
            default_provider = DEFAULT_CONFIG["llm_provider"]
            if default_provider not in providers:
                providers.append(default_provider)
            provider = st.selectbox("LLM provider", providers, index=providers.index(default_provider))
            quick = st.text_input("Quick model", DEFAULT_CONFIG["quick_think_llm"])
            deep = st.text_input("Deep model", DEFAULT_CONFIG["deep_think_llm"])
            backend = st.text_input("API endpoint (blank = provider default)", DEFAULT_CONFIG.get("backend_url") or "")
            asset_type = st.selectbox("Asset type", ["stock", "crypto"])
            language = st.selectbox("Report language", ["English", "Chinese"], index=1 if DEFAULT_CONFIG.get("output_language") == "Chinese" else 0)
        st.caption(f"{provider} · {quick}")
        start = st.button("▶ Run analysis", type="primary", disabled=not valid or not analysts or not quick or not deep, use_container_width=True)
        st.caption("Uses API keys from your local .env")
    with st.container(border=True):
        st.subheader("Team progress")
        team = st.empty()
        team.caption("Analysts → Research → Trader → Risk review")

with workspace:
    with st.container(border=True):
        title_col, date_col, model_col = st.columns([1.2, 1, 1.4])
        title_col.metric("INSTRUMENT", ticker or "—")
        date_col.metric("RESEARCH DATE", str(day))
        model_col.metric("DESK", "AI research")
        with st.expander("Chart settings", expanded=False):
            tv_symbol = st.text_input("TradingView symbol", ticker, help="For example NASDAQ:AMD, NYSE:IBM, or BINANCE:BTCUSDT")
            show_chart = st.toggle("Show TradingView chart", value=True)
        if show_chart:
            settings = json.dumps({"autosize": True, "symbol": tv_symbol, "interval": "D", "timezone": "Etc/UTC", "theme": "dark", "style": "1", "locale": "en", "allow_symbol_change": True, "calendar": False}).replace("<", "\\u003c").replace(">", "\\u003e")
            embed = getattr(st, "iframe", components.html)
            embed('<style>html,body{margin:0;height:360px;background:#0b1018}</style><div class="tradingview-widget-container" style="height:360px"><div class="tradingview-widget-container__widget" style="height:330px"></div><div class="tradingview-widget-copyright"><a href="https://www.tradingview.com/" target="_blank" rel="noopener">Charts by TradingView</a></div><script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>' + settings + '</script></div>', height=370)
        st.caption("TradingView · Live chart is independent of the research date · Data may be delayed")
    with st.container(border=True):
        st.subheader("Research & decisions")
        status = st.empty()
        progress = st.empty()
        reports_tab, activity_tab, details_tab = st.tabs(["Agent reports", "Live activity", "Run details"])
        with reports_tab:
            report = st.empty()
            report.info("Your research starts here. Choose a symbol and run the analyst team.")
        with activity_tab:
            activity = st.empty()
            activity.caption("LLM requests and tool activity will appear during analysis.")
        with details_tab:
            saved_details = st.empty()
            st.caption("The same Python graph powers the terminal and browser interfaces. Reports are saved on disk; the watchlist persists between launches.")
            st.caption("Research only. TradingView loads externally; API credentials stay on the local server.")

    def render(state, run_analysts):
        active_reports = {"market": "market_report", "social": "sentiment_report", "news": "news_report", "fundamentals": "fundamentals_report"}
        expected = [active_reports[key] for key in run_analysts] + ["investment_plan", "trader_investment_plan", "final_trade_decision"]
        completed = [key for key in expected if state.get(key)]
        progress.progress(len(completed) / len(expected), text=f"{len(completed)} / {len(expected)} report sections ready")
        investment = state.get("investment_debate_state") or {}
        risk = state.get("risk_debate_state") or {}
        stages = [(REPORTS[active_reports[key]], bool(state.get(active_reports[key]))) for key in run_analysts]
        stages += [("Bull researcher", bool(investment.get("bull_history"))), ("Bear researcher", bool(investment.get("bear_history"))), ("Research manager", bool(state.get("investment_plan"))), ("Trader", bool(state.get("trader_investment_plan"))), ("Aggressive risk", bool(risk.get("aggressive_history"))), ("Conservative risk", bool(risk.get("conservative_history"))), ("Neutral risk", bool(risk.get("neutral_history"))), ("Portfolio manager", bool(state.get("final_trade_decision")))]
        with team.container():
            for label, ready in stages:
                st.caption(f"{'✓' if ready else '○'}  {label}  ·  {'Ready' if ready else 'Waiting'}")
        with report.container():
            if state.get("company_of_interest"):
                st.caption(f"Research: {state['company_of_interest']} · {state.get('trade_date', '')}")
            for key, label in REPORTS.items():
                if state.get(key):
                    with st.expander(label, expanded=key == "final_trade_decision"):
                        st.markdown(str(state[key]))

    if start:
        config = DEFAULT_CONFIG.copy()
        config.update(llm_provider=provider, quick_think_llm=quick, deep_think_llm=deep, backend_url=backend or None, output_language=language, max_debate_rounds=depth, max_risk_discuss_rounds=depth)
        try:
            run_id = manager.start(ticker, day.isoformat(), analysts, config, asset_type)
        except (RuntimeError, OSError) as exc:
            st.warning(str(exc))
        else:
            st.session_state.history_run = run_id

    history = store.history()
    if history:
        records = {record["id"]: record for record in history}
        st.selectbox(
            "Analysis history", list(records), key="history_run",
            format_func=lambda run_id: f"{records[run_id]['ticker']} · {records[run_id]['day']} · {records[run_id]['created_at']} · {run_id[:6]}",
            help="Saved on this computer. Refreshing or restarting the UI keeps previous analyses.",
        )

        @st.fragment(run_every=1)
        def show_saved_run(run_id):
            record = store.get(run_id)
            state = record["state"]
            status_name = record["status"]
            if status_name == "running":
                status.info(f"Analyzing {record['ticker']} · {record['day']} · Reconnects automatically after refresh")
            elif status_name == "completed":
                status.success(f"{record['ticker']}: {record['signal']} · Reports saved to {record['report_path']}")
            else:
                status.error(f"{status_name.title()}: {record['error']}")
            render(state, record["analysts"])
            activity.code("\n".join(record["activity"][-12:]) or "No activity recorded yet.")
            with saved_details.container():
                st.caption(f"Saved run: {record['id']} · Updated: {record['updated_at']}")
                st.json(record["config"], expanded=False)
            if state:
                text = "\n\n".join(f"# {label}\n\n{state[key]}" for key, label in REPORTS.items() if state.get(key))
                st.download_button("Download report", text, file_name=f"{record['ticker']}-{record['day']}-{run_id[:8]}.md", mime="text/markdown", key=f"download_{run_id}")

        show_saved_run(st.session_state.history_run)
    else:
        st.caption("Analysis history will appear here after your first run.")

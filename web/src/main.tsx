import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AuiIf,
  AssistantRuntimeProvider,
  useLocalRuntime,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  type ChatModelAdapter,
  type TextMessagePartProps,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Edit3,
  History,
  MessageSquare,
  Play,
  Plus,
  Search,
  Save,
  Settings2,
  Square,
  TrendingUp,
  X,
} from "lucide-react";
import "./style.css";
import { TickerPicker, StockLogo } from "./TickerPicker";
import { HoldingsImporter, type HoldingsSnapshot } from "./HoldingsImporter";

type Run = {
  id: string;
  ticker: string;
  day: string;
  created_at: string;
  status: string;
  signal: string | null;
  report_path: string | null;
  error: string | null;
  state: Record<string, any>;
  activity: string[];
  analysts: string[];
  config: Record<string, any>;
};
type SavedSetup = {
  ticker: string;
  day: string;
  analysts: string[];
  provider: string;
  quick: string;
  deep: string;
  rounds: number;
  language: string;
  asset_type: string;
  use_holdings?: boolean;
};
type Config = {
  setup?: SavedSetup;
  provider: string;
  quick: string;
  deep: string;
  language: string;
  models: Record<string, Record<string, [string, string][]>>;
};
type Turn = {
  id: string;
  question: string;
  answer: string;
  status: string;
  error: string | null;
};
const sections: Record<string, string> = {
  market_report: "Market analysis",
  sentiment_report: "Sentiment",
  news_report: "News & catalysts",
  fundamentals_report: "Fundamentals",
  investment_plan: "Research decision",
  trader_investment_plan: "Trading plan",
  final_trade_decision: "Portfolio decision",
};
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    throw Error(
      typeof e.detail === "string"
        ? e.detail
        : `Request failed (${response.status})`,
    );
  }
  return response.json();
}
const md = (text: string) => (
  <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
);
function ModelText({ text }: TextMessagePartProps) {
  return <div className="markdown">{md(text)}</div>;
}
function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user">
      <div className="bubble">
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}
function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message assistant">
      <div className="assistant-avatar">
        <TrendingUp size={15} />
      </div>
      <div className="assistant-body">
        <MessagePrimitive.Content components={{ Text: ModelText }} />
        <ActionBarPrimitive.Root className="message-actions">
          <ActionBarPrimitive.Copy
            className="icon-button"
            aria-label="Copy response"
            title="Copy response"
          >
            <Copy size={14} />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}
function ChatThread({ run, turns }: { run: Run; turns: Turn[] }) {
  const [error, setError] = useState("");
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal }) {
        setError("");
        const message =
          messages
            .at(-1)
            ?.content.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n") || "";
        let text = "";
        try {
          const response = await fetch(`/api/runs/${run.id}/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, request_id: crypto.randomUUID() }),
            signal: abortSignal,
          });
          if (!response.ok) {
            const body = await response.json();
            throw Error(body.detail || "Chat request failed");
          }
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let done = false;
          while (true) {
            const part = await reader.read();
            buffer += decoder.decode(part.value, { stream: !part.done });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line);
              if (event.type === "error") throw Error(event.message);
              if (event.type === "done") done = true;
              if (event.type === "delta") {
                text += event.text;
                yield { content: [{ type: "text" as const, text }] };
              }
            }
            if (part.done) break;
          }
          if (!done && !abortSignal.aborted)
            throw Error(
              "Connection interrupted. Refresh to load the saved partial response.",
            );
        } catch (e) {
          if (!abortSignal.aborted) setError((e as Error).message);
          throw e;
        }
      },
    }),
    [run.id],
  );
  const initial = useMemo<ThreadMessageLike[]>(
    () =>
      turns.flatMap((t) => [
        { role: "user" as const, content: t.question },
        ...(t.answer
          ? [{ role: "assistant" as const, content: t.answer }]
          : []),
      ]),
    [turns],
  );
  const runtime = useLocalRuntime(adapter, { initialMessages: initial });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <div className="chat-context">
          <span className="live-dot" /> {run.ticker}{" "}
          <span>· {run.day} · Saved analysis</span>
        </div>
        <ThreadPrimitive.Viewport className="chat-viewport">
          <ThreadPrimitive.Empty>
            <div className="chat-welcome">
              <div className="welcome-icon">
                <TrendingUp size={25} />
              </div>
              <h2>Let’s look closer.</h2>
              <p>
                Ask about {run.ticker}, challenge the thesis, or explore the
                risks in this analysis.
              </p>
              <div className="suggestions">
                {[
                  "Why this rating?",
                  "What are the biggest risks?",
                  "Summarize the bull and bear cases.",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() =>
                      runtime.thread.append({
                        role: "user",
                        content: [{ type: "text", text: q }],
                      })
                    }
                  >
                    {q}
                    <span>↗</span>
                  </button>
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages
            components={{ UserMessage, AssistantMessage }}
          />
        </ThreadPrimitive.Viewport>
        {turns.some(
          (t) =>
            t.status === "interrupted" ||
            t.status === "failed" ||
            t.status === "cancelled",
        ) && (
          <div className="chat-note">
            An earlier response was interrupted. Its saved text is shown above.
          </div>
        )}
        {error && (
          <div className="error chat-error" role="alert">
            {error}
          </div>
        )}
        <div className="composer-wrap">
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              placeholder={`Ask about ${run.ticker}…`}
              className="composer-input"
              aria-label="Message research assistant"
            />
            <div className="composer-bottom">
              <span>Research assistant</span>
              <AuiIf condition={(s) => s.thread.isRunning}>
                <ComposerPrimitive.Cancel
                  className="send stop"
                  aria-label="Stop response"
                  title="Stop response"
                >
                  <Square size={14} />
                </ComposerPrimitive.Cancel>
              </AuiIf>
              <AuiIf condition={(s) => !s.thread.isRunning}>
                <ComposerPrimitive.Send
                  className="send"
                  aria-label="Send message"
                  title="Send message"
                >
                  <ArrowUp size={18} />
                </ComposerPrimitive.Send>
              </AuiIf>
            </div>
          </ComposerPrimitive.Root>
          <p className="chat-disclaimer">
            Based on saved research. No live data or trade execution.
          </p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
function Chat({ run }: { run: Run }) {
  const [turns, setTurns] = useState<Turn[] | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<Turn[]>(`/runs/${run.id}/chat`)
      .then((t) => {
        if (active) setTurns(t);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [run.id]);
  return error ? (
    <div className="error">{error}</div>
  ) : turns ? (
    <ChatThread run={run} turns={turns} />
  ) : (
    <div className="empty">Loading conversation…</div>
  );
}
function TradingChart({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current!;
    root.replaceChildren();
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "calc(100% - 22px)";
    const credit = document.createElement("a");
    credit.href = "https://www.tradingview.com/";
    credit.textContent = "Charts by TradingView";
    credit.target = "_blank";
    credit.rel = "noopener";
    credit.className = "chart-credit";
    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.textContent = JSON.stringify({
      autosize: true,
      symbol,
      interval: "D",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: true,
    });
    container.append(widget, credit, script);
    root.append(container);
    return () => root.replaceChildren();
  }, [symbol]);
  return <div ref={ref} className="chart-embed" />;
}
function progress(run: Run) {
  const s = run.state || {},
    inv = s.investment_debate_state || {},
    risk = s.risk_debate_state || {};
  const analystKeys: Record<string, string> = {
    market: "market_report",
    social: "sentiment_report",
    news: "news_report",
    fundamentals: "fundamentals_report",
  };
  const steps: [string, boolean][] = [
    ...run.analysts.map(
      (a) =>
        [sections[analystKeys[a]] || a, !!s[analystKeys[a]]] as [
          string,
          boolean,
        ],
    ),
    ["Bull researcher", !!inv.bull_history],
    ["Bear researcher", !!inv.bear_history],
    ["Research manager", !!s.investment_plan],
    ["Trader", !!s.trader_investment_plan],
    ["Aggressive risk", !!risk.aggressive_history],
    ["Conservative risk", !!risk.conservative_history],
    ["Neutral risk", !!risk.neutral_history],
    ["Portfolio manager", !!s.final_trade_decision],
  ];
  const completed = steps.filter((v) => v[1]);
  return {
    done: completed.length,
    total: steps.length,
    pct: Math.round((completed.length / steps.length) * 100),
    latest: completed.at(-1)?.[0] || "Preparing analyst team",
  };
}
function App() {
  const [portfolio, setPortfolio] = useState<string[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [run, setRun] = useState<Run | null>(null),
    [config, setConfig] = useState<Config | null>(null);
  const [ticker, setTicker] = useState(
      localStorage.getItem("desk.ticker") || "AMD",
    ),
    [selected, setSelected] = useState(localStorage.getItem("desk.run") || ""),
    [newTicker, setNewTicker] = useState(""),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(""),
    [error, setError] = useState("");
  const [visible, setVisible] = useState(
      localStorage.getItem("desk.chat.visible") !== "false",
    ),
    [width, setWidth] = useState(
      Math.min(
        650,
        Math.max(320, Number(localStorage.getItem("desk.chat.width")) || 400),
      ),
    ),
    [setupOpen, setSetupOpen] = useState(false),
    [mainTab, setMainTab] = useState("reports"),
    [search, setSearch] = useState("");
  const [day, setDay] = useState(new Date().toLocaleDateString("en-CA")),
    [analysts, setAnalysts] = useState(["market", "news", "fundamentals"]),
    [rounds, setRounds] = useState(1),
    [asset, setAsset] = useState("stock"),
    [starting, setStarting] = useState(false),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false);
  const [holdings, setHoldings] = useState<HoldingsSnapshot | null>(null);
  const [holdingsOpen, setHoldingsOpen] = useState(false);
  const [useHoldings, setUseHoldings] = useState(false);
  useEffect(() => {
    api<Config>("/config")
      .then((value) => {
        if (value.setup) {
          const saved = value.setup;
          setConfig({
            ...value,
            provider: saved.provider,
            quick: saved.quick,
            deep: saved.deep,
            language: saved.language,
          });
          setDay(saved.day);
          setAnalysts(saved.analysts);
          setRounds(saved.rounds);
          setAsset(saved.asset_type);
          setUseHoldings(saved.use_holdings ?? false);
        } else setConfig(value);
      })
      .catch((e) => setError(e.message));
    api<string[]>("/portfolio")
      .then(setPortfolio)
      .catch((e) => setError(e.message));
    api<HoldingsSnapshot | null>("/holdings")
      .then(setHoldings)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api<Run[]>("/runs")
        .then((rows) => {
          if (!active) return;
          setRuns(rows);
          const chosen = rows.find((r) => r.id === selected);
          if (!chosen || chosen.ticker !== ticker) {
            setSelected(rows.find((r) => r.ticker === ticker)?.id || "");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, ticker]);
  useEffect(() => {
    setRun(null);
    if (!selected) {
      localStorage.removeItem("desk.run");
      return;
    }
    localStorage.setItem("desk.run", selected);
    let active = true;
    const refresh = () =>
      api<Run>(`/runs/${selected}`)
        .then((r) => {
          if (active) setRun(r);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    setRun(null);
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected]);
  useEffect(() => localStorage.setItem("desk.ticker", ticker), [ticker]);
  useEffect(
    () => localStorage.setItem("desk.chat.visible", String(visible)),
    [visible],
  );
  useEffect(
    () => localStorage.setItem("desk.chat.width", String(width)),
    [width],
  );
  const switchTicker = (symbol: string) => {
    setTicker(symbol);
    setRun(null);
    setSelected(runs.find((r) => r.ticker === symbol)?.id || "");
  };
  const choose = (r: Run) => {
    setSelected(r.id);
    setTicker(r.ticker);
  };
  async function savePortfolio(items: string[]) {
    try {
      setError("");
      setPortfolio(
        await api<string[]>("/portfolio", {
          method: "PUT",
          body: JSON.stringify({ tickers: items }),
        }),
      );
      setEditing(false);
      setNewTicker("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(
    () => setSaved(false),
    [ticker, day, analysts, config, rounds, asset, useHoldings],
  );
  function analysisBody() {
    if (!config) throw Error("Settings are still loading");
    return JSON.stringify({
      ticker,
      day,
      analysts,
      provider: config.provider,
      quick: config.quick,
      deep: config.deep,
      rounds,
      language: config.language,
      asset_type: asset,
      use_holdings: useHoldings,
    });
  }
  async function saveSettings() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api("/setup", { method: "PUT", body: analysisBody() });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function start() {
    if (!config) return;
    setStarting(true);
    setError("");
    try {
      const body = analysisBody();
      const response = await api<{ id: string }>("/runs", {
        method: "POST",
        body,
      });
      setSelected(response.id);
      setMainTab("reports");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }
  const p = run ? progress(run) : null;
  return (
    <div
      className="app"
      style={{ "--chat-width": `${width}px` } as React.CSSProperties}
    >
      {error && (
        <div className="global-error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X size={16} />
          </button>
        </div>
      )}
      <div className={`desk ${visible ? "" : "chat-hidden"}`}>
        <aside className="left-rail">
          <div className="rail-title">
            <span>WATCHLIST</span>
            <button
              className="icon-button"
              aria-label="Edit portfolio"
              title="Edit portfolio"
              onClick={() => {
                setDraft(portfolio.join("\n"));
                setEditing(true);
              }}
            >
              <Edit3 size={15} />
            </button>
          </div>
          <div className="watchlist">
            {portfolio.map((t) => (
              <button
                key={t}
                className={`ticker-row ${ticker === t ? "active" : ""}`}
                onClick={() => switchTicker(t)}
              >
                <StockLogo symbol={t} />
                <strong>{t}</strong>
                {ticker === t && <span className="selected-dot" />}
              </button>
            ))}
          </div>
          <div className="add-symbol">
            <TickerPicker
              value={newTicker}
              onChange={setNewTicker}
              label="Add ticker"
              placeholder="Add stock"
            />
            <button
              aria-label="Save ticker"
              title="Add selected stock to watchlist"
              disabled={!newTicker.trim()}
              onClick={() => savePortfolio([...portfolio, newTicker])}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="holdings-rail">
            <button
              className="secondary-button"
              onClick={() => setHoldingsOpen(true)}
            >
              {holdings ? "Manage holdings" : "Import holdings CSV"}
            </button>
            <span className="small muted">
              {holdings
                ? `${holdings.positions.length} positions · ${holdings.as_of}`
                : "Optional portfolio context"}
            </span>
            <label className="holdings-toggle">
              <input
                type="checkbox"
                checked={useHoldings}
                disabled={!holdings && !useHoldings}
                onChange={(e) => setUseHoldings(e.target.checked)}
              />
              Use holdings in analysis
            </label>
          </div>
          <div className="rail-title history-heading">
            <span>ANALYSIS HISTORY</span>
            <History size={14} />
          </div>
          <label className="history-search">
            <Search size={14} />
            <input
              placeholder="Find analysis"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search analysis history"
            />
          </label>
          <div className="history-list">
            {runs
              .filter((r) => r.ticker.includes(search.toUpperCase()))
              .map((r) => (
                <button
                  className={`history-row ${selected === r.id ? "active" : ""}`}
                  key={r.id}
                  onClick={() => choose(r)}
                >
                  <div>
                    <strong>{r.ticker}</strong>
                    <span className={`status-dot ${r.status}`} />
                  </div>
                  <span>
                    {r.day}{" "}
                    <span className="history-signal">
                      {r.signal || r.status}
                    </span>
                  </span>
                  <small>
                    {new Date(r.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    · {new Date(r.created_at).toLocaleDateString()}
                  </small>
                </button>
              ))}
            {!runs.length && (
              <p className="muted small">
                Your saved analyses will appear here.
              </p>
            )}
          </div>
          <div className="rail-footer">
            <span className="live-dot" /> Saved on this computer
          </div>
        </aside>
        <main className="workspace">
          <section className="instrument-header">
            <div>
              <div className="eyebrow">RESEARCH TERMINAL</div>
              <div className="instrument-title">
                <h1>{ticker}</h1>
                <span className="asset-label">
                  {asset === "stock" ? "Equity" : "Crypto"}
                </span>
              </div>
            </div>
            <div className="instrument-actions">
              <button
                className="primary-button header-run"
                disabled={
                  starting ||
                  !config ||
                  !ticker ||
                  !analysts.length ||
                  !config.quick ||
                  !config.deep
                }
                onClick={() => start()}
                title="Run the selected ticker with the current analysis settings"
              >
                <Play size={14} />
                {starting ? "Starting…" : "Run analysis"}
              </button>
              <button
                className={`secondary-button ask-ai ${visible ? "active" : ""}`}
                aria-label="Ask with AI"
                aria-pressed={visible}
                aria-expanded={visible}
                aria-controls="research-assistant"
                onClick={() => setVisible(!visible)}
              >
                <MessageSquare size={15} />
                Ask with AI
              </button>
              <button
                className="secondary-button"
                onClick={() => {
                  setSetupOpen((open) => !open);
                }}
              >
                <Settings2 size={15} />
                Analysis setup
              </button>
            </div>
          </section>
          {setupOpen && config && (
            <div
              className="setup-panel analysis-setup-card"
              role="region"
              aria-label="Analysis setup"
            >
              <div className="setup-heading">
                <div>
                  <div className="eyebrow">ANALYSIS SETUP</div>
                  <h2>Build your analysis</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Close analysis setup"
                  onClick={() => setSetupOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>
              <p className="muted">
                Run the same specialist team as the terminal.
              </p>
              <div className="setup-symbol-field">
                <span>Symbol</span>
                <TickerPicker
                  value={ticker}
                  onChange={switchTicker}
                  label="Analysis ticker"
                />
              </div>
              <label>
                Analysis date
                <input
                  type="date"
                  value={day}
                  max={new Date().toLocaleDateString("en-CA")}
                  onChange={(e) => setDay(e.target.value)}
                />
              </label>
              <div className="analyst-label">Analyst team</div>
              <div className="analyst-grid">
                {["market", "social", "news", "fundamentals"].map((a) => (
                  <label key={a}>
                    <input
                      type="checkbox"
                      checked={analysts.includes(a)}
                      onChange={(e) =>
                        setAnalysts((old) =>
                          e.target.checked
                            ? [...old, a]
                            : old.filter((v) => v !== a),
                        )
                      }
                    />
                    {a === "social"
                      ? "Sentiment"
                      : a[0].toUpperCase() + a.slice(1)}
                  </label>
                ))}
              </div>
              <label>
                Debate rounds <span>{rounds}</span>
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={rounds}
                  onChange={(e) => setRounds(+e.target.value)}
                />
              </label>
              <label>
                Provider
                <select
                  value={config.provider}
                  onChange={(e) => {
                    const provider = e.target.value;
                    setConfig({
                      ...config,
                      provider,
                      quick:
                        config.models[provider].quick.find(
                          (m) => m[1] !== "custom",
                        )?.[1] || "",
                      deep:
                        config.models[provider].deep.find(
                          (m) => m[1] !== "custom",
                        )?.[1] || "",
                    });
                  }}
                >
                  {Object.keys(config.models).map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                Quick model
                <input
                  list="quick-models"
                  value={config.quick}
                  onChange={(e) =>
                    setConfig({ ...config, quick: e.target.value })
                  }
                />
                <datalist id="quick-models">
                  {config.models[config.provider]?.quick
                    .filter((m) => m[1] !== "custom")
                    .map((m) => (
                      <option key={m[1]} value={m[1]}>
                        {m[0]}
                      </option>
                    ))}
                </datalist>
              </label>
              <label>
                Deep model
                <input
                  list="deep-models"
                  value={config.deep}
                  onChange={(e) =>
                    setConfig({ ...config, deep: e.target.value })
                  }
                />
                <datalist id="deep-models">
                  {config.models[config.provider]?.deep
                    .filter((m) => m[1] !== "custom")
                    .map((m) => (
                      <option key={m[1]} value={m[1]}>
                        {m[0]}
                      </option>
                    ))}
                </datalist>
              </label>
              <div className="form-row">
                <label>
                  Language
                  <select
                    value={config.language}
                    onChange={(e) =>
                      setConfig({ ...config, language: e.target.value })
                    }
                  >
                    <option>English</option>
                    <option>Chinese</option>
                  </select>
                </label>
                <label>
                  Asset
                  <select
                    value={asset}
                    onChange={(e) => setAsset(e.target.value)}
                  >
                    <option value="stock">Stock</option>
                    <option value="crypto">Crypto</option>
                  </select>
                </label>
              </div>
              <div className="setup-holdings">
                <label className="holdings-toggle">
                  <input
                    type="checkbox"
                    checked={useHoldings}
                    disabled={!holdings && !useHoldings}
                    onChange={(e) => setUseHoldings(e.target.checked)}
                  />
                  Use imported holdings in this analysis
                </label>
                <p className="small muted">
                  {holdings
                    ? `${holdings.positions.length} positions as of ${holdings.as_of}. Shared with the trader, risk team and portfolio manager when enabled.`
                    : "Optional: import your positions to account for existing exposure."}
                </p>
                <button
                  className="secondary-button"
                  onClick={() => setHoldingsOpen(true)}
                >
                  {holdings ? "Review holdings" : "Import holdings CSV"}
                </button>
              </div>
              <button
                className="primary-button"
                disabled={
                  saving ||
                  !ticker ||
                  !analysts.length ||
                  !config.quick ||
                  !config.deep
                }
                onClick={saveSettings}
              >
                <Save size={14} />
                {saving ? "Saving…" : "Save settings"}
              </button>
              {saved && (
                <p className="settings-saved" role="status">
                  <Check size={13} />
                  Settings saved locally.
                </p>
              )}
              <p className="small muted">
                Keys load from your local .env. Results and conversations save
                automatically.
              </p>
            </div>
          )}
          <section className="chart-card">
            <TradingChart symbol={ticker} />
            <div className="chart-caption">
              <span>TradingView · Market data may be delayed</span>
              <span>Live chart · Independent of analysis date</span>
            </div>
          </section>
          <section className="research-card">
            <div className="research-top">
              <div className="tabbar">
                {[
                  ["reports", "Reports"],
                  ["activity", "Activity"],
                  ["details", "Run details"],
                ].map(([id, label]) => (
                  <button
                    className={mainTab === id ? "active" : ""}
                    key={id}
                    onClick={() => setMainTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {run?.signal && <span className="rating">{run.signal}</span>}
            </div>
            {run && p ? (
              <>
                <div className="compact-progress">
                  <div>
                    <strong>Team progress</strong>
                    <span>
                      {p.pct}% <b>·</b> {p.done}/{p.total}
                    </span>
                  </div>
                  <div className="latest-step">
                    {p.done > 0 ? <Check size={13} /> : <Activity size={13} />}{" "}
                    {p.latest}
                    {run.status === "completed"
                      ? " · Done"
                      : run.status === "running"
                        ? " · In progress"
                        : ` · ${run.status}`}
                  </div>
                </div>
                <div className="report-context">
                  <span>
                    {run.ticker} · {run.day}
                  </span>
                  <span>
                    {run.status === "running"
                      ? "● Running · Refresh-safe"
                      : `Saved ${new Date(run.created_at).toLocaleString()}`}
                  </span>
                </div>
                {run.ticker !== ticker && (
                  <div className="context-notice">
                    Viewing saved {run.ticker} research; chart is showing{" "}
                    {ticker}.
                  </div>
                )}
                {run.error && <div className="error">{run.error}</div>}
                {mainTab === "reports" && (
                  <div className="report-sections">
                    {Object.entries(sections)
                      .filter(([key]) => run.state?.[key])
                      .map(([key, label]) => (
                        <details
                          key={`${run.id}-${key}`}
                          open={key === "final_trade_decision"}
                        >
                          <summary>
                            {label}
                            <ChevronDown size={15} />
                          </summary>
                          <div className="markdown">
                            {md(String(run.state[key]))}
                          </div>
                        </details>
                      ))}
                    {!Object.keys(run.state || {}).length && (
                      <div className="empty">Preparing your analyst team…</div>
                    )}
                    <button
                      className="text-button download"
                      onClick={() => {
                        const text = Object.entries(sections)
                          .filter(([k]) => run.state[k])
                          .map(([k, label]) => `# ${label}\n\n${run.state[k]}`)
                          .join("\n\n");
                        const url = URL.createObjectURL(
                          new Blob([text], { type: "text/markdown" }),
                        );
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${run.ticker}-${run.day}.md`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      Download report ↓
                    </button>
                  </div>
                )}
                {mainTab === "activity" && (
                  <div className="activity-log">
                    {run.activity?.map((line, i) => (
                      <div key={i}>
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        {line}
                      </div>
                    ))}
                  </div>
                )}
                {mainTab === "details" && (
                  <div className="run-details">
                    <p>
                      Run ID <code>{run.id}</code>
                    </p>
                    <p>
                      Provider{" "}
                      <strong>
                        {run.config?.llm_provider || "Not recorded"}
                      </strong>
                    </p>
                    <p>
                      Quick model{" "}
                      <code>
                        {run.config?.quick_think_llm || "Not recorded"}
                      </code>
                    </p>
                    <p>
                      Deep model{" "}
                      <code>
                        {run.config?.deep_think_llm || "Not recorded"}
                      </code>
                    </p>
                    <p>
                      Reports <code>{run.report_path || "Not saved yet"}</code>
                    </p>
                    <details className="holdings-run-context">
                      <summary>
                        Portfolio context ·{" "}
                        {run.state.portfolio_context
                          ? "Imported holdings"
                          : "No holdings used"}
                      </summary>
                      <pre>
                        {run.state.portfolio_context ||
                          "This analysis ran without a holdings snapshot."}
                      </pre>
                    </details>
                  </div>
                )}
              </>
            ) : (
              <div className="empty research-empty">
                <Activity size={24} />
                <h3>No saved analysis for {ticker} yet.</h3>
                <p>Use Run analysis above the chart, or configure a new run.</p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setSetupOpen(true);
                  }}
                >
                  Configure analysis
                </button>
              </div>
            )}
          </section>
        </main>
        {
          <>
            <div
              className="resize-handle"
              style={{ display: visible ? undefined : "none" }}
              aria-valuenow={width}
              aria-valuemin={320}
              aria-valuemax={650}
              role="separator"
              aria-label="Resize assistant panel"
              aria-orientation="vertical"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft")
                  setWidth((w) => Math.min(650, w + 20));
                if (e.key === "ArrowRight")
                  setWidth((w) => Math.max(320, w - 20));
              }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  setWidth(
                    Math.min(650, Math.max(320, window.innerWidth - e.clientX)),
                  );
              }}
            />
            <aside
              className="right-panel"
              id="research-assistant"
              style={{ display: visible ? undefined : "none" }}
            >
              <div className="right-header">
                <div className="assistant-panel-title">
                  <MessageSquare size={16} />
                  <strong>Research assistant</strong>
                </div>
                <button
                  className="icon-button"
                  title="Hide assistant"
                  aria-label="Close assistant panel"
                  onClick={() => setVisible(false)}
                >
                  <X size={17} />
                </button>
              </div>
              <div className="chat-surface">
                {run ? (
                  <Chat key={run.id} run={run} />
                ) : (
                  <div className="empty chat-no-run">
                    <MessageSquare size={28} />
                    <h3>A second opinion, on demand.</h3>
                    <p>Select an analysis to discuss its findings.</p>
                    <button
                      className="secondary-button"
                      onClick={() => setSetupOpen(true)}
                    >
                      Set up an analysis
                    </button>
                  </div>
                )}
              </div>
            </aside>
          </>
        }
      </div>
      {holdingsOpen && (
        <HoldingsImporter
          snapshot={holdings}
          onClose={() => setHoldingsOpen(false)}
          onSave={(value) => {
            setHoldings(value);
            if (!value) setUseHoldings(false);
          }}
        />
      )}
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(false)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-label="Edit portfolio"
            className="portfolio-modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              savePortfolio(draft.split(/[\s,]+/).filter(Boolean));
            }}
          >
            <div className="modal-heading">
              <h2>Edit portfolio</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close portfolio editor"
                onClick={() => setEditing(false)}
              >
                <X size={18} />
              </button>
            </div>
            <p className="muted">
              One symbol per line. Add, remove, rename, or reorder.
            </p>
            <textarea
              aria-label="Portfolio tickers"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={10}
              autoFocus
            />
            {error && <p className="error">{error}</p>}
            <div className="modal-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button className="primary-button">Save portfolio</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

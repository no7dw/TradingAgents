import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search } from "lucide-react";

import { searchStocks, type Stock } from "./stockDirectory";
type Results = { items: Stock[]; total: number; stale: boolean };
export function StockLogo({ symbol }: { symbol: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [symbol]);
  return (
    <span className="stock-logo" aria-hidden="true">
      {!failed ? (
        <img
          src={`https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        symbol[0]
      )}
    </span>
  );
}
export function TickerPicker({
  value,
  onChange,
  label,
  placeholder = "Search symbol or company",
}: {
  value: string;
  onChange: (symbol: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(value),
    [open, setOpen] = useState(false),
    [results, setResults] = useState<Results>({
      items: [],
      total: 0,
      stale: false,
    }),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 320,
    height: 300,
  });
  const id = useId();
  useEffect(() => setQuery(value), [value]);
  function close() {
    setOpen(false);
    setQuery(value);
  }
  function select(symbol: string) {
    onChange(symbol);
    setQuery(symbol);
    setOpen(false);
    input.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setResults({ items: [], total: 0, stale: false });
    setError("");
    setActive(0);
    const timer = setTimeout(async () => {
      try {
        const data = await searchStocks(query);
        if (!controller.signal.aborted) setResults(data);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const rect = root.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const up = below < 200 && above > below;
      const height = Math.min(350, Math.max(100, up ? above : below));
      const width = Math.min(
        460,
        Math.max(rect.width, 320),
        window.innerWidth - 24,
      );
      setPosition({
        left: Math.min(rect.left, window.innerWidth - width - 12),
        top: up ? Math.max(8, rect.top - height - 6) : rect.bottom + 6,
        width,
        height,
      });
    }
    function outside(e: PointerEvent) {
      if (
        !root.current?.contains(e.target as Node) &&
        !panel.current?.contains(e.target as Node)
      )
        close();
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, value]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, id, open]);
  const custom = query.trim().toUpperCase();
  const allowCustom =
    !!custom &&
    /^[A-Z0-9^][A-Z0-9.^=_:/-]{0,39}$/.test(custom) &&
    !results.items.some((s) => s.symbol === custom);
  const count = results.items.length + (allowCustom ? 1 : 0);
  function chooseActive() {
    const stock = results.items[active];
    if (stock) select(stock.symbol);
    else if (allowCustom) select(custom);
  }
  return (
    <div className="ticker-picker" ref={root}>
      <div className="ticker-picker-input">
        <Search size={14} />
        <input
          ref={input}
          aria-label={label}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={
            open && count ? `${id}-${Math.min(active, count - 1)}` : undefined
          }
          value={open ? query : value}
          placeholder={placeholder}
          onFocus={(e) => {
            e.target.select();
            setOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, Math.max(0, count - 1)));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (open) chooseActive();
              else setOpen(true);
            }
            if (e.key === "Tab") close();
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Open ${label} dropdown`}
          onClick={() => {
            setOpen(!open);
            if (!open) input.current?.focus();
          }}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open &&
        createPortal(
          <div
            className="ticker-dropdown"
            ref={panel}
            onMouseDown={(e) => e.preventDefault()}
            style={{
              position: "fixed",
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.height,
            }}
          >
            <div className="ticker-dropdown-heading">
              U.S. STOCKS{" "}
              <span>
                {loading
                  ? "Searching…"
                  : `${results.total.toLocaleString()} matches`}
              </span>
            </div>
            <div
              role="listbox"
              id={`${id}-list`}
              aria-label="Stock symbols"
              className="ticker-options"
            >
              {results.items.map((stock, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  id={`${id}-${i}`}
                  key={stock.symbol}
                  className={`stock-option ${i === active ? "active" : ""}`}
                  onPointerMove={() => setActive(i)}
                  onClick={() => select(stock.symbol)}
                >
                  <StockLogo symbol={stock.symbol} />
                  <span className="stock-option-text">
                    <strong>{stock.symbol}</strong>
                    <span title={stock.name}>{stock.name}</span>
                  </span>
                  <small>{stock.exchange}</small>
                </button>
              ))}
              {allowCustom && (
                <button
                  type="button"
                  role="option"
                  aria-selected={active === results.items.length}
                  id={`${id}-${results.items.length}`}
                  className={`stock-option custom-symbol ${active === results.items.length ? "active" : ""}`}
                  onClick={() => select(custom)}
                >
                  Use custom symbol <strong>{custom}</strong>
                  <small>Other markets / crypto</small>
                </button>
              )}
              {!loading && !error && !results.items.length && (
                <div className="ticker-search-note">
                  No U.S. stock matches. Try another symbol or company name.
                </div>
              )}
            </div>
            {error && (
              <div className="ticker-search-note" role="status">
                {error}
              </div>
            )}
            <div className="ticker-dropdown-source">
              Nasdaq Trader ·{" "}
              {results.stale
                ? "Cached list · refresh unavailable"
                : "Symbol & company directory"}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

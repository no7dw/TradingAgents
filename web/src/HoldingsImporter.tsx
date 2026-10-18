import { useEffect, useRef, useState } from "react";
import { Download, Upload, X } from "lucide-react";

export type HoldingsSnapshot = {
  as_of: string;
  imported_at: string;
  positions: {
    ticker: string;
    quantity: string;
    avg_cost?: string;
    market_value?: string;
    currency: string;
  }[];
};

async function request<T>(
  method: string,
  path: string,
  body?: object,
): Promise<T> {
  const response = await fetch(`/api/holdings${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      typeof result.detail === "string"
        ? result.detail
        : "Could not import holdings",
    );
  return result;
}

export function HoldingsImporter({
  snapshot,
  onSave,
  onClose,
}: {
  snapshot: HoldingsSnapshot | null;
  onSave: (value: HoldingsSnapshot | null) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [csv, setCsv] = useState("");
  const [asOf, setAsOf] = useState(new Date().toLocaleDateString("en-CA"));
  const [preview, setPreview] = useState<HoldingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const shown = preview || snapshot;
  async function action(kind: "preview" | "save" | "clear") {
    setBusy(true);
    setError("");
    try {
      if (kind === "clear") {
        await request("DELETE", "");
        onSave(null);
        setPreview(null);
        setCsv("");
      } else {
        const value = await request<HoldingsSnapshot>(
          kind === "preview" ? "POST" : "PUT",
          kind === "preview" ? "/preview" : "",
          { csv, as_of: asOf },
        );
        if (kind === "preview") setPreview(value);
        else {
          onSave(value);
          onClose();
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function template() {
    const url = URL.createObjectURL(
      new Blob(
        [
          "ticker,quantity,avg_cost,market_value,currency\nAAPL,10,180,2200,USD\nNVDA,5,100,700,USD\n",
        ],
        { type: "text/csv" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "holdings-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <dialog
      ref={dialog}
      className="holdings-modal portfolio-modal"
      aria-labelledby="holdings-title"
      onCancel={onClose}
    >
      <div className="modal-heading">
        <div>
          <div className="eyebrow">PORTFOLIO CONTEXT</div>
          <h2 id="holdings-title">Import holdings</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close holdings import"
          onClick={onClose}
          disabled={busy}
        >
          <X size={18} />
        </button>
      </div>
      <p className="muted">
        Upload a snapshot of your positions. Preview it, then save locally. Each
        analysis keeps its own copy when Use holdings is enabled.
      </p>
      <div className="holdings-import-fields">
        <label>
          CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              setPreview(null);
              setCsv("");
              setError("");
              if (!file) return;
              if (file.size > 1_000_000) {
                setError("CSV must be smaller than 1 MB");
                return;
              }
              setBusy(true);
              try {
                setCsv(await file.text());
              } catch {
                setError("Could not read the file. Use a UTF-8 CSV export.");
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        <label>
          Holdings as of
          <input
            type="date"
            value={asOf}
            max={new Date().toLocaleDateString("en-CA")}
            disabled={busy}
            onChange={(e) => {
              setAsOf(e.target.value);
              setPreview(null);
            }}
          />
        </label>
      </div>
      <div className="holdings-import-actions">
        <button className="secondary-button" onClick={template}>
          <Download size={14} />
          CSV template
        </button>
        <button
          className="secondary-button"
          disabled={busy || !csv || !asOf}
          onClick={() => action("preview")}
        >
          <Upload size={14} />
          {busy ? "Working…" : "Preview CSV"}
        </button>
      </div>
      <p className="small muted">
        Required: ticker, quantity (or symbol, shares). Optional: avg_cost per
        share, total market_value, currency (default USD). Positive quantities,
        one row per ticker, up to 500 positions. Replace the sample values in
        the template.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {shown && (
        <>
          <div className="holdings-preview-heading">
            <strong>
              {preview ? "Preview · not saved" : "Saved holdings"}
            </strong>
            <span>
              {shown.positions.length} positions · {shown.as_of}
            </span>
          </div>
          <div className="holdings-table-wrap">
            <table className="holdings-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Quantity</th>
                  <th>Avg. cost</th>
                  <th>Market value</th>
                  <th>Currency</th>
                </tr>
              </thead>
              <tbody>
                {shown.positions.map((p) => (
                  <tr key={p.ticker}>
                    <td>
                      <span>
                        {p.ticker}
                      </span>
                    </td>
                    <td>{p.quantity}</td>
                    <td>{p.avg_cost ?? "—"}</td>
                    <td>{p.market_value ?? "—"}</td>
                    <td>{p.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="small muted">
        When enabled, a summary is sent to your configured LLM for the trader,
        risk team, portfolio manager and follow-up chat. Missing values and cash
        stay unknown. Imported prices are not live quotes. Saving replaces the
        current snapshot; saved analyses retain theirs.
      </p>
      <div className="modal-footer">
        {snapshot && (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => action("clear")}
          >
            Clear saved holdings
          </button>
        )}
        <button
          className="primary-button"
          disabled={busy || !preview}
          onClick={() => action("save")}
        >
          Save holdings
        </button>
      </div>
    </dialog>
  );
}

export type Stock = { symbol: string; name: string; exchange: string };
type Catalog = { stocks: Stock[]; fetched_at: number };
let pending: Promise<Catalog> | null = null;
let expires = 0;
const popular = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AMD",
  "BRK-B",
  "JPM",
];
async function load() {
  if (!pending || Date.now() > expires) {
    expires = Date.now() + 300000;
    pending = fetch("/assets/us-symbols.json", { cache: "no-cache" })
      .then(async (response) => {
        if (!response.ok)
          throw Error(
            "Stock list unavailable. You can still select a custom symbol.",
          );
        const data = await response.json();
        if (
          !Array.isArray(data.stocks) ||
          !data.stocks.length ||
          typeof data.fetched_at !== "number" ||
          !data.stocks.every(
            (s: Stock) =>
              typeof s.symbol === "string" &&
              typeof s.name === "string" &&
              typeof s.exchange === "string",
          )
        )
          throw Error("Stock directory format is invalid.");
        return data as Catalog;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}
export async function searchStocks(query: string) {
  const catalog = await load();
  const q = query.trim().toLowerCase();
  const matches = catalog.stocks.filter(
    (s) =>
      !q ||
      s.symbol.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q),
  );
  function rank(s: Stock) {
    const symbol = s.symbol.toLowerCase();
    if (!q) {
      const i = popular.indexOf(s.symbol);
      return i < 0 ? popular.length : i;
    }
    return symbol === q
      ? 0
      : symbol.startsWith(q)
        ? 1
        : s.name.toLowerCase().startsWith(q)
          ? 2
          : 3;
  }
  matches.sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
  return {
    items: matches.slice(0, 40),
    total: matches.length,
    stale: Date.now() / 1000 - catalog.fetched_at > 86400,
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { searchStocks } from "./stockDirectory.ts";

test("stock picker searches real names and symbols, ranks exact matches, and caches the catalog", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("", { status: 503 });
    return Response.json({
      fetched_at: Date.now() / 1000,
      stocks: [
        {
          symbol: "AAPL",
          name: "Apple Inc. - Common Stock",
          exchange: "NASDAQ",
        },
        {
          symbol: "NVDA",
          name: "NVIDIA Corporation - Common Stock",
          exchange: "NASDAQ",
        },
        {
          symbol: "BRK-B",
          name: "Berkshire Hathaway Class B",
          exchange: "NYSE",
        },
        { symbol: "ZZZ", name: "AAPL other company", exchange: "NYSE" },
      ],
    });
  };
  await assert.rejects(searchStocks("apple"), /unavailable/);
  assert.equal((await searchStocks("apple")).items[0].symbol, "AAPL");
  assert.equal((await searchStocks("aapl")).items[0].symbol, "AAPL");
  assert.equal((await searchStocks("nvidia")).items[0].symbol, "NVDA");
  assert.equal((await searchStocks("brk-b")).items[0].exchange, "NYSE");
  assert.equal((await searchStocks("unlisted company")).total, 0);
  assert.equal((await searchStocks("")).stale, false);
  assert.equal(calls, 2);
});

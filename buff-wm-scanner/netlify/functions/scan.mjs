// Netlify function: Buff163 (CS2/CSGO) -> MarketCSGO (lowest sell offer)
//
// Modes:
//   USE_DUMMY=1  → return dummy data
//   USE_DUMMY=0  → call real APIs
//
// Env vars (live mode):
//   BUFF_COOKIE            (old name, optional)
//   BUFF163_COOKIE         (new name, optional)
//   BUFF_REFERER           (old name, optional)
//   BUFF163_REFERER        (new name, optional)
//   FX_CNY_USD or FX_CNYUSD
//   MARKETCSGO_API_KEY

const BUFF_BASE = "https://buff.163.com";
const MCSGO_BASE = "https://market.csgo.com/api/v2";

// -------- helpers --------

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

function ok(payload) {
  return jsonResponse(200, payload);
}

function fail(status, message, extra = {}) {
  return jsonResponse(status, {
    ok: false,
    error: message,
    ...extra,
  });
}

// -------- env handling / sanitising --------

// accept both names; trim & strip newlines just in case
const RAW_BUFF_COOKIE = (
  process.env.BUFF_COOKIE ||
  process.env.BUFF163_COOKIE ||
  ""
).trim();

const BUFF_COOKIE = RAW_BUFF_COOKIE.replace(/\r?\n/g, "");

// try to extract csrf_token from cookie for header use
const CSRF_TOKEN = (() => {
  const m = BUFF_COOKIE.match(/csrf_token=([^;]+)/);
  return m ? m[1] : "";
})();

// default referer updated to match browser (?game=csgo)
const BUFF_REFERER =
  process.env.BUFF_REFERER ||
  process.env.BUFF163_REFERER ||
  "https://buff.163.com/market/?game=csgo";

// FX can be FX_CNY_USD or FX_CNYUSD
function getFx() {
  const fxEnv = process.env.FX_CNY_USD || process.env.FX_CNYUSD || "0.14";
  const fx = Number(fxEnv);
  return Number.isFinite(fx) && fx > 0 ? fx : 0.14;
}

// -------- BUFF163 client --------

async function buffFetch(path) {
  const url = BUFF_BASE + path;

  if (!BUFF_COOKIE) {
    throw new Error("BUFF cookie missing (BUFF_COOKIE / BUFF163_COOKIE)");
  }

  const headers = {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: BUFF_REFERER,
    Origin: "https://buff.163.com",
    "X-Requested-With": "XMLHttpRequest",
    Cookie: BUFF_COOKIE,
  };

  // many CSRF setups also expect token in a header
  if (CSRF_TOKEN) {
    headers["X-CSRFToken"] = CSRF_TOKEN;
  }

  const res = await fetch(url, { headers });
  const text = await res.text();

  // small snippet for debugging
  console.info("BUFF DEBUG", {
    url,
    status: res.status,
    snippet: text.slice(0, 200),
  });

  if (!res.ok) {
    throw new Error(`BUFF HTTP ${res.status} at ${url}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `BUFF bad JSON at ${url}: ${String(e)} snippet=${text.slice(0, 200)}`
    );
  }

  if (json.code && json.code !== "OK") {
    // this is where "Login Required" is thrown
    throw new Error(
      `BUFF HTTP 200, code=${json.code}, msg=${json.error || json.msg || "Unknown"}`
    );
  }

  return json;
}

// Fetch top N items sorted by Buff price (CNY, highest first)
async function fetchBuffItems(limit, fxCnyUsd) {
  const pageSize = Math.min(Math.max(1, limit), 60);

  // use csgo as in your original working project
  const path = `/api/market/goods?game=csgo&page_num=1&page_size=${pageSize}&sort_by=price.desc`;

  const data = await buffFetch(path);

  const goodsInfos = data.data?.goods_infos || {};
  const items = data.data?.items || [];

  return items.slice(0, limit).map((row, idx) => {
    const goods = goodsInfos[row.goods_id] || {};
    const name =
      goods.market_hash_name || goods.name || row.name || `Unknown #${idx + 1}`;
    const wear = goods.goods_info?.wear || "-";

    const icon = goods.icon_url || "";
    const image = icon.startsWith("http")
      ? icon
      : icon
      ? `https://g.fp.ps.netease.com/${icon}`
      : "https://via.placeholder.com/64";

    const buffPriceCny = Number(row.sell_min_price || 0);
    const buffUsd = buffPriceCny * fxCnyUsd;
    const quantity = Number(row.sell_num || 0);

    return {
      id: Number(row.goods_id || goods.id || idx + 1),
      name,
      wear,
      image,
      buffPrice: buffPriceCny,
      buffUsd: Number(buffUsd.toFixed(2)),
      quantity,
    };
  });
}

// -------- MarketCSGO client --------

const MCSGO_KEY = process.env.MARKETCSGO_API_KEY || "";

async function mcsgoFetch(pathWithQuery) {
  if (!MCSGO_KEY) {
    throw new Error("Missing MARKETCSGO_API_KEY env var");
  }

  const sep = pathWithQuery.includes("?") ? "&" : "?";
  const url = `${MCSGO_BASE}${pathWithQuery}${sep}key=${encodeURIComponent(
    MCSGO_KEY
  )}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`MarketCSGO HTTP ${res.status} at ${url}`);
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`MarketCSGO bad JSON at ${url}: ${String(err)}`);
  }

  if (json.success === false) {
    throw new Error(
      `MarketCSGO API error at ${url}: ${json.error || "Unknown"}`
    );
  }

  return json;
}

// Get lowest SELL price + number of listings for given hash_name
async function mcsgoBestSell(hashName) {
  if (!hashName) {
    return { priceUsd: 0, orders: 0, note: "Missing hash name" };
  }

  try {
    const data = await mcsgoFetch(
      `/search-item-by-hash-name?hash_name=${encodeURIComponent(hashName)}`
    );

    const list = Array.isArray(data.data) ? data.data : [];

    if (!list.length) {
      return { priceUsd: 0, orders: 0, note: "No MarketCSGO listings" };
    }

    const best = list.reduce(
      (min, item) =>
        Number(item.price) < Number(min.price) ? item : min,
      list[0]
    );

    const bestPrice = Number(best.price || 0);

    return {
      priceUsd: Number(bestPrice.toFixed(2)),
      orders: list.length,
      note: "",
    };
  } catch (err) {
    return {
      priceUsd: 0,
      orders: 0,
      note: `API error: ${String(err.message || err).slice(0, 80)}`,
    };
  }
}

// -------- Dummy data (for testing / when APIs are broken) --------

function buildDummyItems(limit, fxCnyUsd) {
  const items = [];
  for (let i = 1; i <= limit; i++) {
    const buffPrice = 10 + i;
    const buffUsd = Number((buffPrice * fxCnyUsd).toFixed(2));
    const mcsgoPrice = buffUsd * 1.25;
    const netProfit = Number((mcsgoPrice - buffUsd).toFixed(2));
    const spreadPct =
      buffUsd > 0 ? Number(((mcsgoPrice / buffUsd - 1) * 100).toFixed(2)) : 0;

    items.push({
      id: i,
      name: `TEST ITEM #${i}`,
      wear: "Field-Tested",
      image: "https://via.placeholder.com/64",
      buffPrice,
      buffUsd,
      mcsgoPrice,
      mcsgoOrders: 3 + i,
      spreadPct,
      netProfitUsd: netProfit,
      quantity: 123,
      note: "Dummy data from scan.mjs",
    });
  }
  return items;
}

// -------- Netlify handler --------

export async function handler(event) {
  const qs = event.queryStringParameters || {};

  // 1) ENV DEBUG MODE: /.netlify/functions/scan?debugEnv=1
  if (qs.debugEnv === "1") {
    return ok({
      BUFF163_COOKIE_len: (process.env.BUFF163_COOKIE || "").length,
      BUFF_COOKIE_len: (process.env.BUFF_COOKIE || "").length,
      BUFF163_REFERER: process.env.BUFF163_REFERER || "",
      BUFF_REFERER: process.env.BUFF_REFERER || "",
      FX_CNY_USD: process.env.FX_CNY_USD || "",
      FX_CNYUSD: process.env.FX_CNYUSD || "",
      MARKETCSGO_API_KEY_len: (process.env.MARKETCSGO_API_KEY || "").length,
      USE_DUMMY: process.env.USE_DUMMY || "",
    });
  }

  const useDummy = process.env.USE_DUMMY === "1";

  const limit = Math.min(
    60,
    Math.max(1, parseInt(qs.limit || "30", 10) || 30)
  );

  const fx = getFx();

  if (useDummy) {
    const items = buildDummyItems(limit, fx);
    return ok({ ok: true, fx, items });
  }

  try {
    // 1) Buff items
    const buffItems = await fetchBuffItems(limit, fx);

    // 2) Attach MarketCSGO quotes in parallel
    const enriched = await Promise.all(
      buffItems.map(async (item) => {
        const quote = await mcsgoBestSell(item.name);

        const mcsgoPrice = quote.priceUsd || 0;
        const netProfit = Number((mcsgoPrice - item.buffUsd).toFixed(2));
        const spreadPct =
          item.buffUsd > 0
            ? Number(((mcsgoPrice / item.buffUsd - 1) * 100).toFixed(2))
            : 0;

        return {
          id: item.id,
          name: item.name,
          wear: item.wear,
          image: item.image,
          buffPrice: item.buffPrice,
          buffUsd: item.buffUsd,
          mcsgoPrice,
          mcsgoOrders: quote.orders || 0,
          spreadPct,
          netProfitUsd: netProfit,
          quantity: item.quantity,
          note: quote.note ? `API: ${quote.note}` : "",
        };
      })
    );

    return ok({ ok: true, fx, items: enriched });
  } catch (err) {
    console.error("scan.mjs top-level error:", err);
    return fail(500, "Scan failed", {
      detail: String(err.message || err),
    });
  }
}

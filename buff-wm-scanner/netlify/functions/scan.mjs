// buff-wm-scanner/netlify/functions/scan.mjs
// Buff163 (CS2) → White.Market buy orders arbitrage scanner
//
// Env vars required:
//   BUFF_COOKIE          – full cookie string from buff.163.com
//   WM_PARTNER_TOKEN     – partner token from white.market profile
//   FX_CNYUSD            – CNY → USD rate (e.g. "0.14")
//
// Optional:
//   USE_DUMMY            – set to "1" to return dummy data for testing

const BUFF_BASE = "https://buff.163.com";
const WM_GQL = "https://api.white.market/graphql/partner";

// --------------- in-memory caches ---------------
let wmCache = { token: null, exp: 0 };
let buffCache = { ts: 0, key: "", items: [] };

// --------------- helpers ---------------
function ok(body) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function fail(statusCode, message) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify({ ok: false, error: message }),
  };
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function normalizeUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  return u;
}

// --------------- BUFF163 ---------------
async function buffFetch(path, params = {}) {
  const cookie = mustEnv("BUFF_COOKIE");
  const url = new URL(BUFF_BASE + path);

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "")
      url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), {
    headers: {
      cookie,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      referer: "https://buff.163.com/market/csgo",
      accept: "application/json, text/plain, */*",
      "x-requested-with": "XMLHttpRequest",
    },
  });

  const text = await r.text().catch(() => "");
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  console.log("BUFF", { status: r.status, snippet: text.slice(0, 200) });

  // BUFF returns { code: "OK" } on success
  if (!r.ok || (json.code && json.code !== "OK")) {
    const msg = json.msg || json.message || json.error || text.slice(0, 120);
    throw new Error(`BUFF goods error: code=${json.code || r.status}, msg=${msg}`);
  }

  return json;
}

async function buffGoodsList({ search = "", pageNum = 1, pageSize = 20 } = {}) {
  const data = await buffFetch("/api/market/goods", {
    game: "csgo",
    page_num: pageNum,
    page_size: pageSize,
    search,
    sort_by: "price.desc",
  });
  return data?.data?.items || [];
}

// --------------- White.Market ---------------
async function wmGetAccessToken() {
  const partnerToken = mustEnv("WM_PARTNER_TOKEN");
  const now = Date.now();

  if (wmCache.token && wmCache.exp > now) return wmCache.token;

  const r = await fetch(WM_GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-partner-token": partnerToken,
    },
    body: JSON.stringify({ query: `mutation { auth_token { accessToken } }` }),
  });

  const j = await r.json().catch(() => ({}));
  const token = j?.data?.auth_token?.accessToken;
  if (!token) throw new Error("White.Market: failed to get accessToken");

  wmCache.token = token;
  wmCache.exp = now + 23 * 60 * 60 * 1000; // refresh 1 hour before 24h expiry
  return token;
}

// Fetch the highest buy order for a given nameHash using order_list
// We sort by PRICE DESC and take the first result — that's the best buy order.
async function wmHighestBuyOrder(nameHash) {
  const accessToken = await wmGetAccessToken();

  const query = `
    query($nameHash: String!) {
      order_list(
        search: {
          appId: CSGO
          nameHash: $nameHash
          nameStrict: true
          sort: { field: PRICE, type: DESC }
        }
        forwardPagination: { first: 1 }
      ) {
        edges {
          node {
            quantity
            price { value currency }
          }
        }
        totalCount
      }
    }
  `;

  const r = await fetch(WM_GQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables: { nameHash } }),
  });

  const j = await r.json().catch(() => ({}));

  if (j?.errors?.length) {
    throw new Error(j.errors[0].message || "WM GraphQL error");
  }

  const edges = j?.data?.order_list?.edges || [];
  const totalCount = j?.data?.order_list?.totalCount || 0;
  const node = edges[0]?.node;

  return {
    priceUsd: node?.price?.value != null ? Number(node.price.value) : 0,
    quantity: node?.quantity != null ? Number(node.quantity) : 0,
    totalOrders: totalCount,
  };
}

// --------------- concurrency limiter ---------------
async function mapLimit(arr, limit, fn) {
  const ret = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const idx = i++;
      ret[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

// --------------- dummy data ---------------
function buildDummyItems(limit, fx) {
  const names = [
    "AK-47 | Redline | Field-Tested",
    "AWP | Dragon Lore | Well-Worn",
    "Knife | Butterfly | Minimal Wear",
    "M4A4 | Howl | Battle-Tested",
    "USP-S | Guardian | Minimal Wear",
    "Glock-18 | Fade | Factory New",
    "AK-47 | Vulcan | Minimal Wear",
    "AWP | Medusa | Field-Tested",
    "Knife | Karambit | Factory New",
    "M4A1-S | Hyper Beast | Well-Worn",
  ];

  return Array.from({ length: limit }, (_, i) => {
    const buffPriceCny = 50 + (i + 1) * 12.5;
    const buffPriceUsd = Number((buffPriceCny * fx).toFixed(2));
    const wmBuyOrder = Number((buffPriceUsd * (1.1 + (i % 3) * 0.08)).toFixed(2));
    const spread = Number(((wmBuyOrder / buffPriceUsd - 1) * 100).toFixed(2));
    const profit = Number((wmBuyOrder - buffPriceUsd).toFixed(2));

    return {
      id: i + 1,
      name: names[i % names.length],
      image: "",
      buffPriceCny,
      buffPriceUsd,
      wmBuyOrderUsd: wmBuyOrder,
      wmOrderCount: 3 + i,
      spreadPct: spread,
      profitUsd: profit,
      buffQuantity: 10 + i * 3,
    };
  });
}

// --------------- main handler ---------------
export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
      body: "",
    };
  }

  try {
    const qs = event.queryStringParameters || {};
    const limit = Math.min(Math.max(parseInt(qs.limit || "20", 10) || 20, 1), 50);
    const search = (qs.search || "").trim();
    const fx = Number(process.env.FX_CNYUSD || "0.14");

    // --- dummy mode ---
    if (process.env.USE_DUMMY === "1") {
      return ok({ ok: true, fx, items: buildDummyItems(limit, fx) });
    }

    // --- BUFF cache (60s) ---
    const cacheKey = `${search}|${limit}`;
    const now = Date.now();
    let buffItems;

    if (buffCache.items?.length && buffCache.key === cacheKey && now - buffCache.ts < 60000) {
      buffItems = buffCache.items;
    } else {
      buffItems = await buffGoodsList({ search, pageNum: 1, pageSize: limit });
      buffCache = { ts: now, key: cacheKey, items: buffItems };
    }

    // --- parse BUFF items ---
    const rows = buffItems
      .map((it, idx) => {
        const nameHash = it?.market_hash_name || it?.name || it?.short_name;
        if (!nameHash) return null;

        const buffPriceCny =
          it?.sell_min_price != null
            ? Number(it.sell_min_price)
            : it?.sell_min_price_cny != null
            ? Number(it.sell_min_price_cny)
            : 0;

        const buffPriceUsd = Number((buffPriceCny * fx).toFixed(2));

        const quantity = it?.sell_num ?? it?.sell_count ?? it?.goods_info?.sell_num ?? 0;

        const image =
          normalizeUrl(it?.goods_info?.icon_url) ||
          normalizeUrl(it?.icon_url) ||
          normalizeUrl(it?.img) ||
          "";

        return {
          id: it?.id || idx + 1,
          name: nameHash,
          image,
          buffPriceCny,
          buffPriceUsd,
          buffQuantity: Number(quantity) || 0,
        };
      })
      .filter(Boolean);

    // --- fetch White.Market buy orders (4 concurrent) ---
    const enriched = await mapLimit(rows, 4, async (row) => {
      try {
        const wm = await wmHighestBuyOrder(row.name);
        const wmBuyOrderUsd = wm.priceUsd || 0;
        const spreadPct =
          row.buffPriceUsd > 0
            ? Number(((wmBuyOrderUsd / row.buffPriceUsd - 1) * 100).toFixed(2))
            : 0;
        const profitUsd = Number((wmBuyOrderUsd - row.buffPriceUsd).toFixed(2));

        return {
          ...row,
          wmBuyOrderUsd,
          wmOrderCount: wm.totalOrders || 0,
          spreadPct,
          profitUsd,
        };
      } catch (e) {
        console.error(`WM error for "${row.name}":`, e.message);
        return { ...row, wmBuyOrderUsd: 0, wmOrderCount: 0, spreadPct: 0, profitUsd: 0 };
      }
    });

    return ok({ ok: true, fx, items: enriched });
  } catch (e) {
    console.error("scan.mjs top-level error:", e);
    return fail(500, String(e?.message || e));
  }
}

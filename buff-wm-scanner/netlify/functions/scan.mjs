// buff-wm-scanner/netlify/functions/scan.mjs
// BUFF163 (CS2) -> White.Market buy orders
// IMPORTANT: This version avoids BUFF 429 by doing ONLY 1 BUFF request per scan
// and using sell_min_price from the goods list.

const BUFF_BASE = "https://buff.163.com";
const WM_GQL_ENDPOINT = "https://api.white.market/graphql/partner";

// Cache White.Market access token (valid ~24h; we refresh early)
let wmCache = { token: null, exp: 0 };

// Cache BUFF goods list for 60 seconds to avoid rate limits
let buffCache = { ts: 0, key: "", items: [] };

function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function fail(statusCode, message) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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

// --- BUFF (ONE request only) ---
async function buffFetch(path, params = {}) {
  const cookie = mustEnv("BUFF_COOKIE"); // must be FULL cookie string, not only Device-Id

  const url = new URL(BUFF_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), {
    headers: {
      cookie,
      "user-agent": "Mozilla/5.0",
      referer: "https://buff.163.com/market/csgo",
      accept: "application/json, text/plain, */*",
    },
  });

  const text = await r.text().catch(() => "");
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!r.ok) {
    const msg = typeof json === "object" ? JSON.stringify(json) : String(text);
    throw new Error(`BUFF HTTP ${r.status}: ${msg}`);
  }
  return json;
}

async function buffGoodsList({ search = "", pageNum = 1, pageSize = 20 } = {}) {
  // Uses BUFF web endpoint for CS2/CSGO market goods list
  const data = await buffFetch("/api/market/goods", {
    game: "csgo",
    page_num: pageNum,
    page_size: pageSize,
    search,
  });
  return data?.data?.items || [];
}

// --- White.Market ---
async function wmGetAccessToken() {
  const partnerToken = mustEnv("WM_PARTNER_TOKEN");
  const now = Date.now();

  if (wmCache.token && wmCache.exp > now) return wmCache.token;

  const r = await fetch(WM_GQL_ENDPOINT, {
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
  wmCache.exp = now + 23 * 60 * 60 * 1000; // refresh early
  return token;
}

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
      }
    }
  `;

  const r = await fetch(WM_GQL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables: { nameHash } }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.errors?.length) {
    const msg = j?.errors?.[0]?.message || `White.Market HTTP ${r.status}`;
    throw new Error(msg);
  }

  const node = j?.data?.order_list?.edges?.[0]?.node;
  return {
    priceUsd: node?.price?.value != null ? Number(node.price.value) : 0,
    quantity: node?.quantity != null ? Number(node.quantity) : 0,
  };
}

// Simple concurrency limiter (so WM isn’t spammed)
async function mapLimit(arr, limit, mapper) {
  const ret = [];
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      ret[idx] = await mapper(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

export async function handler(event) {
  try {
    const limit = Math.min(Math.max(parseInt(event.queryStringParameters?.limit || "20", 10), 1), 50);
    const search = (event.queryStringParameters?.search || "").trim();

    const fx = Number(process.env.FX_CNYUSD || "0.14");

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

    // Build items without extra BUFF calls
    const rows = buffItems
      .map((it) => {
        const goodsId = it?.id;
        const nameHash = it?.market_hash_name || it?.name || it?.short_name;
        if (!goodsId || !nameHash) return null;

        // IMPORTANT: use BUFF's sell_min_price from goods list (no sell_order endpoint)
        const buffPriceCny =
          it?.sell_min_price != null ? Number(it.sell_min_price) :
          it?.sell_min_price_cny != null ? Number(it.sell_min_price_cny) :
          null;

        const quantity =
          it?.sell_num ?? it?.sell_count ?? it?.sell_total ?? it?.goods_info?.sell_num ?? 0;

        const wear =
          it?.goods_info?.info?.wear_name ||
          it?.goods_info?.tags?.exterior ||
          it?.tags?.exterior ||
          "—";

        const image =
          normalizeUrl(it?.goods_info?.icon_url) ||
          normalizeUrl(it?.icon_url) ||
          normalizeUrl(it?.img) ||
          "";

        return {
          id: goodsId,
          name: nameHash,
          wear,
          image,
          buffPrice: buffPriceCny ?? 0, // CNY
          wmPrice: 0,                   // USD (filled later)
          quantity: Number(quantity) || 0,
          fx,
          wmUrl: `https://white.market/` // placeholder (keep simple)
        };
      })
      .filter(Boolean);

    // Query WM for each item (limit concurrency to 4)
    const withWM = await mapLimit(rows, 4, async (row) => {
      try {
        const wm = await wmHighestBuyOrder(row.name);
        return { ...row, wmPrice: wm.priceUsd || 0 };
      } catch {
        // If WM errors for one item, don’t break the whole list
        return { ...row, wmPrice: 0 };
      }
    });

    return ok({ ok: true, items: withWM });
  } catch (e) {
    return fail(500, String(e?.message || e));
  }
}

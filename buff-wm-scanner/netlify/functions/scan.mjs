// netlify/functions/scan.mjs
// Buff163 (CS2/CSGO) -> White.Market (best BUY OFFER via offerMinPrice)

const WM_ENDPOINT = "https://api.white.market/graphql/partner"; // IMPORTANT (fixes 404)
const BUFF_ENDPOINT =
  "https://buff.163.com/api/market/goods?game=csgo&page_num=1&sort_by=sell_num.desc&page_size=";

const clampInt = (n, min, max) => Math.max(min, Math.min(max, n));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(data),
  };
}

// ---- Tiny in-memory caches (survive warm invocations) ----
globalThis.__BUFF_CACHE__ = globalThis.__BUFF_CACHE__ || { ts: 0, limit: 0, items: [] };
globalThis.__WM_TOKEN__ = globalThis.__WM_TOKEN__ || { ts: 0, accessToken: "" };

// ---- White.Market auth (Partner token -> Bearer access token) ----
async function getWmAccessToken() {
  const partnerToken = process.env.WM_PARTNER_TOKEN;
  if (!partnerToken) throw new Error("Missing env WM_PARTNER_TOKEN");

  // reuse token for ~20 hours (safe enough)
  const now = Date.now();
  if (globalThis.__WM_TOKEN__.accessToken && now - globalThis.__WM_TOKEN__.ts < 20 * 60 * 60 * 1000) {
    return globalThis.__WM_TOKEN__.accessToken;
  }

  const query = `
    mutation {
      auth_token {
        accessToken
      }
    }
  `;

  const res = await fetch(WM_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-partner-token": partnerToken,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`WM auth HTTP ${res.status}: ${t}`);
  }

  const json = await res.json();
  const token = json?.data?.auth_token?.accessToken;
  if (!token) throw new Error(`WM auth: missing accessToken (got: ${JSON.stringify(json)?.slice(0, 300)})`);

  globalThis.__WM_TOKEN__ = { ts: now, accessToken: token };
  return token;
}

async function wmGraphql(query, variables) {
  const accessToken = await getWmAccessToken();

  const res = await fetch(WM_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  // If token expired, clear cache once and retry
  if (res.status === 401 || res.status === 403) {
    globalThis.__WM_TOKEN__ = { ts: 0, accessToken: "" };
    const accessToken2 = await getWmAccessToken();
    const res2 = await fetch(WM_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${accessToken2}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res2.ok) {
      const t2 = await res2.text().catch(() => "");
      throw new Error(`WM HTTP ${res2.status}: ${t2}`);
    }
    return await res2.json();
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`WM HTTP ${res.status}: ${t}`);
  }

  return await res.json();
}

// Pull BEST buy-offer (what UI shows in "Buy offers") via offerMinPrice
async function getWmBestBuyOfferUsd(nameHash) {
  const query = `
    query ($nameHash: String!) {
      market_list(
        search: {
          appId: CSGO
          nameHash: $nameHash
          nameStrict: true
          hasOffer: true
          distinctValues: true
        }
        forwardPagination: { first: 1 }
      ) {
        edges {
          node {
            nameHash
            slug
            offerMinPrice { value currency }
          }
        }
      }
    }
  `;

  const json = await wmGraphql(query, { nameHash });

  const node = json?.data?.market_list?.edges?.[0]?.node;
  const valueStr = node?.offerMinPrice?.value; // Money value is string in docs
  const wmPrice = valueStr ? Number.parseFloat(valueStr) : 0;

  const slug = node?.slug || "";
  const wmUrl = slug ? `https://white.market/item/${slug}` : "https://white.market/";

  return { wmPrice: Number.isFinite(wmPrice) ? wmPrice : 0, wmUrl };
}

// ---- BUFF fetch ----
async function fetchBuffTop(limit, forceRefresh = false) {
  const cookie = process.env.BUFF_COOKIE;
  if (!cookie) throw new Error("Missing env BUFF_COOKIE");

  const now = Date.now();
  const cache = globalThis.__BUFF_CACHE__;

  // cache for 20 seconds to reduce 429 spam
  if (!forceRefresh && cache.items.length && cache.limit === limit && now - cache.ts < 20_000) {
    return cache.items;
  }

  const url = BUFF_ENDPOINT + encodeURIComponent(String(limit)) + `&_=${now}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      cookie,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "application/json, text/plain, */*",
      referer: "https://buff.163.com/market/csgo",
      "accept-language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`BUFF HTTP ${res.status}: ${t}`);
  }

  const json = await res.json();

  const items = json?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(`BUFF: unexpected response (no data.items). Got: ${JSON.stringify(json)?.slice(0, 300)}`);
  }

  globalThis.__BUFF_CACHE__ = { ts: now, limit, items };
  return items;
}

function normalizeBuffImage(iconUrlOrFull) {
  if (!iconUrlOrFull) return "";
  if (iconUrlOrFull.startsWith("http")) return iconUrlOrFull;
  // common BUFF image host
  return `https://market.fp.ps.netease.com/file/${iconUrlOrFull}`.replace(/\/file\/file\//, "/file/");
}

function extractWear(item) {
  // best effort: many items don’t have wear (stickers)
  const wear =
    item?.goods_info?.tags?.exterior?.localized_name ||
    item?.goods_info?.info?.tags?.exterior?.localized_name ||
    item?.tags?.exterior?.localized_name ||
    "";
  return wear || "-";
}

export const handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const limit = clampInt(parseInt(qs.limit || "30", 10) || 30, 1, 50);
    const forceRefresh = qs.refresh === "1";

    const fx = Number.parseFloat(process.env.FX_CNYUSD || "0.14");
    if (!Number.isFinite(fx) || fx <= 0) throw new Error("Invalid FX_CNYUSD (set it like 0.14)");

    // 1) BUFF list (CNY)
    const buffItems = await fetchBuffTop(limit, forceRefresh);

    const base = buffItems.map((it) => {
      const id = it?.id ?? it?.goods_id ?? it?.goodsId ?? Math.floor(Math.random() * 1e9);
      const name = it?.name || it?.market_hash_name || it?.marketHashName || "";
      const buffPriceCny = Number.parseFloat(it?.sell_min_price ?? it?.sellMinPrice ?? "0") || 0;
      const quantity = it?.sell_num ?? it?.sellNum ?? it?.sell_number ?? it?.sellNumber ?? 0;
      const icon = it?.goods_info?.icon_url || it?.icon_url || it?.iconUrl || "";
      const image = normalizeBuffImage(icon);

      return {
        id,
        name,
        wear: extractWear(it),
        image,
        buffPrice: buffPriceCny, // CNY (display with ¥)
        quantity,
      };
    });

    // 2) WM best buy offer (USD) — do sequential to be gentle + avoid bans
    const out = [];
    for (const item of base) {
      // small delay helps with BUFF/WM rate limits
      await sleep(120);

      let wm = { wmPrice: 0, wmUrl: "https://white.market/" };
      if (item.name) {
        wm = await getWmBestBuyOfferUsd(item.name);
      }

      out.push({
        ...item,
        wmPrice: wm.wmPrice, // USD
        wmUrl: wm.wmUrl,
        fx, // include per item (handy)
      });
    }

    return jsonResponse(200, { ok: true, fx, items: out });
  } catch (err) {
    return jsonResponse(200, {
      ok: false,
      error: String(err?.message || err),
    });
  }
};

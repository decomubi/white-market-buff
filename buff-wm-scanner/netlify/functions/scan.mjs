// netlify/functions/scan.mjs
// Netlify Function (NOT Edge). Must return { statusCode, headers, body }.
// BUFF163 (CNY) -> White.Market (USD Buy Offer)

const BUFF_URL = "https://buff.163.com/api/market/goods";

const WM_ENDPOINTS = [
  "https://api.white.market/graphql/partner",
  "https://api.white.market/graphql/partner/",
];

const DEFAULT_LIMIT = 30;

function reply(statusCode, data) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(data),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function buffFetchTop({ limit, cookie }) {
  const url = new URL(BUFF_URL);
  url.searchParams.set("game", "csgo");
  url.searchParams.set("page_num", "1");
  url.searchParams.set("page_size", String(Math.min(Math.max(limit, 1), 100)));

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    accept: "application/json, text/plain, */*",
    referer: "https://buff.163.com/market/csgo",
    cookie,
  };

  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithTimeout(url.toString(), { headers }, 15000);
    const text = await res.text();

    if (res.status === 429) {
      lastErr = new Error(`BUFF HTTP 429: ${text}`);
      await sleep(700 * (attempt + 1));
      continue;
    }

    if (!res.ok) throw new Error(`BUFF HTTP ${res.status}: ${text}`);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`BUFF bad JSON: ${text.slice(0, 200)}`);
    }

    if (!data || data.code !== "OK" || !data.data) {
      throw new Error(`BUFF unexpected response: ${text.slice(0, 300)}`);
    }

    const items = Array.isArray(data.data.items) ? data.data.items : [];

    return items.map((it) => {
      const goodsId = it.id ?? it.goods_id ?? it.goodsId ?? it.name;
      const name = it.name ?? it.goods_info?.name ?? it.market_hash_name ?? "";
      const icon =
        it.goods_info?.icon_url ??
        it.goods_info?.original_icon_url ??
        it.icon_url ??
        it.icon ??
        "";

      const buffPrice =
        Number(it.sell_min_price ?? it.min_price ?? it.sell_min_price_cny ?? 0) || 0;

      const quantity = Number(it.sell_num ?? it.sell_count ?? 0) || 0;

      return {
        id: goodsId,
        name,
        wear: "-",
        image: icon.startsWith("http") ? icon : icon ? `https:${icon}` : "",
        buffPrice, // CNY
        quantity,
      };
    });
  }

  throw lastErr || new Error("BUFF failed after retries");
}

// small cache (netlify warm instance)
let WM_TOKEN_CACHE = { token: null, ts: 0 };

async function wmAuthToken(endpoint, partnerToken) {
  const now = Date.now();
  if (WM_TOKEN_CACHE.token && now - WM_TOKEN_CACHE.ts < 10 * 60 * 1000) {
    return WM_TOKEN_CACHE.token;
  }

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-partner-token": partnerToken,
      },
      body: JSON.stringify({
        query: `mutation { auth_token { accessToken } }`,
        variables: {},
      }),
    },
    15000
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`WM AUTH HTTP ${res.status}: ${text}`);

  let jsonData;
  try {
    jsonData = JSON.parse(text);
  } catch {
    throw new Error(`WM AUTH bad JSON: ${text.slice(0, 200)}`);
  }

  const token = jsonData?.data?.auth_token?.accessToken;
  if (!token) throw new Error(`WM AUTH missing token: ${text.slice(0, 300)}`);

  WM_TOKEN_CACHE = { token, ts: now };
  return token;
}

async function wmGraphql(endpoint, accessToken, query, variables) {
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    },
    15000
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`WM HTTP ${res.status} at ${endpoint}: ${text}`);

  let jsonData;
  try {
    jsonData = JSON.parse(text);
  } catch {
    throw new Error(`WM bad JSON: ${text.slice(0, 200)}`);
  }

  if (jsonData.errors?.length) {
    throw new Error(`WM GraphQL error: ${JSON.stringify(jsonData.errors).slice(0, 400)}`);
  }

  return jsonData.data;
}

async function wmBestBuyOfferUSD({ endpoint, accessToken, nameHash }) {
  // ✅ Correct: Buy offers are offerMinPrice, not listing price
  const query = `
    query($search: MarketOrderSearchInput!, $pagination: ForwardPaginationInput!) {
      order_list(search: $search, pagination: $pagination) {
        edges {
          node {
            inventory {
              product {
                name
                slug
                offerMinPrice { value currency }
              }
            }
          }
        }
      }
    }
  `;

  const variables = {
    search: {
      appId: "CSGO",
      searchType: "MARKET",
      nameHash,
      nameHashStrict: true,
      distinctValues: true,
    },
    pagination: { first: 1 },
  };

  const data = await wmGraphql(endpoint, accessToken, query, variables);

  const edge = data?.order_list?.edges?.[0];
  const product = edge?.node?.inventory?.product;

  const offer = Number(product?.offerMinPrice?.value ?? 0) || 0;
  const slug = product?.slug || "";

  return {
    wmPrice: offer, // USD buy offer
    wmUrl: slug ? `https://white.market/item/${slug}` : "https://white.market/",
  };
}

export async function handler(event) {
  try {
    const limitRaw = event?.queryStringParameters?.limit;
    const limit = Math.min(Math.max(Number(limitRaw || DEFAULT_LIMIT), 1), 50);

    const BUFF_COOKIE = process.env.BUFF_COOKIE;
    const WM_PARTNER_TOKEN = process.env.WM_PARTNER_TOKEN;
    const fx = Number(process.env.FX_CNYUSD || "0.14") || 0.14;

    if (!BUFF_COOKIE) return reply(500, { ok: false, error: "Missing env BUFF_COOKIE" });
    if (!WM_PARTNER_TOKEN) return reply(500, { ok: false, error: "Missing env WM_PARTNER_TOKEN" });

    // 1) Buff
    const buffItems = await buffFetchTop({ limit, cookie: BUFF_COOKIE });

    // 2) WM endpoint + auth
    let wmEndpoint = null;
    let accessToken = null;
    let lastWmErr = null;

    for (const ep of WM_ENDPOINTS) {
      try {
        accessToken = await wmAuthToken(ep, WM_PARTNER_TOKEN);
        wmEndpoint = ep;
        break;
      } catch (e) {
        lastWmErr = e;
      }
    }

    if (!wmEndpoint || !accessToken) {
      throw new Error(`WM failed: ${lastWmErr?.message || "Unknown WM error"}`);
    }

    // 3) Merge
    const items = [];
    for (const it of buffItems) {
      let wm = { wmPrice: 0, wmUrl: "https://white.market/" };
      try {
        wm = await wmBestBuyOfferUSD({
          endpoint: wmEndpoint,
          accessToken,
          nameHash: it.name,
        });
      } catch {
        // keep 0 if not found
      }

      items.push({
        id: it.id,
        name: it.name,
        wear: it.wear ?? "-",
        image: it.image,
        buffPrice: Number(it.buffPrice || 0), // CNY
        wmPrice: Number(wm.wmPrice || 0), // USD buy offer
        quantity: Number(it.quantity || 0),
        wmUrl: wm.wmUrl,
      });
    }

    return reply(200, { ok: true, fx, items });
  } catch (e) {
    return reply(500, { ok: false, error: String(e?.message || e) });
  }
}

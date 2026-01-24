// netlify/functions/scan.mjs
// BUFF163 (CNY) -> White.Market (USD Buy Offer)
// - BUFF: uses cookie auth (BUFF_COOKIE env)
// - WM: uses partner GraphQL (WM_PARTNER_TOKEN env) + offerMinPrice (best buy offer)

const BUFF_URL = "https://buff.163.com/api/market/goods";

const WM_ENDPOINTS = [
  "https://api.white.market/graphql/partner",
  // fallback (in case they change routing):
  "https://api.white.market/graphql/partner/",
];

const DEFAULT_LIMIT = 30;

function json(res, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function buffFetchTop({ limit, cookie }) {
  // NOTE: BUFF API fields can differ slightly per response.
  // This version targets the common "goods" endpoint fields.
  const url = new URL(BUFF_URL);
  url.searchParams.set("game", "csgo");
  url.searchParams.set("page_num", "1");
  url.searchParams.set("page_size", String(Math.min(Math.max(limit, 1), 200)));
  url.searchParams.set("sort_by", "price.desc"); // common sort (ok if ignored)

  // Buff can rate-limit (429). We'll retry a bit (polite).
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "accept": "application/json, text/plain, */*",
    "referer": "https://buff.163.com/market/csgo",
    "cookie": cookie,
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithTimeout(url.toString(), { headers }, 15000);
    const text = await res.text();

    if (res.status === 429) {
      lastErr = new Error(`BUFF HTTP 429: ${text}`);
      await sleep(600 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      throw new Error(`BUFF HTTP ${res.status}: ${text}`);
    }

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

    // Normalize to what frontend expects
    return items.map((it) => {
      const goodsId = it.id ?? it.goods_id ?? it.goodsId ?? null;
      const name = it.name ?? it.goods_info?.name ?? it.market_hash_name ?? "";
      const icon =
        it.goods_info?.icon_url ??
        it.goods_info?.original_icon_url ??
        it.icon_url ??
        it.icon ??
        "";
      const price =
        Number(it.sell_min_price ?? it.sell_min_price_cny ?? it.min_price ?? 0) ||
        0;
      const qty = Number(it.sell_num ?? it.sell_num_count ?? it.sell_count ?? 0) || 0;

      return {
        id: goodsId ?? name,
        name,
        wear: "-", // optional; BUFF doesn't always provide wear separately
        image: icon.startsWith("http")
          ? icon
          : icon
          ? `https:${icon}`
          : "",
        buffPrice: price, // CNY
        quantity: qty,
      };
    });
  }

  throw lastErr || new Error("BUFF failed after retries");
}

// In-memory WM token cache (Netlify keeps warm instances sometimes)
let WM_TOKEN_CACHE = { token: null, ts: 0 };

async function wmAuthToken(endpoint, partnerToken) {
  // cache ~10 minutes to reduce calls
  const now = Date.now();
  if (WM_TOKEN_CACHE.token && now - WM_TOKEN_CACHE.ts < 10 * 60 * 1000) {
    return WM_TOKEN_CACHE.token;
  }

  const body = JSON.stringify({
    query: `mutation { auth_token { accessToken } }`,
    variables: {},
  });

  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-partner-token": partnerToken,
      },
      body,
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
  if (!token) throw new Error(`WM AUTH missing accessToken: ${text.slice(0, 300)}`);

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
        "authorization": `Bearer ${accessToken}`,
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
  // IMPORTANT:
  // We use order_list(distinctValues: true) and read product.offerMinPrice.value
  // which corresponds to best "Buy offer" you see on the item page.
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

  const offerValue = Number(product?.offerMinPrice?.value ?? 0) || 0;
  const slug = product?.slug || "";

  return {
    wmPrice: offerValue, // USD buy offer
    wmUrl: slug ? `https://white.market/item/${slug}` : "https://white.market/",
  };
}

export async function handler(event) {
  try {
    const limit = Math.min(
      Math.max(Number(new URL(event.url).searchParams.get("limit") || DEFAULT_LIMIT), 1),
      100
    );

    const BUFF_COOKIE = process.env.BUFF_COOKIE;
    const WM_PARTNER_TOKEN = process.env.WM_PARTNER_TOKEN;
    const fx = Number(process.env.FX_CNYUSD || "0.14") || 0.14;

    if (!BUFF_COOKIE) return json({ ok: false, error: "Missing env BUFF_COOKIE" }, 500);
    if (!WM_PARTNER_TOKEN) return json({ ok: false, error: "Missing env WM_PARTNER_TOKEN" }, 500);

    // 1) Fetch BUFF items (CNY)
    const buffItems = await buffFetchTop({ limit, cookie: BUFF_COOKIE });

    // 2) WM: find a working endpoint + auth token
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

    // 3) For each BUFF item, fetch WM best buy offer (USD)
    // (This is N queries; keep limit small to stay fast)
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
        // keep wmPrice 0 if not found
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

    return json({ ok: true, fx, items });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}

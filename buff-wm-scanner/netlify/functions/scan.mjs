// netlify/functions/scan.mjs
// Node 18+ (Netlify default). Uses server-side fetch.
// Buff -> gets listing min price (CNY) + quantity
// White.market -> finds item page via search, then scrapes "Buy offers" price + quantity from HTML.

const BUFF_COOKIE = process.env.BUFF_COOKIE || "";
const FX_CNYUSD = Number(process.env.FX_CNYUSD || "0.14");

// -------------------- small helpers --------------------
function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(bodyObj),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeFetch(url, opts = {}, { retries = 2, retryDelay = 600 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      // Retry on temporary throttling
      if (res.status === 429 || res.status === 503) {
        const text = await res.text().catch(() => "");
        lastErr = new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
        if (i < retries) {
          await sleep(retryDelay * (i + 1));
          continue;
        }
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        await sleep(retryDelay * (i + 1));
        continue;
      }
    }
  }
  throw lastErr || new Error(`Fetch failed: ${url}`);
}

function slugifyForSearch(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// -------------------- BUFF: get listings --------------------
async function fetchBuffTop({ limit }) {
  if (!BUFF_COOKIE) {
    throw new Error("Missing BUFF_COOKIE env var.");
  }

  // This endpoint is commonly used by BUFF web app.
  // If BUFF changes it later, only this function needs updates.
  const url =
    `https://buff.163.com/api/market/goods?` +
    `game=csgo&page_num=1&page_size=${encodeURIComponent(limit)}&sort_by=price.desc`;

  const res = await safeFetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://buff.163.com/market/csgo",
      "Cookie": BUFF_COOKIE,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`BUFF HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`BUFF returned non-JSON: ${text.slice(0, 200)}`);
  }

  const items = data?.data?.items || [];
  // Normalize
  return items.map((it) => {
    const goodsInfo = it?.goods_info || {};
    const name = goodsInfo?.name || it?.name || "Unknown";
    const icon = goodsInfo?.icon_url || goodsInfo?.icon || "";
    const image = icon
      ? icon.startsWith("http")
        ? icon
        : `https:${icon}`
      : "";

    const buffPrice = Number(it?.sell_min_price ?? it?.sell_reference_price ?? 0);
    const quantity = Number(it?.sell_num ?? it?.sell_num_total ?? it?.sell_num_display ?? it?.sell_num ?? 0);

    // Wear is already included in name for most items; keep separate field for UI filter.
    // For stickers/cases it might not exist; we put "-" like your screenshots.
    const wearMatch = String(name).match(/\(([^)]+)\)\s*$/);
    const wear = wearMatch ? wearMatch[1] : "-";

    return {
      id: Number(it?.id || goodsInfo?.id || 0),
      name,
      wear,
      image,
      buffPrice,
      quantity,
    };
  });
}

// -------------------- WHITE.MARKET: find item page via search --------------------
async function wmFindItemUrl(query) {
  const q = encodeURIComponent(query);

  // We try a few common search URLs. One of them usually works.
  const candidates = [
    `https://white.market/search?query=${q}`,
    `https://white.market/search?search=${q}`,
    `https://white.market/market?query=${q}`,
    `https://white.market/market?search=${q}`,
    `https://white.market/market/cs2?query=${q}`,
    `https://white.market/market/cs2?search=${q}`,
  ];

  for (const url of candidates) {
    const res = await safeFetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }, { retries: 1 });

    if (!res.ok) continue;

    const html = await res.text();

    // First /item/... link found in HTML
    const m = html.match(/href="(\/item\/[^"]+)"/i);
    if (m?.[1]) return `https://white.market${m[1]}`;

    // Sometimes links are single-quoted
    const m2 = html.match(/href='(\/item\/[^']+)'/i);
    if (m2?.[1]) return `https://white.market${m2[1]}`;
  }

  return null;
}

// Extract "Buy offers" price + qty from item page HTML.
// Works even if there is no public API, because we read what the page renders.
function wmExtractBuyOfferFromHtml(html) {
  const lower = html.toLowerCase();
  const idx = lower.indexOf("buy offers");
  if (idx === -1) {
    return { price: 0, qty: 0 };
  }

  // Take a window after the section title
  const slice = html.slice(idx, idx + 6000);

  // First $X.XX after "Buy offers"
  const priceMatch = slice.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  const price = priceMatch ? Number(priceMatch[1]) : 0;

  // First "NN items" after that section
  const qtyMatch = slice.match(/([0-9][0-9,]*)\s*items/i);
  const qty = qtyMatch ? Number(qtyMatch[1].replace(/,/g, "")) : 0;

  return {
    price: Number.isFinite(price) ? price : 0,
    qty: Number.isFinite(qty) ? qty : 0,
  };
}

async function wmGetBuyOffer({ itemUrl }) {
  const res = await safeFetch(itemUrl, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  }, { retries: 1 });

  const html = await res.text();
  if (!res.ok) {
    throw new Error(`WM HTTP ${res.status} at ${itemUrl}: ${html.slice(0, 200)}`);
  }

  return wmExtractBuyOfferFromHtml(html);
}

// simple concurrency limiter
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;

  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      out[idx] = await fn(arr[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

// -------------------- Netlify handler --------------------
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  try {
    const limit = Math.max(1, Math.min(50, Number(event.queryStringParameters?.limit || 30)));
    const fx = Number.isFinite(FX_CNYUSD) ? FX_CNYUSD : 0.14;

    // 1) BUFF
    const buffItems = await fetchBuffTop({ limit });

    // 2) WM (find url + scrape buy offers)
    const enriched = await mapLimit(buffItems, 3, async (it) => {
      const searchTerm = slugifyForSearch(it.name);
      let wmUrl = null;
      let wmPrice = 0;
      let wmBuyQty = 0;

      try {
        wmUrl = await wmFindItemUrl(searchTerm);
        if (wmUrl) {
          const offer = await wmGetBuyOffer({ itemUrl: wmUrl });
          wmPrice = offer.price;
          wmBuyQty = offer.qty;
        }
      } catch {
        // keep zeros if WM fails for this item
      }

      return {
        ...it,
        fx,
        wmPrice: Number.isFinite(wmPrice) ? wmPrice : 0,
        wmBuyQty: Number.isFinite(wmBuyQty) ? wmBuyQty : 0,
        wmUrl: wmUrl || "https://white.market/",
      };
    });

    return json(200, { ok: true, fx, items: enriched });
  } catch (err) {
    return json(500, { ok: false, error: String(err?.message || err) });
  }
}

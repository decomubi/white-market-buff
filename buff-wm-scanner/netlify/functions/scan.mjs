// netlify/functions/scan.mjs

const BUFF_COOKIE = process.env.BUFF_COOKIE || "";
const FX_CNYUSD = Number(process.env.FX_CNYUSD || "0.14");

// -------------------- helpers --------------------
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

function normalizeBuffPrice(v) {
  let n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;

  // If BUFF returns cents-like integer (e.g., 3499985), divide by 100
  // Heuristic: very large values are almost always *100.
  if (n >= 100000 && Number.isInteger(n)) n = n / 100;

  return n;
}

function stripWear(name) {
  // remove "(Factory New)" etc at end
  return String(name || "").replace(/\s*\(([^)]+)\)\s*$/g, "").trim();
}

function cleanText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/souvenir/g, "") // helps matching on WM
    .replace(/stattrak™/g, "stattrak")
    .replace(/[™®]/g, "")
    .replace(/[|]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  const t = cleanText(s).split(" ").filter(Boolean);
  return new Set(t);
}

function jaccard(aSet, bSet) {
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function urlSlugToName(urlPath) {
  // /item/tec-9-cracked-opal-field-tested-4666...
  // /item/hand-wraps-slaughter-minimal-wear-...
  const slug = String(urlPath || "")
    .split("/item/")[1]
    ?.split("?")[0]
    ?.replace(/-\d+$/g, "") || "";
  return slug.replace(/-/g, " ");
}

// -------------------- BUFF: get listings --------------------
async function fetchBuffTop({ limit }) {
  if (!BUFF_COOKIE) throw new Error("Missing BUFF_COOKIE env var.");

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
  if (!res.ok) throw new Error(`BUFF HTTP ${res.status}: ${text.slice(0, 300)}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`BUFF returned non-JSON: ${text.slice(0, 200)}`);
  }

  const items = data?.data?.items || [];
  return items.map((it) => {
    const goodsInfo = it?.goods_info || {};
    const name = goodsInfo?.name || it?.name || "Unknown";

    const icon = goodsInfo?.icon_url || goodsInfo?.icon || "";
    const image = icon ? (icon.startsWith("http") ? icon : `https:${icon}`) : "";

    const rawPrice = it?.sell_min_price ?? it?.sell_reference_price ?? 0;
    const buffPrice = normalizeBuffPrice(rawPrice);

    const quantity = Number(it?.sell_num ?? it?.sell_num_total ?? it?.sell_num_display ?? 0);

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

// -------------------- WHITE.MARKET: better match from search --------------------
async function wmFetchSearchHtml(query) {
  const q = encodeURIComponent(query);
  const urls = [
    `https://white.market/search?query=${q}`,
    `https://white.market/search?search=${q}`,
    `https://white.market/market?query=${q}`,
    `https://white.market/market?search=${q}`,
    `https://white.market/market/cs2?query=${q}`,
    `https://white.market/market/cs2?search=${q}`,
  ];

  for (const url of urls) {
    const res = await safeFetch(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      { retries: 1 }
    );

    if (!res.ok) continue;
    const html = await res.text();
    if (html && html.length > 200) return html;
  }
  return null;
}

function wmExtractItemLinks(html) {
  const out = [];
  const re = /href=(?:"|')((\/item\/[^"']+))(?:"|')/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const path = m[1];
    if (path && !out.includes(path)) out.push(path);
    if (out.length >= 60) break; // enough candidates
  }
  return out;
}

function wmPickBestUrl(itemName, paths) {
  if (!paths?.length) return null;

  const full = cleanText(itemName);
  const noWear = cleanText(stripWear(itemName));

  const aFull = tokenSet(full);
  const aNoWear = tokenSet(noWear);

  let best = { path: null, score: 0 };

  for (const p of paths) {
    const candName = urlSlugToName(p);
    const b = tokenSet(candName);

    // base similarity
    let score = Math.max(jaccard(aFull, b), jaccard(aNoWear, b));

    // small bonus: weapon keyword presence (awp/ak-47/etc)
    const weaponBonusTokens = ["awp", "ak", "ak47", "m4a1", "m4a4", "tec", "glock", "usp", "deagle", "p90", "mp7", "mp9"];
    for (const w of weaponBonusTokens) {
      if (aNoWear.has(w) && b.has(w)) score += 0.08;
    }

    if (score > best.score) best = { path: p, score };
  }

  // If it’s too weak, better return null than wrong item (prevents “fake” prices)
  if (best.score < 0.22) return null;

  return `https://white.market${best.path}`;
}

// Extract buy offer from item page HTML
function wmExtractBuyOfferFromHtml(html) {
  const lower = html.toLowerCase();
  const idx = lower.indexOf("buy offers");
  if (idx === -1) return { price: 0, qty: 0 };

  const slice = html.slice(idx, idx + 8000);

  const priceMatch = slice.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  const price = priceMatch ? Number(priceMatch[1]) : 0;

  const qtyMatch = slice.match(/([0-9][0-9,]*)\s*items/i);
  const qty = qtyMatch ? Number(qtyMatch[1].replace(/,/g, "")) : 0;

  return {
    price: Number.isFinite(price) ? price : 0,
    qty: Number.isFinite(qty) ? qty : 0,
  };
}

async function wmGetBuyOffer(itemUrl) {
  const res = await safeFetch(
    itemUrl,
    {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    },
    { retries: 1 }
  );

  const html = await res.text();
  if (!res.ok) throw new Error(`WM HTTP ${res.status} at ${itemUrl}: ${html.slice(0, 200)}`);
  return wmExtractBuyOfferFromHtml(html);
}

async function wmResolve(itemName) {
  // Try multiple search terms (helps WM match):
  const attempts = [
    itemName,
    stripWear(itemName),
    stripWear(itemName).replace(/^souvenir\s+/i, ""),
  ];

  for (const term of attempts) {
    const html = await wmFetchSearchHtml(term);
    if (!html) continue;

    const paths = wmExtractItemLinks(html);
    const bestUrl = wmPickBestUrl(itemName, paths);
    if (bestUrl) return bestUrl;
  }

  return null;
}

// concurrency limiter
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
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  try {
    const limit = Math.max(1, Math.min(30, Number(event.queryStringParameters?.limit || 10)));
    const fx = Number.isFinite(FX_CNYUSD) ? FX_CNYUSD : 0.14;

    const buffItems = await fetchBuffTop({ limit });

    const enriched = await mapLimit(buffItems, 3, async (it) => {
      let wmUrl = null;
      let wmPrice = 0;
      let wmBuyQty = 0;

      try {
        wmUrl = await wmResolve(it.name);
        if (wmUrl) {
          const offer = await wmGetBuyOffer(wmUrl);
          wmPrice = offer.price;
          wmBuyQty = offer.qty;
        }
      } catch {
        // keep zeros
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

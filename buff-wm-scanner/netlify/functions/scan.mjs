// netlify/functions/scan.mjs

export const handler = async (event, context) => {
  try {
    const url = new URL(event.rawUrl || `https://dummy.local${event.path}${event.rawQuery ? `?${event.rawQueryString}` : ""}`);
    const limit = Number(url.searchParams.get("limit") || 10);

    // Dummy items just to prove the pipeline works
    const items = Array.from({ length: Math.min(limit, 5) }).map((_, i) => ({
      id: i + 1,
      name: `TEST ITEM #${i + 1}`,
      wear: "Field-Tested",
      image: "https://via.placeholder.com/64",
      buffPrice: 10 + i,          // CNY
      buffUsd: (10 + i) * 0.14,   // USD approx
      mcsgPrice: 8 + i,           // MarketCSGO buy order
      mcsgOrders: 3 + i,
      spreadPct: 25,              // %
      netProfitUsd: 1.23,
      quantity: 123,
      note: "Dummy data from scan.mjs",
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        fx: 0.14,
        items,
      }),
    };
  } catch (err) {
    console.error("SCAN TEST ERROR", err);

    // IMPORTANT: still return valid JSON even on error
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        error: err.message || "Unknown error",
        items: [],
      }),
    };
  }
};

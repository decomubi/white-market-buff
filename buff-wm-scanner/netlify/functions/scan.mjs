export async function handler(event) {
  const cookie163 = process.env.BUFF163_COOKIE || "";
  const cookieLegacy = process.env.BUFF_COOKIE || "";
  const referer163 = process.env.BUFF163_REFERER || "";
  const useDummy = process.env.USE_DUMMY || "";
  const fxEnv1 = process.env.FX_CNY_USD || "";
  const fxEnv2 = process.env.FX_CNYUSD || "";
  const mcKey = process.env.MARKETCSGO_API_KEY || "";

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(
      {
        ok: true,
        BUFF163_COOKIE_len: cookie163.length,
        BUFF_COOKIE_len: cookieLegacy.length,
        BUFF163_REFERER: referer163,
        FX_CNY_USD: fxEnv1,
        FX_CNYUSD: fxEnv2,
        MARKETCSGO_API_KEY_len: mcKey.length,
        USE_DUMMY: useDummy,
      },
      null,
      2
    ),
  };
}

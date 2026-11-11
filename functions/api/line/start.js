const STATE_COOKIE = "mohs_line_test_state";

export function onRequestGet({ request, env }) {
  if (!env.LINE_LOGIN_CHANNEL_SECRET || !env.META_CAPI_ACCESS_TOKEN ||
      !env.META_TEST_EVENT_CODE || !/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? "")) {
    return new Response("テスト設定が揃っていません。", { status: 503 });
  }

  const state = crypto.randomUUID();
  const callback = new URL("/api/line/callback", request.url);
  const authorize = new URL("https://access.line.me/oauth2/v2.1/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "2012558185",
    redirect_uri: callback.href,
    state,
    scope: "profile",
    bot_prompt: "aggressive",
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.href,
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/api/line; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

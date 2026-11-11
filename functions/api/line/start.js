const PREVIEW_HOST = "line-friend-add-test.mohs-lp.pages.dev";
const STATE_COOKIE = "mohs_line_test_state";

export function onRequestGet({ request, env }) {
  if (!env.LINE_LOGIN_CHANNEL_SECRET || !env.META_CAPI_ACCESS_TOKEN ||
      !env.META_TEST_EVENT_CODE || !/^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? "")) {
    return new Response("テスト設定が揃っていません。", { status: 503 });
  }

  const url = new URL(request.url);
  const metaTest = url.searchParams.get("mode") === "meta-test";
  if (metaTest && url.hostname !== PREVIEW_HOST) return new Response(null, { status: 404 });

  const state = metaTest ? `meta-test.${crypto.randomUUID()}` : crypto.randomUUID();
  const callback = new URL("/api/line/callback", url);
  const authorize = new URL("https://access.line.me/oauth2/v2.1/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: "2012558185",
    redirect_uri: callback.href,
    state,
    scope: "profile",
  }).toString();
  if (!metaTest) authorize.searchParams.set("bot_prompt", "aggressive");

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.href,
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/api/line; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

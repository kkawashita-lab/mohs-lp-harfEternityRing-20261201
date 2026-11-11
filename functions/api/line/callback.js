const PREVIEW_HOST = "line-friend-add-test.mohs-lp.pages.dev";
const STATE_COOKIE = "mohs_line_test_state";

function reply(message, status = 200) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=; Path=/api/line; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    },
  });
}

function readCookies(request) {
  return new Map((request.headers.get("Cookie") ?? "").split(/;\s*/).map((pair) => {
    const separator = pair.indexOf("=");
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const cookies = readCookies(request);
  const state = url.searchParams.get("state");
  if (!state || state !== cookies.get(STATE_COOKIE)) {
    return reply("テストを開始したブラウザーから再度お試しください。", 400);
  }

  const metaTest = state.startsWith("meta-test.");
  if (metaTest && url.hostname !== PREVIEW_HOST) return reply("プレビュー専用のテストです。", 404);

  const code = url.searchParams.get("code");
  if (!code) return reply("LINEログインが完了しませんでした。", 400);

  const version = env.META_GRAPH_API_VERSION;
  if (!env.LINE_LOGIN_CHANNEL_SECRET || !env.META_CAPI_ACCESS_TOKEN ||
      !env.META_TEST_EVENT_CODE || !/^v\d+\.\d+$/.test(version ?? "")) {
    return reply("テスト設定が揃っていません。", 503);
  }

  try {
    const tokenResponse = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: new URL(url.pathname, url.origin).href,
        client_id: "2012558185",
        client_secret: env.LINE_LOGIN_CHANNEL_SECRET,
      }),
    });
    if (!tokenResponse.ok) return reply("LINEログインの確認に失敗しました。", 502);
    const token = await tokenResponse.json();

    if (!metaTest) {
      const friendshipResponse = await fetch("https://api.line.me/friendship/v1/status", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!friendshipResponse.ok) return reply("LINEの友だち状態を確認できませんでした。", 502);
      const friendship = await friendshipResponse.json();
      if (url.searchParams.get("friendship_status_changed") !== "true" || friendship.friendFlag !== true) {
        return reply("このログインでは友だち追加を検知しませんでした。");
      }
    }

    const userData = {};
    for (const key of ["fbp", "fbc"]) {
      const value = cookies.get(`_${key}`);
      if (value && /^fb\.\d+\.\d+\.[A-Za-z0-9_-]{1,512}$/.test(value)) userData[key] = value;
    }
    if (!userData.fbp && !userData.fbc) {
      const message = metaTest
        ? "Metaの計測Cookieが見つかりません。プレビューLPを同じブラウザーで開いてから再度お試しください。"
        : "友だち追加を確認しました。Metaの計測Cookieが見つからなかったため、テストイベントの送信は保留されました。";
      return reply(message, 422);
    }

    const eventId = Array.from(new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(state),
    )), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const metaResponse = await fetch(`https://graph.facebook.com/${version}/1521986363312676/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.META_CAPI_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        test_event_code: env.META_TEST_EVENT_CODE,
        data: [{
          event_name: metaTest ? "LINEFriendAddedTest" : "LINEFriendAdded",
          event_id: eventId,
          event_time: Math.floor(Date.now() / 1000),
          action_source: "website",
          event_source_url: url.origin + "/",
          user_data: userData,
        }],
      }),
    });
    if (!metaResponse.ok || (await metaResponse.json()).events_received !== 1) {
      const message = metaTest
        ? "Metaへのテスト送信に失敗しました。"
        : "友だち追加は確認できましたが、Metaへのテスト送信に失敗しました。";
      return reply(message, 502);
    }
    return reply(metaTest
      ? "Metaがテストイベント LINEFriendAddedTest を受け付けました。"
      : "友だち追加を確認し、Metaへテストイベントを送信しました。");
  } catch {
    return reply("テストの通信処理に失敗しました。", 502);
  }
}

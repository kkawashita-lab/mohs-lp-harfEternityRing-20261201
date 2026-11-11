const previewOrigin = "https://line-liff-preview.mohs-lp.pages.dev";
const officialAccount = "https://line.me/R/ti/p/%40972cpsts";
const channelId = "2012558185";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

async function handoffKey(secret) {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode("mohs-liff-preview:" + secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function metaCookie(request, name) {
  const prefix = name + "=";
  const value = (request.headers.get("Cookie") ?? "").split(/;\s*/)
    .find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  return /^fb\.\d+\.\d+\.[A-Za-z0-9_-]{1,512}$/.test(value ?? "") ? value : undefined;
}

async function createLink(request, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = encoder.encode(JSON.stringify({
    fbp: metaCookie(request, "_fbp"),
    fbc: metaCookie(request, "_fbc"),
    expires: Date.now() + 15 * 60 * 1000,
  }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv },
    await handoffKey(env.LINE_LOGIN_CHANNEL_SECRET), payload);
  const link = new URL("https://liff.line.me/" + env.MOHS_LIFF_ID);
  link.searchParams.set("visit", encode(iv) + "." + encode(new Uint8Array(encrypted)));
  return json({ url: link.href });
}

async function verify(request, env) {
  const { visit, idToken } = await request.json();
  if (typeof idToken !== "string" || idToken.length > 8192) return json({ error: "invalid_token" }, 400);
  let hasMetaCookie = false;
  if (typeof visit === "string" && /^[\w-]{16}\.[\w-]{1,1800}$/.test(visit)) {
    try {
      const [iv, encrypted] = visit.split(".").map(decode);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv },
        await handoffKey(env.LINE_LOGIN_CHANNEL_SECRET), encrypted);
      const payload = JSON.parse(decoder.decode(plaintext));
      hasMetaCookie = payload.expires > Date.now() && Boolean(payload.fbp || payload.fbc);
    } catch {
      return json({ error: "invalid_visit" }, 400);
    }
  }
  const result = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) return json({ error: "line_verification_failed" }, 401);
  const profile = await result.json();
  if (!profile.sub || profile.aud !== channelId) return json({ error: "line_verification_failed" }, 401);
  return json({ hasMetaCookie });
}

function entry(env) {
  return new Response(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>MOHS JEWELRY</title>
  <style>
    body { margin: 0; background: #faf9f6; color: #17212b; font: 16px/1.6 system-ui,sans-serif; }
    main { max-width: 28rem; margin: 12vh auto 0; padding: 1.5rem; text-align: center; }
    h1 { font: 500 1.7rem Georgia,serif; }
    a { display: block; padding: .85rem; border-radius: .55rem; background: #007a34; color: white; font-weight: 700; text-decoration: none; }
    small { display: block; margin-top: 1rem; color: #394653; }
  </style>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head>
<body>
  <main>
    <h1>MOHS JEWELRY</h1>
    <a id="official" href="${officialAccount}">LINEで友だち追加・公式アカウントを開く</a>
    <small id="result" aria-live="polite">LINEアプリで開いたか確認しています。</small>
  </main>
  <script>
    (async () => {
      const result = document.getElementById("result");
      const official = document.getElementById("official");
      try {
        await liff.init({ liffId: ${JSON.stringify(env.MOHS_LIFF_ID)} });
        if (!liff.isInClient()) {
          result.textContent = "外部ブラウザで開いています。上のボタンでLINEアプリへ進めます。";
          return;
        }
        official.addEventListener("click", (event) => {
          event.preventDefault();
          liff.openWindow({ url: official.href, external: false });
        });
        const idToken = liff.getIDToken();
        if (!idToken) throw new Error("Missing LINE ID token");
        const visit = new URL(location.href).searchParams.get("visit");
        const response = await fetch("/api/liff/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, visit }),
        });
        if (!response.ok) throw new Error("LINE verification failed");
        const { hasMetaCookie } = await response.json();
        result.textContent = hasMetaCookie
          ? "LINEアプリ内で認証でき、LPの計測情報も引き継げました。"
          : "LINEアプリ内で認証できました。LPの計測情報は確認できませんでした。";
      } catch {
        result.textContent = "認証を確認できませんでした。上のボタンで公式アカウントを開けます。";
      }
    })();
  </script>
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  if (url.origin !== previewOrigin) return json({ error: "not_found" }, 404);
  if (!/^2012558185-[\w-]+$/.test(env.MOHS_LIFF_ID ?? "") || !env.LINE_LOGIN_CHANNEL_SECRET) {
    return json({ error: "liff_not_configured" }, 503);
  }

  try {
    if (url.pathname === "/api/liff/entry" && request.method === "GET") return entry(env);
    if (request.headers.get("Origin") !== previewOrigin || request.method !== "POST") {
      return json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/api/liff/link") return await createLink(request, env);
    if (url.pathname === "/api/liff/verify") return await verify(request, env);
    return json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "request_failed" }, 502);
  }
}

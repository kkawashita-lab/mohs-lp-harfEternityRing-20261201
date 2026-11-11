const productionOrigin = "https://lp.mohs-jewelry.com";
const directLineUrl = "https://lin.ee/tXXrxcO";
const lineAppUrl = "https://line.me/R/ti/p/%40972cpsts";
const channelId = "2012558185";
const liffId = "2012558185-v49RagG1";
const datasetId = "1521986363312676";
const callbackPath = "/api/line/callback";
const stateCookie = "mohs_line_state";
const windowSeconds = 600;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function response(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers },
  });
}

function finish(message, status = 200, openLine = false) {
  const launchScript = openLine ? `<script>
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      window.location.replace(document.getElementById("open-line").href);
    }
  </script>` : "";
  return response(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MOHS JEWELRY</title>
  <style>
    body { margin: 0; color: #17212b; background: #faf9f6; font: 16px/1.6 system-ui, sans-serif; }
    main { max-width: 28rem; margin: 12vh auto 0; padding: 1.5rem; text-align: center; }
    h1 { margin: 0 0 1rem; font: 500 1.7rem Georgia, serif; }
    .line-link { display: block; padding: .85rem 1rem; border-radius: .55rem; background: #007a34; color: white; font-weight: 700; text-decoration: none; }
    .return-link { color: #394653; }
  </style>
</head>
<body>
  <main>
    <h1>MOHS JEWELRY</h1>
    <p>${message}</p>
    <p><a id="open-line" class="line-link" href="${lineAppUrl}">LINEアプリで開く</a></p>
    <p><a class="return-link" href="/">商品ページに戻る</a></p>
  </main>
  ${launchScript}
</body>
</html>`, status, {
    "Content-Type": "text/html; charset=utf-8",
    "Set-Cookie": `${stateCookie}=; Path=/api/line; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  });
}

function readCookie(request, name) {
  for (const pair of (request.headers.get("Cookie") ?? "").split(/;\s*/)) {
    if (pair.startsWith(name + "=")) return pair.slice(name.length + 1);
  }
  return "";
}

function metaCookie(request, name) {
  const value = readCookie(request, name);
  return /^fb\.\d+\.\d+\.[A-Za-z0-9_-]{1,512}$/.test(value) ? value : null;
}

async function signatureKey(secret, usage) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function subjectKey(env, userId) {
  const key = await signatureKey(env.LINE_MESSAGING_CHANNEL_SECRET, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode("attribution:" + userId));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function configured(env) {
  return env.LINE_ATTRIBUTION_ENABLED === "true" && env.LINE_ATTRIBUTION_DB &&
    env.LINE_LOGIN_CHANNEL_SECRET && env.LINE_MESSAGING_CHANNEL_SECRET &&
    env.META_CAPI_ACCESS_TOKEN && /^v\d+\.\d+$/.test(env.META_GRAPH_API_VERSION ?? "");
}

function start() {
  const state = crypto.randomUUID();
  const authorize = new URL("https://access.line.me/oauth2/v2.1/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: channelId,
    redirect_uri: productionOrigin + callbackPath,
    state,
    scope: "profile",
    bot_prompt: "aggressive",
  });
  return response(null, 302, {
    Location: authorize.href,
    "Set-Cookie": `${stateCookie}=${state}; Path=/api/line; Max-Age=${windowSeconds}; Secure; HttpOnly; SameSite=Lax`,
  });
}

async function sendMatchedEvent(env, subject, now) {
  const db = env.LINE_ATTRIBUTION_DB;
  const lease = now + 45;
  const row = await db.prepare(`
    UPDATE line_friend_attribution SET claim_until = ?
    WHERE subject = ? AND sent = 0 AND claim_until <= ?
      AND ABS(visited_at - followed_at) <= ? AND expires_at > ?
    RETURNING follow_id, followed_at, fbp, fbc
  `).bind(lease, subject, now, windowSeconds, now).first();
  if (!row) return;
  try {
    const userData = {};
    if (row.fbp) userData.fbp = row.fbp;
    if (row.fbc) userData.fbc = row.fbc;
    const result = await fetch(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${datasetId}/events`, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${env.META_CAPI_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        data: [{
          event_name: "LINEFriendAdded",
          event_id: row.follow_id,
          event_time: row.followed_at,
          action_source: "website",
          event_source_url: productionOrigin + "/",
          user_data: userData,
        }],
      }),
    });
    if (!result.ok || (await result.json()).events_received !== 1) throw new Error("Meta did not accept event");
    await db.prepare("UPDATE line_friend_attribution SET sent = 1, fbp = NULL, fbc = NULL WHERE subject = ? AND claim_until = ?")
      .bind(subject, lease).run();
  } catch (error) {
    await db.prepare("UPDATE line_friend_attribution SET claim_until = 0 WHERE subject = ? AND claim_until = ?")
      .bind(subject, lease).run();
    throw error;
  }
}

async function removeExpired(env, now) {
  await env.LINE_ATTRIBUTION_DB.prepare("DELETE FROM line_friend_attribution WHERE expires_at <= ?")
    .bind(now).run();
}

async function recordVisit(env, userId, fbp, fbc, now) {
  const subject = await subjectKey(env, userId);
  await removeExpired(env, now);
  await env.LINE_ATTRIBUTION_DB.prepare(`
    INSERT INTO line_friend_attribution (subject, visited_at, fbp, fbc, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET visited_at = excluded.visited_at, fbp = excluded.fbp, fbc = excluded.fbc
    WHERE sent = 0 AND claim_until <= excluded.visited_at
  `).bind(subject, now, fbp, fbc, now + 2 * windowSeconds).run();
  try {
    await sendMatchedEvent(env, subject, now);
  } catch {
    console.error("LINE friend attribution: Meta delivery failed after login");
  }
}

async function callback(request, env, url, now) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || state !== readCookie(request, stateCookie)) {
    return finish("LINEログインを完了できませんでした。", 400);
  }

  const tokenResponse = await fetch("https://api.line.me/oauth2/v2.1/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: productionOrigin + callbackPath,
      client_id: channelId,
      client_secret: env.LINE_LOGIN_CHANNEL_SECRET,
    }),
  });
  if (!tokenResponse.ok) return finish("LINEログインを確認できませんでした。", 502);
  const token = await tokenResponse.json();
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const statusResponse = await fetch("https://api.line.me/friendship/v1/status", { headers });
  if (!statusResponse.ok) return finish("友だち登録の状態を確認できませんでした。", 502);
  const friendship = await statusResponse.json();
  if (!friendship.friendFlag) return finish("LINE公式アカウントから友だち追加できます。");

  const fbp = metaCookie(request, "_fbp");
  const fbc = metaCookie(request, "_fbc");
  if (url.searchParams.get("friendship_status_changed") === "true" && (fbp || fbc)) {
    const profileResponse = await fetch("https://api.line.me/v2/profile", { headers });
    if (!profileResponse.ok) throw new Error("LINE profile unavailable");
    const { userId } = await profileResponse.json();
    if (typeof userId !== "string" || !userId) throw new Error("LINE profile user ID unavailable");
    await recordVisit(env, userId, fbp, fbc, now);
  }
  return finish("LINEの友だち登録を確認しました。", 200, true);
}

async function webhook(request, env, now) {
  let signature;
  try {
    signature = Uint8Array.from(atob(request.headers.get("x-line-signature") ?? ""), (c) => c.charCodeAt(0));
  } catch {
    return response(null, 401);
  }
  if (signature.length !== 32) return response(null, 401);
  const body = await request.arrayBuffer();
  const key = await signatureKey(env.LINE_MESSAGING_CHANNEL_SECRET, "verify");
  if (!await crypto.subtle.verify("HMAC", key, signature, body)) return response(null, 401);

  const { events } = JSON.parse(new TextDecoder().decode(body));
  if (!Array.isArray(events)) return response(null, 400);
  if (!configured(env) || events.length === 0) return response(null, 200);
  await removeExpired(env, now);
  for (const event of events) {
    const userId = event.source?.userId;
    const followedAt = Math.floor(event.timestamp / 1000);
    if (event.type !== "follow" || event.follow?.isUnblocked !== false ||
        typeof userId !== "string" || !userId || !event.webhookEventId ||
        !Number.isFinite(followedAt) || Math.abs(now - followedAt) > 2 * windowSeconds) continue;
    const subject = await subjectKey(env, userId);
    await env.LINE_ATTRIBUTION_DB.prepare(`
      INSERT INTO line_friend_attribution (subject, follow_id, followed_at, expires_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET
        follow_id = excluded.follow_id, followed_at = excluded.followed_at
      WHERE follow_id IS NULL
    `).bind(subject, event.webhookEventId, followedAt, now + 2 * windowSeconds).run();
    await sendMatchedEvent(env, subject, now);
  }
  return response(null, 200);
}

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
  const material = await crypto.subtle.digest("SHA-256", encoder.encode("mohs-liff-production:" + secret));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function createLink(request, env, now) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = encoder.encode(JSON.stringify({
    fbp: metaCookie(request, "_fbp"),
    fbc: metaCookie(request, "_fbc"),
    issuedAt: now,
  }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv },
    await handoffKey(env.LINE_LOGIN_CHANNEL_SECRET), payload);
  const link = new URL("https://liff.line.me/" + liffId);
  link.searchParams.set("visit", encode(iv) + "." + encode(new Uint8Array(encrypted)));
  return json({ url: link.href });
}

async function verifyLiffVisit(request, env, now) {
  const { visit, idToken } = await request.json();
  if (typeof idToken !== "string" || idToken.length > 8192) return json({ error: "invalid_token" }, 400);
  let payload;
  if (typeof visit === "string" && /^[\w-]{16}\.[\w-]{1,1800}$/.test(visit)) {
    try {
      const [iv, encrypted] = visit.split(".").map(decode);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv },
        await handoffKey(env.LINE_LOGIN_CHANNEL_SECRET), encrypted);
      payload = JSON.parse(decoder.decode(plaintext));
    } catch {
      return json({ error: "invalid_visit" }, 400);
    }
  }
  if (!payload || !Number.isInteger(payload.issuedAt) || payload.issuedAt > now ||
      now - payload.issuedAt > windowSeconds) return json({ error: "expired_visit" }, 400);
  if (!payload.fbp && !payload.fbc) return response(null, 204);
  const result = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) return json({ error: "line_verification_failed" }, 401);
  const profile = await result.json();
  if (!profile.sub || profile.aud !== channelId) return json({ error: "line_verification_failed" }, 401);
  await recordVisit(env, profile.sub, payload.fbp, payload.fbc, now);
  return response(null, 204);
}

function liffEntry() {
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
    p { color: #394653; }
  </style>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head>
<body>
  <main>
    <h1>MOHS JEWELRY</h1>
    <p id="status" role="status">LINE公式アカウントを開いています…</p>
    <a id="official" href="${lineAppUrl}">LINE公式アカウントを開く</a>
  </main>
  <script>
    (async () => {
      const status = document.getElementById("status");
      const official = document.getElementById("official");
      const openOfficialAccount = () => liff.openWindow({ url: official.href, external: false });
      let selectedManually = false;
      const removeStatus = () => status.remove();
      setTimeout(removeStatus, 1500);
      try {
        await liff.init({ liffId: ${JSON.stringify(liffId)} });
        if (!liff.isInClient()) return;
        official.addEventListener("click", (event) => {
          selectedManually = true;
          event.preventDefault();
          try {
            openOfficialAccount();
          } catch {
            location.assign(official.href);
          }
        });
        const idToken = liff.getIDToken();
        const visit = new URL(location.href).searchParams.get("visit");
        if (idToken && visit) {
          const recorded = fetch("/api/line/liff/visit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken, visit }),
            keepalive: true,
          }).catch(() => {});
          let timeout;
          await Promise.race([recorded, new Promise((resolve) => {
            timeout = setTimeout(resolve, 1200);
          })]);
          clearTimeout(timeout);
        }
        if (!selectedManually) openOfficialAccount();
      } catch {
        // The regular link remains available when the app cannot open automatically.
      } finally {
        removeStatus();
      }
    })();
  </script>
</body>
</html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const isStart = request.method === "GET" && url.pathname === "/api/line/start";
  const enabled = url.origin === productionOrigin && configured(env);
  if (isStart) return enabled ? start() : response(null, 302, { Location: directLineUrl });
  if (url.origin !== productionOrigin) return response(null, 404);
  const now = Math.floor(Date.now() / 1000);
  try {
    if (request.method === "GET" && url.pathname === "/api/line/liff") return liffEntry();
    if (enabled && request.method === "POST" && request.headers.get("Origin") === productionOrigin) {
      if (url.pathname === "/api/line/liff/link") return await createLink(request, env, now);
      if (url.pathname === "/api/line/liff/visit") return await verifyLiffVisit(request, env, now);
    }
    if (request.method === "GET" && url.pathname === callbackPath && enabled) return await callback(request, env, url, now);
    if (request.method === "POST" && url.pathname === "/api/line/webhook" && env.LINE_MESSAGING_CHANNEL_SECRET) {
      return await webhook(request, env, now);
    }
    return response(null, 404);
  } catch {
    console.error("LINE friend attribution: request failed");
    return request.method === "POST" ? response(null, 502) : finish("処理を完了できませんでした。下のリンクからLINEを開けます。", 502);
  }
}

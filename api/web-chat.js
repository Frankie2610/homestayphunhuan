import { createHash, randomUUID } from "node:crypto";
import { handleConversationEvent } from "../lib/conversation.js";
import { getAdminDatabase } from "../lib/firebase-admin.js";
import { runWithWebMessengerCapture } from "../lib/messenger.js";
import { logBotError, withConversationLock } from "../lib/conversation-store.js";

const MAX_BODY_BYTES = 16_000;
const MAX_MESSAGE_LENGTH = 800;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQUESTS = 40;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function isAllowedOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    if (originUrl.host === requestUrl.host) return true;

    const configuredHost = process.env.PUBLIC_SITE_URL
      ? new URL(process.env.PUBLIC_SITE_URL).host
      : "";
    return Boolean(configuredHost && originUrl.host === configuredHost);
  } catch {
    return false;
  }
}

function validSessionId(value) {
  return /^[a-zA-Z0-9_-]{16,96}$/.test(String(value || ""));
}

function normalizePayload(value) {
  const payload = String(value || "").trim();
  if (!payload) return "";
  if (payload.length > 1000 || !/^[\p{L}\p{N}\s_|:.\/-]+$/u.test(payload)) {
    throw new Error("invalid_payload");
  }
  return payload;
}

function getClientFingerprint(request, sessionId) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  const ip = forwarded.split(",")[0].trim()
    || request.headers.get("x-real-ip")
    || "unknown";
  return createHash("sha256")
    .update(`${ip}|${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}

async function claimRateLimit(request, sessionId) {
  const key = getClientFingerprint(request, sessionId);
  const now = Date.now();
  const ref = getAdminDatabase().ref(`messengerBot/webRateLimits/${key}`);
  const result = await ref.transaction(current => {
    const start = Number(current?.windowStartedAt || 0);
    const expired = !start || now - start >= RATE_WINDOW_MS;
    const count = expired ? 0 : Number(current?.count || 0);
    if (count >= RATE_MAX_REQUESTS) return undefined;
    return {
      windowStartedAt: expired ? now : start,
      count: count + 1,
      updatedAt: now,
      expiresAt: now + RATE_WINDOW_MS * 2
    };
  });
  return result.committed;
}

export async function GET() {
  return json({
    ok: true,
    channel: "website",
    firebase: true,
    maxMessageLength: MAX_MESSAGE_LENGTH
  });
}

export async function POST(request) {
  if (!isAllowedOrigin(request)) {
    return json({ ok: false, error: "origin_not_allowed" }, 403);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "request_too_large" }, 413);
  }

  let body;
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
      return json({ ok: false, error: "request_too_large" }, 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const sessionId = String(body?.sessionId || "").trim();
  const text = String(body?.message || "").trim().slice(0, MAX_MESSAGE_LENGTH);
  let payload = "";
  try {
    payload = normalizePayload(body?.payload);
  } catch {
    return json({ ok: false, error: "invalid_payload" }, 400);
  }

  if (!validSessionId(sessionId)) {
    return json({ ok: false, error: "invalid_session" }, 400);
  }
  if (!text && !payload) {
    return json({ ok: false, error: "empty_message" }, 400);
  }

  let rateAllowed = false;
  try {
    rateAllowed = await claimRateLimit(request, sessionId);
  } catch (error) {
    console.error("Website chatbot rate-limit check failed", {
      error: error?.message || String(error)
    });
    return json({
      ok: false,
      error: "chat_service_unavailable",
      message: "Chatbot đang kết nối lại. Bạn thử gửi lại sau ít giây nhé."
    }, 503);
  }
  if (!rateAllowed) {
    return json({
      ok: false,
      error: "rate_limited",
      message: "Bạn gửi hơi nhanh. Vui lòng chờ một chút rồi thử lại nhé."
    }, 429, { "retry-after": "30" });
  }

  const psid = `web_${sessionId}`;
  const eventId = `web_${Date.now()}_${randomUUID()}`;

  try {
    const capture = await withConversationLock(psid, () =>
      runWithWebMessengerCapture(psid, () =>
        handleConversationEvent({
          psid,
          text,
          payload,
          eventId,
          attachmentType: ""
        })
      )
    );

    return json({
      ok: true,
      sessionId,
      messages: capture.messages
    });
  } catch (error) {
    console.error("Website chatbot processing error", {
      eventId,
      error: error?.message || String(error)
    });
    await logBotError(psid, {
      eventId,
      stage: "web_chat",
      error: String(error?.message || error || "unknown_error").slice(0, 500)
    }).catch(() => {});

    return json({
      ok: false,
      error: "chat_processing_failed",
      message: "Chatbot đang kết nối lại. Bạn thử gửi lại sau ít giây hoặc nhắn trực tiếp giúp mình nhé."
    }, 500);
  }
}

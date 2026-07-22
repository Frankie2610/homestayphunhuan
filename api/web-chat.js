import { createHash, randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { handleConversationEvent } from "../lib/conversation.js";
import { runWithWebMessengerCapture } from "../lib/messenger.js";
import { logBotError } from "../lib/conversation-store.js";

const MAX_BODY_BYTES = 16_000;
const MAX_MESSAGE_LENGTH = 800;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQUESTS = 40;
const PROCESSING_TIMEOUT_MS = 18_000;
const rateBuckets = new Map();

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

function pruneRateBuckets(now) {
  if (rateBuckets.size < 2_000) return;
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStartedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
  }
}

function claimRateLimit(request, sessionId) {
  const key = getClientFingerprint(request, sessionId);
  const now = Date.now();
  pruneRateBuckets(now);

  const current = rateBuckets.get(key);
  const expired = !current || now - current.windowStartedAt >= RATE_WINDOW_MS;
  const bucket = expired
    ? { windowStartedAt: now, count: 0 }
    : current;

  if (bucket.count >= RATE_MAX_REQUESTS) return false;
  rateBuckets.set(key, { ...bucket, count: bucket.count + 1 });
  return true;
}

function processingTimeout() {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("web_chat_processing_timeout");
      error.code = "WEB_CHAT_PROCESSING_TIMEOUT";
      reject(error);
    }, PROCESSING_TIMEOUT_MS);
    timer.unref?.();
  });
}

function fallbackMessages(payload, errorCode = "") {
  if (errorCode && errorCode !== "WEB_CHAT_PROCESSING_TIMEOUT") {
    return [{
      type: "text",
      text: "Chatbot chưa kết nối được dữ liệu lúc này. Bạn thử lại sau ít giây hoặc nhắn trực tiếp cho HOME giúp mình nhé.",
      quickReplies: [{ title: "Thử lại", payload: "START|AVAILABILITY" }]
    }];
  }

  if (payload === "START|AVAILABILITY") {
    return [{
      type: "text",
      text: "Bạn muốn ở ngày nào?",
      quickReplies: [
        { title: "Hôm nay", payload: "DATE|TODAY" },
        { title: "Ngày mai", payload: "DATE|TOMORROW" },
        { title: "Ngày kia", payload: "DATE|DAY_AFTER" }
      ]
    }];
  }

  if (payload === "OPEN|GALLERY") {
    return [{
      type: "template",
      text: "Bạn có thể xem hình các HOME tại thư viện ảnh.",
      buttons: [{ type: "web_url", title: "Mở thư viện ảnh", url: "/hinh-anh" }]
    }];
  }

  return [{
    type: "text",
    text: "Hệ thống dữ liệu đang phản hồi chậm. Bạn gửi giúp HOME ngày, giờ nhận phòng và số tiếng dự kiến; HOME sẽ thử kiểm tra lại ngay ở tin nhắn tiếp theo.",
    quickReplies: [{ title: "Kiểm tra lại", payload: "START|AVAILABILITY" }]
  }];
}

function safeProcessingErrorCode(error) {
  const code = String(error?.code || "").trim();
  const message = String(error?.message || "");
  if (code === "WEB_CHAT_PROCESSING_TIMEOUT") return code;
  if (code.startsWith("FIREBASE_")) return code;
  if (/Failed to parse private key|private key/i.test(message)) {
    return "FIREBASE_PRIVATE_KEY_INVALID";
  }
  if (/Thiếu biến môi trường FIREBASE_/i.test(message)) {
    return "FIREBASE_ENV_MISSING";
  }
  return "CHAT_PROCESSING_FAILED";
}

function reportProcessingError(psid, eventId, error, processingMs) {
  const timedOut = error?.code === "WEB_CHAT_PROCESSING_TIMEOUT";
  const errorCode = safeProcessingErrorCode(error);
  console.error("Website chatbot processing error", {
    eventId,
    processingMs,
    timedOut,
    errorCode,
    error: error?.message || String(error)
  });

  // Error logging must never delay the browser response when Firebase itself
  // is the slow dependency.
  void logBotError(psid, {
    eventId,
    stage: "web_chat",
    error: String(error?.message || error || "unknown_error").slice(0, 500)
  }).catch(() => {});

  return { timedOut, errorCode };
}

function streamEvent(controller, encoder, event) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

function scheduleBackgroundTask(task) {
  try {
    waitUntil(task);
    return true;
  } catch {
    // Local Node tests do not have a Vercel request context. In that case the
    // capture waits for the task normally instead of dropping it.
    return false;
  }
}

export function createStreamingResponse({
  sessionId,
  psid,
  payload,
  eventId,
  startedAt = Date.now(),
  processConversation
}) {
  const encoder = new TextEncoder();
  let disconnected = false;
  let deliveredMessages = 0;

  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = event => {
        if (disconnected) return;
        try {
          streamEvent(controller, encoder, event);
        } catch {
          disconnected = true;
        }
      };

      // Flush the response headers immediately while Firebase/Gemini run.
      sendEvent({ type: "ready", sessionId });

      const processing = Promise.resolve().then(() => processConversation(message => {
        deliveredMessages += 1;
        sendEvent({ type: "message", message });
      }));

      void Promise.race([processing, processingTimeout()])
        .then(() => {
          const processingMs = Date.now() - startedAt;
          console.info("Website chatbot stream completed", {
            eventId,
            processingMs,
            deliveredMessages
          });
          sendEvent({
            type: "done",
            ok: true,
            sessionId,
            processingMs,
            deliveredMessages
          });
        })
        .catch(error => {
          const processingMs = Date.now() - startedAt;
          const { timedOut, errorCode } = reportProcessingError(
            psid,
            eventId,
            error,
            processingMs
          );

          // If a reply was already streamed, do not add a duplicate warning.
          // Otherwise return a useful fallback before Vercel reaches its limit.
          if (!deliveredMessages) {
            for (const message of fallbackMessages(payload, errorCode)) {
              deliveredMessages += 1;
              sendEvent({ type: "message", message });
            }
          }
          sendEvent({
            type: "done",
            ok: true,
            degraded: true,
            timedOut,
            errorCode,
            sessionId,
            processingMs,
            deliveredMessages
          });
        })
        .finally(() => {
          if (disconnected) return;
          try {
            controller.close();
          } catch {
            disconnected = true;
          }
        });
    },
    cancel() {
      disconnected = true;
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function GET() {
  return json({
    ok: true,
    channel: "website",
    firebase: true,
    streaming: true,
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

  const rateAllowed = claimRateLimit(request, sessionId);
  if (!rateAllowed) {
    return json({
      ok: false,
      error: "rate_limited",
      message: "Bạn gửi hơi nhanh. Vui lòng chờ một chút rồi thử lại nhé."
    }, 429, { "retry-after": "30" });
  }

  const psid = `web_${sessionId}`;
  const eventId = `web_${Date.now()}_${randomUUID()}`;
  const startedAt = Date.now();

  const processConversation = onMessage =>
    runWithWebMessengerCapture(psid, () =>
      handleConversationEvent({
        psid,
        text,
        payload,
        eventId,
        attachmentType: ""
      }),
    {
      onMessage,
      onBackgroundTask: scheduleBackgroundTask
    });

  if (request.headers.get("accept")?.includes("text/event-stream")) {
    return createStreamingResponse({
      sessionId,
      psid,
      payload,
      eventId,
      startedAt,
      processConversation
    });
  }

  try {
    const capture = await Promise.race([
      processConversation(),
      processingTimeout()
    ]);

    const processingMs = Date.now() - startedAt;
    console.info("Website chatbot request completed", { eventId, processingMs });

    return json({
      ok: true,
      sessionId,
      processingMs,
      messages: capture.messages
    }, 200, { "server-timing": `chat;dur=${processingMs}` });
  } catch (error) {
    const processingMs = Date.now() - startedAt;
    const { timedOut, errorCode } = reportProcessingError(psid, eventId, error, processingMs);

    if (timedOut) {
      return json({
        ok: true,
        degraded: true,
        sessionId,
        processingMs,
        errorCode,
        messages: fallbackMessages(payload, errorCode)
      }, 200, { "server-timing": `chat;dur=${processingMs};desc=timeout` });
    }

    return json({
      ok: false,
      error: "chat_processing_failed",
      message: "Chatbot đang kết nối lại. Bạn thử gửi lại sau ít giây hoặc nhắn trực tiếp giúp mình nhé."
    }, 500);
  }
}

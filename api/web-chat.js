import { randomUUID } from "node:crypto";
import { handleConversationEvent } from "../lib/conversation.js";
import {
  logBotError
} from "../lib/conversation-store.js";
import { captureWebsiteDelivery } from "../lib/messenger.js";
import { config } from "../lib/config.js";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 18;
const requestBuckets = new Map();

const WEB_CHAT_PROCESSING_TIMEOUT_MS = Math.max(10_000, Number(process.env.WEB_CHAT_PROCESSING_TIMEOUT_MS || 20_000));
const websiteLocks = new Map();

function timeoutError(label, ms) {
  const error = new Error(`${label}_timeout_after_${ms}ms`);
  error.code = "WEB_CHAT_TIMEOUT";
  return error;
}

function withDeadline(promise, ms, label = "web_chat") {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Website widget already serializes sends in the browser. An in-process lock is
 * enough here and avoids two extra Firebase transactions per message. Messenger
 * keeps using the distributed Firebase lock in its own webhook path.
 */
async function withWebsiteLock(sessionId, handler) {
  const previous = websiteLocks.get(sessionId) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  websiteLocks.set(sessionId, queued);

  await previous.catch(() => {});
  try {
    return await handler();
  } finally {
    release();
    if (websiteLocks.get(sessionId) === queued) websiteLocks.delete(sessionId);
  }
}

const REQUIRED_FIREBASE_ENV = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
];

function missingWebChatEnv() {
  const missing = [];
  if (!String(process.env.FIREBASE_DATABASE_URL || "").trim()) {
    missing.push("FIREBASE_DATABASE_URL");
  }

  const serviceAccountJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!serviceAccountJson) {
    missing.push(...REQUIRED_FIREBASE_ENV.filter(
      name => !String(process.env[name] || "").trim()
    ));
  }

  return missing;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function allowedOrigins(request) {
  const values = new Set();
  const requestOrigin = normalizeOrigin(request.url);
  if (requestOrigin) values.add(requestOrigin);

  const forwardedHost = String(request.headers.get("x-forwarded-host") || "").trim();
  const forwardedProto = String(request.headers.get("x-forwarded-proto") || "https").trim();
  if (forwardedHost) values.add(`${forwardedProto}://${forwardedHost}`);

  for (const item of String(process.env.WEB_CHAT_ALLOWED_ORIGINS || "").split(",")) {
    const origin = normalizeOrigin(item.trim());
    if (origin) values.add(origin);
  }

  values.add("http://localhost:3000");
  values.add("http://localhost:5173");
  values.add("http://127.0.0.1:3000");
  values.add("http://127.0.0.1:5173");
  return values;
}


function isLocalDevelopmentOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function corsHeaders(request) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) return {};
  if (!allowedOrigins(request).has(origin) && !isLocalDevelopmentOrigin(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function clientIp(request) {
  return String(
    request.headers.get("x-real-ip")
      || request.headers.get("x-forwarded-for")
      || "unknown"
  ).split(",")[0].trim().slice(0, 80);
}

function rateLimitKey(request, sessionId) {
  return `${clientIp(request)}:${sessionId}`;
}

function consumeRateLimit(request, sessionId) {
  const now = Date.now();
  const key = rateLimitKey(request, sessionId);
  const current = requestBuckets.get(key);

  if (!current || now >= current.resetAt) {
    requestBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }

  current.count += 1;
  if (current.count <= RATE_LIMIT) {
    return { allowed: true, retryAfter: 0 };
  }

  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

function safeToken(value, maxLength = 100) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, maxLength);
}

function normalizeSessionId(value) {
  const raw = safeToken(value, 96).replace(/^web_+/i, "");
  if (raw.length < 8) return "";
  return `web_${raw}`;
}

function normalizeMessage(value) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, 1200);
}

function normalizePayload(value) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, 1000);
}

function normalizeOutput(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(item => item && typeof item === "object")
    .slice(0, 12)
    .map(item => {
      if (item.type === "images") {
        return {
          id: String(item.id || ""),
          type: "images",
          imageUrls: (Array.isArray(item.imageUrls) ? item.imageUrls : [])
            .map(url => String(url || "").trim())
            .filter(url => /^https:\/\//i.test(url))
            .slice(0, 4),
          createdAt: Number(item.createdAt || Date.now())
        };
      }

      if (item.type === "button_template") {
        return {
          id: String(item.id || ""),
          type: "button_template",
          text: String(item.text || "").slice(0, 4000),
          buttons: (Array.isArray(item.buttons) ? item.buttons : []).slice(0, 3).map(button => ({
            type: button?.type === "postback" ? "postback" : "web_url",
            title: String(button?.title || "").slice(0, 40),
            payload: String(button?.payload || "").slice(0, 1000),
            url: /^https:\/\//i.test(String(button?.url || ""))
              ? String(button.url)
              : ""
          })),
          createdAt: Number(item.createdAt || Date.now())
        };
      }

      return {
        id: String(item.id || ""),
        type: "text",
        text: String(item.text || "").slice(0, 4000),
        quickReplies: (Array.isArray(item.quickReplies) ? item.quickReplies : [])
          .slice(0, 13)
          .map(reply => ({
            title: String(reply?.title || "").slice(0, 40),
            payload: String(reply?.payload || reply?.title || "").slice(0, 1000)
          })),
        createdAt: Number(item.createdAt || Date.now())
      };
    });
}

export async function GET(request) {
  const headers = corsHeaders(request);
  if (headers === null) return json({ ok: false, error: "origin_not_allowed" }, 403);
  const missing = missingWebChatEnv();
  return json({
    ok: true,
    service: "website-ai-chat",
    brand: "Homestay Quận Phú Nhuận",
    configured: missing.length === 0,
    fastMode: config.webChatFastMode,
    geminiRewrite: config.webChatGeminiRewrite,
    missing,
    time: new Date().toISOString()
  }, 200, headers);
}

export async function OPTIONS(request) {
  const headers = corsHeaders(request);
  if (headers === null) return json({ ok: false, error: "origin_not_allowed" }, 403);
  return new Response(null, { status: 204, headers });
}

export async function POST(request) {
  const headers = corsHeaders(request);
  if (headers === null) {
    return json({ ok: false, error: "origin_not_allowed" }, 403);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 16_000) {
    return json({ ok: false, error: "request_too_large" }, 413, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, headers);
  }

  const psid = normalizeSessionId(body?.sessionId);
  const message = normalizeMessage(body?.message);
  const payload = normalizePayload(body?.payload);
  const clientMessageId = safeToken(body?.clientMessageId, 100) || randomUUID();

  if (!psid) {
    return json({ ok: false, error: "invalid_session" }, 400, headers);
  }
  if (!message && !payload) {
    return json({ ok: false, error: "empty_message" }, 400, headers);
  }

  const missing = missingWebChatEnv();
  if (missing.length) {
    return json({
      ok: false,
      error: "server_configuration_missing",
      missing,
      message: "Chatbot chưa được kết nối Firebase ở môi trường hiện tại."
    }, 503, headers);
  }

  const rate = consumeRateLimit(request, psid);
  if (!rate.allowed) {
    return json(
      { ok: false, error: "rate_limited", retryAfter: rate.retryAfter },
      429,
      { ...headers, "retry-after": String(rate.retryAfter) }
    );
  }

  const eventId = `web_${clientMessageId}`;

  try {
    const startedAt = Date.now();
    const delivery = await withDeadline(
      captureWebsiteDelivery(psid, () =>
        withWebsiteLock(psid, () =>
          handleConversationEvent({
            psid,
            text: message,
            payload,
            eventId,
            attachmentType: ""
          })
        )
      ),
      WEB_CHAT_PROCESSING_TIMEOUT_MS,
      "web_chat_processing"
    );
    const processingMs = Date.now() - startedAt;

    const messages = normalizeOutput(delivery.messages);
    if (!messages.length) {
      messages.push({
        id: `web_fallback_${Date.now()}`,
        type: "text",
        text: "Mình chưa nhận diện được yêu cầu. Bạn thử gửi ngày, giờ và số tiếng muốn ở nhé.",
        quickReplies: [
          { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
          { title: "Giá & combo", payload: "FAQ|PRICE" },
          { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
        ],
        createdAt: Date.now()
      });
    }

    console.log("Website chatbot response", {
      psid: psid.slice(-12),
      processingMs,
      messageCount: messages.length
    });

    return json({
      ok: true,
      sessionId: psid,
      messages,
      processingMs,
      fastMode: config.webChatFastMode
    }, 200, headers);
  } catch (error) {
    console.error("Website chatbot processing error", {
      psid,
      eventId,
      error: String(error?.message || error || "unknown_error")
    });

    // Never await an error log here. If Firebase is the stalled dependency,
    // awaiting the log would make the timeout handler stall a second time and
    // the browser would abort with DOMException code 23.
    logBotError(psid, {
      eventId,
      stage: "web_chat",
      error: String(error?.message || error || "unknown_error").slice(0, 500)
    }).catch(() => {});

    const rawError = String(error?.message || error || "unknown_error");
    const errorCode = rawError.includes("Thiếu biến môi trường")
      ? "server_configuration_missing"
      : error?.code === "WEB_CHAT_TIMEOUT" || rawError.includes("web_chat_processing_timeout")
        ? "chat_processing_timeout"
        : rawError.includes("conversation_busy")
          ? "conversation_busy"
          : "chat_processing_failed";

    const status = errorCode === "chat_processing_timeout" ? 504 : 500;
    return json({
      ok: false,
      error: errorCode,
      message: errorCode === "server_configuration_missing"
        ? "Backend chatbot chưa có đủ biến môi trường Firebase. Hãy kiểm tra file .env.local hoặc cấu hình môi trường đang chạy."
        : errorCode === "chat_processing_timeout"
          ? "Backend xử lý quá thời gian. Hãy kiểm tra kết nối Firebase/Gemini trong terminal local."
          : "Chatbot đang kết nối lại. Bạn thử gửi lại sau ít giây hoặc nhắn trực tiếp giúp mình nhé."
    }, status, headers);
  }
}

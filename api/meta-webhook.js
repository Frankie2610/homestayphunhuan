import { waitUntil } from "@vercel/functions";
import { handleConversationEvent, isUrgentBookingMessage } from "../lib/conversation.js";
import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  logBotError,
  withConversationLock
} from "../lib/conversation-store.js";
import { requireEnv } from "../lib/config.js";
import { sendText } from "../lib/messenger.js";
import {
  getConversationControl,
  handlePageEcho,
  isCustomerResumeRequest,
  recordIncomingWhileHuman,
  rememberBotOutboundMessage,
  setConversationControl
} from "../lib/conversation-control.js";
import { notifyOwner } from "../lib/owner-notifier.js";
import { verifyMetaSignature } from "../lib/meta-signature.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export async function GET(request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const verifyToken = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && verifyToken === requireEnv("META_VERIFY_TOKEN")) {
    return new Response(challenge || "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export function extractIncomingContent(event = {}) {
  const attachments = Array.isArray(event?.message?.attachments)
    ? event.message.attachments
    : [];
  const isEcho = event?.message?.is_echo === true;
  return {
    psid: isEcho ? (event?.recipient?.id || "") : (event?.sender?.id || ""),
    isEcho,
    text: event?.message?.text || "",
    payload: event?.message?.quick_reply?.payload || event?.postback?.payload || "",
    attachmentType: attachments[0]?.type || "",
    messageId: event?.message?.mid || "",
    appId: event?.message?.app_id || ""
  };
}

async function processSingleEvent(entry, event) {
  const {
    psid,
    isEcho,
    text,
    payload,
    attachmentType,
    messageId,
    appId
  } = extractIncomingContent(event);
  if (!psid) return;

  if (isEcho) {
    const echoEventId = `echo_${messageId || `${entry.id || "page"}_${event.timestamp || Date.now()}_${psid}`}`;
    const claimed = await claimWebhookEvent(echoEventId);
    if (!claimed) return;
    try {
      await withConversationLock(psid, () =>
        handlePageEcho({ psid, messageId, text, attachmentType, appId })
      );
      await completeWebhookEvent(echoEventId);
    } catch (error) {
      console.error("Messenger echo processing error:", { echoEventId, psid, error });
      await failWebhookEvent(echoEventId, error).catch(() => {});
      await logBotError(psid, {
        eventId: echoEventId,
        stage: "process_echo",
        error: String(error?.message || error || "unknown_error").slice(0, 500)
      }).catch(() => {});
    }
    return;
  }

  if (!text && !payload && !attachmentType) return;

  const eventId = messageId
    || `${entry.id || "page"}_${event.timestamp || Date.now()}_${psid}`;
  const claimed = await claimWebhookEvent(eventId);
  if (!claimed) return;

  let controlMode = "bot";
  try {
    await withConversationLock(psid, async () => {
      const control = await getConversationControl(psid);
      controlMode = control.mode;
      if (control.mode === "human") {
        const canResume = control.allowCustomerResume === true
          && isCustomerResumeRequest(text, payload);
        if (!canResume) {
          await recordIncomingWhileHuman({ psid, text, payload, eventId, attachmentType });
          if (isUrgentBookingMessage(text)) {
            await notifyOwner(psid, {
              type: "urgent_while_human",
              priority: "high",
              title: "Khách nhắn gấp khi nhân viên đang tư vấn",
              message: text || "Khách vừa gửi yêu cầu gấp.",
              context: {},
              forceExternal: true
            }).catch(() => {});
          }
          return;
        }
        await setConversationControl(psid, "bot", {
          updatedBy: "customer",
          reason: "customer_requested_bot_resume",
          actorName: "Khách Messenger",
          source: "incoming_message",
          allowCustomerResume: false
        });
        controlMode = "bot";
      }
      await handleConversationEvent({ psid, text, payload, eventId, attachmentType });
    });
    await completeWebhookEvent(eventId);
  } catch (error) {
    console.error("Messenger event processing error:", { eventId, psid, error });
    await failWebhookEvent(eventId, error).catch(() => {});
    await logBotError(psid, {
      eventId,
      stage: "process_event",
      error: String(error?.message || error || "unknown_error").slice(0, 500)
    }).catch(() => {});
    await notifyOwner(psid, {
      type: "bot_error",
      priority: "high",
      title: "Chatbot gặp lỗi xử lý",
      message: String(error?.message || error || "unknown_error").slice(0, 500),
      context: { eventId },
      forceExternal: true
    }).catch(() => {});

    // Chỉ gửi câu dự phòng khi bot đang nắm cuộc trò chuyện. Nếu nhân viên
    // đang tư vấn, bot phải im lặng để không chen ngang.
    if (controlMode === "bot") {
      try {
        const result = await sendText(
          psid,
          "Mình vừa gặp lỗi kết nối tạm thời nên chưa xử lý trọn câu hỏi. Bạn nhắn lại giúp mình một lần nữa, hoặc bấm kiểm tra lịch nhé.",
          [
            { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
            { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
          ]
        );
        await rememberBotOutboundMessage(psid, result?.message_id, "fallback").catch(() => {});
      } catch (fallbackError) {
        await logBotError(psid, {
          eventId,
          stage: "fallback_reply",
          error: String(fallbackError?.message || fallbackError || "unknown_error").slice(0, 500)
        }).catch(() => {});
      }
    }
  }
}

async function processPayload(body) {
  if (body?.object !== "page") return;

  const tasks = [];
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      tasks.push(processSingleEvent(entry, event));
    }
  }
  await Promise.allSettled(tasks);
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";
  const valid = verifyMetaSignature(rawBody, signature, requireEnv("META_APP_SECRET"));
  if (!valid) return json({ ok: false, error: "invalid_signature" }, 401);

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  waitUntil(processPayload(body).catch(error => {
    console.error("Messenger webhook payload error:", error);
  }));

  return json({ ok: true });
}

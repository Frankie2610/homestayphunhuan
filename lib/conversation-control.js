import { getAdminDatabase } from "./firebase-admin.js";
import { config } from "./config.js";

const VALID_MODES = new Set(["bot", "human"]);

function safeKey(value) {
  return String(value || "").replace(/[.#$\/\[\]]/g, "_");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeControlMode(value, fallback = "bot") {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : fallback;
}

export function shouldPauseFromEcho({ knownBotMessage = false, autoPauseOnHumanReply = true } = {}) {
  return !knownBotMessage && autoPauseOnHumanReply !== false;
}

export function isCustomerResumeRequest(text = "", payload = "") {
  if (["BOT|RESUME", "GET_STARTED", "START|AVAILABILITY"].includes(String(payload || ""))) {
    return true;
  }
  const normalized = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /\b(quay lai bot|bat bot|bot tu van|bot kiem tra|tiep tuc voi bot|kiem tra tiep|tu dong kiem tra)\b/.test(normalized);
}

export async function getControlSettings() {
  const snap = await getAdminDatabase().ref("messengerBot/settings").get();
  const value = snap.val() || {};
  return {
    defaultMode: normalizeControlMode(value.defaultMode, "bot"),
    autoPauseOnHumanReply: value.autoPauseOnHumanReply !== false
  };
}

export async function getConversationControl(psid) {
  const key = safeKey(psid);
  const [controlSnap, settings] = await Promise.all([
    getAdminDatabase().ref(`messengerBot/controls/${key}`).get(),
    getControlSettings()
  ]);
  const control = controlSnap.val() || {};
  return {
    ...control,
    mode: normalizeControlMode(control.mode, settings.defaultMode),
    autoPauseOnHumanReply: settings.autoPauseOnHumanReply,
    defaultMode: settings.defaultMode
  };
}

export async function setConversationControl(psid, mode, {
  updatedBy = "system",
  reason = "manual",
  actorName = "",
  source = "backend",
  allowCustomerResume = false
} = {}) {
  const normalized = normalizeControlMode(mode);
  const key = safeKey(psid);
  const now = Date.now();
  const db = getAdminDatabase();
  const payload = {
    mode: normalized,
    updatedAt: now,
    updatedBy,
    actorName: String(actorName || "").slice(0, 120),
    reason: String(reason || "manual").slice(0, 160),
    source: String(source || "backend").slice(0, 60),
    allowCustomerResume: allowCustomerResume === true
  };

  const updates = {
    [`messengerBot/controls/${key}`]: payload,
    [`messengerBot/conversations/${key}/controlMode`]: normalized,
    [`messengerBot/conversations/${key}/controlUpdatedAt`]: now,
    [`messengerBot/leads/${key}/controlMode`]: normalized,
    [`messengerBot/leads/${key}/controlUpdatedAt`]: now
  };
  if (normalized === "bot") {
    updates[`messengerBot/conversations/${key}/state`] = "new";
    updates[`messengerBot/conversations/${key}/handoffRequested`] = false;
  }
  await db.ref().update(updates);

  await db.ref(`messengerBot/controlAudit/${key}`).push({
    ...payload,
    createdAt: now
  });

  return payload;
}

export async function rememberBotOutboundMessage(psid, messageId, type = "text") {
  if (!messageId) return;
  // Website capture IDs never return as Facebook echo events, so persisting
  // them only adds an unnecessary Firebase round trip to every web reply.
  if (String(psid || "").startsWith("web_")) return;
  const key = safeKey(psid);
  const mid = safeKey(messageId);
  const now = Date.now();
  await getAdminDatabase().ref(`messengerBot/botOutboundMessages/${key}/${mid}`).set({
    messageId,
    type,
    createdAt: now,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000
  });
}

export async function isKnownBotOutboundMessage(psid, messageId) {
  if (!messageId) return false;
  const key = safeKey(psid);
  const mid = safeKey(messageId);
  const ref = getAdminDatabase().ref(`messengerBot/botOutboundMessages/${key}/${mid}`);
  const snap = await ref.get();
  if (!snap.exists()) return false;
  const value = snap.val() || {};
  if (value.expiresAt && Number(value.expiresAt) < Date.now()) {
    await ref.remove().catch(() => {});
    return false;
  }
  return true;
}

export async function handlePageEcho({
  psid,
  messageId = "",
  text = "",
  attachmentType = "",
  appId = ""
}) {
  const sameApp = Boolean(config.metaAppId && appId && String(appId) === String(config.metaAppId));
  let knownBotMessage = sameApp || await isKnownBotOutboundMessage(psid, messageId);
  // Echo có thể tới rất sát thời điểm Send API trả message_id. Chờ ngắn rồi
  // kiểm tra lại để tránh vô tình tắt bot do race condition.
  if (!knownBotMessage && messageId) {
    await sleep(180);
    knownBotMessage = await isKnownBotOutboundMessage(psid, messageId);
  }
  const control = await getConversationControl(psid);
  const pause = shouldPauseFromEcho({
    knownBotMessage,
    autoPauseOnHumanReply: control.autoPauseOnHumanReply
  });

  if (knownBotMessage) {
    return { kind: "bot_echo", paused: false, control };
  }

  const now = Date.now();
  const key = safeKey(psid);
  const db = getAdminDatabase();
  await db.ref(`messengerBot/messages/${key}`).push({
    direction: "out",
    senderType: "human",
    source: "facebook_page_echo",
    text: String(text || "").slice(0, 2000),
    attachmentType: String(attachmentType || "").slice(0, 60),
    metaMessageId: String(messageId || "").slice(0, 500),
    appId: String(appId || "").slice(0, 120),
    createdAt: now
  });

  if (pause) {
    await setConversationControl(psid, "human", {
      updatedBy: "facebook_page",
      reason: "human_reply_detected",
      actorName: "Nhân viên Page",
      source: "message_echoes",
      allowCustomerResume: false
    });
  }

  return { kind: "human_echo", paused: pause, control };
}

export async function recordIncomingWhileHuman({
  psid,
  text = "",
  payload = "",
  eventId = "",
  attachmentType = ""
}) {
  const key = safeKey(psid);
  const now = Date.now();
  const db = getAdminDatabase();
  await db.ref().update({
    [`messengerBot/conversations/${key}/controlMode`]: "human",
    [`messengerBot/conversations/${key}/lastInteractionAt`]: now,
    [`messengerBot/conversations/${key}/updatedAt`]: now,
    [`messengerBot/leads/${key}/controlMode`]: "human",
    [`messengerBot/leads/${key}/updatedAt`]: now,
    [`messengerBot/leads/${key}/status`]: "human_active"
  });
  await db.ref(`messengerBot/messages/${key}`).push({
    direction: "in",
    senderType: "customer",
    source: "facebook",
    text: String(text || "").slice(0, 2000),
    payload: String(payload || "").slice(0, 1000),
    eventId: String(eventId || "").slice(0, 500),
    attachmentType: String(attachmentType || "").slice(0, 60),
    suppressedByControlMode: true,
    createdAt: now
  });
}

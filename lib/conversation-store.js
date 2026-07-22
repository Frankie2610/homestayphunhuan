import { randomUUID } from "node:crypto";
import { getAdminDatabase } from "./firebase-admin.js";
import { config } from "./config.js";

function safeKey(value) {
  return String(value || "").replace(/[.#$\/\[\]]/g, "_");
}

function channelFor(psid) {
  const website = String(psid || "").startsWith("web_");
  return website
    ? { id: "website", label: "Website" }
    : { id: "facebook", label: "Facebook Messenger" };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getConversation(psid) {
  const snap = await getAdminDatabase().ref(`messengerBot/conversations/${safeKey(psid)}`).get();
  if (!snap.exists()) return null;
  const value = snap.val();
  if (value.expiresAt && Number(value.expiresAt) < Date.now()) return null;
  return value;
}

export async function saveConversation(psid, patch) {
  const now = Date.now();
  const channel = channelFor(psid);
  const ref = getAdminDatabase().ref(`messengerBot/conversations/${safeKey(psid)}`);
  const current = (await ref.get()).val() || {};
  const next = {
    ...current,
    ...patch,
    context: { ...(current.context || {}), ...(patch.context || {}) },
    psid,
    source: channel.id,
    updatedAt: now,
    lastInteractionAt: now,
    windowExpiresAt: now + config.conversationWindowMs,
    expiresAt: now + config.conversationTtlMs
  };
  await ref.set(next);
  return next;
}

export async function saveLead(psid, lead) {
  const now = Date.now();
  const channel = channelFor(psid);
  await getAdminDatabase().ref(`messengerBot/leads/${safeKey(psid)}`).update({
    ...lead,
    psid,
    source: channel.label,
    updatedAt: now,
    createdAt: lead.createdAt || now,
    status: lead.status || "new"
  });
}

export async function logMessage(psid, direction, payload) {
  const key = safeKey(psid);
  const ref = getAdminDatabase().ref(`messengerBot/messages/${key}`).push();
  await ref.set({
    direction,
    ...payload,
    createdAt: Date.now()
  });
}


export async function createOwnerAlert(psid, payload = {}) {
  const ref = getAdminDatabase().ref("messengerBot/alerts").push();
  const channel = channelFor(psid);
  const alert = {
    psid: safeKey(psid),
    source: channel.label,
    status: "unread",
    priority: payload.priority || "normal",
    type: payload.type || "message",
    title: payload.title || "Khách nhắn Messenger",
    message: String(payload.message || "").slice(0, 1000),
    context: payload.context || {},
    afterHours: payload.afterHours === true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await ref.set(alert);
  return { id: ref.key, ...alert };
}

export async function claimOwnerAlertNotification(psid, type = "message", cooldownMs = 0) {
  const key = `${safeKey(psid)}_${safeKey(type)}`;
  const ref = getAdminDatabase().ref(`messengerBot/alertCooldown/${key}`);
  const now = Date.now();
  const result = await ref.transaction(current => {
    const lastSentAt = Number(current?.lastSentAt || 0);
    if (cooldownMs > 0 && now - lastSentAt < cooldownMs) return undefined;
    return {
      lastSentAt: now,
      count: Number(current?.count || 0) + 1
    };
  });
  return result.committed;
}

export async function logBotError(psid, payload = {}) {
  const ref = getAdminDatabase().ref("messengerBot/errors").push();
  await ref.set({
    psid: safeKey(psid),
    ...payload,
    createdAt: Date.now()
  });
}

/**
 * Claims an event with a short lease. Failed/expired claims can be retried,
 * while successfully completed events are permanently deduplicated.
 */
export async function claimWebhookEvent(eventId) {
  if (!eventId) return true;
  const month = new Date().toISOString().slice(0, 7);
  const ref = getAdminDatabase().ref(`messengerBot/processedEvents/${month}/${safeKey(eventId)}`);
  const now = Date.now();
  const leaseMs = 2 * 60 * 1000;

  const result = await ref.transaction(current => {
    if (current?.status === "done") return undefined;
    if (current?.status === "processing" && Number(current.leaseUntil || 0) > now) {
      return undefined;
    }
    return {
      ...(current || {}),
      status: "processing",
      attempts: Number(current?.attempts || 0) + 1,
      claimedAt: now,
      leaseUntil: now + leaseMs
    };
  });
  return result.committed;
}

export async function completeWebhookEvent(eventId) {
  if (!eventId) return;
  const month = new Date().toISOString().slice(0, 7);
  await getAdminDatabase()
    .ref(`messengerBot/processedEvents/${month}/${safeKey(eventId)}`)
    .update({ status: "done", completedAt: Date.now(), leaseUntil: 0 });
}

export async function failWebhookEvent(eventId, error) {
  if (!eventId) return;
  const month = new Date().toISOString().slice(0, 7);
  await getAdminDatabase()
    .ref(`messengerBot/processedEvents/${month}/${safeKey(eventId)}`)
    .update({
      status: "failed",
      failedAt: Date.now(),
      leaseUntil: 0,
      error: String(error?.message || error || "unknown_error").slice(0, 500)
    });
}

/**
 * Serializes messages from the same Messenger user. This prevents two rapid
 * webhook deliveries from reading and overwriting the same conversation state.
 */
export async function withConversationLock(psid, handler) {
  const owner = randomUUID();
  const ref = getAdminDatabase().ref(`messengerBot/locks/conversations/${safeKey(psid)}`);
  const leaseMs = 60_000;
  let acquired = false;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const now = Date.now();
    const result = await ref.transaction(current => {
      if (current && current.owner !== owner && Number(current.leaseUntil || 0) > now) {
        return undefined;
      }
      return { owner, acquiredAt: now, leaseUntil: now + leaseMs };
    });

    if (result.committed) {
      acquired = true;
      break;
    }
    await sleep(100 + attempt * 40);
  }

  if (!acquired) throw new Error("conversation_busy");

  try {
    return await handler();
  } finally {
    await ref.transaction(current => {
      if (current?.owner === owner) return null;
      return current;
    }).catch(() => {});
  }
}

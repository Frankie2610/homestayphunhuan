import { randomUUID } from "node:crypto";
import { getAdminDatabase, firebaseReadWithTimeout } from "./firebase-admin.js";
import { config } from "./config.js";

function safeKey(value) {
  return String(value || "").replace(/[.#$\/\[\]]/g, "_");
}

function channelInfo(psid) {
  const isWebsite = String(psid || "").startsWith("web_");
  return {
    sourceKey: isWebsite ? "website" : "facebook",
    sourceLabel: isWebsite ? "Website AI Chat" : "Facebook Messenger"
  };
}

const websiteConversationCache = new Map();

function isWebsiteConversation(psid) {
  return String(psid || "").startsWith("web_");
}

function getCachedWebsiteConversation(psid) {
  const cached = websiteConversationCache.get(String(psid || ""));
  if (!cached) return undefined;
  if (Number(cached.expiresAt || 0) <= Date.now()) {
    websiteConversationCache.delete(String(psid || ""));
    return undefined;
  }
  return cached.value;
}

function setCachedWebsiteConversation(psid, value) {
  websiteConversationCache.set(String(psid || ""), {
    value,
    expiresAt: Date.now() + Math.max(30_000, Number(config.webChatCacheTtlMs || 600_000))
  });
}

function persistWebsiteConversationInBackground(ref, value, psid) {
  ref.set(value).catch(error => {
    console.warn("Website conversation persistence delayed", {
      psid: safeKey(psid),
      error: String(error?.message || error || "firebase_write_failed").slice(0, 240)
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getConversation(psid) {
  if (isWebsiteConversation(psid)) {
    const cached = getCachedWebsiteConversation(psid);
    if (cached !== undefined) return cached;

    // The standalone local clone must not block every reply on a cloud session
    // read. Keep the live session in RAM while the local server is running.
    // Production/serverless deployments still read Firebase so state survives
    // cold starts.
    if (config.localChatServer && config.webChatFastMode) {
      setCachedWebsiteConversation(psid, null);
      return null;
    }
  }

  const snap = await firebaseReadWithTimeout(
    getAdminDatabase().ref(`messengerBot/conversations/${safeKey(psid)}`).get(),
    "conversation_read",
    config.webChatFirebaseReadTimeoutMs
  );
  if (!snap.exists()) {
    if (isWebsiteConversation(psid)) setCachedWebsiteConversation(psid, null);
    return null;
  }
  const value = snap.val();
  if (value.expiresAt && Number(value.expiresAt) < Date.now()) {
    if (isWebsiteConversation(psid)) setCachedWebsiteConversation(psid, null);
    return null;
  }
  if (isWebsiteConversation(psid)) setCachedWebsiteConversation(psid, value);
  return value;
}

export async function saveConversation(psid, patch) {
  const now = Date.now();
  const ref = getAdminDatabase().ref(`messengerBot/conversations/${safeKey(psid)}`);
  const web = isWebsiteConversation(psid);
  let current;

  if (web) {
    const cached = getCachedWebsiteConversation(psid);
    current = cached && typeof cached === "object" ? cached : {};
  } else {
    current = (await ref.get()).val() || {};
  }

  const channel = channelInfo(psid);
  const next = {
    ...current,
    ...patch,
    context: { ...(current.context || {}), ...(patch.context || {}) },
    psid,
    source: channel.sourceKey,
    updatedAt: now,
    lastInteractionAt: now,
    windowExpiresAt: now + config.conversationWindowMs,
    expiresAt: now + config.conversationTtlMs
  };

  if (web && config.webChatFastMode) {
    setCachedWebsiteConversation(psid, next);
    persistWebsiteConversationInBackground(ref, next, psid);
    return next;
  }

  await ref.set(next);
  if (web) setCachedWebsiteConversation(psid, next);
  return next;
}

export async function saveLead(psid, lead, { critical = false } = {}) {
  const now = Date.now();
  const channel = channelInfo(psid);
  const task = getAdminDatabase().ref(`messengerBot/leads/${safeKey(psid)}`).update({
    ...lead,
    psid,
    source: channel.sourceLabel,
    updatedAt: now,
    createdAt: lead.createdAt || now,
    status: lead.status || "new"
  });

  // Lead analytics must not delay the visible website reply. Critical booking
  // confirmation steps still use their own awaited operations elsewhere.
  if (isWebsiteConversation(psid) && config.webChatFastMode && !critical) {
    task.catch(error => console.warn("Website lead persistence delayed", {
      psid: safeKey(psid),
      error: String(error?.message || error || "firebase_write_failed").slice(0, 240)
    }));
    return;
  }

  await task;
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
  const channel = channelInfo(psid);
  const ref = getAdminDatabase().ref("messengerBot/alerts").push();
  const alert = {
    psid: safeKey(psid),
    source: channel.sourceLabel,
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

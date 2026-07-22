import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { config, requireEnv } from "./config.js";

const webMessengerStorage = new AsyncLocalStorage();

function getWebCapture(recipientId) {
  const capture = webMessengerStorage.getStore();
  if (!capture || capture.recipientId !== recipientId) return null;
  return capture;
}

function captureWebMessage(recipientId, message) {
  const capture = getWebCapture(recipientId);
  if (!capture) return null;

  const messageId = `web_${randomUUID()}`;
  capture.messages.push({ id: messageId, ...message });
  return {
    recipient_id: recipientId,
    message_id: messageId,
    webCaptured: true
  };
}

/**
 * Reuses the Messenger conversation engine for the website without making a
 * Meta Send API request. AsyncLocalStorage keeps concurrent visitors isolated.
 */
export function runWithWebMessengerCapture(recipientId, handler) {
  const capture = { recipientId, messages: [] };
  return webMessengerStorage.run(capture, async () => {
    const result = await handler();
    return { result, messages: capture.messages };
  });
}

function graphUrl(path) {
  const token = encodeURIComponent(requireEnv("META_PAGE_ACCESS_TOKEN"));
  return `https://graph.facebook.com/${config.graphVersion}/${path}?access_token=${token}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function graphPost(path, payload) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(graphUrl(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000)
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok) return data;

      const metaCode = data?.error?.code;
      const metaSubcode = data?.error?.error_subcode;
      const message = data?.error?.message || `Meta API lỗi ${response.status}`;
      const error = new Error(
        `${message}${metaCode ? ` (code ${metaCode}${metaSubcode ? `/${metaSubcode}` : ""})` : ""}`
      );
      error.status = response.status;
      error.metaCode = metaCode;
      error.metaSubcode = metaSubcode;
      lastError = error;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) throw error;
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "TimeoutError"
        || error?.name === "AbortError"
        || Number(error?.status || 0) === 429
        || Number(error?.status || 0) >= 500;
      if (!retryable || attempt === 2) throw error;
    }

    await sleep(250 * (attempt + 1));
  }

  throw lastError || new Error("Meta API không phản hồi");
}

export async function sendTyping(recipientId, enabled = true) {
  if (getWebCapture(recipientId)) {
    return { recipient_id: recipientId, webCaptured: true, typing: Boolean(enabled) };
  }
  return graphPost("me/messages", {
    recipient: { id: recipientId },
    sender_action: enabled ? "typing_on" : "typing_off"
  });
}

function buildQuickReplies(items = []) {
  return items.slice(0, 13).map(item => ({
    content_type: "text",
    title: String(item.title || "").slice(0, 20),
    payload: String(item.payload || item.title || "").slice(0, 1000)
  }));
}

export async function sendText(recipientId, text, quickReplies = []) {
  const message = { text: String(text || "").slice(0, 2000) };
  const normalized = buildQuickReplies(quickReplies);
  if (normalized.length) message.quick_replies = normalized;

  const captured = captureWebMessage(recipientId, {
    type: "text",
    text: message.text,
    quickReplies: normalized.map(item => ({
      title: item.title,
      payload: item.payload
    }))
  });
  if (captured) return captured;

  return graphPost("me/messages", {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message
  });
}

export async function sendImage(recipientId, imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!/^https:\/\//i.test(url)) {
    throw new Error("invalid_image_url");
  }

  const captured = captureWebMessage(recipientId, {
    type: "images",
    imageUrls: [url]
  });
  if (captured) return captured;

  return graphPost("me/messages", {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: "image",
        payload: {
          url,
          is_reusable: true
        }
      }
    }
  });
}

export async function sendImages(recipientId, imageUrls = []) {
  const urls = [...new Set(
    (Array.isArray(imageUrls) ? imageUrls : [])
      .map(item => String(item || "").trim())
      .filter(url => /^https:\/\//i.test(url))
  )].slice(0, 4);

  if (!urls.length) {
    throw new Error("no_valid_image_urls");
  }

  const captured = captureWebMessage(recipientId, {
    type: "images",
    imageUrls: urls
  });
  if (captured) return captured;

  return graphPost("me/messages", {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      attachments: urls.map(url => ({
        type: "image",
        payload: {
          url,
          is_reusable: true
        }
      }))
    }
  });
}

export async function sendButtonTemplate(recipientId, text, buttons = []) {
  const safeButtons = buttons.slice(0, 3).map(button => {
    if (button.type === "postback") {
      return {
        type: "postback",
        title: String(button.title).slice(0, 20),
        payload: String(button.payload).slice(0, 1000)
      };
    }
    return {
      type: "web_url",
      title: String(button.title).slice(0, 20),
      url: String(button.url),
      webview_height_ratio: "full"
    };
  });

  const captured = captureWebMessage(recipientId, {
    type: "template",
    text: String(text).slice(0, 640),
    buttons: safeButtons.map(button => ({
      type: button.type,
      title: button.title,
      ...(button.type === "postback"
        ? { payload: button.payload }
        : { url: button.url })
    }))
  });
  if (captured) return captured;

  return graphPost("me/messages", {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: String(text).slice(0, 640),
          buttons: safeButtons
        }
      }
    }
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import { config, requireEnv } from "./config.js";

const deliveryContext = new AsyncLocalStorage();

function graphUrl(path) {
  const token = encodeURIComponent(requireEnv("META_PAGE_ACCESS_TOKEN"));
  return `https://graph.facebook.com/${config.graphVersion}/${path}?access_token=${token}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function currentWebDelivery() {
  const store = deliveryContext.getStore();
  return store?.channel === "website" ? store : null;
}

function createWebMessageId(store) {
  store.sequence = Number(store.sequence || 0) + 1;
  return `web_mid_${Date.now()}_${store.sequence}`;
}

function captureWebMessage(message) {
  const store = currentWebDelivery();
  if (!store) return null;

  const item = {
    id: createWebMessageId(store),
    createdAt: Date.now(),
    ...message
  };
  store.messages.push(item);
  return { message_id: item.id, recipient_id: store.recipientId || "" };
}

/**
 * Chạy logic hội thoại hiện có nhưng chuyển đầu ra sang website thay vì Meta.
 * Nhờ vậy Facebook Messenger và web widget dùng chung toàn bộ bộ não chatbot.
 */
export async function captureWebsiteDelivery(recipientId, handler) {
  const store = {
    channel: "website",
    recipientId: String(recipientId || ""),
    sequence: 0,
    messages: [],
    typing: false
  };

  const result = await deliveryContext.run(store, handler);
  return {
    result,
    messages: store.messages,
    typing: store.typing
  };
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
  const web = currentWebDelivery();
  if (web) {
    web.typing = Boolean(enabled);
    return { recipient_id: recipientId, typing: Boolean(enabled) };
  }

  return graphPost("me/messages", {
    recipient: { id: recipientId },
    sender_action: enabled ? "typing_on" : "typing_off"
  });
}

function normalizeQuickReplies(items = []) {
  return items.slice(0, 13).map(item => ({
    title: String(item.title || "").slice(0, 40),
    payload: String(item.payload || item.title || "").slice(0, 1000)
  }));
}

function buildQuickReplies(items = []) {
  return normalizeQuickReplies(items).map(item => ({
    content_type: "text",
    title: item.title.slice(0, 20),
    payload: item.payload
  }));
}

export async function sendText(recipientId, text, quickReplies = []) {
  const safeText = String(text || "").slice(0, 4000);
  const webResult = captureWebMessage({
    type: "text",
    text: safeText,
    quickReplies: normalizeQuickReplies(quickReplies)
  });
  if (webResult) return webResult;

  const message = { text: safeText.slice(0, 2000) };
  const normalized = buildQuickReplies(quickReplies);
  if (normalized.length) message.quick_replies = normalized;

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

  const webResult = captureWebMessage({ type: "images", imageUrls: [url] });
  if (webResult) return webResult;

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

  const webResult = captureWebMessage({ type: "images", imageUrls: urls });
  if (webResult) return webResult;

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
        title: String(button.title).slice(0, 40),
        payload: String(button.payload).slice(0, 1000)
      };
    }
    return {
      type: "web_url",
      title: String(button.title).slice(0, 40),
      url: String(button.url)
    };
  });

  const webResult = captureWebMessage({
    type: "button_template",
    text: String(text || "").slice(0, 2000),
    buttons: safeButtons
  });
  if (webResult) return webResult;

  const messengerButtons = safeButtons.map(button => {
    if (button.type === "postback") {
      return { ...button, title: button.title.slice(0, 20) };
    }
    return {
      ...button,
      title: button.title.slice(0, 20),
      webview_height_ratio: "full"
    };
  });

  return graphPost("me/messages", {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: String(text).slice(0, 640),
          buttons: messengerButtons
        }
      }
    }
  });
}

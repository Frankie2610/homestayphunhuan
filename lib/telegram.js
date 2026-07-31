import { config } from "./config.js";

let telegramEndpoint = "";

function endpoint() {
  if (!telegramEndpoint) {
    telegramEndpoint = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  }
  return telegramEndpoint;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function sendTelegramMessage({
  text,
  chatId = config.telegramChatId,
  disableWebPagePreview = true
} = {}) {
  if (!config.telegramBotToken || !chatId) {
    return { sent: false, reason: "telegram_not_configured" };
  }

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text || "").slice(0, 4096),
          disable_web_page_preview: disableWebPagePreview
        }),
        signal: AbortSignal.timeout(6_000)
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok !== false) {
        return { sent: true, messageId: data?.result?.message_id || null };
      }

      const error = new Error(data?.description || `Telegram API lỗi ${response.status}`);
      error.status = response.status;
      lastError = error;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 1) throw error;
    } catch (error) {
      lastError = error;
      const retryable = error?.name === "TimeoutError"
        || error?.name === "AbortError"
        || Number(error?.status || 0) === 429
        || Number(error?.status || 0) >= 500;
      if (!retryable || attempt === 1) throw error;
    }
    await sleep(160 * (attempt + 1));
  }

  throw lastError || new Error("Telegram API không phản hồi");
}

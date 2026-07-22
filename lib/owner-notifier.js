import { config } from "./config.js";
import { nowLocal, minuteToLabel } from "./date-time.js";
import {
  claimOwnerAlertNotification,
  createOwnerAlert,
  logBotError
} from "./conversation-store.js";

function localMinute(now = nowLocal()) {
  return now.hour * 60 + now.minute;
}

export function isAfterHours(now = nowLocal()) {
  const minute = localMinute(now);
  const start = Number(config.afterHoursStartMinute);
  const end = Number(config.afterHoursEndMinute);

  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function afterHoursResumeLabel() {
  return minuteToLabel(config.afterHoursEndMinute);
}

function trimText(value, max = 600) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}


const messengerProfileCache = new Map();

async function getMessengerProfileName(psid, context = {}) {
  if (String(psid || "").startsWith("web_")) {
    return {
      name: "Khách Website",
      source: "website"
    };
  }

  const explicitName = trimText(
    context.customerName ||
    context.guestName ||
    context.profileName ||
    context.name ||
    "",
    120
  );

  if (explicitName) {
    return {
      name: explicitName,
      source: "context"
    };
  }

  const messengerId = String(psid || context.messengerPsid || "").trim();
  if (!messengerId) {
    return {
      name: "Khách Messenger",
      source: "fallback"
    };
  }

  const cached = messengerProfileCache.get(messengerId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const pageAccessToken =
    process.env.META_PAGE_ACCESS_TOKEN ||
    process.env.PAGE_ACCESS_TOKEN ||
    "";

  const graphVersion =
    process.env.META_GRAPH_VERSION ||
    "v25.0";

  if (pageAccessToken) {
    try {
      const url = new URL(
        `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(messengerId)}`
      );
      url.searchParams.set("fields", "first_name,last_name,name");
      url.searchParams.set("access_token", pageAccessToken);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json"
        },
        signal: AbortSignal.timeout(6_000)
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && !data?.error) {
        const fullName = trimText(
          data.name ||
          [data.first_name, data.last_name]
            .filter(Boolean)
            .join(" "),
          120
        );

        if (fullName) {
          const value = {
            name: fullName,
            source: "meta_profile"
          };

          messengerProfileCache.set(messengerId, {
            value,
            expiresAt: Date.now() + 6 * 60 * 60 * 1000
          });

          return value;
        }
      }

      console.warn("Messenger profile lookup failed", {
        psid: messengerId,
        status: response.status,
        error: data?.error?.message || "profile_not_available"
      });
    } catch (error) {
      console.warn("Messenger profile lookup error", {
        psid: messengerId,
        error: error?.message || String(error)
      });
    }
  } else {
    console.warn("META_PAGE_ACCESS_TOKEN is missing; customer name cannot be fetched");
  }

  const value = {
    name: `Khách Messenger • ${messengerId.slice(-6)}`,
    source: "fallback"
  };

  messengerProfileCache.set(messengerId, {
    value,
    expiresAt: Date.now() + 15 * 60 * 1000
  });

  return value;
}

async function sendTelegramAlert(alert, psid = "") {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return { sent: false, reason: "telegram_not_configured" };
  }

  const context = alert.context || {};
  const messengerId = String(context.messengerPsid || psid || "");
  const profile = await getMessengerProfileName(messengerId, context);
  const customerName = profile.name;

  const lines = [
    alert.priority === "high"
      ? "🚨 KHÁCH CẦN XỬ LÝ GẤP"
      : "🌙 KHÁCH NHẮN NGOÀI GIỜ",
    "",
    alert.title,
    alert.message ? `Nội dung: ${alert.message}` : "",
    "",
    `Khách: ${customerName}`,
    context.phone ? `SĐT: ${context.phone}` : "",
    context.selectedHomeName || context.selectedHomeId
      ? `HOME: ${context.selectedHomeName || context.selectedHomeId}`
      : "",
    context.dateKey ? `Ngày ở: ${context.dateKey}` : "",
    Number.isFinite(Number(context.startMinute))
      ? `Check-in: ${minuteToLabel(Number(context.startMinute))}`
      : "",
    Number.isFinite(Number(context.checkoutMinute))
      ? `Check-out: ${minuteToLabel(Number(context.checkoutMinute))}${Number(context.checkoutMinute) >= 1440 ? " hôm sau" : ""}`
      : "",
    context.durationHours ? `Gói: ${context.durationHours}H` : "",
    context.guestCount ? `Số khách: ${context.guestCount}` : "",
    `Nguồn: ${String(psid || "").startsWith("web_") ? "Website" : "Facebook Messenger"}`,
    alert.afterHours ? "Ngoài giờ: Có" : "Ngoài giờ: Không",
    messengerId ? `Messenger ID: ${messengerId}` : ""
  ].filter(Boolean);

  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: lines.join("\n"),
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(8_000)
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.description || `Telegram API lỗi ${response.status}`);
  }
  return {
    sent: true,
    messageId: data?.result?.message_id || null,
    customerName,
    customerNameSource: profile.source
  };
}

export async function notifyOwner(psid, {
  type = "message",
  priority = "normal",
  title = "Khách nhắn Messenger",
  message = "",
  context = {},
  afterHours = isAfterHours(),
  forceExternal = false
} = {}) {
  const alert = await createOwnerAlert(psid, {
    type,
    priority,
    title,
    message: trimText(message),
    context,
    afterHours
  });

  // Không gửi Telegram chỉ vì khách nhắn trong khung ngoài giờ.
  // Telegram chỉ được gửi cho sự kiện thật sự quan trọng hoặc khi caller yêu cầu rõ.
  const shouldSendExternal = forceExternal
    || priority === "high";

  if (!shouldSendExternal) {
    return { alert, external: { sent: false, reason: "not_requested" } };
  }

  // Các yêu cầu chuyển nhân viên phải báo Telegram ngay mỗi lần khách chủ động yêu cầu.
  // Không áp dụng cooldown cho handoff/human_phone, vì admin có thể vừa bật bot lại
  // rồi khách tiếp tục yêu cầu gặp nhân viên.
  const bypassCooldown = type === "human_handoff" || type === "human_phone";

  if (!bypassCooldown) {
    const claimed = await claimOwnerAlertNotification(
      psid,
      type,
      config.ownerAlertCooldownMs
    );
    if (!claimed) {
      console.info("Owner notification skipped by cooldown", { psid, type });
      return { alert, external: { sent: false, reason: "cooldown" } };
    }
  }

  try {
    const external = await sendTelegramAlert(alert, psid);
    console.info("Owner notification sent", { psid, type });
    return { alert, external };
  } catch (error) {
    console.error("Owner notification send failed", {
      psid,
      type,
      error: error?.message || String(error)
    });
    await logBotError(psid, {
      stage: "owner_notification",
      error: trimText(error?.message || error || "owner_notification_failed", 500)
    }).catch(() => {});
    return {
      alert,
      external: { sent: false, reason: "send_failed", error: error?.message || String(error) }
    };
  }
}

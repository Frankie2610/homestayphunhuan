import { getAdminDatabase } from "./firebase-admin.js";
import { config } from "./config.js";
import { verifyBookingOwner } from "./cccd-storage.js";
import { sendTelegramMessage } from "./telegram.js";
import { calculateGuestPricing as calculatePricing, clampGuestCount, MAX_BOOKING_GUESTS } from "./guest-pricing.js";

function text(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function money(value) {
  return `${Math.max(0, Number(value || 0)).toLocaleString("vi-VN")}đ`;
}

export function calculateGuestPricing({ guestCount, basePrice } = {}) {
  return calculatePricing({
    guestCount,
    basePrice,
    standardGuests: config.standardGuests,
    extraGuestFeePerPerson: config.extraGuestFee
  });
}

function bookingDateTimeLabel(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return text(value, 80);
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: config.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

async function sendWebsiteGuestTelegram(booking = {}, pricing = {}, customerName = "") {
  if (!config.websiteGuestAlertEnabled || !config.telegramBotToken || !config.telegramChatId) {
    return { sent: false, reason: "telegram_not_configured" };
  }

  const lines = [
    "👥 CẬP NHẬT SỐ KHÁCH WEBSITE",
    "",
    customerName || booking.customer || booking.customerName
      ? `Khách: ${customerName || booking.customer || booking.customerName}`
      : "",
    booking.phone || booking.customerPhone ? `SĐT: ${booking.phone || booking.customerPhone}` : "",
    booking.roomName || booking.room || booking.roomCode
      ? `HOME: ${booking.roomName || booking.room || booking.roomCode}`
      : "",
    booking.checkin ? `Check-in: ${bookingDateTimeLabel(booking.checkin)}` : "",
    booking.checkout ? `Check-out: ${bookingDateTimeLabel(booking.checkout)}` : "",
    `Số người: ${pricing.guestCount}`,
    pricing.extraGuestFee > 0
      ? `Phụ thu người thêm: ${money(pricing.extraGuestFee)}`
      : "Phụ thu người thêm: Không",
    `Tổng tiền: ${money(pricing.actualPrice)}`,
    booking.orderCode || booking.paymentOrderCode
      ? `Mã booking: ${booking.orderCode || booking.paymentOrderCode}`
      : "",
    "Nguồn: Website"
  ].filter(Boolean);

  const telegram = await sendTelegramMessage({ text: lines.join("\n") });
  return { sent: true, messageId: telegram.messageId || null };
}

export async function updateBookingGuestDetails({
  bookingPath,
  orderCode,
  phoneLast4,
  guestCount,
  basePrice,
  actualPrice,
  customerName = ""
} = {}) {
  const verified = await verifyBookingOwner({ bookingPath, orderCode, phoneLast4 });
  const booking = verified.booking || {};
  const suppliedBase = Math.max(0, Math.round(Number(basePrice || 0)));
  const suppliedActual = Math.max(0, Math.round(Number(actualPrice || 0)));
  const storedExplicitBase = Math.max(0, Math.round(Number(
    booking.basePrice || booking.packagePrice || booking.comboPrice || 0
  )));
  const storedActual = Math.max(0, Math.round(Number(
    booking.actualPrice || booking.paymentAmount || booking.amount || booking.totalAmount || 0
  )));

  let pricing = calculateGuestPricing({
    guestCount,
    basePrice: storedExplicitBase || suppliedBase
  });

  // Không cho request phía khách tự ý hạ giá booking. Tổng tiền phải khớp số đã
  // được worker tạo booking ghi nhận; `price` không được tin là giá gốc vì một
  // số phiên bản worker dùng field này cho tổng thanh toán.
  if (storedActual && pricing.actualPrice !== storedActual && suppliedBase) {
    const suppliedPricing = calculateGuestPricing({ guestCount, basePrice: suppliedBase });
    if (suppliedPricing.actualPrice === storedActual) pricing = suppliedPricing;
  }
  if (storedActual && pricing.actualPrice !== storedActual) {
    const error = new Error("guest_pricing_mismatch");
    error.status = 400;
    throw error;
  }
  if (suppliedActual && suppliedActual !== pricing.actualPrice) {
    const error = new Error("guest_pricing_mismatch");
    error.status = 400;
    throw error;
  }

  const ref = getAdminDatabase().ref(verified.bookingPath);
  const now = Date.now();
  let shouldNotify = false;
  await ref.transaction(current => {
    if (!current || typeof current !== "object") return current;
    shouldNotify = !current.guestDetailsTelegramNotifiedAt
      && current.guestDetailsTelegramNotificationState !== "pending";
    return {
      ...current,
      ...pricing,
      guestPricingVersion: "2026-07-31",
      guestDetailsUpdatedAt: now,
      ...(shouldNotify ? { guestDetailsTelegramNotificationState: "pending" } : {})
    };
  });

  let telegram = { sent: false, reason: "already_notified" };
  if (shouldNotify) {
    try {
      telegram = await sendWebsiteGuestTelegram(verified.booking, pricing, text(customerName, 120));
      if (telegram.sent) {
        await ref.update({
          guestDetailsTelegramNotifiedAt: Date.now(),
          guestDetailsTelegramMessageId: telegram.messageId || null,
          guestDetailsTelegramNotificationState: "sent"
        });
      }
    } catch (error) {
      console.warn("Website guest Telegram alert failed", error?.message || error);
      telegram = { sent: false, reason: "telegram_failed" };
      await ref.update({
        guestDetailsTelegramNotificationState: "failed",
        guestDetailsTelegramLastErrorAt: Date.now()
      }).catch(() => {});
    }
  }

  return {
    bookingPath: verified.bookingPath,
    ...pricing,
    telegram
  };
}

export const __bookingGuestDetailsTest = {
  MAX_GUESTS: MAX_BOOKING_GUESTS,
  clampGuestCount
};

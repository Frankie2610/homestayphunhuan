import { config } from "./config.js";
import {
  formatDateVi,
  localDateTime,
  minuteToLabel,
  normalizeVietnamese,
  nowLocal,
  parseDateFromText,
  parseDurationFromText,
  parsePhone,
  parseStayWindowFromText,
  parseTimeFromText,
  SUPPORTED_DURATIONS
} from "./date-time.js";
import {
  checkLiveAvailability,
  extractAmenities,
  listPublicHomes,
  resolveHomeByPayload,
  suggestAvailableSlots
} from "./availability.js";
import {
  allComboRanges,
  comboPriceRange,
  extraGuestCharge,
  findPricingHome,
  formatMoneyVi,
  lateCheckoutRange,
  loadPricingCatalog
} from "./pricing.js";
import {
  getConversation,
  logMessage,
  saveConversation,
  saveLead
} from "./conversation-store.js";
import { sendButtonTemplate, sendImages, sendText, sendTyping } from "./messenger.js";
import { rememberBotOutboundMessage, setConversationControl } from "./conversation-control.js";
import { afterHoursResumeLabel, isAfterHours, notifyOwner } from "./owner-notifier.js";
import {
  answerScopedQuestionWithGemini,
  rewriteReplyWithGemini,
  runWithGeminiMessageContext
} from "./gemini.js";

const DATE_REPLIES = [
  { title: "Hôm nay", payload: "DATE|TODAY" },
  { title: "Ngày mai", payload: "DATE|TOMORROW" },
  { title: "Ngày mốt", payload: "DATE|DAY_AFTER" }
];

const DURATION_REPLIES = SUPPORTED_DURATIONS.map(hours => ({
  title: [12, 14, 22].includes(hours) ? `Qua đêm ${hours}H` : `${hours} giờ`,
  payload: `DURATION|${hours}`
}));

const TIME_REPLIES = [
  { title: "09:00", payload: "TIME|540" },
  { title: "13:00", payload: "TIME|780" },
  { title: "18:00", payload: "TIME|1080" },
  { title: "20:30", payload: "TIME|1230" }
];

const HELP_REPLIES = [
  { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
  { title: "Giá & combo", payload: "FAQ|PRICE" },
  { title: "Xem hình phòng", payload: "OPEN|GALLERY" },
  { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
];

function chooseCopy(items) {
  return items[Math.floor(Math.random() * items.length)] || items[0] || "";
}

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanContext(context = {}) {
  return {
    dateKey: context.dateKey || null,
    startMinute: toOptionalNumber(context.startMinute),
    checkoutMinute: toOptionalNumber(context.checkoutMinute),
    durationHours: toOptionalNumber(context.durationHours),
    unsupportedDurationHours: toOptionalNumber(context.unsupportedDurationHours),
    timeConflict: context.timeConflict || null,
    timeAmbiguity: context.timeAmbiguity || null,
    amenities: Array.isArray(context.amenities) ? context.amenities : [],
    preferredHomeId: context.preferredHomeId || "",
    selectedHome: context.selectedHome || null,
    lastResults: Array.isArray(context.lastResults) ? context.lastResults : [],
    phone: context.phone || "",
    guestCount: toOptionalNumber(context.guestCount),
    lastAvailabilityMeta: context.lastAvailabilityMeta || null
  };
}

function detectHumanRequest(text) {
  const s = normalizeVietnamese(text);
  return /\b(nhan vien|nguoi that|tu van vien|gap admin|gap nguoi|goi minh|lien he minh|can ho tro)\b/.test(s);
}

function isExplicitHumanAction(text = "", payload = "") {
  if (detectHumanRequest(text)) return true;
  if (payload !== "HUMAN|REQUEST") return false;

  const normalizedText = normalizeVietnamese(text).trim();

  // Postback button thường không có text nên payload được tin cậy.
  if (!normalizedText) return true;

  // Quick reply phải có nội dung đúng với hành động gặp nhân viên.
  // Tránh trường hợp Messenger gửi kèm payload cũ HUMAN|REQUEST
  // cho các lựa chọn combo như "7 giờ".
  return /^(gap nhan vien|nhan vien|gap admin|can ho tro|tu van vien)$/.test(normalizedText);
}

function detectReset(text) {
  const s = normalizeVietnamese(text);
  return /\b(lam lai|dat lai|chon lai|bat dau lai|reset|tim lai tu dau)\b/.test(s);
}

function detectResumeBot(text) {
  const s = normalizeVietnamese(text);
  return /\b(quay lai bot|bot tu van|bot kiem tra|tiep tuc voi bot|kiem tra tiep|tu dong kiem tra)\b/.test(s);
}

function detectThanks(text) {
  const s = normalizeVietnamese(text);
  return /^(cam on|thanks|thank you|ok|oke|okay|duoc|uh|uhm|vang|roi|tot|hay qua|ok nha)[!. ]*$/.test(s);
}

function detectGoodbye(text) {
  const s = normalizeVietnamese(text);
  return /\b(tam biet|bye|hen gap lai|khong can nua|thoi nha)\b/.test(s);
}

function detectMoreOptions(text) {
  const s = normalizeVietnamese(text);
  return /\b(con (?:phong|home|cai) khac|phong khac|home khac|cai khac|khac nua|them lua chon|con lua chon nao)\b/.test(s);
}

function detectHoldRequest(text) {
  const s = normalizeVietnamese(text);
  return /\b(giu phong|giu cho|dat phong|chot phong|chot home|lay phong nay|lay home nay)\b/.test(s);
}

function detectUrgentRequest(text) {
  const s = normalizeVietnamese(text);
  return /\b(gap|khan|ngay bay gio|bay gio|dat ngay|dat lien|book ngay|book lien|chot ngay|chot lien|giu ngay|giu phong ngay|can phong ngay|vao ngay|vao lien|toi nay vao luon|muon dat ngay|muon chot|chuyen khoan ngay|coc ngay|xac nhan ngay)\b/.test(s);
}

function detectBookingIntent(text) {
  const s = normalizeVietnamese(text);
  return /\b(dat phong|book phong|giu phong|giu cho|chot phong|chot home|lay phong|lay home|muon dat|muon chot|coc phong|chuyen khoan|xac nhan booking)\b/.test(s);
}

function detectCheckoutQuestion(text) {
  const s = normalizeVietnamese(text);
  return /\b(check\s*out|checkout|tra phong|gio ra|ra luc|may gio tra|tra luc nao|ket thuc luc nao)\b/.test(s);
}

function detectCheckinQuestion(text) {
  const s = normalizeVietnamese(text);
  return /\b(check\s*in|checkin|nhan phong|gio vao|vao luc|may gio vao|bat dau luc nao)\b/.test(s);
}

function parseResultChoice(text) {
  const s = normalizeVietnamese(text);
  if (/\b(dau tien|cai dau|phong dau|so mot)\b/.test(s)) return 0;
  const match = s.match(/\b(?:phong thu|cai|lua chon|so)\s*(\d{1,2})\b/);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function detectGalleryRequest(text) {
  const s = normalizeVietnamese(text);
  return /\b(xem phong|xem hinh|xem anh|gui hinh|gui anh|hinh anh|thu vien|anh phong|hinh phong|anh home|hinh home|co hinh|co anh)\b/.test(s);
}

function detectCalendarLinkRequest(text) {
  const s = normalizeVietnamese(text);
  return /\b(mo lich|xem lich(?: trong)?|gui lich)\b/.test(s);
}

function detectAvailabilityRequest(text) {
  const s = normalizeVietnamese(text);
  return /\b(con phong|phong con trong|phong trong|con lich|lich con|trong khong|kiem tra (?:lich|phong)|check lich|lich trong(?: ngay| luc| khung)?|co phong khong|co home nao|co phong nao|tim phong|con home|dat duoc khong|book duoc khong|khung nay con khong)\b/.test(s);
}

function detectGreeting(text) {
  const s = normalizeVietnamese(text);
  return /^(hi|hello|alo|chao|xin chao|ad oi|shop oi|home oi|cho minh hoi)[!. ]*$/.test(s)
    || /\b(chao ban|xin chao|alo ad)\b/.test(s);
}

function parseHomeReference(text) {
  const s = normalizeVietnamese(text);
  const match = s.match(/\bhome\s*[- ]?(\d{1,2})\b/);
  return match ? `HOME${Number(match[1])}` : "";
}

function parseGuestCount(text) {
  const s = normalizeVietnamese(text);
  const match = s.match(/\b(\d{1,2})\s*(?:nguoi|khach)\b/)
    || s.match(/\b(?:di|o|cho)\s*(\d{1,2})\s*(?:nguoi|khach)?\b/);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isInteger(count) && count > 0 && count <= 20 ? count : null;
}

function isOvernightDuration(hours) {
  return [12, 14, 22].includes(Number(hours));
}

function buildCalendarUrl(context = {}) {
  const params = new URLSearchParams({ src: "facebook", medium: "messenger", campaign: "chatbot" });
  if (context.dateKey) params.set("date", context.dateKey);
  if (context.preferredHomeId) params.set("room", context.preferredHomeId);
  if (Number.isFinite(context.startMinute)) params.set("start", minuteToLabel(context.startMinute));
  if (Number.isFinite(context.checkoutMinute)) params.set("checkout", minuteToLabel(context.checkoutMinute));
  if (context.durationHours) params.set("duration", String(context.durationHours));
  return `${config.siteUrl}/lich-trong?${params.toString()}`;
}

function buildRoomUrl(home, context = {}) {
  const params = new URLSearchParams({ src: "facebook", medium: "messenger", campaign: "chatbot" });
  if (context.dateKey) params.set("date", context.dateKey);
  if (Number.isFinite(context.startMinute)) params.set("start", minuteToLabel(context.startMinute));
  if (Number.isFinite(context.checkoutMinute)) params.set("checkout", minuteToLabel(context.checkoutMinute));
  if (context.durationHours) params.set("duration", String(context.durationHours));
  return `${config.siteUrl}/${encodeURIComponent(home.routeName)}?${params.toString()}`;
}

function mergeParsedContext(text, previousContext = {}, state = "") {
  const context = cleanContext(previousContext);
  const dateKey = parseDateFromText(text);
  const stay = parseStayWindowFromText(text, { state });
  const phone = parsePhone(text);
  const amenities = extractAmenities(text);
  const homeReference = parseHomeReference(text);
  const guestCount = parseGuestCount(text);

  if (dateKey) context.dateKey = dateKey;
  if (stay.checkInMinute != null) context.startMinute = stay.checkInMinute;
  if (stay.checkOutMinute != null) context.checkoutMinute = stay.checkOutMinute;
  if (stay.durationHours != null) context.durationHours = stay.durationHours;

  if (stay.conflict) {
    context.timeConflict = stay.conflict;
  } else if (stay.checkInMinute != null || stay.checkOutMinute != null || stay.durationHours != null) {
    context.timeConflict = null;
  }

  if (stay.unsupportedDurationHours != null) {
    context.unsupportedDurationHours = stay.unsupportedDurationHours;
  } else if (stay.durationHours != null) {
    context.unsupportedDurationHours = null;
  }

  if (stay.ambiguousBareHour != null) {
    context.timeAmbiguity = { value: stay.ambiguousBareHour };
  } else if (stay.checkInMinute != null || stay.durationHours != null) {
    context.timeAmbiguity = null;
  }

  // Keep all three values mathematically consistent after the newest message.
  if (context.startMinute != null && context.durationHours != null && !context.timeConflict) {
    context.checkoutMinute = context.startMinute + context.durationHours * 60;
  } else if (context.checkoutMinute != null && context.durationHours != null && context.startMinute == null) {
    let startMinute = context.checkoutMinute - context.durationHours * 60;
    while (startMinute < 0) startMinute += 1440;
    context.startMinute = startMinute;
    if (context.checkoutMinute <= startMinute) context.checkoutMinute += 1440;
  }

  if (phone) context.phone = phone;
  if (guestCount) context.guestCount = guestCount;
  if (homeReference) context.preferredHomeId = homeReference;
  if (amenities.length) context.amenities = [...new Set([...(context.amenities || []), ...amenities])];
  return context;
}

function freshSearchContext(text) {
  return mergeParsedContext(text, cleanContext({}), "new");
}

function applyPayload(payload, context) {
  const parts = String(payload || "").split("|");
  const action = parts[0];
  const value = parts.slice(1).join("|");
  const now = nowLocal();

  if (action === "DATE") {
    if (value === "TODAY") context.dateKey = now.toISODate();
    if (value === "TOMORROW") context.dateKey = now.plus({ days: 1 }).toISODate();
    if (value === "DAY_AFTER") context.dateKey = now.plus({ days: 2 }).toISODate();
  }
  if (action === "DURATION") {
    context.durationHours = Number(value);
    context.unsupportedDurationHours = null;
    context.timeConflict = null;
    context.timeAmbiguity = null;
    if (context.startMinute != null) {
      context.checkoutMinute = context.startMinute + context.durationHours * 60;
    } else if (context.checkoutMinute != null) {
      let startMinute = context.checkoutMinute - context.durationHours * 60;
      while (startMinute < 0) startMinute += 1440;
      context.startMinute = startMinute;
      if (context.checkoutMinute <= startMinute) context.checkoutMinute += 1440;
    }
  }
  if (action === "TIME") {
    context.startMinute = Number(value);
    context.timeAmbiguity = null;
    context.timeConflict = null;
    if (context.durationHours) context.checkoutMinute = context.startMinute + context.durationHours * 60;
  }
  if (action === "HOME") context.preferredHomeId = value;
  return { action, value, context };
}

async function replyAndLog(psid, text, quickReplies = []) {
  const originalText = String(text || "");
  const finalText = await rewriteReplyWithGemini({
    originalReply: originalText,
    quickReplies,
    maxCharacters: 2000
  });

  const result = await sendText(psid, finalText, quickReplies);
  await rememberBotOutboundMessage(psid, result?.message_id, "text").catch(() => {});
  await logMessage(psid, "out", {
    senderType: "bot",
    text: finalText,
    originalText: finalText === originalText ? "" : originalText,
    aiRewritten: finalText !== originalText,
    aiProvider: finalText !== originalText ? "gemini" : "",
    quickReplies,
    metaMessageId: result?.message_id || ""
  });
}

async function sendTemplateAndLog(psid, text, buttons, type = "template") {
  const result = await sendButtonTemplate(psid, text, buttons);
  await rememberBotOutboundMessage(psid, result?.message_id, type).catch(() => {});
  await logMessage(psid, "out", {
    senderType: "bot",
    type,
    text,
    buttons,
    metaMessageId: result?.message_id || ""
  });
}

async function sendImagesAndLog(psid, imageUrls, home = {}) {
  const result = await sendImages(psid, imageUrls);

  await rememberBotOutboundMessage(
    psid,
    result?.message_id,
    "image_gallery"
  ).catch(() => {});

  await logMessage(psid, "out", {
    senderType: "bot",
    type: "image_gallery",
    homeId: home.homeId || "",
    homeName: home.displayName || "",
    imageUrls,
    imageCount: imageUrls.length,
    metaMessageId: result?.message_id || ""
  });

  return result;
}

function galleryHomeReplies(homes = []) {
  return homes.slice(0, 10).map(home => ({
    title: String(home.displayName || home.routeName || "HOME").slice(0, 20),
    payload: `GALLERY_HOME|${home.homeId}`
  }));
}

async function askHomeForGallery(psid, context = {}) {
  const homes = await listPublicHomes();
  const replies = galleryHomeReplies(homes);

  if (!replies.length) {
    await sendTemplateAndLog(psid, "HOME chưa đọc được danh sách phòng. Bạn có thể mở thư viện ảnh tại đây.", [
      { type: "web_url", title: "Mở thư viện", url: `${config.siteUrl}/hinh-anh?src=facebook` },
      { type: "web_url", title: "Xem lịch trống", url: buildCalendarUrl(context) }
    ], "gallery");
    return;
  }

  await replyAndLog(
    psid,
    "Bạn muốn xem hình HOME nào? HOME sẽ gửi một số ảnh trực tiếp để Bạn tham khảo.",
    replies
  );
}

async function sendHomeGallery(psid, homeReference, context = {}) {
  const home = await resolveHomeByPayload(homeReference);
  if (!home) {
    await replyAndLog(psid, "HOME chưa nhận ra phòng Bạn muốn xem. Bạn chọn lại giúp HOME nhé.");
    await askHomeForGallery(psid, context);
    return;
  }

  const coverImageUrl = String(home.coverImageUrl || "").trim();
  const images = Array.isArray(home.images)
    ? [...new Set(home.images.map(item => String(item || "").trim()).filter(Boolean))]
      .filter(imageUrl => imageUrl !== coverImageUrl)
      .slice(0, 4)
    : [];

  if (!images.length) {
    await sendTemplateAndLog(
      psid,
      `${home.displayName} hiện chưa có ảnh công khai trong dữ liệu. Bạn có thể mở trang chi tiết để kiểm tra lại.`,
      [
        { type: "web_url", title: "Xem phòng", url: buildRoomUrl(home, context) },
        { type: "web_url", title: "Xem lịch trống", url: buildCalendarUrl({ ...context, preferredHomeId: home.homeId }) }
      ],
      "gallery_empty"
    );
    return;
  }

  let sentCount = 0;
  try {
    await sendImagesAndLog(
      psid,
      images,
      home
    );
    sentCount = images.length;
  } catch (error) {
    console.error("Không gửi được bộ ảnh HOME", {
      homeId: home.homeId,
      imageUrls: images,
      error: error?.message || String(error)
    });
  }

  const nextContext = {
    ...context,
    preferredHomeId: home.homeId,
    selectedHome: home
  };
  await saveConversation(psid, { context: nextContext });

  await sendTemplateAndLog(
    psid,
    sentCount > 0
      ? `${home.displayName}: HOME đã gửi ${sentCount} ảnh để Bạn tham khảo. Bạn có thể mở trang chi tiết để xem toàn bộ hình và tiện ích.`
      : `${home.displayName} hiện chưa gửi được ảnh trực tiếp. Bạn mở trang chi tiết để xem toàn bộ hình nhé.`,
    [
      { type: "web_url", title: "Xem đầy đủ", url: buildRoomUrl(home, nextContext) },
      { type: "web_url", title: "Xem lịch trống", url: buildCalendarUrl(nextContext) }
    ],
    "home_gallery"
  );
}

function alertContext(context = {}) {
  return {
    dateKey: context.dateKey || "",
    startMinute: context.startMinute,
    checkoutMinute: context.checkoutMinute,
    durationHours: context.durationHours,
    guestCount: context.guestCount || config.standardGuests,
    selectedHomeId: context.preferredHomeId || "",
    selectedHomeName: context.selectedHome?.displayName || "",
    phone: context.phone || ""
  };
}

function checkoutDescription(context = {}) {
  if (context.checkoutMinute == null) return "";
  const nextDay = Number(context.checkoutMinute) >= 1440;
  return `${minuteToLabel(context.checkoutMinute)}${nextDay ? " hôm sau" : ""}`;
}

function supportedDurationSuggestions(hours) {
  const lower = [...SUPPORTED_DURATIONS].filter(value => value <= hours).at(-1);
  const upper = SUPPORTED_DURATIONS.find(value => value >= hours);
  const values = [lower, upper].filter(value => value != null);
  if (values.length < 2) {
    const fallback = [...SUPPORTED_DURATIONS]
      .sort((a, b) => Math.abs(a - hours) - Math.abs(b - hours) || a - b)
      .find(value => !values.includes(value));
    if (fallback != null) values.push(fallback);
  }
  return [...new Set(values)].slice(0, 2);
}

export function isUrgentBookingMessage(text = "") {
  return detectUrgentRequest(text);
}

async function maybeNotifyUrgentIntent(psid, text, existing, context) {
  if (!detectUrgentRequest(text)) return false;
  const now = Date.now();
  if (now - Number(existing?.urgentNotificationAt || 0) < 10 * 60 * 1000) return false;

  await saveConversation(psid, {
    urgentNotificationAt: now,
    urgentMessage: String(text || "").slice(0, 500),
    context
  });
  await saveLead(psid, {
    status: "urgent_booking_intent",
    priority: "high",
    urgent: true,
    urgentMessage: String(text || "").slice(0, 500),
    dateKey: context.dateKey || "",
    startMinute: context.startMinute,
    checkoutMinute: context.checkoutMinute,
    durationHours: context.durationHours,
    guestCount: context.guestCount || config.standardGuests,
    selectedHomeId: context.preferredHomeId || "",
    selectedHomeName: context.selectedHome?.displayName || "",
    phone: context.phone || "",
    afterHours: isAfterHours()
  });
  await safeNotifyOwner(psid, {
    type: "urgent_booking_intent",
    priority: "high",
    title: isAfterHours() ? "Khách muốn đặt ngay ngoài giờ" : "Khách muốn đặt ngay",
    message: text || "Khách vừa thể hiện nhu cầu đặt phòng gấp.",
    context: alertContext(context),
    afterHours: isAfterHours(),
    forceExternal: true
  });
  return true;
}

async function answerStayTimeQuestion(psid, text, context, state = "") {
  const normalized = normalizeVietnamese(text);
  const asksCalculation = detectCheckoutQuestion(text)
    || detectCheckinQuestion(text)
    || /\b(la goi may|bao nhieu tieng|tinh gio|tinh giup|tu .* den .*)\b/.test(normalized);
  if (!asksCalculation) return false;

  const parsed = parseStayWindowFromText(text, { state });
  const merged = cleanContext({ ...context });
  if (parsed.checkInMinute != null) merged.startMinute = parsed.checkInMinute;
  if (parsed.checkOutMinute != null) merged.checkoutMinute = parsed.checkOutMinute;
  if (parsed.durationHours != null) merged.durationHours = parsed.durationHours;

  if (parsed.conflict) {
    const statedEnd = parsed.checkInMinute + parsed.conflict.statedDurationHours * 60;
    await replyAndLog(
      psid,
      `Mình thấy thông tin đang lệch nhau: nhận lúc ${minuteToLabel(parsed.checkInMinute)}, trả lúc ${minuteToLabel(parsed.checkOutMinute)} là ${parsed.conflict.derivedDurationHours} giờ, nhưng bạn lại chọn gói ${parsed.conflict.statedDurationHours}H. Nếu theo gói ${parsed.conflict.statedDurationHours}H thì giờ trả sẽ là ${minuteToLabel(statedEnd)}${statedEnd >= 1440 ? " hôm sau" : ""}. Bạn muốn theo giờ trả hay theo combo?`,
      [
        { title: `Theo gói ${parsed.conflict.statedDurationHours}H`, payload: `DURATION|${parsed.conflict.statedDurationHours}` },
        ...(SUPPORTED_DURATIONS.includes(parsed.conflict.derivedDurationHours)
          ? [{ title: `Theo khung ${parsed.conflict.derivedDurationHours}H`, payload: `DURATION|${parsed.conflict.derivedDurationHours}` }]
          : [])
      ]
    );
    return true;
  }

  if (parsed.unsupportedDurationHours != null) {
    const suggestions = parsed.suggestedDurations.length
      ? parsed.suggestedDurations
      : supportedDurationSuggestions(parsed.unsupportedDurationHours);
    const options = suggestions.map(hours => {
      const end = parsed.checkInMinute != null ? parsed.checkInMinute + hours * 60 : null;
      return end == null ? `${hours}H` : `${hours}H (${minuteToLabel(parsed.checkInMinute)}–${minuteToLabel(end)})`;
    }).join(" hoặc ");
    await replyAndLog(
      psid,
      `Khung ${minuteToLabel(parsed.checkInMinute)}–${minuteToLabel(parsed.checkOutMinute)} tương đương ${parsed.unsupportedDurationHours} giờ, nhưng bên mình hiện có các combo ${SUPPORTED_DURATIONS.join("H, ")}H. Gần nhất là ${options}.`,
      suggestions.map(hours => ({ title: `Chọn gói ${hours}H`, payload: `DURATION|${hours}` }))
    );
    return true;
  }

  if (merged.startMinute != null && merged.durationHours != null) {
    const checkoutMinute = merged.startMinute + merged.durationHours * 60;
    await replyAndLog(
      psid,
      `Nếu check-in lúc ${minuteToLabel(merged.startMinute)} với gói ${merged.durationHours}H thì check-out lúc ${minuteToLabel(checkoutMinute)}${checkoutMinute >= 1440 ? " hôm sau" : ""}. Bạn muốn mình kiểm tra lịch cho khung này không?`,
      [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]
    );
    return true;
  }

  if (merged.checkoutMinute != null && merged.durationHours != null) {
    let checkInMinute = merged.checkoutMinute - merged.durationHours * 60;
    while (checkInMinute < 0) checkInMinute += 1440;
    await replyAndLog(
      psid,
      `Nếu muốn check-out lúc ${minuteToLabel(merged.checkoutMinute)} với gói ${merged.durationHours}H thì check-in lúc ${minuteToLabel(checkInMinute)}. Bạn muốn mình kiểm tra lịch cho khung này không?`,
      [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]
    );
    return true;
  }

  return false;
}

async function safeNotifyOwner(psid, payload) {
  try {
    return await notifyOwner(psid, payload);
  } catch (error) {
    console.error("Owner notification error:", error);
    return null;
  }
}

async function maybeSendAfterHoursNotice(psid, existing, state, context, text) {
  if (!isAfterHours()) return;

  const todayKey = nowLocal().toISODate();
  if (existing?.afterHoursNoticeDate === todayKey) return;

  await saveConversation(psid, {
    state,
    context,
    afterHoursNoticeDate: todayKey
  });

  await replyAndLog(
    psid,
    `Giờ này nhân viên đang nghỉ rồi 🌙 nhưng mình vẫn kiểm tra lịch thật trên hệ thống 24/7. Bạn cứ gửi ngày + giờ + số tiếng; yêu cầu cần người xác nhận sẽ được xử lý từ ${afterHoursResumeLabel()}.`
  );

  await safeNotifyOwner(psid, {
    type: "after_hours_message",
    priority: detectUrgentRequest(text) ? "high" : "normal",
    title: detectUrgentRequest(text)
      ? "Khách nhắn gấp ngoài giờ"
      : "Khách mới nhắn ngoài giờ",
    message: text || "Khách bắt đầu cuộc trò chuyện Messenger ngoài giờ.",
    context: alertContext(context),
    afterHours: true
  });
}

async function welcome(psid) {
  await replyAndLog(
    psid,
    chooseCopy([
      `Chào bạn 👋 Mình là trợ lý của ${config.brandName}. Mình có thể kiểm tra lịch trống, hỗ trợ chọn HOME, gửi hình phòng và ghi nhận yêu cầu giữ chỗ.`,
      `Xin chào 👋 Bạn cần xem lịch, hỏi giá hay tìm HOME có tiện nghi cụ thể? Mình hỗ trợ ngay nhé.`,
      `Chào bạn, mình đang trực tuyến nè 🌿 Bạn cho mình ngày, giờ và thời lượng dự kiến, mình sẽ kiểm tra lịch thật trên hệ thống.`
    ]),
    HELP_REPLIES
  );
}

async function askNextMissing(psid, context) {
  const now = nowLocal();

  if (context.timeAmbiguity?.value != null) {
    const value = Number(context.timeAmbiguity.value);
    context.timeAmbiguity = null;
    await saveConversation(psid, { state: "clarifying_time", context });
    await replyAndLog(
      psid,
      `“${value}h” có thể là gói ${value} giờ hoặc giờ nhận phòng. Bạn đang muốn nói ý nào?`,
      [
        ...(SUPPORTED_DURATIONS.includes(value)
          ? [{ title: `Gói ${value}H`, payload: `DURATION|${value}` }]
          : []),
        { title: `Nhận lúc ${String(value).padStart(2, "0")}:00`, payload: `TIME|${value * 60}` },
        ...(value >= 1 && value <= 11
          ? [{ title: `Nhận lúc ${String(value + 12).padStart(2, "0")}:00`, payload: `TIME|${(value + 12) * 60}` }]
          : [])
      ]
    );
    return true;
  }

  if (context.timeConflict) {
    const conflict = context.timeConflict;
    const statedEnd = conflict.checkInMinute + conflict.statedDurationHours * 60;
    await saveConversation(psid, { state: "clarifying_time", context });
    await replyAndLog(
      psid,
      `Mình thấy giờ và combo chưa khớp: ${minuteToLabel(conflict.checkInMinute)}–${minuteToLabel(conflict.checkOutMinute)} là ${conflict.derivedDurationHours} giờ, còn combo bạn nói là ${conflict.statedDurationHours}H. Nếu theo combo ${conflict.statedDurationHours}H thì sẽ trả lúc ${minuteToLabel(statedEnd)}${statedEnd >= 1440 ? " hôm sau" : ""}. Bạn chọn lại giúp mình nhé.`,
      [
        { title: `Theo gói ${conflict.statedDurationHours}H`, payload: `DURATION|${conflict.statedDurationHours}` },
        ...(SUPPORTED_DURATIONS.includes(conflict.derivedDurationHours)
          ? [{ title: `Theo khung ${conflict.derivedDurationHours}H`, payload: `DURATION|${conflict.derivedDurationHours}` }]
          : []),
        { title: "Đổi giờ", payload: "CHANGE|TIME" }
      ]
    );
    return true;
  }

  if (context.unsupportedDurationHours != null) {
    const hours = Number(context.unsupportedDurationHours);
    const suggestions = supportedDurationSuggestions(hours);
    context.unsupportedDurationHours = null;
    context.durationHours = null;
    await saveConversation(psid, { state: "awaiting_duration", context });
    const rangeText = context.startMinute != null && context.checkoutMinute != null
      ? `Khung ${minuteToLabel(context.startMinute)}–${minuteToLabel(context.checkoutMinute)} là ${hours} giờ. `
      : "";
    await replyAndLog(
      psid,
      `${rangeText}Bên mình hiện có các combo ${SUPPORTED_DURATIONS.join("H, ")}H. Bạn chọn combo gần nhất giúp mình nhé.`,
      suggestions.map(value => ({ title: `Gói ${value}H`, payload: `DURATION|${value}` }))
    );
    return true;
  }

  if (context.dateKey && context.dateKey < now.toISODate()) {
    context.dateKey = null;
    context.startMinute = null;
    await saveConversation(psid, { state: "awaiting_date", context });
    await replyAndLog(psid, "Ngày đó đã qua rồi. Bạn chọn lại ngày ở giúp mình nhé.", DATE_REPLIES);
    return true;
  }

  if (!context.dateKey) {
    await saveConversation(psid, { state: "awaiting_date", context });
    await replyAndLog(
      psid,
      chooseCopy([
        "Bạn muốn ở ngày nào để mình kiểm tra lịch?",
        "Mình kiểm tra được nha. Bạn dự định ở hôm nay, ngày mai hay ngày nào khác?",
        "Bạn cho mình ngày nhận phòng trước nhé."
      ]),
      DATE_REPLIES
    );
    return true;
  }

  if (!context.durationHours) {
    await saveConversation(psid, { state: "awaiting_duration", context });
    await replyAndLog(
      psid,
      chooseCopy([
        `Ngày ${formatDateVi(context.dateKey)} bạn muốn ở bao lâu?`,
        `Mình đã ghi nhận ngày ${formatDateVi(context.dateKey)}. Bạn chọn combo mấy giờ nha.`,
        `Bạn dự kiến dùng gói ${SUPPORTED_DURATIONS.join("H, ")}H vào ${formatDateVi(context.dateKey)}?`
      ]),
      DURATION_REPLIES
    );
    return true;
  }

  if (context.startMinute == null) {
    await saveConversation(psid, { state: "awaiting_time", context });
    const checkoutHint = context.checkoutMinute != null
      ? ` Bạn muốn trả lúc ${minuteToLabel(context.checkoutMinute)}, nên mình sẽ tính ngược giờ nhận phòng theo combo ${context.durationHours}H.`
      : "";
    await replyAndLog(
      psid,
      chooseCopy([
        `Bạn dự kiến nhận phòng lúc mấy giờ? Mình sẽ kiểm tra gói ${context.durationHours}H.${checkoutHint}`,
        `Còn thiếu giờ nhận phòng thôi. Bạn muốn vào khoảng mấy giờ?${checkoutHint}`,
        `Gói ${context.durationHours}H rồi nha. Bạn chọn giờ check-in để mình dò lịch chính xác.${checkoutHint}`
      ]),
      TIME_REPLIES
    );
    return true;
  }

  if (context.durationHours != null) {
    context.checkoutMinute = context.startMinute + context.durationHours * 60;
  }

  const start = localDateTime(context.dateKey, context.startMinute);
  if (start < now.minus({ minutes: 5 })) {
    context.startMinute = null;
    await saveConversation(psid, { state: "awaiting_time", context });
    await replyAndLog(
      psid,
      "Khung giờ đó đã qua rồi. Bạn chọn một giờ nhận phòng mới giúp mình nhé.",
      TIME_REPLIES
    );
    return true;
  }

  return false;
}

function availabilitySummary(context, results, availabilityMeta = null) {
  const start = minuteToLabel(context.startMinute);
  const checkout = checkoutDescription(context) || results[0]?.endLabel || "";
  const checkedAt = availabilityMeta?.readAt
    ? nowLocal().set({ millisecond: 0 }).toFormat("HH:mm")
    : nowLocal().toFormat("HH:mm");
  const rows = results.slice(0, 6).map((item, index) => `${index + 1}. ${item.displayName}`).join("\n");
  const headers = [
    `Mình vừa kiểm tra lịch thật ngày ${formatDateVi(context.dateKey)}: check-in ${start}, check-out ${checkout}, combo ${context.durationHours}H.`,
    `Có phòng phù hợp rồi nha 🌿 Check-in ${start}, check-out ${checkout} ngày ${formatDateVi(context.dateKey)} đang còn:`,
    `Lịch hiện tại cho combo ${context.durationHours}H, nhận ${start} và trả ${checkout} ngày ${formatDateVi(context.dateKey)} như sau:`
  ];
  const overnightNote = config.overnightIdRequired && isOvernightDuration(context.durationHours)
    ? "\n\nLưu ý: gói qua đêm cần gửi CCCD để xác nhận thông tin nhận phòng."
    : "";
  return `${chooseCopy(headers)}\n\n${rows}\n\nCập nhật trực tiếp từ lịch hệ thống lúc ${checkedAt}. Bạn chọn HOME nào để mình gửi hình và lịch chi tiết?${overnightNote}`;
}

async function showAvailability(psid, context) {
  const liveCheck = await checkLiveAvailability({ ...context, forceRefresh: true });
  let results = liveCheck.results;
  let availabilityMeta = liveCheck.meta;
  let relaxedPreferredHome = false;

  // A selected HOME must not silently hide all other free rooms in a later search.
  if (!results.length && context.preferredHomeId) {
    const relaxedCheck = await checkLiveAvailability({
      ...context,
      preferredHomeId: "",
      forceRefresh: true
    });
    results = relaxedCheck.results;
    availabilityMeta = relaxedCheck.meta;
    relaxedPreferredHome = results.length > 0;
  }

  if (!results.length) {
    let alternatives = await suggestAvailableSlots({
      dateKey: context.dateKey,
      durationHours: context.durationHours,
      amenities: context.amenities,
      preferredHomeId: context.preferredHomeId,
      requestedStartMinute: context.startMinute,
      limit: 6
    });

    let relaxedAlternativeHome = false;
    if (!alternatives.length && context.preferredHomeId) {
      alternatives = await suggestAvailableSlots({
        dateKey: context.dateKey,
        durationHours: context.durationHours,
        amenities: context.amenities,
        preferredHomeId: "",
        requestedStartMinute: context.startMinute,
        limit: 6
      });
      relaxedAlternativeHome = alternatives.length > 0;
    }

    const nextContext = {
      ...context,
      preferredHomeId: relaxedAlternativeHome ? "" : context.preferredHomeId,
      selectedHome: relaxedAlternativeHome ? null : context.selectedHome,
      lastResults: alternatives,
      lastAvailabilityMeta: availabilityMeta
    };
    await saveConversation(psid, { state: "awaiting_alternative", context: nextContext });

    if (!alternatives.length) {
      const constraintNote = context.amenities.length
        ? " theo tiện nghi bạn yêu cầu"
        : "";
      await replyAndLog(
        psid,
        `${chooseCopy([
          `Khung ${minuteToLabel(context.startMinute)} ngày ${formatDateVi(context.dateKey)} hiện chưa có phòng phù hợp${constraintNote}. Bạn thử đổi giờ, ngày hoặc thời lượng giúp mình nhé.`,
          `Mình đã kiểm tra toàn bộ HOME nhưng chưa ghép được gói ${context.durationHours}H từ ${minuteToLabel(context.startMinute)} ngày ${formatDateVi(context.dateKey)}${constraintNote}.`,
          `Khung này đang bị vướng lịch hoặc thời gian dọn phòng nên chưa thể nhận thêm khách${constraintNote}. Mình thử phương án khác cho bạn nha.`
        ])}\n\nLịch vừa được đọc trực tiếp từ Firebase lúc ${nowLocal().toFormat("HH:mm")}.`,
        [
          { title: "Đổi giờ", payload: "CHANGE|TIME" },
          { title: "Đổi ngày", payload: "CHANGE|DATE" },
          { title: "Đổi thời lượng", payload: "CHANGE|DURATION" },
          ...(context.amenities.length ? [{ title: "Bỏ lọc tiện nghi", payload: "FILTER|CLEAR" }] : []),
          { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
        ]
      );
      return;
    }

    const lines = alternatives
      .map(item => `• ${item.displayName}: ${item.startLabel}–${item.endLabel}`)
      .join("\n");
    const replies = alternatives.slice(0, 6).map(item => ({
      title: `${item.startLabel} ${item.displayName}`.slice(0, 20),
      payload: `ALT|${item.homeId}|${item.startMinute}`
    }));
    replies.push({ title: "Đổi ngày", payload: "CHANGE|DATE" });

    const prefix = relaxedAlternativeHome
      ? "HOME bạn chọn chưa phù hợp, nhưng cùng ngày mình tìm được các HOME khác gần giờ bạn muốn:"
      : chooseCopy([
        "Khung chính xác đó chưa ghép được, nhưng cùng ngày mình còn các lựa chọn gần nhất:",
        "Mình tìm thêm quanh giờ bạn chọn và thấy các phương án này:",
        "Khung đó chưa trống, còn các lựa chọn gần nhất như sau:"
      ]);

    await replyAndLog(psid, `${prefix}\n\n${lines}`, replies);
    return;
  }

  const effectiveContext = relaxedPreferredHome
    ? { ...context, preferredHomeId: "", selectedHome: null }
    : context;
  const nextContext = {
    ...effectiveContext,
    lastResults: results.map(item => ({
      homeId: item.homeId,
      routeName: item.routeName,
      displayName: item.displayName,
      startMinute: item.startMinute,
      endLabel: item.endLabel
    })),
    lastAvailabilityMeta: availabilityMeta
  };

  await saveConversation(psid, { state: "awaiting_home", context: nextContext });
  await saveLead(psid, {
    status: "checking_availability",
    dateKey: context.dateKey,
    startMinute: context.startMinute,
    checkoutMinute: context.checkoutMinute,
    durationHours: context.durationHours,
    guestCount: context.guestCount || config.standardGuests,
    amenities: context.amenities,
    availableHomeIds: results.map(item => item.homeId),
    availabilitySource: availabilityMeta?.source || "firebase_realtime_database",
    availabilityCheckedAt: availabilityMeta?.readAt || Date.now(),
    availabilityBookingPaths: availabilityMeta?.bookingPaths || []
  });

  const replies = results.slice(0, 6).map(item => ({
    title: item.displayName.slice(0, 20),
    payload: `HOME|${item.homeId}`
  }));
  replies.push({ title: "Đổi giờ", payload: "CHANGE|TIME" });

  const message = relaxedPreferredHome
    ? `HOME bạn chọn chưa trống, nhưng mình đã kiểm tra các HOME còn lại.\n\n${availabilitySummary(nextContext, results, availabilityMeta)}`
    : availabilitySummary(nextContext, results, availabilityMeta);
  await replyAndLog(psid, message, replies);
}

async function showSelectedHome(psid, context, homeId) {
  const home = await resolveHomeByPayload(homeId);
  if (!home) {
    await replyAndLog(psid, "Mình chưa nhận ra HOME đó. Bạn chọn lại giúp mình nhé.");
    return;
  }

  const nextContext = { ...context, preferredHomeId: homeId, selectedHome: home };
  await saveConversation(psid, { state: "home_selected", context: nextContext });
  await saveLead(psid, {
    status: "room_selected",
    selectedHomeId: homeId,
    selectedHomeName: home.displayName,
    dateKey: context.dateKey,
    startMinute: context.startMinute,
    checkoutMinute: context.checkoutMinute,
    durationHours: context.durationHours,
    guestCount: context.guestCount || config.standardGuests
  });

  await sendTemplateAndLog(
    psid,
    chooseCopy([
      `${home.displayName} đang phù hợp với khung bạn chọn. Bạn xem ảnh hoặc mở lịch chi tiết tại đây nhé.`,
      `Được nha, ${home.displayName} hiện ghép được với thời gian của bạn. Mình gửi các bước tiếp theo bên dưới.`,
      `${home.displayName} đang còn theo dữ liệu mới nhất. Bạn có thể xem phòng rồi gửi yêu cầu giữ chỗ.`
    ]),
    [
      { type: "web_url", title: "Xem phòng", url: buildRoomUrl(home, nextContext) },
      { type: "web_url", title: "Xem lịch trống", url: buildCalendarUrl(nextContext) },
      { type: "postback", title: "Giữ phòng", payload: "HOLD|REQUEST" }
    ],
    "home_selected"
  );
}

async function requestPhone(psid, context) {
  const afterHours = isAfterHours();
  await saveConversation(psid, { state: "awaiting_phone", context });
  await saveLead(psid, {
    status: "booking_intent",
    dateKey: context.dateKey || "",
    startMinute: context.startMinute,
    checkoutMinute: context.checkoutMinute,
    durationHours: context.durationHours,
    guestCount: context.guestCount || config.standardGuests,
    selectedHomeId: context.preferredHomeId || "",
    selectedHomeName: context.selectedHome?.displayName || "",
    afterHours
  });
  await safeNotifyOwner(psid, {
    type: "booking_intent",
    priority: "high",
    title: afterHours ? "Khách muốn giữ phòng ngoài giờ" : "Khách muốn giữ phòng",
    message: `${context.selectedHome?.displayName || context.preferredHomeId || "Khách đã chọn HOME"} và đang được hỏi số điện thoại.`,
    context: alertContext(context),
    afterHours,
    forceExternal: true
  });
  await replyAndLog(
    psid,
    `${chooseCopy([
      `Bạn gửi giúp mình số điện thoại. Nhân viên sẽ xác nhận lại phòng, giá và hướng dẫn thanh toán${afterHours ? ` từ ${afterHoursResumeLabel()}` : ""} trước khi khóa lịch nhé.`,
      `Để nhân viên giữ đúng khung, bạn để lại số điện thoại giúp mình nha. Lịch chỉ khóa sau khi xác nhận thanh toán${afterHours ? `; ngoài giờ bên mình xử lý tiếp từ ${afterHoursResumeLabel()}` : ""}.`,
      `Bạn cho mình số điện thoại liên hệ. Bên mình sẽ kiểm tra lần cuối${afterHours ? ` vào đầu ca lúc ${afterHoursResumeLabel()}` : ""} rồi gửi hướng dẫn thanh toán.`
    ])}${config.overnightIdRequired && isOvernightDuration(context.durationHours) ? " Gói qua đêm cần gửi CCCD để xác nhận thông tin nhận phòng." : ""}`,
    [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]
  );
}

async function handoff(psid, context) {
  const afterHours = isAfterHours();
  await saveConversation(psid, { state: "human_handoff", handoffRequested: true, context });
  await setConversationControl(psid, "human", {
    updatedBy: "customer",
    reason: "customer_requested_human",
    actorName: "Khách Messenger",
    source: "conversation",
    allowCustomerResume: true
  });
  await saveLead(psid, {
    status: "needs_human",
    handoffRequested: true,
    dateKey: context.dateKey || "",
    startMinute: context.startMinute,
    checkoutMinute: context.checkoutMinute,
    durationHours: context.durationHours,
    phone: context.phone || "",
    selectedHomeId: context.preferredHomeId || "",
    afterHours
  });
  await safeNotifyOwner(psid, {
    type: "human_handoff",
    priority: "high",
    title: afterHours ? "Khách cần nhân viên ngoài giờ" : "Khách cần nhân viên",
    message: "Khách vừa yêu cầu gặp nhân viên trực tiếp.",
    context: alertContext(context),
    afterHours,
    forceExternal: true
  });
  await replyAndLog(
    psid,
    afterHours
      ? `Mình đã ghi nhận và báo nhân viên ${config.brandName}. Hiện đang ngoài giờ, bên mình sẽ phản hồi từ ${afterHoursResumeLabel()}. Bot đang tạm dừng để không chen ngang; nếu muốn kiểm tra lịch tiếp, bạn nhắn “bot kiểm tra tiếp”.`
      : `Mình đã chuyển yêu cầu cho nhân viên ${config.brandName} và tạm dừng bot để nhân viên tư vấn tiếp. Nếu muốn dùng bot lại, bạn nhắn “bot kiểm tra tiếp”. Hotline: ${config.supportPhone}.`
  );
}


function homeChoiceReplies(catalog, prefix = "PRICE_HOME") {
  return (catalog?.homes || []).slice(0, 10).map(home => ({
    title: home.roomCode,
    payload: `${prefix}|${home.roomCode}`
  }));
}

function comboLabel(hours) {
  return isOvernightDuration(hours) ? `Qua đêm ${hours}H` : `Combo ${hours}H`;
}

function priceRangeLabel(range) {
  if (!range) return "";
  return range.min === range.max
    ? formatMoneyVi(range.min)
    : `${formatMoneyVi(range.min)}–${formatMoneyVi(range.max)}`;
}

function customerPolicyNote(context = {}, comboHours = null) {
  const guests = Number(context.guestCount || config.standardGuests);
  const parts = [
    `Giá combo tiêu chuẩn cho ${config.standardGuests} người. Từ người thứ ${config.standardGuests + 1}: +${formatMoneyVi(config.extraGuestFee)}/người.`
  ];
  if (config.overnightIdRequired && isOvernightDuration(comboHours)) {
    parts.push("Gói qua đêm cần gửi CCCD để xác nhận thông tin nhận phòng.");
  }
  if (guests > config.standardGuests) {
    parts.push(`Bạn đang hỏi cho ${guests} người nên phụ thu dự kiến là ${formatMoneyVi(extraGuestCharge(guests, config.standardGuests, config.extraGuestFee))}.`);
  }
  return parts.join(" ");
}

async function answerPriceFaq(psid, context, rawText = "") {
  const catalog = await loadPricingCatalog({ forceRefresh: true });
  const homeReference = parseHomeReference(rawText)
    || context.preferredHomeId
    || context.selectedHome?.homeId
    || "";
  const home = findPricingHome(catalog, homeReference);
  const normalizedText = normalizeVietnamese(rawText);
  const overnightGeneric = /\b(qua dem|nghi dem|overnight)\b/.test(normalizedText)
    && !/\b(12|14|22)\s*(?:h|gio|tieng)\b/.test(normalizedText);
  const comboHours = overnightGeneric
    ? 0
    : Number(context.durationHours || parseDurationFromText(rawText, { state: "awaiting_duration" }) || 0);
  const guests = Number(context.guestCount || parseGuestCount(rawText) || config.standardGuests);
  const guestFee = extraGuestCharge(guests, config.standardGuests, config.extraGuestFee);

  if (home) {
    if (comboHours > 0) {
      const basePrice = Number(home.combos?.[comboHours] || 0);
      if (basePrice <= 0) {
        await replyAndLog(
          psid,
          `${home.displayName} hiện chưa có giá ${comboLabel(comboHours)} trong bảng giá Firebase. Bạn chọn combo khác hoặc để nhân viên kiểm tra giúp nhé.`,
          DURATION_REPLIES
        );
        return true;
      }

      const total = basePrice + guestFee;
      const lines = [
        `${home.displayName} · ${comboLabel(comboHours)}`,
        `• Giá combo (${config.standardGuests} người): ${formatMoneyVi(basePrice)}`
      ];
      if (guestFee > 0) {
        lines.push(`• Phụ thu ${guests - config.standardGuests} người: ${formatMoneyVi(guestFee)}`);
        lines.push(`• Tổng dự kiến: ${formatMoneyVi(total)}`);
      }
      lines.push("", customerPolicyNote({ ...context, guestCount: guests }, comboHours));
      await replyAndLog(psid, lines.join("\n"), [
        { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
        { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
      ]);
      return true;
    }

    const rows = SUPPORTED_DURATIONS
      .filter(hours => (!overnightGeneric || isOvernightDuration(hours)) && Number(home.combos?.[hours] || 0) > 0)
      .map(hours => `• ${comboLabel(hours)}: ${formatMoneyVi(home.combos[hours])}`);
    if (!rows.length) {
      await replyAndLog(psid, `${home.displayName} hiện chưa có bảng giá combo trong Firebase. Mình chuyển nhân viên kiểm tra giúp bạn nhé.`, [
        { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
      ]);
      return true;
    }
    await replyAndLog(
      psid,
      [`Bảng giá ${home.displayName}:`, ...rows, "", customerPolicyNote({ ...context, guestCount: guests }, overnightGeneric ? 12 : null)].join("\n"),
      DURATION_REPLIES
    );
    return true;
  }

  if (comboHours > 0) {
    const range = comboPriceRange(catalog, comboHours);
    if (!range) {
      await replyAndLog(psid, `Hiện chưa có giá ${comboLabel(comboHours)} trong Firebase. Bạn chọn combo khác hoặc gặp nhân viên nhé.`, DURATION_REPLIES);
      return true;
    }
    const rows = range.rows.map(({ home: item, price }) => `• ${item.roomCode}: ${formatMoneyVi(price + guestFee)}`);
    const heading = guestFee > 0
      ? `${comboLabel(comboHours)} cho ${guests} người (đã cộng phụ thu):`
      : `${comboLabel(comboHours)} theo từng HOME:`;
    await replyAndLog(
      psid,
      [heading, ...rows, "", customerPolicyNote({ ...context, guestCount: guests }, comboHours)].join("\n"),
      homeChoiceReplies(catalog)
    );
    return true;
  }

  const ranges = allComboRanges(catalog)
    .filter(range => !overnightGeneric || isOvernightDuration(range.hours));
  if (!ranges.length) {
    await replyAndLog(psid, "Hiện hệ thống chưa đọc được bảng giá combo. Mình chuyển nhân viên kiểm tra giúp bạn nhé.", [
      { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
    ]);
    return true;
  }
  const rows = ranges.map(range => `• ${comboLabel(range.hours)}: ${priceRangeLabel(range)}`);
  await replyAndLog(
    psid,
    [
      overnightGeneric
        ? "Giá các gói qua đêm hiện tại (mức thấp nhất–cao nhất tùy HOME):"
        : "Giá combo hiện tại (mức thấp nhất–cao nhất tùy HOME):",
      ...rows,
      "",
      customerPolicyNote({ ...context, guestCount: guests }, overnightGeneric ? 12 : null),
      "Bạn chọn HOME hoặc combo cụ thể, mình báo đúng giá ngay."
    ].join("\n"),
    homeChoiceReplies(catalog)
  );
  return true;
}

async function answerLateCheckoutFaq(psid, context, rawText = "") {
  const catalog = await loadPricingCatalog({ forceRefresh: true });
  const homeReference = parseHomeReference(rawText)
    || context.preferredHomeId
    || context.selectedHome?.homeId
    || "";
  const home = findPricingHome(catalog, homeReference);

  if (home) {
    const fee = Number(home.lateCheckout?.amount || 0);
    if (fee <= 0) {
      await replyAndLog(
        psid,
        `${home.displayName} chưa có mức phụ thu checkout trễ trong Firebase. Bạn nhắn nhân viên xác nhận trước khi gia hạn nhé.`,
        [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]
      );
      return true;
    }
    await replyAndLog(
      psid,
      chooseCopy([
        `${home.displayName} tính checkout trễ theo từng 30 phút: ${formatMoneyVi(fee)}/30 phút. Việc trả trễ còn tùy lịch booking ngay sau đó, nên bạn báo sớm để nhân viên xác nhận nhé.`,
        `Phụ thu trả trễ của ${home.displayName} hiện là ${formatMoneyVi(fee)} cho mỗi 30 phút. Nếu sau phòng có khách kế tiếp thì có thể không gia hạn được.`
      ]),
      [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]
    );
    return true;
  }

  const range = lateCheckoutRange(catalog);
  if (!range) {
    await replyAndLog(psid, "Mức phụ thu checkout trễ khác nhau theo HOME và hiện chưa đọc được đầy đủ trong Firebase. Bạn chọn HOME để nhân viên xác nhận nhé.", homeChoiceReplies(catalog, "LATE_HOME"));
    return true;
  }
  await replyAndLog(
    psid,
    `Checkout trễ được tính theo từng 30 phút. Mức hiện tại dao động ${formatMoneyVi(range.min)}–${formatMoneyVi(range.max)}/30 phút tùy HOME. Bạn chọn HOME để mình báo đúng mức phụ thu.`,
    homeChoiceReplies(catalog, "LATE_HOME")
  );
  return true;
}

function detectFaqIntent(text) {
  const s = normalizeVietnamese(text);
  if (/\b(tra tre|checkout tre|check out tre|qua gio|phu thu qua gio|phu thu tra tre|tre 30 phut|tre nua tieng)\b/.test(s)) return "late_checkout";
  if (/\b(cccd|cmnd|can cuoc|giay to|qua dem can gi|qua dem co can)\b/.test(s)) return "identity";
  if (/\b(may ban hang|ban do an|ban nuoc|snack|snacks|mi ly|nuoc ngot|nuoc uong|do an nhanh)\b/.test(s)) return "vending";
  if (/\b(gia|bao nhieu tien|bang gia|combo nao|gia phong|gia combo|tien phong|gia cuoi tuan|gia ngay le|\d{1,2}h gia sao|combo \d{1,2})\b/.test(s)
      || (/\bbao nhieu\b/.test(s) && !/\b(nguoi|khach|tre|phut|gio tra|gio vao)\b/.test(s))) return "price";
  if (/\b(dia chi|o dau|vi tri|duong nao|gan quan 1|gui map|ban do|google map|map dau|dia chi home)\b/.test(s)) return "location";
  if (/\b(coc|dat coc|coc bao nhieu)\b/.test(s)) return "deposit";
  if (/\b(thanh toan|chuyen khoan|tra tien)\b/.test(s)) return "payment";
  if (/\b(may nguoi|so nguoi|\d{1,2} nguoi|\d{1,2} khach|them nguoi|nguoi thu 3|phu thu nguoi|phu thu them nguoi)\b/.test(s)) return "capacity";
  if (/\b(check in|checkin|nhan phong|vao phong|ma cua|mat khau cua|tu checkin|self checkin|le tan)\b/.test(s)) return "checkin";
  if (/\b(tien nghi|may chieu|bon tam|netflix|tv 55|ban cong)\b/.test(s)) return "amenities";
  if (/\b(huy phong|doi lich|doi gio|hoan coc|hoan tien|doi home|doi combo)\b/.test(s)) return "change";
  if (/\b(gui xe|de xe|bai xe)\b/.test(s)) return "parking";
  if (/\b(hotline|so dien thoai|lien he)\b/.test(s)) return "contact";
  if (/\b(mo cua|hoat dong|may gio|24\/24|nhan khach khuya|checkin khuya)\b/.test(s)) return "hours";
  if (/\b(wifi|internet|mat khau wifi)\b/.test(s)) return "wifi";
  if (/\b(rieng tu|kin dao|camera|an ninh)\b/.test(s)) return "privacy";
  if (/\b(khuyen mai|uu dai|giam gia|voucher)\b/.test(s)) return "promotion";
  if (/\b(noi quy|thu tuc)\b/.test(s)) return "rules";
  if (/\b(nau an|do an|mang do an|an uong)\b/.test(s)) return "food";
  if (/\b(thu cung|cho meo|pet)\b/.test(s)) return "pets";
  if (/\b(hut thuoc|thuoc la)\b/.test(s)) return "smoking";
  if (/\b(don phong|ve sinh|thoi gian don|phong sach khong|don may phut)\b/.test(s)) return "cleaning";
  if (/\b(vao som|check in som|checkin som|gia han|o them|them gio)\b/.test(s)) return "early_late";
  if (/\b(xuat hoa don|hoa don|vat)\b/.test(s)) return "invoice";
  if (/\b(sinh nhat|trang tri|ky niem|cau hon|surprise)\b/.test(s)) return "celebration";
  if (/\b(gui hanh ly|de hanh ly|giu do|vali)\b/.test(s)) return "luggage";
  if (/\b(thang may|cau thang|tang may|tang bao nhieu)\b/.test(s)) return "access";
  if (/\b(khan tam|ban chai|kem danh rang|dau goi|do dung ca nhan)\b/.test(s)) return "toiletries";
  if (/\b(on khong|cach am|tieng on|yen tinh)\b/.test(s)) return "noise";
  if (/\b(phong nao dep|home nao dep|phong nao rong|goi y phong|nen chon home)\b/.test(s)) return "recommendation";
  if (/\b(anh that|hinh that|giong anh|phong co giong hinh)\b/.test(s)) return "photo_accuracy";
  if (/\b(may lanh|dieu hoa|nuoc nong|binh nong lanh)\b/.test(s)) return "comfort_amenities";
  if (/\b(lich co chinh xac|lich that|lay du lieu o dau|kiem tra firebase|cap nhat lich)\b/.test(s)) return "availability_accuracy";
  if (/\b(co le tan|le tan truc|tu vao phong|tu nhan phong)\b/.test(s)) return "self_checkin";
  return "";
}

async function answerFaq(psid, intent, context, rawText = "") {
  if (intent === "price") {
    return answerPriceFaq(psid, context, rawText);
  }

  if (intent === "location") {
    const homeReference = parseHomeReference(rawText) || context.preferredHomeId || "";
    const home = homeReference ? await resolveHomeByPayload(homeReference) : null;
    const address = home?.address || config.homeAddress;
    const mapUrl = home?.mapUrl || config.mapUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
    const label = home?.displayName ? `${home.displayName} tại` : `${config.brandName} ở`;
    await sendTemplateAndLog(
      psid,
      `${label} ${address}. Khu vực Bình Thạnh, gần cầu Bông và thuận tiện đi Quận 1.`,
      [
        { type: "web_url", title: "Mở Google Maps", url: mapUrl },
        { type: "web_url", title: home ? "Xem HOME này" : "Xem website", url: home ? buildRoomUrl(home, context) : `${config.siteUrl}/?src=facebook` },
        { type: "web_url", title: "Xem lịch trống", url: buildCalendarUrl(context) }
      ],
      "faq_location"
    );
    return true;
  }

  if (intent === "deposit") {
    await replyAndLog(
      psid,
      "Bên mình giữ chỗ sau khi nhận cọc 50%. Nhân viên sẽ xác nhận đúng HOME, thời gian và số tiền trước khi gửi thông tin thanh toán.",
      [
        { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
        { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
      ]
    );
    return true;
  }

  if (intent === "payment") {
    await replyAndLog(
      psid,
      "Sau khi chọn được HOME và khung giờ, nhân viên sẽ xác nhận giá rồi gửi hướng dẫn thanh toán. Lịch chỉ được khóa khi khoản thanh toán/cọc đã được xác nhận.",
      [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]
    );
    return true;
  }

  if (intent === "capacity") {
    const guests = Number(context.guestCount || parseGuestCount(rawText) || config.standardGuests);
    const surcharge = extraGuestCharge(guests, config.standardGuests, config.extraGuestFee);
    const detail = surcharge > 0
      ? `Với ${guests} người, phụ thu dự kiến là ${formatMoneyVi(surcharge)} ngoài giá combo.`
      : `Giá combo hiện áp dụng đúng tiêu chuẩn ${config.standardGuests} người.`;
    await replyAndLog(
      psid,
      `Mỗi phòng tiêu chuẩn ${config.standardGuests} người. Từ người thứ ${config.standardGuests + 1}, phụ thu ${formatMoneyVi(config.extraGuestFee)}/người. ${detail} Số khách tối đa còn tùy từng HOME, nên nếu nhóm đông bạn báo trước để nhân viên xác nhận nhé.`,
      [
        { title: "Xem giá combo", payload: "FAQ|PRICE" },
        { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
      ]
    );
    return true;
  }

  if (intent === "checkin") {
    await replyAndLog(
      psid,
      "Sau khi xác nhận thanh toán, bên mình sẽ gửi hướng dẫn nhận phòng và thông tin cần thiết qua Messenger. Bạn nhớ chọn đúng ngày, giờ và HOME trước nha.",
      [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]
    );
    return true;
  }

  if (intent === "amenities") {
    await replyAndLog(
      psid,
      "Tiện nghi khác nhau theo từng HOME. Hiện có Netflix, máy chiếu, TV 55 inch; HOME 1 có bồn tắm riêng. Khu HOME còn có máy bán hàng tự động phục vụ snacks, mì ly và các loại nước uống. Bạn nói tiện nghi cần nhất, mình lọc phòng phù hợp nhé.",
      [
        { title: "Có máy chiếu", payload: "AMENITY|may chieu" },
        { title: "Có bồn tắm", payload: "AMENITY|bon tam" },
        { title: "Xem hình phòng", payload: "OPEN|GALLERY" }
      ]
    );
    return true;
  }

  if (intent === "change") {
    await replyAndLog(
      psid,
      "Việc đổi giờ, đổi ngày hoặc hoàn/hủy sẽ phụ thuộc tình trạng booking và thời điểm báo. Mình chuyển nhân viên kiểm tra trường hợp cụ thể cho bạn nhé.",
      [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]
    );
    return true;
  }

  if (intent === "parking") {
    await replyAndLog(
      psid,
      "Tình trạng chỗ gửi xe có thể phụ thuộc thời điểm và loại xe. Bạn cho mình loại xe hoặc bấm gặp nhân viên để được xác nhận chính xác nhé.",
      [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]
    );
    return true;
  }

  if (intent === "contact") {
    await replyAndLog(psid, `Hotline của ${config.brandName}: ${config.supportPhone}. Bạn cũng có thể nhắn ngay tại đây để mình kiểm tra lịch trước.`);
    return true;
  }

  if (intent === "hours") {
    await replyAndLog(
      psid,
      chooseCopy([
        "Giờ nhận phòng linh hoạt theo lịch trống và combo. Bạn gửi ngày, giờ dự kiến, mình sẽ kiểm tra trực tiếp trên hệ thống.",
        "Bên mình không cố định một giờ nhận phòng cho mọi booking. Bạn cho mình ngày, giờ và số tiếng để mình dò lịch thật nhé."
      ]),
      [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]
    );
    return true;
  }

  if (intent === "wifi") {
    await replyAndLog(psid, chooseCopy([
      "Thông tin Wi-Fi và hướng dẫn sử dụng phòng sẽ được gửi sau khi booking được xác nhận. Bạn cần mình kiểm tra lịch trước không?",
      "Sau khi xác nhận phòng, bên mình sẽ gửi đầy đủ thông tin sử dụng, trong đó có Wi-Fi."
    ]), [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]);
    return true;
  }

  if (intent === "privacy") {
    await replyAndLog(psid, chooseCopy([
      "3 Cây Non hướng đến trải nghiệm nghỉ ngơi riêng tư. Với câu hỏi cụ thể về an ninh hoặc khu vực camera, mình sẽ chuyển nhân viên xác nhận chính xác cho bạn.",
      "Không gian phòng được vận hành theo hướng riêng tư. Chi tiết an ninh từng khu vực, nhân viên sẽ giải thích rõ để bạn yên tâm."
    ]), [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]);
    return true;
  }

  if (intent === "promotion") {
    await replyAndLog(psid, chooseCopy([
      "Ưu đãi có thể thay đổi theo ngày và khung giờ. Bạn cho mình lịch dự kiến, mình kiểm tra phòng trước rồi nhân viên xác nhận mức giá tốt nhất nhé.",
      "Mình chưa tự áp mã giảm giá để tránh báo sai. Bạn gửi ngày, giờ và combo, bên mình sẽ kiểm tra ưu đãi đang áp dụng."
    ]), [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]);
    return true;
  }

  if (intent === "identity") {
    await replyAndLog(
      psid,
      "Đối với các gói qua đêm 12H, 14H hoặc 22H, khách cần gửi CCCD để xác nhận thông tin nhận phòng. Bên mình chỉ dùng thông tin cho quy trình lưu trú và nhân viên sẽ hướng dẫn cách gửi sau khi chốt booking.",
      [
        { title: "Xem giá qua đêm", payload: "FAQ|PRICE" },
        { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }
      ]
    );
    return true;
  }

  if (intent === "vending" || intent === "food") {
    await replyAndLog(
      psid,
      chooseCopy([
        "Khu HOME có máy bán hàng tự động phục vụ snacks, mì ly và nhiều loại nước uống, nên bạn có thể mua nhanh khi cần nha.",
        "Có nha 🌿 Bên mình có máy bán hàng tự động với snacks, mì ly và nước uống để khách dùng thuận tiện, kể cả buổi tối."
      ]),
      [
        { title: "Xem tiện nghi", payload: "OPEN|GALLERY" },
        { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }
      ]
    );
    return true;
  }

  if (intent === "late_checkout") {
    return answerLateCheckoutFaq(psid, context, rawText);
  }

  if (["rules", "pets", "smoking", "invoice"].includes(intent)) {
    const labels = {
      rules: "thủ tục nhận phòng và giấy tờ",
      pets: "chính sách thú cưng",
      smoking: "khu vực hút thuốc",
      invoice: "việc xuất hóa đơn"
    };
    await replyAndLog(
      psid,
      `Nội dung về ${labels[intent]} cần kiểm tra theo HOME và quy định tại thời điểm đặt. Mình chuyển nhân viên xác nhận rõ cho bạn nhé.`,
      [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]
    );
    return true;
  }

  if (intent === "cleaning") {
    await replyAndLog(psid, chooseCopy([
      "Hệ thống có chừa thời gian dọn phòng giữa các lượt khách, nên một số khung sát booking trước có thể chưa nhận được. Mình sẽ tính phần này khi kiểm tra lịch.",
      "Khi dò lịch, bot đã tính cả khoảng dọn phòng giữa hai booking để tránh báo trống sát giờ."
    ]), [{ title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }]);
    return true;
  }

  if (intent === "early_late") {
    await replyAndLog(
      psid,
      "Nhận sớm hoặc gia hạn phụ thuộc lịch ngay trước/sau booking. Bạn gửi HOME và khung giờ cụ thể để bên mình kiểm tra. Riêng checkout trễ sẽ tính theo từng 30 phút với mức phụ thu riêng của từng HOME.",
      [
        { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
        { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
      ]
    );
    return true;
  }

  if (intent === "celebration") {
    await replyAndLog(psid, chooseCopy([
      "Trang trí sinh nhật, kỷ niệm hoặc bất ngờ cần xác nhận theo HOME và thời gian chuẩn bị. Mình chuyển nhân viên tư vấn gói phù hợp cho bạn nhé.",
      "Bên mình có thể ghi nhận nhu cầu trang trí, nhưng cần nhân viên kiểm tra HOME và mức trang trí cụ thể trước khi báo giá."
    ]), [{ title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }]);
    return true;
  }

  if (intent === "luggage") {
    await replyAndLog(psid, "Việc gửi hành lý trước hoặc sau giờ ở phụ thuộc lịch vận hành trong ngày. Mình chuyển nhân viên xác nhận khung cụ thể cho bạn nhé.", [
      { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
    ]);
    return true;
  }

  if (intent === "access") {
    await replyAndLog(psid, "Vị trí tầng, cầu thang hoặc thang máy có thể khác theo từng HOME. Bạn cho mình HOME đang quan tâm để nhân viên xác nhận đúng nhé.", [
      { title: "Xem hình phòng", payload: "OPEN|GALLERY" },
      { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
    ]);
    return true;
  }

  if (intent === "toiletries") {
    await replyAndLog(psid, "Tiện nghi và đồ dùng cá nhân có thể khác theo từng HOME. Bạn xem trang chi tiết phòng hoặc cho mình HOME để bên mình xác nhận danh sách chính xác nhé.", [
      { title: "Xem hình phòng", payload: "OPEN|GALLERY" },
      { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
    ]);
    return true;
  }

  if (intent === "noise") {
    await replyAndLog(psid, "Mức độ yên tĩnh phụ thuộc vị trí từng HOME và thời điểm. Bên mình ưu tiên trải nghiệm riêng tư; nếu bạn nhạy với tiếng ồn, nhân viên sẽ gợi ý HOME phù hợp hơn.", [
      { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
    ]);
    return true;
  }

  if (intent === "recommendation") {
    await replyAndLog(psid, "HOME phù hợp nhất còn tùy bạn ưu tiên bồn tắm, máy chiếu, TV lớn hay mức giá. Bạn chọn tiêu chí quan trọng nhất, mình lọc giúp nhé.", [
      { title: "Có máy chiếu", payload: "AMENITY|may chieu" },
      { title: "Có bồn tắm", payload: "AMENITY|bon tam" },
      { title: "Xem hình phòng", payload: "OPEN|GALLERY" }
    ]);
    return true;
  }

  if (intent === "photo_accuracy") {
    await replyAndLog(psid, "Bạn có thể xem ảnh theo từng HOME trên thư viện. Bố trí hoặc chi tiết trang trí có thể được cập nhật theo thời điểm, nên nếu cần đúng một góc cụ thể mình sẽ nhờ nhân viên xác nhận ảnh mới nhất.", [
      { title: "Xem hình phòng", payload: "OPEN|GALLERY" },
      { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
    ]);
    return true;
  }

  if (intent === "comfort_amenities") {
    await replyAndLog(psid, "Tiện nghi như máy lạnh hoặc nước nóng cần đối chiếu theo HOME cụ thể. Bạn chọn HOME hoặc gửi ngày, giờ để mình tìm phòng trước rồi xác nhận chi tiết nhé.", [
      { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
      { title: "Xem hình phòng", payload: "OPEN|GALLERY" }
    ]);
    return true;
  }

  if (intent === "availability_accuracy") {
    await replyAndLog(psid, "Bot đọc trực tiếp danh sách HOME và booking thật từ Firebase Realtime Database mỗi lần kiểm tra. Kết quả có tính cả booking đã xác nhận, giữ chỗ còn hạn và thời gian dọn phòng trước/sau lượt khách.", [
      { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }
    ]);
    return true;
  }

  if (intent === "self_checkin") {
    await replyAndLog(psid, "Sau khi booking và thanh toán được xác nhận, bên mình sẽ gửi hướng dẫn nhận phòng, thông tin phòng và cách vào phòng qua Messenger. Trường hợp cần hỗ trợ trực tiếp, nhân viên vẫn theo dõi hội thoại.", [
      { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
      { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
    ]);
    return true;
  }

  return false;
}

async function handleSpecialPayload(psid, payload, context) {
  if (["GET_STARTED", "WELCOME", "MENU|HELP", "BOT|RESUME"].includes(payload)) {
    if (payload === "BOT|RESUME") {
      await setConversationControl(psid, "bot", {
        updatedBy: "customer",
        reason: "customer_requested_bot_resume",
        actorName: "Khách Messenger",
        source: "quick_reply",
        allowCustomerResume: false
      });
    }
    await saveConversation(psid, { state: "new", context, handoffRequested: false });
    await welcome(psid);
    return true;
  }
  if (payload === "START|AVAILABILITY") {
    const fresh = cleanContext({});
    await saveConversation(psid, { state: "awaiting_date", context: fresh });
    await replyAndLog(psid, "Bạn muốn ở ngày nào?", DATE_REPLIES);
    return true;
  }
  if (payload.startsWith("GALLERY_HOME|")) {
    const homeId = payload.split("|")[1] || "";
    await sendHomeGallery(psid, homeId, context);
    return true;
  }
  if (payload === "OPEN|GALLERY") {
    const selectedHomeId = context.selectedHome?.homeId || context.preferredHomeId || "";
    if (selectedHomeId) {
      await sendHomeGallery(psid, selectedHomeId, context);
    } else {
      await askHomeForGallery(psid, context);
    }
    return true;
  }
  if (payload.startsWith("PRICE_HOME|")) {
    const homeId = payload.split("|")[1] || "";
    const next = cleanContext({ ...context, preferredHomeId: homeId, selectedHome: null });
    await saveConversation(psid, { state: "new", context: next });
    return answerPriceFaq(psid, next, `${homeId} giá bao nhiêu`);
  }
  if (payload.startsWith("LATE_HOME|")) {
    const homeId = payload.split("|")[1] || "";
    const next = cleanContext({ ...context, preferredHomeId: homeId, selectedHome: null });
    await saveConversation(psid, { state: "new", context: next });
    return answerLateCheckoutFaq(psid, next, `${homeId} checkout trễ`);
  }
  if (payload.startsWith("FAQ|")) {
    const intentMap = { PRICE: "price", LOCATION: "location", DEPOSIT: "deposit" };
    return answerFaq(psid, intentMap[payload.split("|")[1]] || "", context);
  }
  if (payload.startsWith("AMENITY|")) {
    const amenity = payload.split("|").slice(1).join("|");
    const next = cleanContext({ ...context, amenities: [amenity], preferredHomeId: "", selectedHome: null });
    await saveConversation(psid, { state: "new", context: next });
    const missingHandled = await askNextMissing(psid, next);
    if (!missingHandled) await showAvailability(psid, next);
    return true;
  }
  if (payload === "FILTER|CLEAR") {
    const next = cleanContext({ ...context, amenities: [], preferredHomeId: "", selectedHome: null });
    await saveConversation(psid, { state: "checking_availability", context: next });
    await showAvailability(psid, next);
    return true;
  }
  return false;
}

async function handleConversationEventInternal({
  psid,
  text = "",
  payload = "",
  eventId = "",
  attachmentType = ""
}) {
  await logMessage(psid, "in", { text, payload, eventId, attachmentType });
  const existing = await getConversation(psid);
  let state = existing?.state || "new";
  let context = cleanContext(existing?.context || {});

  await maybeSendAfterHoursNotice(psid, existing, state, context, text);

  if (detectReset(text) || payload === "RESET|ALL") {
    state = "new";
    context = cleanContext({});
    await saveConversation(psid, { state, context, handoffRequested: false });
  }

  const currentMessageContext = text
    ? mergeParsedContext(text, context, state)
    : context;
  await maybeNotifyUrgentIntent(psid, text, existing, currentMessageContext);

  if (isExplicitHumanAction(text, payload)) {
    await handoff(psid, currentMessageContext);
    return;
  }

  if (state === "human_handoff") {
    const phone = parsePhone(text);
    if (phone) {
      context.phone = phone;
      await saveConversation(psid, { state: "human_handoff", context, handoffRequested: true });
      await saveLead(psid, { status: "needs_human", phone, handoffRequested: true, afterHours: isAfterHours() });
      await safeNotifyOwner(psid, {
        type: "human_phone",
        priority: "high",
        title: "Khách cần nhân viên đã để lại SĐT",
        message: `Khách vừa bổ sung số ${phone}.`,
        context: alertContext(context),
        afterHours: isAfterHours(),
        forceExternal: true
      });
      await replyAndLog(psid, `Mình đã bổ sung số ${phone} cho nhân viên phụ trách. ${isAfterHours() ? `Bên mình sẽ phản hồi từ ${afterHoursResumeLabel()}. ` : ""}Trong lúc chờ, bạn vẫn có thể nhắn mình kiểm tra lịch hoặc hỏi thông tin phòng.`);
      return;
    }

    const shouldResume = detectResumeBot(text)
      || detectAvailabilityRequest(text)
      || detectGalleryRequest(text)
      || detectCalendarLinkRequest(text)
      || Boolean(detectFaqIntent(text))
      || ["START|AVAILABILITY", "OPEN|GALLERY", "BOT|RESUME", "GET_STARTED"].includes(payload)
      || payload.startsWith("GALLERY_HOME|");

    if (shouldResume) {
      state = "new";
      await saveConversation(psid, { state, context, handoffRequested: false });
    } else {
      await replyAndLog(
        psid,
        chooseCopy([
          "Nhân viên đã nhận yêu cầu của bạn. Trong lúc chờ, bot vẫn có thể kiểm tra lịch, giá/combo hoặc gửi hình phòng nhé.",
          "Mình đã báo nhân viên rồi nha. Bạn vẫn có thể tiếp tục hỏi lịch trống hoặc thông tin phòng, mình sẽ trả lời ngay."
        ]),
        [
          { title: "Bot kiểm tra lịch", payload: "START|AVAILABILITY" },
          { title: "Xem hình phòng", payload: "OPEN|GALLERY" }
        ]
      );
      return;
    }
  }

  if (attachmentType && !text && !payload) {
    await replyAndLog(
      psid,
      attachmentType === "audio"
        ? "Hiện mình chưa nghe được tin nhắn thoại. Bạn nhập giúp mình ngày, giờ và thời lượng bằng chữ nhé."
        : "Mình đã nhận được tệp bạn gửi. Hiện bot xử lý tốt nhất khi bạn nhập câu hỏi bằng chữ; nếu cần người xem ảnh/tệp, mình chuyển nhân viên nhé.",
      [
        { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
        { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
      ]
    );
    return;
  }

  if (payload && await handleSpecialPayload(psid, payload, context)) return;

  const bookingIntent = !payload && detectBookingIntent(text);
  const availabilityIntent = !payload && (detectAvailabilityRequest(text) || bookingIntent);
  if (availabilityIntent) {
    // A new availability question starts a clean search. This prevents an old HOME or amenity
    // filter from making every later query look unavailable.
    state = "new";
    context = freshSearchContext(text);
    await saveConversation(psid, { state, context, handoffRequested: false });
  }

  if (!availabilityIntent && detectGalleryRequest(text) && !payload) {
    const requestedHome = parseHomeReference(text)
      || context.selectedHome?.homeId
      || context.preferredHomeId
      || "";

    if (requestedHome) {
      await sendHomeGallery(psid, requestedHome, context);
    } else {
      await askHomeForGallery(psid, context);
    }
    return;
  }

  const parsedDate = parseDateFromText(text);
  const parsedStay = parseStayWindowFromText(text, { state });
  const parsedTime = parsedStay.checkInMinute;
  const parsedDuration = parsedStay.durationHours;
  if (!availabilityIntent && detectCalendarLinkRequest(text) && !payload && !parsedDate && parsedTime == null && !parsedDuration) {
    await sendTemplateAndLog(psid, "Mình gửi bạn lịch trống hiện tại nhé.", [
      { type: "web_url", title: "Mở lịch trống", url: buildCalendarUrl(context) }
    ], "calendar_link");
    return;
  }

  if (!payload && detectGoodbye(text)) {
    await replyAndLog(psid, chooseCopy([
      "Dạ, khi nào cần kiểm tra lịch bạn cứ nhắn lại nha 🌿",
      "Cảm ơn bạn đã liên hệ 3 Cây Non. Hẹn gặp lại bạn nhé."
    ]));
    return;
  }

  if (!payload && detectThanks(text)) {
    await replyAndLog(psid, chooseCopy([
      "Dạ được nha 🌿 Bạn cần kiểm tra thêm khung nào cứ nhắn mình.",
      "Ok bạn nha. Mình vẫn ở đây nếu bạn muốn xem lịch hoặc hình phòng.",
      "Cảm ơn bạn. Khi cần, bạn gửi ngày + giờ + số tiếng là mình kiểm tra ngay."
    ]), HELP_REPLIES);
    return;
  }

  if (!payload && detectMoreOptions(text) && context.dateKey && context.durationHours && context.startMinute != null) {
    const next = cleanContext({ ...context, preferredHomeId: "", selectedHome: null });
    await showAvailability(psid, next);
    return;
  }

  if (!payload && detectHoldRequest(text) && context.selectedHome) {
    await requestPhone(psid, context);
    return;
  }

  if (!payload && context.lastResults.length) {
    const choiceIndex = parseResultChoice(text);
    const choice = choiceIndex == null ? null : context.lastResults[choiceIndex];
    if (choice) {
      await showSelectedHome(psid, context, choice.homeId);
      return;
    }
  }

  let payloadAction = "";
  let payloadValue = "";
  if (payload) {
    const applied = applyPayload(payload, context);
    payloadAction = applied.action;
    payloadValue = applied.value;
    context = applied.context;
  } else if (!availabilityIntent) {
    context = mergeParsedContext(text, context, state);
  }

  if (payloadAction === "CHANGE") {
    if (payloadValue === "DATE") {
      context.dateKey = null;
      context.startMinute = null;
      context.checkoutMinute = null;
    }
    if (payloadValue === "TIME") {
      context.startMinute = null;
      context.checkoutMinute = null;
    }
    if (payloadValue === "DURATION") {
      context.durationHours = null;
      context.checkoutMinute = context.startMinute == null ? context.checkoutMinute : null;
    }
    context.timeConflict = null;
    context.timeAmbiguity = null;
    context.unsupportedDurationHours = null;
    context.preferredHomeId = "";
    context.selectedHome = null;
    context.lastResults = [];
  }

  if (payloadAction === "ALT") {
    const [, homeId, minute] = String(payload).split("|");
    context.preferredHomeId = homeId;
    context.startMinute = Number(minute);
    await showAvailability(psid, context);
    return;
  }

  if (payloadAction === "HOME") {
    await showSelectedHome(psid, context, payloadValue);
    return;
  }

  if (payloadAction === "HOLD") {
    await requestPhone(psid, context);
    return;
  }

  if (state === "awaiting_phone") {
    const phone = context.phone || parsePhone(text);
    if (!phone) {
      await replyAndLog(psid, "Số điện thoại chưa đúng định dạng. Bạn nhập lại giúp mình, ví dụ 0902932808 nhé.");
      return;
    }

    context.phone = phone;
    await saveConversation(psid, { state: "lead_created", context });
    await saveLead(psid, {
      status: "new",
      phone,
      dateKey: context.dateKey,
      startMinute: context.startMinute,
      durationHours: context.durationHours,
      guestCount: context.guestCount || config.standardGuests,
      selectedHomeId: context.preferredHomeId,
      selectedHomeName: context.selectedHome?.displayName || "",
      afterHours: isAfterHours()
    });
    await safeNotifyOwner(psid, {
      type: "lead_with_phone",
      priority: "high",
      title: isAfterHours() ? "Lead đặt phòng ngoài giờ có SĐT" : "Lead đặt phòng có SĐT",
      message: `Khách đã để lại số ${phone} để xác nhận booking.`,
      context: alertContext(context),
      afterHours: isAfterHours(),
      forceExternal: true
    });
    await replyAndLog(
      psid,
      `Mình đã ghi nhận số ${phone}. Nhân viên sẽ kiểm tra lần cuối và phản hồi ${isAfterHours() ? `từ ${afterHoursResumeLabel()}` : "ngay"} trong Messenger. Lịch chỉ được khóa sau khi xác nhận thanh toán.${config.overnightIdRequired && isOvernightDuration(context.durationHours) ? " Gói qua đêm cần gửi CCCD để xác nhận thông tin nhận phòng." : ""}`
    );
    return;
  }

  if (!payload && !availabilityIntent) {
    if (await answerStayTimeQuestion(psid, text, context, state)) return;

    const faqIntent = detectFaqIntent(text);
    if (faqIntent && await answerFaq(psid, faqIntent, context, text)) return;

    if (detectGreeting(text) || (state === "new" && !text.trim())) {
      await welcome(psid);
      return;
    }

    const canUseScopedGemini = !parsedDate
      && parsedTime == null
      && !parsedDuration
      && !extractAmenities(text).length
      && !context.timeAmbiguity
      && !context.timeConflict
      && context.unsupportedDurationHours == null;

    if (canUseScopedGemini) {
      const scopedAnswer = await answerScopedQuestionWithGemini({
        userMessage: text,
        conversationContext: {
          dateKey: context.dateKey,
          durationHours: context.durationHours,
          preferredHomeId: context.preferredHomeId,
          selectedHomeId: context.selectedHome?.homeId || "",
          selectedHomeName: context.selectedHome?.displayName || ""
        }
      });

      if (scopedAnswer.handled && scopedAnswer.reply) {
        await replyAndLog(psid, scopedAnswer.reply, HELP_REPLIES);
        return;
      }
    }

    // Allow typing HOME1/HOME 2 instead of pressing the quick reply.
    const typedHome = parseHomeReference(text);
    if (typedHome && context.lastResults.length) {
      const match = context.lastResults.find(item => {
        const candidates = [item.homeId, item.routeName, item.displayName]
          .map(value => normalizeVietnamese(value).replace(/[^a-z0-9]/g, ""));
        return candidates.includes(normalizeVietnamese(typedHome).replace(/[^a-z0-9]/g, ""));
      });
      if (match) {
        await showSelectedHome(psid, context, match.homeId);
        return;
      }
    }

    if (
      state === "new"
      && !parsedDate
      && parsedTime == null
      && !parsedDuration
      && !extractAmenities(text).length
      && !context.timeAmbiguity
      && !context.timeConflict
      && context.unsupportedDurationHours == null
    ) {
      await replyAndLog(
        psid,
        chooseCopy([
          "HOME hỗ trợ lịch trống, giá, tiện ích, đường đi, thông tin lưu trú và đặt phòng. Bạn muốn HOME kiểm tra nội dung nào?",
          "HOME chưa xác định rõ nội dung Bạn cần hỗ trợ. Bạn có thể gửi ngày, giờ và thời lượng lưu trú, hoặc chọn một mục bên dưới.",
          "Bạn cần kiểm tra lịch, giá, hình phòng hay gặp nhân viên? HOME sẽ hỗ trợ theo đúng thông tin trên hệ thống."
        ]),
        HELP_REPLIES
      );
      return;
    }
  }

  const missingHandled = await askNextMissing(psid, context);
  if (missingHandled) return;

  await sendTyping(psid, true).catch(() => {});
  try {
    await showAvailability(psid, context);
  } finally {
    await sendTyping(psid, false).catch(() => {});
  }
}

/**
 * Mỗi webhook Messenger được bọc trong AsyncLocalStorage để Gemini biết
 * tin nhắn khách hiện tại mà không dùng biến global (an toàn khi nhiều khách
 * nhắn đồng thời). Logic lịch, giá và booking cũ vẫn chạy trước; Gemini chỉ
 * viết lại câu trả lời cuối cùng.
 */
export async function handleConversationEvent(event) {
  return runWithGeminiMessageContext(
    {
      psid: event?.psid || "",
      userMessage: event?.text || "",
      payload: event?.payload || "",
      rewriteCount: 0
    },
    () => handleConversationEventInternal(event || {})
  );
}

export const __conversationTest = {
  cleanContext,
  detectAvailabilityRequest,
  freshSearchContext,
  mergeParsedContext,
  parseHomeReference,
  parseResultChoice,
  detectMoreOptions,
  detectThanks,
  detectUrgentRequest,
  detectFaqIntent,
  parseGuestCount
};

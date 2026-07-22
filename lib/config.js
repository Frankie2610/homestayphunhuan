function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export const config = {
  timezone: process.env.BOT_TIMEZONE || "Asia/Ho_Chi_Minh",
  brandName: process.env.BOT_BRAND_NAME || "Homestay Quận Phú Nhuận",
  siteUrl: (process.env.PUBLIC_SITE_URL || "https://homestayphunhuan.vercel.app").replace(/\/$/, ""),
  supportPhone: process.env.BOT_SUPPORT_PHONE || "0933882896",
  homeAddress: process.env.BOT_HOME_ADDRESS || "Quận Phú Nhuận, TP.HCM",
  mapUrl: process.env.BOT_MAP_URL || "https://www.google.com/maps/search/?api=1&query=Qu%E1%BA%ADn+Ph%C3%BA+Nhu%E1%BA%ADn%2C+TP.HCM",
  standardGuests: envNumber("BOT_STANDARD_GUESTS", 2),
  extraGuestFee: envNumber("BOT_EXTRA_GUEST_FEE", 50_000),
  overnightIdRequired: envBoolean("BOT_OVERNIGHT_ID_REQUIRED", true),
  graphVersion: process.env.META_GRAPH_VERSION || "v25.0",
  metaAppId: process.env.META_APP_ID || "",
  cleaningBeforeMinutes: envNumber("BOT_CLEANING_BEFORE_MINUTES", 60),
  cleaningAfterMinutes: envNumber("BOT_CLEANING_AFTER_MINUTES", 60),
  dayEndMinute: envNumber("BOT_DAY_END_MINUTE", 23 * 60),
  slotStepMinutes: envNumber("BOT_SLOT_STEP_MINUTES", 30),
  conversationWindowMs: 24 * 60 * 60 * 1000,
  conversationTtlMs: 30 * 24 * 60 * 60 * 1000,
  afterHoursStartMinute: envNumber("BOT_AFTER_HOURS_START_MINUTE", 23 * 60),
  afterHoursEndMinute: envNumber("BOT_AFTER_HOURS_END_MINUTE", 8 * 60),
  notifyAllAfterHours: envBoolean("BOT_NOTIFY_ALL_AFTER_HOURS", true),
  ownerAlertCooldownMs: envNumber("BOT_OWNER_ALERT_COOLDOWN_MINUTES", 15) * 60 * 1000,
  telegramBotToken: process.env.BOT_TELEGRAM_TOKEN || "",
  telegramChatId: process.env.BOT_TELEGRAM_CHAT_ID || "",

  // Gemini chỉ là lớp viết lại câu trả lời. Khi tắt, thiếu key, hết quota
  // hoặc timeout, bot sẽ tự động dùng câu trả lời gốc.
  geminiEnabled: envBoolean("GEMINI_ENABLED", true),
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
  geminiMaxOutputTokens: envNumber("GEMINI_MAX_OUTPUT_TOKENS", 180),
  geminiTemperature: envNumber("GEMINI_TEMPERATURE", 0.3),
  geminiTimeoutMs: envNumber("GEMINI_TIMEOUT_MS", 5_000),
  geminiMaxRewritesPerMessage: envNumber("GEMINI_MAX_REWRITES_PER_MESSAGE", 1),
  geminiRewriteSensitive: envBoolean("GEMINI_REWRITE_SENSITIVE", false),
  geminiScopedTopicsEnabled: envBoolean("GEMINI_SCOPED_TOPICS_ENABLED", true),
  geminiFootballEnabled: envBoolean("GEMINI_FOOTBALL_ENABLED", true),

  // Website chat waits synchronously for a response, unlike Messenger webhook
  // which acknowledges Meta immediately and continues in the background.
  // Fast mode skips the optional Gemini rewrite and uses an in-memory session
  // cache so common FAQ/availability replies return much sooner.
  webChatFastMode: envBoolean("WEB_CHAT_FAST_MODE", true),
  webChatGeminiRewrite: envBoolean("WEB_CHAT_GEMINI_REWRITE", true),
  webChatCacheTtlMs: envNumber("WEB_CHAT_CACHE_TTL_MS", 10 * 60 * 1000),
  webChatDataCacheTtlMs: envNumber("WEB_CHAT_DATA_CACHE_TTL_MS", 15_000),
  webChatFirebaseReadTimeoutMs: envNumber("WEB_CHAT_FIREBASE_READ_TIMEOUT_MS", 8_000),
  localChatServer: envBoolean("LOCAL_CHAT_SERVER", false)
};

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}`);
  return value;
}

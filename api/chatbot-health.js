import {
  getAdminDatabase,
  getFirebaseAdminAccessToken,
  getFirebaseAdminEnvironmentStatus
} from "../lib/firebase-admin.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function timeoutAfter(ms, code = "FIREBASE_HEALTH_TIMEOUT", message = "Firebase health check quá thời gian") {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.code = code;
      reject(error);
    }, ms);
    timer.unref?.();
  });
}

async function withStageTimeout(promise, ms, code, message) {
  return Promise.race([promise, timeoutAfter(ms, code, message)]);
}

export async function GET(request) {
  const secret = process.env.BOT_HEALTH_SECRET || "";
  const provided = new URL(request.url).searchParams.get("secret") || "";
  if (secret && provided !== secret) return json({ ok: false, error: "forbidden" }, 403);

  let environment = null;
  let stage = "environment";
  const timings = {};
  const startedAt = Date.now();

  try {
    environment = getFirebaseAdminEnvironmentStatus();
    timings.environmentMs = Date.now() - startedAt;

    stage = "access_token";
    const tokenStartedAt = Date.now();
    const token = await withStageTimeout(
      getFirebaseAdminAccessToken(),
      8_000,
      "FIREBASE_ACCESS_TOKEN_TIMEOUT",
      "Không lấy được Firebase Admin access token trong thời gian cho phép"
    );
    timings.accessTokenMs = Date.now() - tokenStartedAt;

    stage = "rest_probe";
    const restStartedAt = Date.now();
    const databaseURL = `https://${environment.databaseHost}`;
    const restResponse = await fetch(`${databaseURL}/.json?shallow=true`, {
      headers: {
        "authorization": `Bearer ${token.access_token}`,
        "accept": "application/json"
      },
      signal: AbortSignal.timeout(8_000)
    });
    const restPayload = await restResponse.json().catch(() => ({}));
    if (!restResponse.ok) {
      const error = new Error(restPayload?.error || `Firebase REST trả HTTP ${restResponse.status}`);
      error.code = `FIREBASE_REST_HTTP_${restResponse.status}`;
      throw error;
    }
    timings.restProbeMs = Date.now() - restStartedAt;

    stage = "admin_sdk_read";
    const sdkStartedAt = Date.now();
    const db = getAdminDatabase();
    const [snap, pricingSnap, settingsSnap] = await withStageTimeout(
      Promise.all([
        db.ref("homes").limitToFirst(1).get(),
        db.ref("roomPricing").limitToFirst(1).get(),
        db.ref("messengerBot/settings").get()
      ]),
      8_000,
      "FIREBASE_ADMIN_SDK_TIMEOUT",
      "Firebase Admin SDK đọc dữ liệu quá thời gian"
    );
    timings.adminSdkReadMs = Date.now() - sdkStartedAt;
    timings.totalMs = Date.now() - startedAt;
    const settings = settingsSnap.val() || {};
    return json({
      ok: true,
      firebase: true,
      environment,
      stage: "complete",
      timings,
      restProbe: true,
      adminSdkRead: true,
      homesConfigured: snap.exists(),
      roomPricingConfigured: pricingSnap.exists(),
      pricingReadsLiveFromFirebase: true,
      lateCheckoutStepMinutes: 30,
      standardGuests: Number(process.env.BOT_STANDARD_GUESTS || 2),
      extraGuestFee: Number(process.env.BOT_EXTRA_GUEST_FEE || 50000),
      overnightIdRequired: String(process.env.BOT_OVERNIGHT_ID_REQUIRED || "true").toLowerCase() !== "false",
      metaConfigured: Boolean(process.env.META_PAGE_ACCESS_TOKEN && process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN),
      metaAppIdConfigured: Boolean(process.env.META_APP_ID),
      ownerNotificationConfigured: Boolean(process.env.BOT_TELEGRAM_TOKEN && process.env.BOT_TELEGRAM_CHAT_ID),
      urgentAlertsStoredInFirebase: true,
      adminBrowserNotificationsSupported: true,
      supportedCombos: [2, 3, 4, 7, 9, 12, 14, 22],
      afterHoursConfigured: true,
      conversationControlSupported: true,
      autoPauseOnHumanReply: settings.autoPauseOnHumanReply !== false,
      defaultControlMode: settings.defaultMode === "human" ? "human" : "bot",
      timestamp: Date.now()
    });
  } catch (error) {
    return json({
      ok: false,
      firebase: false,
      stage,
      environment,
      timings: {
        ...timings,
        totalMs: Date.now() - startedAt
      },
      code: error?.code || "FIREBASE_HEALTH_FAILED",
      error: error?.message || "Firebase health check failed"
    }, 500);
  }
}

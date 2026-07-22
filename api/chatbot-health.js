import { getAdminDatabase } from "../lib/firebase-admin.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export async function GET(request) {
  const secret = process.env.BOT_HEALTH_SECRET || "";
  const provided = new URL(request.url).searchParams.get("secret") || "";
  if (secret && provided !== secret) return json({ ok: false, error: "forbidden" }, 403);

  try {
    const db = getAdminDatabase();
    const [snap, pricingSnap, settingsSnap] = await Promise.all([
      db.ref("homes").limitToFirst(1).get(),
      db.ref("roomPricing").limitToFirst(1).get(),
      db.ref("messengerBot/settings").get()
    ]);
    const settings = settingsSnap.val() || {};
    return json({
      ok: true,
      firebase: true,
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
    return json({ ok: false, firebase: false, error: error.message }, 500);
  }
}

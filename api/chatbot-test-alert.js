import { notifyOwner } from "../lib/owner-notifier.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export async function GET(request) {
  const secret = process.env.BOT_HEALTH_SECRET || "";
  const provided = new URL(request.url).searchParams.get("secret") || "";
  if (!secret || provided !== secret) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const result = await notifyOwner("health-test", {
    type: "test_alert",
    priority: "high",
    title: "Test cảnh báo chatbot",
    message: "Nếu thấy tin này trên Telegram thì cảnh báo ngoài giờ đã hoạt động.",
    context: {},
    afterHours: true,
    forceExternal: true
  });

  return json({
    ok: true,
    alertStored: Boolean(result?.alert?.id),
    external: result?.external || null,
    timestamp: Date.now()
  });
}

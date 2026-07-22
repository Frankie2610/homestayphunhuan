import { diagnoseAvailability, extractAmenities } from "../lib/availability.js";
import { parseTimeFromText } from "../lib/date-time.js";
import { requireEnv } from "../lib/config.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function parseTimeParam(value) {
  if (value == null || value === "") return null;
  if (/^\d+$/.test(value)) return Number(value);
  return parseTimeFromText(value);
}

export async function GET(request) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";
  if (secret !== requireEnv("BOT_HEALTH_SECRET")) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const dateKey = url.searchParams.get("date") || "";
  const startMinute = parseTimeParam(url.searchParams.get("time"));
  const durationHours = Number(url.searchParams.get("duration"));
  const preferredHomeId = url.searchParams.get("home") || "";
  const amenityText = url.searchParams.get("amenities") || "";
  const amenities = extractAmenities(amenityText);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !Number.isFinite(startMinute) || !Number.isFinite(durationHours)) {
    return json({
      ok: false,
      error: "invalid_params",
      example: "/api/chatbot-debug-availability?secret=...&date=2026-07-11&time=13:00&duration=4"
    }, 400);
  }

  try {
    const diagnostics = await diagnoseAvailability({
      dateKey,
      startMinute,
      durationHours,
      amenities,
      preferredHomeId
    });
    return json({ ok: true, diagnostics });
  } catch (error) {
    console.error("Availability diagnostics error:", error);
    return json({ ok: false, error: error?.message || "unknown_error" }, 500);
  }
}

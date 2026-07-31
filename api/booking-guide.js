import {
  loadBusinessProfile,
  resolveBranchForBooking,
  sanitizeBranchGuide,
  verifyPaidBookingProof
} from "../lib/business-profile.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store, max-age=0"
    }
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "INVALID_JSON" }, 400);
  }

  try {
    const verified = await verifyPaidBookingProof(body || {});
    if (!verified.ok) return json({ ok: false, message: verified.message }, verified.status);
    const profile = await loadBusinessProfile();
    const branch = await resolveBranchForBooking(verified.booking, profile);
    const guide = sanitizeBranchGuide(branch);
    if (!guide) return json({ ok: false, message: "BRANCH_GUIDE_NOT_CONFIGURED" }, 404);
    return json({
      ok: true,
      guide,
      booking: {
        room: String(verified.booking?.room || verified.booking?.roomCode || ""),
        checkin: verified.booking?.checkin || "",
        checkout: verified.booking?.checkout || ""
      }
    });
  } catch (error) {
    console.error("booking-guide error:", error);
    return json({ ok: false, message: "BOOKING_GUIDE_UNAVAILABLE" }, 503);
  }
}

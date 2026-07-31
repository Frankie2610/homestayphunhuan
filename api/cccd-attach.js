import { attachCccdImages } from "../lib/cccd-storage.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await attachCccdImages({
      bookingPath: body.bookingPath,
      orderCode: body.orderCode,
      phoneLast4: body.phoneLast4,
      attachToken: body.attachToken,
      images: body.images
    });
    return json({ ok: true, ...result });
  } catch (error) {
    return json({
      ok: false,
      error: String(error?.message || error || "cccd_attach_failed")
    }, Number(error?.status || 500));
  }
}

export async function GET() {
  return json({ ok: false, error: "method_not_allowed" }, 405);
}

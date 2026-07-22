import crypto from "node:crypto";

export function verifyMetaSignature(rawBody, headerValue, appSecret) {
  if (!appSecret || !headerValue || !headerValue.startsWith("sha256=")) return false;

  const received = headerValue.slice("sha256=".length);
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const a = Buffer.from(received, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

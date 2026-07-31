import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAdminDatabase } from "./firebase-admin.js";
import { requireEnv } from "./config.js";

const MAX_CCCD_IMAGES = 20;
const BOOKING_PATH_RE = /^bookingsByMonth\/(20\d{2})\/(0[1-9]|1[0-2])\/([A-Za-z0-9_-]{1,180})$/;

function text(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function cloudinaryConfig() {
  return {
    cloudName: requireEnv("CLOUDINARY_CLOUD_NAME"),
    apiKey: requireEnv("CLOUDINARY_API_KEY"),
    apiSecret: requireEnv("CLOUDINARY_API_SECRET")
  };
}

function signableValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export function signCloudinaryParams(params, apiSecret = cloudinaryConfig().apiSecret) {
  const payload = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${signableValue(value)}`)
    .join("&");
  return createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

export function parseBookingPath(value) {
  const bookingPath = text(value, 320).replace(/^\/+|\/+$/g, "");
  const match = bookingPath.match(BOOKING_PATH_RE);
  if (!match) {
    const error = new Error("invalid_booking_path");
    error.status = 400;
    throw error;
  }
  return {
    bookingPath,
    year: match[1],
    month: match[2],
    bookingKey: match[3]
  };
}

function bookingPhoneLast4(booking = {}) {
  const candidates = [
    booking.phone,
    booking.customerPhone,
    booking.phoneNumber,
    booking.customer?.phone,
    booking.contact?.phone
  ];
  for (const candidate of candidates) {
    const value = digits(candidate);
    if (value.length >= 4) return value.slice(-4);
  }
  return "";
}

export async function verifyBookingOwner({ bookingPath, orderCode, phoneLast4 }) {
  const parsed = parseBookingPath(bookingPath);
  const snapshot = await getAdminDatabase().ref(parsed.bookingPath).get();
  if (!snapshot.exists()) {
    const error = new Error("booking_not_found");
    error.status = 404;
    throw error;
  }

  const booking = snapshot.val() || {};
  const expectedOrder = text(booking.orderCode || booking.paymentOrderCode, 100);
  const suppliedOrder = text(orderCode, 100);
  if (!expectedOrder || !suppliedOrder || expectedOrder !== suppliedOrder) {
    const error = new Error("booking_verification_failed");
    error.status = 403;
    throw error;
  }

  const expectedLast4 = bookingPhoneLast4(booking);
  const suppliedLast4 = digits(phoneLast4).slice(-4);
  if (expectedLast4 && expectedLast4 !== suppliedLast4) {
    const error = new Error("booking_verification_failed");
    error.status = 403;
    throw error;
  }

  return { ...parsed, booking };
}

function attachSecret() {
  return process.env.CCCD_ATTACH_SECRET || cloudinaryConfig().apiSecret;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signAttachPayload(encoded) {
  return createHmac("sha256", attachSecret()).update(encoded).digest("base64url");
}

export function createAttachToken(payload) {
  const encoded = base64urlJson(payload);
  return `${encoded}.${signAttachPayload(encoded)}`;
}

export function verifyAttachToken(token) {
  const [encoded, signature] = text(token, 10000).split(".");
  if (!encoded || !signature) {
    const error = new Error("invalid_attach_token");
    error.status = 403;
    throw error;
  }

  const expected = Buffer.from(signAttachPayload(encoded));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    const error = new Error("invalid_attach_token");
    error.status = 403;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    const error = new Error("invalid_attach_token");
    error.status = 403;
    throw error;
  }

  if (!payload?.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    const error = new Error("attach_token_expired");
    error.status = 403;
    throw error;
  }
  return payload;
}

export async function createCccdUploadBatch({ bookingPath, orderCode, phoneLast4, count }) {
  const verified = await verifyBookingOwner({ bookingPath, orderCode, phoneLast4 });
  const requestedCount = Number(count);
  const existingCount = verified.booking?.cccdImages && typeof verified.booking.cccdImages === "object"
    ? Object.keys(verified.booking.cccdImages).length
    : Math.max(0, Number(verified.booking?.cccdImageCount || 0));
  const remainingCount = Math.max(0, MAX_CCCD_IMAGES - existingCount);

  if (
    !Number.isInteger(requestedCount) ||
    requestedCount < 1 ||
    requestedCount > remainingCount
  ) {
    const error = new Error(remainingCount > 0 ? "invalid_image_count" : "cccd_image_limit_reached");
    error.status = 400;
    throw error;
  }
  const safeCount = requestedCount;

  const { cloudName, apiKey, apiSecret } = cloudinaryConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `homestay-phu-nhuan/cccd/${verified.year}/${verified.month}/${verified.bookingKey}`;
  const items = Array.from({ length: safeCount }, () => {
    const publicId = `${folder}/${timestamp}_${randomBytes(8).toString("hex")}`;
    const params = {
      public_id: publicId,
      timestamp,
      type: "authenticated",
      overwrite: false,
      unique_filename: false
    };
    return {
      publicId,
      signature: signCloudinaryParams(params, apiSecret)
    };
  });

  const attachToken = createAttachToken({
    bookingPath: verified.bookingPath,
    orderCode: text(orderCode, 100),
    publicIds: items.map(item => item.publicId),
    exp: timestamp + 15 * 60
  });

  return {
    cloudName,
    apiKey,
    timestamp,
    folder,
    type: "authenticated",
    overwrite: false,
    uniqueFilename: false,
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    items,
    attachToken
  };
}

function safeImageRecord(image, allowedPublicIds) {
  const publicId = text(image?.publicId || image?.public_id, 500);
  if (!allowedPublicIds.has(publicId)) {
    const error = new Error("invalid_uploaded_asset");
    error.status = 400;
    throw error;
  }

  const assetId = text(image?.assetId || image?.asset_id, 180);
  const format = text(image?.format, 20).toLowerCase();
  const allowedFormats = new Set(["jpg", "jpeg", "png", "webp", "avif"]);
  if (!assetId || !allowedFormats.has(format)) {
    const error = new Error("invalid_uploaded_asset");
    error.status = 400;
    throw error;
  }

  return {
    assetId,
    publicId,
    version: Math.max(0, Number(image?.version || 0)),
    format,
    width: Math.max(0, Number(image?.width || 0)),
    height: Math.max(0, Number(image?.height || 0)),
    bytes: Math.max(0, Number(image?.bytes || 0)),
    resourceType: "image",
    deliveryType: "authenticated",
    uploadedAt: Date.now()
  };
}

function imageRecordKey(record) {
  return createHash("sha256").update(record.assetId || record.publicId).digest("hex").slice(0, 24);
}

export async function attachCccdImages({ bookingPath, orderCode, phoneLast4, attachToken, images }) {
  const verified = await verifyBookingOwner({ bookingPath, orderCode, phoneLast4 });
  const token = verifyAttachToken(attachToken);
  if (token.bookingPath !== verified.bookingPath || token.orderCode !== text(orderCode, 100)) {
    const error = new Error("invalid_attach_token");
    error.status = 403;
    throw error;
  }

  const rawImages = Array.isArray(images) ? images.slice(0, MAX_CCCD_IMAGES) : [];
  if (!rawImages.length) {
    const error = new Error("no_uploaded_images");
    error.status = 400;
    throw error;
  }

  const allowedPublicIds = new Set(Array.isArray(token.publicIds) ? token.publicIds : []);
  const records = rawImages.map(image => safeImageRecord(image, allowedPublicIds));
  const uniqueRecords = new Map(records.map(record => [record.publicId, record]));
  if (uniqueRecords.size !== records.length || records.length > allowedPublicIds.size) {
    const error = new Error("invalid_uploaded_asset");
    error.status = 400;
    throw error;
  }

  const existingCount = verified.booking?.cccdImages && typeof verified.booking.cccdImages === "object"
    ? Object.keys(verified.booking.cccdImages).length
    : Math.max(0, Number(verified.booking?.cccdImageCount || 0));
  if (existingCount + records.length > MAX_CCCD_IMAGES) {
    const error = new Error("cccd_image_limit_reached");
    error.status = 400;
    throw error;
  }

  const bookingRef = getAdminDatabase().ref(verified.bookingPath);
  const now = Date.now();

  await bookingRef.transaction(current => {
    if (!current || typeof current !== "object") return current;
    const existing = current.cccdImages && typeof current.cccdImages === "object"
      ? { ...current.cccdImages }
      : {};
    records.forEach(record => {
      existing[imageRecordKey(record)] = record;
    });
    return {
      ...current,
      cccdOptional: false,
      cccdRequired: true,
      cccdStatus: "provided",
      cccdStorage: "cloudinary_authenticated",
      cccdImages: existing,
      cccdImageCount: Object.keys(existing).length,
      cccdProvidedAt: current.cccdProvidedAt || now,
      cccdUpdatedAt: now,
      cccdRequirementReason: "stay_between_00_00_and_06_00",
      cccdNoticeVersion: "2026-07-31"
    };
  });

  return {
    bookingPath: verified.bookingPath,
    attached: records.length,
    status: "provided"
  };
}

export async function updateCccdBookingStatus({ bookingPath, orderCode, phoneLast4, status }) {
  const verified = await verifyBookingOwner({ bookingPath, orderCode, phoneLast4 });
  const allowed = new Set(["not_provided", "upload_failed"]);
  const normalizedStatus = text(status, 40);
  if (!allowed.has(normalizedStatus)) {
    const error = new Error("invalid_cccd_status");
    error.status = 400;
    throw error;
  }

  const now = Date.now();
  const bookingRef = getAdminDatabase().ref(verified.bookingPath);
  let effectiveStatus = normalizedStatus;
  await bookingRef.transaction(current => {
    if (!current || typeof current !== "object") return current;
    const existingImages = current.cccdImages && typeof current.cccdImages === "object"
      ? current.cccdImages
      : {};
    const existingCount = Object.keys(existingImages).length || Math.max(0, Number(current.cccdImageCount || 0));

    // Không cho request trạng thái đến trễ ghi đè một booking đã có ảnh.
    if (existingCount > 0 || current.cccdStatus === "provided") {
      effectiveStatus = "provided";
      return {
        ...current,
        cccdOptional: false,
        cccdRequired: true,
        cccdStatus: "provided",
        cccdStorage: "cloudinary_authenticated",
        cccdImageCount: existingCount,
        cccdRequirementReason: "stay_between_00_00_and_06_00",
        cccdNoticeVersion: "2026-07-31",
        cccdUpdatedAt: now
      };
    }

    return {
      ...current,
      cccdOptional: false,
      cccdRequired: true,
      cccdStatus: normalizedStatus,
      cccdStorage: "cloudinary_authenticated",
      cccdImageCount: existingCount,
      cccdRequirementReason: "stay_between_00_00_and_06_00",
      cccdNoticeVersion: "2026-07-31",
      cccdUpdatedAt: now
    };
  });
  return { bookingPath: verified.bookingPath, status: effectiveStatus };
}

export function createPrivateDownloadUrl(record, expiresInSeconds = 600) {
  const { cloudName, apiKey, apiSecret } = cloudinaryConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const expiresAt = timestamp + Math.max(60, Math.min(3600, Number(expiresInSeconds || 600)));
  const params = {
    timestamp,
    public_id: text(record?.publicId, 500),
    format: text(record?.format, 20),
    type: "authenticated",
    expires_at: expiresAt
  };
  const signature = signCloudinaryParams(params, apiSecret);
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    signature,
    api_key: apiKey
  });
  return {
    url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/download?${query.toString()}`,
    expiresAt: expiresAt * 1000
  };
}

export async function getAdminCccdImages(bookingPath) {
  const parsed = parseBookingPath(bookingPath);
  const snapshot = await getAdminDatabase().ref(parsed.bookingPath).get();
  if (!snapshot.exists()) {
    const error = new Error("booking_not_found");
    error.status = 404;
    throw error;
  }
  const booking = snapshot.val() || {};
  const records = booking.cccdImages && typeof booking.cccdImages === "object"
    ? Object.entries(booking.cccdImages)
    : [];
  return records.map(([id, record]) => ({
    id,
    ...record,
    ...createPrivateDownloadUrl(record, 600)
  }));
}

export const __cccdStorageTest = {
  MAX_CCCD_IMAGES,
  BOOKING_PATH_RE,
  bookingPhoneLast4,
  imageRecordKey
};

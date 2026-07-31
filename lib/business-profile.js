import { createHash } from "node:crypto";
import { getAdminDatabase } from "./firebase-admin.js";
import { config } from "./config.js";

const BUSINESS_PROFILE_PATH = "businessProfile";
let businessProfileCache = { value: null, expiresAt: 0, pending: null };
let homesBranchCache = { value: null, expiresAt: 0, pending: null };
const BOOKING_PATH_RE = /^bookingsByMonth\/(\d{4})\/(0[1-9]|1[0-2])\/([A-Za-z0-9_-]+)$/;

function text(value) {
  return String(value ?? "").trim();
}

function digits(value) {
  return text(value).replace(/\D/g, "");
}

function safeKey(value) {
  return text(value).replace(/[.#$\/\[\]]/g, "_");
}

function safeHttpsUrl(value) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizePhone(value) {
  let phone = digits(value);
  if (phone.startsWith("84") && phone.length >= 11) phone = `0${phone.slice(2)}`;
  return phone;
}

function normalizeStatus(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeWords(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Chỉ coi đây là xác nhận thanh toán khi chính nhân viên Page gửi một câu
 * khẳng định rõ ràng. Các câu phủ định như “chưa nhận được thanh toán” không
 * được phép mở quyền gửi ảnh/video hướng dẫn.
 */
export function isStaffPaymentConfirmationText(value) {
  const normalized = normalizeWords(value);
  if (!normalized) return false;

  const hasPaymentWords = /\b(thanh toan|chuyen khoan|nhan tien|da nhan tien|payment)\b/.test(normalized);
  if (!hasPaymentWords) return false;

  const negative = /\b(chua|khong|chua thay|chua nhan|khong nhan|dang cho|cho thanh toan|thanh toan sau|chua vao tien|khong thay tien)\b/.test(normalized);
  if (negative) return false;

  return /\b(da thanh toan|thanh toan thanh cong|xac nhan thanh toan|xac nhan da thanh toan|da nhan thanh toan|da nhan duoc thanh toan|da nhan chuyen khoan|da nhan duoc chuyen khoan|da nhan tien|da nhan duoc tien|payment confirmed|payment success)\b/.test(normalized);
}

export async function recordStaffPaymentConfirmation(psid, {
  text: confirmationText = "",
  actorName = "Nhân viên Page"
} = {}) {
  const key = safeKey(psid);
  const now = Date.now();
  const db = getAdminDatabase();
  const claimRef = db.ref(`messengerBot/staffPaymentConfirmations/${key}`);
  const transaction = await claimRef.transaction(current => {
    if (current?.confirmedAt) return;
    return {
      confirmedAt: now,
      confirmedBy: text(actorName).slice(0, 120),
      confirmationText: text(confirmationText).slice(0, 500)
    };
  }, undefined, false);

  const claimed = transaction.committed === true;
  const value = transaction.snapshot?.val() || {};
  const confirmedAt = Number(value.confirmedAt || now);
  const confirmedBy = text(value.confirmedBy || actorName);

  if (claimed) {
    await db.ref().update({
      [`messengerBot/conversations/${key}/staffPaymentConfirmedAt`]: confirmedAt,
      [`messengerBot/conversations/${key}/staffPaymentConfirmedBy`]: confirmedBy.slice(0, 120),
      [`messengerBot/conversations/${key}/staffPaymentConfirmationText`]: text(confirmationText).slice(0, 500),
      [`messengerBot/conversations/${key}/state`]: "payment_confirmed_by_staff",
      [`messengerBot/conversations/${key}/updatedAt`]: now,
      [`messengerBot/leads/${key}/paymentStatus`]: "staff_confirmed",
      [`messengerBot/leads/${key}/status`]: "payment_confirmed",
      [`messengerBot/leads/${key}/paymentConfirmedAt`]: confirmedAt,
      [`messengerBot/leads/${key}/paymentConfirmedBy`]: confirmedBy.slice(0, 120),
      [`messengerBot/leads/${key}/updatedAt`]: now
    });
  }

  return {
    confirmedAt,
    confirmedBy,
    confirmationText: text(value.confirmationText || confirmationText),
    alreadyConfirmed: !claimed
  };
}

function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isPaidBooking(booking = {}) {
  const statuses = [
    booking.paymentStatus,
    booking.payment?.status,
    booking.payosStatus,
    booking.paymentResult?.status
  ].map(normalizeStatus).filter(Boolean);
  const paidStatuses = new Set([
    "paid",
    "da_thanh_toan",
    "payment_confirmed",
    "completed",
    "success",
    "successful"
  ]);
  const paidAmount = Number(
    booking.paidAmount
    ?? booking.payment?.paidAmount
    ?? booking.payment?.amount
    ?? 0
  );
  const expectedAmount = Number(
    booking.actualPrice
    ?? booking.totalAmount
    ?? booking.finalAmount
    ?? booking.amount
    ?? booking.price
    ?? 0
  );
  const hasVerifiedFullAmount = paidAmount > 0
    && expectedAmount > 0
    && paidAmount >= expectedAmount;

  return booking.paymentCompleted === true
    || statuses.some(status => paidStatuses.has(status))
    || Boolean(booking.transactionId)
    || hasVerifiedFullAmount
    || Boolean(booking.paidAt)
    || Boolean(booking.paymentConfirmedAt);
}

export function validateBookingPath(value) {
  const path = text(value).replace(/^\/+/, "").replace(/\/+$/, "");
  const match = path.match(BOOKING_PATH_RE);
  if (!match) return null;
  return { path, year: match[1], month: match[2], bookingKey: match[3] };
}

export function cloudinaryMp4Url(value) {
  const raw = safeHttpsUrl(value);
  if (!raw || !/res\.cloudinary\.com/i.test(raw) || !/\/video\/upload\//i.test(raw)) return raw;
  const [base, query = ""] = raw.split("?");
  const messengerTransform = "f_mp4,vc_h264,ac_aac,fl_progressive,q_auto:good";
  let transformed = base;
  if (!transformed.includes(`/video/upload/${messengerTransform}/`)) {
    transformed = transformed.replace(
      /\/video\/upload\//i,
      `/video/upload/${messengerTransform}/`
    );
  }
  transformed = transformed.replace(/\.[a-z0-9]{2,5}$/i, ".mp4");
  return query ? `${transformed}?${query}` : transformed;
}

export function cloudinaryPosterUrl(value) {
  const raw = safeHttpsUrl(value);
  if (!raw || !/res\.cloudinary\.com/i.test(raw) || !/\/video\/upload\//i.test(raw)) return "";
  return raw
    .split("?")[0]
    .replace(/\/video\/upload\//i, "/video/upload/so_0,f_jpg,q_auto,w_960/")
    .replace(/\.[a-z0-9]{2,5}$/i, ".jpg");
}

export async function loadBusinessProfile({ force = false } = {}) {
  const now = Date.now();
  if (!force && businessProfileCache.value && businessProfileCache.expiresAt > now) {
    return businessProfileCache.value;
  }
  if (!force && businessProfileCache.pending) return businessProfileCache.pending;

  businessProfileCache.pending = (async () => {
    const snapshot = await getAdminDatabase().ref(BUSINESS_PROFILE_PATH).get();
    const value = snapshot.exists() && snapshot.val() && typeof snapshot.val() === "object"
      ? snapshot.val()
      : {};
    const profile = {
      general: value.general && typeof value.general === "object" ? value.general : {},
      banking: value.banking && typeof value.banking === "object" ? value.banking : {},
      branches: value.branches && typeof value.branches === "object" ? value.branches : {}
    };
    businessProfileCache.value = profile;
    businessProfileCache.expiresAt = Date.now() + config.businessProfileCacheMs;
    return profile;
  })();

  try {
    return await businessProfileCache.pending;
  } finally {
    businessProfileCache.pending = null;
  }
}

async function loadHomesForBranchResolution() {
  const now = Date.now();
  if (homesBranchCache.value && homesBranchCache.expiresAt > now) return homesBranchCache.value;
  if (homesBranchCache.pending) return homesBranchCache.pending;

  homesBranchCache.pending = (async () => {
    const homesSnapshot = await getAdminDatabase().ref("homes").get();
    const homes = homesSnapshot.exists() && homesSnapshot.val() && typeof homesSnapshot.val() === "object"
      ? homesSnapshot.val()
      : {};
    homesBranchCache.value = homes;
    homesBranchCache.expiresAt = Date.now() + config.businessProfileCacheMs;
    return homes;
  })();

  try {
    return await homesBranchCache.pending;
  } finally {
    homesBranchCache.pending = null;
  }
}

function sortedBranchEntries(profile = {}) {
  const branches = profile.branches && typeof profile.branches === "object" ? profile.branches : {};
  const defaultId = text(profile.general?.defaultBranchId);
  return Object.entries(branches).sort(([idA, a], [idB, b]) => {
    if (idA === defaultId) return -1;
    if (idB === defaultId) return 1;
    const activeDiff = Number(b?.active !== false) - Number(a?.active !== false);
    if (activeDiff) return activeDiff;
    const createdDiff = Number(a?.createdAt || 0) - Number(b?.createdAt || 0);
    if (createdDiff) return createdDiff;
    return text(a?.name || idA).localeCompare(text(b?.name || idB), "vi", { numeric: true });
  });
}

export function getDefaultBranch(profile = {}) {
  const entries = sortedBranchEntries(profile);
  const defaultId = text(profile.general?.defaultBranchId);
  const selected = entries.find(([branchId]) => branchId === defaultId) || entries[0] || null;
  return selected ? { branchId: selected[0], ...(selected[1] || {}) } : null;
}

async function findHomeBranchId(booking = {}, profile = {}) {
  const directCandidates = [
    booking.branchId,
    booking.businessBranchId,
    booking.locationId,
    booking.propertyId,
    booking.branch
  ].map(text).filter(Boolean);
  for (const candidate of directCandidates) {
    if (profile.branches?.[candidate]) return candidate;
  }

  const homeReference = text(booking.homeId || booking.roomId || booking.room || booking.home || booking.roomCode);
  if (!homeReference) return "";
  const compactTarget = homeReference.toLowerCase().replace(/[^a-z0-9]/g, "");
  const homes = await loadHomesForBranchResolution();

  for (const [homeId, home] of Object.entries(homes)) {
    const values = [homeId, home?.homeId, home?.room, home?.roomCode, home?.displayName, home?.name]
      .map(item => text(item).toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (!values.includes(compactTarget)) continue;
    const branchId = text(home?.branchId || home?.businessBranchId || home?.locationId);
    if (branchId && profile.branches?.[branchId]) return branchId;
  }
  return "";
}

export async function resolveBranchForBooking(booking = {}, profile = null) {
  const resolvedProfile = profile || await loadBusinessProfile();
  const branchId = await findHomeBranchId(booking, resolvedProfile);
  if (branchId && resolvedProfile.branches?.[branchId]) {
    return { branchId, ...resolvedProfile.branches[branchId] };
  }
  return getDefaultBranch(resolvedProfile);
}

export function sanitizeBranchGuide(branch = null) {
  if (!branch) return null;
  return {
    branchId: text(branch.branchId),
    name: text(branch.name || "Cơ sở Homestay"),
    code: text(branch.code),
    phone: text(branch.phone),
    address: text(branch.address),
    mapsUrl: safeHttpsUrl(branch.mapsUrl),
    directionImageUrl: safeHttpsUrl(branch.directionImageUrl),
    checkinVideoUrl: cloudinaryMp4Url(branch.checkinVideoUrl),
    checkinVideoPosterUrl: cloudinaryPosterUrl(branch.checkinVideoUrl),
    checkoutVideoUrl: cloudinaryMp4Url(branch.checkoutVideoUrl),
    checkoutVideoPosterUrl: cloudinaryPosterUrl(branch.checkoutVideoUrl)
  };
}

function publicContactPhone(value = {}) {
  return text(
    value.phone
    || value.hotline
    || value.contactPhone
    || value.supportPhone
    || value.phoneNumber
    || value.telephone
    || value.mobile
    || value.mobilePhone
    || value.zaloPhone
    || value.contact?.phone
  );
}

function publicContactEmail(value = {}) {
  return text(
    value.email
    || value.contactEmail
    || value.supportEmail
    || value.emailAddress
    || value.contact?.email
  );
}

export function sanitizePublicBusinessProfile(profile = {}) {
  const general = profile.general || {};
  const activeBranches = sortedBranchEntries(profile)
    .filter(([, branch]) => branch?.active !== false)
    .map(([branchId, branch]) => ({
      branchId,
      name: text(branch?.name),
      code: text(branch?.code),
      phone: publicContactPhone(branch),
      address: text(branch?.address || branch?.fullAddress),
      mapsUrl: safeHttpsUrl(branch?.mapsUrl || branch?.mapUrl)
    }));
  const defaultId = text(general.defaultBranchId);
  const defaultBranch = activeBranches.find(branch => branch.branchId === defaultId) || activeBranches[0] || null;
  return {
    general: {
      businessName: text(general.businessName),
      phone: publicContactPhone(general),
      email: publicContactEmail(general),
      zaloUrl: safeHttpsUrl(general.zaloUrl),
      defaultBranchId: defaultId
    },
    defaultBranch,
    branches: activeBranches
  };
}

export function sanitizeBanking(profile = {}) {
  const banking = profile.banking || {};
  return {
    bankName: text(banking.bankName),
    accountHolder: text(banking.accountHolder),
    accountNumber: text(banking.accountNumber),
    transferContentPrefix: text(banking.transferContentPrefix),
    qrCodeUrl: safeHttpsUrl(banking.qrCodeUrl)
  };
}

function sha256(value) {
  return createHash("sha256").update(text(value)).digest("hex");
}

export async function verifyPaidBookingProof(body = {}) {
  const parsedPath = validateBookingPath(body.bookingPath);
  const orderCode = text(body.orderCode);
  const accessToken = text(body.accessToken || body.ttlockAccessToken);
  const phoneLast4 = digits(body.phoneLast4).slice(-4);
  if (!parsedPath || !orderCode) {
    return { ok: false, status: 400, message: "MISSING_OR_INVALID_BOOKING_PROOF" };
  }

  const bookingSnapshot = await getAdminDatabase().ref(parsedPath.path).get();
  const booking = bookingSnapshot.exists() ? bookingSnapshot.val() : null;
  if (!booking) return { ok: false, status: 404, message: "BOOKING_NOT_FOUND" };
  if (!isPaidBooking(booking)) return { ok: false, status: 409, message: "BOOKING_NOT_PAID" };
  if (text(booking.orderCode) !== orderCode) {
    return { ok: false, status: 403, message: "ORDER_CODE_MISMATCH" };
  }
  if (body.bookingKey && text(body.bookingKey) !== parsedPath.bookingKey) {
    return { ok: false, status: 403, message: "BOOKING_KEY_MISMATCH" };
  }

  const expectedHash = text(booking.ttlockAccessTokenHash);
  if (expectedHash) {
    if (!accessToken || sha256(accessToken) !== expectedHash) {
      return { ok: false, status: 403, message: "BOOKING_ACCESS_TOKEN_INVALID" };
    }
  } else {
    const bookingPhone = normalizePhone(booking.phone || booking.customerPhone || booking.phoneNumber);
    if (!phoneLast4 || phoneLast4.length !== 4 || !bookingPhone.endsWith(phoneLast4)) {
      return { ok: false, status: 403, message: "PHONE_PROOF_REQUIRED" };
    }
  }
  return { ok: true, booking, parsedPath };
}

function extractOrderCodesFromText(value) {
  const raw = text(value);
  const results = new Set();
  const patterns = [
    /(?:ma\s*(?:don|booking)|order(?:\s*code)?|payos|thanh\s*toan)[^0-9]{0,24}(\d{6,20})/gi,
    /[?&](?:pay|orderCode)=([A-Za-z0-9_-]{6,40})/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(raw))) results.add(text(match[1]));
  }
  return [...results];
}

function extractPhonesFromText(value) {
  const raw = text(value);
  const results = new Set();
  const matches = raw.match(/(?:\+?84|0)[\d\s.-]{8,13}\d/g) || [];
  for (const match of matches) {
    const phone = normalizePhone(match);
    if (phone.length >= 9 && phone.length <= 11) results.add(phone);
  }
  return [...results];
}

async function paidBookingByOrderCode(orderCode) {
  const code = text(orderCode);
  if (!code) return null;
  const indexSnapshot = await getAdminDatabase().ref(`paymentIndex/${safeKey(code)}`).get();
  const index = indexSnapshot.exists() ? indexSnapshot.val() : null;
  const parsedPath = validateBookingPath(index?.bookingPath);
  if (!parsedPath) return null;
  const bookingSnapshot = await getAdminDatabase().ref(parsedPath.path).get();
  const booking = bookingSnapshot.exists() ? bookingSnapshot.val() : null;
  if (!booking || !isPaidBooking(booking) || text(booking.orderCode) !== code) return null;
  return { booking, bookingPath: parsedPath.path, bookingKey: parsedPath.bookingKey, matchedBy: "orderCode" };
}

function monthKeysAroundNow() {
  const result = [];
  const base = new Date();
  for (let offset = 3; offset >= -5; offset -= 1) {
    const date = new Date(base.getFullYear(), base.getMonth() + offset, 1);
    result.push({ year: String(date.getFullYear()), month: String(date.getMonth() + 1).padStart(2, "0") });
  }
  return result;
}

async function paidBookingByPhone(phone) {
  const target = normalizePhone(phone);
  if (!target) return null;
  const matches = [];
  for (const { year, month } of monthKeysAroundNow()) {
    const snapshot = await getAdminDatabase().ref(`bookingsByMonth/${year}/${month}`).get();
    const bookings = snapshot.exists() && snapshot.val() && typeof snapshot.val() === "object"
      ? snapshot.val()
      : {};
    for (const [bookingKey, booking] of Object.entries(bookings)) {
      if (normalizePhone(booking?.phone || booking?.customerPhone || booking?.phoneNumber) !== target) continue;
      if (!isPaidBooking(booking)) continue;
      matches.push({
        booking,
        bookingPath: `bookingsByMonth/${year}/${month}/${bookingKey}`,
        bookingKey,
        matchedBy: "phone"
      });
    }
  }
  matches.sort((a, b) => {
    const timeA = toMillis(a.booking?.checkin) || toMillis(a.booking?.paidAt) || toMillis(a.booking?.createdAt);
    const timeB = toMillis(b.booking?.checkin) || toMillis(b.booking?.paidAt) || toMillis(b.booking?.createdAt);
    return timeB - timeA;
  });
  return matches[0] || null;
}

async function staffConfirmedBookingEvidence(psid, context = {}) {
  const snapshot = await getAdminDatabase()
    .ref(`messengerBot/conversations/${safeKey(psid)}`)
    .get();
  const conversation = snapshot.exists() && snapshot.val() && typeof snapshot.val() === "object"
    ? snapshot.val()
    : {};
  const confirmedAt = Number(conversation.staffPaymentConfirmedAt || 0);
  const maxAgeMs = 45 * 24 * 60 * 60 * 1000;
  if (!confirmedAt || Date.now() - confirmedAt > maxAgeMs) return null;

  const storedContext = conversation.context && typeof conversation.context === "object"
    ? conversation.context
    : {};
  const merged = { ...storedContext, ...(context || {}) };
  const selectedHome = merged.selectedHome && typeof merged.selectedHome === "object"
    ? merged.selectedHome
    : {};
  const room = text(
    selectedHome.displayName
    || selectedHome.name
    || selectedHome.homeId
    || merged.preferredHomeId
    || merged.room
  );

  return {
    booking: {
      room,
      homeId: text(selectedHome.homeId || merged.preferredHomeId),
      branchId: text(selectedHome.branchId || merged.branchId),
      phone: text(merged.phone),
      dateKey: text(merged.dateKey),
      startMinute: merged.startMinute ?? null,
      checkoutMinute: merged.checkoutMinute ?? null,
      durationHours: merged.durationHours ?? null,
      paymentStatus: "staff_confirmed",
      paymentConfirmedAt: confirmedAt,
      paymentConfirmedBy: text(conversation.staffPaymentConfirmedBy || "Nhân viên Page")
    },
    bookingPath: "",
    bookingKey: "",
    matchedBy: "staff_confirmation",
    manualConfirmation: true
  };
}

export async function findPaidBookingFromMessengerEvidence(psid, context = {}) {
  // Xác nhận thủ công chỉ hợp lệ khi webhook đã ghi nhận một tin nhắn echo
  // do chính nhân viên Page gửi trong đúng cuộc hội thoại. Tin nhắn khách không
  // bao giờ đi vào nhánh này.
  const staffMatch = await staffConfirmedBookingEvidence(psid, context);
  if (staffMatch) return staffMatch;

  // Ngoài xác nhận của nhân viên, chỉ booking đã có trạng thái paid hợp lệ
  // trong Firebase mới được chấp nhận.
  const snapshot = await getAdminDatabase()
    .ref(`messengerBot/messages/${safeKey(psid)}`)
    .limitToLast(60)
    .get();
  const values = snapshot.exists() && snapshot.val() && typeof snapshot.val() === "object"
    ? Object.values(snapshot.val())
    : [];
  const inboundText = values
    .filter(item => item?.direction === "in")
    .map(item => `${text(item?.text)} ${text(item?.payload)}`)
    .join("\n");

  const orderCodes = extractOrderCodesFromText(inboundText);
  for (const orderCode of orderCodes.reverse()) {
    const match = await paidBookingByOrderCode(orderCode);
    if (match) return match;
  }

  const phones = new Set(extractPhonesFromText(inboundText));
  const contextPhone = normalizePhone(context?.phone);
  if (contextPhone) phones.add(contextPhone);
  for (const phone of [...phones].reverse()) {
    const match = await paidBookingByPhone(phone);
    if (match) return match;
  }
  return null;
}

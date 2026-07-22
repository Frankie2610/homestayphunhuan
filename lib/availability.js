import { DateTime } from "luxon";
import { getAdminDatabase, firebaseReadWithTimeout } from "./firebase-admin.js";
import { config } from "./config.js";
import {
  localDateTime,
  minuteToLabel,
  normalizeVietnamese,
  nowLocal,
  parseBackendDateTimeMs
} from "./date-time.js";

let homesCache = { value: null, expiresAt: 0 };
const monthCache = new Map();
const CACHE_TTL_MS = Math.max(5_000, Number(config.webChatDataCacheTtlMs || 15_000));

function flattenRecords(value, inheritedKey = "", depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return [];

  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      flattenRecords(child, inheritedKey || String(index), depth + 1)
    );
  }

  const looksLikeBooking = [
    "checkIn",
    "checkin",
    "start",
    "checkInAt",
    "checkinAt",
    "checkinDate",
    "checkOut",
    "checkout",
    "end",
    "checkOutAt",
    "checkoutAt",
    "checkoutDate"
  ].some(key => value[key] != null);

  if (looksLikeBooking) {
    return [{
      ...value,
      firebaseKey: value.firebaseKey || value.bookingFirebaseKey || value.id || inheritedKey
    }];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    flattenRecords(child, key, depth + 1)
  );
}

export function normalizeRoomKey(value) {
  return normalizeVietnamese(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function homeEntries(homesObject) {
  return Object.entries(homesObject || {})
    .filter(([, home]) => home && typeof home === "object");
}

function homeAliases(homeId, home, index) {
  return new Set([
    homeId,
    `HOME${index + 1}`,
    home?.id,
    home?.code,
    home?.slug,
    home?.title,
    home?.name,
    home?.room,
    home?.roomId
  ].filter(Boolean).map(normalizeRoomKey));
}

function normalizeAmenityName(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return String(item || "");
  return [
    item.icon || item.emoji || "",
    item.name || item.title || item.label || item.text || item.value || ""
  ].filter(Boolean).join(" ");
}

function homeSearchText(home) {
  const amenitySource = home?.amenities
    ?? home?.features
    ?? home?.utilities
    ?? home?.facilities
    ?? home?.tienIch
    ?? home?.tienich
    ?? [];
  const amenityList = Array.isArray(amenitySource)
    ? amenitySource
    : Object.values(amenitySource || {});

  const fields = [
    home?.name,
    home?.title,
    home?.description,
    home?.shortDescription,
    home?.content,
    ...amenityList.map(normalizeAmenityName)
  ];

  try {
    fields.push(JSON.stringify(home));
  } catch {
    // Firebase objects are normally serializable. Ignore malformed metadata.
  }

  return normalizeVietnamese(fields.filter(Boolean).join(" "));
}

const AMENITY_PATTERNS = {
  "bon tam": ["bon tam", "bathtub", "bath tub"],
  "may chieu": ["may chieu", "projector"],
  netflix: ["netflix"],
  "55": ["tv 55", "55 inch", "55\""],
  "ban cong": ["ban cong", "cua so", "view"]
};

function amenityMatchesHome(haystack, amenity) {
  const normalized = normalizeVietnamese(amenity);
  const patterns = AMENITY_PATTERNS[normalized] || [normalized];
  return patterns.some(pattern => haystack.includes(normalizeVietnamese(pattern)));
}

function homeMatchesAmenities(home, amenities = []) {
  if (!amenities.length) return true;
  const haystack = homeSearchText(home);
  return amenities.every(item => amenityMatchesHome(haystack, item));
}

function firstPresent(record, keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null && record?.[key] !== "") {
      return record[key];
    }
  }
  return null;
}

export function normalizeBooking(record) {
  if (!record || typeof record !== "object") return null;

  const startRaw = firstPresent(record, [
    "checkIn",
    "checkin",
    "start",
    "checkInAt",
    "checkinAt",
    "checkinDate"
  ]);
  const endRaw = firstPresent(record, [
    "checkOut",
    "checkout",
    "end",
    "checkOutAt",
    "checkoutAt",
    "checkoutDate"
  ]);

  const startMs = parseBackendDateTimeMs(startRaw);
  const endMs = parseBackendDateTimeMs(endRaw);
  const room = firstPresent(record, [
    "room",
    "roomId",
    "home",
    "homeId",
    "homeTitle",
    "roomName"
  ]);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !room) {
    return null;
  }

  return {
    ...record,
    startMs,
    endMs,
    roomKey: normalizeRoomKey(room),
    firebaseKey: record.firebaseKey || record.bookingFirebaseKey || record.id || ""
  };
}

export function bookingBlocks(booking, nowMs = Date.now()) {
  const status = normalizeVietnamese(booking?.bookingStatus || booking?.status || "").replace(/\s+/g, "_");
  const paymentStatus = normalizeVietnamese(booking?.paymentStatus || "").replace(/\s+/g, "_");
  const source = normalizeVietnamese(booking?.source || "");
  const lockedByWebsite = booking?.lockedByWebsite === true;

  if (["cancelled", "canceled", "expired", "cancelled_unpaid", "da_huy", "het_han"].includes(status)) {
    return false;
  }
  if (["expired", "cancelled", "canceled", "refunded", "da_huy", "hoan_tien"].includes(paymentStatus)) {
    return false;
  }

  const actuallyPaid = booking?.paymentCompleted === true
    || paymentStatus === "paid"
    || paymentStatus === "da_thanh_toan"
    || Boolean(booking?.transactionId)
    || Number(booking?.paidAmount || 0) > 0
    || Boolean(booking?.paidAt)
    || Boolean(booking?.paymentConfirmedAt);

  if (status === "confirmed" || status === "da_xac_nhan" || actuallyPaid) return true;

  if (status === "pending_payment" || status === "cho_thanh_toan") {
    return Number(booking?.holdExpiresAt || 0) > Number(nowMs || Date.now());
  }

  // Booking created manually before bookingStatus existed must still block the calendar.
  if (!status && !lockedByWebsite && source !== "website") return true;

  return false;
}

async function loadHomes({ force = false } = {}) {
  if (!force && homesCache.value && homesCache.expiresAt > Date.now()) return homesCache.value;
  const snap = await firebaseReadWithTimeout(
    getAdminDatabase().ref("homes").get(),
    "homes_read",
    config.webChatFirebaseReadTimeoutMs
  );
  const value = snap.exists() ? snap.val() : {};
  homesCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

async function loadMonth(monthPath, { force = false } = {}) {
  const cached = monthCache.get(monthPath);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const snap = await firebaseReadWithTimeout(
    getAdminDatabase().ref(`bookingsByMonth/${monthPath}`).get(),
    `bookings_read_${monthPath.replace(/\//g, "_")}`,
    config.webChatFirebaseReadTimeoutMs
  );
  const rawRecords = snap.exists() ? flattenRecords(snap.val()) : [];
  const value = rawRecords.map(normalizeBooking).filter(Boolean);
  monthCache.set(monthPath, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

function monthPathsForRange(start, end) {
  const paths = new Set();
  let cursor = start.startOf("month");
  const limit = end.startOf("month");
  while (cursor <= limit) {
    paths.add(cursor.toFormat("yyyy/MM"));
    cursor = cursor.plus({ months: 1 });
  }
  return [...paths];
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function getCandidateBlockers(candidateStartMs, candidateEndMs, aliases, bookings) {
  const beforeMs = config.cleaningBeforeMinutes * 60_000;
  const afterMs = config.cleaningAfterMinutes * 60_000;

  return bookings.filter(booking => {
    if (!aliases.has(booking.roomKey) || !bookingBlocks(booking)) return false;
    return rangesOverlap(
      candidateStartMs,
      candidateEndMs,
      booking.startMs - beforeMs,
      booking.endMs + afterMs
    );
  });
}

function normalizeImageUrl(value) {
  if (typeof value === "string") {
    const url = value.trim();
    return /^https:\/\//i.test(url) ? url : "";
  }

  if (value && typeof value === "object") {
    return normalizeImageUrl(
      value.url
      || value.src
      || value.secureUrl
      || value.secure_url
    );
  }

  return "";
}

function extractHomeImages(home = {}) {
  const source = home?.images;
  const values = Array.isArray(source)
    ? source
    : Object.values(source || {});

  const coverImageUrl = normalizeImageUrl(home?.coverImage);
  const gallery = values
    .map(normalizeImageUrl)
    .filter(Boolean);

  return [...new Set([coverImageUrl, ...gallery].filter(Boolean))];
}

function publicHome(homeId, home, index) {
  const routeName = home?.title || `HOME${index + 1}`;
  // Website/chatbot chỉ công khai khu vực, không lấy lại địa chỉ chi tiết cũ
  // từ node homes trên Firebase.
  const address = config.homeAddress;
  const mapUrl = config.mapUrl
    || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  const images = extractHomeImages(home);

  return {
    homeId,
    routeName,
    displayName: home?.name || home?.title || `HOME ${index + 1}`,
    description: String(home?.description || "").trim(),
    address,
    mapUrl,
    coverImageUrl: images[0] || "",
    images,
    aliases: [...homeAliases(homeId, home, index)],
    amenityText: homeSearchText(home)
  };
}

function preferredAliasesFor(preferredHomeId, homes) {
  if (!preferredHomeId) return null;
  const target = normalizeRoomKey(preferredHomeId);
  for (let index = 0; index < homes.length; index += 1) {
    const [homeId, home] = homes[index];
    const aliases = homeAliases(homeId, home, index);
    if (aliases.has(target)) return aliases;
  }
  return new Set([target]);
}

export function extractAmenities(text = "") {
  const s = normalizeVietnamese(text);
  const found = [];
  if (/bon tam|bathtub/.test(s)) found.push("bon tam");
  if (/may chieu|projector/.test(s)) found.push("may chieu");
  if (/netflix/.test(s)) found.push("netflix");
  if (/tv\s*55|55\s*(?:inch|in)/.test(s)) found.push("55");
  if (/ban cong|cua so|view/.test(s)) found.push("ban cong");
  return [...new Set(found)];
}

function validateCandidate(dateKey, startMinute, durationHours) {
  const start = localDateTime(dateKey, startMinute);
  const duration = Number(durationHours);
  if (!start.isValid || !Number.isFinite(duration) || duration <= 0) {
    return { valid: false, start, end: start, reason: "invalid_input" };
  }

  const end = start.plus({ hours: duration });
  if (!end.isValid || end <= start) {
    return { valid: false, start, end, reason: "invalid_range" };
  }

  // Do not offer a time that is already in the past. Keep a small grace period for typing delay.
  if (start < nowLocal().minus({ minutes: 5 })) {
    return { valid: false, start, end, reason: "past_time" };
  }

  return { valid: true, start, end, reason: "" };
}

async function readAvailabilityData(start, end, { forceRefresh = true } = {}) {
  const months = monthPathsForRange(
    start.minus({ hours: 2 }),
    end.plus({ hours: 2 })
  );

  // Homes and monthly bookings are independent Firebase reads. Running them
  // together removes one full network round trip from every availability check.
  const [homesObject, monthRows] = await Promise.all([
    loadHomes({ force: forceRefresh }),
    Promise.all(months.map(month => loadMonth(month, { force: forceRefresh })))
  ]);
  const homes = homeEntries(homesObject);
  const bookings = monthRows.flat();

  return {
    homes,
    bookings,
    months,
    readAt: Date.now(),
    source: "firebase_realtime_database"
  };
}

function evaluateAvailableHomes({
  candidate,
  startMinute,
  durationHours,
  amenities = [],
  preferredHomeId = "",
  data
}) {
  const preferredAliases = preferredAliasesFor(preferredHomeId, data.homes);
  const results = [];

  data.homes.forEach(([homeId, home], index) => {
    const aliases = homeAliases(homeId, home, index);
    if (preferredAliases && ![...aliases].some(alias => preferredAliases.has(alias))) return;
    if (!homeMatchesAmenities(home, amenities)) return;

    const blockers = getCandidateBlockers(
      candidate.start.toMillis(),
      candidate.end.toMillis(),
      aliases,
      data.bookings
    );
    if (blockers.length) return;

    results.push({
      ...publicHome(homeId, home, index),
      startMinute: Number(startMinute),
      durationHours: Number(durationHours),
      startLabel: minuteToLabel(startMinute),
      endLabel: candidate.end.toFormat("HH:mm"),
      endDateKey: candidate.end.toISODate()
    });
  });

  return results;
}


export async function warmAvailabilityCache({ days = 45 } = {}) {
  const start = nowLocal().startOf("day");
  const end = start.plus({ days: Math.max(2, Number(days || 45)) }).endOf("day");
  return readAvailabilityData(start, end, { forceRefresh: false });
}

export async function checkLiveAvailability({
  dateKey,
  startMinute,
  durationHours,
  amenities = [],
  preferredHomeId = "",
  forceRefresh = true
}) {
  const candidate = validateCandidate(dateKey, startMinute, durationHours);
  if (!candidate.valid) {
    return {
      results: [],
      meta: {
        valid: false,
        reason: candidate.reason,
        source: "firebase_realtime_database",
        readAt: Date.now(),
        bookingPaths: []
      }
    };
  }

  // A customer availability request always begins with a fresh Firebase read.
  // The small in-memory cache is only reused inside the same multi-slot search.
  const data = await readAvailabilityData(candidate.start, candidate.end, { forceRefresh });
  const results = evaluateAvailableHomes({
    candidate,
    startMinute,
    durationHours,
    amenities,
    preferredHomeId,
    data
  });

  return {
    results,
    meta: {
      valid: true,
      source: data.source,
      readAt: data.readAt,
      homesPath: "homes",
      bookingPaths: data.months.map(month => `bookingsByMonth/${month}`),
      homeCount: data.homes.length,
      bookingCount: data.bookings.length,
      timezone: config.timezone
    }
  };
}

export async function findAvailableHomes(args) {
  const { results } = await checkLiveAvailability(args);
  return results;
}

function buildNearbyMinutes({ requestedStartMinute, minimumMinute, maximumMinute, step }) {
  const min = Math.max(0, Number(minimumMinute || 0));
  const max = Math.max(min, Number(maximumMinute || 0));
  const normalizedRequested = Number.isFinite(Number(requestedStartMinute))
    ? Math.min(max, Math.max(min, Number(requestedStartMinute)))
    : min;
  const base = Math.round(normalizedRequested / step) * step;
  const values = [];

  for (let distance = 0; distance <= (max - min) + step; distance += step) {
    const later = base + distance;
    const earlier = base - distance;
    if (later >= min && later <= max) values.push(later);
    if (distance > 0 && earlier >= min && earlier <= max) values.push(earlier);
  }

  return [...new Set(values)];
}

export async function suggestAvailableSlots({
  dateKey,
  durationHours,
  amenities = [],
  preferredHomeId = "",
  requestedStartMinute = null,
  limit = 6,
  forceRefresh = true
}) {
  const day = DateTime.fromISO(dateKey, { zone: config.timezone });
  if (!day.isValid) return [];

  const now = nowLocal();
  let firstMinute = 0;
  if (day.hasSame(now, "day")) {
    firstMinute = Math.ceil((now.hour * 60 + now.minute + 15) / config.slotStepMinutes)
      * config.slotStepMinutes;
  }

  // Day packages should not start after the point where they cannot finish by 23:00.
  // Overnight packages are allowed to cross midnight.
  const durationMinutes = Number(durationHours) * 60;
  const maxMinute = Number(durationHours) >= 12
    ? config.dayEndMinute
    : Math.max(firstMinute, config.dayEndMinute - durationMinutes);

  const minutes = buildNearbyMinutes({
    requestedStartMinute,
    minimumMinute: firstMinute,
    maximumMinute: maxMinute,
    step: config.slotStepMinutes
  });

  // Read Firebase once for the whole nearby-slot scan, then evaluate all
  // candidate times against that exact fresh snapshot.
  const rangeStart = day.startOf("day");
  const rangeEnd = day.plus({ days: 2 }).endOf("day");
  const data = await readAvailabilityData(rangeStart, rangeEnd, { forceRefresh });

  const collected = [];
  for (const minute of minutes) {
    const candidate = validateCandidate(dateKey, minute, durationHours);
    if (!candidate.valid) continue;
    const available = evaluateAvailableHomes({
      candidate,
      startMinute: minute,
      durationHours,
      amenities,
      preferredHomeId,
      data
    });

    for (const item of available) {
      if (collected.some(existing => existing.homeId === item.homeId)) continue;
      collected.push(item);
      if (collected.length >= limit) return collected;
    }
  }
  return collected;
}

export async function listPublicHomes() {
  const homesObject = await loadHomes();
  return homeEntries(homesObject).map(([homeId, home], index) =>
    publicHome(homeId, home, index)
  );
}

export async function resolveHomeByPayload(homeId) {
  const homesObject = await loadHomes();
  const homes = homeEntries(homesObject);
  const target = normalizeRoomKey(homeId);
  const index = homes.findIndex(([id, home], currentIndex) =>
    homeAliases(id, home, currentIndex).has(target)
  );
  if (index < 0) return null;
  return publicHome(homes[index][0], homes[index][1], index);
}

export async function diagnoseAvailability({
  dateKey,
  startMinute,
  durationHours,
  amenities = [],
  preferredHomeId = ""
}) {
  const candidate = validateCandidate(dateKey, startMinute, durationHours);
  if (!candidate.valid) {
    return {
      input: { dateKey, startMinute, durationHours, amenities, preferredHomeId },
      valid: false,
      reason: candidate.reason,
      homes: []
    };
  }

  const data = await readAvailabilityData(candidate.start, candidate.end, { forceRefresh: true });
  const homes = data.homes;
  const bookings = data.bookings;
  const months = data.months;
  const preferredAliases = preferredAliasesFor(preferredHomeId, homes);

  const diagnostics = homes.map(([homeId, home], index) => {
    const aliases = homeAliases(homeId, home, index);
    const preferredMatch = !preferredAliases
      || [...aliases].some(alias => preferredAliases.has(alias));
    const amenitiesMatch = homeMatchesAmenities(home, amenities);
    const blockers = getCandidateBlockers(
      candidate.start.toMillis(),
      candidate.end.toMillis(),
      aliases,
      bookings
    );

    return {
      homeId,
      displayName: home?.name || home?.title || `HOME ${index + 1}`,
      preferredMatch,
      amenitiesMatch,
      available: preferredMatch && amenitiesMatch && blockers.length === 0,
      blockers: blockers.map(booking => ({
        roomKey: booking.roomKey,
        start: DateTime.fromMillis(booking.startMs, { zone: config.timezone }).toISO(),
        end: DateTime.fromMillis(booking.endMs, { zone: config.timezone }).toISO(),
        bookingStatus: booking.bookingStatus || booking.status || "",
        paymentStatus: booking.paymentStatus || "",
        holdExpiresAt: Number(booking.holdExpiresAt || 0)
      }))
    };
  });

  return {
    input: {
      dateKey,
      startMinute: Number(startMinute),
      startLabel: minuteToLabel(startMinute),
      durationHours: Number(durationHours),
      amenities,
      preferredHomeId
    },
    valid: true,
    source: data.source,
    readAt: data.readAt,
    homesPath: "homes",
    bookingPaths: months.map(month => `bookingsByMonth/${month}`),
    timezone: config.timezone,
    cleaningBeforeMinutes: config.cleaningBeforeMinutes,
    cleaningAfterMinutes: config.cleaningAfterMinutes,
    monthsRead: months,
    bookingCount: bookings.length,
    homes: diagnostics
  };
}

export function clearAvailabilityCache() {
  homesCache = { value: null, expiresAt: 0 };
  monthCache.clear();
}

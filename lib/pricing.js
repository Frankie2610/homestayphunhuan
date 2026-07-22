import { getAdminDatabase } from "./firebase-admin.js";
import { normalizeRoomKey } from "./availability.js";
import { normalizeVietnamese, SUPPORTED_DURATIONS } from "./date-time.js";
import { normalizePublicHomeRecord } from "./public-branding.js";

const PRICE_CACHE_TTL_MS = 5_000;
let pricingCache = { value: null, expiresAt: 0 };

function firstPresent(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function toPositiveNumber(value) {
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.-]/g, "");
    value = cleaned;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeKey(value) {
  return normalizeVietnamese(String(value || ""))
    .replace(/[^a-z0-9]/g, "");
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

function directComboFields(record = {}) {
  const result = {};
  for (const hours of SUPPORTED_DURATIONS) {
    const candidates = [
      record?.[hours],
      record?.[String(hours)],
      record?.[`price${hours}`],
      record?.[`price${hours}h`],
      record?.[`price${hours}H`],
      record?.[`combo${hours}`],
      record?.[`combo${hours}h`],
      record?.[`combo${hours}H`],
      record?.[`package${hours}`],
      record?.[`package${hours}h`],
      record?.[`package${hours}H`]
    ];
    const value = candidates.map(toPositiveNumber).find(Boolean) || 0;
    if (value > 0) result[hours] = value;
  }
  return result;
}

function comboMapFromSource(source = {}) {
  const merged = {
    ...directComboFields(source),
    ...directComboFields(source?.packages),
    ...directComboFields(source?.day),
    ...directComboFields(source?.night),
    ...directComboFields(source?.flex)
  };

  for (const bucket of [source?.packages, source?.day, source?.night, source?.flex]) {
    for (const [rawHours, rawPrice] of Object.entries(bucket || {})) {
      const hours = Number(rawHours);
      const price = toPositiveNumber(rawPrice);
      if (SUPPORTED_DURATIONS.includes(hours) && price > 0) merged[hours] = price;
    }
  }
  return merged;
}

function walkNumericFields(record, prefix = "", depth = 0, output = []) {
  if (!record || typeof record !== "object" || depth > 5) return output;
  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number" || typeof value === "string") {
      const number = toPositiveNumber(value);
      if (number > 0) output.push({ key, path, normalized: normalizeKey(path), value: number });
      continue;
    }
    if (value && typeof value === "object") walkNumericFields(value, path, depth + 1, output);
  }
  return output;
}

export function extractLateCheckoutFee(pricing = {}, home = {}) {
  const sources = [pricing, home?.pricing || {}, home];
  const explicit30Keys = [
    "lateCheckout30",
    "lateCheckout30Minutes",
    "lateCheckoutFee30",
    "checkoutLate30",
    "checkoutLateFee30",
    "lateFee30",
    "surcharge30",
    "extra30Minutes",
    "extraHalfHour",
    "overtime30",
    "overtime30Minutes",
    "phuThu30Phut",
    "phuthu30phut"
  ];
  const hourlyKeys = [
    "extraHour",
    "hourly",
    "lateCheckoutHourly",
    "lateCheckoutPerHour",
    "checkoutLateHourly",
    "checkoutLatePerHour",
    "lateFeePerHour",
    "surchargePerHour",
    "overtimeHourly",
    "overstayHourly",
    "extraTimePerHour",
    "phuThuMoiGio",
    "phuthuMoiGio"
  ];

  for (const source of sources) {
    const explicit = toPositiveNumber(firstPresent(source, explicit30Keys));
    if (explicit > 0) {
      return { amount: explicit, stepMinutes: 30, source: "explicit_30_minute_fee" };
    }
  }

  for (const source of sources) {
    const hourly = toPositiveNumber(firstPresent(source, hourlyKeys));
    if (hourly > 0) {
      return { amount: hourly / 2, stepMinutes: 30, hourlyAmount: hourly, source: "derived_from_hourly_fee" };
    }
  }

  const fields = sources.flatMap(source => walkNumericFields(source));
  const explicitByPattern = fields.find(item => {
    const key = item.normalized;
    const feeCue = /(late|checkout|tratre|phuthu|overtime|overstay|quagio|extra)/.test(key);
    const thirtyCue = /(30|half|nuagio|nua)/.test(key);
    return feeCue && thirtyCue;
  });
  if (explicitByPattern) {
    return { amount: explicitByPattern.value, stepMinutes: 30, source: explicitByPattern.path };
  }

  const hourlyByPattern = fields.find(item => {
    const key = item.normalized;
    return /(extrahour|hourly|late.*hour|checkout.*hour|phuthu.*gio|overtime.*hour|overstay.*hour|quagio.*gio)/.test(key);
  });
  if (hourlyByPattern) {
    return {
      amount: hourlyByPattern.value / 2,
      stepMinutes: 30,
      hourlyAmount: hourlyByPattern.value,
      source: hourlyByPattern.path
    };
  }

  return { amount: 0, stepMinutes: 30, source: "not_configured" };
}

export function normalizePricingForHome({ homeId, home = {}, index = 0, roomPricing = {} }) {
  home = normalizePublicHomeRecord(home);
  const roomCode = `HOME${index + 1}`;
  const pricingFromRoom = roomPricing?.[roomCode] || roomPricing?.[homeId] || {};
  const pricingFromHome = home?.pricing || {};
  const combos = {
    ...comboMapFromSource(pricingFromRoom),
    ...comboMapFromSource(pricingFromHome)
  };
  const lateCheckout = extractLateCheckoutFee(
    { ...pricingFromRoom, ...pricingFromHome },
    home
  );

  return {
    homeId,
    roomCode,
    routeName: home?.title || roomCode,
    displayName: home?.name || home?.title || `HOME ${index + 1}`,
    aliases: [...homeAliases(homeId, home, index)],
    combos,
    lateCheckout,
    sourcePaths: [`homes/${homeId}`, `roomPricing/${roomCode}`]
  };
}

export function buildPricingCatalogFromData(homesObject = {}, roomPricing = {}) {
  const homes = Object.entries(homesObject || {})
    .filter(([, home]) => home && typeof home === "object")
    .map(([homeId, home], index) => normalizePricingForHome({
      homeId,
      home,
      index,
      roomPricing
    }));

  return {
    homes,
    source: "firebase_realtime_database",
    sourcePaths: ["homes", "roomPricing"],
    readAt: Date.now()
  };
}

export async function loadPricingCatalog({ forceRefresh = true } = {}) {
  if (!forceRefresh && pricingCache.value && pricingCache.expiresAt > Date.now()) {
    return pricingCache.value;
  }

  const db = getAdminDatabase();
  const [homesSnap, pricingSnap] = await Promise.all([
    db.ref("homes").get(),
    db.ref("roomPricing").get()
  ]);
  const value = buildPricingCatalogFromData(
    homesSnap.exists() ? homesSnap.val() : {},
    pricingSnap.exists() ? pricingSnap.val() : {}
  );
  pricingCache = { value, expiresAt: Date.now() + PRICE_CACHE_TTL_MS };
  return value;
}

export function findPricingHome(catalog, homeReference = "") {
  if (!homeReference) return null;
  const target = normalizeRoomKey(homeReference);
  return (catalog?.homes || []).find(home => home.aliases.includes(target)) || null;
}

export async function resolvePricingHome(homeReference, { forceRefresh = true } = {}) {
  const catalog = await loadPricingCatalog({ forceRefresh });
  return findPricingHome(catalog, homeReference);
}

export function comboPriceRange(catalog, comboHours) {
  const hours = Number(comboHours);
  const rows = (catalog?.homes || [])
    .map(home => ({ home, price: toPositiveNumber(home.combos?.[hours]) }))
    .filter(row => row.price > 0);
  if (!rows.length) return null;
  const values = rows.map(row => row.price);
  return {
    hours,
    min: Math.min(...values),
    max: Math.max(...values),
    rows
  };
}

export function allComboRanges(catalog) {
  return SUPPORTED_DURATIONS
    .map(hours => comboPriceRange(catalog, hours))
    .filter(Boolean);
}

export function lateCheckoutRange(catalog) {
  const rows = (catalog?.homes || [])
    .map(home => ({ home, fee: toPositiveNumber(home.lateCheckout?.amount) }))
    .filter(row => row.fee > 0);
  if (!rows.length) return null;
  const values = rows.map(row => row.fee);
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    rows,
    stepMinutes: 30
  };
}

export function formatMoneyVi(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0đ";
  return `${Math.round(number).toLocaleString("vi-VN")}đ`;
}

export function extraGuestCharge(guestCount, includedGuests = 2, feePerGuest = 50_000) {
  const count = Number(guestCount || 0);
  if (!Number.isFinite(count) || count <= includedGuests) return 0;
  return Math.max(0, Math.floor(count) - includedGuests) * feePerGuest;
}

export function clearPricingCache() {
  pricingCache = { value: null, expiresAt: 0 };
}

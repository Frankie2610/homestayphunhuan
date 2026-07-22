import { DateTime } from "luxon";
import { config } from "./config.js";

export const SUPPORTED_DURATIONS = Object.freeze([2, 3, 4, 7, 9, 12, 14, 22]);

export function nowLocal() {
  return DateTime.now().setZone(config.timezone);
}

export function normalizeVietnamese(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDateFromText(text, now = nowLocal()) {
  const raw = String(text || "");
  const s = normalizeVietnamese(raw);

  if (/\b(hom nay|toi nay|nay)\b/.test(s)) return now.toISODate();
  if (/\b(ngay mai|mai)\b/.test(s)) return now.plus({ days: 1 }).toISODate();
  if (/\b(ngay mot|mot)\b/.test(s)) return now.plus({ days: 2 }).toISODate();

  const numeric = raw.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (numeric) {
    let year = numeric[3] ? Number(numeric[3]) : now.year;
    if (year < 100) year += 2000;
    const dt = DateTime.fromObject({
      year,
      month: Number(numeric[2]),
      day: Number(numeric[1])
    }, { zone: config.timezone });
    if (dt.isValid) return dt.toISODate();
  }

  const weekdays = [
    { regex: /\b(chu nhat|cn)\b/, weekday: 7 },
    { regex: /\b(thu 2|thu hai|t2)\b/, weekday: 1 },
    { regex: /\b(thu 3|thu ba|t3)\b/, weekday: 2 },
    { regex: /\b(thu 4|thu tu|t4)\b/, weekday: 3 },
    { regex: /\b(thu 5|thu nam|t5)\b/, weekday: 4 },
    { regex: /\b(thu 6|thu sau|t6)\b/, weekday: 5 },
    { regex: /\b(thu 7|thu bay|t7)\b/, weekday: 6 }
  ];

  for (const item of weekdays) {
    if (!item.regex.test(s)) continue;
    let delta = (item.weekday - now.weekday + 7) % 7;
    if (delta === 0 && /tuan sau/.test(s)) delta = 7;
    if (delta === 0 && /tuan nay/.test(s)) delta = 0;
    return now.plus({ days: delta }).toISODate();
  }

  return null;
}

function normalizeClock(hour, minute = 0, meridiem = "", period = "") {
  let h = Number(hour);
  const m = Number(minute || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m) || m < 0 || m > 59) return null;

  const mer = normalizeVietnamese(meridiem);
  const part = normalizeVietnamese(period);
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
  }

  if (["chieu", "toi", "dem"].includes(part) && h < 12) h += 12;
  if (part === "trua" && h < 11) h += 12;
  if (part === "sang" && h === 12) h = 0;
  if (h < 0 || h > 23) return null;
  return h * 60 + m;
}

export function parseTimeFromText(text) {
  const raw = String(text || "");
  const s = normalizeVietnamese(raw);

  const ampm = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*(sang|trua|chieu|toi|dem))?/i);
  if (ampm) return normalizeClock(ampm[1], ampm[2], ampm[3], ampm[4]);

  const explicit = s.match(/\b(?:luc|khoang|tam)?\s*(\d{1,2})(?::(\d{2}))?\s*(?:h|g|gio)(?:\s*(\d{1,2}))?(?:\s*(sang|trua|chieu|toi|dem))?\b/i)
    || s.match(/\b(\d{1,2}):(\d{2})(?:\s*(sang|trua|chieu|toi|dem))?\b/);
  if (!explicit) return null;

  return normalizeClock(explicit[1], explicit[2] ?? explicit[3] ?? 0, "", explicit[4] ?? explicit[3] ?? "");
}

function durationRegexSource() {
  return SUPPORTED_DURATIONS.join("|");
}

export function parseDurationFromText(text, { state = "" } = {}) {
  const s = normalizeVietnamese(text);
  if (/\b(qua dem|nghi dem|overnight)\b/.test(s)) return 12;

  const values = durationRegexSource();
  const explicit = s.match(new RegExp(`\\b(?:o|nghi|thue|su dung|trong vong|combo|goi|gia|bao gia)\\s*(${values})\\s*(?:tieng|gio|h)\\b`))
    || s.match(new RegExp(`\\b(${values})\\s*tieng\\b`))
    || s.match(new RegExp(`\\b(?:combo|goi)\\s*(${values})\\s*h\\b`));
  if (explicit) return Number(explicit[1]);

  const bare = s.match(new RegExp(`^\\s*(${values})\\s*(?:h|gio)\\s*$`));
  if (bare && state === "awaiting_duration") return Number(bare[1]);

  return null;
}

function extractDurationMention(text, state = "") {
  const s = normalizeVietnamese(text);
  if (/\b(qua dem|nghi dem|overnight)\b/.test(s)) {
    const match = s.match(/\b(qua dem|nghi dem|overnight)\b/);
    return { hours: 12, start: match?.index ?? -1, end: (match?.index ?? 0) + (match?.[0]?.length || 0), explicit: true };
  }

  const values = durationRegexSource();
  const patterns = [
    new RegExp(`\\b(?:o|nghi|thue|su dung|trong vong|combo|goi|gia|bao gia)\\s*(${values})\\s*(?:tieng|gio|h)\\b`),
    new RegExp(`\\b(${values})\\s*tieng\\b`),
    new RegExp(`\\b(?:combo|goi)\\s*(${values})\\s*h\\b`)
  ];
  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match) {
      return {
        hours: Number(match[1]),
        start: match.index ?? -1,
        end: (match.index ?? 0) + match[0].length,
        explicit: true
      };
    }
  }

  const barePattern = new RegExp(`^\\s*(${values})\\s*(?:h|gio)\\s*$`);
  const bare = s.match(barePattern);
  if (bare) {
    if (state === "awaiting_duration") {
      return { hours: Number(bare[1]), start: 0, end: s.length, explicit: true };
    }
    if (state !== "awaiting_time") {
      return { hours: null, start: 0, end: s.length, explicit: false, ambiguousBareHour: Number(bare[1]) };
    }
  }
  return { hours: null, start: -1, end: -1, explicit: false };
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function extractClockMentions(text, durationMention) {
  const s = normalizeVietnamese(text);
  const mentions = [];
  const pattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|h|g|gio)(?:\s*(sang|trua|chieu|toi|dem))?\b|\b(\d{1,2}):(\d{2})(?:\s*(sang|trua|chieu|toi|dem))?\b/g;
  let match;
  while ((match = pattern.exec(s))) {
    const start = match.index;
    const end = start + match[0].length;
    if (durationMention?.start >= 0 && overlaps(start, end, durationMention.start, durationMention.end)) continue;
    const minute = match[1] != null
      ? normalizeClock(
        match[1],
        match[2] || 0,
        ["am", "pm"].includes(String(match[3] || "").toLowerCase()) ? match[3] : "",
        match[4] || ""
      )
      : normalizeClock(match[5], match[6] || 0, "", match[7] || "");
    if (minute == null) continue;
    mentions.push({ minute, start, end, raw: match[0] });
  }

  // Support “check-in 13” / “trả phòng 17” even without h or colon.
  const cuePattern = /\b(check\s*in|checkin|nhan phong|vao phong|gio vao|check\s*out|checkout|tra phong|roi phong|gio ra)\s*(?:luc)?\s*(\d{1,2})(?:\s*(sang|trua|chieu|toi|dem))?\b/g;
  while ((match = cuePattern.exec(s))) {
    const numberStart = match.index + match[0].lastIndexOf(match[2]);
    const numberEnd = numberStart + match[2].length;
    if (mentions.some(item => overlaps(item.start, item.end, numberStart, numberEnd))) continue;
    const minute = normalizeClock(match[2], 0, "", match[3] || "");
    if (minute == null) continue;
    mentions.push({ minute, start: numberStart, end: numberEnd, raw: match[2] });
  }

  return mentions.sort((a, b) => a.start - b.start);
}

function cueBefore(s, mention, cueRegex) {
  const before = s.slice(Math.max(0, mention.start - 36), mention.start);
  return cueRegex.test(before);
}

function durationBetween(startMinute, endMinute) {
  let minutes = Number(endMinute) - Number(startMinute);
  if (minutes <= 0) minutes += 1440;
  return minutes;
}

function nearestSupportedDurations(hours) {
  const lower = [...SUPPORTED_DURATIONS].filter(value => value <= hours).at(-1);
  const upper = SUPPORTED_DURATIONS.find(value => value >= hours);
  const values = [lower, upper].filter(value => value != null);
  if (values.length < 2) {
    const fallback = [...SUPPORTED_DURATIONS]
      .sort((a, b) => Math.abs(a - hours) - Math.abs(b - hours) || a - b)
      .find(value => !values.includes(value));
    if (fallback != null) values.push(fallback);
  }
  return [...new Set(values)].slice(0, 2);
}

/**
 * Parses check-in, check-out and combo as three different concepts.
 * checkoutMinute can be greater than 1440 when the stay crosses midnight.
 */
export function parseStayWindowFromText(text, { state = "" } = {}) {
  const s = normalizeVietnamese(text);
  const durationMention = extractDurationMention(s, state);
  const mentions = extractClockMentions(s, durationMention);
  const result = {
    checkInMinute: null,
    checkOutMinute: null,
    durationHours: durationMention.hours,
    ambiguousBareHour: durationMention.ambiguousBareHour || null,
    unsupportedDurationHours: null,
    suggestedDurations: [],
    conflict: null,
    source: []
  };

  const checkInCue = /\b(check\s*in|checkin|nhan phong|vao phong|gio vao|bat dau|vao luc|den luc)\s*$/;
  const checkOutCue = /\b(check\s*out|checkout|tra phong|roi phong|gio ra|ra luc|ket thuc)\s*$/;

  // “từ 13h đến 17h”, “13h - 17h”, “vào 13h đến 17h”.
  if (mentions.length >= 2) {
    for (let index = 0; index < mentions.length - 1; index += 1) {
      const first = mentions[index];
      const second = mentions[index + 1];
      const between = s.slice(first.end, second.start);
      if (/^\s*(?:den|toi|->|–|—|-)\s*(?:luc|check\s*out|checkout|tra phong|ra)?\s*$/.test(between)) {
        result.checkInMinute = first.minute;
        result.checkOutMinute = second.minute;
        result.source.push("time_range");
        break;
      }
    }
  }

  if (result.checkInMinute == null || result.checkOutMinute == null) {
    for (const mention of mentions) {
      if (cueBefore(s, mention, checkOutCue)) {
        if (result.checkOutMinute == null) {
          result.checkOutMinute = mention.minute;
          result.source.push("labeled_checkout");
        }
        continue;
      }
      if (cueBefore(s, mention, checkInCue)) {
        if (result.checkInMinute == null) {
          result.checkInMinute = mention.minute;
          result.source.push("labeled_checkin");
        }
        continue;
      }
    }
  }

  const unclassified = mentions.filter(mention => {
    const isIn = result.checkInMinute === mention.minute && result.source.some(item => item.includes("checkin") || item === "time_range");
    const isOut = result.checkOutMinute === mention.minute && result.source.some(item => item.includes("checkout") || item === "time_range");
    return !isIn && !isOut;
  });

  if (result.checkInMinute == null && unclassified.length) {
    result.checkInMinute = unclassified[0].minute;
    result.source.push("generic_checkin");
  }
  if (result.checkOutMinute == null && unclassified.length > 1) {
    result.checkOutMinute = unclassified[1].minute;
    result.source.push("generic_checkout");
  }

  if (result.checkInMinute != null && result.checkOutMinute != null) {
    const minutes = durationBetween(result.checkInMinute, result.checkOutMinute);
    const derivedHours = minutes / 60;
    if (result.durationHours != null && Math.abs(minutes - result.durationHours * 60) > 10) {
      result.conflict = {
        checkInMinute: result.checkInMinute,
        checkOutMinute: result.checkOutMinute,
        statedDurationHours: result.durationHours,
        derivedDurationHours: derivedHours
      };
    } else if (Number.isInteger(derivedHours) && SUPPORTED_DURATIONS.includes(derivedHours)) {
      result.durationHours = result.durationHours ?? derivedHours;
      result.source.push("duration_from_range");
    } else if (result.durationHours == null) {
      result.unsupportedDurationHours = derivedHours;
      result.suggestedDurations = nearestSupportedDurations(derivedHours);
    }
  }

  if (result.checkInMinute != null && result.durationHours != null && result.checkOutMinute == null) {
    result.checkOutMinute = result.checkInMinute + result.durationHours * 60;
    result.source.push("checkout_from_combo");
  }

  if (result.checkOutMinute != null && result.durationHours != null && result.checkInMinute == null) {
    let start = result.checkOutMinute - result.durationHours * 60;
    while (start < 0) start += 1440;
    result.checkInMinute = start;
    if (result.checkOutMinute <= start) result.checkOutMinute += 1440;
    result.source.push("checkin_from_checkout_combo");
  }

  if (result.checkInMinute != null && result.checkOutMinute != null && result.checkOutMinute <= result.checkInMinute) {
    result.checkOutMinute += 1440;
  }

  return result;
}

export function parsePhone(text) {
  const digits = String(text || "").replace(/\D/g, "");
  if (/^(?:84|0)\d{8,10}$/.test(digits)) return digits;
  return null;
}

export function minuteToLabel(minute) {
  const safe = ((Number(minute) % 1440) + 1440) % 1440;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatDateVi(dateKey) {
  const dt = DateTime.fromISO(dateKey, { zone: config.timezone });
  return dt.isValid ? dt.setLocale("vi").toFormat("dd/MM/yyyy") : dateKey;
}

export function localDateTime(dateKey, minute) {
  const base = DateTime.fromISO(dateKey, { zone: config.timezone }).startOf("day");
  return base.plus({ minutes: Number(minute) });
}

function hasExplicitZone(value) {
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(String(value || "").trim());
}

export function parseBackendDateTime(value) {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis)
      ? DateTime.fromMillis(millis, { zone: config.timezone })
      : DateTime.invalid("invalid_date");
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return DateTime.fromMillis(millis, { zone: config.timezone });
  }

  const raw = String(value ?? "").trim();
  if (!raw) return DateTime.invalid("empty_date");

  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    const millis = raw.length <= 10 ? numeric * 1000 : numeric;
    return DateTime.fromMillis(millis, { zone: config.timezone });
  }

  let parsed = hasExplicitZone(raw)
    ? DateTime.fromISO(raw, { setZone: true }).setZone(config.timezone)
    : DateTime.fromISO(raw, { zone: config.timezone });
  if (parsed.isValid) return parsed;

  parsed = DateTime.fromSQL(raw, { zone: config.timezone });
  if (parsed.isValid) return parsed;

  const fallbackMs = Date.parse(raw);
  return Number.isFinite(fallbackMs)
    ? DateTime.fromMillis(fallbackMs, { zone: config.timezone })
    : DateTime.invalid("unsupported_date");
}

export function parseBackendDateTimeMs(value) {
  const parsed = parseBackendDateTime(value);
  return parsed.isValid ? parsed.toMillis() : Number.NaN;
}

export const __dateTimeTest = {
  extractDurationMention,
  extractClockMentions,
  normalizeClock
};

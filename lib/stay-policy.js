export const IDENTITY_WINDOW_START_MINUTE = 0;
export const IDENTITY_WINDOW_END_MINUTE = 6 * 60;

export function stayIntersectsDailyWindow({
  startMinute,
  checkoutMinute,
  durationHours,
  windowStartMinute = IDENTITY_WINDOW_START_MINUTE,
  windowEndMinute = IDENTITY_WINDOW_END_MINUTE
} = {}) {
  const start = Number(startMinute);
  let checkout = Number(checkoutMinute);
  const hours = Number(durationHours);
  const windowStart = Number(windowStartMinute);
  const windowEnd = Number(windowEndMinute);

  if (!Number.isFinite(start)) return false;
  if (!Number.isFinite(checkout) && Number.isFinite(hours) && hours > 0) {
    checkout = start + hours * 60;
  }
  if (!Number.isFinite(checkout) || checkout <= start) return false;
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) return false;

  const firstDay = Math.floor(start / 1440);
  const lastDay = Math.floor((checkout - 1) / 1440);
  for (let day = firstDay; day <= lastDay; day += 1) {
    const dailyStart = day * 1440 + windowStart;
    const dailyEnd = day * 1440 + windowEnd;
    if (start < dailyEnd && checkout > dailyStart) return true;
  }
  return false;
}

export function requiresIdentityDocumentsForStay(value = {}) {
  return stayIntersectsDailyWindow(value);
}

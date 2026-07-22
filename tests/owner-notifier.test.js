import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { afterHoursResumeLabel, isAfterHours } from "../lib/owner-notifier.js";

test("ngoài giờ mặc định từ 23:00 đến trước 08:00", () => {
  assert.equal(isAfterHours(DateTime.fromISO("2026-07-11T23:30:00", { zone: "Asia/Ho_Chi_Minh" })), true);
  assert.equal(isAfterHours(DateTime.fromISO("2026-07-12T02:00:00", { zone: "Asia/Ho_Chi_Minh" })), true);
  assert.equal(isAfterHours(DateTime.fromISO("2026-07-12T08:00:00", { zone: "Asia/Ho_Chi_Minh" })), false);
  assert.equal(isAfterHours(DateTime.fromISO("2026-07-12T14:00:00", { zone: "Asia/Ho_Chi_Minh" })), false);
  assert.equal(afterHoursResumeLabel(), "08:00");
});

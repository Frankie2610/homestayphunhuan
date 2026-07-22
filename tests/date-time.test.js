import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  parseDateFromText,
  parseDurationFromText,
  parsePhone,
  parseStayWindowFromText,
  parseTimeFromText
} from "../lib/date-time.js";

const now = DateTime.fromISO("2026-07-11T19:00:00", { zone: "Asia/Ho_Chi_Minh" });

test("đọc ngày tương đối tiếng Việt", () => {
  assert.equal(parseDateFromText("hôm nay", now), "2026-07-11");
  assert.equal(parseDateFromText("ngày mai", now), "2026-07-12");
  assert.equal(parseDateFromText("ngày mốt", now), "2026-07-13");
});

test("đọc ngày dd/mm", () => {
  assert.equal(parseDateFromText("mình ở 20/07", now), "2026-07-20");
  assert.equal(parseDateFromText("20/07/2027", now), "2027-07-20");
});

test("đọc giờ có buổi", () => {
  assert.equal(parseTimeFromText("8 giờ tối"), 20 * 60);
  assert.equal(parseTimeFromText("20:30"), 20 * 60 + 30);
  assert.equal(parseTimeFromText("9h sáng"), 9 * 60);
});

test("đọc thời lượng", () => {
  assert.equal(parseDurationFromText("ở 4 tiếng"), 4);
  assert.equal(parseDurationFromText("combo 7h"), 7);
  assert.equal(parseDurationFromText("nghỉ qua đêm"), 12);
});

test("đọc số điện thoại", () => {
  assert.equal(parsePhone("0902 932 808"), "0902932808");
  assert.equal(parsePhone("abc"), null);
});

test("phân biệt check-in, check-out và combo", async () => {
  const { parseStayWindowFromText } = await import("../lib/date-time.js");
  assert.deepEqual(
    parseStayWindowFromText("checkin 13h checkout 17h", { state: "new" }),
    {
      checkInMinute: 13 * 60,
      checkOutMinute: 17 * 60,
      durationHours: 4,
      ambiguousBareHour: null,
      unsupportedDurationHours: null,
      suggestedDurations: [],
      conflict: null,
      source: ["labeled_checkin", "labeled_checkout", "duration_from_range"]
    }
  );
});

test("tính giờ check-in từ checkout và combo", async () => {
  const { parseStayWindowFromText } = await import("../lib/date-time.js");
  const result = parseStayWindowFromText("checkout 17h gói 4h", { state: "new" });
  assert.equal(result.checkInMinute, 13 * 60);
  assert.equal(result.checkOutMinute, 17 * 60);
  assert.equal(result.durationHours, 4);
});

test("nhận biết khung giờ không khớp combo", async () => {
  const { parseStayWindowFromText } = await import("../lib/date-time.js");
  const unsupported = parseStayWindowFromText("13h đến 18h", { state: "new" });
  assert.equal(unsupported.unsupportedDurationHours, 5);
  assert.deepEqual(unsupported.suggestedDurations, [4, 7]);

  const conflict = parseStayWindowFromText("checkin 13h checkout 17h gói 7h", { state: "new" });
  assert.equal(conflict.conflict.derivedDurationHours, 4);
  assert.equal(conflict.conflict.statedDurationHours, 7);
});

test("4h được hiểu theo trạng thái hội thoại", async () => {
  const { parseStayWindowFromText } = await import("../lib/date-time.js");
  assert.equal(parseStayWindowFromText("4h", { state: "awaiting_duration" }).durationHours, 4);
  assert.equal(parseStayWindowFromText("4h", { state: "awaiting_time" }).checkInMinute, 4 * 60);
  assert.equal(parseStayWindowFromText("4h", { state: "new" }).ambiguousBareHour, 4);
});

test("đọc combo trong câu hỏi giá mà không nhầm thành giờ check-in", () => {
  assert.equal(parseDurationFromText("HOME 1 giá 4H bao nhiêu?"), 4);
  const stay = parseStayWindowFromText("HOME 1 giá 4H bao nhiêu?");
  assert.equal(stay.durationHours, 4);
  assert.equal(stay.checkInMinute, null);
});

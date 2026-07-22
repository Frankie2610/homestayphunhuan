import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  bookingBlocks,
  normalizeBooking,
  normalizeRoomKey
} from "../lib/availability.js";
import { parseBackendDateTime } from "../lib/date-time.js";


test("room keys ignore spaces, accents and punctuation", () => {
  assert.equal(normalizeRoomKey(" Home - 1 "), "HOME1");
  assert.equal(normalizeRoomKey("HÔME 01"), "HOME01");
});


test("timezone-less booking ISO is interpreted in Asia/Ho_Chi_Minh", () => {
  const parsed = parseBackendDateTime("2026-07-11T13:00:00");
  assert.equal(parsed.zoneName, "Asia/Ho_Chi_Minh");
  assert.equal(parsed.toFormat("yyyy-MM-dd HH:mm"), "2026-07-11 13:00");
  assert.equal(parsed.toUTC().toFormat("HH:mm"), "06:00");
});


test("booking ISO with Z keeps the instant and converts to local time", () => {
  const parsed = parseBackendDateTime("2026-07-11T06:00:00.000Z");
  assert.equal(parsed.toFormat("yyyy-MM-dd HH:mm"), "2026-07-11 13:00");
});


test("normalizeBooking accepts local ISO and room aliases", () => {
  const booking = normalizeBooking({
    room: "HOME 1",
    checkIn: "2026-07-11T13:00:00",
    checkOut: "2026-07-11T17:00:00",
    bookingStatus: "confirmed"
  });
  assert.ok(booking);
  assert.equal(booking.roomKey, "HOME1");
  assert.equal(
    DateTime.fromMillis(booking.startMs, { zone: "Asia/Ho_Chi_Minh" }).toFormat("HH:mm"),
    "13:00"
  );
});


test("confirmed and valid pending bookings block; expired holds do not", () => {
  assert.equal(bookingBlocks({ bookingStatus: "confirmed" }), true);
  assert.equal(bookingBlocks({
    bookingStatus: "pending_payment",
    holdExpiresAt: Date.now() + 60_000
  }), true);
  assert.equal(bookingBlocks({
    bookingStatus: "pending_payment",
    holdExpiresAt: Date.now() - 60_000
  }), false);
  assert.equal(bookingBlocks({ bookingStatus: "cancelled" }), false);
});

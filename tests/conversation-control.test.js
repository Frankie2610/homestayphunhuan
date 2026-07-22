import test from "node:test";
import assert from "node:assert/strict";
import {
  isCustomerResumeRequest,
  normalizeControlMode,
  shouldPauseFromEcho
} from "../lib/conversation-control.js";

test("chuẩn hóa chế độ điều khiển", () => {
  assert.equal(normalizeControlMode("human"), "human");
  assert.equal(normalizeControlMode("BOT"), "bot");
  assert.equal(normalizeControlMode("unknown", "human"), "human");
});

test("chỉ auto pause khi echo không phải do bot gửi", () => {
  assert.equal(shouldPauseFromEcho({ knownBotMessage: true, autoPauseOnHumanReply: true }), false);
  assert.equal(shouldPauseFromEcho({ knownBotMessage: false, autoPauseOnHumanReply: true }), true);
  assert.equal(shouldPauseFromEcho({ knownBotMessage: false, autoPauseOnHumanReply: false }), false);
});

test("nhận biết yêu cầu khách bật bot lại", () => {
  assert.equal(isCustomerResumeRequest("bot kiểm tra tiếp"), true);
  assert.equal(isCustomerResumeRequest("Bật bot tư vấn giúp mình"), true);
  assert.equal(isCustomerResumeRequest("", "BOT|RESUME"), true);
  assert.equal(isCustomerResumeRequest("nhân viên tư vấn tiếp nhé"), false);
});

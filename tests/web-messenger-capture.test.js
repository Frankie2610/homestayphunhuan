import assert from "node:assert/strict";
import test from "node:test";
import {
  runWithWebMessengerCapture,
  sendButtonTemplate,
  sendImages,
  sendText,
  sendTyping
} from "../lib/messenger.js";

test("website capture returns text and quick replies without calling Meta", async () => {
  const recipientId = "web_1234567890abcdef";
  const captured = await runWithWebMessengerCapture(recipientId, async () => {
    await sendTyping(recipientId, true);
    await sendText(recipientId, "Xin chào", [
      { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }
    ]);
  });

  assert.equal(captured.messages.length, 1);
  assert.equal(captured.messages[0].type, "text");
  assert.equal(captured.messages[0].text, "Xin chào");
  assert.deepEqual(captured.messages[0].quickReplies, [
    { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" }
  ]);
});

test("website capture converts templates and image groups", async () => {
  const recipientId = "web_fedcba0987654321";
  const captured = await runWithWebMessengerCapture(recipientId, async () => {
    await sendButtonTemplate(recipientId, "HOME 1 đang còn lịch", [
      { type: "web_url", title: "Xem HOME", url: "https://example.com/HOME1" },
      { type: "postback", title: "Giữ phòng", payload: "HOLD|REQUEST" }
    ]);
    await sendImages(recipientId, [
      "https://example.com/1.jpg",
      "https://example.com/2.jpg"
    ]);
  });

  assert.equal(captured.messages.length, 2);
  assert.equal(captured.messages[0].type, "template");
  assert.equal(captured.messages[0].buttons[1].payload, "HOLD|REQUEST");
  assert.deepEqual(captured.messages[1].imageUrls, [
    "https://example.com/1.jpg",
    "https://example.com/2.jpg"
  ]);
});

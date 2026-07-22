import test from "node:test";
import assert from "node:assert/strict";
import {
  captureWebsiteDelivery,
  sendButtonTemplate,
  sendImages,
  sendText,
  sendTyping
} from "../lib/messenger.js";

test("website delivery captures Messenger chatbot output without calling Meta", async () => {
  const delivery = await captureWebsiteDelivery("web_test_session", async () => {
    await sendTyping("web_test_session", true);
    const textResult = await sendText("web_test_session", "Xin chào", [
      { title: "Kiểm tra lịch trống hôm nay", payload: "START|AVAILABILITY" }
    ]);
    assert.match(textResult.message_id, /^web_mid_/);

    await sendImages("web_test_session", [
      "https://example.com/home-1.jpg",
      "https://example.com/home-2.jpg"
    ]);

    await sendButtonTemplate("web_test_session", "Bạn muốn làm gì?", [
      { type: "postback", title: "Chọn HOME 1", payload: "HOME|HOME1" },
      { type: "web_url", title: "Mở lịch trống", url: "https://example.com/lich-trong" }
    ]);
    await sendTyping("web_test_session", false);
  });

  assert.equal(delivery.messages.length, 3);
  assert.equal(delivery.messages[0].type, "text");
  assert.equal(delivery.messages[0].text, "Xin chào");
  assert.equal(delivery.messages[0].quickReplies[0].title, "Kiểm tra lịch trống hôm nay");
  assert.equal(delivery.messages[1].type, "images");
  assert.equal(delivery.messages[1].imageUrls.length, 2);
  assert.equal(delivery.messages[2].type, "button_template");
  assert.equal(delivery.messages[2].buttons[0].title, "Chọn HOME 1");
  assert.equal(delivery.typing, false);
});

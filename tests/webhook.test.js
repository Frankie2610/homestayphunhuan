import test from "node:test";
import assert from "node:assert/strict";
import { extractIncomingContent } from "../api/meta-webhook.js";

test("webhook nhận được ảnh hoặc audio dù không có text", () => {
  assert.deepEqual(extractIncomingContent({
    sender: { id: "123" },
    message: { mid: "m_1", attachments: [{ type: "image" }] }
  }), {
    psid: "123",
    isEcho: false,
    text: "",
    payload: "",
    attachmentType: "image",
    messageId: "m_1",
    appId: ""
  });

  assert.equal(extractIncomingContent({
    sender: { id: "123" },
    message: { attachments: [{ type: "audio" }] }
  }).attachmentType, "audio");
});

test("message echo lấy PSID từ recipient thay vì Page sender", () => {
  assert.deepEqual(extractIncomingContent({
    sender: { id: "PAGE_ID" },
    recipient: { id: "CUSTOMER_PSID" },
    message: {
      mid: "echo_mid",
      is_echo: true,
      app_id: "app_123",
      text: "Nhân viên trả lời"
    }
  }), {
    psid: "CUSTOMER_PSID",
    isEcho: true,
    text: "Nhân viên trả lời",
    payload: "",
    attachmentType: "",
    messageId: "echo_mid",
    appId: "app_123"
  });
});

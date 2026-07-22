import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST, createStreamingResponse } from "../api/web-chat.js";

test("web chat health response is available without touching Firebase", async () => {
  const response = await GET();
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.channel, "website");
  assert.equal(data.streaming, true);
});

test("web chat streaming sends ready, message and done events in order", async () => {
  const response = createStreamingResponse({
    sessionId: "1234567890abcdef",
    psid: "web_1234567890abcdef",
    payload: "",
    eventId: "test_stream_success",
    processConversation: async onMessage => {
      onMessage({ type: "text", text: "Phản hồi trực tiếp" });
    }
  });
  const body = await response.text();
  const events = body
    .split(/\r?\n\r?\n/)
    .map(block => block.replace(/^data:\s*/, "").trim())
    .filter(Boolean)
    .map(value => JSON.parse(value));

  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.deepEqual(events.map(event => event.type), ["ready", "message", "done"]);
  assert.equal(events[1].message.text, "Phản hồi trực tiếp");
});

test("web chat rejects malformed sessions before database access", async () => {
  const response = await POST(new Request("https://example.com/api/web-chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "short", message: "Xin chào" })
  }));
  const data = await response.json();
  assert.equal(response.status, 400);
  assert.equal(data.error, "invalid_session");
});

test("web chat rejects cross-origin browser calls", async () => {
  const response = await POST(new Request("https://example.com/api/web-chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": "https://attacker.invalid"
    },
    body: JSON.stringify({
      sessionId: "1234567890abcdef",
      message: "Xin chào"
    })
  }));
  const data = await response.json();
  assert.equal(response.status, 403);
  assert.equal(data.error, "origin_not_allowed");
});

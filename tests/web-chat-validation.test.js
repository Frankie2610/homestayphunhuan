import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../api/web-chat.js";

test("web chat health response is available without touching Firebase", async () => {
  const response = await GET();
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.channel, "website");
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

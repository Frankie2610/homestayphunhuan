import test from "node:test";
import assert from "node:assert/strict";
import { GET, OPTIONS, POST } from "../api/web-chat.js";

test("web chat health endpoint responds without Firebase access", async () => {
  const response = await GET(new Request("https://example.com/api/web-chat", {
    headers: { origin: "https://example.com" }
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "website-ai-chat");
});

test("web chat allows localhost preview origins", async () => {
  const response = await OPTIONS(new Request("https://example.com/api/web-chat", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5500" }
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5500");
});

test("web chat rejects invalid sessions before touching Firebase", async () => {
  const response = await POST(new Request("https://example.com/api/web-chat", {
    method: "POST",
    headers: {
      origin: "https://example.com",
      "content-type": "application/json"
    },
    body: JSON.stringify({ sessionId: "x", message: "Xin chào" })
  }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "invalid_session");
});

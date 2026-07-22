import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyMetaSignature } from "../lib/meta-signature.js";

test("xác minh chữ ký webhook Meta", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ object: "page" });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(verifyMetaSignature(body + "x", signature, secret), false);
});

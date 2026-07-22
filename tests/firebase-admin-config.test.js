import assert from "node:assert/strict";
import test from "node:test";
import { __firebaseAdminTest } from "../lib/firebase-admin.js";

const SAMPLE_KEY = "-----BEGIN PRIVATE KEY-----\nTEST_KEY_BODY\n-----END PRIVATE KEY-----";

test("Firebase private key accepts literal newline escapes and wrapping quotes", () => {
  const value = `"${SAMPLE_KEY.replaceAll("\n", "\\n")}"`;
  const normalized = __firebaseAdminTest.normalizePrivateKey(value);
  assert.equal(normalized, `${SAMPLE_KEY}\n`);
});

test("Firebase service account accepts standard downloaded JSON", () => {
  const account = __firebaseAdminTest.normalizeServiceAccount(JSON.stringify({
    project_id: "demo-project",
    client_email: "firebase-adminsdk@example.test",
    private_key: SAMPLE_KEY.replaceAll("\n", "\\n")
  }));

  assert.equal(account.projectId, "demo-project");
  assert.equal(account.clientEmail, "firebase-adminsdk@example.test");
  assert.equal(account.privateKey, `${SAMPLE_KEY}\n`);
});

test("Firebase private key reports a clear error for an invalid value", () => {
  assert.throws(
    () => __firebaseAdminTest.normalizePrivateKey("not-a-private-key"),
    error => error?.code === "FIREBASE_PRIVATE_KEY_INVALID"
  );
});

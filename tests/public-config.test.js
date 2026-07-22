import test from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "PUBLIC_FIREBASE_API_KEY", "FIREBASE_API_KEY",
  "PUBLIC_FIREBASE_AUTH_DOMAIN", "FIREBASE_AUTH_DOMAIN",
  "PUBLIC_FIREBASE_DATABASE_URL", "FIREBASE_DATABASE_URL",
  "PUBLIC_FIREBASE_PROJECT_ID", "FIREBASE_PROJECT_ID",
  "PUBLIC_FIREBASE_STORAGE_BUCKET", "FIREBASE_STORAGE_BUCKET"
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

async function loadRoute() {
  return import(`../api/public-config.js?test=${Date.now()}-${Math.random()}`);
}

test("public config supports existing FIREBASE_* names", async () => {
  clearEnv();
  process.env.FIREBASE_API_KEY = "web-key";
  process.env.FIREBASE_AUTH_DOMAIN = "demo.firebaseapp.com";
  process.env.FIREBASE_DATABASE_URL = "https://demo-default-rtdb.firebaseio.com";
  process.env.FIREBASE_PROJECT_ID = "demo";
  process.env.FIREBASE_STORAGE_BUCKET = "demo.firebasestorage.app";

  const { GET } = await loadRoute();
  const response = await GET();
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.apiKey, "web-key");
  assert.equal(payload.projectId, "demo");
  assert.equal(payload.__diagnostics.databaseHost, "demo-default-rtdb.firebaseio.com");
});

test("public config does not cache missing-env errors", async () => {
  clearEnv();
  const { GET } = await loadRoute();
  const response = await GET();
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.error, "public_firebase_config_missing");
  assert.match(response.headers.get("cache-control") || "", /no-store/);
});

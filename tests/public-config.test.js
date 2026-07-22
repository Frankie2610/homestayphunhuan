import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicFirebaseConfig } from "../api/public-config.js";

test("public Firebase config is built from Vercel-style environment variables", () => {
  const config = buildPublicFirebaseConfig({
    FIREBASE_API_KEY: "public-api-key",
    FIREBASE_PROJECT_ID: "homestay3caynon",
    FIREBASE_DATABASE_URL: "https://homestay3caynon-default-rtdb.firebaseio.com"
  });

  assert.deepEqual(config, {
    apiKey: "public-api-key",
    authDomain: "homestay3caynon.firebaseapp.com",
    databaseURL: "https://homestay3caynon-default-rtdb.firebaseio.com",
    projectId: "homestay3caynon",
    storageBucket: "homestay3caynon.firebasestorage.app"
  });
});

test("public Firebase config rejects missing required values", () => {
  assert.throws(
    () => buildPublicFirebaseConfig({ FIREBASE_PROJECT_ID: "homestay3caynon" }),
    error => error?.code === "FIREBASE_PUBLIC_CONFIG_MISSING"
  );
});

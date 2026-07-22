import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { requireEnv } from "./config.js";

function stripWrappingQuotes(value) {
  const text = String(value ?? "").trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

function normalizePrivateKey(value) {
  return stripWrappingQuotes(value)
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();
}

function parseServiceAccountJson(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;

  let parsed = JSON.parse(raw);
  // Some dashboards may store the JSON as a quoted JSON string.
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON không phải JSON object hợp lệ");
  }

  if (parsed.private_key) parsed.private_key = normalizePrivateKey(parsed.private_key);
  return parsed;
}

function getCredentialConfig() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (String(serviceAccountJson || "").trim()) {
    return parseServiceAccountJson(serviceAccountJson);
  }

  return {
    projectId: stripWrappingQuotes(requireEnv("FIREBASE_PROJECT_ID")),
    clientEmail: stripWrappingQuotes(requireEnv("FIREBASE_CLIENT_EMAIL")),
    privateKey: normalizePrivateKey(requireEnv("FIREBASE_PRIVATE_KEY"))
  };
}

export function getAdminDatabase() {
  if (!getApps().length) {
    initializeApp({
      credential: cert(getCredentialConfig()),
      databaseURL: stripWrappingQuotes(requireEnv("FIREBASE_DATABASE_URL"))
    });
  }
  return getDatabase();
}

export function firebaseReadWithTimeout(
  promise,
  label = "firebase_read",
  timeoutMs = Number(process.env.WEB_CHAT_FIREBASE_READ_TIMEOUT_MS || 8_000)
) {
  let timer;
  const safeTimeout = Math.max(1_000, Number(timeoutMs || 8_000));
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}_timeout_after_${safeTimeout}ms`);
      error.code = "FIREBASE_READ_TIMEOUT";
      reject(error);
    }, safeTimeout);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

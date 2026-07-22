import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { requireEnv } from "./config.js";

function getCredentialConfig() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    const parsed = JSON.parse(serviceAccountJson);
    if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    return parsed;
  }

  return {
    projectId: requireEnv("FIREBASE_PROJECT_ID"),
    clientEmail: requireEnv("FIREBASE_CLIENT_EMAIL"),
    privateKey: requireEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n")
  };
}

export function getAdminDatabase() {
  if (!getApps().length) {
    initializeApp({
      credential: cert(getCredentialConfig()),
      databaseURL: requireEnv("FIREBASE_DATABASE_URL")
    });
  }
  return getDatabase();
}


export function firebaseReadWithTimeout(promise, label = "firebase_read", timeoutMs = Number(process.env.WEB_CHAT_FIREBASE_READ_TIMEOUT_MS || 8_000)) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}_timeout_after_${timeoutMs}ms`);
      error.code = "FIREBASE_READ_TIMEOUT";
      reject(error);
    }, Math.max(1_000, Number(timeoutMs || 8_000)));
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

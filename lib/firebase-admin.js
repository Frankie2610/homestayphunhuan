import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { requireEnv } from "./config.js";

function unwrapEnvValue(value = "") {
  let output = String(value || "").replace(/^\uFEFF/, "").trim();
  if (
    output.length >= 2
    && ((output.startsWith('"') && output.endsWith('"'))
      || (output.startsWith("'") && output.endsWith("'")))
  ) {
    if (output.startsWith('"')) {
      try {
        const parsed = JSON.parse(output);
        if (typeof parsed === "string") output = parsed;
      } catch {
        output = output.slice(1, -1);
      }
    } else {
      output = output.slice(1, -1);
    }
  }
  return String(output || "").trim();
}

function normalizePrivateKey(value = "") {
  const normalized = unwrapEnvValue(value)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "")
    .trim();

  if (
    !normalized.startsWith("-----BEGIN PRIVATE KEY-----")
    || !normalized.endsWith("-----END PRIVATE KEY-----")
  ) {
    const error = new Error("FIREBASE_PRIVATE_KEY không đúng định dạng PEM");
    error.code = "FIREBASE_PRIVATE_KEY_INVALID";
    throw error;
  }
  return `${normalized}\n`;
}

function normalizeServiceAccount(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    parsed = JSON.parse(unwrapEnvValue(parsed));
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON không phải JSON hợp lệ");
  }

  const projectId = unwrapEnvValue(parsed.project_id || parsed.projectId);
  const clientEmail = unwrapEnvValue(parsed.client_email || parsed.clientEmail);
  const privateKey = normalizePrivateKey(parsed.private_key || parsed.privateKey);
  if (!projectId || !clientEmail) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON thiếu project_id hoặc client_email");
  }
  return { projectId, clientEmail, privateKey };
}

function getCredentialConfig() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    try {
      return normalizeServiceAccount(serviceAccountJson);
    } catch (error) {
      const separateVariablesAvailable = Boolean(
        process.env.FIREBASE_PROJECT_ID
        && process.env.FIREBASE_CLIENT_EMAIL
        && process.env.FIREBASE_PRIVATE_KEY
      );
      if (!separateVariablesAvailable) throw error;
      console.warn("FIREBASE_SERVICE_ACCOUNT_JSON invalid; using separate Firebase variables", {
        code: error?.code || "INVALID_SERVICE_ACCOUNT_JSON"
      });
    }
  }

  // Also accept the common mistake of pasting the complete service-account
  // JSON into FIREBASE_PRIVATE_KEY on Vercel.
  const privateKeyValue = unwrapEnvValue(requireEnv("FIREBASE_PRIVATE_KEY"));
  if (privateKeyValue.startsWith("{")) {
    return normalizeServiceAccount(privateKeyValue);
  }

  return {
    projectId: unwrapEnvValue(requireEnv("FIREBASE_PROJECT_ID")),
    clientEmail: unwrapEnvValue(requireEnv("FIREBASE_CLIENT_EMAIL")),
    privateKey: normalizePrivateKey(privateKeyValue)
  };
}

export function getAdminDatabase() {
  if (!getApps().length) {
    initializeApp({
      credential: cert(getCredentialConfig()),
      databaseURL: unwrapEnvValue(requireEnv("FIREBASE_DATABASE_URL"))
    });
  }
  return getDatabase();
}

export async function getFirebaseAdminAccessToken() {
  getAdminDatabase();
  const app = getApps()[0];
  const credential = app?.options?.credential;
  if (!credential || typeof credential.getAccessToken !== "function") {
    const error = new Error("Firebase Admin credential không hỗ trợ access token");
    error.code = "FIREBASE_CREDENTIAL_UNAVAILABLE";
    throw error;
  }
  return credential.getAccessToken();
}

export function getFirebaseAdminEnvironmentStatus() {
  const credential = getCredentialConfig();
  const databaseURL = unwrapEnvValue(requireEnv("FIREBASE_DATABASE_URL"));
  let databaseHost = "";
  try {
    databaseHost = new URL(databaseURL).host;
  } catch {
    const error = new Error("FIREBASE_DATABASE_URL không đúng định dạng URL");
    error.code = "FIREBASE_DATABASE_URL_INVALID";
    throw error;
  }
  return {
    configured: true,
    credentialFormatValid: true,
    projectId: credential.projectId,
    databaseHost
  };
}

export const __firebaseAdminTest = {
  normalizePrivateKey,
  normalizeServiceAccount,
  unwrapEnvValue
};

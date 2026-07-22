import { getAdminDatabase, firebaseReadWithTimeout } from "../lib/firebase-admin.js";
import { config } from "../lib/config.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function envValue(name) {
  return String(process.env[name] || "").trim();
}

function envPresent(name) {
  return Boolean(envValue(name));
}

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
  return stripWrappingQuotes(value).replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function parseServiceAccountJson() {
  const raw = envValue("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  let parsed = JSON.parse(raw);
  if (typeof parsed === "string") parsed = JSON.parse(parsed);
  return parsed;
}

function credentialSummary() {
  try {
    const serviceAccount = parseServiceAccountJson();
    if (serviceAccount) {
      const key = normalizePrivateKey(serviceAccount.private_key || "");
      return {
        mode: "service_account_json",
        projectId: String(serviceAccount.project_id || ""),
        clientEmailDomain: String(serviceAccount.client_email || "").split("@")[1] || "",
        privateKeyFormat: key.includes("BEGIN PRIVATE KEY") && key.includes("END PRIVATE KEY"),
        parseError: ""
      };
    }

    const key = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || "");
    return {
      mode: "split_env",
      projectId: stripWrappingQuotes(process.env.FIREBASE_PROJECT_ID || ""),
      clientEmailDomain: stripWrappingQuotes(process.env.FIREBASE_CLIENT_EMAIL || "").split("@")[1] || "",
      privateKeyFormat: key.includes("BEGIN PRIVATE KEY") && key.includes("END PRIVATE KEY"),
      parseError: ""
    };
  } catch (error) {
    return {
      mode: "service_account_json",
      projectId: "",
      clientEmailDomain: "",
      privateKeyFormat: false,
      parseError: String(error?.message || error || "invalid_service_account_json").slice(0, 300)
    };
  }
}

function databaseSummary() {
  const raw = stripWrappingQuotes(process.env.FIREBASE_DATABASE_URL || "");
  try {
    const url = new URL(raw);
    return {
      present: true,
      validUrl: url.protocol === "https:",
      host: url.host,
      path: url.pathname,
      hasWrappingQuotes: envValue("FIREBASE_DATABASE_URL") !== raw
    };
  } catch {
    return {
      present: Boolean(raw),
      validUrl: false,
      host: "",
      path: "",
      hasWrappingQuotes: envValue("FIREBASE_DATABASE_URL") !== raw
    };
  }
}

export async function GET(request) {
  const expectedSecret = envValue("BOT_HEALTH_SECRET");
  const providedSecret = new URL(request.url).searchParams.get("secret") || "";

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({
      ok: false,
      error: "forbidden",
      hint: "Set BOT_HEALTH_SECRET on Vercel and call this endpoint with ?secret=..."
    }, 403);
  }

  const credentials = credentialSummary();
  const database = databaseSummary();
  const diagnostics = {
    firebaseEnv: {
      databaseUrl: envPresent("FIREBASE_DATABASE_URL"),
      projectId: envPresent("FIREBASE_PROJECT_ID"),
      clientEmail: envPresent("FIREBASE_CLIENT_EMAIL"),
      privateKey: envPresent("FIREBASE_PRIVATE_KEY"),
      serviceAccountJson: envPresent("FIREBASE_SERVICE_ACCOUNT_JSON")
    },
    credentials,
    database,
    projectAlignment: {
      projectIdMatchesClientEmail: credentials.projectId
        ? credentials.clientEmailDomain.includes(credentials.projectId)
        : false,
      databaseHostContainsProjectId: credentials.projectId
        ? database.host.includes(credentials.projectId)
        : false
    },
    gemini: {
      enabled: config.geminiEnabled,
      apiKeyPresent: Boolean(config.geminiApiKey),
      model: config.geminiModel,
      rewriteWebsite: config.webChatGeminiRewrite
    }
  };

  if (credentials.parseError) {
    return json({
      ok: false,
      stage: "firebase_credentials",
      error: "invalid_service_account_json",
      diagnostics
    }, 500);
  }

  if (!credentials.privateKeyFormat) {
    return json({
      ok: false,
      stage: "firebase_credentials",
      error: "invalid_private_key_format",
      diagnostics
    }, 500);
  }

  if (!database.validUrl) {
    return json({
      ok: false,
      stage: "firebase_database_url",
      error: "invalid_database_url",
      diagnostics
    }, 500);
  }

  const timeoutMs = Math.min(
    6_000,
    Math.max(2_000, Number(process.env.BOT_HEALTH_FIREBASE_TIMEOUT_MS || 4_500))
  );

  let db;
  try {
    db = getAdminDatabase();
  } catch (error) {
    return json({
      ok: false,
      firebase: false,
      stage: "firebase_initialization",
      errorCode: error?.code || error?.name || "firebase_initialization_error",
      error: String(error?.message || error || "unknown_error").slice(0, 600),
      diagnostics
    }, 500);
  }

  const startedAt = Date.now();
  try {
    const homesSnap = await firebaseReadWithTimeout(
      db.ref("homes").limitToFirst(1).get(),
      "health_homes_read",
      timeoutMs
    );

    return json({
      ok: true,
      firebase: true,
      latencyMs: Date.now() - startedAt,
      homesConfigured: homesSnap.exists(),
      diagnostics,
      timestamp: Date.now()
    });
  } catch (error) {
    const isTimeout = error?.code === "FIREBASE_READ_TIMEOUT";
    console.error("Chatbot health Firebase error", {
      name: error?.name || "",
      code: error?.code || "",
      message: String(error?.message || error || "unknown_error"),
      stack: String(error?.stack || "").slice(0, 2000)
    });

    return json({
      ok: false,
      firebase: false,
      stage: isTimeout ? "firebase_read_timeout" : "firebase_runtime",
      errorCode: error?.code || error?.name || "firebase_error",
      error: String(error?.message || error || "unknown_error").slice(0, 600),
      latencyMs: Date.now() - startedAt,
      timeoutMs,
      hints: isTimeout ? [
        "Copy FIREBASE_DATABASE_URL exactly from Firebase Console > Realtime Database.",
        "Make sure the service account belongs to the same Firebase project as the database URL.",
        "Prefer FIREBASE_SERVICE_ACCOUNT_JSON to avoid multiline private-key formatting issues."
      ] : [],
      diagnostics
    }, isTimeout ? 504 : 500);
  }
}

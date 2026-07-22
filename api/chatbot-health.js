import { getAdminDatabase } from "../lib/firebase-admin.js";
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

function envPresent(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function firebaseCredentialMode() {
  return envPresent("FIREBASE_SERVICE_ACCOUNT_JSON") ? "service_account_json" : "split_env";
}

function privateKeyLooksValid() {
  if (envPresent("FIREBASE_SERVICE_ACCOUNT_JSON")) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      const key = String(parsed?.private_key || "").replace(/\\n/g, "\n");
      return key.includes("BEGIN PRIVATE KEY") && key.includes("END PRIVATE KEY");
    } catch {
      return false;
    }
  }
  const key = String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return key.includes("BEGIN PRIVATE KEY") && key.includes("END PRIVATE KEY");
}

export async function GET(request) {
  const expectedSecret = String(process.env.BOT_HEALTH_SECRET || "").trim();
  const providedSecret = new URL(request.url).searchParams.get("secret") || "";

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return json({
      ok: false,
      error: "forbidden",
      hint: "Set BOT_HEALTH_SECRET on Vercel and call this endpoint with ?secret=..."
    }, 403);
  }

  const diagnostics = {
    credentialMode: firebaseCredentialMode(),
    firebaseEnv: {
      databaseUrl: envPresent("FIREBASE_DATABASE_URL"),
      projectId: envPresent("FIREBASE_PROJECT_ID"),
      clientEmail: envPresent("FIREBASE_CLIENT_EMAIL"),
      privateKey: envPresent("FIREBASE_PRIVATE_KEY"),
      serviceAccountJson: envPresent("FIREBASE_SERVICE_ACCOUNT_JSON"),
      privateKeyFormat: privateKeyLooksValid()
    },
    gemini: {
      enabled: config.geminiEnabled,
      apiKeyPresent: Boolean(config.geminiApiKey),
      model: config.geminiModel,
      rewriteWebsite: config.webChatGeminiRewrite
    }
  };

  if (!diagnostics.firebaseEnv.privateKeyFormat) {
    return json({
      ok: false,
      stage: "firebase_credentials",
      error: "invalid_private_key_format",
      diagnostics
    }, 500);
  }

  try {
    const db = getAdminDatabase();
    const startedAt = Date.now();
    const [homesSnap, pricingSnap] = await Promise.all([
      db.ref("homes").limitToFirst(1).get(),
      db.ref("roomPricing").limitToFirst(1).get()
    ]);

    return json({
      ok: true,
      firebase: true,
      latencyMs: Date.now() - startedAt,
      homesConfigured: homesSnap.exists(),
      roomPricingConfigured: pricingSnap.exists(),
      diagnostics,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error("Chatbot health Firebase error", {
      name: error?.name || "",
      code: error?.code || "",
      message: String(error?.message || error || "unknown_error"),
      stack: String(error?.stack || "").slice(0, 2000)
    });

    return json({
      ok: false,
      firebase: false,
      stage: "firebase_runtime",
      errorCode: error?.code || error?.name || "firebase_error",
      error: String(error?.message || error || "unknown_error").slice(0, 600),
      diagnostics
    }, 500);
  }
}

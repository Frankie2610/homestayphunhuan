function clean(value = "") {
  return String(value || "").replace(/^\uFEFF/, "").trim().replace(/^"|"$/g, "");
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) return value;
  }
  return "";
}

export function buildPublicFirebaseConfig(env = process.env) {
  const rawJson = firstEnv(env, ["FIREBASE_PUBLIC_CONFIG_JSON", "FIREBASE_PUBLIC_CONFIG"]);
  let supplied = {};
  if (rawJson) {
    supplied = JSON.parse(rawJson);
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
      throw new Error("FIREBASE_PUBLIC_CONFIG_JSON không hợp lệ");
    }
  }

  const projectId = clean(supplied.projectId) || firstEnv(env, [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_WEB_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID"
  ]);
  const config = {
    apiKey: clean(supplied.apiKey) || firstEnv(env, [
      "FIREBASE_API_KEY",
      "FIREBASE_WEB_API_KEY",
      "NEXT_PUBLIC_FIREBASE_API_KEY"
    ]),
    authDomain: clean(supplied.authDomain) || firstEnv(env, [
      "FIREBASE_AUTH_DOMAIN",
      "FIREBASE_WEB_AUTH_DOMAIN",
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"
    ]) || (projectId ? `${projectId}.firebaseapp.com` : ""),
    databaseURL: clean(supplied.databaseURL) || firstEnv(env, [
      "FIREBASE_DATABASE_URL",
      "FIREBASE_WEB_DATABASE_URL",
      "NEXT_PUBLIC_FIREBASE_DATABASE_URL"
    ]),
    projectId,
    storageBucket: clean(supplied.storageBucket) || firstEnv(env, [
      "FIREBASE_STORAGE_BUCKET",
      "FIREBASE_WEB_STORAGE_BUCKET",
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"
    ]) || (projectId ? `${projectId}.firebasestorage.app` : "")
  };

  const missing = Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    const error = new Error(`Thiếu Firebase public config: ${missing.join(", ")}`);
    error.code = "FIREBASE_PUBLIC_CONFIG_MISSING";
    throw error;
  }
  return config;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-content-type-options": "nosniff"
    }
  });
}

export async function GET() {
  try {
    return json(buildPublicFirebaseConfig());
  } catch (error) {
    console.error("Firebase public config error", {
      code: error?.code || "FIREBASE_PUBLIC_CONFIG_FAILED",
      error: error?.message || String(error)
    });
    return json({
      ok: false,
      code: error?.code || "FIREBASE_PUBLIC_CONFIG_FAILED",
      message: "Firebase public config chưa được cấu hình đầy đủ."
    }, 500);
  }
}

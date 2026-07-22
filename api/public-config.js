function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=3600"
    }
  });
}

function value(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

export async function GET() {
  const projectId = value("PUBLIC_FIREBASE_PROJECT_ID", process.env.FIREBASE_PROJECT_ID);
  const config = {
    apiKey: value("PUBLIC_FIREBASE_API_KEY"),
    authDomain: value("PUBLIC_FIREBASE_AUTH_DOMAIN", projectId ? `${projectId}.firebaseapp.com` : ""),
    databaseURL: value("PUBLIC_FIREBASE_DATABASE_URL", process.env.FIREBASE_DATABASE_URL),
    projectId,
    storageBucket: value("PUBLIC_FIREBASE_STORAGE_BUCKET", projectId ? `${projectId}.firebasestorage.app` : "")
  };

  const missing = Object.entries(config)
    .filter(([, item]) => !item)
    .map(([name]) => name);

  if (missing.length) {
    return json({
      ok: false,
      error: "public_firebase_config_missing",
      missing
    }, 503);
  }

  return json(config);
}

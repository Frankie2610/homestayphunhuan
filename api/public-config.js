function readEnv(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return "";
}

function json(data, status = 200) {
  const success = status >= 200 && status < 300;
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Không cache lỗi cấu hình. Response thành công chỉ cache ngắn.
      "cache-control": success
        ? "public, max-age=60, s-maxage=300, stale-while-revalidate=600"
        : "no-store, no-cache, max-age=0, must-revalidate",
      ...(success ? {} : { pragma: "no-cache", expires: "0" })
    }
  });
}

export async function GET() {
  const config = {
    apiKey: readEnv("PUBLIC_FIREBASE_API_KEY", "FIREBASE_API_KEY"),
    authDomain: readEnv("PUBLIC_FIREBASE_AUTH_DOMAIN", "FIREBASE_AUTH_DOMAIN"),
    databaseURL: readEnv("PUBLIC_FIREBASE_DATABASE_URL", "FIREBASE_DATABASE_URL"),
    projectId: readEnv("PUBLIC_FIREBASE_PROJECT_ID", "FIREBASE_PROJECT_ID"),
    storageBucket: readEnv("PUBLIC_FIREBASE_STORAGE_BUCKET", "FIREBASE_STORAGE_BUCKET")
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

  try {
    const databaseHost = new URL(config.databaseURL).hostname;
    return json({
      ...config,
      __diagnostics: {
        projectId: config.projectId,
        databaseHost
      }
    });
  } catch {
    return json({
      ok: false,
      error: "invalid_firebase_database_url"
    }, 503);
  }
}

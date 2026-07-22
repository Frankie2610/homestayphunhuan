import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function parseEnvFile(filename) {
  const fullPath = path.join(ROOT, filename);
  if (!existsSync(fullPath)) return;

  const content = readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = rawValue.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }

    process.env[key] = value;
  }
}

parseEnvFile(".env.local");
parseEnvFile(".env");
process.env.LOCAL_CHAT_SERVER = process.env.LOCAL_CHAT_SERVER || "true";

const API_ROUTES = new Map([
  ["/api/public-config", "./api/public-config.js"],
  ["/api/web-chat", "./api/web-chat.js"],
  ["/api/meta-webhook", "./api/meta-webhook.js"],
  ["/api/chatbot-health", "./api/chatbot-health.js"],
  ["/api/chatbot-debug-availability", "./api/chatbot-debug-availability.js"],
  ["/api/chatbot-test-alert", "./api/chatbot-test-alert.js"]
]);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readRequestBody(req, maxBytes = 64_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

async function handleApi(req, res, url, modulePath) {
  const method = String(req.method || "GET").toUpperCase();
  const module = await import(modulePath);
  const handler = module[method];

  if (typeof handler !== "function") {
    res.setHeader("allow", Object.keys(module).filter(key => ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(key)).join(", "));
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  let body;
  try {
    body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(req);
  } catch (error) {
    return sendJson(res, 413, { ok: false, error: String(error?.message || "request_too_large") });
  }

  const request = new Request(url, {
    method,
    headers: requestHeaders(req),
    body: body?.length ? body : undefined,
    duplex: body?.length ? "half" : undefined
  });

  try {
    const response = await handler(request);
    const responseBody = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    headers["content-length"] = String(responseBody.length);
    res.writeHead(response.status, headers);
    res.end(responseBody);
  } catch (error) {
    console.error("Local API error:", error);
    sendJson(res, 500, {
      ok: false,
      error: "local_api_failed",
      message: String(error?.message || error || "unknown_error")
    });
  }
}

function safeLocalPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return "";
  }
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, "");
  const resolved = path.resolve(ROOT, normalized);
  return resolved.startsWith(ROOT) ? resolved : "";
}

async function serveFile(req, res, filename) {
  try {
    const info = await stat(filename);
    if (!info.isFile()) return false;
    const data = await readFile(filename);
    const ext = path.extname(filename).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "content-length": String(data.length),
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=300"
    });
    if (String(req.method || "GET").toUpperCase() === "HEAD") res.end();
    else res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const origin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const url = new URL(req.url || "/", origin);
  const pathname = url.pathname.replace(/\/$/, "") || "/";

  const apiModule = API_ROUTES.get(pathname);
  if (apiModule) {
    await handleApi(req, res, url, apiModule);
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(res, 404, { ok: false, error: "api_route_not_found", path: pathname });
    return;
  }

  const aliases = {
    "/privacy-policy": "/privacy-policy.html",
    "/data-deletion": "/data-deletion.html",
    "/terms-of-service": "/terms-of-service.html"
  };
  const requestedPath = aliases[pathname] || pathname;
  const directFile = safeLocalPath(requestedPath === "/" ? "/index.html" : requestedPath);

  if (directFile && await serveFile(req, res, directFile)) return;

  if (!path.extname(pathname)) {
    if (await serveFile(req, res, path.join(ROOT, "index.html"))) return;
  }

  sendJson(res, 404, { ok: false, error: "static_file_not_found", path: pathname });
});

server.listen(PORT, HOST, () => {
  const firebaseConfigured = Boolean(
    process.env.FIREBASE_DATABASE_URL
    && (
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
    )
  );

  console.log("");
  console.log(`Website local: http://localhost:${PORT}`);
  console.log(`Web chat API: http://localhost:${PORT}/api/web-chat`);
  console.log(`Firebase: ${firebaseConfigured ? "đã có cấu hình" : "CHƯA có cấu hình"}`);
  if (!firebaseConfigured) {
    console.log("Hãy đặt .env.local ngang hàng với package.json.");
  }
  console.log("Nhấn Ctrl + C để dừng server.\n");
});

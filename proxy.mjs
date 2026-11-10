// Loopback-only key-injection proxy for magpie.
// Keys are read from the process environment at startup and held in memory only.
// They are never written to disk, never logged, and never echoed in a response.
// Log lines carry route, model name, status code and elapsed milliseconds only.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.KEY_PROXY_PORT || 3426);
const LOG_FILE = path.join(HERE, "proxy.log");
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP = 3;
const UPSTREAM_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "OPTIONS", "DELETE"]);

const ROUTES = {
  nvidia: { base: "https://integrate.api.nvidia.com/v1", env: "NVIDIA_API_KEY" },
  iteracompute: { base: "https://api.iteracompute.com/v1", env: "ITERACOMPUTE_API_KEY" },
};

const keys = new Map();
for (const [name, route] of Object.entries(ROUTES)) {
  const value = process.env[route.env];
  if (typeof value === "string" && value.trim() !== "") keys.set(name, value.trim());
}

// Every line reopens the file and the whole check-rotate-append is synchronous,
// so an in-flight request never sees a half-rotated log and no line is lost.
function rotateLog() {
  try { fs.rmSync(`${LOG_FILE}.${LOG_KEEP}`, { force: true }); } catch {}
  for (let i = LOG_KEEP - 1; i >= 1; i--) {
    try { fs.renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`); } catch {}
  }
  try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
}

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try {
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch {}
    if (size + Buffer.byteLength(entry) > LOG_MAX_BYTES) rotateLog();
    fs.appendFileSync(LOG_FILE, entry);
  } catch {}
}

// Node's fetch transparently decompresses bodies, so the upstream's
// content-encoding and content-length no longer describe the bytes we pipe on.
const REQUEST_HEADER_DROP = new Set([
  "host", "authorization", "connection", "content-length", "accept-encoding",
  "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization",
  "proxy-connection", "te", "trailer",
]);
const RESPONSE_HEADER_DROP = new Set([
  "connection", "transfer-encoding", "keep-alive", "upgrade", "proxy-authorization",
  "proxy-connection", "te", "trailer", "content-encoding", "content-length",
]);

function safePath(rest) {
  if (!rest.startsWith("/") || rest.startsWith("//")) return false;
  if (/[\u0000-\u001f\u007f]/.test(rest)) return false;
  return !rest.split("/").some((seg) => seg === ".." || seg === ".");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let route = "-";
  let model = "-";
  let logged = false;
  let timer = null;

  const done = () => {
    if (logged) return;
    logged = true;
    if (timer) clearTimeout(timer);
    log(`${route} model=${model} status=${res.statusCode} ms=${Date.now() - started}`);
  };
  res.on("close", done);

  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch {
    sendJson(res, 400, { error: { message: "bad request target", type: "proxy_error" } });
    return;
  }

  if (url.pathname === "/health") {
    const routes = Object.fromEntries(
      Object.entries(ROUTES).map(([name, r]) => [name, { upstream: r.base, keyPresent: keys.has(name) }]),
    );
    sendJson(res, 200, { ok: true, host: HOST, port: PORT, routes });
    return;
  }

  const match = /^\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { error: { message: "unknown route", type: "proxy_error" } });
    return;
  }
  route = match[1];
  const rest = match[2] || "/";
  const config = ROUTES[route];

  if (!config) {
    sendJson(res, 404, { error: { message: "unknown route", type: "proxy_error" } });
    return;
  }
  if (!ALLOWED_METHODS.has(req.method)) {
    sendJson(res, 405, { error: { message: "method not allowed", type: "proxy_error" } });
    return;
  }
  if (!safePath(rest)) {
    sendJson(res, 400, { error: { message: "bad upstream path", type: "proxy_error" } });
    return;
  }
  const key = keys.get(route);
  if (!key) {
    log(`${route} model=- status=503 ms=0 reason=env-key-missing`);
    sendJson(res, 503, {
      error: { message: `key-proxy: ${config.env} is not set in the environment`, type: "proxy_error" },
    });
    return;
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: { message: "request body too large", type: "proxy_error" } });
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    if (!res.headersSent) sendJson(res, 400, { error: { message: "request body read failed", type: "proxy_error" } });
    return;
  }
  const body = Buffer.concat(chunks);

  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      if (typeof parsed.model === "string") model = parsed.model.replace(/[\r\n\t]/g, " ").slice(0, 120);
    } catch {}
  }

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (REQUEST_HEADER_DROP.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers.authorization = `Bearer ${key}`;

  const controller = new AbortController();
  timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  const target = `${config.base}${rest}${url.search}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && body.length > 0;

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? body : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    // Deliberately not logging the exception: it may quote request details.
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: "key-proxy: upstream request failed", type: "proxy_error" } });
    } else {
      res.end();
    }
    return;
  }

  const outHeaders = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (RESPONSE_HEADER_DROP.has(name.toLowerCase())) continue;
    outHeaders[name] = value;
  }
  res.writeHead(upstream.status, outHeaders);
  res.flushHeaders();

  if (!upstream.body || req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.on("error", () => res.end());
  stream.pipe(res);
});

server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 75_000;

server.on("error", (err) => {
  log(`server-error code=${err.code || "unknown"}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const presence = Object.keys(ROUTES).map((n) => `${n}=${keys.has(n) ? "key-present" : "KEY-MISSING"}`).join(" ");
  log(`startup host=${HOST} port=${PORT} ${presence}`);
});
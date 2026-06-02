"use strict";

const http = require("http");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const {
  verifyWebhookQuery,
  verifyMetaSignature,
  handleIncomingPayload,
  getConfig: getWhatsAppConfig,
} = require("./services/whatsapp-cloud");

const PORT = Number(process.env.PORT || 7861);
const GATEWAY_PORT = Number(process.env.API_SERVER_PORT || 8642);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9119);
const TELEGRAM_WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT || 8765);
const GATEWAY_HOST = "127.0.0.1";
const startTime = Date.now();
const API_SERVER_KEY = process.env.API_SERVER_KEY || process.env.GATEWAY_TOKEN || "";
const APP_BASE = "/app";
const LOGIN_PATH = "/login";
const SESSION_COOKIE = "huggingmes_session";
const SYNC_STATUS_FILE = "/tmp/huggingmes-sync-status.json";
const CLOUDFLARE_KEEPALIVE_STATUS_FILE = "/tmp/huggingmes-cloudflare-keepalive-status.json";

function canConnect(port, host = GATEWAY_HOST, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readJson(path, fallback = null) {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {}
  return fallback;
}

function timingSafeEqualString(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function expectedSessionValue() {
  if (!API_SERVER_KEY) return "";
  return crypto.createHmac("sha256", API_SERVER_KEY).update("huggingmes-session-v1").digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function buildSessionCookie(req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(expectedSessionValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
}

function getBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : "";
}

function isAuthorized(req) {
  if (!API_SERVER_KEY) return true;
  return (
    timingSafeEqualString(getBearerToken(req), API_SERVER_KEY) ||
    timingSafeEqualString(parseCookies(req)[SESSION_COOKIE], expectedSessionValue())
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeNext(value) {
  if (!value || typeof value !== "string") return `${APP_BASE}/`;
  if (!value.startsWith("/") || value.startsWith("//")) return `${APP_BASE}/`;
  return value;
}

function loginUrl(nextPath) {
  return `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(nextPath))}`;
}

function renderLoginPage(nextPath, errorMessage = "") {
  const safeNext = sanitizeNext(nextPath);
  const errorHtml = errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HuggingMes Login</title><style>:root{color-scheme:dark;--bg:#10141f;--panel:#171d2b;--line:#293246;--text:#f4f7fb;--muted:#9aa7bd;--bad:#ef4444;--accent:#38bdf8}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:20px}main{width:min(440px,100%);border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:28px}p{color:var(--muted)}input,button{width:100%;min-height:44px;border-radius:7px;font:inherit}.error{border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.1);color:#fecaca;border-radius:7px;padding:10px 12px;margin-bottom:16px}button{margin-top:16px;border:0;background:var(--accent);font-weight:750}</style></head>
<body><main><h1>Open HuggingMes</h1><p>Enter the <code>GATEWAY_TOKEN</code> from your Space secrets.</p>${errorHtml}<form method="post" action="${LOGIN_PATH}"><input type="hidden" name="next" value="${escapeHtml(safeNext)}"><label for="token">GATEWAY_TOKEN</label><input id="token" name="token" type="password" autocomplete="current-password" autofocus required><button type="submit">Continue</button></form></main></body></html>`;
}

function readRequestBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  const parsed = new URL(req.url, "http://localhost");
  redirect(res, loginUrl(`${parsed.pathname}${parsed.search}`));
  return false;
}

function wantsHtml(req) {
  return String(req.headers.accept || "").includes("text/html");
}

async function handleLogin(req, res, parsed) {
  const nextPath = sanitizeNext(parsed.searchParams.get("next") || `${APP_BASE}/`);
  if (!API_SERVER_KEY) {
    redirect(res, nextPath);
    return;
  }
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderLoginPage(nextPath));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }
  try {
    const params = new URLSearchParams(await readRequestBody(req, 64 * 1024));
    const submittedToken = params.get("token") || "";
    const submittedNext = sanitizeNext(params.get("next") || nextPath);
    if (!timingSafeEqualString(submittedToken, API_SERVER_KEY)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderLoginPage(submittedNext, "That token did not match GATEWAY_TOKEN."));
      return;
    }
    res.writeHead(302, { location: submittedNext, "set-cookie": buildSessionCookie(req), "cache-control": "no-store" });
    res.end();
  } catch (error) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(error.message || "Invalid login request.");
  }
}

function proxyRequest(req, res, targetPort, rewritePath = (path) => path, headerOverrides = {}) {
  const parsed = new URL(req.url, "http://localhost");
  const targetPath = rewritePath(parsed.pathname) + parsed.search;
  const headers = {
    ...req.headers,
    ...headerOverrides,
    host: `${GATEWAY_HOST}:${targetPort}`,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
  };
  const proxy = http.request(
    { hostname: GATEWAY_HOST, port: targetPort, method: req.method, path: targetPath, headers },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxy.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: "Upstream service is unavailable." }));
  });
  req.pipe(proxy);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { location });
  res.end();
}

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function statusPayload() {
  const gateway = await canConnect(GATEWAY_PORT);
  const dashboard = await canConnect(DASHBOARD_PORT);
  const telegramWebhook = !!process.env.TELEGRAM_WEBHOOK_URL && (await canConnect(TELEGRAM_WEBHOOK_PORT));
  const whatsapp = getWhatsAppConfig();
  const sync = readJson(
    SYNC_STATUS_FILE,
    process.env.HF_TOKEN
      ? { status: "configured", message: "Backup is enabled; waiting for the first sync." }
      : { status: "disabled", message: "HF_TOKEN is not configured." },
  );
  return {
    ok: gateway,
    uptime: formatUptime(Date.now() - startTime),
    startedAt: new Date(startTime).toISOString(),
    gateway,
    dashboard,
    authConfigured: !!API_SERVER_KEY,
    ports: { public: PORT, gateway: GATEWAY_PORT, dashboard: DASHBOARD_PORT, telegramWebhook: TELEGRAM_WEBHOOK_PORT },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
      webhook: !!process.env.TELEGRAM_WEBHOOK_URL,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
      webhookListening: telegramWebhook,
      proxy: process.env.CLOUDFLARE_PROXY_URL || "",
    },
    whatsapp: {
      provider: whatsapp.provider,
      configured: !!(whatsapp.accessToken && whatsapp.phoneNumberId && whatsapp.verifyToken && whatsapp.allowedNumbers.size),
      allowedNumbers: whatsapp.allowedNumbers.size,
      graphApiVersion: whatsapp.graphApiVersion,
      webhookPath: "/whatsapp/webhook",
    },
    model: process.env.MODEL_FOR_CONFIG || process.env.HERMES_MODEL || process.env.LLM_MODEL || "",
    provider: process.env.PROVIDER_FOR_CONFIG || process.env.HERMES_INFERENCE_PROVIDER || "auto",
    backup: sync,
    keepalive: readJson(CLOUDFLARE_KEEPALIVE_STATUS_FILE, null),
  };
}

function toneBadge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function renderTile({ title, value, detail = "", tone = "neutral" }) {
  return `<article class="tile ${tone}"><div class="tile-title">${escapeHtml(title)}</div><div class="tile-value">${value}</div>${detail ? `<div class="tile-detail">${detail}</div>` : ""}</article>`;
}

function renderDashboard(data) {
  const whatsappTone = data.whatsapp.configured ? "ok" : "warn";
  const telegramTone = data.telegram.configured ? "ok" : "warn";
  const syncStatus = String(data.backup?.status || "unknown");
  const tiles = [
    renderTile({ title: "Gateway", value: toneBadge(data.gateway ? "Online" : "Offline", data.gateway ? "ok" : "off"), detail: data.authConfigured ? "Protected" : "Unprotected", tone: data.gateway ? "ok" : "off" }),
    renderTile({ title: "Model", value: `<code>${escapeHtml(data.model || "Not set")}</code>`, detail: `Provider: ${escapeHtml(data.provider || "auto")}`, tone: data.model ? "ok" : "warn" }),
    renderTile({ title: "WhatsApp", value: toneBadge(data.whatsapp.configured ? "Configured" : "Disabled", whatsappTone), detail: `${escapeHtml(data.whatsapp.provider)} webhook at <code>${data.whatsapp.webhookPath}</code>`, tone: whatsappTone }),
    renderTile({ title: "Telegram", value: toneBadge(data.telegram.configured ? "Configured" : "Disabled", telegramTone), detail: data.telegram.configured ? "Backward-compatible" : "Not required", tone: telegramTone }),
    renderTile({ title: "Backup", value: toneBadge(syncStatus.toUpperCase(), syncStatus === "disabled" ? "warn" : "ok"), detail: escapeHtml(data.backup?.message || "No status yet"), tone: syncStatus === "disabled" ? "warn" : "ok" }),
    renderTile({ title: "Runtime", value: escapeHtml(data.uptime), detail: `Port ${data.ports.public}`, tone: "neutral" }),
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>HuggingMes</title><style>:root{color-scheme:dark;--bg:#08080f;--panel:#12111b;--line:#26243a;--text:#f6f4ff;--muted:#9a93bd;--good:#22c55e;--warn:#f5c542;--bad:#fb7185;--accent:#7c6cf2}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--text)}main{width:min(760px,calc(100% - 32px));margin:0 auto;padding:36px 0 44px}header{text-align:center;margin-bottom:22px}.hero-action{display:flex;width:100%;min-height:46px;align-items:center;justify-content:center;border-radius:8px;background:#fff;color:#000;text-decoration:none;font-weight:850;margin:24px 0 20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.tile{border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:16px}.tile-title{color:var(--muted);font-size:.78rem;text-transform:uppercase;font-weight:800}.tile-value{font-size:1.05rem;margin-top:8px}.tile-detail{color:var(--muted);margin-top:8px}.badge{border-radius:999px;padding:3px 8px;font-weight:800}.badge.ok{color:var(--good)}.badge.warn{color:var(--warn)}.badge.off{color:var(--bad)}code{color:#c4b5fd}</style></head><body><main><header><h1>HuggingMes</h1><p>Self-hosted Hermes Agent gateway with WhatsApp Cloud API support.</p></header><a class="hero-action" href="${APP_BASE}/">Open Hermes Agent →</a><section class="grid">${tiles}</section></main></body></html>`;
}

async function handleWhatsAppWebhook(req, res, parsed) {
  if (req.method === "GET") {
    const verification = verifyWebhookQuery(parsed.searchParams);
    if (!verification.ok) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Forbidden");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(verification.challenge);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }

  let rawBody = "";
  try {
    rawBody = await readRequestBody(req);
    const signature = verifyMetaSignature({ rawBody, signatureHeader: req.headers["x-hub-signature-256"] });
    if (!signature.ok) {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "invalid_signature" }));
      return;
    }
    const payload = rawBody ? JSON.parse(rawBody) : {};
    handleIncomingPayload(payload).catch((error) => {
      console.error(`[whatsapp] async processing failed: ${error.message}`);
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    console.error(`[whatsapp] webhook request rejected: ${error.message}`);
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "bad_request" }));
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  if (path === LOGIN_PATH) {
    await handleLogin(req, res, parsed);
    return;
  }
  if (path === "/whatsapp/webhook") {
    await handleWhatsAppWebhook(req, res, parsed);
    return;
  }
  if (path === "/health" || path === `${APP_BASE}/health`) {
    const data = await statusPayload();
    res.writeHead(data.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: data.ok, gateway: data.gateway, uptime: data.uptime }));
    return;
  }
  if (path === "/status" || path === `${APP_BASE}/status`) {
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }
  if (path === "/") {
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard(data));
    return;
  }
  if (path === "/dashboard" || path === "/dashboard/") {
    redirect(res, `${APP_BASE}/${parsed.search}`);
    return;
  }
  if (path === "/telegram" || path.startsWith("/telegram/")) {
    proxyRequest(req, res, TELEGRAM_WEBHOOK_PORT);
    return;
  }
  if (path === APP_BASE || path.startsWith(`${APP_BASE}/`)) {
    if (!requireAuth(req, res)) return;
    proxyRequest(req, res, DASHBOARD_PORT, (p) => p.replace(/^\/app/, "") || "/");
    return;
  }
  if (
    path === "/favicon.ico" ||
    path.startsWith("/assets/") ||
    path.startsWith("/api/") ||
    path.startsWith("/dashboard-plugins/") ||
    path.startsWith("/ds-assets/")
  ) {
    if (!requireAuth(req, res)) return;
    proxyRequest(req, res, DASHBOARD_PORT);
    return;
  }
  if (["/analytics", "/chat", "/config", "/cron", "/docs", "/env", "/logs", "/models", "/plugins", "/profiles", "/sessions", "/skills"].some((route) => path === route || path.startsWith(`${route}/`))) {
    redirect(res, `${APP_BASE}${path}${parsed.search}`);
    return;
  }
  if (path === "/v1" || path.startsWith("/v1/")) {
    if (!isAuthorized(req)) {
      if (wantsHtml(req)) {
        redirect(res, loginUrl(`${path}${parsed.search}`));
        return;
      }
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "unauthorized", message: "Use Authorization: Bearer <GATEWAY_TOKEN>." }));
      return;
    }
    const upstreamHeaders = getBearerToken(req) || !API_SERVER_KEY ? {} : { authorization: `Bearer ${API_SERVER_KEY}` };
    proxyRequest(req, res, GATEWAY_PORT, (p) => p, upstreamHeaders);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HuggingMes dashboard listening on 0.0.0.0:${PORT}`);
  console.log("WhatsApp Cloud API webhook available at /whatsapp/webhook");
});

module.exports = { server, statusPayload, handleWhatsAppWebhook };

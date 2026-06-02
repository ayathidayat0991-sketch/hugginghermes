"use strict";

const crypto = require("crypto");
const { sendMessage: sendHermesMessage } = require("./hermes-client");

const DEFAULT_GRAPH_VERSION = "v20.0";
const MAX_WHATSAPP_TEXT_LENGTH = 3900;
const processedMessageIds = new Map();
const IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;

function log(level, message, details = undefined) {
  const safeDetails = details ? JSON.stringify(details) : "";
  console[level](`[whatsapp] ${message}${safeDetails ? ` ${safeDetails}` : ""}`);
}

function getConfig(env = process.env) {
  return {
    provider: (env.WHATSAPP_PROVIDER || "cloud").toLowerCase(),
    accessToken: env.WHATSAPP_ACCESS_TOKEN || "",
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || "",
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || "",
    allowedNumbers: new Set(
      String(env.WHATSAPP_ALLOWED_NUMBERS || "")
        .split(",")
        .map((item) => normalizePhone(item))
        .filter(Boolean),
    ),
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION || DEFAULT_GRAPH_VERSION,
    appSecret: env.WHATSAPP_APP_SECRET || "",
    rejectUnauthorized: String(env.WHATSAPP_REJECT_UNAUTHORIZED || "false").toLowerCase() === "true",
  };
}

function normalizePhone(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function timingSafeEqualString(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyWebhookQuery(searchParams, env = process.env) {
  const config = getConfig(env);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && timingSafeEqualString(token, config.verifyToken)) {
    return { ok: true, challenge: challenge || "" };
  }
  return { ok: false };
}

function verifyMetaSignature({ rawBody, signatureHeader, env = process.env }) {
  const { appSecret } = getConfig(env);
  if (!appSecret) return { ok: true, skipped: true };
  const signature = String(signatureHeader || "").replace(/^sha256=/i, "");
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody || "").digest("hex");
  return { ok: timingSafeEqualString(signature, expected), skipped: false };
}

function extractTextMessages(payload) {
  const messages = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      if (Array.isArray(value.statuses) && !Array.isArray(value.messages)) continue;
      const contactsByWaId = new Map((value.contacts || []).map((contact) => [contact?.wa_id, contact]));
      for (const message of value.messages || []) {
        if (message.from === value.metadata?.phone_number_id) continue;
        const from = normalizePhone(message.from || contactsByWaId.get(message.from)?.wa_id);
        const body = message.type === "text" ? String(message.text?.body || "").trim() : "";
        messages.push({
          id: message.id || "",
          from,
          body,
          type: message.type || "unknown",
          timestamp: message.timestamp || "",
          raw: message,
        });
      }
    }
  }
  return messages;
}

function pruneProcessed(now = Date.now()) {
  for (const [id, timestamp] of processedMessageIds.entries()) {
    if (now - timestamp > IDEMPOTENCY_TTL_MS) processedMessageIds.delete(id);
  }
}

function markProcessed(messageId) {
  if (!messageId) return false;
  pruneProcessed();
  if (processedMessageIds.has(messageId)) return false;
  processedMessageIds.set(messageId, Date.now());
  return true;
}

function splitWhatsAppText(text, maxLength = MAX_WHATSAPP_TEXT_LENGTH) {
  const input = String(text || "").trim();
  if (!input) return [];
  const chunks = [];
  let remaining = input;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    const splitAt = sentenceBreak > Math.floor(maxLength * 0.6) ? sentenceBreak + 1 : window.lastIndexOf(" ");
    const end = splitAt > Math.floor(maxLength * 0.4) ? splitAt : maxLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendWhatsAppText(to, text, { env = process.env, fetchImpl = global.fetch } = {}) {
  const config = getConfig(env);
  if (config.provider !== "cloud") throw new Error(`Unsupported WhatsApp provider: ${config.provider}`);
  if (!config.accessToken || !config.phoneNumberId) throw new Error("WhatsApp Cloud API credentials are not configured");
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available");

  const url = `https://graph.facebook.com/${encodeURIComponent(config.graphApiVersion)}/${encodeURIComponent(config.phoneNumberId)}/messages`;
  const responses = [];
  for (const chunk of splitWhatsAppText(text)) {
    const body = {
      messaging_product: "whatsapp",
      to: normalizePhone(to),
      type: "text",
      text: {
        preview_url: false,
        body: chunk,
      },
    };
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let errorMessage = `WhatsApp send failed (${response.status})`;
      try {
        const errorBody = await response.json();
        errorMessage = errorBody?.error?.message || errorMessage;
      } catch {}
      throw new Error(errorMessage);
    }
    responses.push(await response.json().catch(() => ({})));
  }
  return responses;
}

async function handleIncomingPayload(payload, options = {}) {
  const env = options.env || process.env;
  const config = getConfig(env);
  const hermesClient = options.hermesClient || sendHermesMessage;
  const sendText = options.sendText || ((to, text) => sendWhatsAppText(to, text, options));
  const results = [];

  if (config.provider === "baileys") {
    log("warn", "WHATSAPP_PROVIDER=baileys is documented as optional but is not started by this webhook route");
    return { processed: 0, ignored: true, results };
  }

  for (const message of extractTextMessages(payload)) {
    if (!message.id || !markProcessed(message.id)) {
      log("debug", "duplicate message ignored", { messageId: message.id || "missing" });
      results.push({ messageId: message.id, status: "duplicate" });
      continue;
    }
    if (message.type !== "text" || !message.body) {
      results.push({ messageId: message.id, status: "ignored" });
      continue;
    }
    if (!config.allowedNumbers.has(message.from)) {
      log("warn", "message rejected by whitelist", { from: message.from, messageId: message.id });
      if (config.rejectUnauthorized) {
        await sendText(message.from, "Maaf, nomor ini tidak diizinkan menggunakan bot ini.");
      }
      results.push({ messageId: message.id, status: "rejected" });
      continue;
    }

    try {
      log("info", "forwarding message to Hermes", { from: message.from, messageId: message.id });
      const reply = await hermesClient({
        userId: `whatsapp:${message.from}`,
        text: message.body,
        metadata: {
          channel: "whatsapp",
          whatsapp_message_id: message.id,
          whatsapp_sender: message.from,
        },
      });
      await sendText(message.from, reply.text || "Hermes did not return a response.");
      results.push({ messageId: message.id, status: "processed" });
    } catch (error) {
      log("error", "failed to process message", { from: message.from, messageId: message.id, error: error.message });
      await sendText(message.from, "Maaf, Hermes sedang mengalami gangguan. Coba lagi sebentar lagi.").catch(() => {});
      results.push({ messageId: message.id, status: "error" });
    }
  }
  return { processed: results.filter((item) => item.status === "processed").length, results };
}

function resetIdempotencyCache() {
  processedMessageIds.clear();
}

module.exports = {
  DEFAULT_GRAPH_VERSION,
  MAX_WHATSAPP_TEXT_LENGTH,
  getConfig,
  normalizePhone,
  verifyWebhookQuery,
  verifyMetaSignature,
  extractTextMessages,
  splitWhatsAppText,
  sendWhatsAppText,
  handleIncomingPayload,
  markProcessed,
  resetIdempotencyCache,
};

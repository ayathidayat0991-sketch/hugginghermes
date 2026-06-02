"use strict";

const http = require("http");

const DEFAULT_HISTORY_LIMIT = 12;
const conversations = new Map();

function redact(value) {
  return value ? "[redacted]" : "";
}

function getGatewayConfig(env = process.env) {
  return {
    host: env.API_SERVER_HOST || "127.0.0.1",
    port: Number(env.API_SERVER_PORT || 8642),
    token: env.API_SERVER_KEY || env.GATEWAY_TOKEN || "",
    model:
      env.MODEL_FOR_CONFIG ||
      env.HERMES_MODEL ||
      env.LLM_MODEL ||
      env.WHATSAPP_HERMES_MODEL ||
      "default",
    timeoutMs: Number(env.HERMES_CLIENT_TIMEOUT_MS || 120000),
    historyLimit: Number(env.HERMES_SESSION_HISTORY_LIMIT || DEFAULT_HISTORY_LIMIT),
  };
}

function requestJson({ host, port, token, timeoutMs }, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: host,
        port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          let parsed;
          try {
            parsed = responseBody ? JSON.parse(responseBody) : {};
          } catch (error) {
            reject(new Error(`Hermes returned invalid JSON (${res.statusCode})`));
            return;
          }
          if ((res.statusCode || 500) >= 400) {
            const message = parsed?.error?.message || parsed?.message || `Hermes request failed (${res.statusCode})`;
            reject(new Error(message));
            return;
          }
          resolve(parsed);
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("Hermes request timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function extractAssistantText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
  }
  if (typeof content === "string") return content.trim();
  if (typeof response?.text === "string") return response.text.trim();
  return "";
}

async function sendMessage({ userId, text, metadata = {}, env = process.env } = {}) {
  if (!userId) throw new Error("userId is required");
  if (!text || !String(text).trim()) throw new Error("text is required");

  const config = getGatewayConfig(env);
  const sessionId = String(userId);
  const prior = conversations.get(sessionId) || [];
  const userMessage = { role: "user", content: String(text).trim() };
  const messages = [...prior, userMessage];

  const payload = {
    model: config.model,
    messages,
    user: sessionId,
    metadata: {
      ...metadata,
      session_id: sessionId,
    },
  };

  const response = await requestJson(config, payload);
  const assistantText = extractAssistantText(response) || "Hermes did not return a text response.";
  const nextHistory = [...messages, { role: "assistant", content: assistantText }].slice(
    -Math.max(2, config.historyLimit) * 2,
  );
  conversations.set(sessionId, nextHistory);
  return { text: assistantText, raw: response };
}

function resetSessions() {
  conversations.clear();
}

module.exports = {
  sendMessage,
  resetSessions,
  getGatewayConfig,
  extractAssistantText,
  redact,
};

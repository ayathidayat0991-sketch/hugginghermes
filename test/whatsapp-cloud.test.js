"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  verifyWebhookQuery,
  extractTextMessages,
  handleIncomingPayload,
  sendWhatsAppText,
  resetIdempotencyCache,
} = require("../services/whatsapp-cloud");

function env(overrides = {}) {
  return {
    WHATSAPP_PROVIDER: "cloud",
    WHATSAPP_ACCESS_TOKEN: "test-token",
    WHATSAPP_PHONE_NUMBER_ID: "12345",
    WHATSAPP_VERIFY_TOKEN: "verify-me",
    WHATSAPP_ALLOWED_NUMBERS: "6281234567890",
    WHATSAPP_GRAPH_API_VERSION: "v20.0",
    ...overrides,
  };
}

function payload({ from = "6281234567890", id = "wamid.1", body = "Halo" } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "12345" },
              contacts: [{ wa_id: from }],
              messages: [{ from, id, timestamp: "1710000000", type: "text", text: { body } }],
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

test("GET webhook verify succeeds when token matches", () => {
  const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "abc" });
  assert.deepEqual(verifyWebhookQuery(params, env()), { ok: true, challenge: "abc" });
});

test("GET webhook verify fails when token is wrong", () => {
  const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "abc" });
  assert.deepEqual(verifyWebhookQuery(params, env()), { ok: false });
});

test("POST webhook ignores status events", async () => {
  resetIdempotencyCache();
  const statusPayload = { entry: [{ changes: [{ value: { statuses: [{ id: "status-1", status: "read" }] } }] }] };
  let hermesCalls = 0;
  const result = await handleIncomingPayload(statusPayload, {
    env: env(),
    hermesClient: async () => {
      hermesCalls += 1;
      return { text: "no" };
    },
    sendText: async () => {},
  });
  assert.equal(result.processed, 0);
  assert.equal(hermesCalls, 0);
});

test("POST webhook rejects non-whitelisted numbers", async () => {
  resetIdempotencyCache();
  let hermesCalls = 0;
  let sends = 0;
  const result = await handleIncomingPayload(payload({ from: "6280000000000", id: "wamid.reject" }), {
    env: env(),
    hermesClient: async () => {
      hermesCalls += 1;
      return { text: "no" };
    },
    sendText: async () => {
      sends += 1;
    },
  });
  assert.equal(result.results[0].status, "rejected");
  assert.equal(hermesCalls, 0);
  assert.equal(sends, 0);
});

test("POST webhook calls Hermes client for whitelisted number", async () => {
  resetIdempotencyCache();
  const calls = [];
  const sends = [];
  const result = await handleIncomingPayload(payload({ id: "wamid.allowed", body: "Apa kabar?" }), {
    env: env(),
    hermesClient: async (message) => {
      calls.push(message);
      return { text: "Baik." };
    },
    sendText: async (to, text) => {
      sends.push({ to, text });
    },
  });
  assert.equal(result.processed, 1);
  assert.equal(calls[0].userId, "whatsapp:6281234567890");
  assert.equal(calls[0].text, "Apa kabar?");
  assert.deepEqual(sends, [{ to: "6281234567890", text: "Baik." }]);
});

test("sendWhatsAppText forms Graph API payload correctly", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ messages: [{ id: "wamid.sent" }] }) };
  };
  await sendWhatsAppText("+62 812-3456-7890", "Hello", { env: env(), fetchImpl });
  assert.equal(requests[0].url, "https://graph.facebook.com/v20.0/12345/messages");
  assert.equal(requests[0].options.headers.authorization, "Bearer test-token");
  assert.deepEqual(requests[0].body, {
    messaging_product: "whatsapp",
    to: "6281234567890",
    type: "text",
    text: { preview_url: false, body: "Hello" },
  });
});

test("duplicate message id is not processed twice", async () => {
  resetIdempotencyCache();
  let hermesCalls = 0;
  const options = {
    env: env(),
    hermesClient: async () => {
      hermesCalls += 1;
      return { text: "ok" };
    },
    sendText: async () => {},
  };
  const first = await handleIncomingPayload(payload({ id: "wamid.dup" }), options);
  const second = await handleIncomingPayload(payload({ id: "wamid.dup" }), options);
  assert.equal(first.processed, 1);
  assert.equal(second.results[0].status, "duplicate");
  assert.equal(hermesCalls, 1);
});

test("health server webhook verify endpoint works over HTTP", async () => {
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
  process.env.PORT = "0";
  const { server } = require("../health-server");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${address.port}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=ok`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    }).on("error", reject);
  });
  assert.deepEqual(body, { status: 200, data: "ok" });
  await new Promise((resolve) => server.close(resolve));
});

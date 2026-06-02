---
title: HuggingMes
emoji: 🪽
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7861
pinned: true
license: mit
secrets:
  - name: LLM_API_KEY
    description: Your LLM provider API key.
  - name: LLM_MODEL
    description: Model/provider ID such as openai/gpt-4o or openrouter/anthropic/claude-sonnet-4.
  - name: GATEWAY_TOKEN
    description: Strong token that secures the dashboard and /v1 API.
  - name: HF_TOKEN
    description: Hugging Face token with write access for state backup.
  - name: WHATSAPP_ACCESS_TOKEN
    description: Meta WhatsApp Cloud API access token.
  - name: WHATSAPP_PHONE_NUMBER_ID
    description: WhatsApp Cloud API Phone Number ID.
  - name: WHATSAPP_VERIFY_TOKEN
    description: Secret string used by Meta webhook verification.
  - name: WHATSAPP_ALLOWED_NUMBERS
    description: Comma-separated allowed WhatsApp numbers in international format without plus signs.
  - name: WHATSAPP_GRAPH_API_VERSION
    description: Meta Graph API version, default v20.0.
---

# HuggingMes

HuggingMes runs the Nous Research Hermes Agent gateway on Hugging Face Spaces and wraps it with:

- A protected public dashboard at `/app/`.
- A protected OpenAI-compatible API at `/v1/*` using `Authorization: Bearer <GATEWAY_TOKEN>`.
- Optional Hugging Face Dataset backup/restore for Hermes state.
- Optional Cloudflare keep-alive/proxy helpers.
- WhatsApp Cloud API chat integration at `/whatsapp/webhook`.
- Backward-compatible Telegram configuration when the underlying Hermes image supports it.

## Architecture

```text
WhatsApp user
  -> Meta WhatsApp Cloud API webhook
  -> GET/POST /whatsapp/webhook on HuggingMes
  -> services/whatsapp-cloud.js validates token/signature, whitelist, idempotency
  -> services/hermes-client.js calls local Hermes /v1/chat/completions
  -> WhatsApp Cloud API /messages sends Hermes reply back to the user
```

The public health/dashboard server is `health-server.js`. It also proxies dashboard routes to the Hermes dashboard port and `/v1/*` to the local Hermes gateway port. `start.sh` prepares environment, state directories, provider mappings, backup restore, then starts the health server, Hermes dashboard, Hermes gateway, and backup loop.

## Quick Start on Hugging Face Spaces

1. Duplicate this Space.
2. Add secrets in **Settings → Variables and secrets**:
   - `LLM_API_KEY`
   - `LLM_MODEL`
   - `GATEWAY_TOKEN`
   - `HF_TOKEN` (optional but recommended for persistence)
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_VERIFY_TOKEN`
   - `WHATSAPP_ALLOWED_NUMBERS`
   - `WHATSAPP_GRAPH_API_VERSION` (optional, defaults to `v20.0`)
3. Restart the Space.
4. Open `/status` to confirm WhatsApp is configured without exposing tokens.

## WhatsApp Setup

### 1. Create a Meta app

1. Open Meta for Developers and create an app.
2. Add the **WhatsApp** product.
3. Enable **WhatsApp Cloud API**.
4. Copy your **Temporary Access Token** for testing or configure a permanent system-user token for production.
5. Copy the **Phone Number ID**. This is not the display phone number.

### 2. Configure Hugging Face Space secrets

Set these secrets:

```env
LLM_API_KEY=...
LLM_MODEL=openai/gpt-4o
GATEWAY_TOKEN=<strong random token>
HF_TOKEN=<optional Hugging Face write token>
WHATSAPP_PROVIDER=cloud
WHATSAPP_ACCESS_TOKEN=<Meta access token>
WHATSAPP_PHONE_NUMBER_ID=<Phone Number ID>
WHATSAPP_VERIFY_TOKEN=<your own random verify token>
WHATSAPP_ALLOWED_NUMBERS=6281234567890,6289876543210
WHATSAPP_GRAPH_API_VERSION=v20.0
```

`WHATSAPP_ALLOWED_NUMBERS` must use international format without `+`, separated by commas. Only those senders can use the bot.

Optional hardening:

```env
WHATSAPP_APP_SECRET=<Meta App Secret>
WHATSAPP_REJECT_UNAUTHORIZED=false
```

When `WHATSAPP_APP_SECRET` is set, HuggingMes validates Meta's `X-Hub-Signature-256` header. By default, non-whitelisted users are silently rejected; set `WHATSAPP_REJECT_UNAUTHORIZED=true` if you want them to receive a short denial message.

### 3. Configure the Meta webhook

In the WhatsApp product webhook settings:

- Callback URL: `https://<nama-space>.hf.space/whatsapp/webhook`
- Verify Token: the exact value of `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` webhook field

Meta will call:

```http
GET /whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
```

HuggingMes returns the challenge only when the verify token matches.

### 4. Test WhatsApp chat

1. Make sure the sender's number is listed in `WHATSAPP_ALLOWED_NUMBERS`.
2. Send a text message to the WhatsApp Cloud API phone number.
3. HuggingMes parses the webhook message, uses `whatsapp:<wa_id>` as the Hermes session ID, forwards the text to Hermes, then sends the answer with the Cloud API `/messages` endpoint.

## Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WHATSAPP_PROVIDER` | No | `cloud` | WhatsApp provider. `cloud` is the official/default provider. |
| `WHATSAPP_ACCESS_TOKEN` | Yes for WhatsApp | empty | Meta WhatsApp Cloud API bearer token. |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes for WhatsApp | empty | Phone Number ID used in Graph API send endpoint. |
| `WHATSAPP_VERIFY_TOKEN` | Yes for WhatsApp | empty | Secret token used for webhook verification. |
| `WHATSAPP_ALLOWED_NUMBERS` | Yes for WhatsApp | empty | Comma-separated allowed sender numbers without plus signs. |
| `WHATSAPP_GRAPH_API_VERSION` | No | `v20.0` | Graph API version in send-message URL. |
| `WHATSAPP_APP_SECRET` | No | empty | Enables webhook signature validation. |
| `WHATSAPP_REJECT_UNAUTHORIZED` | No | `false` | Sends denial message instead of silent reject. |
| `GATEWAY_TOKEN` | Recommended | generated per boot | Protects dashboard and `/v1/*`. |
| `LLM_API_KEY` | Usually | empty | Provider API key mapped into Hermes config. |
| `LLM_MODEL` | Usually | empty | Provider/model selector. |
| `HF_TOKEN` | No | empty | Enables backup/restore to a private HF Dataset. |
| `TELEGRAM_BOT_TOKEN` | No | empty | Backward-compatible Telegram adapter configuration. |
| `TELEGRAM_ALLOWED_USERS` | No | empty | Backward-compatible Telegram allowlist. |

## Testing Webhook Manually

Verify success:

```bash
curl -i 'https://<nama-space>.hf.space/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=hello'
```

Expected response: HTTP 200 with body `hello`.

Verify failure:

```bash
curl -i 'https://<nama-space>.hf.space/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=hello'
```

Expected response: HTTP 403.

POST status events are ignored and acknowledged with `{"ok":true}` so Meta does not retry non-message delivery/read webhooks.

## Optional Baileys Mode

`WHATSAPP_PROVIDER=baileys` is reserved for an unofficial WhatsApp Web fallback. It is not the default and is not recommended for production because it can log out unexpectedly and requires persistent session storage. The Space creates `$HERMES_HOME/whatsapp/baileys` so a future Baileys session can be included in HF Dataset backups, but the official Cloud API path is the supported adapter in this build.

## Security Notes

- No WhatsApp, Gateway, LLM, Cloudflare, or HF tokens are hardcoded.
- `/v1/*` remains protected by `GATEWAY_TOKEN`/`API_SERVER_KEY`.
- `WHATSAPP_VERIFY_TOKEN` is required for Meta webhook verification.
- `WHATSAPP_ALLOWED_NUMBERS` prevents arbitrary WhatsApp users from using the bot.
- Public webhook responses do not include stack traces.
- Logs include message IDs and sender numbers for diagnostics but never print bearer tokens.

## Risk and Limitations

- In-memory duplicate-message protection resets on container restart; Meta may retry older webhooks after a restart.
- In-memory chat history resets on container restart. Hermes still receives a stable `user`/session ID (`whatsapp:<wa_id>`) for integrations that persist sessions internally.
- WhatsApp Cloud API templates are not implemented; this adapter handles inbound text and free-form text replies inside the customer-service window.
- Very long Hermes replies are split into multiple WhatsApp messages without cutting mid-sentence when possible.

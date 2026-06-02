# Security

Do not commit Hugging Face, LLM provider, Telegram, Cloudflare, or WhatsApp tokens.
Configure all secrets through Hugging Face Space secrets.

WhatsApp access is restricted by `WHATSAPP_ALLOWED_NUMBERS`; keep it narrow.
Use a strong `WHATSAPP_VERIFY_TOKEN` and set `WHATSAPP_APP_SECRET` when possible
to validate Meta webhook signatures.

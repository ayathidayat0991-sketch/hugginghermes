#!/usr/bin/env python3
"""Placeholder-compatible Cloudflare Telegram proxy setup.

The upstream HuggingMes can create a Cloudflare Worker for Telegram Bot API egress.
WhatsApp Cloud API uses direct HTTPS calls from the webhook adapter and does not need
this proxy. This script intentionally avoids printing secrets.
"""
import os
from pathlib import Path

ENV_FILE = Path("/tmp/huggingmes-cloudflare-proxy.env")

if os.environ.get("CLOUDFLARE_PROXY_URL"):
    ENV_FILE.write_text(f"export CLOUDFLARE_PROXY_URL='{os.environ['CLOUDFLARE_PROXY_URL'].rstrip('/')}'\n", encoding="utf-8")
    print("Cloudflare proxy URL already configured.")
elif os.environ.get("CLOUDFLARE_WORKERS_TOKEN"):
    print("Cloudflare Telegram proxy token detected; automatic worker provisioning is not bundled in this build.")
else:
    print("Cloudflare Telegram proxy not configured.")

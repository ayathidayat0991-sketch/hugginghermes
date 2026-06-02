#!/usr/bin/env python3
"""Best-effort Cloudflare keep-alive status helper."""
import json
import os
import time
from pathlib import Path

status = {
    "configured": bool(os.environ.get("CLOUDFLARE_WORKERS_TOKEN")),
    "status": "pending" if os.environ.get("CLOUDFLARE_WORKERS_TOKEN") else "not configured",
    "message": "Configure a Cloudflare Worker cron to ping /health if desired.",
    "targetUrl": os.environ.get("SPACE_HOST", "") and f"https://{os.environ['SPACE_HOST']}/health",
    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
Path("/tmp/huggingmes-cloudflare-keepalive-status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
print("Cloudflare keep-alive status written.")

# Contributing

Run these local checks before submitting changes:

```bash
npm test
npm run check
bash -n start.sh
python3 -m py_compile hermes-sync.py cloudflare-proxy-setup.py cloudflare-keepalive-setup.py
```

Avoid committing secrets or generated `/opt/data` state.

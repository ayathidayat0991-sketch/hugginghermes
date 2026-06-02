#!/usr/bin/env python3
"""Best-effort HuggingMes state backup/restore to a private Hugging Face Dataset."""
import json
import os
import shutil
import sys
import tarfile
import tempfile
import time
from pathlib import Path

STATUS_FILE = Path("/tmp/huggingmes-sync-status.json")
HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))
DATASET_NAME = os.environ.get("BACKUP_DATASET_NAME", "huggingmes-backup")
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL", "600"))
EXCLUDES = {"*.sqlite-shm", "*.sqlite-wal", "*.db-shm", "*.db-wal"}


def status(state, message, **extra):
    payload = {"status": state, "message": message, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **extra}
    STATUS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"[sync] {state}: {message}", flush=True)


def have_hf():
    return bool(os.environ.get("HF_TOKEN"))


def should_skip(path: Path):
    name = path.name
    return any(path.match(pattern) or name.endswith(pattern.lstrip("*")) for pattern in EXCLUDES)


def make_archive(target: Path):
    with tarfile.open(target, "w:gz") as tar:
        for item in HERMES_HOME.rglob("*"):
            if should_skip(item) or item.is_socket():
                continue
            tar.add(item, arcname=item.relative_to(HERMES_HOME), recursive=False)


def sync_once():
    if not have_hf():
        status("disabled", "HF_TOKEN is not configured.")
        return 0
    try:
        from huggingface_hub import HfApi, create_repo, upload_file
        token = os.environ["HF_TOKEN"]
        api = HfApi(token=token)
        who = api.whoami(token=token)["name"]
        repo_id = f"{who}/{DATASET_NAME}" if "/" not in DATASET_NAME else DATASET_NAME
        create_repo(repo_id, repo_type="dataset", private=True, exist_ok=True, token=token)
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "huggingmes-state.tar.gz"
            make_archive(archive)
            upload_file(path_or_fileobj=str(archive), path_in_repo="huggingmes-state.tar.gz", repo_id=repo_id, repo_type="dataset", token=token)
        status("synced", f"Backed up Hermes state to {repo_id}.", repo_id=repo_id)
        return 0
    except Exception as exc:  # noqa: BLE001
        status("error", f"Backup failed: {exc.__class__.__name__}")
        return 1


def restore():
    if not have_hf():
        status("disabled", "HF_TOKEN is not configured.")
        return 0
    try:
        from huggingface_hub import HfApi, hf_hub_download
        token = os.environ["HF_TOKEN"]
        api = HfApi(token=token)
        who = api.whoami(token=token)["name"]
        repo_id = f"{who}/{DATASET_NAME}" if "/" not in DATASET_NAME else DATASET_NAME
        archive = hf_hub_download(repo_id=repo_id, repo_type="dataset", filename="huggingmes-state.tar.gz", token=token)
        HERMES_HOME.mkdir(parents=True, exist_ok=True)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(HERMES_HOME)
        status("restored", f"Restored Hermes state from {repo_id}.", repo_id=repo_id)
        return 0
    except Exception as exc:  # noqa: BLE001
        status("configured", f"No previous backup restored ({exc.__class__.__name__}).")
        return 0


def loop():
    while True:
        sync_once()
        time.sleep(SYNC_INTERVAL)


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "sync-once"
    if command == "restore":
        raise SystemExit(restore())
    if command == "loop":
        loop()
    if command == "sync-once":
        raise SystemExit(sync_once())
    print(f"Unknown command: {command}", file=sys.stderr)
    raise SystemExit(2)

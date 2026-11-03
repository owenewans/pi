#!/usr/bin/env python3
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import uuid
import zipfile

root = Path(__file__).resolve().parent
if sys.platform != "linux" or platform.machine() != "x86_64":
    raise SystemExit("tools.lock.json targets Linux x86_64")
lock = json.loads((root / "tools.lock.json").read_text())
agent = os.environ.get("PI_CODING_AGENT_DIR")
proxy = json.loads((Path(agent) / "settings.json").read_text()).get("httpProxy") if agent else None
proxy = proxy or os.environ.get("HTTPS_PROXY") or os.environ.get("ALL_PROXY")
for name, entry in lock.items():
    target = root / "tools" / name
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == entry["binarySha256"]:
        continue
    if not proxy:
        raise SystemExit("set PI_CODING_AGENT_DIR or HTTPS_PROXY to use the configured network route")
    result = subprocess.run(["curl", "--proxy", proxy, "--fail", "--silent", "--show-error", "--location", "--max-time", "180", entry["url"]], capture_output=True)
    if result.returncode:
        raise SystemExit(f"{name}: download failed: {result.stderr.decode(errors='replace').replace(proxy, '[configured proxy]')}")
    if hashlib.sha256(result.stdout).hexdigest() != entry["sha256"]:
        raise SystemExit(f"{name}: archive checksum mismatch")
    if entry["format"] == "gzip":
        binary = gzip.decompress(result.stdout)
    else:
        with zipfile.ZipFile(io.BytesIO(result.stdout)) as archive:
            binary = archive.read(entry["member"])
    if hashlib.sha256(binary).hexdigest() != entry["binarySha256"]:
        raise SystemExit(f"{name}: binary checksum mismatch")
    target.parent.mkdir(exist_ok=True)
    temporary = target.with_name(f".{name}-{uuid.uuid4()}")
    try:
        temporary.write_bytes(binary)
        temporary.chmod(0o755)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"installed {name} {entry['version']}")

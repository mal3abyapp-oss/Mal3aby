#!/usr/bin/env python3
"""backup-verify -- re-computes SHA-256 checksums for every file listed
in a backup's 09_manifest.json and compares against the files currently
on disk. Reports PASS/FAIL per file. A FAIL means the file was modified
or corrupted after the backup was created -- treat that backup as
untrustworthy and create a fresh one.

Usage:
    python3 verify_manifest.py <backup_dir>
"""
import hashlib
import json
import os
import sys


def main():
    if len(sys.argv) != 2:
        print("usage: verify_manifest.py <backup_dir>", file=sys.stderr)
        sys.exit(1)
    backup_dir = sys.argv[1]
    manifest_path = os.path.join(backup_dir, "09_manifest.json")

    if not os.path.isfile(manifest_path):
        print(f"ERROR: no manifest found at {manifest_path}", file=sys.stderr)
        sys.exit(1)

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    all_pass = True
    for entry in manifest.get("files", []):
        path = os.path.join(backup_dir, entry["name"])
        if not os.path.isfile(path):
            print(f"FAIL  {entry['name']}: file missing")
            all_pass = False
            continue
        with open(path, "rb") as f:
            content = f.read()
        actual_size = len(content)
        actual_sha256 = hashlib.sha256(content).hexdigest()
        size_ok = actual_size == entry["size_bytes"]
        hash_ok = actual_sha256 == entry["sha256"]
        if size_ok and hash_ok:
            print(f"PASS  {entry['name']}: {actual_size} bytes, checksum matches")
        else:
            print(f"FAIL  {entry['name']}: expected {entry['size_bytes']}B/{entry['sha256'][:16]}..., "
                  f"got {actual_size}B/{actual_sha256[:16]}...")
            all_pass = False

    print()
    if all_pass:
        print(f"ALL CHECKS PASSED for backup {manifest.get('backup_timestamp', backup_dir)}")
        sys.exit(0)
    else:
        print(f"VERIFICATION FAILED for backup {manifest.get('backup_timestamp', backup_dir)} -- "
              f"do not trust this backup, create a fresh one")
        sys.exit(1)


if __name__ == "__main__":
    main()

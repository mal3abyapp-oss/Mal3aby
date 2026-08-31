#!/usr/bin/env python3
"""backup-verify (manifest generator) -- computes SHA-256 checksums and
sizes for every file in a backup directory and writes 09_manifest.json.
Never invents/assumes a checksum -- always reads the real file bytes.

Usage:
    python3 make_manifest.py <backup_dir>

Expects the standard 8 numbered backup files (01_tables.sql through
08_data.sql) to already exist in <backup_dir>. See BACKUP_RUNBOOK.md.

NOTE: this generates the minimal checksum-only manifest shape. The
first real backup (20260831T163434Z) additionally hand-documents
postgres_version, total_tables/functions/rls_policies_captured,
not_captured, security_review, and structural_validation fields --
richer than what this script produces alone. If re-running this script
against an existing manifest, merge rather than blindly overwrite those
richer fields (this script intentionally does not fabricate them from
nothing -- they require reading real counts from the backup content).
import hashlib
import json
import os
import sys

EXPECTED_FILES = [
    "01_tables.sql",
    "02_functions.sql",
    "03_constraints.sql",
    "04_indexes.sql",
    "05_rls_enable.sql",
    "06_rls_policies.sql",
    "07_grants.sql",
    "08_data.sql",
]


def main():
    if len(sys.argv) != 2:
        print("usage: make_manifest.py <backup_dir>", file=sys.stderr)
        sys.exit(1)
    backup_dir = sys.argv[1]
    ts = os.path.basename(os.path.normpath(backup_dir))

    files = []
    total_size = 0
    missing = []
    for name in EXPECTED_FILES:
        path = os.path.join(backup_dir, name)
        if not os.path.isfile(path):
            missing.append(name)
            continue
        with open(path, "rb") as f:
            content = f.read()
        size = len(content)
        total_size += size
        sha256 = hashlib.sha256(content).hexdigest()
        files.append({"name": name, "size_bytes": size, "sha256": sha256})

    if missing:
        print(f"WARNING: missing expected files: {missing}", file=sys.stderr)

    manifest = {
        "backup_timestamp": ts,
        "files": files,
        "total_size_bytes": total_size,
        "missing_files": missing,
    }

    out_path = os.path.join(backup_dir, "09_manifest.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    print(f"Manifest written to {out_path}")
    print(f"Total size: {total_size} bytes (~{total_size / 1024 / 1024:.1f} MB)")
    for entry in files:
        print(f"  {entry['name']}: {entry['size_bytes']} bytes, sha256={entry['sha256'][:16]}...")
    if missing:
        print(f"MISSING: {missing}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""backup-extract-result -- extract a single-column SQL text result from
a saved Supabase-MCP execute_sql tool-result file and append it to a
target backup file.

Used by the backup-production procedure documented in
BACKUP_RUNBOOK.md, whenever a query's result exceeds the tool's inline
token limit and is auto-saved to a local file instead. Not part of the
application runtime -- a backup-operator utility only.

Usage:
    python3 extract_result.py <source_tool_result.txt> <dest.sql> <column_name>
"""
import json
import re
import sys


def main():
    if len(sys.argv) != 4:
        print("usage: extract_result.py <source_tool_result.txt> <dest.sql> <column_name>", file=sys.stderr)
        sys.exit(1)
    src_path, dest_path, column_name = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(src_path, 'r', encoding='utf-8') as f:
        outer = json.load(f)
    text = outer['result']
    m = re.search(r'<untrusted-data-[a-f0-9-]+>\n(.*)\n</untrusted-data-[a-f0-9-]+>', text, re.DOTALL)
    if not m:
        print("ERROR: could not find the untrusted-data boundary markers in the source file -- unexpected format", file=sys.stderr)
        sys.exit(1)
    inner_json = m.group(1)
    rows = json.loads(inner_json)
    value = rows[0][column_name] or ''
    with open(dest_path, 'a', encoding='utf-8') as out:
        out.write(value)
    print(f'written {len(value)} chars to {dest_path}')


if __name__ == '__main__':
    main()

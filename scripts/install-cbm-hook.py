#!/usr/bin/env python3
"""
安裝 codebase-memory-mcp post-commit git hook。
.git/hooks/ 不進 git，container 重建或 merge 後需重跑此腳本。
用法：python3 scripts/install-cbm-hook.py
"""
import os, stat, sys

REPO = "/home/runner/workspace"
BIN  = f"{REPO}/.local/bin/codebase-memory-mcp"
HOOK = f"{REPO}/.git/hooks/post-commit"

HOOK_BODY = f"""#!/bin/sh
# codebase-memory-mcp auto-reindex on every git commit (Replit Agent checkpoints)
BIN="{BIN}"
REPO="{REPO}"
if [ -x "$BIN" ]; then
  nohup "$BIN" cli index_repository "{{\\"repo_path\\":\\"$REPO\\",\\"force\\":true}}" > /tmp/cbm-reindex.log 2>&1 &
fi
"""

hooks_dir = os.path.dirname(HOOK)
os.makedirs(hooks_dir, exist_ok=True)

with open(HOOK, "w") as f:
    f.write(HOOK_BODY)

st = os.stat(HOOK)
os.chmod(HOOK, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

print(f"[cbm-hook] installed: {HOOK}")

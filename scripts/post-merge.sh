#!/bin/bash
set -e

cd server
npm install --no-audit --no-fund

# 重裝 codebase-memory-mcp git hook（.git/hooks/ 不進 git，merge 後需補回）
cd /home/runner/workspace
python3 scripts/install-cbm-hook.py 2>/dev/null || true

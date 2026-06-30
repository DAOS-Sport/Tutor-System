---
name: Codebase Memory MCP
description: Graph-based code intelligence tool — prefer over grep/read for function/route/component discovery.
---

# Codebase Memory MCP

**Binary**: `.local/bin/codebase-memory-mcp` (v0.8.1, Linux amd64 portable)
**Project name in index**: `home-runner-workspace`
**Last indexed**: 2026-06-30 — 17,610 nodes, 47,304 edges

## Priority rule
Always try MCP graph tools FIRST for code discovery. Fall back to grep only for string literals, config values, or non-code files.

## Key tools (call via MCP)
```
search_graph(project="home-runner-workspace", name_pattern="<regex>")
trace_path(project="home-runner-workspace", start="<qualified_name>", direction="callers|callees")
get_code_snippet(project="home-runner-workspace", qualified_name="<fn>")
get_architecture(project="home-runner-workspace", aspects=["all"])
query_graph(project="home-runner-workspace", cypher="MATCH ...")
```

## If MCP is not responding / index missing
The index lives in `~/.cache/codebase-memory-mcp/` — lost on container reset. Rebuild:
```bash
.local/bin/codebase-memory-mcp install -y
.local/bin/codebase-memory-mcp cli index_repository '{"repo_path":"/home/runner/workspace"}'
```

**Why**: Container resets wipe `~/.cache/`; binary stays in `.local/bin/` (committed to repo) but the index does not.

## Claude Code config (written by install)
`/home/runner/.claude/.mcp.json` — auto-wires the binary as MCP server on Claude Code startup.

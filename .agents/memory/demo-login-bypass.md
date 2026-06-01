---
name: Demo login bypass (LINE-free testing)
description: How the username/password demo backdoor for mobile functional testing is gated and why it fails closed; pitfalls when reusing it.
---

# Demo login bypass

A username/password backdoor (`POST /api/auth/demo-login`) lets the user test the LIFF app on mobile without LINE Login.

## Gating & why
- Enabled only when env flag `ALLOW_DEMO_LOGIN=1`; otherwise the route returns 404. This is the deliberate on/off switch — the user wants it ON in production during a demo, then removes the flag afterward. There is intentionally NO hard `NODE_ENV==='production'` block, because the demo target is the published `.replit.app`.
- **Why fail-closed coach lookup matters:** an earlier version fell back to "any active coach (`LIMIT 1`)" when no test account existed — that would mint a real coach's JWT and allow IDOR into a real coach's data. The lookup now requires `name LIKE '%測試帳號%'` and returns 404 if absent. Never reintroduce an arbitrary-real-account fallback for a demo path.

## Critical pitfall: LIFF auto-login defeats the bypass
- `client/liff/src/main.jsx` calls `liff.login()` (redirects to LINE OAuth) for any non-logged-in path when a LIFF ID is configured. A demo page is useless if it gets bounced to LINE.
- Fix pattern: detect the demo path early in `initLiff()` and `mount()` directly, skipping `liff.init`/`liff.login`. Any future "open in plain browser, no LINE" entry point needs the same skip.

## Data
- Coach demo → Ragic "(測試帳號)教練"; parent demo → phone `0912345678` = Ragic "(測試帳號)家長" with test students. These are designated test records, not real families — acceptable PII surface. If those accounts ever disappear from the Ragic-synced DB, coach demo 404s and parent demo returns empty students.

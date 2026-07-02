#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function walk(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, predicate, out);
    else if (predicate(rel)) out.push(rel);
  }
  return out;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split(/\n/).length;
}

function joinPath(base, local) {
  if (!local || local === '/') return base || '/';
  if (local === '*') return `${base || ''}/*`;
  return `${(base || '').replace(/\/$/, '')}/${String(local).replace(/^\//, '')}`.replace(/\/+/g, '/') || '/';
}

function routeRegex(routePath) {
  let escaped = routePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  escaped = escaped.replace(/\\\*/g, '.*').replace(/:([^/]+)/g, '[^/]+');
  return new RegExp(`^${escaped}(?:\\?.*)?$`);
}

function routeSort(a, b) {
  return a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file);
}

function routeKey(r) {
  return `${r.method} ${r.path}`;
}

function extractRouteCalls(file, base, objectName = 'router') {
  const src = read(file);
  const out = [];
  const re = new RegExp(`${objectName}\\.(get|post|put|patch|delete|all)\\s*\\(\\s*([\\"'])([^\\"']+)\\2`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const chunk = src.slice(m.index, m.index + 900);
    const guards = [];
    for (const guard of [
      'requireParent',
      'optionalParent',
      'requireLiffUser',
      'requireCoach',
      'requireAdminAuth',
      'requireAdminRole',
      'byPhoneRateLimit',
      'byLineUidRateLimit',
      'previewRateLimit',
      'lookupRateLimit',
    ]) {
      if (chunk.includes(guard)) guards.push(guard);
    }
    out.push({
      method: m[1].toUpperCase(),
      path: joinPath(base, m[3]),
      file,
      line: lineOf(src, m.index),
      guards,
    });
  }
  return out;
}

function backendGraph() {
  const src = read('server/index.js');
  const mounts = [];
  const mountedFiles = new Set(['server/index.js']);
  const topRe = /app\.use\(\s*(['"])(\/api\/[^'"]+)\1\s*,\s*require\(\s*(['"])(\.\/routes\/[^'"]+)\3\s*\)/g;
  let m;
  while ((m = topRe.exec(src))) {
    mounts.push({ base: m[2], requirePath: m[4], file: 'server/index.js', line: lineOf(src, m.index) });
  }

  const adminMounts = [];
  const routes = [];
  for (const mount of mounts) {
    const routeFile = `${mount.requirePath.replace('./', 'server/')}.js`;
    mountedFiles.add(routeFile);
    if (routeFile === 'server/routes/admin.js') {
      const admin = read(routeFile);
      const adminRe = /router\.use\(\s*(['"])(\/[^'"]+)\1\s*,\s*require\(\s*(['"])(\.\/admin\/[^'"]+)\3\s*\)/g;
      let a;
      while ((a = adminRe.exec(admin))) {
        const subFile = `server/routes/${a[4].replace('./', '')}.js`;
        mountedFiles.add(subFile);
        const base = joinPath(mount.base, a[2]);
        adminMounts.push({ base, requirePath: a[4], file: routeFile, line: lineOf(admin, a.index) });
        routes.push(...extractRouteCalls(subFile, base));
      }
      routes.push(...extractRouteCalls(routeFile, mount.base));
    } else {
      routes.push(...extractRouteCalls(routeFile, mount.base));
    }
  }
  routes.push(...extractRouteCalls('server/index.js', '', 'app'));
  routes.sort(routeSort);

  const routeFiles = walk('server/routes', (p) => p.endsWith('.js'));
  const helperFiles = new Set(['server/routes/_chatNotify.js', 'server/routes/admin/_customerShared.js']);
  const unmountedRouteFiles = routeFiles
    .filter((file) => !mountedFiles.has(file) && !helperFiles.has(file))
    .sort();

  return { mounts, adminMounts, routes, unmountedRouteFiles };
}

function normalizeClientPath(raw) {
  let value = raw.trim();
  const quote = value[0];
  if (quote === '`') {
    value = value
      .slice(1, -1)
      .replace(/\$\{\s*(qs|rev)\([\s\S]*?\)\s*\}/g, '')
      .replace(/\$\{[^}]+}/g, ':param');
  } else {
    value = value.slice(1, -1);
  }
  return value.replace(/\?.*$/, '').replace(/\/+/g, '/') || '/';
}

function parseFirstQuotedArg(src, start) {
  let i = start;
  while (/\s/.test(src[i])) i += 1;
  const quote = src[i];
  if (!['"', "'", '`'].includes(quote)) return null;
  let j = i + 1;
  let escaped = false;
  let templateDepth = 0;
  for (; j < src.length; j += 1) {
    const ch = src[j];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote === '`' && ch === '$' && src[j + 1] === '{') {
      templateDepth += 1;
      j += 1;
      continue;
    }
    if (quote === '`' && ch === '}' && templateDepth > 0) {
      templateDepth -= 1;
      continue;
    }
    if (ch === quote && templateDepth === 0) break;
  }
  if (j >= src.length) return null;
  return { raw: src.slice(i, j + 1), end: j + 1 };
}

function findCallEnd(src, start) {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let str = null;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (str) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === str) str = null;
      continue;
    }
    if (['"', "'", '`'].includes(ch)) {
      str = ch;
      continue;
    }
    if (ch === '(') paren += 1;
    else if (ch === ')') {
      if (paren === 0 && brace === 0 && bracket === 0) return i;
      paren -= 1;
    } else if (ch === '{') brace += 1;
    else if (ch === '}') brace -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;
  }
  return src.length;
}

function clientBaseFor(file) {
  return file.startsWith('client/admin') ? '/api/admin' : '/api';
}

function addBase(base, clientPath) {
  if (clientPath.startsWith('/api/')) return clientPath;
  return joinPath(base, clientPath);
}

function parseWrapperCalls(file, base, names) {
  const src = read(file);
  const out = [];
  for (const name of names) {
    let idx = 0;
    const needle = `${name}(`;
    while ((idx = src.indexOf(needle, idx)) !== -1) {
      const first = parseFirstQuotedArg(src, idx + needle.length);
      if (!first) {
        idx += needle.length;
        continue;
      }
      const end = findCallEnd(src, first.end);
      const expr = src.slice(first.end, end);
      const methodMatch = expr.match(/method\s*:\s*['"](get|post|put|patch|delete)['"]/i);
      const pathValue = addBase(base, normalizeClientPath(first.raw));
      out.push({
        method: (methodMatch ? methodMatch[1] : 'get').toUpperCase(),
        path: pathValue,
        file,
        line: lineOf(src, idx),
        kind: name,
      });
      idx = end + 1;
    }
  }
  return out;
}

function parseDirectHttp(file, base) {
  const src = read(file);
  const out = [];
  const re = /(http|portalHttp|axios)\.(get|post|put|patch|delete)\s*\(\s*([`'"])([^`'"]+)\3/g;
  let m;
  while ((m = re.exec(src))) {
    const directBase = m[1] === 'portalHttp' ? '/api/coach-portal' : (m[1] === 'axios' ? '' : base);
    out.push({
      method: m[2].toUpperCase(),
      path: addBase(directBase, normalizeClientPath(`${m[3]}${m[4]}${m[3]}`)),
      file,
      line: lineOf(src, m.index),
      kind: `${m[1]}.${m[2]}`,
    });
  }
  const constRe = /COACH_LINE_LOGIN_URL\s*=\s*(['"])(\/api\/[^'"]+)\1/g;
  while ((m = constRe.exec(src))) {
    out.push({
      method: 'GET',
      path: m[2],
      file,
      line: lineOf(src, m.index),
      kind: 'const-url',
    });
  }
  return out;
}

function frontendApiCalls() {
  const apiFiles = [
    ...walk('client/liff/src/api', (p) => /\.(js|jsx)$/.test(p)),
    ...walk('client/admin/src/api', (p) => /\.(js|jsx)$/.test(p)),
  ];
  const out = [];
  for (const file of apiFiles) {
    const base = clientBaseFor(file);
    out.push(...parseWrapperCalls(file, base, ['callApi']));
    if (file === 'client/admin/src/api/promotions.js') {
      out.push(...parseWrapperCalls(file, base, ['req']));
    }
    out.push(...parseDirectHttp(file, base));
  }
  const seen = new Set();
  return out
    .filter((call) => {
      const key = `${call.method}|${call.path}|${call.file}|${call.line}|${call.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(routeSort);
}

function frontendRoutes(file, basename) {
  const src = read(file);
  const out = [];
  const re = /<Route\s+[^>]*path=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({ path: joinPath(basename, m[1]), file, line: lineOf(src, m.index) });
  }
  if (src.includes('<Route index')) out.push({ path: basename, file, line: lineOf(src, src.indexOf('<Route index')) });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function matchCallsToRoutes(calls, routes) {
  const matchers = routes.map((route) => ({ ...route, re: routeRegex(route.path) }));
  const matchesFor = (call) => matchers.filter((route) => (
    (route.method === call.method || route.method === 'ALL') && route.re.test(call.path)
  ));
  const unmatched = calls.filter((call) => matchesFor(call).length === 0);
  const calledRouteKeys = new Set();
  for (const call of calls) {
    for (const route of matchesFor(call)) calledRouteKeys.add(routeKey(route));
  }
  const noStaticCaller = routes.filter((route) => (
    route.path.startsWith('/api/') &&
    route.method !== 'ALL' &&
    !route.path.includes('*') &&
    !calledRouteKeys.has(routeKey(route))
  ));
  return { unmatched, noStaticCaller };
}

function classifyNoStatic(route) {
  const key = routeKey(route);
  const map = {
    'GET /api/auth/line-config-debug': 'manual debug endpoint; env gated by DEBUG_LINE_AUTH in production',
    'POST /api/auth/parent-login': 'legacy endpoint; default 410 unless ALLOW_LEGACY_PARENT_LOGIN=1 outside production',
    'GET /api/coach-portal/auth/line/callback': 'external LINE OAuth callback; not called by frontend JS',
    'DELETE /api/parents/me/students/:id': 'intentional 405 guard; frontend deletion removed',
    'PATCH /api/transfers/:id/cancel': 'backend/service supports cancel; no current LIFF API wrapper or UI caller',
    'POST /api/admin/venues/sync': 'legacy one-step venue sync; current admin UI uses /sync-ragic',
    'POST /api/admin/sessions/checkin': 'MGM/checkin finalization endpoint; current CheckinPage uses list/verify/backfill routes',
    'POST /api/admin/periods/:id/activate': 'canonical activation seam for future callers; no current admin API wrapper',
  };
  return map[key] || 'no static frontend caller found';
}

function mdTable(rows, columns) {
  const header = `| ${columns.map((c) => c.label).join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((c) => String(c.value(row) ?? '').replace(/\n/g, ' ')).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function renderMarkdown(data) {
  const routeRows = data.routes.map((r) => ({
    method: r.method,
    path: r.path,
    guard: r.guards.length ? r.guards.join(', ') : '',
    source: `${r.file}:${r.line}`,
  }));
  const apiRows = data.calls.map((c) => ({
    method: c.method,
    path: c.path,
    source: `${c.file}:${c.line}`,
    kind: c.kind,
  }));
  const noStaticRows = data.noStaticCaller.map((r) => ({
    method: r.method,
    path: r.path,
    source: `${r.file}:${r.line}`,
    note: classifyNoStatic(r),
  }));

  return [
    '# Route Map Audit',
    '',
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Method',
    '',
    '- Source of truth: `server/index.js`, `server/routes/**`, `client/liff/src/App.jsx`, `client/admin/src/App.jsx`, and `client/**/src/api/**`.',
    '- Matching is static and code-derived. External callbacks and manual debug URLs are classified separately instead of guessed as dead code.',
    '- Dynamic frontend template segments are normalized to `:param`; query-string helpers are stripped before matching.',
    '',
    '## Summary',
    '',
    mdTable([
      { metric: 'Backend Express handlers', value: data.routes.length },
      { metric: 'Frontend API wrapper/direct calls', value: data.calls.length },
      { metric: 'Frontend API calls without backend handler', value: data.unmatched.length },
      { metric: 'Route files not mounted', value: data.unmountedRouteFiles.length },
      { metric: 'Backend handlers without static frontend caller', value: data.noStaticCaller.length },
      { metric: 'LIFF React routes', value: data.liffRoutes.length },
      { metric: 'Admin React routes', value: data.adminRoutes.length },
    ], [
      { label: 'Metric', value: (r) => r.metric },
      { label: 'Value', value: (r) => r.value },
    ]),
    '',
    '## Top-Level Backend Mounts',
    '',
    mdTable(data.mounts, [
      { label: 'Mount', value: (r) => r.base },
      { label: 'Require', value: (r) => r.requirePath },
      { label: 'Source', value: (r) => `${r.file}:${r.line}` },
    ]),
    '',
    '## Admin Sub-Mounts',
    '',
    mdTable(data.adminMounts, [
      { label: 'Mount', value: (r) => r.base },
      { label: 'Require', value: (r) => r.requirePath },
      { label: 'Source', value: (r) => `${r.file}:${r.line}` },
    ]),
    '',
    '## Frontend Route Graph',
    '',
    '### LIFF (`basename=/liff`)',
    '',
    mdTable(data.liffRoutes, [
      { label: 'Path', value: (r) => r.path },
      { label: 'Source', value: (r) => `${r.file}:${r.line}` },
    ]),
    '',
    '### Admin (`basename=/admin`)',
    '',
    mdTable(data.adminRoutes, [
      { label: 'Path', value: (r) => r.path },
      { label: 'Source', value: (r) => `${r.file}:${r.line}` },
    ]),
    '',
    '## Orphan / Mismatch Audit',
    '',
    '### Frontend API Calls Without Backend Handler',
    '',
    data.unmatched.length
      ? mdTable(data.unmatched, [
        { label: 'Method', value: (r) => r.method },
        { label: 'Path', value: (r) => r.path },
        { label: 'Source', value: (r) => `${r.file}:${r.line}` },
        { label: 'Kind', value: (r) => r.kind },
      ])
      : 'None found.',
    '',
    '### Route Files Not Mounted',
    '',
    data.unmountedRouteFiles.length ? data.unmountedRouteFiles.map((f) => `- ${f}`).join('\n') : 'None found.',
    '',
    '### Backend Handlers Without Static Frontend Caller',
    '',
    noStaticRows.length
      ? mdTable(noStaticRows, [
        { label: 'Method', value: (r) => r.method },
        { label: 'Path', value: (r) => r.path },
        { label: 'Source', value: (r) => r.source },
        { label: 'Classification', value: (r) => r.note },
      ])
      : 'None found.',
    '',
    '## Full Backend Route Inventory',
    '',
    mdTable(routeRows, [
      { label: 'Method', value: (r) => r.method },
      { label: 'Path', value: (r) => r.path },
      { label: 'Guard Detected', value: (r) => r.guard },
      { label: 'Source', value: (r) => r.source },
    ]),
    '',
    '## Full Frontend API Call Inventory',
    '',
    mdTable(apiRows, [
      { label: 'Method', value: (r) => r.method },
      { label: 'Path', value: (r) => r.path },
      { label: 'Kind', value: (r) => r.kind },
      { label: 'Source', value: (r) => r.source },
    ]),
    '',
  ].join('\n');
}

function main() {
  const backend = backendGraph();
  const calls = frontendApiCalls();
  const match = matchCallsToRoutes(calls, backend.routes);
  const data = {
    ...backend,
    calls,
    unmatched: match.unmatched,
    noStaticCaller: match.noStaticCaller,
    liffRoutes: frontendRoutes('client/liff/src/App.jsx', '/liff'),
    adminRoutes: frontendRoutes('client/admin/src/App.jsx', '/admin'),
  };

  const json = process.argv.includes('--json');
  const out = json ? JSON.stringify(data, null, 2) : renderMarkdown(data);
  const writeIndex = process.argv.indexOf('--write');
  if (writeIndex >= 0) {
    const target = process.argv[writeIndex + 1] || 'docs/route-map-audit.md';
    fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    fs.writeFileSync(path.join(root, target), out);
    console.log(`wrote ${target}`);
  } else {
    console.log(out);
  }
}

main();

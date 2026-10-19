'use strict';
// 靜態分析後台前端：每個路由頁面（含它引入的元件、hooks）會呼叫哪些 API。
// API 都集中在 src/api/*.js 的 `xxxApi = { fn: () => callApi(path, { method }) }`，
// 所以追「頁面用到哪些 xxxApi.fn」再對回 path 與 method 即可。
const fs = require('fs');
const path = require('path');

const ADMIN = path.join(__dirname, '..', '..', 'client', 'admin');
const SRC = path.join(ADMIN, 'src');
const nm = (m) => require(require.resolve(m, { paths: [ADMIN] }));
const { parse } = nm('@babel/parser');
const traverse = nm('@babel/traverse').default;

const astCache = new Map();
function astOf(file) {
  if (!astCache.has(file)) {
    const code = fs.readFileSync(file, 'utf8');
    astCache.set(file, parse(code, { sourceType: 'module', plugins: ['jsx'] }));
  }
  return astCache.get(file);
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js'), path.join(base, 'index.jsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// `/venues/${id}/active` → '/venues/:p/active'；非字面值回 null
function pathPattern(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map((q, i) => q.value.cooked + (i < node.expressions.length ? ':p' : '')).join('');
  }
  return null;
}

function methodFromOptions(node) {
  if (!node || node.type !== 'ObjectExpression') return 'GET';
  const m = node.properties.find((p) => p.key && (p.key.name === 'method' || p.key.value === 'method'));
  return m && m.value.type === 'StringLiteral' ? m.value.value.toUpperCase() : 'GET';
}

// 找出一段 AST 內所有 API 呼叫：callApi(path, opts) 或 http.get/post(...)(path)
function callsIn(nodePath) {
  const calls = [];
  nodePath.traverse({
    CallExpression(p) {
      const { callee, arguments: args } = p.node;
      if (callee.type === 'Identifier' && callee.name === 'callApi') {
        const pat = pathPattern(args[0]);
        if (pat) calls.push({ method: methodFromOptions(args[1]), path: pat.split('?')[0] });
      } else if (callee.type === 'MemberExpression' && callee.object.name === 'http' && callee.property.name) {
        const pat = pathPattern(args[0]);
        if (pat) calls.push({ method: callee.property.name.toUpperCase(), path: pat.split('?')[0] });
      }
    },
  });
  return calls;
}

// api/*.js：{ 'venuesApi.list': [{method, path}] }
function apiFunctionTable() {
  const table = {};
  for (const name of fs.readdirSync(path.join(SRC, 'api'))) {
    if (!name.endsWith('.js')) continue;
    traverse(astOf(path.join(SRC, 'api', name)), {
      VariableDeclarator(p) {
        if (p.node.id.type !== 'Identifier' || !p.node.init || p.node.init.type !== 'ObjectExpression') return;
        const obj = p.node.id.name;
        p.get('init.properties').forEach((prop) => {
          if (!prop.node.key) return;
          const key = prop.node.key.name || prop.node.key.value;
          const calls = callsIn(prop);
          if (calls.length) table[`${obj}.${key}`] = calls;
        });
      },
    });
  }
  return table;
}

// 一個檔案的直接引入（相對路徑），以及它用到的 `xxxApi.fn` 與直接 http 呼叫
function scanFile(file) {
  const imports = [];
  const members = new Set();
  let direct = [];
  traverse(astOf(file), {
    ImportDeclaration(p) {
      const r = resolveImport(file, p.node.source.value);
      if (r) imports.push(r);
    },
    MemberExpression(p) {
      const { object, property } = p.node;
      if (object.type === 'Identifier' && /Api$/.test(object.name) && property.type === 'Identifier') {
        members.add(`${object.name}.${property.name}`);
      }
    },
    Program(p) {
      if (!file.includes(`${path.sep}api${path.sep}`)) direct = callsIn(p);
    },
  });
  return { imports, members: [...members], direct };
}

// 從入口檔往下追所有非 api/ 的引入檔，彙總 API 呼叫。
function apisReachableFrom(entry, table, stopAt = new Set()) {
  const seen = new Set();
  const stack = [entry];
  const calls = [];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || stopAt.has(f)) continue;
    seen.add(f);
    if (f.includes(`${path.sep}api${path.sep}`)) continue;
    const { imports, members, direct } = scanFile(f);
    for (const m of members) for (const c of table[m] || []) calls.push({ ...c, via: m, file: path.relative(SRC, f) });
    for (const c of direct) calls.push({ ...c, via: 'http', file: path.relative(SRC, f) });
    stack.push(...imports);
  }
  return calls;
}

// App.jsx 的 <Route path="/x" element={...<XxxPage/>...}> → { '/x': file }
function routePages() {
  const app = path.join(SRC, 'App.jsx');
  const importMap = {};
  const pages = {};
  traverse(astOf(app), {
    ImportDeclaration(p) {
      const r = resolveImport(app, p.node.source.value);
      for (const s of p.node.specifiers) if (r) importMap[s.local.name] = r;
    },
    // 路由切分後頁面改成 const XxxPage = lazyPage(() => import('./pages/XxxPage'))
    VariableDeclarator(p) {
      if (p.node.id.type !== 'Identifier' || !p.node.init) return;
      p.get('init').traverse({
        CallExpression(q) {
          const [arg] = q.node.arguments;
          if (q.node.callee.type !== 'Import' || !arg || arg.type !== 'StringLiteral') return;
          const r = resolveImport(app, arg.value);
          if (r) importMap[p.node.id.name] = r;
        },
        ImportExpression(q) {
          if (q.node.source.type !== 'StringLiteral') return;
          const r = resolveImport(app, q.node.source.value);
          if (r) importMap[p.node.id.name] = r;
        },
      });
    },
  });
  traverse(astOf(app), {
    JSXOpeningElement(p) {
      if (p.node.name.name !== 'Route') return;
      const attr = (n) => p.node.attributes.find((a) => a.name && a.name.name === n);
      const pathAttr = attr('path');
      const el = attr('element');
      if (!pathAttr || !el || pathAttr.value.type !== 'StringLiteral') return;
      const names = [];
      p.get('attributes').forEach((a) => {
        if (a.node !== el) return;
        a.traverse({ JSXIdentifier(q) { if (importMap[q.node.name] && /Page|Redirect/.test(q.node.name)) names.push(q.node.name); } });
      });
      if (names.length) pages[pathAttr.value.value] = importMap[names[names.length - 1]];
    },
  });
  return pages;
}

function loadAdminPageApis() {
  const table = apiFunctionTable();
  const layout = path.join(SRC, 'components', 'AppLayout.jsx');
  const pages = routePages();
  const stopAt = new Set([layout]);
  const result = {};
  for (const [route, file] of Object.entries(pages)) {
    result[route] = { file: path.relative(SRC, file), calls: apisReachableFrom(file, table, stopAt) };
  }
  return { pages: result, layoutCalls: apisReachableFrom(layout, table) };
}

module.exports = { loadAdminPageApis };

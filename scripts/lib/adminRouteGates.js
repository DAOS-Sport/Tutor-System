'use strict';
// 載入真正的後台 Express router，列出每支 API 實際掛的權限閘門。
// 不靠正規表示式猜：把 requireResource 等閘門工廠換成會留下標記的版本，
// 再走訪 router.stack。只讀程式結構，不連資料庫、不收請求。
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server');

function tag(fn, gate) {
  fn.__gate = gate;
  return fn;
}

function installTaggedGates() {
  const rr = require(path.join(SERVER, 'middlewares/requireResource'));
  const origResource = rr.requireResource;
  const origAny = rr.requireAnyResource;
  rr.requireResource = (key) => tag(origResource(key), { type: 'resource', keys: [key] });
  rr.requireAnyResource = (...keys) => tag(origAny(...keys), { type: 'resource', keys });
  rr.requireAnyBackoffice = () => tag((req, res, next) => next(), { type: 'anyBackoffice' });

  const auth = require(path.join(SERVER, 'middlewares/adminAuth'));
  const origRole = auth.requireAdminRole;
  auth.requireAdminRole = (...roles) => tag(origRole(...roles), { type: 'role', roles });
  auth.requireAdminAuth.__gate = { type: 'login' };
}

// Express 4 把掛載路徑編成 regexp；這裡只需要還原 router.use('/xxx') 的字面前綴。
function mountPrefix(layer) {
  if (layer.path) return layer.path;
  const src = layer.regexp && layer.regexp.source;
  if (!src || src === '^\\/?(?=\\/|$)') return '';
  const m = src.match(/^\^((?:\\\/[\w-]+)+)\\\/\?\(\?=\\\/\|\$\)$/);
  if (!m) throw new Error(`無法還原掛載路徑：${src}`);
  return m[1].replace(/\\\//g, '/');
}

function gatesOf(handles) {
  return handles.map((h) => h.__gate).filter(Boolean);
}

function walk(router, prefix, inherited, out) {
  const scoped = [...inherited];
  for (const layer of router.stack) {
    if (layer.route) {
      const own = gatesOf(layer.route.stack.map((s) => s.handle));
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of Object.keys(layer.route.methods)) {
        for (const p of paths) {
          out.push({ method: method.toUpperCase(), path: prefix + (p === '/' ? '' : p) || '/', gates: [...scoped, ...own] });
        }
      }
    } else if (layer.handle && layer.handle.stack) {
      walk(layer.handle, prefix + mountPrefix(layer), scoped, out);
    } else if (layer.handle && layer.handle.__gate) {
      // router.use(gate)：之後註冊的路由都要過這道
      scoped.push(layer.handle.__gate);
    }
  }
}

function loadAdminRouteGates() {
  installTaggedGates();
  const adminRouter = require(path.join(SERVER, 'routes/admin'));
  const out = [];
  walk(adminRouter, '', [], out);
  return out;
}

module.exports = { loadAdminRouteGates };

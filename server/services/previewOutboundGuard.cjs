'use strict';
// Task-only Preview boundary. Never loaded by the normal production entry.
const crypto = require('node:crypto');
function blocked() {
  return Object.assign(new Error('Preview external side effects are disabled'), { code: 'PREVIEW_SIDE_EFFECTS_BLOCKED' });
}
function targetOf(connectionString) {
  const u = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(u.protocol)) throw blocked();
  return { host: u.hostname.toLowerCase(), database: decodeURIComponent(u.pathname.slice(1)), port: Number(u.port || 5432) };
}
function targetHash(target) { return crypto.createHash('sha256').update(JSON.stringify([target.host, target.database, target.port])).digest('hex'); }
function install({ connectionString, expectedTargetHash, replayPolicy }) {
  const target = targetOf(connectionString);
  if (!/^[a-f0-9]{64}$/.test(expectedTargetHash || '') || targetHash(target) !== expectedTargetHash) throw blocked();
  const net = require('node:net');
  const tls = require('node:tls');
  const http = require('node:http');
  const https = require('node:https');
  const child = require('node:child_process');
  const { Worker } = require('node:worker_threads');
  const replaySpawn = replayPolicy ? require('./previewReplaySpawn.cjs').createReplaySpawn(child.spawn.bind(child), replayPolicy) : null;
  const allowedSockets = new WeakSet();
  const restore = [];
  const patch = (obj, key, value) => { const old = obj[key]; restore.push(() => { obj[key] = old; }); obj[key] = value; };
  function permitted(args) {
    if (Array.isArray(args[0])) args = args[0]; // Node net.createConnection forwards normalized arguments.
    const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (!o || o.path || o.lookup || o.fd !== undefined || String(o.host || 'localhost').toLowerCase() !== target.host || Number(o.port) !== target.port) throw blocked();
  }
  const originalConnect = net.Socket.prototype.connect;
  patch(net.Socket.prototype, 'connect', function (...args) {
    permitted(args); allowedSockets.add(this);
    return originalConnect.apply(this, args);
  });
  const originalTls = tls.connect;
  patch(tls, 'connect', function (...args) {
    const opts = args[0];
    if (opts && typeof opts === 'object' && opts.socket) {
      if (!allowedSockets.has(opts.socket)) throw blocked();
    } else permitted(args);
    return originalTls.apply(this, args);
  });
  const reject = () => { throw blocked(); };
  for (const mod of [http, https]) for (const method of ['request', 'get']) patch(mod, method, reject);
  if (globalThis.fetch) patch(globalThis, 'fetch', async () => { throw blocked(); });
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) patch(child, key, reject);
  if (replaySpawn) patch(child, 'spawn', replaySpawn);
  patch(require('node:worker_threads'), 'Worker', class extends Worker { constructor() { throw blocked(); } });
  patch(require('node:dgram'), 'createSocket', reject);
  return { restore() { for (const fn of restore.reverse()) fn(); } };
}
module.exports = { install, targetOf, targetHash, blocked };

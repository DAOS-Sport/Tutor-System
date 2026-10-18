'use strict';
// Narrow trusted-app exception, not an OS sandbox. Policy is operator-owned,
// never derived from an HTTP request. All other child APIs remain blocked.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function refused() { return Object.assign(new Error('Preview replay execution refused'), { code: 'PREVIEW_REPLAY_REFUSED' }); }
function createReplaySpawn(originalSpawn, policy) {
  if (!policy || !path.isAbsolute(policy.binary || '') || !/^[a-f0-9]{64}$/.test(policy.sha256 || '')) throw refused();
  const binary = fs.realpathSync(policy.binary);
  const cwd = path.dirname(binary);
  let active = 0;
  return function guardedReplay(command, args, options) {
    if (command !== binary || !Array.isArray(args) || args.length !== 1 || args[0] !== 'replay-stdin'
      || !options || Object.keys(options).sort().join(',') !== 'cwd,env,shell,stdio,windowsHide'
      || options.shell !== false || options.windowsHide !== true || options.cwd !== cwd
      || JSON.stringify(options.stdio) !== '["pipe","pipe","pipe"]'
      || !options.env || Object.keys(options.env).sort().join(',') !== 'LANG,TZ'
      || options.env.LANG !== 'C' || options.env.TZ !== 'UTC' || active >= 1) throw refused();
    if (fs.realpathSync(command) !== binary || crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== policy.sha256) throw refused();
    const child = originalSpawn(binary, ['replay-stdin'], { shell:false, windowsHide:true, cwd, env:{ LANG:'C', TZ:'UTC' }, stdio:['pipe','pipe','pipe'] });
    active += 1;
    let input = 0, output = 0, released = false;
    const timer = setTimeout(() => child.kill(), 10000);
    const release = () => { if (!released) { released = true; active -= 1; clearTimeout(timer); } };
    child.once('close', release); child.once('error', release);
    const count = chunk => { input += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk)); if (input > 8 * 1024 * 1024) { child.kill(); throw refused(); } };
    const write = child.stdin.write.bind(child.stdin), end = child.stdin.end.bind(child.stdin);
    child.stdin.write = function(chunk, ...rest) { count(chunk); return write(chunk, ...rest); };
    child.stdin.end = function(chunk, ...rest) { if (chunk !== undefined && chunk !== null) count(chunk); return end(chunk, ...rest); };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.length; if (output > 4 * 1024 * 1024) child.kill(); });
    return child;
  };
}
module.exports = { createReplaySpawn };

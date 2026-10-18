'use strict';
// Official stopped-development Workflow only. Does not build/install/read config.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..'); // server/scripts
// Official rustup opt-out: https://rust-lang.github.io/rustup/environment-variables.html
// Process-local only; a missing pinned toolchain must fail rather than download.
process.env.RUSTUP_AUTO_INSTALL = '0';
process.env.CARGO_NET_OFFLINE = 'true';
function version(command, pattern) {
  const r = spawnSync(command, ['--version'], { encoding:'utf8', timeout:5000, shell:false, windowsHide:true });
  return { available:r.status===0 && pattern.test(r.stdout || ''), version:pattern.test(r.stdout || '') ? r.stdout.trim() : null, errorCode:r.error?.code || (r.status===0?null:'COMMAND_UNAVAILABLE') };
}
const cargoLock = path.join(root,'tools/ragic-shadow-core/Cargo.lock');
const receipt = {kind:'readonly-toolchain-probe',platform:process.platform,arch:process.arch,
 rustc:version('rustc',/^rustc \d+\.\d+\.\d+[^\r\n]*\r?\n?$/),cargo:version('cargo',/^cargo \d+\.\d+\.\d+[^\r\n]*\r?\n?$/),
 sourcePresent:fs.existsSync(path.join(root,'tools/ragic-shadow-core/Cargo.toml')),
 lockSha256:fs.existsSync(cargoLock)?crypto.createHash('sha256').update(fs.readFileSync(cargoLock)).digest('hex'):null,
 built:false,installCommandIssued:false,autoInstallDisabled:true,databaseAccess:false,appStarted:false};
console.log(JSON.stringify(receipt));

'use strict';
// Fresh filesystem proof only. Does not fetch the browser-blocked Preview or access DB/env.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '../..');
const at = relative => path.join(root, relative);
const readJson = relative => JSON.parse(fs.readFileSync(at(relative)));
const manifest = readJson('server/scripts/original-guides-redo-v11-manifest.json');
const receipt = readJson('outputs/original-guides-redo-20260930-v11-build/receipt.json');
const readback = readJson('outputs/original-guides-redo-20260930/applied-v11/source-readback.json');
const baseline = readJson('outputs/original-guides-redo-20260930/preview-baseline.json');
const hashes = Object.fromEntries(Object.keys(manifest.sourceRawByteSha256).map(relative => {
  if (!/^client\/liff\/src\/[A-Za-z0-9_./-]+\.(jsx|js|mjs)$/.test(relative) || relative.includes('..')) throw Error('PROOF_PATH_INVALID');
  return [relative, sha(fs.readFileSync(at(relative)))];
}));
const allSourceRawMatches = Object.entries(hashes).every(([relative,value]) => manifest.sourceRawByteSha256[relative] === value);
const liffIndexSha = sha(fs.readFileSync(at('server/public/liff/index.html')));
const adminIndexSha = sha(fs.readFileSync(at('server/public/admin/index.html')));
const adminIndexUnchanged = adminIndexSha === baseline.rows.find(row => row.surface === 'admin').sha256;
const status = receipt.status === 'PASS' && allSourceRawMatches && liffIndexSha === receipt.indexes.liff.sha256 && adminIndexUnchanged ? 'FILESYSTEM_PROOF_PASS' : 'FAIL';
const proof = { status, capturedAt: new Date().toISOString(), buildReceipt: receipt, sourceReadback: readback, allSourceRawMatches, rawHashCount: Object.keys(hashes).length, freshSourceRawHashes: hashes, liffIndexSha, adminIndexSha, adminIndexUnchanged, httpOrBrowserAcceptance: false, databaseAccess: false, workflowChanged: false };
fs.writeFileSync(at('outputs/original-guides-redo-20260930/proof-v11.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status, rawHashCount: proof.rawHashCount, changedReadbackCount: readback.files.length, adminIndexUnchanged, browserAcceptance: false }));
if (status !== 'FILESYSTEM_PROOF_PASS') process.exitCode = 1;

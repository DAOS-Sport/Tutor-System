'use strict';
// Candidate for official development Workflow only, after stopping the old app.
// No app/bootstrap, database, dotenv, package install, shell or deployment action.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..'); // staged at server/scripts/<this file>
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const expectedPaths = ["client/admin/src/api/families.js","client/admin/src/components/FamilyPanel.jsx","server/routes/admin/customerParents.js","server/routes/admin/families.js","server/routes/parents.js","server/services/parentSync.js","server/services/z03IdentityClaim.js"];
async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'preview-phone-manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !/^[a-z0-9-]{1,70}$/.test(manifest.runId || '') || !/^[a-f0-9]{64}$/.test(manifest.liveIndexHash || '')) fail('MANIFEST_INVALID');
  if (JSON.stringify(Object.keys(manifest.sources || {}).sort()) !== JSON.stringify(expectedPaths.slice().sort())) fail('SOURCE_SET_INVALID');
  for (const relative of expectedPaths) {
    if (!/^[a-f0-9]{64}$/.test(manifest.sources[relative]) || hash(fs.readFileSync(path.join(root, relative))) !== manifest.sources[relative]) fail('SOURCE_HASH_MISMATCH');
  }
  const live = path.join(root, 'server/public/admin');
  const index = path.join(live, 'index.html');
  const original = fs.readFileSync(index);
  if (hash(original) !== manifest.liveIndexHash) fail('LIVE_INDEX_CAS_MISMATCH');
  const artifacts = path.join(root, 'outputs', manifest.runId);
  if (fs.existsSync(artifacts)) fail('RUN_DIRECTORY_EXISTS');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'original-index.html'), original, { flag: 'wx' });
  const client = path.join(root, 'client/admin');
  const { build } = await import(pathToFileURL(path.join(client, 'node_modules/vite/dist/node/index.js')).href);
  const react = (await import(pathToFileURL(path.join(client, 'node_modules/@vitejs/plugin-react/dist/index.js')).href)).default;
  const stage = path.join(artifacts, 'admin-build');
  await build({ root: client, configFile: false, envFile: false, plugins: [react()], base: '/admin/', build: { outDir: stage, emptyOutDir: false } });
  const next = fs.readFileSync(path.join(stage, 'index.html'));
  const references = [...next.toString('utf8').matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  if (!references.length) fail('NO_BUILD_REFERENCES');
  for (const ref of references) {
    if (ref === '/brand/company-1b122f0a.png') { if (!original.toString('utf8').includes(ref) || !fs.existsSync(path.join(root, 'server/public/brand/company-1b122f0a.png'))) fail('BRAND_ASSET_MISSING'); continue; }
    if (!/^\/admin\/assets\/[A-Za-z0-9_.-]+$/.test(ref)) fail('UNEXPECTED_ASSET_REFERENCE');
    const name = ref.slice('/admin/'.length), source = path.join(stage, name);
    if (!fs.existsSync(source)) fail('BUILD_ASSET_MISSING');
  }
  // Include lazy chunks as well as the two assets referenced directly by index.
  const assets = fs.readdirSync(path.join(stage, 'assets'));
  for (const filename of assets) {
    if (!/^[A-Za-z0-9_.-]+$/.test(filename)) fail('UNEXPECTED_ASSET_NAME');
    const source = path.join(stage, 'assets', filename), dest = path.join(live, 'assets', filename);
    if (!fs.statSync(source).isFile()) fail('UNEXPECTED_ASSET_DIRECTORY');
    if (fs.existsSync(dest) && hash(fs.readFileSync(dest)) !== hash(fs.readFileSync(source))) fail('ASSET_COLLISION');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  }
  if (hash(fs.readFileSync(index)) !== manifest.liveIndexHash) fail('LIVE_INDEX_CAS_CHANGED');
  const candidate = path.join(live, `${manifest.runId}.index.tmp`);
  fs.writeFileSync(candidate, next, { flag: 'wx' });
  fs.renameSync(candidate, index);
  const receipt = { status: 'PASS', runId: manifest.runId, indexSha256: hash(next), previousIndexSha256: hash(original), sourceHashes: manifest.sources, databaseAccess: false, appStarted: false, oldAssetsPreserved: true };
  fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(receipt));
}
main().catch(error => { console.error(JSON.stringify({ status: 'FAIL', code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'BUILD_FAILED' })); process.exitCode = 1; });

'use strict';
// Independent Shell operator: precise source CAS, backup, then LIFF build. No workflow or DB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };
async function main() {
  if (process.argv.length !== 4) fail('ARGUMENTS_INVALID');
  const root = path.resolve(__dirname, '../..');
  const encoded = fs.readFileSync(path.join(root, 'outputs/original-guides-redo-20260930/delivery.json.gz'));
  if (sha(encoded) !== process.argv[2]) fail('DELIVERY_GZIP_HASH_MISMATCH');
  const payload = JSON.parse(zlib.gunzipSync(encoded));
  if (payload.version !== 1 || payload.digest !== process.argv[3] || !payload.files.length) fail('DELIVERY_INVALID');
  const directory = path.join(root, 'outputs/original-guides-redo-20260930/applied-v11');
  if (fs.existsSync(directory)) fail('APPLIED_DIRECTORY_EXISTS');
  const seen = new Set();
  for (const file of payload.files) {
    if (!/^client\/liff\/src\/[A-Za-z0-9_./-]+\.(jsx|js|mjs)$/.test(file.path) || file.path.includes('..') || seen.has(file.path)) fail('SOURCE_PATH_INVALID');
    seen.add(file.path);
    if (typeof file.content !== 'string' || sha(file.content) !== file.targetRawSha256) fail('TARGET_RAW_HASH_MISMATCH');
    const absolute = path.join(root, file.path);
    if (file.beforeRawSha256 === null) {
      if (fs.existsSync(absolute)) fail('NEW_SOURCE_ALREADY_EXISTS');
    } else if (!fs.existsSync(absolute) || sha(fs.readFileSync(absolute)) !== file.beforeRawSha256) fail('SOURCE_RAW_CAS_MISMATCH');
  }
  for (const [relative, expected] of Object.entries(payload.baseHashes)) {
    if (!/^client\/liff\/(src\/[A-Za-z0-9_./-]+\.(jsx|js|mjs)|package\.json)$/.test(relative) || relative.includes('..')) fail('BASE_PATH_INVALID');
    if (sha(fs.readFileSync(path.join(root, relative))) !== expected) fail('SNAPSHOT_RAW_CAS_MISMATCH');
  }
  if (sha(fs.readFileSync(path.join(root, 'server/public/liff/index.html'))) !== payload.manifest.indexRawByteSha256.liff) fail('INDEX_RAW_CAS_MISMATCH');
  fs.mkdirSync(directory, { recursive: true });
  for (const file of payload.files) {
    if (file.beforeRawSha256 !== null) {
      const saved = path.join(directory, 'before', file.path);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.copyFileSync(path.join(root, file.path), saved, fs.constants.COPYFILE_EXCL);
    }
  }
  fs.writeFileSync(path.join(directory, 'review.json'), JSON.stringify({
    digest: payload.digest, files: payload.files.map(({ path, beforeRawSha256, targetRawSha256 }) => ({ path, beforeRawSha256, targetRawSha256 })),
    workflowChanged: false, databaseAccess: false,
  }, null, 2), { flag: 'wx' });
  for (const file of payload.files) {
    const absolute = path.join(root, file.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (file.beforeRawSha256 === null ? fs.existsSync(absolute) : sha(fs.readFileSync(absolute)) !== file.beforeRawSha256) fail('SOURCE_CAS_CHANGED');
    const temporary = absolute + '.original-guides-v11.tmp';
    fs.writeFileSync(temporary, file.content, { flag: 'wx' });
    fs.renameSync(temporary, absolute);
    if (sha(fs.readFileSync(absolute)) !== file.targetRawSha256) fail('SOURCE_READBACK_MISMATCH');
  }
  const scripts = path.join(root, 'server/scripts');
  fs.writeFileSync(path.join(scripts, 'originalGuidesV11Build.cjs'), payload.builder, { flag: 'wx' });
  fs.writeFileSync(path.join(scripts, 'original-guides-redo-v11-manifest.json'), JSON.stringify(payload.manifest, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'source-readback.json'), JSON.stringify({
    status: 'SOURCE_READBACK_PASS', files: payload.files.map(f => ({ path: f.path, sha256: sha(fs.readFileSync(path.join(root, f.path))) })),
    databaseAccess: false, workflowChanged: false,
  }, null, 2), { flag: 'wx' });
  process.argv = [process.argv[0], path.join(scripts, 'originalGuidesV11Build.cjs'), payload.digest];
  await require(path.join(scripts, 'originalGuidesV11Build.cjs')).main();
}
module.exports = { main };
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', code: /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'ORIGINAL_GUIDE_BUILD_FAILED' }));
  process.exitCode = 1;
});

'use strict';
// Reviewed guide and Z03 build for the stopped-development Preview workflow.
// It never loads dotenv or app bootstrap and must not be run until the manifest,
// current raw index byte hashes, and exact remote source set are reviewed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalLf = (buffer) => Buffer.from(buffer.toString('utf8').replace(/\r\n?/g, '\n').trimEnd() + '\n', 'utf8');
const fail = (code) => { throw Object.assign(Error(code), { code }); };
const approvalDigest = 'e7eef8e210c8f91f9c9a8c1c9d6d3ec9db0e3568323ce3bb2ddb2c09dabe1a3d';
const manifestName = 'preview-coefficient-build-manifest.json';
const requiredPaths = [
  "server/bootstrap/admin.js",
  "server/bootstrap/coreSchema.js",
  "server/routes/enrollments.js",
  "server/routes/groupOrders.js",
  "server/routes/admin/enrollments.js",
  "server/routes/admin/groupOrders.js",
  "server/routes/admin/sessions.js",
  "db/migrations/068_purchased_pricing_snapshot.sql",
  "client/admin/src/utils/sessionExportSummary.mjs",
  "client/admin/src/utils/sessionXlsxReport.mjs",
  "client/admin/src/utils/sessionPivotXlsx.mjs",
  "client/admin/src/utils/csvExport.js",
  "client/admin/src/pages/SessionsPage.jsx",
  "client/admin/src/api/sessions.js",
  "client/admin/src/components/ExportMenu.jsx"
];
let pool;
const publicKeys = [
  'VITE_LIFF_ID_PARENT', 'VITE_LIFF_ID_COACH', 'VITE_LIFF_ID',
  'VITE_SUPPORT_LINE_COACH', 'VITE_SUPPORT_LINE_PARENT', 'VITE_USE_MOCK',
];
const cssSelectors = {
  admin: ['.bg-brand-primary', '.text-brand-primary', '.grid-cols-7', String.raw`.min-h-\[44px\]`],
  liff: ['.bg-brand-primary', '.text-brand-primary', '.grid-cols-7', String.raw`.min-h-\[44px\]`],
};

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== approvalDigest) fail('UNAPPROVED_TARGET_DIGEST');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, manifestName), 'utf8'));
  const sourceKeys = Object.keys(manifest.sourceCanonicalLfSha256).sort();
  if (
    manifest.version !== 2 ||
    manifest.runId !== 'preview-purchased-coefficient-20260930-v1' ||
    JSON.stringify(sourceKeys) !== JSON.stringify(requiredPaths.slice().sort())
  ) fail('MANIFEST_INVALID');

  for (const relative of requiredPaths) {
    const bytes = fs.readFileSync(path.join(root, relative));
    if (sha(canonicalLf(bytes)) !== manifest.sourceCanonicalLfSha256[relative]) fail('SOURCE_CANONICAL_LF_HASH_MISMATCH');
  }

  // Only presence is logged. Values remain in process memory and never enter receipts.
  console.log(JSON.stringify({
    event: 'public_build_settings',
    presence: Object.fromEntries(publicKeys.map((key) => [key, Boolean(process.env[key])])),
  }));
  if (!(process.env.VITE_LIFF_ID_PARENT || process.env.VITE_LIFF_ID)) fail('PUBLIC_PARENT_LIFF_ID_MISSING');
  if (!(process.env.VITE_LIFF_ID_COACH || process.env.VITE_LIFF_ID)) fail('PUBLIC_COACH_LIFF_ID_MISSING');
  if (process.env.VITE_USE_MOCK === 'true') fail('MOCK_BUILD_REFUSED');

  const artifacts = path.join(root, 'outputs', manifest.runId);
  if (fs.existsSync(artifacts)) fail('RUN_DIRECTORY_EXISTS');
  fs.mkdirSync(artifacts);
  const staged = [];

  for (const kind of ['admin', 'liff']) {
    const client = path.join(root, 'client', kind);
    const live = path.join(root, 'server/public', kind);
    const index = path.join(live, 'index.html');
    const original = fs.readFileSync(index);
    // CAS is raw bytes. The saved read_file receipt is only a way to recover the
    // known-LF baseline; canonical source hashing is never substituted here.
    if (sha(original) !== manifest.indexRawByteSha256[kind]) fail('INDEX_RAW_BYTE_CAS_MISMATCH');
    fs.writeFileSync(path.join(artifacts, `${kind}-original-index.html`), original, { flag: 'wx' });

    const viteModule = path.join(client, 'node_modules/vite/dist/node/index.js');
    const reactModule = path.join(client, 'node_modules/@vitejs/plugin-react/dist/index.js');
    const { build } = await import(pathToFileURL(viteModule).href);
    const react = (await import(pathToFileURL(reactModule).href)).default;
    const stage = path.join(artifacts, `${kind}-build`);
    const previousCwd = process.cwd();
    try {
      process.chdir(client);
      await build({
        root: client,
        configFile: false,
        envFile: false,
        plugins: [react()],
        base: `/${kind}/`,
        build: { outDir: stage, emptyOutDir: false },
      });
    } finally {
      process.chdir(previousCwd);
    }

    const assetDir = path.join(stage, 'assets');
    const names = fs.readdirSync(assetDir);
    const css = names.filter((name) => name.endsWith('.css'))
      .map((name) => fs.readFileSync(path.join(assetDir, name), 'utf8')).join('\n');
    if (Buffer.byteLength(css) === 0) fail('CSS_EMPTY');
    for (const selector of cssSelectors[kind]) if (!css.includes(selector)) fail('TAILWIND_UTILITY_MISSING');
    if (!/rgb\(21\s+49\s+106\s*(?:\/|\))/.test(css)) fail('TAILWIND_BRAND_MISSING');

    const next = fs.readFileSync(path.join(stage, 'index.html'));
    const references = [...next.toString().matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    if (!references.length) fail('NO_BUILD_REFERENCES');
    for (const reference of references) {
      if (reference === '/brand/company-1b122f0a.png') {
        if (!original.toString().includes(reference) || !fs.existsSync(path.join(root, 'server/public/brand/company-1b122f0a.png'))) fail('BRAND_ASSET_MISSING');
        continue;
      }
      if (!new RegExp(`^/${kind}/assets/[A-Za-z0-9_.-]+$`).test(reference)) fail('BUILD_ASSET_REFERENCE_INVALID');
      if (!fs.existsSync(path.join(stage, reference.slice(kind.length + 2)))) fail('BUILD_ASSET_REFERENCE_MISSING');
    }
    for (const name of names) {
      const built = path.join(assetDir, name);
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || !fs.statSync(built).isFile()) fail('BUILD_ASSET_INVALID');
      const destination = path.join(live, 'assets', name);
      if (fs.existsSync(destination) && sha(fs.readFileSync(destination)) !== sha(fs.readFileSync(built))) fail('ASSET_COLLISION');
    }
    staged.push({ kind, live, index, original, next, assetDir, names, cssBytes: Buffer.byteLength(css) });
  }

  for (const entry of staged) if (sha(fs.readFileSync(entry.index)) !== manifest.indexRawByteSha256[entry.kind]) fail('INDEX_CAS_CHANGED');
  // Builds and CSS gates succeed before this additive schema migration.
  require('../services/previewOutboundGuard.cjs').install({connectionString:process.env.DATABASE_URL,expectedTargetHash:approvalDigest});
  const {Pool}=require('pg');
  pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c timezone=Asia/Taipei'});
  const client=await pool.connect();
  try {
    const cp=client.connectionParameters;
    if(sha(JSON.stringify([String(cp.host).toLowerCase(),cp.database,Number(cp.port)]))!==approvalDigest)fail('ACTUAL_TEST_TARGET_MISMATCH');
    if((await client.query('SELECT current_database() AS database')).rows[0]?.database!==cp.database)fail('ACTUAL_DATABASE_MISMATCH');
    await client.query('BEGIN');
    await client.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'");
    const expected=[['group_orders','purchased_pricing_multiplier',5],['group_orders','purchased_unit_price',10],['admin_enrollments','purchased_pricing_multiplier',5],['course_periods','purchased_pricing_multiplier',5]];
    async function checkSchema(required) {
      for(const [table,column,precision] of expected) {
        const q=await client.query('SELECT data_type,numeric_precision,numeric_scale,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',['public',table,column]);
        if(!q.rowCount){if(required)fail('SNAPSHOT_SCHEMA_MISSING');continue;}
        const r=q.rows[0];if(r.data_type!=='numeric'||r.numeric_precision!==precision||r.numeric_scale!==2||r.is_nullable!=='YES')fail('SNAPSHOT_SCHEMA_MISMATCH');
      }
    }
    await checkSchema(false);
    await client.query(fs.readFileSync(path.join(root,'db/migrations/068_purchased_pricing_snapshot.sql'),'utf8'));
    await checkSchema(true);
    const constraints=await client.query("SELECT COUNT(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='c' AND c.convalidated AND c.conname=ANY($1::text[])",[['chk_group_orders_purchased_multiplier','chk_group_orders_purchased_unit_price','chk_admin_enrollments_purchased_multiplier','chk_course_periods_purchased_multiplier']]);
    if(constraints.rows[0].n!==4)fail('SNAPSHOT_CONSTRAINT_MISSING');
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
  await pool.end();pool=null;
  // Immutable assets are additive. Every old asset remains available for the old index and rollback.
  for (const entry of staged) {
    fs.mkdirSync(path.join(entry.live, 'assets'), { recursive: true });
    for (const name of entry.names) {
      const destination = path.join(entry.live, 'assets', name);
      if (!fs.existsSync(destination)) fs.copyFileSync(path.join(entry.assetDir, name), destination, fs.constants.COPYFILE_EXCL);
    }
  }
  for (const entry of staged) if (sha(fs.readFileSync(entry.index)) !== manifest.indexRawByteSha256[entry.kind]) fail('INDEX_CAS_CHANGED');

  const changed = [];
  try {
    for (const entry of staged) {
      const temporary = path.join(entry.live, `${manifest.runId}.tmp`);
      fs.writeFileSync(temporary, entry.next, { flag: 'wx' });
      fs.renameSync(temporary, entry.index);
      changed.push(entry);
    }
  } catch (error) {
    for (const entry of changed) {
      const rollback = path.join(entry.live, `${manifest.runId}.rollback.tmp`);
      fs.writeFileSync(rollback, entry.original, { flag: 'wx' });
      fs.renameSync(rollback, entry.index);
    }
    throw error;
  }

  const receipt = {
    status: 'PASS',
    runId: manifest.runId,
    sourceCanonicalization: manifest.sourceCanonicalization,
    sources: manifest.sourceCanonicalLfSha256,
    indexes: Object.fromEntries(staged.map((entry) => [entry.kind, { sha256: sha(entry.next), cssBytes: entry.cssBytes }])),
    databaseAccess: true,
    migration068: true,
    historicalBackfill: false,
    rowsChanged: 0,
    oldAssetsPreserved: true,
    appStarted: false,
    noticesDispatched: false,
  };
  fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(receipt));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'FAIL', code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'GUIDE_Z03_BUILD_FAILED' }));
  process.exitCode = 1;
}).finally(async()=>{if(pool)await pool.end();});

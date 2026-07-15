// Object Storage driver 選擇契約：不連線 bucket、不寫檔，只以獨立 Node process
// 載入 module，避免 require cache 與本機環境變數互相污染。
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const modulePath = path.join(ROOT, 'server/services/objectStorage');
const STORAGE_ENV_KEYS = [
  'NODE_ENV',
  'OBJECT_STORAGE_DRIVER',
  'OBJECT_STORAGE_BUCKET_ID',
  'REPLIT_OBJECT_STORAGE_BUCKET',
];

function driverFor(overrides = {}) {
  const env = { ...process.env };
  for (const key of STORAGE_ENV_KEYS) delete env[key];
  Object.assign(env, overrides);

  const result = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(require(${JSON.stringify(modulePath)}).driverName)`],
    { cwd: ROOT, env, encoding: 'utf8' }
  );
  assert.strictEqual(result.status, 0, result.stderr || 'objectStorage failed to load');
  return result.stdout.trim();
}

assert.strictEqual(driverFor(), 'local', '未設定時 local 開發應使用 local driver');
assert.strictEqual(
  driverFor({ NODE_ENV: 'development', REPLIT_OBJECT_STORAGE_BUCKET: 'configured-bucket' }),
  'local',
  'local 開發即使有 bucket 設定也不可意外切換 driver'
);
assert.strictEqual(
  driverFor({ NODE_ENV: 'production' }),
  'replit',
  'production 未覆寫時必須使用 Replit shared storage，bucket 缺失由 startup probe fail closed'
);
assert.strictEqual(
  driverFor({ NODE_ENV: 'production', OBJECT_STORAGE_BUCKET_ID: 'alternate-bucket-id' }),
  'replit',
  '指定非預設 bucket 時 production 必須使用 Replit driver'
);
assert.strictEqual(
  driverFor({ NODE_ENV: 'production', REPLIT_OBJECT_STORAGE_BUCKET: 'configured-bucket', OBJECT_STORAGE_DRIVER: 'local' }),
  'local',
  'driver 選擇可被觀察，但 production startup gate 會拒絕 explicit local'
);
assert.strictEqual(
  driverFor({ NODE_ENV: 'development', OBJECT_STORAGE_DRIVER: 'replit' }),
  'replit',
  '明確 replit override 應可供整合測試使用'
);
assert.strictEqual(
  driverFor({ NODE_ENV: 'production', OBJECT_STORAGE_DRIVER: 'db' }),
  'db',
  'production 可明確選用 PostgreSQL 耐久 driver'
);

const dbGate = spawnSync(
  process.execPath,
  ['-e', `require(${JSON.stringify(modulePath)}).assertProductionStorageConfigured()`],
  {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', OBJECT_STORAGE_DRIVER: 'db' },
    encoding: 'utf8',
  }
);
assert.strictEqual(dbGate.status, 0, 'production + db（PostgreSQL 耐久儲存）必須通過 configured gate');

const gate = spawnSync(
  process.execPath,
  ['-e', `require(${JSON.stringify(modulePath)}).assertProductionStorageConfigured()`],
  {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', OBJECT_STORAGE_DRIVER: 'local' },
    encoding: 'utf8',
  }
);
assert.notStrictEqual(gate.status, 0, 'production + local storage must fail startup/preflight');

// Regression: production 曾在 bucket preflight 失敗後切到 Autoscale 的本機空目錄，
// 讓所有既有 /uploads 照片變成 404，且新上傳不具持久性。正式環境不可再有此入口。
// 唯一允許的 runtime fallback 是 PostgreSQL 耐久 driver（useFallbackDbDriver）。
const storageModule = require(modulePath);
assert.strictEqual(
  storageModule.useFallbackLocalDriver,
  undefined,
  'object storage must not expose an unsafe runtime local-disk fallback',
);
assert.strictEqual(
  typeof storageModule.useFallbackDbDriver,
  'function',
  'bucket preflight 失敗時必須有 PostgreSQL 耐久 fallback 可用',
);

console.log('object_storage_driver_test: PASS');

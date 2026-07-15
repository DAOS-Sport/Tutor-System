/**
 * Chat 媒體儲存 — Adapter 抽象層（spec F-S09 / F-C03）
 *
 * 開發環境預設使用 LocalDiskDriver；production 一律選用 Replit App Storage，
 * 並在 listen 前實際探測 bucket，避免 Autoscale 多實例／重部署遺失附件。
 * bucket 未開通／preflight 失敗時，production 改用 PostgreSQL 耐久 driver
 * （uploaded_files 表）——與 schema bootstrap 同一顆 DB，跨實例共享、重部署不消失。
 * 絕不可降級 local disk：Autoscale 本機磁碟會讓家長照片 404、objectExists 於別台
 * 實例驗證失敗（對帳清單讀不到匯款證明的根因）。
 * driver pattern 讓未來切到 S3 / GCS 時業務碼不需改動。
 *
 * 安全：
 *  - 強制 MIME + 副檔名白名單（杜絕 .html/.svg/.js 同源 XSS）
 *  - 大小上限（預設 25 MB）
 *  - LocalDisk 由 server/index.js 的 /uploads middleware 加上
 *    nosniff / CSP sandbox / Content-Disposition:attachment 三道防線
 *
 * 切換方式：環境變數 OBJECT_STORAGE_DRIVER=local|replit|db。
 * 未設定時：production → replit（preflight 失敗自動降級 db），其餘（含 local dev）→ local。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { formatPlainDate } = require('../utils/dateTime');

const ALLOWED_MAX_BYTES = Number(process.env.CHAT_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024;

// 嚴格 MIME → ext 白名單
const ALLOWED = {
  // 影像（不接受 image/svg+xml — SVG 內可嵌 <script>）
  'image/jpeg':      ['.jpg', '.jpeg', '.jfif'],
  'image/png':       ['.png'],
  'image/gif':       ['.gif'],
  'image/webp':      ['.webp'],
  'image/heic':      ['.heic'],
  'image/heif':      ['.heif'],
  'image/avif':      ['.avif'],
  // 影片
  'video/mp4':       ['.mp4', '.m4v'],
  'video/quicktime': ['.mov'],
  'video/webm':      ['.webm'],
  // 音訊
  'audio/mpeg':      ['.mp3'],
  'audio/wav':       ['.wav'],
  'audio/x-wav':     ['.wav'],
  'audio/mp4':       ['.m4a'],
  'audio/aac':       ['.aac'],
  'audio/ogg':       ['.ogg'],
  'audio/amr':       ['.amr'],
  'audio/webm':      ['.webm'],
  // 文件
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       ['.xlsx'],
};

function isAllowed(mimeType, ext) {
  const exts = ALLOWED[(mimeType || '').toLowerCase()];
  if (!exts) return false;
  return exts.includes((ext || '').toLowerCase());
}

function inferMessageType(mimeType, ext) {
  const m = (mimeType || '').toLowerCase();
  const e = (ext || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'voice';
  if (['.jpg','.jpeg','.jfif','.png','.gif','.webp','.heic','.heif','.avif'].includes(e)) return 'image';
  if (['.mp4','.mov','.webm','.m4v'].includes(e)) return 'video';
  if (['.mp3','.wav','.m4a','.ogg','.aac','.amr'].includes(e)) return 'voice';
  return 'file';
}

function safeExt(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (!ext || ext.length > 6) return '';
  return ext.replace(/[^a-z0-9.]/g, '');
}

// ── Driver: Local Disk ────────────────────────────────────────
const LOCAL_ROOT = path.join(__dirname, '..', 'uploads');
const LocalDiskDriver = {
  name: 'local',
  async saveBuffer({ buffer, ext }) {
    if (!fs.existsSync(LOCAL_ROOT)) fs.mkdirSync(LOCAL_ROOT, { recursive: true });
    const yyyymm = formatPlainDate(new Date()).slice(0, 7);
    const dir = path.join(LOCAL_ROOT, yyyymm);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(12).toString('hex');
    const filename = `${id}${ext}`;
    await fs.promises.writeFile(path.join(dir, filename), buffer);
    // /uploads 由 server/index.js 提供 middleware（含 nosniff + CSP sandbox）
    return { url: `/uploads/${yyyymm}/${filename}` };
  },
  async exists(key) {
    const full = path.resolve(LOCAL_ROOT, key);
    if (full !== LOCAL_ROOT && !full.startsWith(LOCAL_ROOT + path.sep)) return false;
    try {
      await fs.promises.access(full, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
};

// ── Driver: Replit App Storage（Object Storage bucket）────────────
// 為什麼需要：正式環境是 Autoscale 多實例＋臨時檔案系統，本機磁碟寫入的檔案
// 無法跨實例存取、也無法在重新部署後存活。改存共享 bucket 後，上傳／驗證／事後
// 檢視都與「處理請求的是哪個實例」無關。
// 物件 key 用 `YYYY-MM/xxxx.ext`（去掉 /uploads 前綴的相對路徑），對外 URL 仍維持
// `/uploads/YYYY-MM/xxxx.ext`，由 index.js 的 /uploads handler 從 bucket 串流回應。
// 啟用條件：在 Replit 面板為此 App 開通 Object Storage（會提供 default bucket）。
// production 偵測到 bucket 時會自動選用此 driver，也可明確設
// OBJECT_STORAGE_DRIVER=replit。Client 延遲建立，未開通 bucket 時只有在實際
// 上傳/讀取才會拋錯（模組載入不受影響，dev 仍可用 local）。
let replitClient = null;
function getReplitClient() {
  if (!replitClient) {
    const { Client } = require('@replit/object-storage');
    // SDK v1 的唯一自訂選項是 { bucketId }；未提供時由 Replit sidecar 取得
    // default bucket。REPLIT_OBJECT_STORAGE_BUCKET 保留相容專案既有部署命名。
    const bucketId = process.env.OBJECT_STORAGE_BUCKET_ID
      || process.env.REPLIT_OBJECT_STORAGE_BUCKET;
    replitClient = bucketId ? new Client({ bucketId }) : new Client();
  }
  return replitClient;
}

function createReplitDriver(getClient = getReplitClient) {
  return {
    name: 'replit',
    async saveBuffer({ buffer, ext }) {
      const yyyymm = formatPlainDate(new Date()).slice(0, 7);
      const id = crypto.randomBytes(12).toString('hex');
      const key = `${yyyymm}/${id}${ext}`;
      const result = await getClient().uploadFromBytes(key, buffer);
      if (!result || result.ok !== true) {
        const err = new Error('物件儲存上傳失敗');
        err.code = 'OBJECT_STORAGE_UPLOAD_FAILED';
        throw err;
      }
      return { url: `/uploads/${key}` };
    },
    async exists(key) {
      // @replit/object-storage v1 Result<boolean, RequestError>：不存在是
      // { ok:true, value:false }；SDK/credential/bucket error 是 ok:false。
      const result = await getClient().exists(key);
      if (!result || result.ok !== true) {
        const err = new Error('物件儲存查詢失敗');
        err.code = 'OBJECT_STORAGE_LOOKUP_FAILED';
        throw err;
      }
      return result.value === true;
    },
    // 回傳一個 Node Readable（PassThrough）；物件不存在時串流會 emit 'error'，
    // 由 index.js 的 /uploads handler 轉成 404。key 已在 objectKeyFromUrl 過濾穿越。
    openReadStream(key) {
      return getClient().downloadAsStream(key);
    },
  };
}

const ReplitDriver = createReplitDriver();

// ── Driver: PostgreSQL（uploaded_files 表）───────────────────────
// bucket 未開通／異常時的耐久 fallback：檔案存 bytea，與 schema bootstrap 同一顆
// DB，天生跨實例共享且重部署不消失。lazy require pool，讓 driver 選擇契約測試
// 可以在沒有 DATABASE_URL 的獨立 process 載入本模組。
function createDbDriver(getPool = () => require('../models/db').pool) {
  return {
    name: 'db',
    async saveBuffer({ buffer, ext, mimeType }) {
      const yyyymm = formatPlainDate(new Date()).slice(0, 7);
      const id = crypto.randomBytes(12).toString('hex');
      const key = `${yyyymm}/${id}${ext}`;
      await getPool().query(
        `INSERT INTO uploaded_files (key, mime_type, bytes, byte_size)
         VALUES ($1, $2, $3, $4)`,
        [key, mimeType || 'application/octet-stream', buffer, buffer.length]
      );
      return { url: `/uploads/${key}` };
    },
    async exists(key) {
      const r = await getPool().query('SELECT 1 FROM uploaded_files WHERE key = $1', [key]);
      return r.rowCount > 0;
    },
    async readFile(key) {
      const r = await getPool().query(
        'SELECT bytes, mime_type FROM uploaded_files WHERE key = $1',
        [key]
      );
      if (!r.rowCount) return null;
      return { buffer: r.rows[0].bytes, mimeType: r.rows[0].mime_type || null };
    },
  };
}

const DbDriver = createDbDriver();

// 從對外 URL 還原 bucket 物件 key：'/uploads/2026-06/abc.jpg' → '2026-06/abc.jpg'
// 拒絕非 /uploads 前綴與路徑穿越（..），與 local 的防穿越規則一致。
function objectKeyFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  const key = url.slice('/uploads/'.length);
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\') || key.includes('\0')) return null;
  return key;
}

const DRIVERS = { local: LocalDiskDriver, replit: ReplitDriver, db: DbDriver };
const requestedDriver = String(process.env.OBJECT_STORAGE_DRIVER || '').trim().toLowerCase();
const shouldAutoUseReplit = !requestedDriver
  && process.env.NODE_ENV === 'production';
const selectedDriverName = requestedDriver || (shouldAutoUseReplit ? 'replit' : 'local');
let activeDriver = DRIVERS[selectedDriverName] || LocalDiskDriver;

// 供 index.js 在 bucket preflight 失敗時呼叫：降級至 PostgreSQL 耐久 driver（冪等）。
// probe 先確認 uploaded_files 可讀（coreSchema bootstrap 已在此之前建表）；
// probe 失敗會 throw，由啟動流程 fail closed——寧可拒絕啟動，也不可退回
// 會弄丟家長照片的本機磁碟。
async function useFallbackDbDriver() {
  if (activeDriver.name === 'db') return;
  await DbDriver.exists('__driver_preflight__');
  console.warn('[objectStorage] bucket unavailable; switching to durable PostgreSQL upload storage (uploaded_files)');
  activeDriver = DbDriver;
}

// An explicit local override remains useful for local troubleshooting, but it
// is intentionally loud in production because files would not be durable on
// an Autoscale deployment.
function assertProductionStorageConfigured({
  nodeEnv = process.env.NODE_ENV,
  actualDriver = activeDriver.name,
} = {}) {
  if (nodeEnv === 'production' && !['replit', 'db'].includes(actualDriver)) {
    const err = new Error('production 必須使用共享儲存（Replit bucket 或 PostgreSQL）；local driver 已拒絕');
    err.code = 'PRODUCTION_LOCAL_STORAGE_FORBIDDEN';
    throw err;
  }
  return true;
}

async function assertProductionStorageReady({
  nodeEnv = process.env.NODE_ENV,
  actualDriver = activeDriver.name,
  listObjects = () => getReplitClient().list({ maxResults: 1 }),
  probeDb = () => DbDriver.exists('__driver_preflight__'),
} = {}) {
  assertProductionStorageConfigured({ nodeEnv, actualDriver });
  if (nodeEnv !== 'production') return true;
  if (actualDriver === 'db') {
    try {
      await probeDb();
      return true;
    } catch {
      const err = new Error('production PostgreSQL upload storage preflight failed');
      err.code = 'PRODUCTION_STORAGE_PREFLIGHT_FAILED';
      throw err;
    }
  }
  let result;
  try {
    result = await listObjects();
  } catch {
    result = null;
  }
  if (!result || result.ok !== true) {
    const err = new Error('production object storage bucket/credentials preflight failed');
    err.code = 'PRODUCTION_STORAGE_PREFLIGHT_FAILED';
    throw err;
  }
  return true;
}

// ── 對外 API（保持 v1 簽名，呼叫端無需改動） ────────────────────
async function saveBuffer({ buffer, originalName = 'file.bin', mimeType = 'application/octet-stream' }) {
  if (!buffer || !buffer.length) throw new Error('檔案為空');
  if (buffer.length > ALLOWED_MAX_BYTES) {
    throw new Error(`檔案過大（上限 ${Math.round(ALLOWED_MAX_BYTES / 1024 / 1024)} MB）`);
  }
  // 副檔名一律以「已驗證的 MIME」為準正規化，而非全信原始檔名：
  // 手機／LINE 相機挑的圖常常沒有副檔名（檔名如 image），Windows 的 JPEG 又可能是 .jfif，
  // 這些都通過 MIME 白名單卻與 safeExt 取到的副檔名不符，舊寫法會誤判「不支援的檔案類型」而整個上傳失敗
  // （家長端症狀：末 5 碼能送出、但匯款證明圖片一直傳不上去）。改為：MIME 不在白名單才拒絕；
  // 原始副檔名缺漏或與 MIME 不符時，一律套用該 MIME 的正規副檔名，確保落地檔名可被後續 PROOF_URL 驗證通過。
  const allowedExts = ALLOWED[(mimeType || '').toLowerCase()];
  if (!allowedExts) {
    throw new Error(`不支援的檔案類型（${mimeType || 'unknown'}）`);
  }
  const originalExt = safeExt(originalName);
  const ext = allowedExts.includes(originalExt.toLowerCase()) ? originalExt : allowedExts[0];
  const { url } = await activeDriver.saveBuffer({ buffer, ext, mimeType });
  return {
    url,
    filename: originalName,
    size: buffer.length,
    mimeType,
    messageType: inferMessageType(mimeType, ext),
    driver: activeDriver.name,
  };
}

// 檢查一個物件 key 是否已落地於任何耐久來源。
// 為什麼查兩個來源：bucket 不可用期間上傳的檔案存在 uploaded_files；bucket 恢復
// （或日後開通）切回 replit driver 後，這些 URL 仍必須驗證通過、照片仍要能顯示，
// 否則對帳清單上既有的匯款證明會整批失效。
// fail closed：bucket lookup error 且 DB 也沒有此檔時，把 bucket error 丟回，
// 交由 parseProofInput 回 503，絕不把「查不到」當成「存在」。
async function sourceExists(key, { driver = activeDriver, dbDriver = DbDriver } = {}) {
  if (driver.name === 'replit') {
    let bucketError = null;
    try {
      if (await driver.exists(key)) return true;
    } catch (err) {
      bucketError = err;
    }
    let inDb = false;
    try {
      inDb = await dbDriver.exists(key);
    } catch (err) {
      throw bucketError || err;
    }
    if (inDb) return true;
    if (bucketError) throw bucketError;
    return false;
  }
  if (driver.name === 'db') return dbDriver.exists(key);
  // local dev：磁碟優先；開發資料庫可能存有 db-driver 時期的檔案，miss 時補查。
  if (await driver.exists(key)) return true;
  try {
    return await dbDriver.exists(key);
  } catch {
    return false;
  }
}

// 驗證一個對外 URL 是否真的指向本服務已落地的檔案（防止偽造 /uploads 路徑）。
async function objectExists(url) {
  const key = objectKeyFromUrl(url);
  if (!key) return false;
  return sourceExists(key);
}

// 以對外 URL 解析上傳檔案的讀取來源，供 index.js 的 /uploads handler 回應：
//   { kind: 'stream', stream }            — bucket 物件串流
//   { kind: 'buffer', buffer, mimeType }  — PostgreSQL uploaded_files
//   { kind: 'file',   path }              — local dev 磁碟（由 res.sendFile 提供）
//   null                                  — 不存在（404）
// 與 sourceExists 同一套 read-through 順序，任何 driver 切換都不會讓既有 URL 404。
async function openUpload(url, { driver = activeDriver, dbDriver = DbDriver } = {}) {
  const key = objectKeyFromUrl(url);
  if (!key) return null;
  if (driver.name === 'replit') {
    // 先 exists 再開串流：downloadAsStream 對不存在物件只會 emit error，
    // 無法在 header 送出前改走 DB fallback。多一次 lookup 換 read-through 正確性。
    let bucketError = null;
    try {
      if (await driver.exists(key)) {
        return { kind: 'stream', stream: driver.openReadStream(key) };
      }
    } catch (err) {
      bucketError = err;
    }
    let fromDb = null;
    try {
      fromDb = await dbDriver.readFile(key);
    } catch (err) {
      throw bucketError || err;
    }
    if (fromDb) return { kind: 'buffer', buffer: fromDb.buffer, mimeType: fromDb.mimeType };
    if (bucketError) throw bucketError;
    return null;
  }
  if (driver.name === 'db') {
    const found = await dbDriver.readFile(key);
    return found ? { kind: 'buffer', buffer: found.buffer, mimeType: found.mimeType } : null;
  }
  if (await driver.exists(key)) {
    return { kind: 'file', path: path.join(LOCAL_ROOT, key) };
  }
  try {
    const found = await dbDriver.readFile(key);
    return found ? { kind: 'buffer', buffer: found.buffer, mimeType: found.mimeType } : null;
  } catch {
    return null;
  }
}

module.exports = {
  saveBuffer,
  isAllowed,
  inferMessageType,
  objectExists,
  openUpload,
  UPLOAD_ROOT: LOCAL_ROOT,
  ALLOWED_MAX_BYTES,
  get driverName() { return activeDriver.name; },
  useFallbackDbDriver,
  assertProductionStorageConfigured,
  assertProductionStorageReady,
  __test__: {
    createReplitDriver,
    createDbDriver,
    sourceExists,
    objectKeyFromUrl,
  },
};

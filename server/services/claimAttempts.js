'use strict';
// 家長認領的嘗試紀錄（Owner 2026-10-20）：
// - 核對失敗只記在這裡，不再把整個家庭鎖成人工審核；同一個 LINE 帳號 30 分鐘內錯 5 次就要冷靜。
// - 靠身分證或姓名只差一字通過的也記下來，櫃台可在反查清單修正登記姓名。
// 開機時建表（bootstrap/admin.js）；發布前要先在 dev 庫跑過 SCHEMA_SQL，否則發布會提議刪表。
const crypto = require('crypto');
const { pool } = require('../models/db');

const FAILURE_LIMIT = 5;
const COOLDOWN_MINUTES = 30;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS parent_claim_attempts (
  id                   BIGSERIAL PRIMARY KEY,
  line_uid_hash        TEXT NOT NULL,
  phone_canonical      TEXT NOT NULL,
  path                 TEXT NOT NULL,
  source_record_id     TEXT,
  submitted_name       TEXT NOT NULL,
  submitted_id_present BOOLEAN NOT NULL DEFAULT FALSE,
  outcome              TEXT NOT NULL,
  matched_name         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at          TIMESTAMPTZ,
  reviewed_by          TEXT
);
CREATE INDEX IF NOT EXISTS idx_parent_claim_attempts_uid ON parent_claim_attempts(line_uid_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parent_claim_attempts_open ON parent_claim_attempts(created_at DESC) WHERE reviewed_at IS NULL;
`;

const lineUidHash = (lineUid) => crypto.createHash('sha256').update(String(lineUid || '')).digest('hex');

// outcome：FAILED（核對失敗）、PASSED_ID、PASSED_NEAR（姓名不完全相同但通過，待櫃台確認登記姓名）
async function recordClaimAttempt({ lineUid, phone, path, sourceRecordId = null, submittedName, submittedIdNumber, outcome, matchedName = null }, db = pool) {
  await db.query(
    `INSERT INTO parent_claim_attempts
       (line_uid_hash, phone_canonical, path, source_record_id, submitted_name, submitted_id_present, outcome, matched_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [lineUidHash(lineUid), String(phone || ''), path, sourceRecordId == null ? null : String(sourceRecordId),
     String(submittedName || '').trim(), Boolean(String(submittedIdNumber || '').trim()), outcome, matchedName]
  );
}

async function recentFailures(lineUid, db = pool) {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM parent_claim_attempts
      WHERE line_uid_hash = $1 AND outcome = 'FAILED' AND created_at > NOW() - make_interval(mins => $2)`,
    [lineUidHash(lineUid), COOLDOWN_MINUTES]
  );
  return r.rows[0].n;
}

async function isCoolingDown(lineUid, db = pool) {
  return (await recentFailures(lineUid, db)) >= FAILURE_LIMIT;
}

// 同一個 LINE 帳號的認領一筆一筆排隊：失敗紀錄要等交易回滾後才寫入，
// 不排隊的話並發送出的請求會在任何一筆失敗寫入前全數通過冷靜檢查。
// 排隊而不是直接拒絕：同一帳號重送要照舊拿到 replay（source_claim_concurrency_test）。
// 這是 session 鎖，要在連線歸還前放掉。
const slotKey = (lineUid) => `claim-attempt:${lineUidHash(lineUid)}`;

async function acquireClaimSlot(client, lineUid) {
  await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [slotKey(lineUid)]);
}

async function releaseClaimSlot(client, lineUid) {
  await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [slotKey(lineUid)]);
}

module.exports = {
  SCHEMA_SQL, recordClaimAttempt, recentFailures, isCoolingDown, acquireClaimSlot, releaseClaimSlot,
  FAILURE_LIMIT, COOLDOWN_MINUTES,
};

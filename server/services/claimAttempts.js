'use strict';
// 家長認領的嘗試紀錄（Owner 2026-10-20）：
// - 核對失敗只記在這裡，不再把整個家庭鎖成人工審核；同一個 LINE 帳號 30 分鐘內錯 5 次就要冷靜。
// - 靠身分證或姓名只差一字通過的也記下來，櫃台可在反查清單修正登記姓名。
// - 每次認領先登記一筆 PENDING 再數（PENDING＋FAILED 達上限就冷靜）：並發送出的請求彼此看得到，
//   同時最多只有 FAILURE_LIMIT 筆能進來。用認領本身的連線在交易外寫，不另借連線、不用綁連線的鎖
//   （cron/lock.js：正式庫可能走 transaction pooler）。
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

// outcome：PENDING（處理中）、FAILED（核對失敗）——這兩種計入冷靜；
//          PASSED_EXACT／PASSED_ID／PASSED_NEAR、NEW_SIMILAR（另建的學員和登記的只差一字，待櫃台確認）、
//          REGISTERED（全新家長）、APPENDED、REPLAYED、COOLDOWN、ERROR（系統錯誤）不計。
async function reserveClaimAttempt({ lineUid, phone, path, submittedName, submittedIdNumber }, db = pool) {
  const hash = lineUidHash(lineUid);
  const { id } = (await db.query(
    `INSERT INTO parent_claim_attempts (line_uid_hash, phone_canonical, path, submitted_name, submitted_id_present, outcome)
     VALUES ($1,$2,$3,$4,$5,'PENDING') RETURNING id`,
    [hash, String(phone || ''), path, String(submittedName || '').trim(), Boolean(String(submittedIdNumber || '').trim())]
  )).rows[0];
  const others = (await db.query(
    `SELECT count(*)::int AS n FROM parent_claim_attempts
      WHERE line_uid_hash = $1 AND id <> $2 AND outcome IN ('PENDING','FAILED')
        AND created_at > NOW() - make_interval(mins => $3)`,
    [hash, id, COOLDOWN_MINUTES]
  )).rows[0].n;
  return { id, coolingDown: others >= FAILURE_LIMIT };
}

async function finishClaimAttempt(id, { outcome, path = null, sourceRecordId = null, matchedName = null }, db = pool) {
  await db.query(
    `UPDATE parent_claim_attempts
        SET outcome = $2, path = COALESCE($3, path), source_record_id = COALESCE($4, source_record_id),
            matched_name = COALESCE($5, matched_name)
      WHERE id = $1`,
    [id, outcome, path, sourceRecordId == null ? null : String(sourceRecordId), matchedName]
  );
}

module.exports = { SCHEMA_SQL, reserveClaimAttempt, finishClaimAttempt, FAILURE_LIMIT, COOLDOWN_MINUTES };

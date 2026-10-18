'use strict';

// Webhooks describe a record's latest projection, not an instruction to mutate
// business data. Coalesce by source identity and refetch on every attempt.
async function enqueue(db, sheetCode, ids, eventType) {
  await db.query(
    `INSERT INTO ragic_webhook_inbox (sheet_code,ragic_record_id,event_type)
     SELECT $1, id, $3 FROM unnest($2::text[]) AS id
     ON CONFLICT (sheet_code,ragic_record_id) DO UPDATE SET
       event_type=EXCLUDED.event_type, revision=ragic_webhook_inbox.revision+1,
       state=CASE WHEN ragic_webhook_inbox.state='completed' THEN 'pending' ELSE ragic_webhook_inbox.state END,
       attempts=CASE WHEN ragic_webhook_inbox.state='completed' THEN 0 ELSE ragic_webhook_inbox.attempts END,
       next_retry_at=CASE WHEN ragic_webhook_inbox.state='completed' THEN NOW() ELSE ragic_webhook_inbox.next_retry_at END,
       updated_at=NOW()`, [sheetCode, ids, eventType || null]);
}

async function processInbox({ db, project, limit = 20, sheetCode = null, ids = null }) {
  const items = [];
  for (let n = 0; n < Math.min(100, Math.max(0, limit)); n++) {
    const client = await db.connect();
    let job;
    let savepointActive = false;
    let transactionEnded = false;
    try {
      await client.query('BEGIN');
      job = (await client.query(
        `SELECT * FROM ragic_webhook_inbox
         WHERE state IN ('pending','retryable') AND next_retry_at <= NOW()
           AND ($1::text IS NULL OR sheet_code=$1)
           AND ($2::text[] IS NULL OR ragic_record_id=ANY($2))
         ORDER BY next_retry_at, sheet_code, ragic_record_id
         FOR UPDATE SKIP LOCKED LIMIT 1`, [sheetCode, ids])).rows[0];
      if (!job) { await client.query('COMMIT'); transactionEnded = true; break; }
      await client.query('SAVEPOINT webhook_projection');
      savepointActive = true;
      // Keep the row lock through refetch and projection. On process death PG
      // rolls back both; the durable pending row is available after restart.
      const result = await project(client, job);
      await client.query(
        `UPDATE ragic_webhook_inbox SET state='completed', attempts=attempts+1,
           last_error_code=NULL, completed_at=NOW(), updated_at=NOW()
         WHERE sheet_code=$1 AND ragic_record_id=$2`, [job.sheet_code, job.ragic_record_id]);
      await client.query('COMMIT');
      transactionEnded = true;
      items.push({ id: job.ragic_record_id, state: 'completed', ...result });
    } catch (err) {
      // Keep the pre-savepoint queue row lock while rolling back a partial
      // projection. Redelivery cannot erase this failed attempt in between.
      if (!job || !savepointActive) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      try { await client.query('ROLLBACK TO SAVEPOINT webhook_projection'); }
      catch {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      const attempts = Number(job.attempts) + 1;
      const state = attempts >= Number(job.max_attempts) ? 'blocked' : 'retryable';
      // Error text can include source PII or credentials. Keep only a code.
      const code = /^[A-Z0-9_]{1,80}$/.test(String(err.code || '')) ? err.code : 'RAGIC_WEBHOOK_FAILED';
      // Retain revision/attempt checks as a second guard against stale work.
      const changed = await client.query(
        `UPDATE ragic_webhook_inbox SET state=$4, attempts=$5,
           last_error_code=$6, next_retry_at=NOW()+($7::int * INTERVAL '1 second'), updated_at=NOW()
         WHERE sheet_code=$1 AND ragic_record_id=$2 AND revision=$3 AND state <> 'completed' AND attempts=$8`,
        [job.sheet_code, job.ragic_record_id, job.revision, state, attempts, code,
          Math.min(3600, 30 * (2 ** Math.min(10, attempts - 1))), job.attempts]);
      items.push({ id: job.ragic_record_id, state: changed.rowCount ? state : 'superseded', error: code });
      await client.query('COMMIT');
      transactionEnded = true;
    } finally {
      if (!transactionEnded) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
  return { processed: items.length, failed: items.filter(i => i.state !== 'completed').length, items };
}

async function getStates(db, sheetCode, ids) {
  return (await db.query(
    `SELECT ragic_record_id AS id,state,attempts,last_error_code AS error,next_retry_at
       FROM ragic_webhook_inbox WHERE sheet_code=$1 AND ragic_record_id=ANY($2::text[])
       ORDER BY ragic_record_id`, [sheetCode, ids])).rows;
}

module.exports = { enqueue, processInbox, getStates };

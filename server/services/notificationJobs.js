/** Durable LINE notification jobs. Business transactions enqueue by local parent id;
 * delivery resolves parents.line_uid at send time and never guesses from phone/name/url. */
const { pool } = require('../models/db');
const line = require('./line');

async function enqueueParentNotification({ eventName, refId, parentId, venueId, messages }) {
  if (!eventName || !refId || !parentId || !venueId || !Array.isArray(messages)) {
    throw new Error('notification job requires event/ref/parent/venue/messages');
  }
  const r = await pool.query(
    `INSERT INTO notification_jobs (event_name, ref_id, parent_id, venue_id, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (event_name, ref_id, parent_id)
     DO UPDATE SET updated_at = notification_jobs.updated_at
     RETURNING id, correlation_id, status`,
    [eventName, String(refId), parentId, String(venueId), JSON.stringify({ messages })]
  );
  return r.rows[0];
}

async function processNotificationJobs({ limit = 20 } = {}) {
  const claimed = await pool.query(
    `WITH due AS (
       SELECT id FROM notification_jobs
        WHERE status IN ('PENDING','FAILED') AND attempts < 5 AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at, created_at
        FOR UPDATE SKIP LOCKED LIMIT $1
     )
     UPDATE notification_jobs j
        SET status = 'PROCESSING', attempts = attempts + 1, updated_at = NOW()
       FROM due WHERE j.id = due.id
     RETURNING j.*`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))]
  );
  let sent = 0;
  let failed = 0;
  for (const job of claimed.rows) {
    try {
      const parent = await pool.query(
        `SELECT line_uid FROM parents WHERE id = $1 AND is_active = TRUE`,
        [job.parent_id]
      );
      const uid = String(parent.rows[0]?.line_uid || '').trim();
      if (!uid || uid.startsWith('demo:')) {
        const error = new Error('canonical parent LINE UID missing');
        error.code = 'CANONICAL_LINE_UID_MISSING';
        throw error;
      }
      const response = await line.pushMessage(uid, job.payload?.messages || [], job.venue_id);
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'SENT', line_response_code = $2, sent_at = NOW(),
                last_error_code = NULL, updated_at = NOW()
          WHERE id = $1`,
        [job.id, Number(response?.status) || 200]
      );
      sent += 1;
    } catch (error) {
      const responseCode = Number(error?.response?.status) || null;
      const errorCode = String(error?.code || (responseCode ? `LINE_HTTP_${responseCode}` : 'LINE_DELIVERY_FAILED')).slice(0, 120);
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'FAILED', line_response_code = $2, last_error_code = $3,
                next_attempt_at = NOW() + make_interval(mins => LEAST(60, attempts * attempts)),
                updated_at = NOW()
          WHERE id = $1`,
        [job.id, responseCode, errorCode]
      );
      failed += 1;
      // correlation id is safe for tracing; do not log UID, payload, or channel token.
      console.warn('[notification-job] delivery failed', { correlation_id: job.correlation_id, code: errorCode });
    }
  }
  return { processed: claimed.rowCount, sent, failed };
}

function scheduleNotificationJobs() {
  setImmediate(() => processNotificationJobs({ limit: 10 }).catch((error) => {
    console.warn('[notification-job] worker failed', { code: error?.code || 'WORKER_FAILED' });
  }));
}

module.exports = { enqueueParentNotification, processNotificationJobs, scheduleNotificationJobs };

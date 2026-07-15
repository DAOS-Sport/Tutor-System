const { randomUUID } = require('crypto');
const { Client } = require('../../server/node_modules/pg');
const { enqueueParentNotification, processNotificationJobs } = require('../../server/services/notificationJobs');
const { assert, step } = require('./_lib');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const parentId = randomUUID();
  const refId = `e2e-notification-${randomUUID()}`;
  try {
    await pg.query(
      `INSERT INTO parents (id, phone, name, is_active) VALUES ($1,$2,$3,TRUE)`,
      [parentId, `09${Date.now().toString().slice(-8)}`, 'E2E notification parent']
    );
    step('LINE notification V2 stores a durable job keyed by canonical local parent');
    const first = await enqueueParentNotification({
      eventName: 'invoice_issued', refId, parentId, venueId: 'B',
      messages: [{ type: 'text', text: 'E2E' }],
    });
    const retry = await enqueueParentNotification({
      eventName: 'invoice_issued', refId, parentId, venueId: 'B',
      messages: [{ type: 'text', text: 'E2E' }],
    });
    assert(first.id === retry.id, 'same event/ref/parent is idempotent');
    const before = await pg.query(
      `SELECT COUNT(*)::int AS n FROM notification_jobs WHERE event_name = 'invoice_issued' AND ref_id = $1`,
      [refId]
    );
    assert(before.rows[0].n === 1, 'retry creates no second delivery job');

    step('missing canonical parent.line_uid records failure without rolling back/deleting the job');
    const processed = await processNotificationJobs({ limit: 10 });
    assert(processed.failed >= 1, 'worker records a failed attempt');
    const job = await pg.query(
      `SELECT status, attempts, line_response_code, correlation_id, last_error_code
         FROM notification_jobs WHERE id = $1`,
      [first.id]
    );
    assert(job.rows[0].status === 'FAILED' && job.rows[0].attempts === 1
      && job.rows[0].last_error_code === 'CANONICAL_LINE_UID_MISSING',
    'failure keeps status/attempts/error code for retry');
    assert(job.rows[0].correlation_id && job.rows[0].line_response_code === null,
      'delivery log has correlation id and does not invent a LINE response code');
  } finally {
    await pg.query(`DELETE FROM notification_jobs WHERE ref_id = $1`, [refId]).catch(() => {});
    await pg.query(`DELETE FROM parents WHERE id = $1`, [parentId]).catch(() => {});
    await pg.end().catch(() => {});
  }
  step('LINE notification binding cleanup complete');
})().catch((error) => { console.error(error); process.exit(1); });

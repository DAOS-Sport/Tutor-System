/* Real multipart upload -> object storage -> checkout/enrollment DB persistence. */
const express = require('../../server/node_modules/express');
const sharp = require('../../server/node_modules/sharp');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { pool } = require('../../server/models/db');
const { signParentToken } = require('../../server/middlewares/parentAuth');
const uploadRouter = require('../../server/routes/uploads');
const checkoutRouter = require('../../server/routes/checkout');
const { assert, step } = require('./_lib');

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', uploadRouter);
  app.use('/api/checkout', checkoutRouter);
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

(async () => {
  step('Mobile image multipart upload persists proof URL for F-M02');
  const suffix = Date.now().toString().slice(-8);
  const phone = `09${suffix}`;
  const enrollmentId = `IMG-E2E-${suffix}`;
  let parentId;
  let checkoutId;
  let route;
  let uploaded;

  try {
    parentId = (await pool.query(
      `INSERT INTO parents(phone, name, is_active) VALUES($1, 'IMG E2E', TRUE) RETURNING id`,
      [phone],
    )).rows[0].id;
    checkoutId = (await pool.query(
      `INSERT INTO checkout_sessions(parent_id, enrollment_batch_id, total_amount)
       VALUES($1, $2, 3135) RETURNING checkout_id`,
      [parentId, randomUUID()],
    )).rows[0].checkout_id;
    await pool.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, venue_id, course_type,
          original_price, final_price, status, submitted_at, checkout_id)
       VALUES($1, 'IMG E2E', $2, ARRAY['測試學員'], '測試教練', 'B', 1,
              3135, 3135, 'pending_payment', NOW(), $3)`,
      [enrollmentId, phone, checkoutId],
    );

    route = await startServer();
    const token = signParentToken({ parentId, phone });
    const webp = await sharp({
      create: { width: 40, height: 60, channels: 3, background: '#ddffee' },
    }).webp().toBuffer();
    const form = new FormData();
    // Declared JPEG but actual WebP: server must trust magic bytes, not browser MIME/name.
    form.append('file', new Blob([webp], { type: 'image/jpeg' }), 'phone.jpg');
    const uploadResponse = await fetch(`${route.base}/api/uploads/payment-proof`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    uploaded = await uploadResponse.json();
    assert(uploadResponse.status === 200, `upload returns 200, actual ${uploadResponse.status}`);
    assert(uploaded.actual_mime_type === 'image/webp', 'magic bytes identify actual WebP');
    assert(uploaded.preview_url && uploaded.preview_url.endsWith('.jpg'), 'browser-safe JPEG preview created');

    const writeResponse = await fetch(`${route.base}/api/checkout/${checkoutId}/payment-proof`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transfer_last_5: '12345', payment_proof_url: uploaded.url }),
    });
    const written = await writeResponse.json();
    assert(writeResponse.status === 200, `proof write returns 200, actual ${writeResponse.status}`);
    assert(written.has_payment_proof === true, 'checkout API reads proof immediately');

    const db = await pool.query(
      `SELECT cs.payment_proof_url AS checkout_url, ae.payment_proof_url AS enrollment_url
         FROM checkout_sessions cs
         JOIN admin_enrollments ae ON ae.checkout_id=cs.checkout_id
        WHERE cs.checkout_id=$1`,
      [checkoutId],
    );
    assert(db.rows[0].checkout_url === uploaded.url, 'checkout_sessions stores preview URL');
    assert(db.rows[0].enrollment_url === uploaded.url, 'child enrollment stores same preview URL');
    console.log('  ✓ upload, preview, checkout DB and enrollment DB form one complete path');
  } finally {
    if (enrollmentId) await pool.query(`DELETE FROM admin_enrollments WHERE id=$1`, [enrollmentId]).catch(() => {});
    if (checkoutId) await pool.query(`DELETE FROM checkout_sessions WHERE checkout_id=$1`, [checkoutId]).catch(() => {});
    if (parentId) await pool.query(`DELETE FROM parents WHERE id=$1`, [parentId]).catch(() => {});
    for (const url of [uploaded?.url, uploaded?.original_url, uploaded?.thumbnail_url]) {
      if (!url?.startsWith('/uploads/')) continue;
      const relative = url.slice('/uploads/'.length);
      await fs.promises.unlink(path.resolve(__dirname, '../../server/uploads', relative)).catch(() => {});
    }
    if (route) await route.close();
    await pool.end();
  }
  step('done');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { shapeCheckout } = require('../server/services/checkouts');
const { parseProofInput } = require('../server/services/paymentProof');

const PARENT_PROOF = '/uploads/2026-07/0123456789abcdef01234567.jpg';
const LEGACY_CHILD_PROOF = '/uploads/2026-07/aaaaaaaaaaaaaaaaaaaaaaaa.webp';

function baseRow(overrides = {}) {
  return {
    checkout_id: 'checkout-test',
    total_amount: 3135,
    payment_status: 'pending_reconcile',
    transfer_last_5: '12345',
    sub_orders: [],
    ...overrides,
  };
}

function testCheckoutAndLegacyFallback() {
  const direct = shapeCheckout(baseRow({ payment_proof_url: PARENT_PROOF }));
  assert.strictEqual(direct.payment_proof_url, PARENT_PROOF);
  assert.deepStrictEqual(direct.payment_proof_urls, [PARENT_PROOF]);
  assert.strictEqual(direct.has_payment_proof, true);

  const legacy = shapeCheckout(baseRow({
    payment_proof_url: null,
    sub_orders: [
      { id: 'E1', payment_proof_url: LEGACY_CHILD_PROOF },
      { id: 'E2', payment_proof_url: LEGACY_CHILD_PROOF },
      { id: 'E3', payment_proof_url: PARENT_PROOF },
    ],
  }));
  assert.strictEqual(legacy.payment_proof_url, LEGACY_CHILD_PROOF, 'legacy child proof becomes the compatible primary URL');
  assert.deepStrictEqual(legacy.payment_proof_urls, [LEGACY_CHILD_PROOF, PARENT_PROOF], 'all distinct stored proofs remain visible');
  assert.strictEqual(legacy.has_payment_proof, true);

  const ledgerOnly = shapeCheckout(baseRow({
    payment_proof_url: null,
    uploaded_payment_proof_urls: [PARENT_PROOF],
    sub_orders: [{ id: 'E-ledger' }],
  }));
  assert.deepStrictEqual(ledgerOnly.payment_proof_urls, [PARENT_PROOF], 'first-stage upload ledger keeps the proof visible');
  assert.strictEqual(ledgerOnly.has_payment_proof, true);

  const groupMemberOnly = shapeCheckout(baseRow({
    payment_proof_url: null,
    group_member_payment_proof_urls: [LEGACY_CHILD_PROOF, PARENT_PROOF],
    sub_orders: [{ id: 'E-group', group_order_id: 'group-1' }],
  }));
  assert.deepStrictEqual(
    groupMemberOnly.payment_proof_urls,
    [LEGACY_CHILD_PROOF, PARENT_PROOF],
    'group_order_members payment proofs must remain visible in F-M02',
  );

  const absent = shapeCheckout(baseRow({ payment_proof_url: null, sub_orders: [{ id: 'E4' }] }));
  assert.strictEqual(absent.payment_proof_url, null);
  assert.deepStrictEqual(absent.payment_proof_urls, []);
}

async function testPendingConversionExtensionsPersist() {
  for (const ext of ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'heic', 'heif', 'avif']) {
    const url = `/uploads/2026-07/0123456789abcdef01234567.${ext}`;
    const parsed = await parseProofInput({ payment_proof_url: url }, { exists: async () => true });
    assert.strictEqual(parsed.value, url, `${ext} URL must persist after an authenticated image upload`);
  }
}

function testFamiliarUiContract() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../client/admin/src/pages/ReconcilePage.jsx'),
    'utf8',
  );
  assert.ok(source.includes("key: 'proof'"));
  assert.ok(source.includes('checkoutProofUrls(r)'));
  assert.ok(source.includes('thumbnailClassName="h-14 w-14"'), 'F-M02 list must show the actual thumbnail, not only a badge');
  assert.ok(source.includes('setConfirming(r)'), 'existing reconcile action must remain unchanged');
}

function testUploadOwnershipContract() {
  const apiSource = fs.readFileSync(
    path.resolve(__dirname, '../client/liff/src/api/enrollments.js'),
    'utf8',
  );
  assert.ok(apiSource.includes("form.append('target_type', targetType)"));
  assert.ok(apiSource.includes("form.append('target_id', targetId)"));
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, '../server/routes/uploads.js'),
    'utf8',
  );
  assert.ok(routeSource.includes('INSERT INTO payment_proof_uploads'));
  assert.ok(routeSource.includes('PAYMENT_PROOF_TARGET_FORBIDDEN'));
  const checkoutSource = fs.readFileSync(
    path.resolve(__dirname, '../server/services/checkouts.js'),
    'utf8',
  );
  assert.ok(checkoutSource.includes('FROM group_order_members gom'));
  assert.ok(checkoutSource.includes('gom.parent_id = cs.parent_id'));
}

(async () => {
  testCheckoutAndLegacyFallback();
  await testPendingConversionExtensionsPersist();
  testFamiliarUiContract();
  testUploadOwnershipContract();
  console.log('reconcile_payment_proof_visibility_test: PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

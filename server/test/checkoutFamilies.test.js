const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutFamilyKey, groupCheckoutFamilies } = require('../services/checkoutFamilies');

test('orders with the same normalized parent phone stay in one invoice family', () => {
  const groups = groupCheckoutFamilies([
    { id: 'A1', parent_name: '王家長', parent_phone: '0912-345-678', final_price: 3500, tax_id: '12345678' },
    { id: 'A2', parent_name: '王家長', parent_phone: '0912345678', final_price: 3600 },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].family_key, 'phone:0912345678');
  assert.equal(groups[0].amount, 7100);
  assert.equal(groups[0].tax_id, '12345678');
  assert.deepEqual(groups[0].order_ids, ['A1', 'A2']);
});

test('different parent accounts require separate family invoices', () => {
  const groups = groupCheckoutFamilies([
    { id: 'A1', parent_name: '王家長', parent_phone: '0912345678', final_price: 4500 },
    { id: 'B1', parent_name: '李家長', parent_phone: '0987654321', final_price: 4500 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.amount), [4500, 4500]);
});

test('missing parent phone never merges orders by student or parent name', () => {
  assert.notEqual(
    checkoutFamilyKey({ id: 'A1', parent_name: '同名家長' }),
    checkoutFamilyKey({ id: 'A2', parent_name: '同名家長' })
  );
});

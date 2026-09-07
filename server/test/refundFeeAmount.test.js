'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateRefundAmounts: calc } = require('../services/refundReasons');
test('refund fee boundaries and family allocation', () => {
  const rows = [{id:'a',final_price:1001},{id:'b',final_price:2003}];
  const fixed = calc(rows, .5, .1, undefined, 101);
  assert.equal(fixed.before_fee, 1503); assert.equal(fixed.refund_amount, 1402);
  assert.equal(fixed.fee_amount,101); assert.equal(fixed.sibling_refunds.reduce((s,r)=>s+r.refund_amount,0),1402);
  assert.equal(calc(rows,.5,.1,.1234).refund_amount, Math.round(1001*.5*.8766)+Math.round(2003*.5*.8766));
  assert.equal(calc(rows,0,.1,undefined,0).refund_amount,0);
  assert.equal(calc(rows,.5,.1,undefined,1503).refund_amount,0);
  for(const amount of [-1,.5,'',true,{},Infinity,1504]) assert.throws(()=>calc(rows,.5,.1,undefined,amount),e=>e.status===400);
  for(const rate of [-1,1.01,'',true,{},Infinity]) assert.throws(()=>calc(rows,.5,.1,rate),e=>e.status===400);
  assert.throws(()=>calc(rows,.5,.1,.1,0),e=>e.status===400);
  for(let fee=0;fee<=1503;fee++) {
    const v=calc(rows,.5,.1,undefined,fee);
    assert.equal(v.refund_amount,1503-fee);
    assert.ok(v.sibling_refunds.every(r=>r.refund_amount>=0));
  }
});

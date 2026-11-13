// 優惠表單（使用者 2026-11-03／04）：新建優惠預設可套用團購；視窗底部不放小編輯與修改紀錄。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const modal = read('client/admin/src/pages/promotions/PromotionFormModal.jsx');
assert.ok(modal.includes('applicable_to_group_orders: initial?.id ? initial.applicable_to_group_orders === true : true,'), '新建預設開啟，編輯照原值');
assert.ok(modal.includes('新建時預設開啟'), '說明文字');
assert.ok(!/QuickEdit|修改紀錄/.test(modal), '視窗底部保持乾淨');
assert.ok(!read('server/routes/admin/promotions.js').includes('group-orders'), '團購開關路由已拿掉');
assert.ok(!read('client/admin/src/api/promotions.js').includes('setGroupOrders'));
console.log('PASS: new promotions default to group orders on; promotion modal has no quick-edit or log section');

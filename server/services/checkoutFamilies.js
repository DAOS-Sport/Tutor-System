/**
 * checkout 發票家庭分組。
 *
 * 新版團報正常情況是一個家庭一張 checkout；這個 helper 只為歷史匯入／舊資料中
 * 「同一 checkout 混入多個家庭」提供安全相容。家庭判定只用家長手機，不用學員
 * 姓名猜測；缺手機時採每筆訂單獨立分組，寧可要求多開、不可誤合併兩戶發票。
 */
function normalizeFamilyPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function checkoutFamilyKey(order) {
  const phone = normalizeFamilyPhone(order?.parent_phone);
  if (phone) return `phone:${phone}`;
  return `order:${String(order?.id || '')}`;
}

function groupCheckoutFamilies(orders = []) {
  const groups = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    const familyKey = checkoutFamilyKey(order);
    if (!groups.has(familyKey)) {
      groups.set(familyKey, {
        family_key: familyKey,
        parent_name: order?.parent_name || null,
        parent_phone: order?.parent_phone || null,
        tax_id: order?.tax_id || null,
        amount: 0,
        carrier: order?.carrier || '',
        order_ids: [],
        payment_proof_urls: [],
      });
    }
    const group = groups.get(familyKey);
    group.amount += Number(order?.final_price) || 0;
    group.order_ids.push(order?.id);
    if (!group.parent_name && order?.parent_name) group.parent_name = order.parent_name;
    if (!group.parent_phone && order?.parent_phone) group.parent_phone = order.parent_phone;
    if (!group.tax_id && order?.tax_id) group.tax_id = order.tax_id;
    if (!group.carrier && order?.carrier) group.carrier = order.carrier;
    const proof = String(order?.payment_proof_url || '').trim();
    if (proof && !group.payment_proof_urls.includes(proof)) group.payment_proof_urls.push(proof);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    amount: Number(group.amount),
    order_ids: group.order_ids.filter(Boolean),
    order_count: group.order_ids.filter(Boolean).length,
  }));
}

module.exports = { checkoutFamilyKey, groupCheckoutFamilies, normalizeFamilyPhone };

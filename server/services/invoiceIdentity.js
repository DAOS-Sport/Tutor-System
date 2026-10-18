'use strict';

// 財政部新版營利事業統一編號檢核：8 碼、乘數 12121241，各乘積反覆相加為
// 個位數，總和可被 5 整除。第 7 碼為 7 時，該位乘積之和可取 0 或 1。
// Primary source: https://www.ntbna.gov.tw/singlehtml/bbabfd4af20541b7859b4c5a099081f6?cntId=0625114d47274366baab1d3317f866ab
const TAX_ID_RE = /^\d{8}$/;
const TAX_ID_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];
const MAX_CARRIER_LENGTH = 64;

function digitRoot(value) {
  let current = Number(value);
  while (current >= 10) {
    current = Math.floor(current / 10) + (current % 10);
  }
  return current;
}

function isValidTaiwanTaxId(value) {
  const taxId = String(value || '').trim();
  if (!TAX_ID_RE.test(taxId)) return false;
  const digits = [...taxId].map(Number);
  const terms = digits.map((digit, index) => digitRoot(digit * TAX_ID_WEIGHTS[index]));
  const sum = terms.reduce((total, term) => total + term, 0);
  if (sum % 5 === 0) return true;
  return digits[6] === 7 && (sum - terms[6]) % 5 === 0;
}

function validateCarrier(value) {
  if (value !== null && value !== undefined && typeof value !== 'string') {
    return { error: '電子發票載具必須是文字或空值', code: 'INVOICE_IDENTITY_TYPE_INVALID' };
  }
  const carrier = String(value || '').trim();
  if (carrier.length > MAX_CARRIER_LENGTH) {
    return { error: `電子發票載具不得超過 ${MAX_CARRIER_LENGTH} 字元`, code: 'CARRIER_TOO_LONG' };
  }
  return { value: carrier };
}

function parseInvoiceIdentityInput(body = {}) {
  const carrierSupplied = Object.prototype.hasOwnProperty.call(body, 'carrier');
  const taxIdSupplied = Object.prototype.hasOwnProperty.call(body, 'tax_id');
  if (taxIdSupplied && body.tax_id !== null && typeof body.tax_id !== 'string') {
    return { error: '統一編號與電子發票載具必須是文字或空值', code: 'INVOICE_IDENTITY_TYPE_INVALID' };
  }
  const carrierResult = validateCarrier(carrierSupplied ? body.carrier : '');
  if (carrierResult.error) return carrierResult;
  const carrier = carrierResult.value;
  const taxId = taxIdSupplied && typeof body.tax_id === 'string'
    ? body.tax_id.trim() : '';

  if (carrier && taxId) {
    return { error: '統一編號與電子發票載具只能擇一填寫', code: 'INVOICE_IDENTITY_CONFLICT' };
  }
  if (taxId && !isValidTaiwanTaxId(taxId)) {
    return { error: '統一編號格式或檢查碼錯誤', code: 'TAX_ID_INVALID' };
  }
  return {
    value: {
      carrier,
      taxId: taxId || null,
      carrierSupplied,
      taxIdSupplied,
      supplied: carrierSupplied || taxIdSupplied,
    },
  };
}

function resolveInvoiceIdentity(input, existing = {}) {
  const carrierSource = input.taxIdSupplied && input.taxId
    ? ''
    : input.carrierSupplied ? input.carrier : existing.carrier;
  const carrierResult = validateCarrier(carrierSource);
  if (carrierResult.error) return carrierResult;
  let carrier = input.carrierSupplied
    ? (carrierResult.value || null)
    : (carrierResult.value || null);
  let taxId = input.taxIdSupplied
    ? (input.taxId || null)
    : (String(existing.taxId || '').trim() || null);

  if (input.carrierSupplied && input.carrier) taxId = null;
  if (input.taxIdSupplied && input.taxId) carrier = null;
  if (carrier && taxId) {
    return { error: '統一編號與電子發票載具只能擇一填寫', code: 'INVOICE_IDENTITY_CONFLICT' };
  }
  if (taxId && !isValidTaiwanTaxId(taxId)) {
    return { error: '統一編號格式或檢查碼錯誤', code: 'TAX_ID_INVALID' };
  }
  return { value: { carrier, taxId } };
}

module.exports = {
  isValidTaiwanTaxId,
  validateCarrier,
  MAX_CARRIER_LENGTH,
  parseInvoiceIdentityInput,
  resolveInvoiceIdentity,
};

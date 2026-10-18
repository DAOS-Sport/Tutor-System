const TAX_ID_RE = /^\d{8}$/;
const TAX_ID_WEIGHTS = [1, 2, 1, 2, 1, 2, 4, 1];
export const MAX_CARRIER_LENGTH = 64;

export function isValidInvoiceCarrier(value) {
  return typeof value === 'string' && value.trim().length <= MAX_CARRIER_LENGTH;
}

function digitRoot(value) {
  let current = Number(value);
  while (current >= 10) current = Math.floor(current / 10) + (current % 10);
  return current;
}

export function normalizeTaxIdInput(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

export function isValidTaiwanTaxId(value) {
  const taxId = String(value || '').trim();
  if (!TAX_ID_RE.test(taxId)) return false;
  const digits = [...taxId].map(Number);
  const terms = digits.map((digit, index) => digitRoot(digit * TAX_ID_WEIGHTS[index]));
  const sum = terms.reduce((total, term) => total + term, 0);
  return sum % 5 === 0 || (digits[6] === 7 && (sum - terms[6]) % 5 === 0);
}

export function invoiceTypeFor({ carrier = '', taxId = '' } = {}) {
  if (String(taxId).trim()) return 'tax_id';
  if (String(carrier).trim()) return 'carrier';
  return 'none';
}

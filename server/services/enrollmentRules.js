/**
 * 一般整組報名與試上的最小共用規則。
 *
 * 一對二到一對六的一般報名是同一家庭一次買下整組，因此必須一次送齊
 * 2～6 位學員（一對五、一對六 2026-10-15 補上，原本只有前端擋；D18／GitHub #13）。
 * 跨家庭分次加入走 groupOrders，不會呼叫這份驗證。
 * 試上比照正式課（使用者 2026-10-14）：一樣要選滿人數；訂單仍每人每堂一筆，
 * 對帳時同批同堂開成同一個共用課期（admin/enrollments.js ensureSoloCoursePeriod）。
 */
const STANDARD_WHOLE_GROUP_SIZES = new Set([2, 3, 4, 5, 6]);
const WHOLE_GROUP_ORDER_KINDS = new Set(['standard', 'trial']);

function requiredStandardStudentCount({ courseType, orderKind = 'standard' } = {}) {
  if (!WHOLE_GROUP_ORDER_KINDS.has(String(orderKind).trim().toLowerCase())) return null;
  const size = Number(courseType);
  return STANDARD_WHOLE_GROUP_SIZES.has(size) ? size : null;
}

function validateStandardStudentCount({ courseType, orderKind = 'standard', studentCount } = {}) {
  const expected = requiredStandardStudentCount({ courseType, orderKind });
  const actual = Number(studentCount);
  return {
    ok: expected == null || actual === expected,
    expected,
    actual,
  };
}

function validateStandardCourseCapacity({ courseType, orderKind = 'standard', maxStudents } = {}) {
  const expected = requiredStandardStudentCount({ courseType, orderKind });
  const configured = Number(maxStudents);
  return {
    ok: expected == null || (Number.isInteger(configured) && configured === expected),
    expected,
    configured,
  };
}

function calculateEnrollmentSubtotal({ unitPrice, studentCount, periodCount = 1 } = {}) {
  if (unitPrice === null || unitPrice === undefined || unitPrice === '') return null;
  const price = Number(unitPrice);
  const students = Number(studentCount);
  const periods = Number(periodCount);
  if (!Number.isFinite(price) || price < 0 || price > Number.MAX_SAFE_INTEGER
      || !Number.isInteger(students) || students < 1
      || !Number.isInteger(periods) || periods < 1) {
    return null;
  }
  const subtotal = price * students * periods;
  return Number.isFinite(subtotal) && subtotal <= Number.MAX_SAFE_INTEGER
    ? subtotal
    : null;
}

/**
 * 將整筆整數折抵安全分配到各子訂單。
 *
 * 不能用 Math.round(total / count) 再把餘數全塞最後一筆：例如折 2 元、
 * 4 筆訂單會得到 1/1/1/-1，最後一筆反而高於原價。這裡採商數＋餘數，
 * 每筆折抵皆為非負整數，總和精確等於整筆折抵。
 */
function allocateEnrollmentDiscount({ totalDiscount, orderCount, perOrderOriginal } = {}) {
  const discount = Number(totalDiscount);
  const count = Number(orderCount);
  const original = Number(perOrderOriginal);
  if (!Number.isSafeInteger(discount) || discount < 0
      || !Number.isSafeInteger(count) || count < 1
      || !Number.isSafeInteger(original) || original < 0) {
    return null;
  }
  const originalTotal = original * count;
  if (!Number.isSafeInteger(originalTotal) || discount > originalTotal) return null;

  const base = Math.floor(discount / count);
  const remainder = discount % count;
  return Array.from({ length: count }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

module.exports = {
  requiredStandardStudentCount,
  validateStandardStudentCount,
  validateStandardCourseCapacity,
  calculateEnrollmentSubtotal,
  allocateEnrollmentDiscount,
};

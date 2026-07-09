function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function appPath(path) {
  const text = firstText(path);
  if (!text) return '';
  return text.replace(/^\/liff(?=\/|$)/, '') || '/';
}

function collectObjects(value, out = [], seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return out;
  seen.add(value);
  out.push(value);
  const preferred = [
    value.data,
    value.route_instruction,
    value.routeInstruction,
    value.route,
    value.checkout,
    value.result,
    value.payload,
  ];
  for (const child of preferred) collectObjects(child, out, seen, depth + 1);
  return out;
}

export function resolveRouteInstruction(result) {
  const objects = collectObjects(result);
  const checkoutId = firstText(...objects.flatMap((o) => [
    o.checkout_id,
    o.checkoutId,
    o.checkout?.checkout_id,
    o.checkout?.checkoutId,
    o.checkout?.id,
  ]));
  const target = firstText(...objects.flatMap((o) => [
    o.target_page,
    o.targetPage,
    o.target,
    o.path,
  ]));
  const normalizedTarget = appPath(target);
  const targetKey = normalizedTarget.replace(/^\/+/, '').toLowerCase();

  // Checkout id is authoritative for enrollment/payment responses. This keeps the
  // LIFF client from falling back to legacy /enroll-status or /my-courses when the
  // backend has already created a mother checkout.
  if (checkoutId) return `/checkout/${checkoutId}`;

  if (
    targetKey === 'checkout/payment-view' ||
    targetKey === 'checkout' ||
    targetKey === 'checkout_page' ||
    targetKey === 'enroll_status' ||
    normalizedTarget.startsWith('/enroll-status/') ||
    (!targetKey && checkoutId)
  ) {
    return checkoutId ? `/checkout/${checkoutId}` : '';
  }
  if (normalizedTarget.startsWith('/checkout/')) return normalizedTarget;
  if (targetKey === 'my_courses' || normalizedTarget === '/my-courses') return '/my-courses';

  if (targetKey === 'enroll_status' || normalizedTarget.startsWith('/enroll-status/')) {
    if (normalizedTarget.startsWith('/enroll-status/')) return normalizedTarget;
    const enrollmentId = firstText(...objects.flatMap((o) => [o.enrollment_id, o.enrollmentId, o.first_id, o.id]));
    return enrollmentId ? `/enroll-status/${enrollmentId}` : '';
  }

  return '';
}

export function applyRouteInstruction(result, navigate, options = {}) {
  const path = resolveRouteInstruction(result);
  if (!path) return false;
  navigate(path, { replace: options.replace !== false });
  return true;
}

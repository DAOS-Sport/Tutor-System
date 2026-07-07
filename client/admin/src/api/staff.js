import { callApi } from './client';
import { mockDb } from './mock';

function qs(params) {
  const q = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== '' && v != null) q.set(k, v);
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const staffApi = {
  list: (params = {}) =>
    callApi(`/staff${qs(params)}`, {}, () => mockDb.staff(params)),
  // Task #91：員工詳細（包含 coach_profile + bio_media）供編輯彈窗 prefetch
  get: (id) =>
    callApi(`/staff/${id}`, {}, () => {
      const list = mockDb.staff();
      const row = list.find((x) => x.id === id);
      return row ? { ...row, bio_media: [] } : null;
    }),
  // Task #91：教練 lookup（取代已 410 的 /admin/coaches?venueId=）
  coachesByVenue: (venueId, status = 'active') =>
    callApi(`/staff/coaches${qs({ venueId, status })}`, {}, () => {
      const list = mockDb.staff().filter((s) => s.role === 'coach');
      return list.map((s) => ({
        id: s.coach_id || s.id, ragic_employee_id: s.id, name: s.name, phone: s.phone,
        is_senior: !!s.is_senior, pricing_multiplier: Number(s.multiplier || 1),
        multiplier: Number(s.multiplier || 1), is_active: !!s.active,
        venue_ids: s.venue_ids || (s.venue_id ? [s.venue_id] : []),
      }));
    }),
  create: (body) =>
    callApi(`/staff`, { method: 'post', data: body }, () => mockDb.createStaff?.(body) || {
      ...body,
      login_username: body.id,
      default_password_hint: body.phone,
    }),
  update: (id, patch) =>
    callApi(`/staff/${id}`, { method: 'patch', data: patch }, () => mockDb.updateStaff(id, patch)),
  hardDelete: (staffIds) =>
    callApi(`/staff/bulk`, { method: 'delete', data: { staff_ids: staffIds } }, () => ({
      ok: true,
      deleted_staff_ids: (staffIds || []).map((id) => String(id)),
      deleted_coach_ids: [],
      counts: { admin_staff: (staffIds || []).length },
    })),
  syncRagic: () =>
    callApi('/staff/sync', { method: 'post', data: {} }, () => ({
      synced: 0,
      h01_applied: 0,
      coefficient_updated: 0,
      unmatched_staff_warning: 0,
      skipped: true,
    })),
  resetPassword: (id) =>
    callApi(`/staff/${id}/reset-password`, { method: 'post', data: {} },
      () => {
        const row = mockDb.staff().find((x) => x.id === id);
        return {
          ok: true,
          staff_id: id,
          staff_name: row?.name || id,
          login_username: row?.id || id,
          notified: false,
          notify_error: 'mock',
          default_password_hint: row?.phone || '',
        };
      }),
  // 檢視密碼：後端確認目前密碼是否仍為預設（手機號碼）→ 是則回傳明碼，否則回 is_default=false
  passwordHint: (id) =>
    callApi(`/staff/${id}/password-hint`, {},
      () => {
        const row = mockDb.staff().find((x) => x.id === id);
        return row?.phone
          ? { has_account: true, is_default: true, password: row.phone }
          : { has_account: true, is_default: false, password: null, missing_default_phone: true };
      }),
};

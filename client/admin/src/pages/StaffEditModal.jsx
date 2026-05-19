import React from 'react';

const ROLE_OPTIONS = [
  { value: 'admin',   label: '系統管理員' },
  { value: 'manager', label: '主管' },
  { value: 'staff',   label: '行政櫃檯' },
  { value: 'coach',   label: '教練' },
];

/**
 * StaffPage 編輯彈窗 — 同時支援「編輯」與「新建」兩種模式
 *   editing.isNew = true → 啟用 id / name / phone 輸入欄，並提示預設密碼
 */
export default function StaffEditModal({ editing, setEditing, venues, busy, onSave, multiplierMin, multiplierMax }) {
  if (!editing) return null;
  const isNew = !!editing.isNew;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && setEditing(null)}
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? '新建員工' : '編輯員工'}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <h3 className="mb-4 text-lg font-bold text-brand-primary">
          {isNew ? '新建員工' : `編輯員工 — ${editing.name}`}
        </h3>
        <div className="space-y-4">
          {isNew && (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">員工編號 *</label>
                <input
                  value={editing.id || ''}
                  onChange={(e) => setEditing({ ...editing, id: e.target.value.toUpperCase() })}
                  placeholder="如 C005 / M002 / S003"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono"
                />
                <p className="mt-1 text-xs text-gray-500">
                  建議命名：教練 C***、主管 M***、行政 S***、系統管理員 U***；2–10 碼英數，首字母為英文。
                  <span className="ml-1 font-medium text-amber-700">建立後預設密碼 = 員工編號（首次登入後請改密碼）。</span>
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">姓名 *</label>
                  <input
                    value={editing.name || ''}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">手機</label>
                  <input
                    value={editing.phone || ''}
                    onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                    placeholder="0912345678"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  />
                </div>
              </div>
            </>
          )}
          {!isNew && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">姓名</label>
                <input
                  value={editing.name || ''}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">手機</label>
                <input
                  value={editing.phone || ''}
                  onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                />
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">角色</label>
            <select
              value={editing.role || 'staff'}
              onChange={(e) => setEditing({ ...editing, role: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2"
            >
              {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">變更角色會同步調整其登入後可見的選單與權限。</p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">所屬場館</label>
            <select
              value={editing.venue_id || ''}
              onChange={(e) => setEditing({ ...editing, venue_id: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2"
            >
              <option value="">— 不指定 —</option>
              {/* Task #84：過濾停用場館；但若該員工目前所屬館已被停用，仍保留以免下拉「莫名消失」 */}
              {venues
                .filter((v) => v.is_active !== false || v.id === editing.venue_id)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}{v.is_active === false ? '（已停用）' : ''}
                  </option>
                ))}
            </select>
          </div>
          {editing.role === 'coach' && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!editing.is_senior}
                  onChange={(e) => setEditing({ ...editing, is_senior: e.target.checked })}
                />
                <span>資深教練（可建立學習歷程、會顯示金色徽章）</span>
              </label>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  修課係數（100% – 150%）
                </label>
                <input
                  type="number"
                  step="0.01"
                  min={multiplierMin}
                  max={multiplierMax}
                  value={editing.multiplier}
                  onChange={(e) => setEditing({ ...editing, multiplier: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                />
                <p className="mt-1 text-xs text-gray-500">資深教練 1.30 ~ 1.50；一般 1.00 ~ 1.20。</p>
              </div>
            </>
          )}
          {!isNew && editing.role !== 'coach' && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
                <input
                  type="checkbox"
                  checked={!!editing.coach_active}
                  onChange={(e) => setEditing({ ...editing, coach_active: e.target.checked })}
                />
                <span>啟用教練 LIFF 身分</span>
              </label>
              <p className="mt-1 text-xs text-gray-500">
                勾選後啟用「教練」身分；取消勾選只暫停 LIFF 教練權限，角色欄仍保留灰色「教練」。
              </p>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!editing.active}
              onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
            />
            <span>啟用此帳號（取消勾選會立即停用其後台 login 與 LIFF 身分）</span>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={() => setEditing(null)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
            disabled={busy}
          >
            取消
          </button>
          <button
            onClick={onSave}
            disabled={busy}
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
          >
            {busy ? '儲存中…' : (isNew ? '建立' : '儲存')}
          </button>
        </div>
      </div>
    </div>
  );
}

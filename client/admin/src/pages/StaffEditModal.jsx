import React from 'react';

/** Task #90：場館多選 chip — 已停用場館仍顯示但加註，避免下拉「莫名消失」。 */
function VenueChipsField({ value, venues, onChange }) {
  const selected = new Set(value || []);
  const visible = venues.filter((v) => v.is_active !== false || selected.has(v.id));
  function toggle(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(Array.from(next));
  }
  if (!visible.length) {
    return <p className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-400">尚未設定任何場館</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {visible.map((v) => {
        const on = selected.has(v.id);
        const inactive = v.is_active === false;
        return (
          <button
            type="button"
            key={v.id}
            onClick={() => toggle(v.id)}
            className={
              'rounded-full border px-3 py-1 text-xs font-medium transition ' +
              (on
                ? 'border-brand-teal bg-brand-teal text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:border-brand-teal')
            }
            title={inactive ? '此場館已停用' : v.name}
          >
            {on ? '✓ ' : ''}{v.name}{inactive ? '（停用）' : ''}
          </button>
        );
      })}
    </div>
  );
}

const ROLE_OPTIONS = [
  { value: 'admin',   label: '系統管理員' },
  { value: 'manager', label: '主管' },
  { value: 'staff',   label: '行政櫃檯' },
  { value: 'coach',   label: '教練' },
];

const INTRO_STATUS_LABEL = {
  draft: { tone: 'bg-gray-100 text-gray-700', text: '草稿' },
  pending_review: { tone: 'bg-amber-100 text-amber-800', text: '送審中' },
  published: { tone: 'bg-emerald-100 text-emerald-800', text: '已上架' },
  rejected: { tone: 'bg-rose-100 text-rose-800', text: '已退回' },
};

/** Task #91：教練設定區塊 — 簡介 / 專長 / 待審狀態 / 介紹圖（read-only 摘要） */
function CoachProfileSection({ editing, setEditing, multiplierMin, multiplierMax }) {
  const profile = editing.coach_profile || {};
  const specialties = Array.isArray(profile.specialties) ? profile.specialties : [];
  const introStatus = profile.intro_review_status || 'draft';
  const introMeta = INTRO_STATUS_LABEL[introStatus] || INTRO_STATUS_LABEL.draft;
  const bioMedia = Array.isArray(editing.bio_media) ? editing.bio_media : [];

  function patchProfile(p) {
    setEditing({ ...editing, coach_profile: { ...profile, ...p } });
  }

  return (
    <div className="space-y-3 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-brand-primary">教練設定（F-C-Admin 已合併）</h4>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${introMeta.tone}`}
              title="介紹送審狀態（F-C06 由 admin/manager 在「教練介紹送審」頁審核）">
          介紹：{introMeta.text}
        </span>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={!!editing.is_senior}
               onChange={(e) => setEditing({ ...editing, is_senior: e.target.checked })} />
        <span>資深教練（可建立學習歷程、會顯示金色徽章）</span>
      </label>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">修課係數（100% – 150%）</label>
        <input type="number" step="0.01" min={multiplierMin} max={multiplierMax}
               value={editing.multiplier}
               onChange={(e) => setEditing({ ...editing, multiplier: e.target.value })}
               className="w-full rounded-lg border border-gray-300 px-3 py-2" />
        <p className="mt-1 text-xs text-gray-500">資深教練 1.30 ~ 1.50；一般 1.00 ~ 1.20。改完會立即影響新報名計價。</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">教練 Email（用於官方通知）</label>
        <input type="email" value={profile.email || ''}
               onChange={(e) => patchProfile({ email: e.target.value })}
               className="w-full rounded-lg border border-gray-300 px-3 py-2"
               placeholder="可留空" />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">簡介（顯示於 LIFF 教練卡）</label>
        <textarea rows={4} value={profile.bio_rich_text || ''}
                  onChange={(e) => patchProfile({ bio_rich_text: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2"
                  placeholder="例：8 年青少年羽球教學經驗，擅長基本動作建立與比賽培訓。" />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">專長 tags（以逗號或 Enter 分隔）</label>
        <SpecialtyChipsField value={specialties} onChange={(arr) => patchProfile({ specialties: arr })} />
        <p className="mt-1 text-xs text-gray-500">範例：羽球、體適能、青少年。</p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700">介紹圖 / 影片</span>
          <span className="text-[11px] text-gray-500">共 {bioMedia.length} 筆</span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">介紹圖的上傳與排序在「教練 LIFF / 個人頁」操作；此處僅顯示當前數量。</p>
        {bioMedia.length > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-2">
            {bioMedia.slice(0, 4).map((m) => (
              <div key={m.id} className="aspect-square overflow-hidden rounded bg-gray-100 text-center text-[10px] text-gray-500">
                {m.media_type === 'image' && m.storage_url
                  ? <img src={m.storage_url} alt={m.alt_text || ''} className="h-full w-full object-cover" />
                  : <div className="flex h-full items-center justify-center">#{m.sort_order}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {profile.intro_review_note && introStatus === 'rejected' && (
        <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">
          退回原因：{profile.intro_review_note}
        </p>
      )}
    </div>
  );
}

function SpecialtyChipsField({ value, onChange }) {
  const [draft, setDraft] = React.useState('');
  function commit(text) {
    const parts = String(text).split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = Array.from(new Set([...(value || []), ...parts]));
    onChange(next);
    setDraft('');
  }
  function remove(tag) {
    onChange((value || []).filter((t) => t !== tag));
  }
  return (
    <div className="rounded-lg border border-gray-300 bg-white px-2 py-1.5">
      <div className="flex flex-wrap gap-1.5">
        {(value || []).map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-teal/15 px-2 py-0.5 text-xs text-brand-primary">
            {t}
            <button type="button" onClick={() => remove(t)} className="text-brand-primary/70 hover:text-rose-600" aria-label={`移除 ${t}`}>×</button>
          </span>
        ))}
        <input value={draft}
               onChange={(e) => setDraft(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
                   e.preventDefault();
                   commit(draft);
                 } else if (e.key === 'Backspace' && !draft && value?.length) {
                   onChange(value.slice(0, -1));
                 }
               }}
               onBlur={() => draft && commit(draft)}
               placeholder={value?.length ? '' : '新增專長…'}
               className="flex-1 min-w-[80px] border-none px-1 py-0.5 text-sm outline-none" />
      </div>
    </div>
  );
}

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
            <label className="mb-1 block text-sm font-medium text-gray-700">所屬場館（可複選）</label>
            {/* Task #90：多場館 chip 勾選；空陣列代表「不指定」（系統管理員 / 跨館） */}
            <VenueChipsField
              value={Array.isArray(editing.venue_ids) ? editing.venue_ids : (editing.venue_id ? [editing.venue_id] : [])}
              venues={venues}
              onChange={(ids) => setEditing({ ...editing, venue_ids: ids, venue_id: ids[0] || null })}
            />
            <p className="mt-1 text-xs text-gray-500">
              {editing.role === 'admin'
                ? '系統管理員可不指定場館（看全部）。'
                : '主管 / 行政 / 教練：勾選的場館清單就是其權限可見範圍。'}
            </p>
          </div>
          {/* Task #91：教練設定 — 角色 = 教練 或 兼任教練 LIFF 身分皆顯示 */}
          {editing.role === 'coach' && (
            <CoachProfileSection
              editing={editing} setEditing={setEditing}
              multiplierMin={multiplierMin} multiplierMax={multiplierMax}
            />
          )}
          {!isNew && editing.role !== 'coach' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
                  <input
                    type="checkbox"
                    checked={!!editing.coach_active}
                    onChange={(e) => setEditing({ ...editing, coach_active: e.target.checked })}
                  />
                  <span>啟用教練 LIFF 身分（兼任教練）</span>
                </label>
                <p className="mt-1 text-xs text-gray-500">
                  勾選後啟用「教練」身分，可在 LIFF 教練端登入並接課；取消勾選只暫停 LIFF 教練權限，coaches 列保留（避免清掉歷史排課 FK）。
                </p>
              </div>
              {(editing.coach_active || editing.has_coach_profile) && (
                <CoachProfileSection
                  editing={editing} setEditing={setEditing}
                  multiplierMin={multiplierMin} multiplierMax={multiplierMax}
                />
              )}
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

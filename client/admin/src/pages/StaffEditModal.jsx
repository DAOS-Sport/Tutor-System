import React from 'react';

/** Task #90：場館多選 chip — 已停用場館仍顯示但加註，避免下拉「莫名消失」。
 *  Task #95：disabled 模式（Ragic 來源員工）— 只顯示已選場館，不可點選。 */
function VenueChipsField({ value, venues, onChange, disabled = false }) {
  const selected = new Set(value || []);
  const visible = disabled
    ? venues.filter((v) => selected.has(v.id))
    : venues.filter((v) => v.is_active !== false || selected.has(v.id));
  function toggle(id) {
    if (disabled) return;
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(Array.from(next));
  }
  if (!visible.length) {
    return <p className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-400">{disabled ? '（尚無場館，待 Ragic 部門欄位同步帶入）' : '尚未設定任何場館'}</p>;
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
            disabled={disabled}
            className={
              'rounded-full border px-3 py-1 text-xs font-medium transition ' +
              (on
                ? 'border-brand-teal bg-brand-teal text-white'
                : 'border-gray-300 bg-white text-gray-700 hover:border-brand-teal') +
              (disabled ? ' cursor-not-allowed opacity-70' : '')
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

/** Task #91：教練設定區塊 — 簡介 / 專長 / 待審狀態 / 介紹圖排序 + 刪除 + 上下架 */
function CoachProfileSection({ editing, setEditing, multiplierMin, multiplierMax, showActiveToggle }) {
  const profile = editing.coach_profile || {};
  const specialties = Array.isArray(profile.specialties) ? profile.specialties : [];
  const introStatus = profile.intro_review_status || 'draft';
  const introMeta = INTRO_STATUS_LABEL[introStatus] || INTRO_STATUS_LABEL.draft;
  const bioMedia = Array.isArray(editing.bio_media) ? editing.bio_media : [];

  function patchProfile(p) {
    setEditing({ ...editing, coach_profile: { ...profile, ...p } });
  }
  function setBioMedia(next) {
    const reindexed = next.map((m, i) => ({ ...m, sort_order: i }));
    setEditing({ ...editing, bio_media: reindexed, bio_media_dirty: true });
  }
  function moveMedia(idx, dir) {
    const next = [...bioMedia];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setBioMedia(next);
  }
  function removeMedia(idx) {
    if (!window.confirm('確定刪除這張介紹圖？此操作無法復原。')) return;
    const next = bioMedia.filter((_, i) => i !== idx);
    setBioMedia(next);
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
               placeholder="可留空（Ragic H01 同步會自動補上）" />
        <p className="mt-1 text-[11px] text-gray-500">手動編輯後不會被 Ragic 覆寫；清空後下次同步會重新從 Ragic 帶入。</p>
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

      {showActiveToggle && (
        <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
          <input type="checkbox"
                 checked={editing.coach_active !== false}
                 onChange={(e) => setEditing({ ...editing, coach_active: e.target.checked })} />
          <span>教練上架（取消勾選會立即從家長端教練清單下架，但歷史排課 FK 保留）</span>
        </label>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-700">介紹圖 / 影片排序</span>
          <span className="text-[11px] text-gray-500">共 {bioMedia.length} 筆（拖移序號可改順序）</span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">教練可在 LIFF 個人頁上傳介紹圖；此處可調整顯示順序或刪除。</p>
        {bioMedia.length === 0 && (
          <p className="mt-2 text-xs text-gray-400">尚無介紹圖。</p>
        )}
        {bioMedia.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {bioMedia.map((m, idx) => (
              <li key={m.id} className="flex items-center gap-2 rounded border border-gray-200 bg-gray-50 p-1.5">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-brand-teal/15 text-[11px] font-bold text-brand-primary">{idx + 1}</span>
                <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-white">
                  {m.media_type === 'image' && m.storage_url
                    ? <img src={m.storage_url} alt={m.alt_text || ''} className="h-full w-full object-cover" />
                    : <div className="flex h-full items-center justify-center text-[10px] text-gray-500">影片</div>}
                </div>
                <span className="flex-1 truncate text-[11px] text-gray-600">{m.alt_text || m.storage_url}</span>
                <div className="flex gap-1">
                  <button type="button" disabled={idx === 0}
                          onClick={() => moveMedia(idx, -1)}
                          className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] hover:bg-white disabled:opacity-40">↑</button>
                  <button type="button" disabled={idx === bioMedia.length - 1}
                          onClick={() => moveMedia(idx, +1)}
                          className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] hover:bg-white disabled:opacity-40">↓</button>
                  <button type="button"
                          onClick={() => removeMedia(idx)}
                          className="rounded border border-rose-300 px-1.5 py-0.5 text-[11px] text-rose-700 hover:bg-rose-50">刪</button>
                </div>
              </li>
            ))}
          </ul>
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

/** 救生員設定區塊 — 比 CoachProfileSection 簡單得多：
 *  is_lifeguard 是否為救生員身分由 Ragic 應徵職務欄位判定，此處唯讀顯示；
 *  admin 只能開關 lifeguard_active（是否啟用救生員身分，比照教練上架/下架邏輯）。 */
function LifeguardProfileSection({ editing, setEditing }) {
  return (
    <div className="space-y-3 rounded-xl border border-amber-300/40 bg-amber-50 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-amber-800">救生員設定</h4>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
              title="是否為救生員由 Ragic 應徵職務欄位判定，此處唯讀">
          Ragic 判定：{editing.is_lifeguard ? '是' : '否'}
        </span>
      </div>
      <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
        <input type="checkbox"
               checked={editing.lifeguard_active !== false}
               onChange={(e) => setEditing({ ...editing, lifeguard_active: e.target.checked })} />
        <span>救生員上架（取消勾選會立即暫停其救生員身分；是否具救生員身分本身由 Ragic 判定，不受此開關影響）</span>
      </label>
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
 *
 * Task #91 後續：採雙欄佈局 — 左欄基本資料，右欄教練設定。
 *                取消 / 儲存 按鈕固定在 header 右上，啟用此帳號 在底部 sticky bar。
 */
export default function StaffEditModal({ editing, setEditing, venues, busy, onSave, multiplierMin, multiplierMax }) {
  if (!editing) return null;
  const isNew = !!editing.isNew;
  const showCoachPane = editing.role === 'coach' || editing.coach_active || editing.has_coach_profile;
  // Task #95（Ragic 權威政策）：來自 Ragic 的員工，姓名/手機/場館 唯讀 — 修改請洽 HR 至 Ragic 更新，
  // 系統同步會自動帶回（場館由「部門」欄位自動套用）。後端 PATCH 亦會忽略這些欄位（雙重防護）。
  const ragicLocked = !isNew && !!editing.ragic_locked;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && setEditing(null)}
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? '新建員工' : '編輯員工'}
    >
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-xl max-h-[92vh] overflow-hidden flex flex-col">
        {/* Header — 標題 + 取消/儲存 */}
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-6 py-4">
          <h3 className="text-lg font-bold text-brand-primary">
            {isNew ? '新建員工' : `編輯員工 — ${editing.name}`}
          </h3>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(null)}
              className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
              disabled={busy}
            >
              取消
            </button>
            <button
              onClick={onSave}
              disabled={busy}
              className="rounded-lg bg-brand-teal px-4 py-1.5 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
            >
              {busy ? '儲存中…' : (isNew ? '建立' : '儲存')}
            </button>
          </div>
        </div>

        {/* Body — 雙欄 grid */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* 左欄：基本資料 */}
            <div className="space-y-4">
              {isNew && (
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
                    <span className="ml-1 font-medium text-amber-700">建立後登入帳號與預設密碼 = 手機號碼（首次登入後請改密碼）。</span>
                  </p>
                </div>
              )}
              {ragicLocked && (
                <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-relaxed text-sky-800">
                  此員工來自 <span className="font-bold">Ragic 人事資料（權威來源）</span>：姓名、手機、所屬場館為唯讀，
                  如需修改請洽 HR 至 Ragic 更新，系統會自動同步帶回（場館依「部門」欄位自動套用）。
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">姓名{isNew ? ' *' : ''}</label>
                  <input
                    value={editing.name || ''}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    disabled={ragicLocked}
                    title={ragicLocked ? '由 Ragic 同步，修改請洽 HR' : undefined}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100 disabled:text-gray-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">手機{!ragicLocked ? ' *' : ''}</label>
                  <input
                    value={editing.phone || ''}
                    onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                    placeholder="0912345678"
                    disabled={ragicLocked}
                    title={ragicLocked ? '由 Ragic 同步，修改請洽 HR' : undefined}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100 disabled:text-gray-500"
                  />
                </div>
              </div>
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
                <label className="mb-1 block text-sm font-medium text-gray-700">所屬場館{ragicLocked ? '（由 Ragic 部門自動同步）' : '（可複選）'}</label>
                <VenueChipsField
                  value={Array.isArray(editing.venue_ids) ? editing.venue_ids : (editing.venue_id ? [editing.venue_id] : [])}
                  venues={venues}
                  disabled={ragicLocked}
                  onChange={(ids) => setEditing({ ...editing, venue_ids: ids, venue_id: ids[0] || null })}
                />
                <p className="mt-1 text-xs text-gray-500">
                  {ragicLocked
                    ? '場館清單依 Ragic「部門」欄位自動套用（即權限可見範圍），調整請洽 HR 修改 Ragic 部門。'
                    : (editing.role === 'admin'
                        ? '系統管理員可不指定場館（看全部）。'
                        : '主管 / 行政 / 教練：勾選的場館清單就是其權限可見範圍。')}
                </p>
              </div>
              {!isNew && editing.role !== 'coach' && (
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
              )}
            </div>

            {/* 右欄：教練設定 + 救生員設定 */}
            <div className="space-y-4">
              {showCoachPane ? (
                <CoachProfileSection
                  editing={editing} setEditing={setEditing}
                  multiplierMin={multiplierMin} multiplierMax={multiplierMax}
                  showActiveToggle={!isNew && editing.role === 'coach'}
                />
              ) : (
                <div className="flex h-full min-h-[260px] flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
                  <p className="text-sm font-medium text-gray-500">教練設定</p>
                  <p className="mt-2 text-xs text-gray-400 leading-relaxed">
                    角色選擇「教練」<br/>或勾選「啟用教練 LIFF 身分」<br/>後此處會出現教練專屬欄位<br/>（簡介、修課係數、Email、介紹圖等）。
                  </p>
                </div>
              )}
              {editing.is_lifeguard && (
                <LifeguardProfileSection editing={editing} setEditing={setEditing} />
              )}
            </div>
          </div>
        </div>

        {/* Footer — 啟用此帳號（橫跨整列） */}
        <div className="border-t border-gray-200 bg-gray-50 px-6 py-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!editing.active}
              onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
            />
            <span>啟用此帳號（取消勾選會立即停用其後台 login 與 LIFF 身分）</span>
          </label>
        </div>
      </div>
    </div>
  );
}

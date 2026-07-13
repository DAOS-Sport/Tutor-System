import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

/**
 * 團購共用：選擇「自己名下的學生（可多位）」+ 視需要新增學員。
 * 受控元件：value = { studentIds: string[], newStudents: NewStudent[] }
 *   NewStudent = { name, id_number?, birth_date?, gender }
 *
 * U10：匯款證明不在此元件上傳——改為送出後於團購狀態頁各家自行上傳。
 *
 * 學員一律「綁定」到家長名下——
 *   - 既有學員：勾選 → 收進 studentIds（已建檔、已在 Ragic）。
 *   - 新學員：填完整資料 → newStudents，後端會建檔到本人名下並 best-effort 回寫 Ragic。
 */
const emptyNewStudent = () => ({ name: '', id_number: '', birth_date: '', gender: '生理男' });

export default function GroupMemberFields({ value, onChange, maxStudents, error = '' }) {
  const toast = useToast();
  const { parent } = useAuth();
  const myStudents = (parent?.students || []).filter((s) => s && s.id && s.name && s.is_active !== false);

  const studentIds = value.studentIds || [];
  const newStudents = value.newStudents || [];
  const [showNew, setShowNew] = useState(myStudents.length === 0);

  // 依課程組別限制可選學生數（1對2→2、1對3→3）；未指定則不限。
  const cap = Number.isFinite(maxStudents) && maxStudents > 0 ? maxStudents : Infinity;
  const pickedCount = studentIds.length + newStudents.filter((s) => String(s?.name || '').trim()).length;
  const atCap = pickedCount >= cap;

  function togglePick(id) {
    const isOn = studentIds.includes(id);
    if (!isOn && atCap) {
      toast.warning?.(`此組別最多選 ${cap} 位學員`);
      return;
    }
    const next = isOn ? studentIds.filter((x) => x !== id) : [...studentIds, id];
    onChange({ ...value, studentIds: next });
  }
  function setNewAt(i, patch) {
    const next = newStudents.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    onChange({ ...value, newStudents: next });
  }
  function addNew() {
    if (atCap) { toast.warning?.(`此組別最多選 ${cap} 位學員`); return; }
    onChange({ ...value, newStudents: [...newStudents, emptyNewStudent()] });
    setShowNew(true);
  }
  function removeNew(i) {
    onChange({ ...value, newStudents: newStudents.filter((_, idx) => idx !== i) });
  }

  return (
    <div className="space-y-3">
      <div className={`rounded-xl border p-3 ${error ? 'border-brand-error bg-brand-error/5' : 'border-gray-200 bg-white'}`}>
        <label className="mb-2 block text-xs font-medium text-gray-600">
          選擇學生（您名下，可多位）
          {Number.isFinite(cap) && <span className="ml-1 text-brand-teal">已選 {pickedCount}/{cap}</span>}
        </label>

        {myStudents.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {myStudents.map((s) => {
              const on = studentIds.includes(s.id);
              const disabled = !on && atCap;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  title={disabled ? `此組別最多選 ${cap} 位學員` : undefined}
                  onClick={() => togglePick(s.id)}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-teal/30 ${
                    on
                      ? 'border-brand-teal bg-brand-teal text-white hover:bg-brand-primary'
                      : disabled
                        ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
                        : 'border-gray-300 bg-white text-gray-700 hover:border-brand-teal/60 hover:bg-brand-teal/5 active:bg-brand-teal/10'
                  }`}
                >
                  {on ? '✓ ' : ''}{s.name}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-400">名下尚無學生資料，請用下方新增學員。</p>
        )}

        {error && <p role="alert" className="mt-2 text-xs font-medium text-brand-error">{error}</p>}

        <button type="button" onClick={() => (showNew ? setShowNew(false) : addNew())}
          className="mt-2 text-xs font-bold text-brand-teal">
          {showNew ? '－ 收起新增學員' : '＋ 新增學員（會綁到您名下並同步資料表）'}
        </button>

        {showNew && (
          <div className="mt-2 space-y-3 border-t border-gray-100 pt-2">
            {newStudents.length === 0 && (
              <button type="button" onClick={addNew} className="text-xs font-bold text-brand-teal">＋ 新增一位學員</button>
            )}
            {newStudents.map((s, i) => (
              <div key={i} className="rounded-lg border border-gray-200 p-2.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-gray-600">新學員 {i + 1}</span>
                  <button type="button" onClick={() => removeNew(i)} className="text-xs text-brand-error">移除</button>
                </div>
                <div className="space-y-2">
                  <input type="text" value={s.name} onChange={(e) => setNewAt(i, { name: e.target.value })}
                    placeholder="學生姓名（必填）" className={inputCls} />
                  <input type="text" value={s.id_number}
                    onChange={(e) => setNewAt(i, { id_number: e.target.value.toUpperCase() })}
                    placeholder="身分證字號（建議填，利於資料比對）" className={`${inputCls} uppercase`} />
                  <div className="flex gap-2">
                    <input type="date" value={s.birth_date} onChange={(e) => setNewAt(i, { birth_date: e.target.value })}
                      className={`${inputCls} flex-1`} />
                    <select value={s.gender} onChange={(e) => setNewAt(i, { gender: e.target.value })}
                      className={`${inputCls} w-24`}>
                      <option value="生理男">生理男</option><option value="生理女">生理女</option><option value="不方便透漏">不方便透漏</option>
                    </select>
                  </div>
                </div>
              </div>
            ))}
            {newStudents.length > 0 && (
              <button type="button" onClick={addNew} className="text-xs font-bold text-brand-teal">＋ 再加一位</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none';

// 供頁面驗證：至少選/填一位學生（U10：證明改送審後上傳，這裡不再要求）
export function memberFieldsReady(value) {
  const ids = value.studentIds || [];
  const news = (value.newStudents || []).filter((s) => String(s.name || '').trim());
  return (ids.length + news.length) > 0;
}

// 供頁面組裝送出 payload
export function memberFieldsPayload(value) {
  return {
    student_ids: value.studentIds || [],
    new_students: (value.newStudents || [])
      .filter((s) => String(s.name || '').trim())
      .map((s) => ({
        name: s.name.trim(),
        id_number: (s.id_number || '').trim() || undefined,
        birth_date: s.birth_date || undefined,
        gender: s.gender || undefined,
      })),
  };
}

import React, { useState } from 'react';
import { enrollmentsApi } from '../../api/enrollments';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';

/**
 * 團購共用：選擇「自己名下的學生（可多位）」+ 上傳匯款證明。
 * 受控元件：value = { studentNames: string[], proofUrl: string }
 *
 * 學生來源優先用家長名下的學生（parent.students，勾選即可，免手打）；
 * 名下尚未建檔的學生可用「手動補充」自行輸入。最終都化為 studentNames 字串陣列送出。
 */
export default function GroupMemberFields({ value, onChange, uploading, setUploading }) {
  const toast = useToast();
  const { parent } = useAuth();
  const myStudents = (parent?.students || []).filter((s) => s && s.id && s.name);

  const [pickedIds, setPickedIds] = useState([]);
  const [manual, setManual] = useState(['']);
  const [showManual, setShowManual] = useState(myStudents.length === 0);

  // 把目前勾選的名下學生 + 手動輸入合併成 studentNames 後回拋給父層
  function emit(ids, manualArr) {
    const pickedNames = ids
      .map((id) => myStudents.find((s) => s.id === id)?.name)
      .filter(Boolean);
    const manualNames = manualArr.map((s) => String(s || '').trim()).filter(Boolean);
    onChange({ ...value, studentNames: [...pickedNames, ...manualNames] });
  }

  function togglePick(id) {
    const next = pickedIds.includes(id) ? pickedIds.filter((x) => x !== id) : [...pickedIds, id];
    setPickedIds(next);
    emit(next, manual);
  }
  function setManualAt(i, v) {
    const next = manual.slice();
    next[i] = v;
    setManual(next);
    emit(pickedIds, next);
  }
  function addManual() {
    setManual([...manual, '']);
  }
  function removeManual(i) {
    const next = manual.filter((_, idx) => idx !== i);
    const nn = next.length ? next : [''];
    setManual(nn);
    emit(pickedIds, nn);
  }

  async function handleProof(file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) return toast.error('只接受 JPG / PNG 圖片');
    if (file.size > 5 * 1024 * 1024) return toast.error('圖片大小不得超過 5MB');
    setUploading(true);
    try {
      const { url } = await enrollmentsApi.uploadPaymentProof(file);
      onChange({ ...value, proofUrl: url || '' });
    } catch {
      toast.error('證明上傳失敗，請重試');
      onChange({ ...value, proofUrl: '' });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-2 block text-xs font-medium text-gray-600">選擇學生（您名下，可多位）</label>

        {myStudents.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {myStudents.map((s) => {
              const on = pickedIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => togglePick(s.id)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    on ? 'bg-brand-teal text-white' : 'bg-gray-100 text-gray-600 active:bg-gray-200'
                  }`}
                >
                  {on ? '✓ ' : ''}{s.name}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-400">名下尚無學生資料，請用下方手動輸入。</p>
        )}

        {/* 手動補充：名下沒建檔的學生 */}
        {myStudents.length > 0 && (
          <button type="button" onClick={() => setShowManual((v) => !v)}
            className="mt-2 text-xs font-bold text-brand-teal">
            {showManual ? '－ 收起手動輸入' : '＋ 找不到？手動補充學生'}
          </button>
        )}

        {showManual && (
          <div className="mt-2 space-y-2 border-t border-gray-100 pt-2">
            {manual.map((n, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={n}
                  onChange={(e) => setManualAt(i, e.target.value)}
                  placeholder={`手動輸入學生 ${i + 1} 姓名`}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
                />
                {manual.length > 1 && (
                  <button type="button" onClick={() => removeManual(i)}
                    className="rounded-lg bg-gray-100 px-3 text-sm font-bold text-gray-500">刪除</button>
                )}
              </div>
            ))}
            <button type="button" onClick={addManual}
              className="text-xs font-bold text-brand-teal">＋ 再加一位</button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-2 block text-xs font-medium text-gray-600">匯款／轉帳證明（JPG / PNG，≤5MB）</label>
        <input
          type="file"
          accept="image/jpeg,image/png"
          onChange={(e) => handleProof(e.target.files?.[0])}
          className="block w-full text-xs text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-teal file:px-3 file:py-2 file:text-xs file:font-bold file:text-white"
        />
        {uploading && <p className="mt-1 text-xs text-gray-400">上傳中…</p>}
        {value.proofUrl && !uploading && <p className="mt-1 text-xs text-brand-green">已上傳證明 ✓</p>}
      </div>
    </div>
  );
}

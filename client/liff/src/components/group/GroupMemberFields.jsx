import React from 'react';
import { enrollmentsApi } from '../../api/enrollments';
import { useToast } from '../../context/ToastContext';

/**
 * 團購共用：填寫「自己學生姓名（可多位）」+ 上傳匯款證明。
 * 受控元件：value = { studentNames: string[], proofUrl: string }
 */
export default function GroupMemberFields({ value, onChange, uploading, setUploading }) {
  const toast = useToast();
  const names = value.studentNames.length ? value.studentNames : [''];

  function setName(i, v) {
    const next = names.slice();
    next[i] = v;
    onChange({ ...value, studentNames: next });
  }
  function addName() {
    onChange({ ...value, studentNames: [...names, ''] });
  }
  function removeName(i) {
    const next = names.filter((_, idx) => idx !== i);
    onChange({ ...value, studentNames: next.length ? next : [''] });
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
        <label className="mb-2 block text-xs font-medium text-gray-600">學生姓名（您名下，可多位）</label>
        <div className="space-y-2">
          {names.map((n, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                value={n}
                onChange={(e) => setName(i, e.target.value)}
                placeholder={`學生 ${i + 1} 姓名`}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
              />
              {names.length > 1 && (
                <button type="button" onClick={() => removeName(i)}
                  className="rounded-lg bg-gray-100 px-3 text-sm font-bold text-gray-500">刪除</button>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={addName}
          className="mt-2 text-xs font-bold text-brand-teal">＋ 新增一位學生</button>
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

import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypesApi } from '../api/courseTypes';

const autoLabel = (ct) => {
  const map = { 1: '一對一', 2: '一對二', 3: '一對三', 4: '一對四', 5: '一對五', 6: '一對六' };
  return map[ct] || `一對${ct}`;
};

export default function CourseTypesPage() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [saving, setSaving] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ course_type: '', label: '', min_students: '', max_students: '' });
  const [addErr, setAddErr] = useState('');
  const [editing, setEditing] = useState(null); // { course_type, label, min_students, max_students }
  const [editErr, setEditErr] = useState('');

  async function load() {
    try {
      const data = await courseTypesApi.list();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      const msg = e?.response?.data?.error || '載入失敗';
      toast.error(msg);
      setRows([]);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleActive(row) {
    setSaving(row.course_type);
    try {
      await courseTypesApi.update(row.course_type, { is_active: !row.is_active });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '更新失敗');
    } finally { setSaving(null); }
  }

  async function handleAdd(e) {
    e.preventDefault();
    setAddErr('');
    const ct = parseInt(form.course_type, 10);
    const ms = parseInt(form.max_students, 10);
    const mn = form.min_students === '' ? 1 : parseInt(form.min_students, 10);
    if (isNaN(ct) || ct < 1) return setAddErr('課程編號必須為正整數');
    if (!form.label.trim()) return setAddErr('請填寫名稱');
    if (isNaN(ms) || ms < 1 || ms > 10) return setAddErr('最多學生人數需為 1–10 之間');
    if (isNaN(mn) || mn < 1 || mn > 10) return setAddErr('最少學生人數需為 1–10 之間');
    if (mn > ms) return setAddErr('最少學生人數不可大於最多學生人數');
    try {
      await courseTypesApi.create({ course_type: ct, label: form.label.trim(), min_students: mn, max_students: ms });
      setShowAdd(false);
      setForm({ course_type: '', label: '', min_students: '', max_students: '' });
      toast.success(`已新增「${form.label.trim()}」`);
      await load();
    } catch (e) {
      setAddErr(e?.response?.data?.error || '新增失敗');
    }
  }

  function startEdit(row) {
    setEditing({
      course_type: row.course_type,
      label: row.label,
      min_students: String(row.min_students ?? 1),
      max_students: String(row.max_students),
    });
    setEditErr('');
  }

  async function handleSaveEdit(e) {
    e.preventDefault();
    setEditErr('');
    const lb = (editing.label || '').trim();
    const ms = parseInt(editing.max_students, 10);
    const mn = editing.min_students === '' ? 1 : parseInt(editing.min_students, 10);
    if (!lb) return setEditErr('請填寫名稱');
    if (lb.length > 50) return setEditErr('名稱長度不可超過 50');
    if (isNaN(ms) || ms < 1 || ms > 10) return setEditErr('最多學生人數需為 1–10 之間');
    if (isNaN(mn) || mn < 1 || mn > 10) return setEditErr('最少學生人數需為 1–10 之間');
    if (mn > ms) return setEditErr('最少學生人數不可大於最多學生人數');
    setSaving(editing.course_type);
    try {
      await courseTypesApi.update(editing.course_type, { label: lb, min_students: mn, max_students: ms });
      toast.success('已更新');
      setEditing(null);
      await load();
    } catch (err) {
      setEditErr(err?.response?.data?.error || '更新失敗');
    } finally { setSaving(null); }
  }

  async function handleDelete(row) {
    if (!window.confirm(`確定刪除「${row.label}」嗎？（有報名記錄的類型無法刪除）`)) return;
    setSaving(row.course_type);
    try {
      await courseTypesApi.remove(row.course_type);
      toast.success(`已刪除「${row.label}」`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '刪除失敗');
    } finally { setSaving(null); }
  }

  if (!rows) return <LoadingSpinner fullPage />;

  return (
    <div>
      <PageHeader
        title="課程需求管理"
        subtitle="F-A07 · 設定可用的師生比規格（停用後 LIFF 報名頁不再顯示）"
        actions={
          <button
            onClick={() => { setShowAdd(true); setAddErr(''); }}
            className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            + 新增課程需求
          </button>
        }
      />

      {showAdd && (
        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-5">
          <div className="mb-3 font-semibold text-blue-800">新增課程需求</div>
          <form onSubmit={handleAdd} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">課程編號（正整數）</label>
              <input
                type="number" min="1"
                value={form.course_type}
                onChange={(e) => {
                  const ct = e.target.value;
                  setForm((f) => ({
                    ...f,
                    course_type: ct,
                    label: f.label || autoLabel(parseInt(ct, 10)),
                    max_students: f.max_students || ct,
                  }));
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                placeholder="例：4"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">名稱（顯示用）</label>
              <input
                type="text"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                placeholder="例：一對四"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">最少學生人數（1–10）</label>
              <input
                type="number" min="1" max="10"
                value={form.min_students}
                onChange={(e) => setForm((f) => ({ ...f, min_students: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                placeholder="例：2（揪團最低成團）"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">最多學生人數（1–10）</label>
              <input
                type="number" min="1" max="10"
                value={form.max_students}
                onChange={(e) => setForm((f) => ({ ...f, max_students: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                placeholder="例：4"
                required
              />
            </div>
            {addErr && <p className="col-span-full text-sm text-red-600">{addErr}</p>}
            <div className="col-span-full flex gap-2">
              <button type="submit" className="rounded-lg bg-brand-primary px-5 py-2 text-sm font-semibold text-white hover:opacity-90">
                新增
              </button>
              <button
                type="button"
                onClick={() => { setShowAdd(false); setForm({ course_type: '', label: '', min_students: '', max_students: '' }); setAddErr(''); }}
                className="rounded-lg border border-gray-300 px-5 py-2 text-sm hover:bg-gray-50"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-5 py-3 text-left font-semibold text-gray-600">課程需求</th>
              <th className="px-5 py-3 text-left font-semibold text-gray-600">最少學生</th>
              <th className="px-5 py-3 text-left font-semibold text-gray-600">最多學生</th>
              <th className="px-5 py-3 text-left font-semibold text-gray-600">系統代碼</th>
              <th className="px-5 py-3 text-left font-semibold text-gray-600">狀態</th>
              <th className="px-5 py-3 text-right font-semibold text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-gray-400">尚無課程需求設定</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.course_type} className={`transition hover:bg-gray-50 ${!row.is_active ? 'opacity-50' : ''}`}>
                <td className="px-5 py-4 font-semibold text-gray-800">
                  {editing?.course_type === row.course_type ? (
                    <input
                      type="text"
                      value={editing.label}
                      onChange={(e) => setEditing((s) => ({ ...s, label: e.target.value }))}
                      className="w-32 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                  ) : row.label}
                </td>
                <td className="px-5 py-4 text-gray-600">
                  {editing?.course_type === row.course_type ? (
                    <input
                      type="number" min="1" max="10"
                      value={editing.min_students}
                      onChange={(e) => setEditing((s) => ({ ...s, min_students: e.target.value }))}
                      className="w-20 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                  ) : `${row.min_students ?? 1} 人`}
                </td>
                <td className="px-5 py-4 text-gray-600">
                  {editing?.course_type === row.course_type ? (
                    <input
                      type="number" min="1" max="10"
                      value={editing.max_students}
                      onChange={(e) => setEditing((s) => ({ ...s, max_students: e.target.value }))}
                      className="w-20 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                    />
                  ) : `${row.max_students} 人`}
                </td>
                <td className="px-5 py-4">
                  <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-500">
                    course_type = {row.course_type}
                  </span>
                </td>
                <td className="px-5 py-4">
                  {row.is_active ? (
                    <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">啟用中</span>
                  ) : (
                    <span className="rounded-full bg-gray-200 px-3 py-1 text-xs font-semibold text-gray-500">已停用</span>
                  )}
                </td>
                <td className="px-5 py-4 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex justify-end gap-2">
                      {editing?.course_type === row.course_type ? (
                        <>
                          <button
                            onClick={handleSaveEdit}
                            disabled={saving === row.course_type}
                            className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                          >
                            {saving === row.course_type ? '儲存中…' : '儲存'}
                          </button>
                          <button
                            onClick={() => { setEditing(null); setEditErr(''); }}
                            disabled={saving === row.course_type}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(row)}
                            disabled={saving === row.course_type || !!editing}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
                          >
                            編輯
                          </button>
                          <button
                            onClick={() => toggleActive(row)}
                            disabled={saving === row.course_type || !!editing}
                            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
                          >
                            {saving === row.course_type ? '…' : row.is_active ? '停用' : '啟用'}
                          </button>
                          <button
                            onClick={() => handleDelete(row)}
                            disabled={saving === row.course_type || !!editing}
                            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            刪除
                          </button>
                        </>
                      )}
                    </div>
                    {editing?.course_type === row.course_type && editErr && (
                      <p className="text-xs text-red-600">{editErr}</p>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
        提示：已有報名記錄的課程需求無法刪除，請改為「停用」。停用後 LIFF 報名流程不再顯示該規格。
      </div>
    </div>
  );
}

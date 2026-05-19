import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { adminKeywordsApi } from '../api/chat';

const CATEGORY_OPTIONS = ['違規收費', '私下交易', '客訴風險', '其他'];
const CATEGORY_TONE = {
  違規收費: 'orange', 私下交易: 'gold', 客訴風險: 'primary', 其他: 'teal',
};

const EMPTY_FORM = { keyword: '', category: '其他', is_active: true };

export default function KeywordsPage() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editId, setEditId] = useState(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    setList(null);
    adminKeywordsApi.list()
      .then((r) => setList(Array.isArray(r) ? r : []))
      .catch((e) => { setList([]); toast.error(e?.response?.data?.error || e.message); });
  }
  useEffect(reload, []); // eslint-disable-line

  function startEdit(k) {
    setEditId(k.id);
    setForm({ keyword: k.keyword, category: k.category, is_active: k.is_active });
  }
  function reset() { setEditId(null); setForm(EMPTY_FORM); }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.keyword.trim()) { toast.error('請輸入關鍵字'); return; }
    setBusy(true);
    try {
      if (editId) {
        await adminKeywordsApi.update(editId, form);
        toast.success('已更新關鍵字');
      } else {
        await adminKeywordsApi.create(form);
        toast.success('已新增關鍵字');
      }
      reset(); reload();
    } catch (e2) {
      toast.error(e2?.response?.data?.error || '儲存失敗');
    } finally { setBusy(false); }
  }

  async function handleToggle(k) {
    try {
      await adminKeywordsApi.update(k.id, { is_active: !k.is_active });
      reload();
    } catch (e) { toast.error(e?.response?.data?.error || '更新失敗'); }
  }

  async function handleDelete(k) {
    if (!confirm(`確定要刪除「${k.keyword}」？`)) return;
    try {
      await adminKeywordsApi.remove(k.id);
      toast.success('已刪除');
      reload();
    } catch (e) { toast.error(e?.response?.data?.error || '刪除失敗'); }
  }

  const columns = [
    { key: 'keyword', label: '關鍵字', render: (k) => <code className="text-sm font-bold text-brand-primary">{k.keyword}</code> },
    { key: 'category', label: '分類', render: (k) => (
      <StatusBadge tone={CATEGORY_TONE[k.category] || 'teal'} label={k.category} />
    )},
    { key: 'is_active', label: '狀態', render: (k) => (
      <button type="button" onClick={() => handleToggle(k)}
        className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${k.is_active ? 'bg-brand-green text-white' : 'bg-gray-200 text-gray-600'}`}>
        {k.is_active ? '啟用中' : '停用'}
      </button>
    )},
    { key: 'op', label: '操作', render: (k) => (
      <div className="flex gap-2">
        <button type="button" onClick={() => startEdit(k)}
          className="rounded-md border border-brand-teal px-2 py-1 text-xs font-bold text-brand-teal hover:bg-brand-teal/5">編輯</button>
        <button type="button" onClick={() => handleDelete(k)}
          className="rounded-md border border-red-500 px-2 py-1 text-xs font-bold text-red-500 hover:bg-red-50">刪除</button>
      </div>
    )},
  ];

  return (
    <div>
      <PageHeader title="關鍵字管理 (F-A07)" subtitle="維護敏感字詞清單，命中即觸發主管警示。" />

      <form onSubmit={handleSubmit} className="mb-5 grid grid-cols-1 gap-3 rounded-xl bg-white p-4 shadow-sm md:grid-cols-5">
        <input type="text" value={form.keyword} placeholder="關鍵字（例：私下加、紅包、退費）"
          onChange={(e) => setForm({ ...form, keyword: e.target.value })}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none md:col-span-2" />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm">
          {CATEGORY_OPTIONS.map((o) => <option key={o} value={o}>分類：{o}</option>)}
        </select>
        <label className="flex items-center gap-2 px-3 py-2 text-sm">
          <input type="checkbox" checked={form.is_active}
            onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
          啟用
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={busy}
            className="flex-1 rounded-md bg-brand-teal px-3 py-2 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50">
            {editId ? '更新' : '新增'}
          </button>
          {editId && (
            <button type="button" onClick={reset}
              className="rounded-md bg-gray-200 px-3 py-2 text-sm font-bold text-gray-700">取消</button>
          )}
        </div>
      </form>

      {!list ? <LoadingSpinner /> : (
        <DataTable columns={columns} rows={list} emptyText="尚未設定任何關鍵字" />
      )}
    </div>
  );
}

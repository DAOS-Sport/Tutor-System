import React, { useEffect, useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseIntrosApi } from '../api/courseIntros';

function IntroCard({ row, onSave }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [draft, setDraft] = useState({ title: row.title, body: row.body, image_url: row.image_url });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const dirty = ['title', 'body', 'image_url'].some((k) => (draft[k] || '') !== (row[k] || ''));

  async function handleFile(file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) { toast.error('只接受 JPG / PNG 圖片'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('圖片大小不得超過 5MB'); return; }
    setUploading(true);
    try {
      const { url } = await courseIntrosApi.uploadImage(file);
      setDraft((d) => ({ ...d, image_url: url }));
    } catch (e) {
      toast.error(e?.response?.data?.error || '圖片上傳失敗');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function save() {
    if (!draft.title?.trim()) {
      toast.error('標題不可為空');
      return;
    }
    setBusy(true);
    try {
      const updated = await onSave(row.course_type, draft);
      setDraft({ title: updated.title, body: updated.body, image_url: updated.image_url });
      toast.success(`已儲存「${row.label}」介紹`);
    } catch {
      toast.error('儲存失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-white p-6 shadow-sm ${row.is_active ? 'border-gray-200' : 'border-gray-300 bg-gray-50'}`}>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`text-base font-bold ${row.is_active ? 'text-brand-primary' : 'text-gray-500'}`}>
            {row.label}
          </div>
          <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-500">
            type = {row.course_type}
          </span>
          {!row.is_active && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-600">已停用</span>
          )}
          {row.title_overridden && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700" title="標題已被覆寫，名稱變更不會自動同步">
              標題已自訂
            </span>
          )}
        </div>
        <button
          onClick={save}
          disabled={!dirty || busy}
          className="rounded-lg bg-brand-teal px-3 py-1.5 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
        >
          {busy ? '儲存中…' : '儲存'}
        </button>
      </div>
      {!row.is_active && (
        <div className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
          此課程需求已停用，家長 LIFF 不會看到此介紹；仍可在此編輯內容。
        </div>
      )}
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">標題</label>
          <input
            type="text"
            value={draft.title || ''}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2"
          />
          <p className="mt-1 text-xs text-gray-500">
            預設與「課程需求名稱」相同；改成其他文字後，後台改名不會自動覆蓋此標題。
          </p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">內文</label>
          <textarea
            rows={4}
            value={draft.body || ''}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            封面圖片（可選）
            <span className="ml-2 font-normal text-gray-400">（JPG / PNG，≤ 5MB）</span>
          </label>
          <div
            className={`relative flex min-h-28 flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 transition ${draft.image_url ? 'border-brand-teal bg-brand-teal/5' : 'cursor-pointer border-gray-300 hover:border-brand-teal'}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (!uploading) handleFile(e.dataTransfer.files?.[0]); }}
            onClick={() => { if (!draft.image_url && !uploading) fileRef.current?.click(); }}
          >
            {uploading ? (
              <div className="text-sm text-gray-400">上傳中…</div>
            ) : draft.image_url ? (
              <>
                <img src={draft.image_url} alt="封面預覽" className="max-h-40 rounded-lg object-contain" />
                <div className="mt-2 flex gap-3 text-xs">
                  <button
                    type="button"
                    className="text-gray-500 underline hover:text-brand-teal"
                    onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
                  >重新選擇</button>
                  <button
                    type="button"
                    className="text-gray-500 underline hover:text-red-500"
                    onClick={(e) => { e.stopPropagation(); setDraft((d) => ({ ...d, image_url: '' })); }}
                  >移除圖片</button>
                </div>
              </>
            ) : (
              <div className="text-center text-sm text-gray-400">
                <div className="mb-1 text-3xl">🖼️</div>
                <div>拖放或點此選擇封面圖片</div>
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CourseIntrosPage() {
  const toast = useToast();
  const [rows, setRows] = useState(null);

  async function load() {
    try {
      const data = await courseIntrosApi.list();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      // 載入失敗時跳出無限轉圈：顯示空清單 + toast 引導重新整理
      toast.error(e?.response?.data?.error || '載入課程介紹失敗，請重新整理頁面');
      setRows([]);
    }
  }
  useEffect(() => { load(); }, []);

  async function onSave(type, patch) {
    const res = await courseIntrosApi.update(type, patch);
    setRows((list) => list.map((r) =>
      r.course_type === type
        ? { ...r, title: res.title, body: res.body, image_url: res.image_url, title_overridden: res.title_overridden }
        : r
    ));
    return res;
  }

  if (!rows) return <LoadingSpinner fullPage />;

  return (
    <div>
      <PageHeader
        title="課程介紹維護"
        subtitle="F-A04 · 介紹隨「課程需求」自動增減；停用後家長 LIFF 不顯示，但仍可編輯。"
      />
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-12 text-center text-gray-400">
          尚無課程需求；請先到「課程需求管理」新增。
        </div>
      ) : (
        <div className="space-y-5">
          {rows.map((r) => (
            <IntroCard key={r.course_type} row={r} onSave={onSave} />
          ))}
        </div>
      )}
    </div>
  );
}

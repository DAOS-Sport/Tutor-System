import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { enrollmentsApi } from '../api/enrollments';
import { courseTypeLabel, formatTWDateTime } from '../utils/format';

// 手動建檔頁的「建檔記錄」（使用者 2026-11-03：原本「本次操作建檔歷程（暫存累計）」重新整理就不見，
// 改成從資料庫列出「目前登入帳號建過的單」，含現在的狀態）。後端 GET /api/admin/enrollments?createdBy=me
// 以登入 token 認人，前端傳不了別人的帳號。refreshKey 變動（剛建好一筆）就重新載入。
const LIMIT = 100;
const STATUS = {
  pending_payment: ['待對帳', 'border-amber-200 bg-amber-50 text-amber-800'],
  confirmed: ['已對帳', 'border-emerald-200 bg-emerald-50 text-emerald-800'],
  cancelled: ['已取消', 'border-slate-200 bg-slate-50 text-slate-500'],
  refunded: ['已退費', 'border-red-200 bg-red-50 text-red-700'],
};
const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString() + ' 元');

export default function ManualEnrollRecords({ refreshKey = 0, venueName = (id) => id }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setError('');
    enrollmentsApi.list({ createdBy: 'me', limit: LIMIT })
      .then((data) => { if (alive) setRows(Array.isArray(data) ? data : []); })
      .catch((err) => { if (alive) { setRows([]); setError(err?.response?.data?.error || '建檔記錄載入失敗'); } });
    return () => { alive = false; };
  }, [refreshKey]);

  function exportCsv() {
    if (!rows || !rows.length) return;
    const head = ['建檔時間', '編號', '家長', '電話', '學員', '館別', '組別', '教練', '堂數', '期別', '原價', '實收', '收付方式', '狀態'];
    const lines = rows.map((r) => [
      formatTWDateTime(r.submitted_at), r.id, r.parent_name, r.parent_phone, (r.students || []).join(' '),
      venueName(r.venue_id), courseTypeLabel(r.course_type), r.coach, r.total_sessions,
      (r.period_number || 1) + '/' + (r.period_count || 1), r.original_price, r.final_price, r.payment_method,
      (STATUS[r.status] || [r.status])[0],
    ]);
    const csv = [head, ...lines].map((row) => row.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '建檔記錄_' + rows.length + '筆.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200/80 bg-slate-50/80 p-5 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-extrabold tracking-wide text-slate-800">建檔記錄</h2>
          <span className="rounded-full bg-indigo-600 px-2.5 py-0.5 text-[11px] font-black text-white">{rows ? rows.length : 0} 筆</span>
          <span className="text-[11px] text-slate-400">我建的單（最近 {LIMIT} 筆）</span>
        </div>
        <div className="flex gap-2">
          {rows && rows.length > 0 && (
            <button type="button" onClick={exportCsv} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">匯出 CSV</button>
          )}
          <Link to="/reconcile" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">前往待對帳</Link>
        </div>
      </div>
      {error && <p role="alert" className="px-5 pt-3 text-xs text-red-600">{error}</p>}
      {rows === null ? (
        <p className="py-12 text-center text-xs text-slate-400">載入建檔記錄中…</p>
      ) : rows.length === 0 ? (
        <div className="py-16 text-center">
          <h4 className="text-sm font-bold text-slate-700">目前沒有建檔記錄</h4>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-400">用這個帳號建好的單都會列在這裡，重新整理也不會消失。</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                <th className="p-4 pl-6">建檔時間</th><th className="p-4">學員 / 家長</th><th className="p-4">館別 / 組別</th>
                <th className="p-4">教練 / 堂數</th><th className="p-4">金額</th><th className="p-4">收付方式</th><th className="p-4 pr-6 text-center">狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
              {rows.map((r) => {
                const [label, tone] = STATUS[r.status] || [r.status || '—', 'border-slate-200 bg-slate-50 text-slate-600'];
                return (
                  <tr key={r.id} className="transition hover:bg-slate-50/80">
                    <td className="p-4 pl-6 font-mono text-[11px] text-slate-500">{formatTWDateTime(r.submitted_at)}<div className="mt-1 text-[10px] text-slate-400">{r.id}</div></td>
                    <td className="p-4">
                      <div className="text-sm font-extrabold text-slate-950">{(r.students || []).join('、') || '—'}</div>
                      <div className="mt-1 text-[10px] text-slate-400">家長：{r.parent_name}（{r.parent_phone}）</div>
                    </td>
                    <td className="p-4"><span className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-extrabold text-slate-700">{venueName(r.venue_id)}</span><div className="mt-0.5 text-[10px] text-slate-400">{courseTypeLabel(r.course_type)}</div></td>
                    <td className="p-4"><div className="font-bold text-slate-800">{r.coach || '—'}</div><div className="mt-1 text-[10px] text-slate-400">{r.total_sessions} 堂{(r.period_count || 1) > 1 ? '・第 ' + r.period_number + '/' + r.period_count + ' 期' : ''}</div></td>
                    <td className="p-4"><div className="text-sm font-black text-emerald-700">{money(r.final_price)}</div><div className="mt-1 text-[10px] text-slate-400">原價 {money(r.original_price)}</div></td>
                    <td className="p-4 text-xs text-slate-800">{r.payment_method || '—'}</td>
                    <td className="p-4 pr-6 text-center"><span className={'inline-flex rounded-full border px-2.5 py-1 text-[10px] font-black ' + tone}>{label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

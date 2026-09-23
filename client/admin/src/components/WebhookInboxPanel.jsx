import React, { useEffect, useState } from 'react';
import { ragicStatusApi } from '../api/ragicStatus';

const labels = { pending: '待處理', retryable: '等待重試', blocked: '需要人工處理', completed: '已完成' };
export default function WebhookInboxPanel({ canRetry }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function load() {
    try { setData(await ragicStatusApi.webhookInbox()); setError(''); }
    catch { setError('通知處理狀態讀取失敗，請稍後重新整理。'); }
  }
  useEffect(() => { load(); const timer = setInterval(load, 30000); return () => clearInterval(timer); }, []);
  async function retry(item) {
    const key = `${item.sheet_code}:${item.ragic_record_id}`;
    setBusy(key);
    try { await ragicStatusApi.retryWebhook(item); await load(); }
    catch { setError('重新排入失敗，請確認權限或最新狀態後再試。'); }
    finally { setBusy(''); }
  }
  return <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
    <h2 className="text-sm font-bold">Ragic 通知處理</h2>
    <p className="my-2 text-xs text-gray-600">暫時失敗會自動重試；達 8 次後保留於待處理，修正來源資料或連線後可重新排入。</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!data && !error && <p>讀取中…</p>}
    {data && <p className="text-sm">{data.summary.map(row => `${labels[row.state] || row.state} ${row.count}`).join(' · ') || '尚無通知'}</p>}
    <div className="mt-3 space-y-2">{(data?.items || []).map(item => {
      const key = `${item.sheet_code}:${item.ragic_record_id}`;
      return <div key={key} className="flex flex-wrap items-center justify-between gap-2 border-t py-2 text-xs">
        <span>{key} · {labels[item.state]} · {item.attempts}/{item.max_attempts} 次{item.last_error_code ? ` · ${item.last_error_code}` : ''}</span>
        {canRetry && ['retryable', 'blocked'].includes(item.state) && <button type="button" disabled={Boolean(busy) || Boolean(error)}
          onClick={() => retry(item)} className="min-h-11 rounded border px-3 py-2 disabled:opacity-50">
          {busy === key ? '排入中…' : '重新排入'}
        </button>}
      </div>;
    })}</div>
  </section>;
}

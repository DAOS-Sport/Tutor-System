import React, { useEffect, useState } from 'react';
import { ragicStatusApi } from '../api/ragicStatus';

const LABELS = { pending: '處理中', retryable: '等待重試', blocked: '需要人工處理', completed: '已完成' };
const TONE = {
  pending: 'bg-gray-100 text-gray-700',
  retryable: 'bg-amber-100 text-amber-800',
  blocked: 'bg-red-100 text-red-700',
  completed: 'bg-brand-green/15 text-brand-green',
};
const SHEET_NAMES = { H01: '員工', H05: '場館', Z01: '家長', Z02: '學員' };

// Ragic Webhook 收件匣：Ragic 資料一改就通知系統更新；這裡看處理結果，必要時重新排入。
// onSummary 把各狀態筆數回報給頁面頂端的總覽。
export default function WebhookInboxPanel({ canRetry, onSummary }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  async function load() {
    try {
      const next = await ragicStatusApi.webhookInbox();
      setData(next);
      setError('');
      if (onSummary) onSummary(next.summary || []);
    } catch {
      setError('通知處理狀態讀取失敗，請稍後重新整理。');
    }
  }
  useEffect(() => { load(); const timer = setInterval(load, 30000); return () => clearInterval(timer); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function retry(item) {
    const key = `${item.sheet_code}:${item.ragic_record_id}`;
    setBusy(key);
    try { await ragicStatusApi.retryWebhook(item); await load(); }
    catch { setError('重新排入失敗，請確認權限或最新狀態後再試。'); }
    finally { setBusy(''); }
  }
  const summary = data?.summary || [];
  const items = data?.items || [];
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold text-gray-800">即時通知（Ragic Webhook）</h2>
      <p className="mt-1 text-xs text-gray-500">
        Ragic 的資料一改就會通知系統更新。暫時失敗會自動重試；重試 8 次仍失敗的，修正資料或連線後按「重新排入」。
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
      {!data && !error && <p className="mt-2 text-xs text-gray-500">讀取中…</p>}
      {data && (
        <div className="mt-3 flex flex-wrap gap-2">
          {summary.length
            ? summary.map((row) => (
              <span key={row.state} className={`rounded px-2 py-0.5 text-xs font-bold ${TONE[row.state] || 'bg-gray-100 text-gray-700'}`}>
                {LABELS[row.state] || row.state} {row.count}
              </span>
            ))
            : <span className="text-xs text-gray-500">尚未收到任何通知</span>}
        </div>
      )}
      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
          {items.map((item) => {
            const key = `${item.sheet_code}:${item.ragic_record_id}`;
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                <span className="text-gray-700" title={item.last_error_code || ''}>
                  {SHEET_NAMES[item.sheet_code] || item.sheet_code}（{item.sheet_code}）第 {item.ragic_record_id} 筆
                  {' · '}{LABELS[item.state] || item.state}{' · '}已試 {item.attempts}/{item.max_attempts} 次
                </span>
                {canRetry && ['retryable', 'blocked'].includes(item.state) && (
                  <button
                    type="button"
                    disabled={Boolean(busy) || Boolean(error)}
                    onClick={() => retry(item)}
                    className="min-h-11 rounded border border-gray-300 px-3 py-2 font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {busy === key ? '排入中…' : '重新排入'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

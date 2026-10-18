import React, { useEffect, useState } from 'react';
import { ragicStatusApi } from '../api/ragicStatus';
import { formatTWDateTime } from '../utils/format';
import { attemptOutcome } from '../utils/ragicStatusView.mjs';

const LABELS = { pending: '處理中', retryable: '等待重試', blocked: '需要人工處理', completed: '已完成' };
const TONE = {
  pending: 'bg-gray-100 text-gray-700',
  retryable: 'bg-amber-100 text-amber-800',
  blocked: 'bg-red-100 text-red-700',
  completed: 'bg-brand-green/15 text-brand-green',
};
const OUTCOME_TONE = {
  green: 'bg-brand-green/15 text-brand-green',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-700',
  gray: 'bg-gray-100 text-gray-600',
};
const SHEET_NAMES = { H01: '員工', H05: '場館', Z01: '家長', Z02: '學員' };

// Ragic Webhook：Ragic 資料一改就通知系統更新。這裡看兩件事——
//   最近收到的請求（含被拒的，分辨「Ragic 沒送」還是「送了被擋」）與處理結果（收件匣）。
// onSummary 把收件匣各狀態筆數、onAttempts 把最近的請求回報給頁面頂端的總覽／需要處理。
export default function WebhookInboxPanel({ canRetry, onSummary, onAttempts }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(null);
  const [attemptsError, setAttemptsError] = useState(false);
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
    try {
      const next = await ragicStatusApi.webhookAttempts();
      setAttempts(next);
      setAttemptsError(false);
      if (onAttempts) onAttempts(next.recent || []);
    } catch {
      setAttemptsError(true);
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
  const recent = attempts?.recent || [];
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold text-gray-800">即時通知（Ragic Webhook）</h2>
      <p className="mt-1 text-xs text-gray-500">
        Ragic 的資料一改就會通知系統更新。暫時失敗會自動重試；重試 8 次仍失敗的，修正資料或連線後按「重新排入」。
      </p>

      <h3 className="mt-3 text-xs font-bold text-gray-700">最近收到的請求</h3>
      {attemptsError ? (
        <p className="mt-1 text-xs text-gray-500">請求紀錄讀取失敗，請稍後重新整理。</p>
      ) : !attempts ? (
        <p className="mt-1 text-xs text-gray-500">讀取中…</p>
      ) : recent.length === 0 ? (
        <p className="mt-1 text-xs text-gray-500">
          還沒收到任何請求。如果剛在 Ragic 改過資料，代表 Ragic 沒有送出，請檢查 Ragic 表單的 Webhook 網址。
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-gray-100 border-y border-gray-100">
          {recent.map((a, i) => {
            const o = attemptOutcome(a.outcome);
            return (
              <li key={`${a.received_at}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs text-gray-600">
                <span>{formatTWDateTime(a.received_at)}</span>
                <span>{SHEET_NAMES[a.sheet_code] || a.sheet_code || '—'}（{a.sheet_code || '—'}）</span>
                <span className={`rounded px-2 py-0.5 font-bold ${OUTCOME_TONE[o.tone]}`}>{o.text}</span>
                {a.id_count ? <span>{a.id_count} 筆</span> : null}
                {o.rejected && a.content_type ? <span className="text-[11px] text-gray-400">格式：{a.content_type}</span> : null}
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="mt-3 text-xs font-bold text-gray-700">處理結果</h3>
      {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
      {!data && !error && <p className="mt-1 text-xs text-gray-500">讀取中…</p>}
      {data && (
        <div className="mt-1 flex flex-wrap gap-2">
          {summary.length
            ? summary.map((row) => (
              <span key={row.state} className={`rounded px-2 py-0.5 text-xs font-bold ${TONE[row.state] || 'bg-gray-100 text-gray-700'}`}>
                {LABELS[row.state] || row.state} {row.count}
              </span>
            ))
            : <span className="text-xs text-gray-500">還沒有需要處理的通知</span>}
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

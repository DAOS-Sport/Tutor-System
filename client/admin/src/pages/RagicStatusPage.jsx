import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { ragicStatusApi } from '../api/ragicStatus';

function fmtDate(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-TW', { hour12: false });
  } catch { return String(ts); }
}

function statusBadge(s) {
  const base = 'inline-block rounded px-2 py-0.5 text-xs font-bold';
  if (s === 'ok')      return <span className={`${base} bg-brand-green/15 text-brand-green`}>成功</span>;
  if (s === 'error')   return <span className={`${base} bg-red-100 text-red-700`}>失敗</span>;
  if (s === 'skipped') return <span className={`${base} bg-gray-200 text-gray-600`}>未執行</span>;
  return <span className={`${base} bg-gray-100 text-gray-500`}>—</span>;
}

function FormCard({ job, info, onSync, syncing, isAdmin, enabled }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-bold text-gray-800">{info.label}</div>
          <div className="mt-0.5 text-xs text-gray-500">form_code: {info.form_code}</div>
        </div>
        {statusBadge(info.last_status)}
      </div>
      <dl className="mt-3 space-y-1.5 text-xs">
        <div className="flex justify-between">
          <dt className="text-gray-500">最後一次執行</dt>
          <dd className="text-gray-800">
            {fmtDate(info.last_run_at)}
            {info.last_triggered_by ? <span className="ml-1 text-gray-400">({info.last_triggered_by})</span> : null}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">最後一次成功</dt>
          <dd className="text-gray-800">{fmtDate(info.last_success_at)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">最後成功筆數</dt>
          <dd className="text-gray-800">{info.last_count ?? '—'}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-500">耗時</dt>
          <dd className="text-gray-800">{info.last_duration_ms != null ? `${info.last_duration_ms} ms` : '—'}</dd>
        </div>
      </dl>
      {info.last_error ? (
        <div className="mt-2 rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">
          錯誤：{info.last_error}
        </div>
      ) : null}
      {isAdmin ? (
        <button
          type="button"
          disabled={syncing || !enabled}
          onClick={() => onSync(job)}
          title={!enabled ? 'Ragic 未設定，無法同步' : ''}
          className="mt-3 w-full rounded bg-brand-teal px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {syncing ? '同步中…' : '單獨同步此表'}
        </button>
      ) : null}
    </div>
  );
}

export default function RagicStatusPage() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null); // 'all' | 'staff' | 'coaches' | 'venues' | null

  async function load() {
    try {
      setData(await ragicStatusApi.get());
    } catch (e) {
      toast.error(e?.response?.data?.error || '載入失敗');
      setData({ enabled: false, env: {}, missing_env: [], forms: {} });
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSync(job) {
    setBusy(job);
    try {
      const r = await ragicStatusApi.sync(job);
      setData((prev) => ({ ...(prev || {}), forms: r.forms, now: new Date().toISOString() }));
      const lines = Object.entries(r.results).map(([k, v]) => {
        if (v.skipped) return `${k}: 略過`;
        if (v.error)   return `${k}: 失敗 (${v.error})`;
        return `${k}: ${v.synced ?? 0} 筆`;
      });
      toast.success(`同步完成 — ${lines.join('；')}`);
    } catch (e) {
      toast.error(e?.response?.data?.error || '同步失敗');
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <LoadingSpinner />;

  const env = data.env || {};
  const missing = data.missing_env || [];
  const forms = data.forms || {};

  return (
    <div>
      <PageHeader
        title="Ragic 連線狀態"
        description="檢視 H01 / H05 同步是否正常運作。Cron 每 10 分鐘自動同步一次；admin 也可手動立即同步。"
        actions={isAdmin ? (
          <button
            type="button"
            disabled={busy != null || !data.enabled}
            onClick={() => runSync('all')}
            className="rounded bg-brand-primary px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-brand-teal disabled:opacity-50"
          >
            {busy === 'all' ? '全部同步中…' : '立即同步全部'}
          </button>
        ) : null}
      />

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold text-gray-800">連線設定</div>
          {data.enabled
            ? <span className="rounded bg-brand-green/15 px-2 py-0.5 text-xs font-bold text-brand-green">已啟用</span>
            : <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">未啟用</span>}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          {Object.entries(env).map(([k, v]) => (
            <div key={k} className={`flex items-center justify-between rounded border px-2 py-1 ${v ? 'border-gray-200 text-gray-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
              <span className="font-mono">{k}</span>
              <span>{v ? '已設定' : '未設定'}</span>
            </div>
          ))}
        </div>
        {missing.length > 0 ? (
          <div className="mt-2 text-xs text-red-700">
            缺少：{missing.join(', ')} — 請在 Replit Secrets 補齊後重啟。
          </div>
        ) : null}
        <div className="mt-2 text-[11px] text-gray-500">
          Cron 排程：<span className="font-mono">{data.cron_schedule}</span>（每 10 分鐘）
          ・狀態抓取時間：{fmtDate(data.now)}
          {data.next_cron_run_at ? <> ・下次 cron 預定：{fmtDate(data.next_cron_run_at)}</> : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(forms).map(([job, info]) => (
          <FormCard
            key={job}
            job={job}
            info={info}
            onSync={runSync}
            syncing={busy === job || busy === 'all'}
            isAdmin={isAdmin}
            enabled={!!data.enabled}
          />
        ))}
      </div>

      <div className="mt-6 rounded-lg bg-gray-50 p-4 text-xs text-gray-600">
        <div className="font-bold text-gray-700">說明</div>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>「最後一次成功」是最近一筆 status=ok 的紀錄；「最後一次執行」可能是失敗或略過。</li>
          <li>H01 員工 / 教練 與 H05 場館為定期 bulk sync；Z01 家長 / Z02 學員為「按請求查詢」，本頁的同步動作會發一次健康檢查 ping 驗證端點可用。</li>
          <li>每次同步會寫一筆 <span className="font-mono">ragic_sync_log</span>，可由 SQL 查詢歷史趨勢。</li>
        </ul>
      </div>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { ragicStatusApi } from '../api/ragicStatus';

// Task #70 邊緣案例處理準則：
// skipAuthRedirect=true 讓 axios interceptor 不跳轉，改由頁面自己決定：
//   - HTTP 401 → 確認是 token 失效 → 呼叫 logout()，AuthContext 清狀態，RequireAuth 導回 /login
//   - HTTP 500 / timeout / 其他 → toast + 重試按鈕，不觸碰 session

function fmtDate(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-TW', { hour12: false });
  } catch { return String(ts); }
}

function statusBadge(s, inProgress) {
  const base = 'inline-block rounded px-2 py-0.5 text-xs font-bold';
  if (inProgress)      return <span className={`${base} bg-brand-teal/15 text-brand-teal`}>同步中…</span>;
  if (s === 'ok')      return <span className={`${base} bg-brand-green/15 text-brand-green`}>成功</span>;
  if (s === 'error')   return <span className={`${base} bg-red-100 text-red-700`}>失敗</span>;
  if (s === 'skipped') return <span className={`${base} bg-gray-200 text-gray-600`}>未執行</span>;
  return <span className={`${base} bg-gray-100 text-gray-500`}>—</span>;
}

function FormCard({ job, info, onSync, syncing, isAdmin, enabled }) {
  const inProgress = !!info.in_progress || syncing;
  // Task #94：kind 區分「全表 bulk sync」與「連線 ping (healthcheck)」。
  // 後者不會真的把 Ragic 全表寫進 staging—只是發一筆 where=eq 驗證端點，
  // 文案 / 按鈕 / 統計欄都要改才不會誤導 admin。
  const isPing = info.kind === 'healthcheck';
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <div className="text-sm font-bold text-gray-800">{info.label}</div>
            {isPing ? (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">健康檢查</span>
            ) : (
              <span className="rounded bg-brand-teal/15 px-1.5 py-0.5 text-[10px] font-bold text-brand-teal">全表同步</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">form_code: {info.form_code}</div>
        </div>
        {statusBadge(info.last_status, inProgress)}
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
          <dt className="text-gray-500">{isPing ? '上次回應筆數' : '最後成功筆數'}</dt>
          <dd className="text-gray-800">
            {info.last_count ?? '—'}
            {isPing ? <span className="ml-1 text-[10px] text-gray-400">(ping 通常 0)</span> : null}
          </dd>
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
          title={!enabled ? 'Ragic 未設定，無法觸發' : ''}
          className="mt-3 w-full rounded bg-brand-teal px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {syncing
            ? (isPing ? '檢查中…' : '同步中…')
            : (isPing ? '發送連線 Ping' : '單獨同步此表')}
        </button>
      ) : null}
    </div>
  );
}

// Task #70：載入失敗時顯示此元件，而非無限 spinner 或白屏
function LoadError({ onRetry }) {
  return (
    <div className="rounded-lg border border-dashed border-red-200 bg-red-50 p-8 text-center">
      <div className="text-sm font-bold text-red-700">無法取得 Ragic 連線狀態</div>
      <div className="mt-1 text-xs text-red-500">後端暫時無法回應，請稍後重試。</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded bg-brand-primary px-4 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
      >
        重新載入
      </button>
    </div>
  );
}

export default function RagicStatusPage() {
  const toast = useToast();
  const { isAdmin, logout } = useAuth();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);

  // Task #83：POST /sync 改 202 fire-and-forget，後端執行狀態由 GET status 的
  // forms[].in_progress 決定。前端不再用 local `busy` state 推導 spinner。
  async function load({ silent = false } = {}) {
    if (!silent) {
      setLoadError(false);
      setData(null);
    }
    try {
      const next = await ragicStatusApi.get();
      setData(next);
      setLoadError(false);
    } catch (e) {
      if (e?.response?.status === 401) {
        toast.error('登入逾期，請重新登入');
        logout();
        return;
      }
      if (!silent) {
        const msg = e?.response?.data?.error || e?.message || '載入失敗';
        toast.error(`Ragic 連線狀態：${msg}`);
        setLoadError(true);
      }
      // silent polling 失敗：保留舊資料，不打擾使用者
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Task #83：5 秒輪詢 — 任何一個 job in_progress 時持續刷新，
  // 完成後也再多 poll 一輪確保拿到 last_run_at / last_status 更新。
  const anyInProgress = !!data && Object.values(data.forms || {}).some((f) => f.in_progress);
  useEffect(() => {
    if (!data) return undefined;
    const id = setInterval(() => { load({ silent: true }); }, 5000);
    return () => clearInterval(id);
  }, [data == null, anyInProgress]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSync(job) {
    try {
      await ragicStatusApi.sync(job);
      toast.info(job === 'all' ? '已排入背景同步全部，狀態會自動更新…' : `已排入背景同步 ${job}…`);
      // 立刻 fetch 一次拿到 in_progress=true，後續由 5 秒 polling 接手
      load({ silent: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || '同步觸發失敗');
    }
  }

  if (!data && !loadError) return <LoadingSpinner />;

  if (loadError) {
    return (
      <div>
        <PageHeader title="Ragic 連線狀態" description="檢視 H01 / H05 同步是否正常運作。" />
        <LoadError onRetry={load} />
      </div>
    );
  }

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
            disabled={anyInProgress || !data.enabled}
            onClick={() => runSync('all')}
            className="rounded bg-brand-primary px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-brand-teal disabled:opacity-50"
          >
            {anyInProgress ? '同步中…' : '立即同步全部'}
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
            syncing={!!info.in_progress}
            isAdmin={isAdmin}
            enabled={!!data.enabled}
          />
        ))}
      </div>

      <div className="mt-6 rounded-lg bg-gray-50 p-4 text-xs text-gray-600">
        <div className="font-bold text-gray-700">說明</div>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>「最後一次成功」是最近一筆 status=ok 的紀錄；「最後一次執行」可能是失敗或略過。</li>
          <li>H01 員工（含教練 1:1 同步）與 H05 場館為定期 <span className="font-bold">全表同步</span>（差異會進待審核區）；Z01 家長 / Z02 學員為「按請求查詢」，本頁僅提供<span className="font-bold">健康檢查 Ping</span> 驗證端點可用，不會抓全表。</li>
          <li>每次執行會寫一筆 <span className="font-mono">ragic_sync_log</span>，可由 SQL 查詢歷史趨勢。</li>
        </ul>
      </div>
    </div>
  );
}

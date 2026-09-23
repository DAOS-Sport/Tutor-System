import { toUserMessage } from '../../../shared/userMessage.js';
import React, { useEffect, useRef, useState } from 'react';
import WebhookInboxPanel from '../components/WebhookInboxPanel';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { ragicStatusApi } from '../api/ragicStatus';
import { formatTWDateTime } from '../utils/format';
import { buildTimeline, jobState, reasonText, summarizeFailures } from '../utils/ragicStatusView.mjs';

// Task #70 邊緣案例處理準則：
// skipAuthRedirect=true 讓 axios interceptor 不跳轉，改由頁面自己決定：
//   - HTTP 401 → 確認是 token 失效 → 呼叫 logout()，AuthContext 清狀態，RequireAuth 導回 /login
//   - HTTP 500 / timeout / 其他 → toast + 重試按鈕，不觸碰 session

// 頁面結構（2026-09-23 整理）：總覽 → 需要處理 → 排程同步 → 即時通知 → 收合的連線檢查／說明／資料維護。
// 排程時間與名稱一律用後端 schedules（constants/ragicJobSchedules.js），前端不再寫死時間。

const PAGE_DESCRIPTION = '系統與 Ragic 之間的資料同步。多數在夜間自動執行；這裡看結果，必要時手動補跑。';

// 顯示順序＝夜間執行先後，只能手動的放最後；後端新增的工作會自動排在最後面。
const JOB_ORDER = ['backup', 'pull', 'quarantine', 'staff', 'venues', 'parents', 'students'];

const DIRECTION = {
  in:    { text: 'Ragic → 系統', cls: 'bg-sky-50 text-sky-700' },
  out:   { text: '系統 → Ragic', cls: 'bg-violet-50 text-violet-700' },
  check: { text: '檢查',         cls: 'bg-gray-100 text-gray-600' },
};

const TONE = {
  green: 'bg-brand-green/15 text-brand-green',
  amber: 'bg-amber-100 text-amber-800',
  red:   'bg-red-100 text-red-700',
  teal:  'bg-brand-teal/15 text-brand-teal',
  gray:  'bg-gray-100 text-gray-600',
};
const TEXT_TONE = {
  green: 'text-brand-green',
  amber: 'text-amber-700',
  red:   'text-red-700',
  teal:  'text-brand-teal',
  gray:  'text-gray-700',
};

function fmtDate(ts) {
  return ts ? formatTWDateTime(ts) : '—';
}

function Badge({ tone = 'gray', children }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${TONE[tone]}`}>
      {children}
    </span>
  );
}

function ToggleSwitch({ checked, disabled, onChange, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-brand-teal' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// 收合區塊的展開提示（summary 設成 flex 後瀏覽器原生的三角形會消失）
function Chevron() {
  return <span aria-hidden="true" className="text-gray-400 transition-transform group-open:rotate-180">▾</span>;
}

function SummaryTile({ title, tone, value, note }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="text-xs text-gray-500">{title}</div>
      <div className={`mt-1 text-base font-bold ${TEXT_TONE[tone] || TEXT_TONE.gray}`}>{value}</div>
      {note ? <div className="mt-0.5 text-[11px] text-gray-500">{note}</div> : null}
    </div>
  );
}

function JobRow({ job, info, schedule, issues, isAdmin, envEnabled, onSync, onToggle, toggling }) {
  const state = jobState(info, issues);
  const dir = DIRECTION[schedule?.direction] || DIRECTION.check;
  // 連線測試只對 Z01／Z02 各讀一筆，沒有「處理筆數」可言
  const isCheck = info.kind === 'healthcheck';
  const adminEnabled = info.admin_enabled !== false;
  const canRun = envEnabled && adminEnabled && !info.in_progress;
  const runCount = info.last_run_count ?? info.last_count;
  const runTitle = !envEnabled
    ? 'Ragic 設定不完整，無法執行'
    : (!adminEnabled ? '已暫停，請先打開開關' : '');
  return (
    <li className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-bold text-gray-800">{schedule?.name || info.label || job}</span>
          {schedule?.sheet ? <span className="text-[11px] text-gray-400">{schedule.sheet}</span> : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${dir.cls}`}>{dir.text}</span>
          <span>{schedule?.text || '—'}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 lg:w-72 lg:shrink-0">
        <Badge tone={state.tone}>{state.text}</Badge>
        <span>
          {fmtDate(info.last_run_at)}
          {info.last_triggered_by === 'manual' ? '（手動）' : ''}
        </span>
        {!isCheck && runCount != null ? <span>處理 {runCount} 筆</span> : null}
        {issues?.permanent ? <span className="font-bold text-amber-700">{issues.permanent} 筆待補</span> : null}
        {state.key !== 'ok' && info.last_success_at && info.last_success_at !== info.last_run_at ? (
          <span className="w-full text-[11px] text-gray-400">最後一次完全成功：{fmtDate(info.last_success_at)}</span>
        ) : null}
      </div>
      {isAdmin ? (
        <div className="flex items-center gap-3 lg:w-36 lg:shrink-0 lg:justify-end">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <ToggleSwitch
              checked={adminEnabled}
              disabled={toggling}
              onChange={(next) => onToggle(job, next)}
              title={adminEnabled ? '點擊暫停這一項（排程與補跑都會停）' : '點擊恢復'}
            />
            {adminEnabled ? '啟用' : '暫停'}
          </label>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => onSync(job)}
            title={runTitle}
            className="min-h-[44px] rounded border border-brand-teal px-3 text-xs font-bold text-brand-teal transition hover:bg-brand-teal hover:text-white disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0 md:py-1.5"
          >
            {info.in_progress ? '執行中…' : (isCheck ? '測試' : '補跑')}
          </button>
        </div>
      ) : null}
    </li>
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

function probeBadge(status) {
  if (status === 'ok') return <Badge tone="green">讀得到</Badge>;
  if (status === 'empty') return <Badge tone="amber">回 0 筆</Badge>;
  if (status === 'missing_env') return <Badge tone="red">缺設定</Badge>;
  if (status === 'skipped') return <Badge tone="gray">未檢查</Badge>;
  return <Badge tone="red">讀不到</Badge>;
}

function ConnectionDetails({ data }) {
  const probe = data.live_probe || {};
  const forms = Object.entries(probe.forms || {});
  const env = Object.entries(data.env || {});
  const missing = data.missing_env || [];
  const waiting = !!probe.pending && !probe.checked_at;
  const allGood = missing.length === 0 && !!probe.ok;
  const headline = missing.length
    ? `缺少 ${missing.length} 項設定`
    : (waiting ? '檢查中…' : (allGood ? `${forms.length} 張表單都讀得到` : '有表單讀不到'));
  return (
    <details className="group rounded-lg border border-gray-200 bg-white p-4 shadow-sm" open={!allGood && !waiting}>
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-2 md:min-h-0">
        <span className="text-sm font-bold text-gray-800">連線檢查</span>
        <span className="flex items-center gap-2 text-xs text-gray-500">{headline}<Chevron /></span>
      </summary>
      <div className="mt-3 space-y-3 text-xs">
        <p className="text-gray-500">直接向 Ragic 的各表單讀 1 筆，確認帳號與表單設定真的能用（每分鐘最多檢查一次）。</p>
        {probe.error ? (
          <div className="rounded bg-red-50 px-2 py-1.5 text-red-700">
            {toUserMessage(probe.error, '連線檢查失敗，請稍後重試。')}
          </div>
        ) : null}
        {forms.length ? (
          <ul className="divide-y divide-gray-100 rounded border border-gray-100">
            {forms.map(([key, item]) => (
              <li key={key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-gray-700">{item.label || key}</span>
                <span className="flex items-center gap-2">
                  {item.duration_ms != null ? <span className="text-gray-400">{item.duration_ms} ms</span> : null}
                  {probeBadge(item.status)}
                </span>
                {item.error ? <span className="w-full text-red-700">{item.error}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="text-gray-600">
          Ragic 設定：{env.length - missing.length}/{env.length} 項已設定
          {missing.length ? (
            <span className="text-red-700">；缺少 {missing.join('、')}，請在 Replit Secrets 補齊後重新發布。</span>
          ) : null}
        </div>
        <div className="text-[11px] text-gray-400">
          檢查時間：{fmtDate(probe.checked_at)}{probe.cached ? '（最近一次的結果）' : ''}
        </div>
      </div>
    </details>
  );
}

function HowItWorks({ schedules }) {
  const { daily, frequent } = buildTimeline(schedules);
  return (
    <details className="group rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-2 md:min-h-0">
        <span className="text-sm font-bold text-gray-800">說明：整晚的順序與名詞</span>
        <Chevron />
      </summary>
      <div className="mt-3 space-y-3 text-xs text-gray-600">
        {daily.length ? (
          <ol className="space-y-1">
            {daily.map((row) => (
              <li key={row.time}>
                <span className="mr-2 font-mono text-gray-800">{row.time}</span>
                {row.names.join('、')}
              </li>
            ))}
          </ol>
        ) : null}
        {frequent.map((s) => (
          <p key={s.key || s.name}>{s.name}：{s.text}</p>
        ))}
        <ul className="list-disc space-y-1 pl-4">
          <li>「部分完成」：大部分資料已經處理，只有個別資料有問題，不影響其他資料。</li>
          <li>「暫停」：這一項的排程與手動補跑都不會執行，直到重新打開。</li>
          <li>「立即同步全部」會依序把每一項跑一次，可能需要幾分鐘；執行中可以離開本頁。</li>
          <li>每次執行都有紀錄（ragic_sync_log），要查歷史可請工程協助。</li>
        </ul>
      </div>
    </details>
  );
}

export default function RagicStatusPage() {
  const toast = useToast();
  const { isAdmin, logout } = useAuth();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [failures, setFailures] = useState(null);
  const [failuresError, setFailuresError] = useState(false);
  const [inboxSummary, setInboxSummary] = useState(null);

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

  // 寫不進 Ragic 的資料統計（唯讀）；失敗不影響整頁，只在總覽顯示「讀取失敗」
  async function loadFailures() {
    try {
      setFailures(await ragicStatusApi.syncFailures(2));
      setFailuresError(false);
    } catch {
      setFailuresError(true);
    }
  }

  useEffect(() => { load(); loadFailures(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Task #83：5 秒輪詢 — 任何一個 job in_progress 時持續刷新，
  // 完成後也再多 poll 一輪確保拿到 last_run_at / last_status 更新。
  const anyInProgress = !!data && Object.values(data.forms || {}).some((f) => f.in_progress);
  useEffect(() => {
    if (!data) return undefined;
    const id = setInterval(() => { load({ silent: true }); }, 5000);
    return () => clearInterval(id);
  }, [data == null, anyInProgress]); // eslint-disable-line react-hooks/exhaustive-deps

  // 有工作剛跑完（執行中 → 結束）才重抓失敗統計，不跟著 5 秒輪詢一直查
  const wasInProgress = useRef(false);
  useEffect(() => {
    if (wasInProgress.current && !anyInProgress) loadFailures();
    wasInProgress.current = anyInProgress;
  }, [anyInProgress]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSync(job) {
    try {
      await ragicStatusApi.sync(job);
      toast.info(job === 'all' ? '已排入背景同步全部，狀態會自動更新…' : `已排入背景執行 ${job}…`);
      // 立刻 fetch 一次拿到 in_progress=true，後續由 5 秒 polling 接手
      load({ silent: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || '同步觸發失敗');
    }
  }

  const [purging, setPurging] = useState(false);
  async function runPurgeGhosts() {
    if (!window.confirm('確定要清除所有無 LINE UID 的 ghost 家長、Z03 佇列、quarantine 名單嗎？\n\n有業務紀錄（課程/報到）的記錄不會被刪除。\n\n此操作不可復原。')) return;
    setPurging(true);
    try {
      const result = await ragicStatusApi.purgeGhosts();
      toast.success(result.message || '清除完成');
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || '清除失敗');
    } finally {
      setPurging(false);
    }
  }

  const [togglingJob, setTogglingJob] = useState(null);
  async function runToggle(job, enabled) {
    setTogglingJob(job);
    try {
      const next = await ragicStatusApi.toggle(job, enabled);
      toast.info(enabled ? `已恢復 ${job}` : `已暫停 ${job}（排程與補跑都會停）`);
      setData((prev) => (prev ? { ...prev, forms: next.forms || prev.forms } : prev));
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || '開關切換失敗');
    } finally {
      setTogglingJob(null);
    }
  }

  if (!data && !loadError) return <LoadingSpinner />;

  if (loadError) {
    return (
      <div>
        <PageHeader title="Ragic 連線狀態" subtitle={PAGE_DESCRIPTION} />
        <LoadError onRetry={load} />
      </div>
    );
  }

  const forms = data.forms || {};
  const jobSchedules = data.schedules?.jobs || {};
  const missing = data.missing_env || [];
  const probe = data.live_probe || {};
  const issuesByJob = summarizeFailures(failures);
  const orderedJobs = [
    ...JOB_ORDER.filter((job) => forms[job]),
    ...Object.keys(forms).filter((job) => !JOB_ORDER.includes(job)),
  ].map((job) => ({ job, info: forms[job], schedule: jobSchedules[job], issues: issuesByJob[job] }));
  const withState = orderedJobs.map((row) => ({ ...row, state: jobState(row.info, row.issues) }));
  const nameOf = (row) => row.schedule?.name || row.info.label || row.job;

  // ── 總覽四格 ──
  const probeWaiting = !!probe.pending && !probe.checked_at;
  const badProbeForms = Object.values(probe.forms || {}).filter((f) => f.status && f.status !== 'ok');
  const connTile = missing.length
    ? { tone: 'red', value: `缺少 ${missing.length} 項設定`, note: '見下方「連線檢查」' }
    : probeWaiting
      ? { tone: 'gray', value: '檢查中…' }
      : probe.ok
        ? { tone: 'green', value: '正常', note: `${Object.keys(probe.forms || {}).length} 張表單都讀得到` }
        : { tone: 'amber', value: '有表單讀不到', note: '見下方「連線檢查」' };

  const errorJobs = withState.filter((r) => r.state.key === 'error');
  const partialJobs = withState.filter((r) => r.state.key === 'partial');
  const latestRun = withState
    .filter((r) => r.schedule?.cron && r.info.last_run_at)
    .map((r) => r.info.last_run_at)
    .sort()
    .pop();
  const jobsTile = errorJobs.length
    ? { tone: 'red', value: `${errorJobs.length} 項失敗` }
    : partialJobs.length
      ? { tone: 'amber', value: `${partialJobs.length} 項部分完成` }
      : { tone: 'green', value: '正常' };
  jobsTile.note = `最近一次執行：${fmtDate(latestRun)}`;

  const permanentTotal = Object.values(issuesByJob).reduce((sum, v) => sum + v.permanent, 0);
  const dataTile = failuresError
    ? { tone: 'gray', value: '讀取失敗', note: '稍後重新整理' }
    : !failures
      ? { tone: 'gray', value: '讀取中…' }
      : permanentTotal
        ? { tone: 'amber', value: `${permanentTotal} 筆`, note: '寫不進 Ragic，要修正資料本身' }
        : { tone: 'green', value: '沒有', note: '近兩天沒有寫不進去的資料' };

  const inboxCount = (state) => (inboxSummary || []).find((r) => r.state === state)?.count || 0;
  const webhookTile = inboxSummary == null
    ? { tone: 'gray', value: '讀取中…' }
    : inboxCount('blocked')
      ? { tone: 'red', value: `${inboxCount('blocked')} 筆要人工處理` }
      : inboxCount('retryable')
        ? { tone: 'amber', value: `${inboxCount('retryable')} 筆等待重試` }
        : {
          tone: 'green',
          value: '正常',
          note: inboxCount('completed') ? `已處理 ${inboxCount('completed')} 筆` : '尚未收到通知',
        };

  // ── 需要處理（白話＋下一步）──
  const attention = [];
  if (missing.length) {
    attention.push({ tone: 'red', text: `缺少 Ragic 設定：${missing.join('、')}。請在 Replit Secrets 補齊後重新發布。` });
  }
  for (const r of errorJobs) {
    attention.push({
      tone: 'red',
      text: `${nameOf(r)}上次執行失敗（${fmtDate(r.info.last_run_at)}）：${toUserMessage(r.info.last_error, '同步未完成，請確認必要資料是否齊全；若持續失敗，請聯絡管理員。')}`,
    });
  }
  for (const r of partialJobs) {
    const reasons = r.issues.reasons.map((x) => `${reasonText(x.code)} ${x.count} 筆`).join('；');
    const runCount = r.info.last_run_count ?? r.info.last_count;
    attention.push({
      tone: 'amber',
      text: `${nameOf(r)}：${r.issues.permanent} 筆資料寫不進 Ragic —— ${reasons}。其他資料照常處理${runCount != null ? `（上次處理 ${runCount} 筆）` : ''}。`,
    });
  }
  for (const r of withState) {
    if (/^unmatched_staff_warning=/.test(r.info.last_error || '')) {
      attention.push({ tone: 'amber', text: `${nameOf(r)}：部分員工尚未對應，請核對員工資料；其他資料同步不受影響。` });
    }
  }
  if (inboxCount('blocked')) {
    attention.push({ tone: 'red', text: `${inboxCount('blocked')} 筆 Ragic 即時通知需要人工處理，見下方「即時通知」。` });
  }
  if (!missing.length && !probeWaiting && !probe.ok && badProbeForms.length) {
    attention.push({
      tone: 'amber',
      text: `${badProbeForms.map((f) => f.label).join('、')}讀不到資料，見下方「連線檢查」。`,
    });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ragic 連線狀態"
        subtitle={PAGE_DESCRIPTION}
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

      {data.simulated && (
        <div role="alert" className="rounded-lg border-2 border-red-500 bg-red-50 p-3 text-sm font-bold text-red-700">
          ⚠️ SIMULATED — 本頁為模擬（mock）資料，非真實 Ragic 同步狀態；下方綠燈不代表已同步。
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryTile title="連線" {...connTile} />
        <SummaryTile title="排程同步" {...jobsTile} />
        <SummaryTile title="資料待補" {...dataTile} />
        <SummaryTile title="即時通知" {...webhookTile} />
      </div>

      {attention.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-bold text-amber-900">需要處理</h2>
          <ul className="mt-2 space-y-1.5 text-xs">
            {attention.map((item, i) => (
              <li key={i} className={`flex gap-2 ${item.tone === 'red' ? 'text-red-700' : 'text-amber-900'}`}>
                <span aria-hidden="true">•</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-gray-200 bg-white px-4 pt-4 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-bold text-gray-800">排程同步</h2>
          <span className="text-[11px] text-gray-500">依夜間執行順序排列；時間為台灣時間</span>
        </div>
        <ul className="mt-1 divide-y divide-gray-100">
          {withState.map((row) => (
            <JobRow
              key={row.job}
              job={row.job}
              info={row.info}
              schedule={row.schedule}
              issues={row.issues}
              isAdmin={isAdmin}
              envEnabled={!!data.enabled}
              onSync={runSync}
              onToggle={runToggle}
              toggling={togglingJob === row.job}
            />
          ))}
        </ul>
      </section>

      <WebhookInboxPanel canRetry={isAdmin} onSummary={setInboxSummary} />

      <ConnectionDetails data={data} />

      <HowItWorks schedules={data.schedules} />

      {isAdmin && (
        <details className="group rounded-lg border border-red-200 bg-red-50 p-4">
          <summary className="flex min-h-[44px] cursor-pointer items-center justify-between gap-2 md:min-h-0">
            <span className="text-sm font-bold text-red-700">資料維護（危險操作）</span>
            <Chevron />
          </summary>
          <p className="mb-3 mt-3 text-xs text-red-600">
            清除所有「無 LINE UID」的 ghost 家長記錄、Z03 待處理佇列、quarantine 名單。
            有業務紀錄（課程 / 報到 / 轉讓）的記錄不受影響。此操作不可復原，請確認後再執行。
          </p>
          <button
            type="button"
            disabled={purging}
            onClick={runPurgeGhosts}
            className="rounded bg-red-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-50"
          >
            {purging ? '清除中…' : '清除錯誤載入資料（Ghost / Z03 / Quarantine）'}
          </button>
        </details>
      )}
    </div>
  );
}

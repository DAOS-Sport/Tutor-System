import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { adminReportsApi } from '../api/reports';
import { venuesApi } from '../api/venues';
import { staffApi } from '../api/staff';
import { rowsToCsv, downloadCsv } from '../utils/csvExport';

const TABS = [
  { key: 'revenue',     label: '營收報表' },
  { key: 'sessions',    label: '堂數使用' },
  { key: 'discounts',   label: '優惠折抵' },
  { key: 'mgm',         label: 'MGM 漏斗' },
  { key: 'learning',    label: '學習履行率' },
];

function defaultRange() {
  const to = new Date().toISOString().slice(0, 10);
  const d = new Date(); d.setDate(d.getDate() - 30);
  return { from: d.toISOString().slice(0, 10), to };
}

export default function ReportsPage() {
  const toast = useToast();
  const [tab, setTab] = useState('revenue');
  const [range, setRange] = useState(defaultRange());
  const [venueId, setVenueId] = useState('');
  const [coachId, setCoachId] = useState('');
  const [data, setData] = useState(null);
  const [venues, setVenues] = useState([]);
  const [coaches, setCoaches] = useState([]);

  useEffect(() => {
    venuesApi.list().then((r) => setVenues(r || [])).catch(() => setVenues([]));
    staffApi.list().then((r) => setCoaches((r || []).filter((s) => s.role === 'coach' || s.is_coach)))
      .catch(() => setCoaches([]));
  }, []);

  useEffect(() => {
    setData(null);
    const fn = ({
      revenue: adminReportsApi.revenue,
      sessions: adminReportsApi.sessions,
      discounts: adminReportsApi.discounts,
      mgm: adminReportsApi.mgmConversion,
      learning: adminReportsApi.learningCompletion,
    })[tab];
    const params = { ...range };
    if (venueId) params.venueId = venueId;
    if (coachId) params.coachId = coachId;
    fn(params).then(setData).catch((e) => {
      setData({ rows: [] });
      toast.error(e?.response?.data?.error || '報表載入失敗');
    });
  }, [tab, range.from, range.to, venueId, coachId]); // eslint-disable-line

  function exportCsv() {
    if (!data) return;
    const meta = TABLES[tab];
    const headers = meta.headers;
    const rows = (tab === 'mgm' ? mgmRows(data) : (data.rows || [])).map(meta.row);
    const suffix = [venueId && `v${venueId}`, coachId && `c${coachId.slice(0,6)}`].filter(Boolean).join('_');
    downloadCsv(
      `report_${tab}_${range.from}_${range.to}${suffix ? '_' + suffix : ''}.csv`,
      rowsToCsv(headers, rows)
    );
  }

  return (
    <div>
      <PageHeader title="營運報表 (F-M01)" subtitle="可依日期 / 場館 / 教練篩選；支援 CSV 匯出" />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${
              tab === t.key ? 'bg-brand-primary text-white' : 'bg-gray-100 text-gray-600'
            }`}>{t.label}</button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <input type="date" value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
          className="rounded border border-gray-300 px-2 py-1" />
        <span>～</span>
        <input type="date" value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
          className="rounded border border-gray-300 px-2 py-1" />
        <select value={venueId} onChange={(e) => setVenueId(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1">
          <option value="">全部場館</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
        </select>
        <select value={coachId} onChange={(e) => setCoachId(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1">
          <option value="">全部教練</option>
          {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={exportCsv} disabled={!data}
          className="ml-auto rounded bg-brand-teal px-3 py-1 font-bold text-white disabled:opacity-50">
          匯出 CSV
        </button>
      </div>

      {data === null ? <LoadingSpinner label="載入報表中…" />
        : tab === 'mgm' ? <MgmView d={data} /> : <TableView meta={TABLES[tab]} rows={data.rows || []} />}
    </div>
  );
}

const TABLES = {
  revenue: {
    headers: ['場館', '教練', '組別', '期數', '原價總計', '應收總計'],
    cols: [
      { k: 'venue_id' }, { k: 'coach_name' }, { k: 'course_type', fmt: (v) => `1對${v}` },
      { k: 'period_count' }, { k: 'original_total', fmt: (v) => `$ ${Number(v).toLocaleString()}` },
      { k: 'final_total', fmt: (v) => `$ ${Number(v).toLocaleString()}` },
    ],
    row: (r) => [r.venue_id, r.coach_name, `1對${r.course_type}`, r.period_count, r.original_total, r.final_total],
  },
  sessions: {
    headers: ['場館', '教練', '已使用', '剩餘', '已過期', '本期新增'],
    cols: [
      { k: 'venue_id' }, { k: 'coach_name' }, { k: 'used' },
      { k: 'remaining' }, { k: 'expired' }, { k: 'new_this_period' },
    ],
    row: (r) => [r.venue_id, r.coach_name, r.used, r.remaining, r.expired, r.new_this_period],
  },
  discounts: {
    headers: ['優惠名稱', '代碼', '類型', '使用次數', '折抵總計', '原價總計', '應收總計'],
    cols: [
      { k: 'name' }, { k: 'coupon_code', fmt: (v) => v || '—' }, { k: 'type' },
      { k: 'use_count' },
      { k: 'discount_total', fmt: (v) => `$ ${Number(v).toLocaleString()}` },
      { k: 'original_total', fmt: (v) => `$ ${Number(v).toLocaleString()}` },
      { k: 'final_total',    fmt: (v) => `$ ${Number(v).toLocaleString()}` },
    ],
    row: (r) => [r.name, r.coupon_code || '', r.type, r.use_count, r.discount_total, r.original_total, r.final_total],
  },
  learning: {
    headers: ['資深教練', '期數', '已發布規劃', '排定堂數', '已送出記錄', '規劃率%', '記錄率%'],
    cols: [
      { k: 'coach_name' }, { k: 'periods' }, { k: 'plans_published' },
      { k: 'sessions_count' }, { k: 'records_submitted' },
      { k: 'plan_rate' }, { k: 'record_rate' },
    ],
    row: (r) => [r.coach_name, r.periods, r.plans_published, r.sessions_count, r.records_submitted, r.plan_rate, r.record_rate],
  },
};

function TableView({ meta, rows }) {
  if (rows.length === 0) {
    return <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">區間內無資料</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>{meta.headers.map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-100">
              {meta.cols.map((c, j) => (
                <td key={j} className="px-3 py-2">{c.fmt ? c.fmt(r[c.k]) : (r[c.k] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MgmView({ d }) {
  const k = d.kpis || {}; const c = d.conversion || {};
  const cards = [
    { label: '推薦連結建立', value: k.total_links, suffix: '組' },
    { label: '受邀者註冊', value: k.registered, rate: c.register_rate, base: '/ 連結' },
    { label: '完成體驗付款', value: k.trial_paid, rate: c.trial_rate, base: '/ 註冊' },
    { label: '體驗課簽到', value: k.checked_in, rate: c.checkin_rate, base: '/ 付款' },
    { label: '獎勵已發放', value: k.rewarded, rate: c.reward_rate, base: '/ 簽到' },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {cards.map((cd, i) => (
        <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">{cd.label}</div>
          <div className="mt-1 text-2xl font-bold text-brand-primary">{cd.value || 0}</div>
          {cd.rate !== undefined && (
            <div className="mt-1 text-xs text-brand-green">{cd.rate}% {cd.base}</div>
          )}
          {cd.suffix && <div className="mt-1 text-xs text-gray-400">{cd.suffix}</div>}
        </div>
      ))}
    </div>
  );
}

function mgmRows(d) {
  const k = d.kpis || {}; const c = d.conversion || {};
  return [
    { stage: '推薦連結建立', count: k.total_links, rate: '—' },
    { stage: '受邀者註冊',   count: k.registered, rate: `${c.register_rate}%` },
    { stage: '完成體驗付款', count: k.trial_paid, rate: `${c.trial_rate}%` },
    { stage: '體驗課簽到',   count: k.checked_in, rate: `${c.checkin_rate}%` },
    { stage: '獎勵已發放',   count: k.rewarded,   rate: `${c.reward_rate}%` },
  ];
}
TABLES.mgm = {
  headers: ['階段', '數量', '轉換率'],
  cols: [{ k: 'stage' }, { k: 'count' }, { k: 'rate' }],
  row: (r) => [r.stage, r.count, r.rate],
};

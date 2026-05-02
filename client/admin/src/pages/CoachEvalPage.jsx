import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { adminEvalApi } from '../api/learn';

const METRIC_LABEL = { avg_overall: '整體', avg_teaching: '教學' };

function StarBar({ value }) {
  const v = Number(value) || 0;
  const pct = Math.max(0, Math.min(100, (v / 5) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-16 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-brand-green" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-600">{v ? v.toFixed(2) : '—'}</span>
    </div>
  );
}

export default function CoachEvalPage() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [report, setReport] = useState(null);

  useEffect(() => {
    adminEvalApi.listCoaches()
      .then((r) => setList(Array.isArray(r) ? r : []))
      .catch((e) => { setList([]); toast.error(e?.response?.data?.error || e.message); });
  }, []); // eslint-disable-line

  function openCoach(c) {
    setActiveId(c.id); setReport(null);
    adminEvalApi.coachReport(c.id)
      .then(setReport)
      .catch((e) => toast.error(e?.response?.data?.error || e.message));
  }

  if (!list) return <div className="p-6"><LoadingSpinner /></div>;

  const active = activeId ? list.find((x) => x.id === activeId) : null;

  return (
    <div className="p-6">
      <PageHeader title="教練考核報表" subtitle="F-M09 / 期末評鑑彙總、月趨勢、家長評語" />

      <section className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-bold text-brand-primary">教練總覽</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-gray-500">
                <tr><th className="py-2">教練</th><th>件數</th><th>整體</th><th>教學</th><th>續報</th><th>狀態</th></tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className={`border-t ${activeId === c.id ? 'bg-brand-primary/5' : ''}`}>
                    <td className="py-2"><button onClick={() => openCoach(c)} className="font-bold text-brand-primary hover:underline">{c.name}</button>
                      {c.is_senior && <span className="ml-1 rounded bg-brand-gold/15 px-1.5 py-0.5 text-[10px] font-bold text-brand-gold">資深</span>}
                    </td>
                    <td>{c.n}</td>
                    <td><StarBar value={c.avg_overall} /></td>
                    <td><StarBar value={c.avg_teaching} /></td>
                    <td className="text-xs">{c.renew_rate != null ? `${Math.round(c.renew_rate * 100)}%` : '—'}</td>
                    <td>
                      {c.failed_metrics?.length
                        ? <StatusBadge tone="orange" label={`不達標 ${c.failed_metrics.length}`} />
                        : c.n === 0
                          ? <StatusBadge tone="teal" label="無資料" />
                          : <StatusBadge tone="green" label="達標" />}
                    </td>
                  </tr>
                ))}
                {list.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-xs text-gray-400">尚無教練資料</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          {!active && <p className="text-sm text-gray-500">點擊左側教練查看詳細報表。</p>}
          {active && !report && <LoadingSpinner />}
          {active && report && (
            <div>
              <h3 className="mb-3 text-sm font-bold text-brand-primary">{active.name} · 詳細報表</h3>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Metric title="件數" value={report.summary?.n ?? 0} />
                <Metric title="整體 (avg)" value={report.summary?.avg_overall ?? '—'} />
                <Metric title="教學 (avg)" value={report.summary?.avg_teaching ?? '—'} />
                <Metric title="續報率" value={report.summary?.renew_rate != null ? `${Math.round(report.summary.renew_rate * 100)}%` : '—'} />
              </div>

              <h4 className="mt-4 text-xs font-bold text-gray-700">月度趨勢</h4>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-gray-500"><tr><th className="py-1">月份</th><th>件數</th><th>整體</th><th>教學</th></tr></thead>
                  <tbody>
                    {report.monthly?.map((m) => (
                      <tr key={m.month} className="border-t">
                        <td className="py-1">{m.month}</td>
                        <td>{m.n}</td>
                        <td>{m.avg_overall ?? '—'}</td>
                        <td>{m.avg_teaching ?? '—'}</td>
                      </tr>
                    ))}
                    {(!report.monthly || report.monthly.length === 0) &&
                      <tr><td colSpan={4} className="py-2 text-center text-gray-400">尚無資料</td></tr>}
                  </tbody>
                </table>
              </div>

              <h4 className="mt-4 text-xs font-bold text-gray-700">最新評語</h4>
              <ul className="mt-1 max-h-64 space-y-2 overflow-y-auto pr-1">
                {report.comments?.map((c) => (
                  <li key={c.id} className="rounded bg-gray-50 p-2 text-xs">
                    <div className="flex justify-between text-gray-500">
                      <span>★ {c.score_overall} · 續報：{c.renew_intent}</span>
                      <span>{new Date(c.submitted_at).toLocaleDateString()}</span>
                    </div>
                    <p className="mt-1 text-gray-800">{c.comment}</p>
                  </li>
                ))}
                {(!report.comments || report.comments.length === 0) &&
                  <li className="text-xs text-gray-400">尚無評語</li>}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ title, value }) {
  return (
    <div className="rounded bg-brand-primary/5 p-2 text-center">
      <div className="text-[10px] text-gray-500">{title}</div>
      <div className="text-base font-bold text-brand-primary">{value}</div>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { historyApi } from '../api/learn';
import { formatTWDate } from '../utils/format';

function Field({ title, body }) {
  if (!body) return null;
  return (
    <div className="mt-2">
      <div className="text-[11px] font-bold text-brand-primary">{title}</div>
      <p className="whitespace-pre-wrap text-sm text-gray-800">{body}</p>
    </div>
  );
}

export default function LearningHistoryPage() {
  const { periodId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    historyApi.byPeriod(periodId)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e?.response?.status === 403 ? '此課程不屬於您' : '載入失敗'));
    return () => { alive = false; };
  }, [periodId]);

  if (error) {
    return (
      <div className="px-4 py-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">{error}</div>
        <button onClick={() => navigate(-1)} className="mt-4 w-full rounded-lg bg-brand-primary py-3 text-sm font-bold text-white">返回</button>
      </div>
    );
  }
  if (!data) return <div className="px-4 py-6"><LoadingSpinner label="載入中…" /></div>;

  const { plan, records } = data;

  return (
    <div className="px-4 py-4 print:py-2">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-brand-teal active:opacity-60 print:hidden">‹ 返回</button>

      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-brand-primary">學習歷程</h1>
          <p className="mt-1 text-xs text-gray-500">F-S06 / 點右側按鈕可列印或匯出 PDF</p>
        </div>
        <button onClick={() => window.print()} className="rounded-full bg-brand-primary/10 px-3 py-1.5 text-xs font-bold text-brand-primary print:hidden">列印</button>
      </header>

      {plan ? (
        <section className="rounded-2xl border border-brand-primary/15 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-bold text-brand-primary">課前規劃</h2>
          <Field title="本期學習目標" body={plan.goals} />
          <Field title="預期成果" body={plan.expected_outcomes} />
          <Field title="訓練規劃" body={plan.learning_plan} />
          <Field title="初評" body={plan.initial_assessment} />
          <Field title="備註" body={plan.notes} />
          <p className="mt-3 text-[10px] text-gray-400">發佈於 {plan.published_at ? formatTWDate(new Date(plan.published_at)) : '—'}</p>
        </section>
      ) : (
        <section className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-sm text-gray-500">
          教練尚未發佈課前規劃
        </section>
      )}

      <section className="mt-4">
        <h2 className="mb-2 text-sm font-bold text-brand-primary">授課記錄</h2>
        {records.length === 0 && (
          <p className="rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-sm text-gray-500">
            尚無已發佈的授課記錄
          </p>
        )}
        <ul className="space-y-3">
          {records.map((r, idx) => (
            <li key={r.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm break-inside-avoid">
              <div className="flex items-center justify-between">
                <div className="text-sm font-bold text-brand-primary">第 {idx + 1} 堂 · {formatTWDate(new Date(r.scheduled_at))}</div>
                <span className="rounded-full bg-brand-green/15 px-2 py-0.5 text-[10px] font-bold text-brand-green">已發佈</span>
              </div>
              <Field title="上課摘要" body={r.summary} />
              <Field title="表現亮點" body={r.highlights} />
              <Field title="待加強" body={r.improvements} />
              <Field title="回家練習" body={r.homework} />
              {r.tags?.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-1 text-[11px]">
                  {r.tags.map((t) => (
                    <span key={t} className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-brand-teal">#{t}</span>
                  ))}
                </p>
              )}
              {r.media?.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs print:hidden">
                  {r.media.map((m, i) => (
                    <li key={i}>
                      <a href={m.url} target="_blank" rel="noreferrer" className="text-brand-teal underline">{m.name || m.url.slice(-30)}</a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

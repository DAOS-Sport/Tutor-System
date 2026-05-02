import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { adminEvalApi } from '../api/learn';

const METRIC_LABELS = {
  avg_overall: '整體評分平均',
  avg_teaching: '教學評分平均',
  avg_attitude: '態度評分平均',
  avg_progress: '進步幅度平均',
  renew_rate: '續報率（0-1）',
};

export default function EvalThresholdPage() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [draft, setDraft] = useState({});

  function reload() {
    setList(null);
    adminEvalApi.thresholds()
      .then((r) => { setList(Array.isArray(r) ? r : []); setDraft({}); })
      .catch((e) => { setList([]); toast.error(e?.response?.data?.error || e.message); });
  }
  useEffect(reload, []); // eslint-disable-line

  function setField(metric, field, value) {
    setDraft((d) => ({ ...d, [metric]: { ...(d[metric] || {}), [field]: value } }));
  }

  async function save(metric) {
    const base = list.find((x) => x.metric === metric);
    const merged = { ...base, ...(draft[metric] || {}) };
    try {
      await adminEvalApi.upsertThreshold({
        metric,
        min_value: Number(merged.min_value),
        window_months: Number(merged.window_months) || 3,
        is_active: !!merged.is_active,
      });
      toast.success('已儲存'); reload();
    } catch (e) { toast.error(e?.response?.data?.error || '儲存失敗'); }
  }

  if (!list) return <div className="p-6"><LoadingSpinner /></div>;

  return (
    <div className="p-6">
      <PageHeader title="考核門檻設定" subtitle="F-A09 / 不達標教練在 F-M09 報表中以橘色標示" />

      <section className="mt-4 max-w-3xl rounded-2xl border border-brand-primary/15 bg-white p-4">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-gray-500">
            <tr>
              <th className="py-2">指標</th>
              <th>最低值</th>
              <th>觀察月數</th>
              <th>啟用</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const d = draft[t.metric] || {};
              const v = (k) => (d[k] !== undefined ? d[k] : t[k]);
              return (
                <tr key={t.metric} className="border-t">
                  <td className="py-2">
                    <div className="font-bold text-brand-primary">{METRIC_LABELS[t.metric] || t.metric}</div>
                    <div className="text-[10px] text-gray-500">{t.metric}</div>
                  </td>
                  <td>
                    <input type="number" step="0.01" min="0" max="5"
                      value={v('min_value')}
                      onChange={(e) => setField(t.metric, 'min_value', e.target.value)}
                      className="w-24 rounded border px-2 py-1 text-sm" />
                  </td>
                  <td>
                    <input type="number" min="1" max="24"
                      value={v('window_months')}
                      onChange={(e) => setField(t.metric, 'window_months', e.target.value)}
                      className="w-20 rounded border px-2 py-1 text-sm" />
                  </td>
                  <td>
                    <input type="checkbox" checked={!!v('is_active')}
                      onChange={(e) => setField(t.metric, 'is_active', e.target.checked)} />
                  </td>
                  <td>
                    <button onClick={() => save(t.metric)}
                      className="rounded bg-brand-teal px-3 py-1 text-xs font-bold text-white">儲存</button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr><td colSpan={5} className="py-4 text-center text-xs text-gray-400">尚無門檻資料</td></tr>
            )}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-gray-500">
          指標說明：avg_overall / avg_teaching / avg_attitude / avg_progress 為 1-5 星平均；
          renew_rate 為續報率（0-1，已填寫意願者中選「願意」之比例）。
        </p>
      </section>
    </div>
  );
}

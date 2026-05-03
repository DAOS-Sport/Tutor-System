import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { coachesApi } from '../api/coaches';
import { venuesApi } from '../api/venues';

const MULTIPLIER_MIN = 1.00;
const MULTIPLIER_MAX = 1.50;

const INTRO_TONE = {
  draft: 'gray', pending: 'gold', published: 'green', rejected: 'red',
};
const INTRO_LABEL = {
  draft: '草稿', pending: '送審中', published: '已發佈', rejected: '已退件',
};

export default function CoachesPage() {
  const toast = useToast();
  const [coaches, setCoaches] = useState(null);
  const [venues, setVenues] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([coachesApi.list(), venuesApi.list()])
      .then(([c, v]) => {
        setCoaches(c);
        setVenues(v);
      })
      .catch((err) => {
        console.error('[CoachesPage] load failed:', err);
        toast.error('載入教練資料失敗，請重新整理');
        setCoaches([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const venueMap = useMemo(
    () => Object.fromEntries(venues.map((v) => [v.id, v.name])),
    [venues]
  );

  if (!coaches) return <LoadingSpinner fullPage />;

  function startEdit(row) {
    setEditing({
      ...row,
      pricing_multiplier: Number(row.pricing_multiplier).toFixed(2),
      specialties_text: (row.specialties || []).join('、'),
      venue_ids: [...(row.venue_ids || [])],
    });
  }

  function toggleVenue(vid) {
    setEditing((e) => {
      const set = new Set(e.venue_ids);
      if (set.has(vid)) set.delete(vid); else set.add(vid);
      return { ...e, venue_ids: Array.from(set) };
    });
  }

  async function saveEdit() {
    if (!editing) return;
    const m = Number(editing.pricing_multiplier);
    if (Number.isNaN(m) || m < MULTIPLIER_MIN || m > MULTIPLIER_MAX) {
      toast.error(`修課係數需介於 ${MULTIPLIER_MIN.toFixed(2)} – ${MULTIPLIER_MAX.toFixed(2)}`);
      return;
    }
    const specialties = editing.specialties_text
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      const patch = {
        email: editing.email || '',
        is_senior: !!editing.is_senior,
        pricing_multiplier: m,
        specialties,
        bio_rich_text: editing.bio_rich_text || '',
        is_active: !!editing.is_active,
        venue_ids: editing.venue_ids || [],
      };
      const res = await coachesApi.update(editing.id, patch);
      setCoaches((arr) => arr.map((x) => (x.id === res.id ? res : x)));
      toast.success(`已更新 ${res.name}`);
      setEditing(null);
    } catch {
      toast.error('更新失敗');
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: 'name', label: '姓名', render: (r) => (
        <div>
          <div className="font-medium">{r.name}</div>
          <div className="text-xs text-gray-400">{r.ragic_employee_id}</div>
        </div>
      ) },
    { key: 'phone', label: '聯絡電話' },
    { key: 'email', label: 'Email', render: (r) => r.email || <span className="text-gray-300">—</span> },
    { key: 'is_senior', label: '資深', className: 'text-center',
      render: (r) => r.is_senior
        ? <StatusBadge tone="gold">資深</StatusBadge>
        : <span className="text-gray-300">—</span> },
    { key: 'pricing_multiplier', label: '修課係數', className: 'text-right',
      render: (r) => <span className="font-mono">{Number(r.pricing_multiplier).toFixed(2)}</span> },
    { key: 'venue_ids', label: '可教場館',
      render: (r) => (r.venue_ids || []).length === 0
        ? <span className="text-gray-300">—</span>
        : <span className="text-xs">{(r.venue_ids || []).map((v) => venueMap[v] || v).join('、')}</span> },
    { key: 'line_bound', label: 'LINE',
      render: (r) => r.line_bound
        ? <StatusBadge tone="green">已綁</StatusBadge>
        : <StatusBadge tone="gray">未綁</StatusBadge> },
    { key: 'intro_review_status', label: '簡介',
      render: (r) => <StatusBadge tone={INTRO_TONE[r.intro_review_status] || 'gray'}>
        {INTRO_LABEL[r.intro_review_status] || r.intro_review_status}
      </StatusBadge> },
    { key: 'is_active', label: '在職',
      render: (r) => r.is_active
        ? <StatusBadge tone="green">在職</StatusBadge>
        : <StatusBadge tone="gray">離職</StatusBadge> },
    { key: 'actions', label: '操作', className: 'text-right',
      render: (r) => (
        <button className="text-xs font-medium text-brand-teal hover:underline"
          onClick={() => startEdit(r)}>編輯</button>
      ) },
  ];

  return (
    <div>
      <PageHeader
        title="教練資料 (F-C-Admin)"
        subtitle="從 Ragic H01 (在職 + 應徵職務含「教練」) 自動同步；可調整資深旗標、修課係數、專長、簡介與可教場館"
      />
      <DataTable columns={columns} rows={coaches} rowKey={(r) => r.id} />

      {editing && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => e.target === e.currentTarget && setEditing(null)}
          role="dialog" aria-modal="true" aria-label="編輯教練"
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-1 text-lg font-bold text-brand-primary">
              編輯教練 — {editing.name}
            </h3>
            <p className="mb-4 text-xs text-gray-500">
              工號 {editing.ragic_employee_id} · 姓名/電話來自 Ragic，無法在後台改
            </p>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">姓名</label>
                  <input value={editing.name} disabled
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-500" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">電話</label>
                  <input value={editing.phone} disabled
                    className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-gray-500" />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                <input type="email" value={editing.email || ''}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!editing.is_senior}
                  onChange={(e) => setEditing({ ...editing, is_senior: e.target.checked })} />
                <span>資深教練（可建立學習歷程，會顯示金色徽章）</span>
              </label>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  修課係數（{MULTIPLIER_MIN.toFixed(2)} – {MULTIPLIER_MAX.toFixed(2)}）
                </label>
                <input type="number" step="0.01"
                  min={MULTIPLIER_MIN} max={MULTIPLIER_MAX}
                  value={editing.pricing_multiplier}
                  onChange={(e) => setEditing({ ...editing, pricing_multiplier: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2" />
                <p className="mt-1 text-xs text-gray-500">資深 1.30 ~ 1.50；一般 1.00 ~ 1.20</p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  專長（用「、」或半形逗號分隔）
                </label>
                <input value={editing.specialties_text}
                  onChange={(e) => setEditing({ ...editing, specialties_text: e.target.value })}
                  placeholder="例如：基礎技巧、體能訓練、青少年班"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">教練簡介</label>
                <textarea rows={4}
                  value={editing.bio_rich_text || ''}
                  onChange={(e) => setEditing({ ...editing, bio_rich_text: e.target.value })}
                  placeholder="顯示在 LIFF 教練詳情頁的自我介紹"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2" />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  可教場館（複選）
                </label>
                <div className="flex flex-wrap gap-2">
                  {venues.length === 0 && (
                    <span className="text-xs text-gray-400">沒有可指派的場館</span>
                  )}
                  {venues.map((v) => {
                    const selected = (editing.venue_ids || []).includes(v.id);
                    return (
                      <button key={v.id} type="button"
                        onClick={() => toggleVenue(v.id)}
                        className={`rounded-full border px-3 py-1 text-sm transition ${
                          selected
                            ? 'border-brand-teal bg-brand-teal text-white'
                            : 'border-gray-300 bg-white text-gray-700 hover:border-brand-teal'
                        }`}>
                        {v.name}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Ragic H01 沒有「教練可教場館」欄位，請手動勾選
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!editing.is_active}
                  onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} />
                <span>在職中（取消勾選 = 軟下架，LIFF 不再顯示此教練）</span>
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button onClick={() => setEditing(null)} disabled={busy}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                取消
              </button>
              <button onClick={saveEdit} disabled={busy}
                className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50">
                {busy ? '儲存中…' : '儲存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

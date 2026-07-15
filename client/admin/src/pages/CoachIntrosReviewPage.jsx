import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { adminIntrosApi } from '../api/learn';
import { formatTWDateTime } from '../utils/format';

const STATUS_TONE = {
  draft: 'gold', pending_review: 'amber', published: 'green', rejected: 'error',
};
const STATUS_LABEL = {
  draft: '草稿', pending_review: '待審', published: '已上架', rejected: '退回',
};

export default function CoachIntrosReviewPage() {
  const toast = useToast();
  const [filter, setFilter] = useState('pending_review');
  const [allList, setAllList] = useState(null);
  const [busyId, setBusyId] = useState(null);

  // 一次抓全部狀態，分頁切換前端過濾，讓每個分頁都能顯示正確筆數
  function reload() {
    setAllList(null);
    adminIntrosApi.list('all')
      .then((r) => setAllList(Array.isArray(r) ? r : []))
      .catch((e) => { setAllList([]); toast.error(e?.response?.data?.error || e.message); });
  }
  useEffect(reload, []); // eslint-disable-line

  const counts = useMemo(() => {
    const c = { all: 0, pending_review: 0, rejected: 0, published: 0, draft: 0 };
    if (Array.isArray(allList)) {
      c.all = allList.length;
      for (const r of allList) c[r.intro_review_status] = (c[r.intro_review_status] || 0) + 1;
    }
    return c;
  }, [allList]);

  const list = useMemo(() => {
    if (!Array.isArray(allList)) return null;
    return filter === 'all' ? allList : allList.filter((c) => c.intro_review_status === filter);
  }, [allList, filter]);

  async function approve(c) {
    setBusyId(c.id);
    try { await adminIntrosApi.approve(c.id); toast.success(`已上架：${c.name}`); reload(); }
    catch (e) { toast.error(e?.response?.data?.error || '上架失敗'); }
    finally { setBusyId(null); }
  }

  async function reject(c) {
    const note = prompt(`退回「${c.name}」的原因：`);
    if (!note || !note.trim()) return;
    setBusyId(c.id);
    try { await adminIntrosApi.reject(c.id, note.trim()); toast.success('已退回'); reload(); }
    catch (e) { toast.error(e?.response?.data?.error || '退回失敗'); }
    finally { setBusyId(null); }
  }

  return (
    <div className="p-6">
      <PageHeader title="教練特色專區審核" subtitle="F-C06 / 教練編輯送審 → 主管核可後上架" />

      <div className="mt-3 mb-4 inline-flex gap-2 rounded-full border border-gray-200 bg-white p-1 text-xs">
        {[['all', '全部'], ['pending_review', '待審'], ['rejected', '已退回'], ['published', '已上架']].map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)}
            className={`rounded-full px-3 py-1 ${filter === v ? 'bg-brand-primary text-white' : 'text-gray-600'}`}>
            {l}（{Array.isArray(allList) ? (v === 'all' ? counts.all : counts[v] || 0) : '…'}）
          </button>
        ))}
      </div>

      {!list && <LoadingSpinner />}
      {list && list.length === 0 && <p className="text-sm text-gray-500">目前沒有符合條件的教練。</p>}

      <ul className="space-y-3">
        {list?.map((c) => (
          <li key={c.id} className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-brand-primary">{c.name}</h3>
                <p className="mt-0.5 text-xs text-gray-500">{c.phone}</p>
              </div>
              <StatusBadge tone={STATUS_TONE[c.intro_review_status] || 'teal'}>{STATUS_LABEL[c.intro_review_status] || c.intro_review_status}</StatusBadge>
            </div>

            <div className="mt-2 max-h-40 overflow-y-auto rounded bg-gray-50 p-3 text-sm text-gray-800 whitespace-pre-wrap">
              {c.bio_rich_text || <span className="text-gray-400">（教練尚未填寫介紹）</span>}
            </div>

            {Array.isArray(c.media) && c.media.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {c.media.map((m, i) => (
                  <a key={i} href={m.url} target="_blank" rel="noreferrer"
                     className="rounded border border-gray-200 px-2 py-1 text-[10px] text-gray-600 hover:bg-gray-50">
                    [{m.type}] {m.alt || m.url.slice(-20)}
                  </a>
                ))}
              </div>
            )}

            {c.intro_review_note && (
              <p className="mt-2 rounded bg-orange-50 p-2 text-xs text-orange-700">退回原因：{c.intro_review_note}</p>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-500">
              <span>送審於（台北時間）：{c.intro_submitted_at ? formatTWDateTime(c.intro_submitted_at) : '—'} · 審核於：{c.intro_reviewed_at ? formatTWDateTime(c.intro_reviewed_at) : '—'}</span>
              {c.intro_review_status === 'pending_review' && (
                <div className="flex gap-2">
                  <button disabled={busyId === c.id} onClick={() => reject(c)}
                    className="rounded border border-orange-400 px-3 py-1 text-xs font-bold text-orange-600 disabled:opacity-50">退回</button>
                  <button disabled={busyId === c.id} onClick={() => approve(c)}
                    className="rounded bg-brand-green px-3 py-1 text-xs font-bold text-white disabled:opacity-50">上架</button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

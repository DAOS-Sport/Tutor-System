import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { groupOrdersApi } from '../api/groupOrders';
import { courseTypeLabel } from '../utils/format';

/**
 * 「未完成團報」橫幅（4.8：新增未完成訂單列表）。
 * 彙整家長端兩種「未完成」狀態，提供續辦入口，避免家長操作中斷後找不到、重複建立：
 *   1) 草稿（draft）：開了發起頁、填到一半但尚未建立 → 可「繼續填寫」。
 *   2) 進行中團報：status = forming（揪團中）/ submitted（審核中）→ 可「查看 / 繼續」。
 * 沒有任何未完成項目時不顯示（回傳 null）。
 */
const STATUS_LABEL = {
  forming: '揪團中',
  submitted: '審核中',
};

function draftHasContent(d) {
  if (!d) return false;
  return (
    (Array.isArray(d.student_ids) && d.student_ids.length > 0) ||
    (Array.isArray(d.new_students) && d.new_students.some((s) => String(s?.name || '').trim())) ||
    !!d.proof_url ||
    !!d.note
  );
}

function draftResumeQuery(d) {
  const q = new URLSearchParams();
  if (d.venue_id) q.set('venue', d.venue_id);
  if (d.coach_id) q.set('coach', d.coach_id);
  q.set('courseType', String(d.course_type || 2));
  return q.toString();
}

export default function IncompleteGroupOrdersBanner() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(null);
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([groupOrdersApi.getDraft(), groupOrdersApi.mine()])
      .then(([draftRes, mineRes]) => {
        if (!alive) return;
        const d = draftRes.status === 'fulfilled' ? draftRes.value?.draft : null;
        setDraft(draftHasContent(d) ? d : null);
        const list = mineRes.status === 'fulfilled' && Array.isArray(mineRes.value) ? mineRes.value : [];
        setOrders(list.filter((o) => o.status === 'forming' || o.status === 'submitted'));
      })
      .catch(() => { /* 載入失敗不影響首頁其餘內容 */ });
    return () => { alive = false; };
  }, []);

  if (!draft && orders.length === 0) return null;

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-sm font-bold text-brand-primary">📝 未完成的團報</h3>
      <div className="space-y-2">
        {draft && (
          <button
            type="button"
            onClick={() => navigate(`/group/new?${draftResumeQuery(draft)}`)}
            className="flex w-full items-center justify-between rounded-xl border border-brand-gold/40 bg-brand-gold/5 px-3 py-2.5 text-left active:opacity-80"
          >
            <div className="min-w-0">
              <div className="text-sm font-bold text-brand-gold">
                {courseTypeLabel(draft.course_type || 2)} 團報・尚未建立
              </div>
              <div className="mt-0.5 text-[11px] text-gray-500">填到一半的內容已暫存，點此繼續填寫</div>
            </div>
            <span className="shrink-0 text-brand-gold">›</span>
          </button>
        )}
        {orders.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => navigate(`/group/${o.id}`)}
            className="flex w-full items-center justify-between rounded-xl border border-brand-teal/30 bg-brand-teal/5 px-3 py-2.5 text-left active:opacity-80"
          >
            <div className="min-w-0">
              <div className="text-sm font-bold text-brand-teal">
                {courseTypeLabel(o.course_type)} 團報・{STATUS_LABEL[o.status] || o.status}
              </div>
              <div className="mt-0.5 text-[11px] text-gray-500">
                目前 {o.total_students} 人{o.is_leader ? '（您是團主）' : ''}・點此查看
              </div>
            </div>
            <span className="shrink-0 text-brand-teal">›</span>
          </button>
        ))}
      </div>
    </section>
  );
}

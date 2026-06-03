import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRoomForPeriod } from '../api/chat';
import { coursesApi } from '../api/courses';
import { groupOrdersApi } from '../api/groupOrders';
import CourseCard from '../components/CourseCard';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

// 三分頁（learning-focused）：
//  - active：進行中（預設）→ lifecycle === 'active'
//  - purchased：購買的課程 → lifecycle in ('active','completed')
//  - todo：還未完成 → lifecycle === 'pending_payment' 的報名 + 進行中的團報（forming/submitted）
// 'closed'（取消/退費）不出現在任何分頁。
const TABS = [
  { key: 'active', label: '進行中' },
  { key: 'purchased', label: '購買的課程' },
  { key: 'todo', label: '還未完成' },
];

// 團報「進行中」狀態（沿用 IncompleteGroupOrdersBanner 的呈現）。
const GROUP_STATUS_LABEL = {
  forming: '揪團中',
  submitted: '審核中',
};

export default function MyCoursesPage() {
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();
  const [courses, setCourses] = useState(null);
  const [groupOrders, setGroupOrders] = useState([]);
  const [tab, setTab] = useState('active');
  const [loadError, setLoadError] = useState(null);
  const [openingRoomId, setOpeningRoomId] = useState(null);

  function load() {
    setLoadError(null);
    setCourses(null);
    setGroupOrders([]);
    let alive = true;
    Promise.allSettled([coursesApi.myCourses(parent.id), groupOrdersApi.mine()])
      .then(([coursesRes, groupRes]) => {
        if (!alive) return;
        if (coursesRes.status === 'fulfilled') {
          setCourses(coursesRes.value || []);
        } else {
          setLoadError('課程資料載入失敗');
          toast.error('課程資料載入失敗');
        }
        const list = groupRes.status === 'fulfilled' && Array.isArray(groupRes.value) ? groupRes.value : [];
        setGroupOrders(list.filter((o) => o.status === 'forming' || o.status === 'submitted'));
      });
    return () => {
      alive = false;
    };
  }

  useEffect(() => {
    return load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent.id]);

  // 各分頁的報名卡片資料來源。
  const activeCourses = useMemo(
    () => (courses || []).filter((c) => c.lifecycle === 'active'),
    [courses],
  );
  const purchasedCourses = useMemo(
    () => (courses || []).filter((c) => c.lifecycle === 'active' || c.lifecycle === 'completed'),
    [courses],
  );
  const pendingCourses = useMemo(
    () => (courses || []).filter((c) => c.lifecycle === 'pending_payment'),
    [courses],
  );

  // 分頁計數：進行中／購買／還未完成（待處理報名 + 進行中團報）。
  const counts = useMemo(() => ({
    active: activeCourses.length,
    purchased: purchasedCourses.length,
    todo: pendingCourses.length + groupOrders.length,
  }), [activeCourses, purchasedCourses, pendingCourses, groupOrders]);

  async function openRoomForCourse(cp) {
    if (!cp.course_period_id || openingRoomId) return;
    setOpeningRoomId(cp.course_period_id);
    try {
      const r = await getRoomForPeriod(cp.course_period_id);
      if (!r?.room_id) throw new Error('聊天室尚未建立');
      navigate(`/chat/${r.room_id}`);
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || '開啟聊天室失敗');
    } finally {
      setOpeningRoomId(null);
    }
  }

  // 卡片點擊導航：
  //  - active / completed → 課程詳情頁 /course/:id
  //  - pending_payment 且為團報共享報名（有 group_order_id）→ 團購狀態頁 /group/:id
  //  - 其餘 pending_payment → 報名狀態頁 /enroll-status/:id
  function navigateForCard(cp) {
    if (cp.lifecycle === 'active' || cp.lifecycle === 'completed') {
      navigate(`/course/${cp.id}`);
      return;
    }
    if (cp.group_order_id) {
      navigate(`/group/${cp.group_order_id}`);
      return;
    }
    navigate(`/enroll-status/${cp.id}`);
  }

  function renderCourseCard(cp) {
    return (
      <CourseCard
        key={cp.id}
        variant="period"
        period={cp}
        onClick={() => navigateForCard(cp)}
        actions={cp.lifecycle === 'active'
          ? (cp.course_period_id ? [
            {
              label: openingRoomId === cp.course_period_id ? '開啟中…' : '約時間',
              primary: true,
              disabled: openingRoomId === cp.course_period_id,
              onClick: () => openRoomForCourse(cp),
            },
            { label: '選可用時段', onClick: () => navigate(`/book-slot/${cp.course_period_id}`) },
          ] : [
            { label: '等待對帳完成', primary: true, disabled: true, onClick: () => {} },
          ])
          : []}
      />
    );
  }

  const loading = courses === null && !loadError;

  return (
    <div className="px-4 py-4">
      <h1 className="mb-3 text-base font-bold text-brand-primary">我的課程</h1>

      <div className="mb-4 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              tab === t.key
                ? 'border-brand-primary bg-brand-primary text-white'
                : 'border-gray-200 bg-white text-gray-600'
            }`}
          >
            {t.label}（{counts[t.key]}）
          </button>
        ))}
      </div>

      {loadError ? (
        <div className="rounded-2xl border-2 border-dashed border-brand-error/40 bg-white px-6 py-10 text-center">
          <div className="mb-3 text-sm text-brand-error">{loadError}</div>
          <button
            type="button"
            onClick={load}
            className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
          >
            重新載入
          </button>
        </div>
      ) : loading ? (
        <LoadingSpinner label="載入課程中…" />
      ) : tab === 'active' ? (
        activeCourses.length === 0 ? (
          <EmptyState
            emoji="📚"
            title="目前沒有進行中的課程，挑個教練開始上課吧"
          />
        ) : (
          <div className="space-y-3">{activeCourses.map(renderCourseCard)}</div>
        )
      ) : tab === 'purchased' ? (
        purchasedCourses.length === 0 ? (
          <EmptyState emoji="📚" title="還沒有購買的課程" />
        ) : (
          <div className="space-y-3">{purchasedCourses.map(renderCourseCard)}</div>
        )
      ) : (
        // tab === 'todo'：待處理報名 + 進行中團報
        pendingCourses.length === 0 && groupOrders.length === 0 ? (
          <EmptyState emoji="🎉" title="沒有待處理的項目 🎉" />
        ) : (
          <div className="space-y-3">
            {pendingCourses.map(renderCourseCard)}
            {groupOrders.map((o) => (
              <GroupOrderCard key={`g-${o.id}`} order={o} onClick={() => navigate(`/group/${o.id}`)} />
            ))}
          </div>
        )
      )}
    </div>
  );
}

// 團報進度卡片（沿用 IncompleteGroupOrdersBanner 的呈現），點擊進入團購狀態頁。
function GroupOrderCard({ order, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-2xl border border-brand-teal/30 bg-brand-teal/5 px-4 py-3 text-left shadow-sm active:opacity-80"
    >
      <div className="min-w-0">
        <div className="text-sm font-bold text-brand-teal">
          {courseTypeLabel(order.course_type)} 團報・{GROUP_STATUS_LABEL[order.status] || order.status}
        </div>
        <div className="mt-0.5 text-[11px] text-gray-500">
          目前 {order.total_students} 人{order.is_leader ? '（您是團主）' : ''}・點此查看
        </div>
      </div>
      <span className="shrink-0 text-brand-teal">›</span>
    </button>
  );
}

function EmptyState({ emoji = '📚', title }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <div className="mb-3 text-3xl">{emoji}</div>
      <h3 className="text-sm font-bold text-gray-700">{title}</h3>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { coursesApi } from '../api/courses';
import { groupOrdersApi } from '../api/groupOrders';
import { checkoutApi } from '../api/checkout';
import CourseCard from '../components/CourseCard';
import LoadingSpinner from '../components/LoadingSpinner';
import PaymentDisclaimerModal from '../components/PaymentDisclaimerModal';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

// 三分頁：
//  - all：全部（預設）→ lifecycle !== 'closed' 的報名 + 可見團報
//  - active：進行中 → lifecycle === 'active'
//  - review：待審核 → lifecycle === 'pending_payment'（待對帳）的報名 + 揪團中/審核中團報（forming/submitted）
// 'closed'（取消/退費）不出現在任何分頁。
const TABS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '進行中' },
  { key: 'review', label: '待審核' },
];

// 團報「進行中」狀態（沿用 IncompleteGroupOrdersBanner 的呈現）。
const GROUP_STATUS_LABEL = {
  forming: '揪團中',
  submitted: '審核中',
  approved: '已核准・對帳中',
};

export default function MyCoursesPage() {
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();
  const [courses, setCourses] = useState(null);
  const [groupOrders, setGroupOrders] = useState([]);
  const [tab, setTab] = useState('all');
  const [loadError, setLoadError] = useState(null);
  const [cancellingId, setCancellingId] = useState(null);
  const [resolvingPaymentId, setResolvingPaymentId] = useState(null);
  const [paymentTarget, setPaymentTarget] = useState('');

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
        setGroupOrders(list.filter((o) => ['forming', 'submitted', 'approved'].includes(o.status)));
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
  const allCourses = useMemo(
    () => (courses || []).filter((c) => c.lifecycle !== 'closed'),
    [courses],
  );
  const activeCourses = useMemo(
    () => (courses || []).filter((c) => c.lifecycle === 'active'),
    [courses],
  );
  const pendingCourses = useMemo(
    () => (courses || []).filter((c) => c.lifecycle === 'pending_payment'),
    [courses],
  );
  const visibleGroupOrders = useMemo(() => {
    const representedGroupIds = new Set((courses || []).map((c) => c.group_order_id).filter(Boolean));
    return groupOrders.filter((o) => !representedGroupIds.has(o.id));
  }, [groupOrders, courses]);
  // 待審核分頁只收「揪團中／審核中」團報（approved＝已過審・對帳中，不算待審核）。
  const reviewGroupOrders = useMemo(
    () => visibleGroupOrders.filter((o) => ['forming', 'submitted'].includes(o.status)),
    [visibleGroupOrders],
  );

  // 分頁計數：全部／進行中／待審核。
  const counts = useMemo(() => ({
    all: allCourses.length + visibleGroupOrders.length,
    active: activeCourses.length,
    review: pendingCourses.length + reviewGroupOrders.length,
  }), [allCourses, activeCourses, pendingCourses, visibleGroupOrders, reviewGroupOrders]);

  async function openPaymentTarget(cp) {
    if (!cp) return;
    if (cp.checkout_id) {
      setPaymentTarget(`/checkout/${cp.checkout_id}`);
      return;
    }
    if (cp.group_order_id) {
      navigate(`/group/${cp.group_order_id}`);
      return;
    }
    if (!cp.enrollment_batch_id) {
      toast.error('此報名缺少付款單資料，請聯繫櫃檯');
      return;
    }
    setResolvingPaymentId(cp.id);
    try {
      const route = await checkoutApi.route({ enrollment_batch_id: cp.enrollment_batch_id });
      const checkoutId = route?.data?.checkout_id || route?.checkout_id || route?.route_instruction?.checkout_id;
      if (!checkoutId) throw new Error('missing checkout id');
      setPaymentTarget(`/checkout/${checkoutId}`);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '付款單導向失敗，請聯繫櫃檯');
    } finally {
      setResolvingPaymentId(null);
    }
  }

  // 卡片點擊導航：
  //  - active / completed → 課程詳情頁 /course/:id
  //  - pending_payment → checkout 母單付款；缺 checkout_id 時嘗試用 enrollment_batch_id 修復
  //  - pending_payment 且為團報共享報名（有 group_order_id）→ 團購狀態頁 /group/:id
  async function navigateForCard(cp) {
    if (cp.lifecycle === 'active' || cp.lifecycle === 'completed') {
      navigate(`/course/${cp.id}`);
      return;
    }
    if (cp.lifecycle === 'pending_payment') {
      await openPaymentTarget(cp);
      return;
    }
    if (cp.group_order_id) {
      navigate(`/group/${cp.group_order_id}`);
      return;
    }
    if (cp.checkout_id) navigate(`/checkout/${cp.checkout_id}`);
  }

  async function cancelPendingCourse(cp) {
    if (!cp?.id || cancellingId) return;
    const ok = window.confirm('確定取消這筆未完成報名？取消後若要上課需重新報名。');
    if (!ok) return;
    setCancellingId(cp.id);
    try {
      if (cp.is_checkout_aggregate && cp.checkout_id) {
        await checkoutApi.cancel(cp.checkout_id);
      } else if (cp.is_checkout_aggregate && Array.isArray(cp.sub_order_ids) && cp.sub_order_ids.length) {
        await Promise.all(cp.sub_order_ids.map((id) => coursesApi.cancelPending(id)));
      } else {
        await coursesApi.cancelPending(cp.id);
      }
      toast.success('已取消未完成報名');
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '取消失敗');
    } finally {
      setCancellingId(null);
    }
  }

  function renderCourseCard(cp) {
    // 已填末 5 碼＋已上傳匯款證明＝付款資料已送出（與 EnrollStatusPage 的鎖定條件一致，用 AND）。
    // 待櫃檯對帳期間（lifecycle 仍為 pending_payment）按鈕改顯示「已上傳，待櫃檯確認」，
    // 不再重複顯示「上傳付款資料」，避免家長誤以為要再次上傳。團報付款走另一條流程，不套用。
    const paymentSubmitted = !cp.group_order_id && !!cp.payment_proof_url && !!cp.transfer_last_5;
    const actions = cp.lifecycle === 'active'
      ? (cp.course_period_id ? [
        // 聯繫教練：依需求改為停用（灰掉、不可點）。
        { label: '聯繫教練', primary: true, disabled: true, onClick: () => {} },
        { label: '預約劃課', onClick: () => navigate(`/book-slot/${cp.course_period_id}`) },
        // 上課簽到：橘底黑字，進入該期六堂逐堂視圖（上課記錄頁，預選此期）。
        { label: '上課簽到', tone: 'accent', onClick: () => navigate(`/my-lessons?period=${cp.course_period_id}`) },
      ] : [
        { label: '課程開通處理中', primary: true, disabled: true, onClick: () => {} },
      ])
      : (cp.lifecycle === 'pending_payment' ? [
        cp.group_order_id
          ? { label: '查看團購狀態', primary: true, onClick: () => navigateForCard(cp) }
          : (paymentSubmitted
            ? { label: '已上傳，待櫃檯確認', primary: true, disabled: true, onClick: () => {} }
            : {
              label: resolvingPaymentId === cp.id ? '付款單確認中…' : '上傳付款資料',
              primary: true,
              disabled: resolvingPaymentId === cp.id,
              onClick: () => navigateForCard(cp),
            }),
        ...(cp.group_order_id ? [] : [{
          label: cancellingId === cp.id ? '取消中…' : '取消訂單',
          disabled: cancellingId === cp.id,
          onClick: () => cancelPendingCourse(cp),
        }]),
      ] : []);

    // 進行中課程：卡片本體不再導向詳細頁（/course/:id），改由下方三個按鈕操作；
    // 其餘狀態（已結束無按鈕、待處理）保留點卡片進入對應頁面，避免無路可點。
    return (
      <CourseCard
        key={cp.id}
        variant="period"
        period={cp}
        onClick={cp.lifecycle === 'active' ? undefined : () => navigateForCard(cp)}
        actions={actions}
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
      ) : tab === 'all' ? (
        allCourses.length === 0 && visibleGroupOrders.length === 0 ? (
          <EmptyState
            emoji="📚"
            title="還沒有任何課程，挑個教練開始上課吧"
            ctaLabel="去挑教練報名"
            onCta={() => navigate('/venue')}
          />
        ) : (
          <div className="space-y-3">
            {allCourses.map(renderCourseCard)}
            {visibleGroupOrders.map((o) => (
              <GroupOrderCard key={`g-${o.id}`} order={o} onClick={() => navigate(`/group/${o.id}`)} />
            ))}
          </div>
        )
      ) : tab === 'active' ? (
        activeCourses.length === 0 ? (
          <EmptyState
            emoji="📚"
            title="目前沒有進行中的課程，挑個教練開始上課吧"
            ctaLabel="去挑教練報名"
            onCta={() => navigate('/venue')}
          />
        ) : (
          <div className="space-y-3">{activeCourses.map(renderCourseCard)}</div>
        )
      ) : (
        // tab === 'review'：待對帳報名 + 揪團中/審核中團報
        pendingCourses.length === 0 && reviewGroupOrders.length === 0 ? (
          <EmptyState emoji="🎉" title="沒有待審核的項目 🎉" />
        ) : (
          <div className="space-y-3">
            {pendingCourses.map(renderCourseCard)}
            {reviewGroupOrders.map((o) => (
              <GroupOrderCard key={`g-${o.id}`} order={o} onClick={() => navigate(`/group/${o.id}`)} />
            ))}
          </div>
        )
      )}
      <PaymentDisclaimerModal
        open={!!paymentTarget}
        onAgree={() => {
          const target = paymentTarget;
          setPaymentTarget('');
          if (target) navigate(target);
        }}
        onCancel={() => setPaymentTarget('')}
      />
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

function EmptyState({ emoji = '📚', title, ctaLabel, onCta }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <div className="mb-3 text-3xl">{emoji}</div>
      <h3 className="text-sm font-bold text-gray-700">{title}</h3>
      {ctaLabel && onCta && (
        <button
          type="button"
          onClick={onCta}
          className="mt-4 rounded-lg bg-brand-primary px-5 py-2.5 text-sm font-bold text-white active:bg-brand-teal"
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}

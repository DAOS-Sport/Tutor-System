import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import StudentMultiSelect from '../components/enroll/StudentMultiSelect';
import PriceBreakdown from '../components/enroll/PriceBreakdown';
import ErrorBlock from '../components/enroll/ErrorBlock';
import useEnrollmentBoot from '../hooks/useEnrollmentBoot';
import useEnrollmentPricing from '../hooks/useEnrollmentPricing';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export default function EnrollmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();

  const venueId = params.get('venue');
  const initialCourseType = Number(params.get('courseType') || 1);
  const coachId = params.get('coach');

  // 組別由顧客在首頁「商品」選好後帶進來（?courseType=N），報名頁不再重複讓人選，避免誤導。
  const [courseType] = useState(initialCourseType);
  const [periodCount, setPeriodCount] = useState(1);
  const [selectedSelfStudents, setSelectedSelfStudents] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [activeCoupon, setActiveCoupon] = useState('');

  // 推薦折扣（TRIAL50）已停用（2026-07 全站優惠清除）：不再自動套用 pendingCoupon，
  // 並主動清掉既有使用者瀏覽器內殘留的 daos.pendingCoupon，避免套到已刪除的券而報「折價券無效」。
  useEffect(() => {
    try { localStorage.removeItem('daos.pendingCoupon'); } catch { /* noop */ }
  }, []);

  const onBootError = useCallback((m) => toast.error(m), [toast]);
  const { bootData, bootError } = useEnrollmentBoot({
    coachId, venueId, courseType, onError: onBootError,
  });

  // 切換組別時重置學員選擇
  useEffect(() => {
    setSelectedSelfStudents([]);
  }, [courseType]);

  // 1對N 須剛好湊滿 N 位（min=max=courseType）；同組多家庭請改走團購（GroupCreate）。
  const maxStudents = courseType;
  const minStudents = courseType;
  const totalSelected = selectedSelfStudents.length;
  const pricingStudentCount = Math.max(totalSelected, minStudents);

  const pricing = useEnrollmentPricing(bootData, {
    courseType,
    venueId,
    couponCode: activeCoupon || undefined,
    studentCount: pricingStudentCount,
    periodCount,
  });

  if (bootError) return <ErrorBlock message={bootError} onBack={() => navigate('/', { replace: true })} />;
  if (!bootData || !pricing) return <LoadingSpinner fullPage label="載入課程資訊…" />;
  if (!bootData.coach || !bootData.venue) {
    return <ErrorBlock message="找不到此教練或場館" onBack={() => navigate('/', { replace: true })} />;
  }

  const { coach, venue } = bootData;

  // U4：移除「帶出他人學員」流程後，報名只能選自己名下的學員（同組改走 U5–U8 團購）。
  const allSelectedStudents = selectedSelfStudents
    .map((sid) => {
      const s = parent.students.find((x) => x.id === sid);
      return s ? { ...s, _ownerName: parent.name } : null;
    })
    .filter(Boolean);
  // 防 stale ID：所有勾選 ID 都要解析得到，否則送出鈕不亮
  const selectionResolved = allSelectedStudents.length === selectedSelfStudents.length;

  // 須湊滿該組別人數（1v1=1、1v2=2、1v3=3），且只能用自己名下的學員。
  // 付款資料在訂單成立後才填，讓一般報名與團報到尾端才分岔。
  const canSubmit =
    totalSelected >= minStudents &&
    totalSelected <= maxStudents &&
    selectionResolved &&
    !submitting &&
    !pricing.previewLoading &&
    !pricing.previewError;

  function toggleSelf(sid) {
    setSelectedSelfStudents((prev) => {
      if (prev.includes(sid)) return prev.filter((x) => x !== sid);
      if (prev.length >= maxStudents) {
        toast.warning(`此組別最多選 ${maxStudents} 位學員`);
        return prev;
      }
      return [...prev, sid];
    });
  }

  async function handleConfirmSubmit() {
    setSubmitting(true);
    try {
      const result = await enrollmentsApi.create({
        parent_id: parent.id,
        parent_name: parent.name,
        parent_phone: parent.phone,
        coach: { id: coach.id, name: coach.name, is_senior: coach.is_senior },
        venue: { id: venue.id, name: venue.name },
        course_type: courseType,
        period_count: periodCount,
        students: allSelectedStudents.map((s) => ({ id: s.id, name: s.name })),
        original_price: pricing.subtotal,
        final_price: pricing.final,
        promotion: pricing.promo
          ? { id: pricing.promo.id, discount: pricing.discount, coupon_code: pricing.promo.coupon_code || null }
          : null,
      });
      try { localStorage.removeItem('daos.pendingCoupon'); } catch { /* noop */ }
      // 訂單依期數拆分：買多期會建多筆訂單 → 導到「我的課程」逐筆繳款；單期維持直接進狀態頁。
      if ((result.count || 1) > 1) {
        navigate('/my-courses', { replace: true });
      } else {
        navigate(`/enroll-status/${result.first_id || result.id}`, { replace: true });
      }
    } catch {
      toast.error('送出失敗，請稍後再試');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-bold text-brand-primary">{coach.name}</h2>
          {coach.is_senior && (
            <span className="rounded-md bg-brand-gold px-1.5 py-0.5 text-xs font-medium text-white">
              資深
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-gray-500">{venue.name}</p>
      </div>

      {/* 購買期數（下拉；費用會隨期數變動） */}
      <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">購買期數</label>
        <select
          value={periodCount}
          onChange={(e) => setPeriodCount(Number(e.target.value))}
          className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-bold text-gray-800 focus:border-brand-teal focus:outline-none"
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>{n} 期</option>
          ))}
        </select>
      </div>

      <StudentMultiSelect
        parent={parent}
        selectedSelfStudents={selectedSelfStudents}
        minStudents={minStudents}
        maxStudents={maxStudents}
        onToggle={toggleSelf}
      />

      <PriceBreakdown pricing={pricing} multiplier={coach.multiplier} isSenior={coach.is_senior} />

      <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">折價券代碼（選填）</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={couponInput}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
            placeholder="輸入後按右側按鈕套用"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm uppercase focus:border-brand-teal focus:outline-none"
          />
          {activeCoupon ? (
            <button type="button" onClick={() => { setActiveCoupon(''); setCouponInput(''); }}
              className="rounded-lg bg-gray-200 px-3 py-2 text-sm font-bold text-gray-700">取消</button>
          ) : (
            <button type="button" onClick={() => setActiveCoupon(couponInput.trim())}
              disabled={!couponInput.trim() || pricing.previewLoading}
              className="rounded-lg bg-brand-teal px-3 py-2 text-sm font-bold text-white disabled:opacity-50">套用</button>
          )}
        </div>
        {pricing.previewError && (
          <p className="mt-1 text-xs text-brand-error">{pricing.previewError}</p>
        )}
        {activeCoupon && pricing.promo && pricing.discount > 0 && (
          <p className="mt-1 text-xs text-brand-green">已套用：{pricing.promo.name}（折抵 NT${pricing.discount.toLocaleString()}）</p>
        )}
      </div>

      <button
        type="button"
        disabled={!canSubmit || submitting}
        onClick={handleConfirmSubmit}
        className="mt-4 w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
      >
        {submitting ? '送出中…' : '下一步：填寫轉帳資料'}
      </button>

      {/* 發起團購：移到最下面、移除上方行銷文案；帶入已選的組別/期數/學員。1V1 不開團。 */}
      {courseType !== 1 && (
        <button
          type="button"
          onClick={() => {
            const q = new URLSearchParams();
            q.set('venue', venue.id);
            q.set('coach', coach.id);
            q.set('courseType', String(courseType));
            q.set('period', String(periodCount));
            const ids = allSelectedStudents.map((s) => s.id).filter(Boolean);
            if (ids.length) q.set('students', ids.join(','));
            navigate(`/group/new?${q.toString()}`);
          }}
          className="mt-3 w-full rounded-lg border border-brand-teal py-2.5 text-sm font-bold text-brand-teal active:bg-brand-teal/10"
        >
          發起團購
        </button>
      )}

    </div>
  );
}

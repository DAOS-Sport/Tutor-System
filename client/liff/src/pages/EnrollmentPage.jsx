import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import CourseTypeSelector from '../components/enroll/CourseTypeSelector';
import SelfStudentSelector from '../components/enroll/SelfStudentSelector';
import PriceBreakdown from '../components/enroll/PriceBreakdown';
import EnrollmentSummary from '../components/enroll/EnrollmentSummary';
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

  const [courseType, setCourseType] = useState(initialCourseType);
  const [periodCount, setPeriodCount] = useState(1);
  const [selectedSelfStudents, setSelectedSelfStudents] = useState([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [activeCoupon, setActiveCoupon] = useState('');

  // MGM：若有 pendingCoupon 對應同一教練，自動套用
  useEffect(() => {
    try {
      const raw = localStorage.getItem('daos.pendingCoupon');
      if (!raw || !coachId) return;
      const v = JSON.parse(raw);
      if (v && v.coupon && v.coachId === coachId) {
        setCouponInput(v.coupon);
        setActiveCoupon(v.coupon);
      }
    } catch { /* noop */ }
  }, [coachId]);

  const onBootError = useCallback((m) => toast.error(m), [toast]);
  const { bootData, bootError } = useEnrollmentBoot({
    coachId, venueId, courseType, onError: onBootError,
  });

  // 切換組別時重置學員選擇
  useEffect(() => {
    setSelectedSelfStudents([]);
  }, [courseType]);

  const pricing = useEnrollmentPricing(bootData, {
    courseType,
    venueId,
    couponCode: activeCoupon || undefined,
    studentCount: selectedSelfStudents.length,
    periodCount,
  });

  if (bootError) return <ErrorBlock message={bootError} onBack={() => navigate('/', { replace: true })} />;
  if (!bootData || !pricing) return <LoadingSpinner fullPage label="載入課程資訊…" />;
  if (!bootData.coach || !bootData.venue) {
    return <ErrorBlock message="找不到此教練或場館" onBack={() => navigate('/', { replace: true })} />;
  }

  const { coach, venue } = bootData;
  const requiredStudentCount = courseType;
  const totalSelected = selectedSelfStudents.length;

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
    totalSelected === requiredStudentCount &&
    selectionResolved &&
    !submitting &&
    !pricing.previewLoading &&
    !pricing.previewError;

  function toggleSelf(sid) {
    setSelectedSelfStudents((prev) => {
      if (prev.includes(sid)) return prev.filter((x) => x !== sid);
      if (prev.length >= requiredStudentCount) {
        toast.warning(`此組別最多選 ${requiredStudentCount} 位學員`);
        return prev;
      }
      return [...prev, sid];
    });
  }

  async function handleConfirmSubmit() {
    setSubmitting(true);
    try {
      const period = await enrollmentsApi.create({
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
      setConfirmOpen(false);
      try { localStorage.removeItem('daos.pendingCoupon'); } catch { /* noop */ }
      // 送出後導到報名狀態頁（待繳款 → 上傳證明 → 等待櫃台確認）
      navigate(`/enroll-status/${period.id}`, { replace: true });
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

      <CourseTypeSelector courseType={courseType} onChange={setCourseType} />

      {/* 購買期數（U10：移到前面，費用會隨期數變動） */}
      <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">購買期數</label>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} type="button" onClick={() => setPeriodCount(n)}
              className={`min-w-[3rem] rounded-lg border px-3 py-2 text-sm font-bold active:opacity-80 ${
                periodCount === n ? 'border-brand-primary bg-brand-primary text-white' : 'border-gray-300 bg-white text-gray-600'
              }`}>
              {n} 期
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-500">每期 6 堂；費用 = 單期費 × 學生數 × 期數。</p>
      </div>

      {/* 一對一（1V1, courseType===1）不提供團購：團報是「揪其他家長一起上課」的流程，
          1V1 不適用，故隱藏發起團購入口，避免邏輯衝突。 */}
      {courseType !== 1 && (
        <div className="mt-2 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
          <p className="text-xs text-gray-600">
            想找其他家長一起上課？可改用「團購」分享邀請連結，最多揪到 <span className="font-bold text-brand-primary">6 人</span>，
            價格依組別計、人數越多越好揪。
          </p>
          <button
            type="button"
            onClick={() => navigate(`/group/new?venue=${venue.id}&coach=${coach.id}&courseType=${courseType}`)}
            className="mt-2 w-full rounded-lg border border-brand-teal py-2 text-sm font-bold text-brand-teal active:bg-brand-teal/10"
          >
            發起團購
          </button>
        </div>
      )}

      <SelfStudentSelector
        parent={parent}
        totalSelected={totalSelected}
        requiredStudentCount={requiredStudentCount}
        selectedSelfStudents={selectedSelfStudents}
        onToggle={toggleSelf}
      />

      <PriceBreakdown pricing={pricing} multiplier={coach.multiplier} />

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

      <div className="mt-2 rounded-xl border border-brand-gold/30 bg-brand-gold/5 p-3 text-[12px] leading-5 text-gray-600">
        送出後會進入報名狀態頁，那裡會顯示轉帳帳號與應繳金額，請完成轉帳後填寫末 5 碼並上傳匯款證明，等待櫃檯確認。
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => setConfirmOpen(true)}
        className="mt-2 w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
      >
        送出報名
      </button>

      <ConfirmModal
        open={confirmOpen}
        title="確認報名資料"
        confirmLabel="確認送出"
        busy={submitting}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleConfirmSubmit}
      >
        <EnrollmentSummary
          venue={venue}
          coach={coach}
          courseType={courseType}
          periodCount={periodCount}
          allSelectedStudents={allSelectedStudents}
          pricing={pricing}
        />
      </ConfirmModal>
    </div>
  );
}

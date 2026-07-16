import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { checkoutApi } from '../api/checkout';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import StudentMultiSelect from '../components/enroll/StudentMultiSelect';
import PriceBreakdown from '../components/enroll/PriceBreakdown';
import ErrorBlock from '../components/enroll/ErrorBlock';
import useEnrollmentBoot from '../hooks/useEnrollmentBoot';
import useEnrollmentPricing from '../hooks/useEnrollmentPricing';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { resolveRouteInstruction } from '../utils/routeInstruction';

function createSubmitRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* noop */ }
  return `enroll-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function EnrollmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();
  const submitRequestIdRef = useRef(null);
  const submitLockRef = useRef(false);

  const venueId = params.get('venue');
  const initialCourseType = Number(params.get('courseType') || 1);
  const coachId = params.get('coach');
  const initialTrial = params.get('trial') === '1';
  // 續報掛券入口：?coupon=CODE 直接預填並套用既有折價券（試上模式不吃券，會被下方 effect 清除）。
  const initialCoupon = (params.get('coupon') || '').trim().toUpperCase();

  // 組別由顧客在首頁「商品」選好後帶進來（?courseType=N），報名頁不再重複讓人選，避免誤導。
  const [courseType] = useState(initialCourseType);
  const [periodCount, setPeriodCount] = useState(1);
  const [isTrial, setIsTrial] = useState(initialTrial);
  const [paymentMethod, setPaymentMethod] = useState(initialTrial ? 'on_site' : 'bank_transfer');
  const [selectedSelfStudents, setSelectedSelfStudents] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [couponInput, setCouponInput] = useState(initialCoupon);
  const [activeCoupon, setActiveCoupon] = useState(initialTrial ? '' : initialCoupon);

  // 推薦折扣（TRIAL50）已停用（2026-07 全站優惠清除）：不再自動套用 pendingCoupon，
  // 並主動清掉既有使用者瀏覽器內殘留的 daos.pendingCoupon，避免套到已刪除的券而報「折價券無效」。
  useEffect(() => {
    try { localStorage.removeItem('daos.pendingCoupon'); } catch { /* noop */ }
  }, []);

  const onBootError = useCallback((m) => toast.error(m), [toast]);
  const { bootData, bootError } = useEnrollmentBoot({
    coachId, venueId, courseType, onError: onBootError,
  });

  // F-A07 試上開關：此品項未開放試上（trial_enabled=false）→ 隱藏試上入口；
  // 若經 ?trial=1 深連結進來則強制切回一般報名並提示（後端另有 TRIAL_NOT_ENABLED fail-closed）。
  const trialEnabled = bootData ? bootData.trialEnabled === true : false;
  useEffect(() => {
    if (bootData && isTrial && bootData.trialEnabled !== true) {
      setIsTrial(false);
      toast.warning('此課程組別未開放試上，已切換為一般報名');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootData]);

  // 切換組別時重置學員選擇
  useEffect(() => {
    setSelectedSelfStudents([]);
  }, [courseType]);

  // 試上永遠是一位學員、一堂；切回一般報名時只清除試上專屬付款方式，其他既有流程不變。
  useEffect(() => {
    if (isTrial) {
      setPeriodCount(1);
      setSelectedSelfStudents([]);
      setActiveCoupon('');
      setCouponInput('');
      setPaymentMethod('on_site');
    } else {
      setPaymentMethod('bank_transfer');
    }
  }, [isTrial]);

  // 1對N 須剛好湊滿 N 位（min=max=courseType）；同組多家庭請改走團購（GroupCreate）。
  const maxStudents = isTrial ? 1 : courseType;
  const minStudents = isTrial ? 1 : courseType;
  const totalSelected = selectedSelfStudents.length;
  const pricingStudentCount = Math.max(totalSelected, minStudents);

  const pricing = useEnrollmentPricing(bootData, {
    courseType,
    venueId,
    couponCode: activeCoupon || undefined,
    studentCount: pricingStudentCount,
    periodCount,
    orderKind: isTrial ? 'trial' : 'standard',
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
    if (submitLockRef.current || submitting) return;
    submitLockRef.current = true;
    setSubmitting(true);
    if (!submitRequestIdRef.current) submitRequestIdRef.current = createSubmitRequestId();
    try {
      const result = await enrollmentsApi.create({
        request_id: submitRequestIdRef.current,
        parent_id: parent.id,
        parent_name: parent.name,
        parent_phone: parent.phone,
        coach: { id: coach.id, name: coach.name, is_senior: coach.is_senior },
        venue: { id: venue.id, name: venue.name },
        course_type: courseType,
        period_count: periodCount,
        order_kind: isTrial ? 'trial' : 'standard',
        payment_method: isTrial ? paymentMethod : 'bank_transfer',
        students: allSelectedStudents.map((s) => ({ id: s.id, name: s.name })),
        original_price: pricing.subtotal,
        final_price: pricing.final,
        promotion: !isTrial && pricing.promo
          ? { id: pricing.promo.id, discount: pricing.discount, coupon_code: pricing.promo.coupon_code || null }
          : null,
      });
      try { localStorage.removeItem('daos.pendingCoupon'); } catch { /* noop */ }
      const directPath = resolveRouteInstruction(result);
      if (directPath) {
        navigate(directPath, { replace: true });
        submitRequestIdRef.current = null;
        return;
      }
      const batchId = result?.batch_id || result?.batchId || result?.data?.batch_id || result?.data?.batchId;
      if (batchId) {
        const route = await checkoutApi.route({ enrollment_batch_id: batchId });
        const repairedPath = resolveRouteInstruction(route);
        if (repairedPath) {
          navigate(repairedPath, { replace: true });
          submitRequestIdRef.current = null;
          return;
        }
      }
      // eslint-disable-next-line no-console
      console.warn('[EnrollmentPage] enrollment created without route instruction', result);
      navigate('/my-courses', { replace: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || '送出失敗，請稍後再試');
    } finally {
      submitLockRef.current = false;
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

      {/* 報名方式：品項未開放試上 → 整塊隱藏（只走一般報名）；
          由試上入口（?trial=1）進來 → 鎖定「試上單次課」不再提供切換；
          其餘（開放試上、非試上入口）→ 維持原本雙鈕切換。 */}
      {trialEnabled && initialTrial && isTrial && (
        <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
          <span className="mb-2 block text-xs font-medium text-gray-600">報名方式</span>
          <div className="rounded-lg border border-brand-teal bg-brand-teal/10 px-3 py-2 text-center text-sm font-bold text-brand-primary">
            試上單次課
          </div>
          <p className="mt-2 text-xs leading-relaxed text-gray-500">試上限一位學員、一堂課，可選擇現場付費或轉帳。</p>
        </div>
      )}
      {trialEnabled && !(initialTrial && isTrial) && (
        <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
          <span className="mb-2 block text-xs font-medium text-gray-600">報名方式</span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setIsTrial(false)}
              className={`min-w-0 rounded-lg border px-3 py-2 text-sm font-bold transition ${
                !isTrial
                  ? 'border-brand-teal bg-brand-teal/10 text-brand-primary'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-brand-teal/50'
              }`}
            >
              一般報名
            </button>
            <button
              type="button"
              onClick={() => setIsTrial(true)}
              className={`min-w-0 rounded-lg border px-3 py-2 text-sm font-bold transition ${
                isTrial
                  ? 'border-brand-teal bg-brand-teal/10 text-brand-primary'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-brand-teal/50'
              }`}
            >
              試上單次課
            </button>
          </div>
          {isTrial && <p className="mt-2 text-xs leading-relaxed text-gray-500">試上限一位學員、一堂課，可選擇現場付費或轉帳。</p>}
        </div>
      )}

      {/* 購買期數（下拉；費用會隨期數變動） */}
      <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">購買期數</label>
        <select
          value={periodCount}
          onChange={(e) => setPeriodCount(Number(e.target.value))}
          disabled={isTrial}
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

      {isTrial && (
        <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
          <label className="mb-1 block text-xs font-medium text-gray-600">付款方式</label>
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-bold text-gray-800 focus:border-brand-teal focus:outline-none"
          >
            <option value="on_site">現場付費</option>
            <option value="bank_transfer">轉帳付款</option>
          </select>
        </div>
      )}

      {!isTrial && <div className="mt-2 rounded-xl border border-gray-200 bg-white p-3">
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
        {activeCoupon && pricing.previewLoading && (
          <p className="mt-1 text-xs text-gray-500">套用中…</p>
        )}
        {/* 已套用橫幅只在「試算完成」且為「折價券來源」的優惠時顯示（coupon_code 有值＝折價券；自動優惠為 null），
            避免試算中殘留的自動優惠被誤標為剛輸入的折價券。 */}
        {activeCoupon && !pricing.previewLoading && pricing.promo?.coupon_code && pricing.discount > 0 && (
          <p className="mt-1 text-xs text-brand-green">已套用：{pricing.promo.name}（折抵 NT${pricing.discount.toLocaleString()}）</p>
        )}
      </div>}

      <button
        type="button"
        disabled={!canSubmit || submitting}
        onClick={() => { if (canSubmit) handleConfirmSubmit(); }}
        className="mt-4 w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
      >
        {submitting ? '送出中…' : isTrial && paymentMethod === 'on_site' ? '確認試上現場付費' : '下一步：填寫轉帳資料'}
      </button>

      {/* 發起團購：移到最下面、移除上方行銷文案；帶入已選的組別/期數/學員。1V1 不開團。 */}
      {!isTrial && courseType !== 1 && (
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

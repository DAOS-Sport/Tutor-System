import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { parentsApi } from '../api/parents';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import CourseTypeSelector from '../components/enroll/CourseTypeSelector';
import SelfStudentSelector from '../components/enroll/SelfStudentSelector';
import PartnerLookup from '../components/enroll/PartnerLookup';
import PriceBreakdown from '../components/enroll/PriceBreakdown';
import BankTransferBlock from '../components/enroll/BankTransferBlock';
import EnrollmentSummary from '../components/enroll/EnrollmentSummary';
import ErrorBlock from '../components/enroll/ErrorBlock';
import useEnrollmentBoot from '../hooks/useEnrollmentBoot';
import useEnrollmentPricing from '../hooks/useEnrollmentPricing';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidTWPhone, isValidLast5 } from '../utils/format';

export default function EnrollmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();

  const venueId = params.get('venue');
  const initialCourseType = Number(params.get('courseType') || 1);
  const coachId = params.get('coach');

  const [courseType, setCourseType] = useState(initialCourseType);
  const [selectedSelfStudents, setSelectedSelfStudents] = useState([]);
  const [partnerPhone, setPartnerPhone] = useState('');
  const [partnerLookup, setPartnerLookup] = useState(null);
  const [partnerLookingUp, setPartnerLookingUp] = useState(false);
  const [selectedPartnerStudents, setSelectedPartnerStudents] = useState([]);
  const [last5, setLast5] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [activeCoupon, setActiveCoupon] = useState('');

  const onBootError = useCallback((m) => toast.error(m), [toast]);
  const { bootData, bootError } = useEnrollmentBoot({
    coachId, venueId, courseType, onError: onBootError,
  });

  // 切換組別時重置學員選擇
  useEffect(() => {
    setSelectedSelfStudents([]);
    setSelectedPartnerStudents([]);
    setPartnerLookup(null);
    setPartnerPhone('');
  }, [courseType]);

  const pricing = useEnrollmentPricing(bootData, {
    courseType,
    venueId,
    couponCode: activeCoupon || undefined,
  });

  if (bootError) return <ErrorBlock message={bootError} onBack={() => navigate('/', { replace: true })} />;
  if (!bootData || !pricing) return <LoadingSpinner fullPage label="載入課程資訊…" />;
  if (!bootData.coach || !bootData.venue) {
    return <ErrorBlock message="找不到此教練或場館" onBack={() => navigate('/', { replace: true })} />;
  }

  const { coach, venue } = bootData;
  const requiredStudentCount = courseType;
  const totalSelected = selectedSelfStudents.length + selectedPartnerStudents.length;

  const allSelectedStudents = [
    ...selectedSelfStudents
      .map((sid) => {
        const s = parent.students.find((x) => x.id === sid);
        return s ? { ...s, _ownerName: parent.name } : null;
      })
      .filter(Boolean),
    ...selectedPartnerStudents
      .map((sid) => {
        const s = partnerLookup?.students?.find((x) => x.id === sid);
        return s ? { ...s, _ownerName: partnerLookup.name } : null;
      })
      .filter(Boolean),
  ];
  // 防 stale ID：所有勾選 ID 都要解析得到，否則送出鈕不亮
  const selectionResolved =
    allSelectedStudents.length === selectedSelfStudents.length + selectedPartnerStudents.length;

  // 1v1 必為 1 位、1v2/1v3 只要湊滿總人數即可（自身學員多就不需要 partner，partner 純粹是補位用）
  const canSubmit =
    totalSelected === requiredStudentCount &&
    selectionResolved &&
    isValidLast5(last5) &&
    !submitting;

  async function handleLookupPartner() {
    if (!isValidTWPhone(partnerPhone)) {
      toast.error('請輸入正確手機號碼');
      return;
    }
    if (partnerPhone === parent.phone) {
      toast.warning('無法將自己加為同組家長');
      return;
    }
    // 切換 partner 時先清空舊選擇，避免 stale ID 流入提交 payload
    setSelectedPartnerStudents([]);
    setPartnerLookup(null);
    setPartnerLookingUp(true);
    try {
      const found = await parentsApi.findByPhone(partnerPhone.trim());
      if (!found || !found.students?.length) {
        toast.error('找不到此家長或該家長底下沒有學員');
      } else {
        setPartnerLookup(found);
        toast.success(`已找到 ${found.name}（${found.students.length} 位學員）`);
      }
    } catch {
      toast.error('查詢失敗');
    } finally {
      setPartnerLookingUp(false);
    }
  }

  function toggleSelf(sid) {
    setSelectedSelfStudents((prev) => {
      if (prev.includes(sid)) return prev.filter((x) => x !== sid);
      if (prev.length + selectedPartnerStudents.length >= requiredStudentCount) {
        toast.warning(`此組別最多選 ${requiredStudentCount} 位學員`);
        return prev;
      }
      return [...prev, sid];
    });
  }
  function togglePartner(sid) {
    setSelectedPartnerStudents((prev) => {
      if (prev.includes(sid)) return prev.filter((x) => x !== sid);
      if (prev.length + selectedSelfStudents.length >= requiredStudentCount) {
        toast.warning(`此組別最多選 ${requiredStudentCount} 位學員`);
        return prev;
      }
      return [...prev, sid];
    });
  }

  async function handleCopyAccount() {
    try {
      await navigator.clipboard.writeText(venue.account_number);
      toast.success('已複製帳號！');
    } catch {
      toast.error('複製失敗，請手動複製');
    }
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
        students: allSelectedStudents.map((s) => ({ id: s.id, name: s.name })),
        original_price: pricing.afterMultiplier,
        final_price: pricing.final,
        transfer_last_5: last5,
        promotion: pricing.promo
          ? { id: pricing.promo.id, discount: pricing.discount, coupon_code: pricing.promo.coupon_code || null }
          : null,
      });
      setConfirmOpen(false);
      navigate('/enroll-success', { state: { period }, replace: true });
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

      <SelfStudentSelector
        parent={parent}
        totalSelected={totalSelected}
        requiredStudentCount={requiredStudentCount}
        selectedSelfStudents={selectedSelfStudents}
        onToggle={toggleSelf}
      />

      {courseType > 1 && (
        <PartnerLookup
          partnerPhone={partnerPhone}
          setPartnerPhone={setPartnerPhone}
          partnerLookingUp={partnerLookingUp}
          partnerLookup={partnerLookup}
          selectedPartnerStudents={selectedPartnerStudents}
          onLookup={handleLookupPartner}
          onTogglePartner={togglePartner}
        />
      )}

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

      <BankTransferBlock
        venue={venue}
        last5={last5}
        setLast5={setLast5}
        onCopyAccount={handleCopyAccount}
      />

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
          allSelectedStudents={allSelectedStudents}
          pricing={pricing}
          last5={last5}
        />
      </ConfirmModal>
    </div>
  );
}

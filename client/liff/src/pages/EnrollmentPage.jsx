import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { coachesApi } from '../api/coaches';
import { coursesApi } from '../api/courses';
import { venuesApi } from '../api/venues';
import { parentsApi } from '../api/parents';
import { promotionsApi } from '../api/promotions';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import { Section, StudentRow } from '../components/enroll/EnrollmentParts';
import PartnerLookup from '../components/enroll/PartnerLookup';
import PriceBreakdown from '../components/enroll/PriceBreakdown';
import BankTransferBlock from '../components/enroll/BankTransferBlock';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatTWD, isValidTWPhone, isValidLast5, courseTypeLabel } from '../utils/format';

export default function EnrollmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();

  const venueId = params.get('venue');
  const initialCourseType = Number(params.get('courseType') || 1);
  const coachId = params.get('coach');

  const [bootData, setBootData] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [courseType, setCourseType] = useState(initialCourseType);
  const [selectedSelfStudents, setSelectedSelfStudents] = useState([]);
  const [partnerPhone, setPartnerPhone] = useState('');
  const [partnerLookup, setPartnerLookup] = useState(null);
  const [partnerLookingUp, setPartnerLookingUp] = useState(false);
  const [selectedPartnerStudents, setSelectedPartnerStudents] = useState([]);
  const [last5, setLast5] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setBootError(null);
    Promise.all([
      coachesApi.detail(coachId),
      venuesApi.detail(venueId),
      coursesApi.basePrice(courseType),
      promotionsApi.list(),
    ])
      .then(([coach, venue, bp, promos]) => {
        if (!alive) return;
        setBootData({ coach, venue, basePrice: bp.original_price, promos });
      })
      .catch(() => {
        if (!alive) return;
        setBootError('資料載入失敗');
        toast.error('資料載入失敗');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coachId, venueId, courseType]);

  // 切換組別時重置學員選擇
  useEffect(() => {
    setSelectedSelfStudents([]);
    setSelectedPartnerStudents([]);
    setPartnerLookup(null);
    setPartnerPhone('');
  }, [courseType]);

  const pricing = useMemo(() => {
    if (!bootData) return null;
    const base = bootData.basePrice;
    const afterMultiplier = Math.round(base * (bootData.coach?.multiplier || 1));
    const autoPromo = (bootData.promos || []).find((p) => p.is_auto_apply);
    let final = afterMultiplier;
    let discount = 0;
    if (autoPromo) {
      final = Math.round(afterMultiplier * autoPromo.value);
      discount = afterMultiplier - final;
    }
    return { base, afterMultiplier, final, discount, promo: autoPromo };
  }, [bootData]);

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
        coach: { id: coach.id, name: coach.name, is_senior: coach.is_senior },
        venue: { id: venue.id, name: venue.name },
        course_type: courseType,
        students: allSelectedStudents.map((s) => ({ id: s.id, name: s.name })),
        original_price: pricing.afterMultiplier,
        final_price: pricing.final,
        transfer_last_5: last5,
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

      <Section title="選擇組別">
        <div className="grid grid-cols-3 gap-2">
          {[1, 2, 3].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setCourseType(t)}
              className={`rounded-lg border-2 py-2.5 text-sm font-bold transition ${
                courseType === t
                  ? 'border-brand-teal bg-brand-teal text-white'
                  : 'border-gray-200 bg-white text-gray-600'
              }`}
            >
              {courseTypeLabel(t)}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`選擇學員（已選 ${totalSelected}/${requiredStudentCount}）`}>
        <p className="mb-2 text-xs text-gray-500">{parent.name}（您）名下：</p>
        <div className="space-y-2">
          {parent.students.map((s) => (
            <StudentRow
              key={s.id}
              student={s}
              checked={selectedSelfStudents.includes(s.id)}
              onToggle={() => toggleSelf(s.id)}
            />
          ))}
        </div>
      </Section>

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
        <ul className="space-y-1.5 text-sm">
          <li><b>場館：</b>{venue.name}</li>
          <li><b>教練：</b>{coach.name}{coach.is_senior ? '（資深）' : ''}</li>
          <li><b>組別：</b>{courseTypeLabel(courseType)}</li>
          <li>
            <b>學員：</b>
            {allSelectedStudents.map((s) => `${s.name}（${s._ownerName}）`).join('、')}
          </li>
          <li><b>應繳：</b><span className="font-bold text-brand-primary">{formatTWD(pricing.final)}</span></li>
          <li><b>轉帳末 5 碼：</b>{last5}</li>
        </ul>
      </ConfirmModal>
    </div>
  );
}

function ErrorBlock({ message, onBack }) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="mb-3 text-sm text-brand-error">{message}</div>
      <button
        type="button"
        onClick={onBack}
        className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
      >
        回首頁
      </button>
    </div>
  );
}

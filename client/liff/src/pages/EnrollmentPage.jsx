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
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  formatTWD,
  isValidTWPhone,
  isValidLast5,
  courseTypeLabel,
} from '../utils/format';

export default function EnrollmentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();

  const venueId = params.get('venue');
  const initialCourseType = Number(params.get('courseType') || 1);
  const coachId = params.get('coach');

  const [bootData, setBootData] = useState(null);
  const [courseType, setCourseType] = useState(initialCourseType);
  const [selectedSelfStudents, setSelectedSelfStudents] = useState([]);
  const [partnerPhone, setPartnerPhone] = useState('');
  const [partnerLookup, setPartnerLookup] = useState(null); // {parent, students[]} | null
  const [partnerLookingUp, setPartnerLookingUp] = useState(false);
  const [selectedPartnerStudents, setSelectedPartnerStudents] = useState([]);
  const [last5, setLast5] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
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
      .catch(() => alive && toast.error('資料載入失敗'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coachId, venueId, courseType]);

  // 計算費用
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

  // 切換組別時重置學員選擇
  useEffect(() => {
    setSelectedSelfStudents([]);
    setSelectedPartnerStudents([]);
    setPartnerLookup(null);
    setPartnerPhone('');
  }, [courseType]);

  if (!bootData || !pricing) return <LoadingSpinner fullPage label="載入課程資訊…" />;
  if (!bootData.coach || !bootData.venue) {
    return (
      <div className="px-4 py-8 text-center">
        <div className="mb-3 text-sm text-brand-error">找不到此教練或場館</div>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
        >
          回首頁
        </button>
      </div>
    );
  }

  const { coach, venue } = bootData;
  const requiredStudentCount = courseType; // 1v1=1, 1v2=2, 1v3=3
  const totalSelected = selectedSelfStudents.length + selectedPartnerStudents.length;
  const canSubmit =
    totalSelected === requiredStudentCount &&
    selectionResolved &&
    isValidLast5(last5) &&
    !submitting &&
    (courseType === 1 || (partnerLookup && selectedPartnerStudents.length > 0));

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
  // 防 stale ID：所有已勾選 ID 都必須能解析到實際學員物件，否則送出鈕就不該亮
  const selectionResolved =
    allSelectedStudents.length === selectedSelfStudents.length + selectedPartnerStudents.length;

  async function handleLookupPartner() {
    if (!isValidTWPhone(partnerPhone)) {
      toast.error('請輸入正確手機號碼');
      return;
    }
    if (partnerPhone === parent.phone) {
      toast.warning('無法將自己加為同組家長');
      return;
    }
    // 先清掉前一位 partner 的暫存選擇與資料，避免 stale ID 流入提交 payload
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
      {/* 教練 + 場館摘要 */}
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

      {/* 切換組別 */}
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

      {/* 我方學員 */}
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

      {/* 1對多：同組家長 */}
      {courseType > 1 && (
        <Section title="加入同組學員（其他家長名下）">
          <div className="flex gap-2">
            <input
              type="tel"
              inputMode="numeric"
              placeholder="同組家長手機 09xxxxxxxx"
              value={partnerPhone}
              onChange={(e) => setPartnerPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
            />
            <button
              type="button"
              onClick={handleLookupPartner}
              disabled={partnerLookingUp}
              className="shrink-0 rounded-lg bg-brand-primary px-3 py-2 text-sm font-bold text-white active:bg-brand-teal disabled:opacity-50"
            >
              {partnerLookingUp ? '查詢中' : '查詢'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            測試手機：0922333444（李爸爸）、0933555777（陳媽媽）
          </p>

          {partnerLookup && (
            <div className="mt-3">
              <p className="mb-2 text-xs text-gray-500">
                {partnerLookup.name} 名下：
              </p>
              <div className="space-y-2">
                {partnerLookup.students.map((s) => (
                  <StudentRow
                    key={s.id}
                    student={s}
                    checked={selectedPartnerStudents.includes(s.id)}
                    onToggle={() => togglePartner(s.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* 費用明細 */}
      <Section title="費用明細">
        <Row label="原始費用" value={formatTWD(pricing.base)} />
        <Row
          label={`套用係數 ${Math.round((coach.multiplier || 1) * 100)}%`}
          value={formatTWD(pricing.afterMultiplier)}
        />
        {pricing.promo && (
          <Row
            label={`優惠：${pricing.promo.title}`}
            value={`-${formatTWD(pricing.discount)}`}
            valueCls="text-brand-green"
          />
        )}
        <div className="mt-2 flex items-baseline justify-between border-t border-gray-100 pt-2">
          <span className="text-sm font-bold text-gray-700">應繳金額</span>
          <span className="text-xl font-bold text-brand-primary">{formatTWD(pricing.final)}</span>
        </div>
      </Section>

      {/* 銀行帳號 + 一鍵複製 */}
      <Section title="轉帳資訊">
        <Row label="戶名" value={venue.account_holder} />
        <Row label="銀行" value={`${venue.bank_institution_name} ${venue.bank_branch_name}`} />
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-brand-primary/5 p-3">
          <div className="flex-1">
            <div className="text-[11px] text-gray-500">帳號</div>
            <div className="font-mono text-base font-bold text-brand-primary">
              {venue.account_number}
            </div>
          </div>
          <button
            type="button"
            onClick={handleCopyAccount}
            className="rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white active:bg-brand-primary"
          >
            一鍵複製
          </button>
        </div>

        <div className="mt-3">
          <label htmlFor="last5" className="mb-1 block text-xs font-medium text-gray-600">
            轉帳末 5 碼
          </label>
          <input
            id="last5"
            type="tel"
            inputMode="numeric"
            placeholder="5 位數字"
            value={last5}
            onChange={(e) => setLast5(e.target.value.replace(/\D/g, '').slice(0, 5))}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
          />
          {last5 && !isValidLast5(last5) && (
            <p className="mt-1 text-xs text-brand-error">需為 5 位數字</p>
          )}
        </div>
      </Section>

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

function Section({ title, children }) {
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
      <h3 className="mb-3 text-sm font-bold text-brand-primary">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value, valueCls = 'text-gray-900' }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-gray-600">{label}</span>
      <span className={`font-medium ${valueCls}`}>{value}</span>
    </div>
  );
}

function StudentRow({ student, checked, onToggle }) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between rounded-lg border-2 p-3 transition ${
        checked ? 'border-brand-teal bg-brand-teal/5' : 'border-gray-200 bg-white'
      }`}
    >
      <div>
        <div className="text-sm font-bold text-gray-900">{student.name}</div>
        <div className="text-[11px] text-gray-500">{student.id_number}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-5 w-5 accent-brand-teal"
      />
    </label>
  );
}

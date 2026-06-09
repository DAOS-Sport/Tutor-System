import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { groupOrdersApi } from '../api/groupOrders';
import GroupMemberFields, { memberFieldsReady, memberFieldsPayload } from '../components/group/GroupMemberFields';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

// 期數可選範圍（與後端 PERIOD_COUNT_MAX 一致）。
const PERIOD_OPTIONS = [1, 2, 3, 4, 5, 6];

// 把目前表單狀態整理成「草稿暫存」用的 payload（後端會再做白名單 / 大小過濾）。
function buildDraftPayload({ courseType, venueId, coachId, fields, note, periodCount }) {
  return {
    course_type: courseType,
    venue_id: venueId || undefined,
    coach_id: coachId || undefined,
    period_count: periodCount || 1,
    student_ids: fields.studentIds || [],
    new_students: fields.newStudents || [],
    proof_url: fields.proofUrl || undefined,
    note: note.trim() || undefined,
  };
}
// 草稿是否有「值得存」的內容（避免一進頁面就存空草稿）。
function draftHasContent(fields, note) {
  return (
    (fields.studentIds || []).length > 0 ||
    (fields.newStudents || []).some((s) => String(s?.name || '').trim()) ||
    !!fields.proofUrl ||
    !!note.trim()
  );
}

/**
 * 發起團購頁。由報名頁帶 venue / coach / courseType 進來。
 * 團主填自己的學生 + 匯款證明 → 建立團購 → 導到狀態頁分享邀請碼。
 * 填到一半會自動暫存到後端草稿（group_order_drafts），重整 / 換裝置回來可還原。
 */
export default function GroupCreatePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const venueId = params.get('venue') || '';
  const coachId = params.get('coach') || '';
  const courseType = Number(params.get('courseType') || 2);
  // 由報名頁帶入的已選值（組別已在 courseType；這裡再帶期數與學員）——URL 帶值優先於後端草稿。
  const carriedPeriod = Number(params.get('period') || 0);
  const carriedStudentIds = (params.get('students') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hasCarried = carriedPeriod > 0 || carriedStudentIds.length > 0;

  const [fields, setFields] = useState({ studentIds: carriedStudentIds, newStudents: [], proofUrl: '' });
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');
  const [periodCount, setPeriodCount] = useState(carriedPeriod >= 1 && carriedPeriod <= 6 ? carriedPeriod : 1);

  // 草稿自動暫存控制：hydrated 後才開始存；lastSaved 去重，避免重複 PUT。
  const hydratedRef = useRef(false);
  const lastSavedRef = useRef(null);

  // 一對一（1V1）不開放團購：即使有人直接帶 ?courseType=1 進來也導回報名頁，
  // 與 EnrollmentPage 拔掉發起鈕的邏輯一致。
  useEffect(() => {
    if (courseType === 1) {
      toast.error('一對一課程不提供團購');
      const q = new URLSearchParams();
      if (venueId) q.set('venue', venueId);
      if (coachId) q.set('coach', coachId);
      q.set('courseType', '1');
      navigate(coachId ? `/enroll?${q.toString()}` : '/', { replace: true });
    }
  }, [courseType, coachId, venueId, navigate, toast]);

  // 進頁面載入草稿並還原（1V1 不載入，因為會被導走）。URL 有帶入值時跳過還原（帶值優先）。
  useEffect(() => {
    if (courseType === 1) return;
    if (hasCarried) { hydratedRef.current = true; return; }
    let alive = true;
    (async () => {
      try {
        const res = await groupOrdersApi.getDraft();
        const d = res?.draft;
        if (alive && d && draftHasContent(
          { studentIds: d.student_ids, newStudents: d.new_students, proofUrl: d.proof_url },
          d.note || ''
        )) {
          setFields({
            studentIds: Array.isArray(d.student_ids) ? d.student_ids : [],
            newStudents: Array.isArray(d.new_students) ? d.new_students : [],
            proofUrl: d.proof_url || '',
          });
          if (d.note) setNote(d.note);
          const restoredPeriod = PERIOD_OPTIONS.includes(Number(d.period_count)) ? Number(d.period_count) : 1;
          if (restoredPeriod !== 1) setPeriodCount(restoredPeriod);
          // 還原值即視為「已存」，避免還原後立刻又被 autosave 回存一次
          lastSavedRef.current = JSON.stringify(buildDraftPayload({
            courseType,
            venueId,
            coachId,
            fields: { studentIds: d.student_ids || [], newStudents: d.new_students || [], proofUrl: d.proof_url || '' },
            note: d.note || '',
            periodCount: restoredPeriod,
          }));
          toast.info?.('已還原上次未填完的團報內容');
        }
      } catch { /* 草稿載入失敗不阻擋發起流程 */ }
      finally { if (alive) hydratedRef.current = true; }
    })();
    return () => { alive = false; };
    // 僅在進頁面時跑一次（venue/coach/courseType 由 URL 固定）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 表單變動 → debounce 自動暫存草稿（hydrated 後才啟動，去重避免重複 PUT）。
  useEffect(() => {
    if (!hydratedRef.current || courseType === 1) return;
    if (!draftHasContent(fields, note)) return;
    const payload = buildDraftPayload({ courseType, venueId, coachId, fields, note, periodCount });
    const key = JSON.stringify(payload);
    if (key === lastSavedRef.current) return;
    const t = setTimeout(() => {
      groupOrdersApi.saveDraft(payload)
        .then(() => { lastSavedRef.current = key; })
        .catch(() => { /* 暫存失敗不打擾使用者，下次變動再試 */ });
    }, 800);
    return () => clearTimeout(t);
  }, [fields, note, courseType, venueId, coachId, periodCount]);

  const canSubmit = !!venueId && memberFieldsReady(fields) && !submitting;

  async function handleCreate() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const order = await groupOrdersApi.create({
        course_type: courseType,
        venue_id: venueId,
        coach_id: coachId || undefined,
        period_count: periodCount,
        ...memberFieldsPayload(fields),
        note: note.trim() || undefined,
      });
      // 後端建立成功會自動刪草稿；mock 模式再補一刀確保乾淨。
      groupOrdersApi.clearDraft().catch(() => {});
      toast.success('團購已建立，快邀請其他家長加入！');
      navigate(`/group/${order.id}`, { replace: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || '發起團購失敗');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
        <h2 className="text-sm font-bold text-brand-primary">發起 {courseTypeLabel(courseType)} 團購</h2>
        <p className="mt-1 text-xs text-gray-500">
          您將成為團主，先選好自己的學生。建立後會取得邀請碼，分享給其他家長一起湊滿開團人數；送審後再各自上傳匯款證明。
        </p>
      </div>

      <GroupMemberFields
        value={fields}
        onChange={setFields}
        maxStudents={courseType}
      />

      <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">購買期數</label>
        <div className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setPeriodCount(n)}
              className={`min-w-[3rem] rounded-lg border px-3 py-2 text-sm font-bold active:opacity-80 ${
                periodCount === n
                  ? 'border-brand-primary bg-brand-primary text-white'
                  : 'border-gray-300 bg-white text-gray-600'
              }`}
            >
              {n} 期
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-500">
          每期 {6} 堂；一次購買多期可一併開通。<strong>送審後此團報名單將鎖定、不可更換成員</strong>，需更換請另開團報。
        </p>
      </div>

      <div className="mt-3 rounded-xl border border-gray-200 bg-white p-3">
        <label className="mb-1 block text-xs font-medium text-gray-600">備註（選填）</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="例如：希望週六下午班"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
        />
      </div>

      <button
        type="button"
        disabled={!canSubmit}
        onClick={handleCreate}
        className="mt-4 w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
      >
        {submitting ? '建立中…' : '建立團購'}
      </button>
    </div>
  );
}

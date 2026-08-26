import React, { useEffect, useMemo, useState } from 'react';
import { enrollmentsApi } from '../../api/enrollments';
import { venuesApi } from '../../api/venues';
import { staffApi } from '../../api/staff';
import { useToast } from '../../context/ToastContext';

const COURSE_TYPES = [
  { value: 1, label: '1 對 1 個別班' },
  { value: 2, label: '1 對 2 雙人班' },
  { value: 3, label: '1 對 3 三人班' },
];

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>}
    </div>
  );
}

function Input({ value, onChange, type = 'text', placeholder, className = '' }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-teal ${className}`}
    />
  );
}

function Select({ value, onChange, children, disabled, className = '' }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-teal disabled:bg-gray-100 disabled:text-gray-400 ${className}`}
    >
      {children}
    </select>
  );
}

export default function EditEnrollmentModal({ enrollment, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const [parentName, setParentName]         = useState(enrollment.parent_name || '');
  const [parentPhone, setParentPhone]       = useState(enrollment.parent_phone || '');
  const [students, setStudents]             = useState((enrollment.students || []).join('、'));
  const [venueId, setVenueId]               = useState(enrollment.venue_id || '');
  const [coachId, setCoachId]               = useState(enrollment.coach_id || '');
  const [courseType, setCourseType]         = useState(enrollment.course_type || 1);
  const [originalPrice, setOriginalPrice]   = useState(enrollment.original_price ?? '');
  const [finalPrice, setFinalPrice]         = useState(enrollment.final_price ?? '');
  const [transferLast5, setTransferLast5]   = useState(enrollment.transfer_last_5 || '');
  const [extraPhones, setExtraPhones]       = useState((enrollment.extra_parent_phones || []).join('\n'));
  const [notes, setNotes]                   = useState(enrollment.notes || '');

  const [venues, setVenues] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [coachesLoading, setCoachesLoading] = useState(false);
  const [errors, setErrors] = useState({});

  // 載入場館清單
  useEffect(() => {
    let alive = true;
    venuesApi.list().then((d) => alive && setVenues(d || [])).catch(() => {});
    return () => { alive = false; };
  }, []);

  // 載入該場館的教練清單。若原報名教練已停用、不在 active 清單，補一個 disabled 的
  // 「目前」選項並選中，避免下拉變空、看不出原指派教練（需重新指派）。
  useEffect(() => {
    if (!venueId) { setCoaches([]); return; }
    let alive = true;
    setCoachesLoading(true);
    staffApi.coachesByVenue(venueId, 'active')
      .then((d) => {
        if (!alive) return;
        const list = d || [];
        const stillSameVenue = venueId === enrollment.venue_id;
        if (stillSameVenue && enrollment.coach_id && coachId === enrollment.coach_id
            && !list.some((c) => c.id === enrollment.coach_id)) {
          setCoaches([
            { id: enrollment.coach_id, name: `目前：${enrollment.coach || '原教練'}（已停用，需重新指派）`, _inactive: true },
            ...list,
          ]);
        } else {
          setCoaches(list);
        }
      })
      .catch(() => alive && setCoaches([]))
      .finally(() => alive && setCoachesLoading(false));
    return () => { alive = false; };
  }, [venueId, enrollment.venue_id, enrollment.coach_id, enrollment.coach, coachId]);

  // 換場館時無條件 reset 教練選擇（即使新場館也含此教練），確保管理員自覺重選
  function handleVenueChange(nextVenueId) {
    if (nextVenueId !== venueId) setCoachId('');
    setVenueId(nextVenueId);
  }

  const venueName = useMemo(
    () => (venues.find((v) => v.id === venueId)?.name) || venueId,
    [venues, venueId]
  );
  const newCoachName = useMemo(
    () => (coaches.find((c) => c.id === coachId && !c._inactive)?.name) || enrollment.coach || '',
    [coaches, coachId, enrollment.coach]
  );

  function validate() {
    const e = {};
    if (!parentName.trim()) e.parentName = '家長姓名必填';
    if (!parentPhone.trim()) e.parentPhone = '家長手機必填';
    if (!students.trim()) e.students = '至少填一位學員';
    if (!venueId) e.venueId = '報名場館必填';
    if (!coachId) e.coachId = '請選擇教練';
    if (Number(originalPrice) <= 0) e.originalPrice = '原價必須 > 0';
    if (Number(finalPrice) <= 0) e.finalPrice = '應收金額必須 > 0';
    return e;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const studentList = students.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
    const extraPhoneList = extraPhones.split(/[\n,，]/).map((p) => p.trim()).filter(Boolean);

    setBusy(true);
    try {
      const updated = await enrollmentsApi.update(enrollment.id, {
        parent_name:          parentName.trim(),
        parent_phone:         parentPhone.trim(),
        students:             studentList,
        venue_id:             venueId,
        coach_id:             coachId,
        course_type:          Number(courseType),
        original_price:       Number(originalPrice),
        final_price:          Number(finalPrice),
        transfer_last_5:      transferLast5.trim(),
        extra_parent_phones:  extraPhoneList,
        notes:                notes.trim() || null,
      });

      const venueChanged = venueId !== enrollment.venue_id;
      const coachChanged = newCoachName && newCoachName !== enrollment.coach;
      if (venueChanged || coachChanged) {
        const parts = [];
        if (venueChanged) parts.push(`場館 ${venueName}`);
        if (coachChanged) parts.push(`教練 ${enrollment.coach} → ${newCoachName}`);
        const reassigned = updated?._transfer?.reassigned_sessions || 0;
        toast.success(`已更新${parts.join('、')}${reassigned ? `（重新指派 ${reassigned} 堂未來課程）` : ''}`);
      } else {
        toast.success('報名資料已更新');
      }
      onSaved(updated);
    } catch (err) {
      const msg = err?.response?.data?.error || '更新失敗，請稍後再試';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:px-4"
      onClick={(ev) => ev.target === ev.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label="編輯報名資料"
    >
      {/* 原本在 375px 會發生什麼：面板置中、被 px-4 夾成 343 寬，表單有十幾個欄位，
          雙欄 grid 在手機上仍維持 grid-cols-2、每格只剩約 150px。面板吃滿 90vh 之後
          「取消 / 儲存變更」落在整段表單的最尾端，要一路捲到底才看得到；再加上編輯時
          鍵盤一定會彈出來，可視高度砍半，而 vh 在 iOS Safari 上含收合中的網址列，
          那一排按鈕會被壓到看不見。
          改成 md 以下貼底升起的面板：滿版、上緣圓角、85dvh。
          面板本身原本就是捲軸（p-6 + overflow-y-auto），改成 flex-col 後把 p-6 與
          overflow-y-auto 搬進中段那層，grabber 才不會跟著內容捲走；桌機的內距、
          捲軸位置與可捲範圍完全一致。
          md 以上原封不動回到 items-center + max-w-lg + rounded-2xl + 90dvh（桌機同 90vh）。 */}
      <div className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl pb-[env(safe-area-inset-bottom)] md:max-h-[90dvh] md:max-w-lg md:rounded-2xl">
        {/* grabber：行動裝置上「這個可以往下拉」的通用暗示，桌機沒有這個手勢所以 md:hidden。 */}
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-gray-300 md:hidden" aria-hidden="true" />
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-bold text-brand-primary">編輯報名資料 — {enrollment.id}</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="家長姓名 *">
                <Input value={parentName} onChange={setParentName} placeholder="如：張媽媽" />
                {errors.parentName && <p className="mt-0.5 text-[11px] text-red-500">{errors.parentName}</p>}
              </Field>
              <Field label="家長手機 *">
                <Input value={parentPhone} onChange={setParentPhone} placeholder="0912345678" />
                {errors.parentPhone && <p className="mt-0.5 text-[11px] text-red-500">{errors.parentPhone}</p>}
              </Field>
            </div>

            <Field label="學員姓名 *" hint="多位學員請以頓號（、）或逗號分隔">
              <Input
                value={students}
                onChange={setStudents}
                placeholder="如：張小明、張小美"
              />
              {errors.students && <p className="mt-0.5 text-[11px] text-red-500">{errors.students}</p>}
            </Field>

            <Field label="報名場館 *" hint="變更場館後教練選項會重新載入">
              <Select value={venueId} onChange={handleVenueChange}>
                <option value="">請選擇場館</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </Select>
              {errors.venueId && <p className="mt-0.5 text-[11px] text-red-500">{errors.venueId}</p>}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="教練 *" hint={!venueId ? '請先選擇場館' : (coachesLoading ? '載入中…' : `本場館 ${coaches.length} 位在職教練`)}>
                <Select value={coachId} onChange={setCoachId} disabled={!venueId || coachesLoading}>
                  <option value="">{venueId ? '請選擇教練' : '—'}</option>
                  {coaches.map((c) => (
                    <option key={c.id} value={c.id} disabled={c._inactive}>
                      {c.name}{c.is_senior ? ' ⭐' : ''}
                    </option>
                  ))}
                </Select>
                {errors.coachId && <p className="mt-0.5 text-[11px] text-red-500">{errors.coachId}</p>}
              </Field>
              <Field label="組別">
                <Select value={courseType} onChange={setCourseType}>
                  {COURSE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="原價（NT$）*">
                <Input type="number" value={originalPrice} onChange={setOriginalPrice} placeholder="11700" />
                {errors.originalPrice && <p className="mt-0.5 text-[11px] text-red-500">{errors.originalPrice}</p>}
              </Field>
              <Field label="應收金額（NT$）*">
                <Input type="number" value={finalPrice} onChange={setFinalPrice} placeholder="11115" />
                {errors.finalPrice && <p className="mt-0.5 text-[11px] text-red-500">{errors.finalPrice}</p>}
              </Field>
            </div>

            <Field label="轉帳末 5 碼">
              <Input value={transferLast5} onChange={setTransferLast5} placeholder="12345" className="font-mono" />
            </Field>

            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
              <div className="mb-2 text-xs font-bold text-blue-700">📱 附加家長手機（多組家庭）</div>
              <p className="mb-2 text-[11px] text-blue-600">
                1 對 2 / 1 對 3 等多個家庭同組時，在這裡加入其他家庭的手機號碼，讓他們登入 LIFF 也能查看本報名資訊。
                每行填一組。
              </p>
              <textarea
                value={extraPhones}
                onChange={(ev) => setExtraPhones(ev.target.value)}
                rows={3}
                placeholder={'0922333444\n0933555666'}
                className="w-full rounded-lg border border-blue-200 px-3 py-2 text-sm font-mono outline-none focus:border-brand-teal"
              />
            </div>

            <Field label="備注">
              <textarea
                value={notes}
                onChange={(ev) => setNotes(ev.target.value)}
                rows={2}
                placeholder="如：家長要求特定時段、付款方式說明等..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-brand-teal"
              />
            </Field>

            {/* 原本在 375px 會發生什麼：這排按鈕在表單最尾端，鍵盤彈出後幾乎不可能捲到。
                sticky bottom-0 讓它在捲動時就釘在面板下緣（＝拇指區）；md:static 把它
                原樣放回文件流，桌機仍是捲到底才出現的那一列。按鈕留在 <form> 裡面，
                type="submit" 的行為不變。 */}
            <div className="sticky bottom-0 flex justify-end gap-3 bg-white pb-3 pt-2 md:static md:bg-transparent md:pb-0">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-brand-primary px-5 py-2 text-sm font-bold text-white hover:bg-brand-teal disabled:opacity-50"
              >
                {busy ? '儲存中…' : '儲存變更'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

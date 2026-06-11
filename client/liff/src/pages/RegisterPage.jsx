import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import liff from '@line/liff';
import { parentsApi } from '../api/parents';
import { authApi } from '../api/auth';
import { referralsApi } from '../api/referrals';
import { coachesApi } from '../api/coaches';
import { venuesApi } from '../api/venues';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { takeAfterAuth } from '../utils/afterAuth';
import { isValidTWPhone, isValidTWId } from '../utils/format';
import { USE_MOCK } from '../api/client';
import ReportIssueButton from '../components/ReportIssueButton';

const PENDING_COUPON_KEY = 'daos.pendingCoupon';
const IS_PROD = import.meta.env.PROD;

function tryGetLineIdToken() {
  try {
    if (typeof liff?.getIDToken === 'function' && liff.isLoggedIn?.()) {
      return liff.getIDToken() || null;
    }
  } catch { /* swallow */ }
  return null;
}

function registerErrorMessage(err) {
  const code = err?.response?.data?.code;
  const status = err?.response?.status;
  if (code === 'LINE_ALREADY_BOUND_TO_OTHER_PHONE') return '此 LINE 已綁定其他手機，請聯絡管理員。';
  if (code === 'LINE_ALREADY_REGISTERED') return '此 LINE 已註冊過，請直接從 LINE 開啟連結登入。';
  if (code === 'PHONE_EXISTS_USE_BINDING') return '此手機已存在於系統，請改回登入頁以手機綁定。';
  if (code === 'LINE_VERIFY_FAILED' || code === 'LINE_ID_TOKEN_REQUIRED') return 'LINE 驗證失敗：請重新由 LINE 開啟。';
  if (code === 'RAGIC_UNAVAILABLE' || code === 'RAGIC_WRITE_FAILED') return '資料同步暫時失敗，請稍後再試。';
  if (code === 'PHONE_FORMAT_INVALID') return '手機格式錯誤（需 09xxxxxxxx）。';
  if (code === 'ID_NUMBER_INVALID') return '學員身分證字號格式錯誤。';
  if (code === 'RATE_LIMITED' || status === 429) return '嘗試次數過多，請稍後再試。';
  return '註冊失敗，請稍後再試。';
}

export default function RegisterPage() {
  const [params] = useSearchParams();
  const prefilledPhone = params.get('phone') || '';
  const refToken = params.get('ref') || '';
  const demoMode = params.get('demo') === '1';
  const navigate = useNavigate();
  const { setParent, parent, isAuthed, role } = useAuth();
  const toast = useToast();
  const [refInfo, setRefInfo] = useState(null);
  const [refResolved, setRefResolved] = useState(false);
  // 註冊失敗 → 顯示「問題回報」按鈕（避免使用者只看到一閃即逝的 toast 而卡住）
  const [failed, setFailed] = useState(false);
  const [errCode, setErrCode] = useState('');
  const authedParent = isAuthed && role === 'parent';

  // 用推薦的教練解析出有效場館（優先家長慣用場館，否則取教練第一個場館），
  // 組出帶 coach/venue/courseType 的報名頁 URL；EnrollmentPage 會據 coachId 自動套 TRIAL50。
  const buildRefEnrollUrl = useCallback(async (coachId, preferVenueId) => {
    let venueId = preferVenueId || '';
    try {
      const cd = await coachesApi.detail(coachId);
      const vids = cd?.venue_ids || [];
      if (vids.length && !vids.includes(venueId)) venueId = vids[0];
    } catch { /* 場館解析失敗就沿用 preferVenueId */ }
    const q = new URLSearchParams();
    q.set('coach', coachId);
    if (venueId) q.set('venue', venueId);
    q.set('courseType', '1'); // 體驗課＝一對一
    return `/enroll?${q.toString()}`;
  }, []);

  // 讀取推薦連結資訊（推薦人 / 教練）— MGM ref_token UI 保留
  useEffect(() => {
    if (!refToken) return;
    let alive = true;
    referralsApi.byToken(refToken)
      .then((d) => { if (alive) setRefInfo(d); })
      .catch(() => { if (alive) toast.warning('推薦連結資訊載入失敗'); })
      .finally(() => { if (alive) setRefResolved(true); });
    return () => { alive = false; };
  }, [refToken, toast]);

  // 已登入家長點教練分享連結：不該再被丟去新客戶註冊表。
  // 等推薦資訊載入完 → 寫 pendingCoupon（享該教練 5 折）→ 直接導去報名頁帶現有學生報名。
  useEffect(() => {
    if (!authedParent || !refToken || !refResolved) return;
    let alive = true;
    (async () => {
      const coachId = refInfo?.coach?.id;
      if (!coachId) { navigate('/', { replace: true }); return; } // 推薦連結失效 → 回首頁
      if (refInfo.already_bound !== true) {
        try {
          localStorage.setItem(PENDING_COUPON_KEY,
            JSON.stringify({ coupon: 'TRIAL50', coachId }));
        } catch { /* noop */ }
      }
      const url = await buildRefEnrollUrl(coachId, parent?.primary_venue_id);
      if (alive) navigate(url, { replace: true });
    })();
    return () => { alive = false; };
  }, [authedParent, refToken, refResolved, refInfo, parent, navigate, buildRefEnrollUrl]);

  // 館別（上課場館）清單 — /api/venues 為公開端點，未登入註冊頁也可載入
  const [venues, setVenues] = useState([]);
  useEffect(() => {
    let alive = true;
    venuesApi.list().then((vs) => { if (alive) setVenues(vs || []); }).catch(() => { /* noop */ });
    return () => { alive = false; };
  }, []);

  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm({
    defaultValues: {
      name: '', phone: prefilledPhone, gender: '女', email: '', primary_venue_id: '',
      students: [{ name: '', id_number: '', birth_date: '', gender: '男' }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'students' });

  async function onSubmit(data) {
    setFailed(false);
    setErrCode('');
    const cleanParent = {
      name: data.name,
      phone: data.phone.trim(),
      gender: data.gender,
      email: data.email,
      primary_venue_id: data.primary_venue_id || null,
    };
    const cleanStudents = data.students.map((s) => ({
      ...s,
      id_number: (s.id_number || '').toUpperCase(),
    }));

    try {
      // Demo 新用戶（測試註冊）：繞過 id_token，後端以 DEMOTEST_ 前綴真寫 Ragic Z01。
      if (demoMode) {
        const r = await authApi.parentRegisterLine({
          demo: true,
          parent: cleanParent,
          students: cleanStudents,
          refToken: refToken || undefined,
        });
        if (r?.status === 'registered_and_logged_in' && r.parent) {
          setParent({ ...r.parent, token: r.token || r.parent.token || null });
          toast.success('🧪 Demo 測試註冊完成！已寫入 Ragic（DEMOTEST 標記），自動登入');
          navigate(takeAfterAuth('/'), { replace: true });
          return;
        }
        setErrCode('DEMO_REGISTER_FAILED');
        setFailed(true);
        toast.error('Demo 註冊失敗，請稍後再試。');
        return;
      }

      const idToken = tryGetLineIdToken();

      // LINE-first 註冊：有 id_token → 走 parent-register-line（同步串入 ref_token）
      if (idToken) {
        const r = await authApi.parentRegisterLine({
          idToken,
          parent: cleanParent,
          students: cleanStudents,
          refToken: refToken || undefined,
        });
        if (r?.status === 'registered_and_logged_in' && r.parent) {
          const merged = { ...r.parent, token: r.token || r.parent.token || null };
          setParent(merged);
          // MGM：ref_bound=true 且 refInfo.coach 存在 → 寫 pendingCoupon
          // 報名頁會偵測並自動套用 TRIAL50 (5 折)
          if (refInfo && refInfo.coach && r.ref_bound) {
            try {
              localStorage.setItem(PENDING_COUPON_KEY,
                JSON.stringify({ coupon: 'TRIAL50', coachId: refInfo.coach.id }));
            } catch { /* noop */ }
            toast.success(`註冊完成！請選擇組別與場館後即可享 ${refInfo.coach.name} 教練體驗課 5 折`);
          } else if (refInfo && refInfo.coach && r.ref_error) {
            // 推薦綁定失敗不阻擋註冊，但要告知使用者
            toast.warning('註冊完成，但推薦連結綁定失敗，請聯絡客服');
          } else {
            toast.success('註冊完成！歡迎加入夢想體育學院');
          }
          // 推薦註冊成功 → 直接導去帶該教練的報名頁，pendingCoupon 才套得上 5 折
          if (refInfo?.coach && r.ref_bound) {
            const url = await buildRefEnrollUrl(refInfo.coach.id, merged?.primary_venue_id);
            navigate(url, { replace: true });
          } else {
            navigate(takeAfterAuth('/'), { replace: true });
          }
          return;
        }
        setErrCode('REGISTER_NO_STATUS');
        setFailed(true);
        toast.error('註冊失敗，請稍後再試。');
        return;
      }

      // 無 id_token：
      //  - production 正式 LIFF：禁止 fallback，要求重新由 LINE 開啟
      //  - dev / mock：保留舊 parentsApi.create fallback，方便本地測試
      if (IS_PROD && !USE_MOCK) {
        setErrCode('LINE_ID_TOKEN_REQUIRED');
        setFailed(true);
        toast.error('LINE 驗證失敗：請重新由 LINE 開啟註冊頁。');
        return;
      }
      const created = await parentsApi.create({
        ...cleanParent,
        ref_token: refToken || undefined,
        students: cleanStudents,
      });
      const parent = { ...created, token: created?.token || null };
      setParent(parent);
      if (refInfo && refInfo.coach && created?.ref_bound) {
        try {
          localStorage.setItem(PENDING_COUPON_KEY,
            JSON.stringify({ coupon: 'TRIAL50', coachId: refInfo.coach.id }));
        } catch { /* noop */ }
        toast.success(`註冊完成！請選擇組別與場館後即可享 ${refInfo.coach.name} 教練體驗課 5 折`);
      } else {
        toast.success('註冊完成！歡迎加入夢想體育學院');
      }
      if (refInfo?.coach && created?.ref_bound) {
        const url = await buildRefEnrollUrl(refInfo.coach.id, parent?.primary_venue_id);
        navigate(url, { replace: true });
      } else {
        navigate(takeAfterAuth('/'), { replace: true });
      }
    } catch (err) {
      setErrCode(err?.response?.data?.code || err?.code || '');
      setFailed(true);
      toast.error(registerErrorMessage(err));
    }
  }

  return (
    <div className="px-4 py-4">
      <h2 className="mb-1 text-lg font-bold text-brand-primary">建立家長帳號</h2>
      <p className="mb-3 text-xs text-gray-500">系統會將資料同步寫入 Ragic 家長／學員資料表</p>

      {demoMode && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
          🧪 <b>Demo 測試註冊</b>（模擬全新未註冊用戶）。送出會<b>真的寫入 Ragic Z01</b>，
          line_uid 以 <code>DEMOTEST_</code> 標記，方便事後依此前綴清除。
          請填一個<b>尚未在系統內的手機號</b>，以免撞到既有資料而被導去「手機綁定」。
        </div>
      )}

      {refInfo && (
        <div className="mb-3 rounded-xl border border-brand-green/40 bg-green-50 p-3 text-xs">
          <div className="font-bold text-brand-green">🎁 推薦連結已啟用</div>
          <div className="mt-0.5 text-gray-600">
            來自 <b>{refInfo.referrer?.name}</b> 推薦 <b>{refInfo.coach?.name}</b> 教練
          </div>
          <div className="mt-0.5 text-gray-600">完成註冊後，體驗課將自動套用 <b>5 折優惠</b>。</div>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <Section title="家長資料">
          <Field label="姓名" error={errors.name?.message}>
            <input type="text" {...register('name', { required: '請填寫家長姓名' })} className={inputCls} />
          </Field>
          <Field label="手機號碼" error={errors.phone?.message}>
            <input type="tel" inputMode="numeric"
              {...register('phone', {
                required: '請填寫手機',
                validate: (v) => isValidTWPhone(v) || '手機格式錯誤',
              })} className={inputCls} />
          </Field>
          <Field label="館別（上課場館）" error={errors.primary_venue_id?.message}>
            <select {...register('primary_venue_id', { required: '請選擇館別' })} className={inputCls}>
              <option value="">請選擇上課場館</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </Field>
          <Field label="性別">
            <select {...register('gender')} className={inputCls}>
              <option value="女">女</option><option value="男">男</option><option value="不方便透露">不方便透露</option>
            </select>
          </Field>
          <Field label="Email" error={errors.email?.message}>
            <input type="email"
              {...register('email', { required: '請填寫 Email', pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Email 格式錯誤' } })}
              className={inputCls} />
          </Field>
        </Section>

        <Section title="學員資料"
          extra={
            <button type="button"
              onClick={() => append({ name: '', id_number: '', birth_date: '', gender: '男' })}
              className="rounded-md bg-brand-teal/10 px-3 py-1 text-xs font-medium text-brand-teal active:bg-brand-teal/20">
              + 新增學員
            </button>
          }
        >
          {fields.map((f, idx) => (
            <div key={f.id} className="rounded-lg border border-gray-200 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-bold text-gray-700">學員 {idx + 1}</h4>
                {fields.length > 1 && (
                  <button type="button" onClick={() => remove(idx)} className="text-xs text-brand-error active:text-brand-error-strong">移除</button>
                )}
              </div>
              <div className="space-y-3">
                <Field label="姓名" error={errors.students?.[idx]?.name?.message}>
                  <input {...register(`students.${idx}.name`, { required: '請填寫學員姓名' })} className={inputCls} />
                </Field>
                <Field label="身分證字號" error={errors.students?.[idx]?.id_number?.message}>
                  <input {...register(`students.${idx}.id_number`, {
                    required: '請填寫身分證字號',
                    validate: (v) => isValidTWId(v) || '身分證格式錯誤（如 A123456789）',
                  })} className={`${inputCls} uppercase`} />
                </Field>
                <Field label="出生年月日" error={errors.students?.[idx]?.birth_date?.message}>
                  <input type="date" {...register(`students.${idx}.birth_date`, { required: '請選擇出生年月日' })} className={inputCls} />
                </Field>
                <Field label="性別">
                  <select {...register(`students.${idx}.gender`)} className={inputCls}>
                    <option value="男">男</option><option value="女">女</option><option value="不方便透露">不方便透露</option>
                  </select>
                </Field>
              </div>
            </div>
          ))}
        </Section>

        <button type="submit" disabled={isSubmitting}
          className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50">
          {isSubmitting ? '送出中…' : '完成註冊'}
        </button>

        {failed && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-center">
            <p className="mb-3 text-sm leading-6 text-rose-800">
              註冊未完成。請確認資料後重新送出，或透過下方按鈕回報問題。
            </p>
            <ReportIssueButton
              audience="parent"
              errorCode={errCode}
              errorMessage="家長註冊失敗"
              context="家長註冊頁"
            />
          </div>
        )}
      </form>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30';

function Section({ title, children, extra }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-brand-primary">{title}</h3>
        {extra}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, error, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs text-brand-error">{error}</span>}
    </label>
  );
}

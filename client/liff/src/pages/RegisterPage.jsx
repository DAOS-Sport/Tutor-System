import React, { useCallback, useEffect, useState } from 'react';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';

// 生日不可能在未來。釘 UTC+8 取「今天」，不吃瀏覽器時區。
const todayTaipeiYMD = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import liff from '@line/liff';
import logoMark from '../assets/logo-mark.jpg';
import { parentsApi } from '../api/parents';
import { authApi } from '../api/auth';
import { referralsApi } from '../api/referrals';
import { coachesApi } from '../api/coaches';
import { venuesApi } from '../api/venues';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { takeAfterAuth } from '../utils/afterAuth';
import { isValidTWPhone, isValidTWId } from '../utils/format';
import { cleanVenueList } from '../utils/venues';
import { USE_MOCK } from '../api/client';
import ReportIssueButton from '../components/ReportIssueButton';
import ConfirmModal from '../components/ConfirmModal';

// PENDING_COUPON_KEY（daos.pendingCoupon）已隨推薦折扣停用移除（2026-07 全站優惠清除）。
const IS_PROD = import.meta.env.PROD;
const BLOOD_TYPE_OPTIONS = ['A', 'B', 'O', 'AB', '不清楚'];
const STEP1_FIELDS = ['name', 'phone', 'email', 'primary_venue_id', 'gender'];
const STUDENT_GENDER_OPTIONS = ['生理男', '生理女', '不方便透漏'];

function tryGetLineIdToken() {
  try {
    if (typeof liff?.getIDToken === 'function' && liff.isLoggedIn?.()) {
      return liff.getIDToken() || null;
    }
  } catch { /* swallow */ }
  return null;
}

function registerErrorMessage(err) {
  const data = err?.response?.data || {};
  const code = data.code;
  const status = err?.response?.status;
  // 後端若帶了明確 error 文字（如身分證重複會帶實際號碼），優先沿用
  const serverMsg = err?.response?.data?.error;
  // 完全沒有 response：請求根本沒送達（離線 / DNS / CORS / 逾時無回應），跟「伺服器回了 4xx/5xx」不同狀況。
  if (!err?.response) return '網路連線異常，請檢查網路連線後再試一次。';
  if (/^(RAGIC_|SYNC_|LOCAL_UPSERT_|LOCAL_STUDENT_REFRESH_|PARENT_REFRESH_|Z03_RESOLVE_)/i.test(String(code || ''))) {
    return '登入資料已保留，歷史資料正在背景整理中，請勿重複註冊。';
  }

  const MAP = {
    // —— 必填 / 格式 ——
    INPUT_INVALID:            '資料不完整，請確認家長姓名、手機與至少一位學員都已填寫。',
    PHONE_FORMAT_INVALID:     '手機格式錯誤（需 09 開頭共 10 碼）。',
    EMAIL_FORMAT_INVALID:     'Email 格式錯誤，請確認後重填。',
    GENDER_REQUIRED:          '請選擇家長性別。',
    VENUE_REQUIRED:           '請選擇館別。',
    VENUE_NOT_FOUND:          '館別不存在，請重新選擇。',
    ID_NUMBER_INVALID:        '學員身分證字號格式錯誤（如 A123456789）。',
    // —— 重複 / 衝突 ——
    STUDENT_ID_NUMBER_EXISTS: '此學員身分證字號已被系統內其他學員使用，請確認是否填錯；若確為本人請聯絡客服。',
    LINE_ALREADY_REGISTERED:  '此 LINE 帳號已註冊過，請直接從 LINE 開啟連結登入。',
    LINE_ALREADY_BOUND_TO_OTHER_PHONE: '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服。',
    PHONE_ALREADY_BOUND_TO_OTHER_LINE: '此手機已綁定其他 LINE 帳號，請聯絡客服協助處理。',
    ACCOUNT_RECOVERY_REQUIRED: '此家庭已綁定其他 LINE 帳號，請完成手機所有權驗證或聯絡客服協助恢復。',
    ACCOUNT_CONFIRMATION_REQUIRED: '需要確認家庭帳號，系統已保留本次資料，請依畫面指示完成確認。',
    SYNC_IN_PROGRESS: '登入資料已保留，歷史資料正在背景整理中，請勿重複註冊。',
    DATA_RECONCILIATION_PENDING: '身分已保留，資料正在整理中；請勿重複註冊。',
    RAGIC_UID_DUPLICATE: '來源資料有重複 LINE 綁定，已停止自動覆蓋。',
    RAGIC_SCHEMA_BLOCKED: '會員已建立，外部資料欄位設定待處理。',
    RAGIC_SCHEMA_NOT_VERIFIED: '會員已建立且可登入；外部資料欄位驗證尚未完成，系統會稍後重試。',
    LOCAL_LINK_FAILED: '本地身分連結失敗，未建立重複資料，請聯絡客服。',
    // —— LINE 驗證 ——
    LINE_TOKEN_EXPIRED:        'LINE 登入已逾時，請重新由 LINE 開啟註冊頁。',
    LINE_CHANNEL_MISCONFIGURED:'系統設定異常，請聯繫客服協助處理（非您的操作問題）。',
    LINE_VERIFY_NETWORK_ERROR: '暫時無法連上 LINE 驗證服務，請稍後再試。',
    LINE_VERIFY_FAILED:       'LINE 驗證失敗，請重新由 LINE 開啟註冊頁。',
    LINE_ID_TOKEN_REQUIRED:   'LINE 驗證已逾時，請重新由 LINE 開啟註冊頁。',
    // —— 系統 / 同步 ——
    RAGIC_TIMEOUT:            'Ragic 回應較慢，請稍候片刻再試一次。',
    RAGIC_UNAVAILABLE:        '資料同步服務暫時無法連線，請稍後再試。',
    RAGIC_WRITE_FAILED:       '資料暫時無法完成同步，請稍後再試；若持續發生請聯絡客服。',
    RAGIC_CONFIGURATION_ERROR: '同步服務設定異常，請聯絡客服協助處理。',
    RAGIC_RATE_LIMITED:       '同步服務目前忙碌，請稍後再試。',
    LOCAL_UPSERT_FAILED:      '資料建檔失敗，請稍後再試；若持續發生請聯絡客服。',
    Z01_INCOMPLETE:           '會員資料尚未完整寫入，請確認必填欄位後重新送出。',
    RAGIC_REFRESH_STUDENTS_INCOMPLETE: '學員資料同步尚未完成，請稍後再試。',
    LOCAL_STUDENT_REFRESH_FAILED: '本地學員資料同步尚未完成，請稍後再試。',
    STUDENT_NAME_REQUIRED:     '請填寫每位學員姓名。',
    STUDENT_ID_REQUIRED:       '請填寫每位學員身分證字號。',
    STUDENT_BIRTH_DATE_REQUIRED: '請填寫每位學員出生年月日。',
    STUDENT_BIRTH_DATE_INVALID: '學員出生年月日格式錯誤。',
    STUDENT_GENDER_REQUIRED:   '請選擇每位學員性別。',
    STUDENT_BLOOD_TYPE_REQUIRED: '請選擇每位學員血型；不確定可選「不清楚」。',
    Z03_RESOLVE_FAILED:       '舊資料清理狀態更新失敗，請稍後再試。',
    PARENT_REFRESH_FAILED:    '會員資料重新整理失敗，請稍後再試。',
    LOGIN_FAILED:             '系統忙線，請稍後再試。',
    RATE_LIMITED:             '嘗試次數過多，請稍後再試。',
    // —— 前端自設 ——
    REGISTER_NO_STATUS:       '註冊未完成（伺服器未回傳成功狀態），請稍後再試。',
    DEMO_REGISTER_FAILED:     'Demo 測試註冊失敗，請稍後再試。',
  };
  if (code === 'ACCOUNT_RECOVERY_REQUIRED' && data.recovery_request_id && data.recovery_token) {
    return `${MAP.ACCOUNT_RECOVERY_REQUIRED} 案件編號：${data.recovery_request_id}；一次性驗證碼：${data.recovery_token}（短效，請只提供給客服）。`;
  }
  if (code && MAP[code]) return MAP[code];
  if (status === 429) return MAP.RATE_LIMITED;
  // 後端有給可讀訊息就用它，否則泛用
  if (serverMsg && typeof serverMsg === 'string') return serverMsg;
  return '註冊失敗，請稍後再試。';
}

function publicErrorCode(code) {
  const c = String(code || '');
  if (['ACCOUNT_RECOVERY_REQUIRED', 'DATA_RECONCILIATION_PENDING', 'RAGIC_UID_DUPLICATE',
    'MANUAL_REVIEW_REQUIRED', 'LOCAL_LINK_FAILED'].includes(c)) return 'ACCOUNT_CONFIRMATION_REQUIRED';
  if (/RAGIC|LOCAL_UPSERT|SYNC_/i.test(c)) return 'SYNC_IN_PROGRESS';
  return c;
}

export default function RegisterPage() {
  const [params] = useSearchParams();
  const prefilledPhone = params.get('phone') || '';
  const refToken = params.get('ref') || '';
  const demoMode = params.get('demo') === '1';
  const bindIntent = params.get('intent') === 'bind';
  const navigate = useNavigate();
  const { setParent, parent, isAuthed, role } = useAuth();
  const toast = useToast();
  const [refInfo, setRefInfo] = useState(null);
  const [refResolved, setRefResolved] = useState(false);
  // 註冊失敗 → 顯示「問題回報」按鈕（避免使用者只看到一閃即逝的 toast 而卡住）
  const [failed, setFailed] = useState(false);
  const [errCode, setErrCode] = useState('');
  const [errMsg, setErrMsg] = useState('');
  // 手機已存在於 Ragic（非本人 LINE）→ 顯示專屬引導彈窗，而非泛用錯誤卡片
  const [phoneConflict, setPhoneConflict] = useState(false);
  const [step, setStep] = useState(1);
  const [showOptional, setShowOptional] = useState(false);
  const [missingFields, setMissingFields] = useState([]);
  const authedParent = isAuthed && role === 'parent';

  function finishRegistration() {
    if (bindIntent) {
      navigate('/bind', { replace: true, state: { binding: 'success' } });
      return;
    }
    navigate(takeAfterAuth('/'), { replace: true });
  }

  // 用推薦的教練解析出有效場館（優先家長慣用場館，否則取教練第一個場館），
  // 組出帶 coach/venue/courseType 的報名頁 URL（推薦折扣 TRIAL50 已停用，僅預帶教練/場館，不再自動套券）。
  const buildRefEnrollUrl = useCallback(async (coachId, preferVenueId) => {
    let venueId = preferVenueId || '';
    try {
      const cd = await coachesApi.detail(coachId);
      const vids = cleanVenueList(cd?.venue_ids || cd?.venues || []);
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
  // 等推薦資訊載入完 → 直接導去帶該教練的報名頁（推薦折扣已停用，不再寫 pendingCoupon）。
  useEffect(() => {
    if (!authedParent || !refToken || !refResolved) return;
    let alive = true;
    (async () => {
      const coachId = refInfo?.coach?.id;
      if (!coachId) { navigate('/', { replace: true }); return; } // 推薦連結失效 → 回首頁
      // 推薦折扣（TRIAL50 體驗課 5 折）已停用（2026-07 全站優惠清除）：
      // 受推薦家長仍導向該教練報名頁，但不再自動帶入折價券。
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

  const { register, handleSubmit, control, setValue, getValues, getFieldState, trigger, formState: { errors, isSubmitting } } = useForm({
    defaultValues: {
      name: '', phone: prefilledPhone, gender: '生理女', email: '', primary_venue_id: '',
      home_phone: '', line_id: '', home_address: '',
      students: [{ name: '', id_number: '', birth_date: '', gender: '', blood_type: '' }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'students' });

  function missingFieldList(validationErrors) {
    const list = [];
    const add = (path, label, error) => {
      if (error) list.push({ path, label, message: error.message || '此欄位為必填' });
    };
    add('name', '家長姓名', validationErrors?.name);
    add('phone', '手機號碼', validationErrors?.phone);
    add('email', '家長 Email', validationErrors?.email);
    add('primary_venue_id', '館別（上課場館）', validationErrors?.primary_venue_id);
    add('gender', '家長性別', validationErrors?.gender);
    (validationErrors?.students || []).forEach((studentErrors, index) => {
      add(`students.${index}.name`, `學員 ${index + 1}－姓名`, studentErrors?.name);
      add(`students.${index}.id_number`, `學員 ${index + 1}－身分證字號`, studentErrors?.id_number);
      add(`students.${index}.birth_date`, `學員 ${index + 1}－出生年月日`, studentErrors?.birth_date);
      add(`students.${index}.gender`, `學員 ${index + 1}－性別`, studentErrors?.gender);
      add(`students.${index}.blood_type`, `學員 ${index + 1}－血型`, studentErrors?.blood_type);
    });
    return list;
  }

  function handleInvalid(validationErrors) {
    const list = missingFieldList(validationErrors);
    setMissingFields(list);
  }

  // 帶入 LINE 顯示名稱作為姓名欄位建議值（僅在使用者尚未自行填寫時才帶入，且可再編輯）
  useEffect(() => {
    (async () => {
      try {
        if (liff?.isLoggedIn?.()) {
          const p = await liff.getProfile();
          if (p?.displayName && !getValues('name')) {
            setValue('name', p.displayName, { shouldValidate: false });
          }
        }
      } catch { /* 非 LINE 環境，略過 */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function goToStep2() {
    const ok = await trigger(STEP1_FIELDS);
    if (ok) {
      setStep(2);
      return;
    }
    const stepErrors = Object.fromEntries(STEP1_FIELDS.map((path) => [path, getFieldState(path).error]));
    setMissingFields(missingFieldList(stepErrors));
  }
  function goToStep1() { setStep(1); }

  async function onSubmit(data) {
    setFailed(false);
    setPhoneConflict(false);
    setErrCode('');
    setErrMsg('');
    const cleanParent = {
      name: data.name,
      phone: data.phone.trim(),
      gender: data.gender,
      email: data.email,
      primary_venue_id: data.primary_venue_id || null,
      home_phone: data.home_phone || null,
      line_id: data.line_id || null,
      home_address: data.home_address || null,
    };
    const cleanStudents = data.students.map((s) => ({
      name: (s.name || '').trim(),
      id_number: (s.id_number || '').toUpperCase(),
      birth_date: s.birth_date || '',
      gender: s.gender || '',
      blood_type: s.blood_type || '',
    }));

    try {
      // Demo 新用戶（測試註冊）：繞過 id_token，後端以 DEMOTEST_ 前綴建測試資料。
      if (demoMode) {
        const r = await authApi.parentRegisterLine({
          demo: true,
          parent: cleanParent,
          students: cleanStudents,
          refToken: refToken || undefined,
        });
        if (r?.status === 'registered_and_logged_in' && r.parent) {
          setParent({ ...r.parent, token: r.token || r.parent.token || null });
          toast.success('Demo 測試註冊完成！已建立測試資料，自動登入');
          finishRegistration();
          return;
        }
        setErrCode('DEMO_REGISTER_FAILED');
        setErrMsg('Demo 測試註冊失敗，請稍後再試。');
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
          if (r.sync_pending || r.sync_state === 'SYNC_PENDING' || r.sync_state === 'DATA_RECONCILIATION_PENDING') {
            toast.info(r.sync_state === 'DATA_RECONCILIATION_PENDING'
              ? '登入完成，歷史資料整理中，請勿重複註冊'
              : '登入完成，Ragic 資料正在背景同步');
          }
          // MGM：ref_bound=true → 綁定推薦關係（推薦折扣 TRIAL50 已停用，不再寫 pendingCoupon）
          if (refInfo && refInfo.coach && r.ref_bound) {
            toast.success('註冊完成！請選擇組別與場館開始報名');
          } else if (refInfo && refInfo.coach && r.ref_error === 'REF_EXISTING_CUSTOMER') {
            // 舊客開通（found→update）依業務規則不適用新客推薦優惠——這是預期行為，
            // 不是綁定失敗，不可顯示「請聯絡客服」造成無謂客訴。
            toast.success('註冊完成！您是本館既有客戶，推薦優惠僅適用全新客戶');
          } else if (refInfo && refInfo.coach && r.ref_error) {
            // 推薦綁定失敗不阻擋註冊，但要告知使用者
            toast.warning('註冊完成，但推薦連結綁定失敗，請聯絡客服');
          } else {
            toast.success(bindIntent ? 'LINE 綁定成功！歡迎加入夢想體育學院' : '註冊完成！歡迎加入夢想體育學院');
          }
          if (bindIntent) {
            finishRegistration();
            return;
          }
          // 推薦註冊成功 → 直接導去帶該教練的報名頁（推薦折扣已停用，僅預帶教練）
          if (refInfo?.coach && r.ref_bound) {
            const url = await buildRefEnrollUrl(refInfo.coach.id, merged?.primary_venue_id);
            navigate(url, { replace: true });
          } else {
            navigate(takeAfterAuth('/'), { replace: true });
          }
          return;
        }
        setErrCode('REGISTER_NO_STATUS');
        setErrMsg('註冊未完成（伺服器未回傳成功狀態），請稍後再試。');
        setFailed(true);
        toast.error('註冊失敗，請稍後再試。');
        return;
      }

      // 無 id_token：
      //  - production 正式 LIFF：禁止 fallback，要求重新由 LINE 開啟
      //  - dev / mock：保留舊 parentsApi.create fallback，方便本地測試
      if (IS_PROD && !USE_MOCK) {
        setErrCode('LINE_ID_TOKEN_REQUIRED');
        setErrMsg('LINE 驗證已逾時，請重新由 LINE 開啟註冊頁。');
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
        // 推薦折扣（TRIAL50）已停用：不再寫入 pendingCoupon，改為中性完成訊息。
        toast.success('註冊完成！請選擇組別與場館開始報名');
      } else {
        toast.success('註冊完成！歡迎加入夢想體育學院');
      }
      if (bindIntent) {
        finishRegistration();
      } else if (refInfo?.coach && created?.ref_bound) {
        const url = await buildRefEnrollUrl(refInfo.coach.id, parent?.primary_venue_id);
        navigate(url, { replace: true });
      } else {
        finishRegistration();
      }
    } catch (err) {
      const code = publicErrorCode(err?.response?.data?.code || err?.code || '');
      // 手機已存在於系統（Ragic）：這不是「使用者填錯」，是身分核對議題 → 專屬引導彈窗，
      // 不提供自助認領表單；請使用者透過本館 LINE 官方帳號請客服協助核對身分（見彈窗文案）。
      if (code === 'PHONE_EXISTS_USE_BINDING') {
        setPhoneConflict(true);
        setErrCode(code);
        return;
      }
      setErrCode(code);
      setErrMsg(registerErrorMessage(err));
      setFailed(true);
      toast.error(registerErrorMessage(err));
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-slate-50">
      {/* ── Hero ── */}
      <div className="relative shrink-0 overflow-hidden bg-gradient-to-br from-brand-primary via-[#1a3d7c] to-slate-900 px-6 pb-6 pt-7 text-white">
        <div className="pointer-events-none absolute -bottom-8 -right-8 h-32 w-32 rounded-full bg-white/5 blur-2xl" />
        <div className="pointer-events-none absolute -left-8 -top-8 h-32 w-32 rounded-full bg-brand-teal/20 blur-2xl" />
        <div className="relative z-10 flex items-center gap-2.5">
          <img src={logoMark} alt="夢想體育學院 DAOS" className="h-9 w-9 rounded-xl shadow-md" />
          <h1 className="text-lg font-black tracking-wide">建立家長與學員帳號</h1>
        </div>
      </div>

      {/* ── 步驟指示器 ── */}
      <div className="flex shrink-0 items-center justify-between border-b border-gray-100 bg-white px-6 py-3.5">
        <StepDot n={1} label="家長資料" active={step === 1} done={step > 1} />
        <div className={`mx-3 h-0.5 flex-1 rounded transition-colors ${step > 1 ? 'bg-brand-primary' : 'bg-gray-200'}`} />
        <StepDot n={2} label="學員資料" active={step === 2} done={false} />
      </div>

      <div className="mx-auto w-full max-w-[420px] flex-1 px-5 py-5">
        {demoMode && (
          <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
            🧪 <b>Demo 測試註冊</b>（模擬全新未註冊用戶）。送出會<b>真的建立測試資料</b>，
            line_uid 以 <code>DEMOTEST_</code> 標記，方便事後依此前綴清除。
            請填一個<b>尚未在系統內的手機號</b>，以免撞到既有資料而被導去「手機綁定」。
          </div>
        )}

        {refInfo && (
          <div className="mb-4 rounded-xl border border-brand-green/40 bg-green-50 p-3 text-xs">
            <div className="font-bold text-brand-green">🎁 推薦連結已啟用</div>
            <div className="mt-0.5 text-gray-600">
              來自 <b>{refInfo.referrer?.name}</b> 推薦 <b>{refInfo.coach?.name}</b> 教練
            </div>
            {/* TRIAL50 推薦折扣已於 2026-07 全站優惠清除時停用，不再承諾自動套用折扣 */}
            <div className="mt-0.5 text-gray-600">完成註冊後即可預約課程與試上體驗。</div>
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit, handleInvalid)} noValidate>
          {/* ========== STEP 1：家長資料 ========== */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-brand-primary">
                  <span className="inline-block h-4 w-1.5 rounded-full bg-brand-teal" /> 家長基本資料
                </h2>
                <span className="text-[10px] font-medium text-brand-error">＊ 為必填欄位</span>
              </div>

              <IconField label="家長姓名" required icon={<IconUser />} error={errors.name?.message}>
                <input type="text" placeholder="請輸入真實姓名"
                  {...register('name', { required: '請填寫家長姓名' })}
                  className={fieldCls(!!errors.name, true)} />
              </IconField>

              <IconField label="手機號碼" required icon={<IconPhone />} error={errors.phone?.message}
                hint="舊生請填寫原登記手機，以便自動核對身分">
                <input type="tel" inputMode="numeric" placeholder="09xxxxxxxx"
                  {...register('phone', {
                    required: '請填寫手機',
                    validate: (v) => isValidTWPhone(v) || '手機格式錯誤',
                  })} className={fieldCls(!!errors.phone, true)} />
              </IconField>

              {/* Email 於 2026-08-03 改為必填：Ragic Z01「(報)Email」是必填欄，
                  本地留空的家長一律寫不回 Ragic（RAGIC_VALIDATION_ERROR INVALID 202），
                  連帶讓該家長之後每次開 App 的 /parents/me/sync 都失敗。 */}
              <IconField label="家長 Email" required icon={<IconMail />} error={errors.email?.message}>
                <input type="email" placeholder="you@example.com"
                  {...register('email', {
                    required: '請填寫 Email',
                    pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Email 格式錯誤' },
                  })}
                  className={fieldCls(!!errors.email, true)} />
              </IconField>

              <div className="grid grid-cols-2 gap-3">
                <Field label="館別（上課場館）" required error={errors.primary_venue_id?.message}>
                  <select
                    {...register('primary_venue_id', { required: '請選擇館別' })}
                    className={fieldCls(!!errors.primary_venue_id)}
                  >
                    <option value="">請選擇館別</option>
                    {venues.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="性別" required error={errors.gender?.message}>
                  <select {...register('gender', { required: '請選擇家長性別' })} className={fieldCls(!!errors.gender)}>
                    <option value="生理女">生理女</option><option value="生理男">生理男</option><option value="不方便透漏">不方便透漏</option>
                  </select>
                </Field>
              </div>

              <div className="pt-1">
                <button type="button" onClick={() => setShowOptional((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-bold text-brand-teal">
                  <span>{showOptional ? '收合選填資訊' : '展開選填資訊（住家電話／LINE ID／住家地址）'}</span>
                  <IconChevronDown className={`h-3 w-3 transition-transform ${showOptional ? 'rotate-180' : ''}`} />
                </button>
                {showOptional && (
                  <div className="mt-3 space-y-3 border-t border-dashed border-gray-200 pt-3">
                    <Field label="住家電話" optional>
                      <input type="tel" inputMode="numeric" {...register('home_phone')} className={fieldCls(false)} />
                    </Field>
                    <Field label="LINE ID" optional>
                      <input type="text" {...register('line_id')} className={fieldCls(false)} />
                    </Field>
                    <Field label="住家地址" optional>
                      <input type="text" {...register('home_address')} className={fieldCls(false)} />
                    </Field>
                  </div>
                )}
              </div>

              <button type="button" onClick={goToStep2}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-primary py-3.5 text-sm font-bold text-white shadow-lg shadow-brand-primary/25 transition active:scale-[0.99] active:bg-brand-teal">
                <span>填寫學員(學生)資料</span>
                <IconArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* ========== STEP 2：學員資料 ========== */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-bold text-brand-primary">
                  <span className="inline-block h-4 w-1.5 rounded-full bg-brand-green" /> 學員(學生)資料
                </h2>
                <button type="button"
                  onClick={() => append({ name: '', id_number: '', birth_date: '', gender: '', blood_type: '' })}
                  className="flex items-center gap-1 rounded-full bg-brand-green/10 px-3 py-1.5 text-xs font-bold text-brand-green active:bg-brand-green/20">
                  <IconPlus className="h-3 w-3" /> 新增學員
                </button>
              </div>
              <p className="text-[11px] leading-4 text-gray-400">
                學員資料皆為必填；身分證字號將用於銜接您先前的上課資料，請務必正確填寫。
              </p>

              <div className="space-y-3">
                {fields.map((f, idx) => (
                  <div key={f.id} className="rounded-2xl border border-gray-200 bg-white p-3.5 shadow-sm">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1 text-xs font-black text-gray-500">
                        學員 {idx + 1}
                      </span>
                      {fields.length > 1 && (
                        <button type="button" onClick={() => remove(idx)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition active:bg-brand-error-soft active:text-brand-error">
                          <IconTrash className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    <div className="space-y-3">
                      <Field label="學員姓名" required error={errors.students?.[idx]?.name?.message}>
                        <input placeholder="請填入學生真實姓名"
                          {...register(`students.${idx}.name`, { required: '請填寫學員姓名' })}
                          className={fieldCls(!!errors.students?.[idx]?.name)} />
                      </Field>
                      <Field label="身分證字號" required error={errors.students?.[idx]?.id_number?.message}>
                        <input placeholder="A123456789"
                          {...register(`students.${idx}.id_number`, {
                            required: '請填寫身分證字號',
                            validate: (v) => isValidTWId(v) || '身分證格式錯誤（如 A123456789）',
                          })} className={`${fieldCls(!!errors.students?.[idx]?.id_number)} uppercase`} />
                      </Field>
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="出生年月日" required error={errors.students?.[idx]?.birth_date?.message}>
                          {/* 非原生 input，改用 Controller 接進 react-hook-form；
                              {...register} 那組 onChange/ref 對自繪元件無效。 */}
                          <Controller
                            control={control}
                            name={`students.${idx}.birth_date`}
                            rules={{ required: '請填寫出生年月日' }}
                            render={({ field }) => (
                              <DateTimePicker
                                value={field.value || ''}
                                max={todayTaipeiYMD()}
                                onChange={field.onChange}
                                placeholder="出生年月日"
                              />
                            )}
                          />
                        </Field>
                        <Field label="性別" required error={errors.students?.[idx]?.gender?.message}>
                          <select
                            {...register(`students.${idx}.gender`, { required: '請選擇性別' })}
                            className={fieldCls(!!errors.students?.[idx]?.gender)}
                          >
                            <option value="">請選擇</option>
                            {STUDENT_GENDER_OPTIONS.map((g) => (
                              <option key={g} value={g}>{g}</option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <Field label="血型" required error={errors.students?.[idx]?.blood_type?.message}>
                        <select
                          {...register(`students.${idx}.blood_type`, { required: '請選擇血型；不確定可選「不清楚」' })}
                          className={fieldCls(!!errors.students?.[idx]?.blood_type)}
                        >
                          <option value="">請選擇</option>
                          {BLOOD_TYPE_OPTIONS.map((type) => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  </div>
                ))}
              </div>

              <div className="space-y-2 pt-2">
                <button type="submit" disabled={isSubmitting}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 py-3.5 text-sm font-bold text-white shadow-lg transition active:scale-[0.99] active:bg-slate-800 disabled:opacity-50">
                  <IconCheck className="h-4 w-4" />
                  <span>{isSubmitting ? '送出中…' : '確認並送出註冊'}</span>
                </button>
                <button type="button" onClick={goToStep1}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white py-3 text-sm font-bold text-gray-500 transition active:bg-gray-50">
                  <IconChevronLeft className="h-4 w-4" />
                  <span>回上一步修正</span>
                </button>
              </div>
            </div>
          )}

          {failed && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-center">
              <p className="mb-1 text-sm font-bold leading-6 text-rose-800">
                {errMsg || '註冊未完成，請確認資料後重新送出。'}
              </p>
              <p className="mb-3 text-xs leading-5 text-rose-600">
                請依上方訊息修正後重新送出；若無法解決，請透過下方按鈕回報問題{errCode ? `（錯誤碼：${errCode}）` : ''}。
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

      <div className="flex shrink-0 items-center justify-center gap-1.5 border-t border-gray-100 bg-white py-3 text-[10px] text-gray-400">
        <IconShield className="h-3 w-3 text-brand-green" />
        <span>您的資料已受妥善保管，並遵守個人資料保護法</span>
      </div>

      {/* ── 手機衝突引導彈窗 ── */}
      {phoneConflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="relative bg-gradient-to-br from-amber-400 to-amber-600 p-6 text-center text-white">
              <div className="pointer-events-none absolute -bottom-6 -right-6 h-20 w-20 rounded-full bg-white/10 blur-lg" />
              <div className="relative z-10 mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-white/20">
                <IconInfo className="h-7 w-7" />
              </div>
              <h3 className="relative z-10 text-base font-black">此手機號碼在系統中已有資料</h3>
            </div>
            <div className="p-5">
              <p className="text-xs leading-6 text-gray-600">
                為了保護個人資料，我們無法自動核對身分。請截圖此畫面，回到<b className="text-gray-800">本館 LINE 官方帳號</b>洽詢客服協助核對並綁定；
                若這支手機其實是您本人先前使用過的舊帳號，也可以直接返回登入頁，用目前這個 LINE 帳號重新登入一次。
              </p>
            </div>
            <div className="space-y-2 border-t border-gray-100 bg-gray-50 p-5">
              <button type="button" onClick={() => navigate('/login')}
                className="w-full rounded-xl bg-brand-primary py-3 text-sm font-bold text-white shadow-lg shadow-brand-primary/20 transition active:scale-[0.99]">
                返回登入頁
              </button>
              <button type="button" onClick={() => setPhoneConflict(false)}
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 text-xs font-bold text-gray-500 transition active:bg-gray-100">
                關閉，我再確認一次資料
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={missingFields.length > 0}
        title={`尚有 ${missingFields.length} 個欄位需要補填`}
        confirmLabel="知道了"
        cancelLabel="關閉"
        onCancel={() => setMissingFields([])}
        onConfirm={() => setMissingFields([])}
      >
        <p className="mb-3 text-xs leading-5 text-gray-500">請完成以下資料後再送出。</p>
        <div className="space-y-2">
          {missingFields.map((item) => (
            <div
              key={item.path}
              className="rounded-xl border border-rose-100 bg-rose-50 px-3 py-2.5"
            >
              <span className="block text-xs font-bold text-rose-800">{item.label}</span>
              <span className="mt-0.5 block text-[11px] text-rose-600">{item.message}</span>
            </div>
          ))}
        </div>
      </ConfirmModal>
    </div>
  );
}

const inputCls = 'w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-brand-teal focus:ring-4 focus:ring-brand-teal/10';
const inputWithIconCls = 'w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3.5 text-sm outline-none transition focus:border-brand-teal focus:ring-4 focus:ring-brand-teal/10';
const errInputCls = 'border-brand-error bg-brand-error-soft focus:border-brand-error focus:ring-brand-error/10';
function fieldCls(hasErr, withIcon) {
  return `${withIcon ? inputWithIconCls : inputCls} ${hasErr ? errInputCls : ''}`;
}

function StepDot({ n, label, active, done }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-colors ${
        active || done ? 'bg-brand-primary text-white shadow-md shadow-brand-primary/20' : 'bg-gray-200 text-gray-500'
      }`}>
        {n}
      </div>
      <span className={`text-xs transition-colors ${active ? 'font-bold text-gray-800' : 'font-medium text-gray-400'}`}>
        {label}
      </span>
    </div>
  );
}

function Field({ label, error, required, optional, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-1 text-xs font-bold text-gray-600">
        {label}
        {required && <span className="text-brand-error">＊</span>}
        {optional && <span className="font-normal text-gray-300">（選填）</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-[11px] leading-4 text-gray-400">{hint}</span>}
      {error && <span className="mt-1 block text-[11px] font-medium text-brand-error">{error}</span>}
    </label>
  );
}

// 帶左側圖示的欄位（家長資料主要三欄：姓名／手機／Email）
function IconField({ label, error, required, hint, icon, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-1 text-xs font-bold text-gray-600">
        {label}
        {required && <span className="text-brand-error">＊</span>}
      </span>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
          {icon}
        </span>
        {children}
      </div>
      {hint && !error && <span className="mt-1 block text-[11px] leading-4 text-gray-400">{hint}</span>}
      {error && <span className="mt-1 block text-[11px] font-medium text-brand-error">{error}</span>}
    </label>
  );
}

// ── 內嵌 SVG 圖示（Feather 風格 stroke，免外部圖示庫依賴）──────────────────
function IconBase({ d, className = 'h-4 w-4', extra }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
      {extra}
    </svg>
  );
}
function IconUser(props) { return <IconBase {...props} d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" extra={<circle cx="12" cy="7" r="4" />} />; }
function IconPhone(props) { return <IconBase {...props} d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />; }
function IconMail(props) { return <IconBase {...props} d={['M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z', 'm22 6-10 7L2 6']} />; }
function IconChevronDown(props) { return <IconBase {...props} d="m6 9 6 6 6-6" />; }
function IconChevronLeft(props) { return <IconBase {...props} d="m15 18-6-6 6-6" />; }
function IconArrowRight(props) { return <IconBase {...props} d={['M5 12h14', 'm12 5 7 7-7 7']} />; }
function IconPlus(props) { return <IconBase {...props} d="M12 5v14M5 12h14" />; }
function IconTrash(props) { return <IconBase {...props} d={['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2']} />; }
function IconCheck(props) { return <IconBase {...props} d="M20 6 9 17l-5-5" />; }
function IconShield(props) { return <IconBase {...props} d={['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'm9 12 2 2 4-4']} />; }
function IconInfo(props) { return <IconBase {...props} d={['M12 16v-4', 'M12 8h.01']} extra={<circle cx="12" cy="12" r="10" />} />; }

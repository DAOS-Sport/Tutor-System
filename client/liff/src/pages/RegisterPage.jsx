import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { parentsApi } from '../api/parents';
import { referralsApi } from '../api/referrals';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidTWPhone, isValidTWId } from '../utils/format';

const PENDING_COUPON_KEY = 'daos.pendingCoupon';

export default function RegisterPage() {
  const [params] = useSearchParams();
  const prefilledPhone = params.get('phone') || '';
  const refToken = params.get('ref') || '';
  const navigate = useNavigate();
  const { setParent } = useAuth();
  const toast = useToast();
  const [refInfo, setRefInfo] = useState(null);

  // 讀取推薦連結資訊（推薦人 / 教練）
  useEffect(() => {
    if (!refToken) return;
    let alive = true;
    referralsApi.byToken(refToken)
      .then((d) => alive && setRefInfo(d))
      .catch(() => alive && toast.warning('推薦連結資訊載入失敗'));
    return () => { alive = false; };
  }, [refToken, toast]);

  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm({
    defaultValues: {
      name: '', phone: prefilledPhone, gender: '女', email: '',
      students: [{ name: '', id_number: '', birth_date: '', gender: '男' }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'students' });

  async function onSubmit(data) {
    try {
      const created = await parentsApi.create({
        ...data,
        phone: data.phone.trim(),
        ref_token: refToken || undefined,
        students: data.students.map((s) => ({ ...s, id_number: s.id_number.toUpperCase() })),
      });
      setParent(created);
      // MGM：成功綁定推薦 → 寫入 pendingCoupon，導回首頁讓家長挑組別 → 系統會在對應教練的報名頁自動套用
      if (refInfo && refInfo.coach && created?.ref_bound) {
        try { localStorage.setItem(PENDING_COUPON_KEY, JSON.stringify({ coupon: 'TRIAL50', coachId: refInfo.coach.id })); } catch { /* noop */ }
        toast.success(`註冊完成！請選擇組別與場館後即可享 ${refInfo.coach.name} 教練體驗課 5 折`);
        navigate('/', { replace: true });
        return;
      }
      toast.success('註冊完成！歡迎加入夢想體育學院');
      navigate('/', { replace: true });
    } catch (err) {
      toast.error('註冊失敗，請稍後再試');
    }
  }

  return (
    <div className="px-4 py-4">
      <h2 className="mb-1 text-lg font-bold text-brand-primary">建立家長帳號</h2>
      <p className="mb-3 text-xs text-gray-500">系統會將資料同步寫入 Ragic 家長／學員資料表</p>

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
          <Field label="性別">
            <select {...register('gender')} className={inputCls}>
              <option value="女">女</option><option value="男">男</option><option value="不方便透露">不方便透露</option>
            </select>
          </Field>
          <Field label="Email（選填）" error={errors.email?.message}>
            <input type="email"
              {...register('email', { pattern: { value: /^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Email 格式錯誤' } })}
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

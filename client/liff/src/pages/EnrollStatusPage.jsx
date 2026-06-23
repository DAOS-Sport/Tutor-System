import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { coursesApi } from '../api/courses';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel, formatTWD } from '../utils/format';

/**
 * 報名狀態頁（U10）— 一般報名「送出後的審核等候畫面」。
 * 顯示應繳金額、轉帳帳號、上傳匯款證明、狀態（待繳款→已上傳待櫃台確認→已確認）。
 * 若此報名屬於團報（group_order_id），引導到團購狀態頁（可見其他家庭繳費狀態）。
 */
const STATUS_META = {
  pending_payment: { label: '待繳款／待櫃台確認', cls: 'bg-brand-gold/15 text-brand-gold' },
  confirmed: { label: '已確認・課程已開通', cls: 'bg-brand-green/15 text-brand-green' },
  active: { label: '進行中', cls: 'bg-brand-green/15 text-brand-green' },
  payment_anomaly: { label: '帳款異常，請聯繫櫃台', cls: 'bg-brand-error/10 text-brand-error' },
  refunded: { label: '已退費', cls: 'bg-gray-100 text-gray-500' },
};

export default function EnrollStatusPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [enr, setEnr] = useState(undefined); // undefined=loading, null=error
  const [proofBusy, setProofBusy] = useState(false);
  const [transferLast5, setTransferLast5] = useState('');
  const [carrier, setCarrier] = useState('');
  const [proofFile, setProofFile] = useState(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const proofInputRef = useRef(null);

  const load = useCallback(() => {
    let alive = true;
    coursesApi.get(id)
      .then((d) => alive && setEnr(d || null))
      .catch(() => alive && setEnr(null));
    return () => { alive = false; };
  }, [id]);

  useEffect(() => load(), [load]);
  useEffect(() => {
    if (enr) {
      setTransferLast5(enr.transfer_last_5 || '');
      // 載具：優先用報名已存值，否則帶入瀏覽器快取（上次填過的載具），免重複輸入。
      setCarrier(enr.carrier || localStorage.getItem('daos_invoice_carrier') || '');
      setProofFile(null);
    }
  }, [enr?.id, enr?.transfer_last_5, enr?.has_payment_proof, enr?.carrier]);

  if (enr === undefined) return <LoadingSpinner fullPage label="載入報名狀態…" />;
  if (enr === null) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-3 text-sm text-brand-error">找不到此報名</div>
        <button type="button" onClick={() => navigate('/my-courses', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">前往我的課程</button>
      </div>
    );
  }

  const meta = STATUS_META[enr.payment_status] || { label: enr.payment_status, cls: 'bg-gray-100 text-gray-500' };
  const v = enr.venue || {};
  const canUpload = enr.payment_status === 'pending_payment';
  // 末碼＋證明都送出後即唯讀（移除家長自行重編入口）；需更改請聯繫櫃檯。
  // 用 AND（兩者皆備＝已送出）避免半填狀態被鎖死而無法補齊。
  const paymentLocked = canUpload && enr.has_payment_proof && !!enr.transfer_last_5;

  async function copyAccount() {
    if (!v.account_number) {
      toast.error('此場館尚未設定轉帳帳號，請聯繫櫃台');
      return;
    }
    try {
      await navigator.clipboard.writeText(v.account_number);
      toast.success('已複製帳號！');
    } catch {
      toast.error('複製失敗，請手動複製');
    }
  }

  function selectProofFile(file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast.error('只接受 JPG / PNG 圖片');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('圖片大小不得超過 5MB');
      return;
    }
    setProofFile(file);
  }

  async function handleConfirmPayment() {
    if (!/^\d{5}$/.test(transferLast5.trim())) return toast.error('請先填寫 5 位數字的轉帳末碼');
    if (!proofFile && !enr.has_payment_proof) return toast.error('請選擇匯款／轉帳證明');
    setProofBusy(true);
    try {
      let url = null;
      if (proofFile) {
        const uploaded = await enrollmentsApi.uploadPaymentProof(proofFile);
        url = uploaded?.url || null;
        if (!url) throw new Error('no url');
      }
      await coursesApi.uploadProof(id, {
        transfer_last_5: transferLast5.trim(),
        payment_proof_url: url || undefined,
        carrier: carrier.trim() || undefined,
      });
      // 載具快取：記住本次填寫，下次報名/付款自動帶入（純前端 localStorage）。
      if (carrier.trim()) localStorage.setItem('daos_invoice_carrier', carrier.trim());
      toast.success('付款資料已送出，待櫃台確認');
      setProofFile(null);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '送出失敗，請重試');
    } finally {
      setProofBusy(false);
    }
  }

  async function handleCancelEnrollment() {
    if (cancelBusy) return;
    const ok = window.confirm('確定取消這筆未完成報名？取消後若要上課需重新報名。');
    if (!ok) return;
    setCancelBusy(true);
    try {
      await coursesApi.cancelPending(id);
      toast.success('已取消未完成報名');
      navigate('/my-courses', { replace: true });
    } catch (e) {
      toast.error(e?.response?.data?.error || '取消失敗');
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-brand-primary">
            {courseTypeLabel(enr.course_type)} 報名
            {enr.period_count > 1 && <span className="ml-1.5 text-xs font-bold text-brand-gold">· {enr.period_count} 期</span>}
          </h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.cls}`}>{meta.label}</span>
        </div>
        <p className="mt-2 text-xs text-gray-500">教練：{enr.coach || '—'}・學員：{(enr.students || []).join('、') || '—'}</p>
        <div className="mt-2 flex items-baseline justify-between border-t border-gray-100 pt-2">
          <span className="text-sm font-bold text-gray-700">應繳金額</span>
          <span className="text-xl font-bold text-brand-primary">{formatTWD(enr.final_price)}</span>
        </div>
      </div>

      {enr.group_order_id && (
        <button type="button" onClick={() => navigate(`/group/${enr.group_order_id}`)}
          className="mb-4 w-full rounded-lg border border-brand-teal py-2.5 text-sm font-bold text-brand-teal active:bg-brand-teal/10">
          這是團報 → 查看團購狀態（含其他家庭繳費狀態）
        </button>
      )}

      {/* 轉帳資訊 */}
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
        <h3 className="mb-2 text-xs font-bold text-gray-600">轉帳資訊</h3>
        <div className="space-y-1 text-sm text-gray-700">
          <div>戶名：{v.account_holder || '—'}</div>
          <div>銀行：{[v.bank_institution_name, v.bank_branch_name].filter(Boolean).join(' ') || '—'}</div>
        </div>
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-brand-primary/5 p-3">
          <div className="flex-1">
            <div className="text-[11px] text-gray-500">帳號</div>
            <div className="font-mono text-base font-bold text-brand-primary">{v.account_number || '—'}</div>
          </div>
          <button type="button" onClick={copyAccount} disabled={!v.account_number}
            className="rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white active:bg-brand-primary disabled:bg-gray-300">一鍵複製</button>
        </div>
        {!v.account_number && (
          <p className="mt-2 text-xs text-brand-error">此場館尚未設定轉帳帳號，請聯繫櫃台後再完成轉帳。</p>
        )}
      </div>

      {/* 匯款證明 */}
      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <h3 className="mb-1 text-xs font-bold text-gray-600">匯款／轉帳證明</h3>
        <label className="mt-2 block text-xs font-medium text-gray-600" htmlFor="transfer-last5">轉帳末 5 碼</label>
        <input
          id="transfer-last5"
          type="tel"
          inputMode="numeric"
          maxLength={5}
          value={transferLast5}
          disabled={!canUpload || proofBusy || paymentLocked}
          onChange={(e) => setTransferLast5(e.target.value.replace(/\D/g, '').slice(0, 5))}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-brand-teal focus:outline-none disabled:bg-gray-50"
          placeholder="5 位數字"
        />
        {enr.has_payment_proof ? (
          <p className="mt-2 text-sm font-medium text-brand-gold">✓ 已上傳，等待櫃台確認帳款</p>
        ) : (
          <p className="mt-2 text-sm text-gray-500">尚未上傳。請先完成轉帳，再填末 5 碼並上傳證明。</p>
        )}
        {paymentLocked && (
          <p className="mt-1 text-[11px] text-gray-400">已送出，需更改請聯繫櫃檯。</p>
        )}
        {canUpload && !paymentLocked && (
          <>
            <input
              ref={proofInputRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              disabled={proofBusy}
              onChange={(e) => selectProofFile(e.target.files?.[0])}
            />
            <button
              type="button"
              disabled={proofBusy}
              onClick={() => proofInputRef.current?.click()}
              className="mt-2 w-full rounded-lg border border-dashed border-brand-teal/50 px-3 py-3 text-sm font-bold text-brand-teal disabled:opacity-50"
            >
              {proofFile ? `已選：${proofFile.name}` : (enr.has_payment_proof ? '更換匯款證明' : '選擇匯款證明')}
            </button>
            <button
              type="button"
              disabled={proofBusy || !/^\d{5}$/.test(transferLast5.trim()) || (!proofFile && !enr.has_payment_proof)}
              onClick={handleConfirmPayment}
              className="mt-2 w-full rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white disabled:bg-gray-300"
            >
              {proofBusy ? '送出中…' : '確認無誤，送出付款資料'}
            </button>
          </>
        )}
      </div>

      {/* 載具（電子發票，選填）：隨付款資料一起送出，櫃檯開發票時產生條碼掃描。 */}
      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3">
        <h3 className="mb-1 text-xs font-bold text-gray-600">載具（電子發票，選填）</h3>
        {canUpload && !paymentLocked ? (
          <>
            <input
              type="text"
              value={carrier}
              disabled={proofBusy}
              onChange={(e) => setCarrier(e.target.value.slice(0, 64))}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-brand-teal focus:outline-none disabled:bg-gray-50"
              placeholder="手機條碼載具，例如 /ABC+123"
            />
            <p className="mt-1 text-[11px] text-gray-400">將與上方付款資料一起送出；可留空。</p>
          </>
        ) : (
          <p className="mt-1 text-sm text-gray-700">{carrier || '—'}</p>
        )}
      </div>

      {canUpload && !enr.group_order_id && (
        <button
          type="button"
          disabled={cancelBusy}
          onClick={handleCancelEnrollment}
          className="mt-2 w-full rounded-lg border border-brand-error/40 py-2.5 text-sm font-bold text-brand-error disabled:opacity-50"
        >
          {cancelBusy ? '取消中…' : '取消報名'}
        </button>
      )}
    </div>
  );
}

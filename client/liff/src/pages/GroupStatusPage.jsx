import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import liff from '@line/liff';
import { groupOrdersApi } from '../api/groupOrders';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';
import { isPaymentProofCandidate, PAYMENT_PROOF_ACCEPT } from '../utils/paymentProofImage';

const money = (n) => `NT$ ${Number(n || 0).toLocaleString()}`;

// 家長端 LIFF App ID（與 main.jsx / LoginPage 同來源）。分享到 LINE 的加入連結要用
// LIFF 形式（liff.line.me/<id>/...），在 LINE 內點開才會帶 LIFF session → 自動取 id_token
// → 跑 LoginPage 的「自動驗證→登入→建檔」流程。無 LIFF ID（dev/瀏覽器）時退回 raw 網址。
const PARENT_LIFF_ID = import.meta.env.VITE_LIFF_ID_PARENT || import.meta.env.VITE_LIFF_ID;
function buildJoinUrl(token) {
  if (!token) return '';
  return PARENT_LIFF_ID
    ? `https://liff.line.me/${PARENT_LIFF_ID}/group/join/${token}`
    : `${window.location.origin}/liff/group/join/${token}`;
}

const STATUS_META = {
  forming: { label: '揪團中', cls: 'bg-brand-teal/15 text-brand-teal' },
  submitted: { label: '審核中', cls: 'bg-brand-gold/15 text-brand-gold' },
  approved: { label: '已成團', cls: 'bg-brand-green/15 text-brand-green' },
  rejected: { label: '已退回', cls: 'bg-brand-error/10 text-brand-error' },
  cancelled: { label: '已取消', cls: 'bg-gray-100 text-gray-500' },
};

export default function GroupStatusPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [order, setOrder] = useState(undefined); // undefined=loading, null=error
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'submit' | 'cancel' | null
  const [proofBusy, setProofBusy] = useState(false);
  const [transferLast5, setTransferLast5] = useState('');
  const [carrier, setCarrier] = useState('');
  const [proofFile, setProofFile] = useState(null);
  const [lineName, setLineName] = useState('');
  const proofInputRef = useRef(null);
  // 檔案已上傳、但 my-proof API 回應在網路中斷時，重試必須沿用同一 URL；
  // 否則重傳同一張圖會產生新 URL，被後端的 anti-overwrite lock 誤判成不同證明。
  const uploadedProofUrlRef = useRef(null);

  // 取家長的 LINE 顯示名稱，組分享訊息用（在 LINE 內才拿得到；dev/瀏覽器時靜默略過）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (liff?.isLoggedIn?.()) {
          const p = await liff.getProfile();
          if (alive && p?.displayName) setLineName(p.displayName);
        }
      } catch { /* 非 LINE 環境，退回用報名姓名 */ }
    })();
    return () => { alive = false; };
  }, []);

  const load = useCallback(() => {
    let alive = true;
    groupOrdersApi.get(id)
      .then((d) => alive && setOrder(d || null))
      .catch(() => alive && setOrder(null));
    return () => { alive = false; };
  }, [id]);

  useEffect(() => load(), [load]);
  // 只在「伺服器已存的末碼」有值且變動時回填（例如曾送出過或送出成功後）；
  // 不清空使用者輸入中的末碼／已選檔案，避免揪團中每 6 秒輪詢把填到一半的內容洗掉。
  const selfSavedLast5 = ((order?.members || []).find((m) => m.is_self)?.transfer_last_5) || '';
  const selfSavedCarrier = ((order?.members || []).find((m) => m.is_self)?.carrier) || '';
  useEffect(() => {
    if (selfSavedLast5) setTransferLast5(selfSavedLast5);
  }, [order?.id, selfSavedLast5]);
  useEffect(() => {
    if (selfSavedCarrier) setCarrier(selfSavedCarrier);
    else if (order?.id) setCarrier((current) => current || localStorage.getItem('daos_invoice_carrier') || '');
  }, [order?.id, selfSavedCarrier]);

  // 揪團中自動輪詢，讓團主在頁面上即時看到新加入的成員/學生（不必手動重整）
  useEffect(() => {
    if (order?.status !== 'forming') return undefined;
    const t = setInterval(() => {
      groupOrdersApi.get(id).then((d) => d && setOrder(d)).catch(() => {});
    }, 6000);
    return () => clearInterval(t);
  }, [order?.status, id]);

  if (order === undefined) return <LoadingSpinner fullPage label="載入團購狀態…" />;
  if (order === null) {
    return (
      <div className="px-4 py-10 text-center">
        <div className="mb-3 text-sm text-brand-error">找不到此團購</div>
        <button type="button" onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white">回首頁</button>
      </div>
    );
  }

  const meta = STATUS_META[order.status] || { label: order.status, cls: 'bg-gray-100 text-gray-500' };
  const reachedMin = order.total_students >= order.min_students;
  const allPaymentConfirmed = (order.members || []).length > 0 && (order.members || []).every((m) => m.payment_confirmed);
  const selfMember = (order.members || []).find((m) => m.is_self) || null;
  const selfPaymentReady = !!(selfMember?.has_payment_proof && selfMember?.transfer_last_5);
  const missingPaymentCount = (order.members || []).filter((m) => !m.payment_confirmed).length;
  // U14 送審守門：全團都要「末 5 碼 + 匯款證明」皆備才可送審。
  // has_payment_info 是後端新增的布林（他家的 transfer_last_5 不外露，無法在前端自行判斷）。
  // 向後相容：舊 API 沒有這個欄位時退回只看 has_payment_proof，
  // 避免前端先上線／CDN 還吐舊 bundle 的時間差把所有送審鈕鎖死。
  const memberPaymentReady = (m) => (
    m.has_payment_info === undefined ? !!m.has_payment_proof : !!m.has_payment_info
  );
  const unpaidMembers = (order.members || []).filter((m) => !memberPaymentReady(m));
  const allPaymentReady = (order.members || []).length > 0 && unpaidMembers.length === 0;
  const v = order.venue || {};
  const joinUrl = order.is_leader ? buildJoinUrl(order.join_token) : null;
  const canCancelGroup = order.is_leader && ['forming', 'submitted'].includes(order.status);

  // 分享訊息：{家長LINE名稱}邀請您一同來參加{教練名稱}的{幾V幾}家教班\n加入連結👉{LIFF連結}
  function buildInviteMessage() {
    const inviter = lineName || selfMember?.parent_name || '家長';
    const coach = order.coach_name || '教練';
    const fmt = courseTypeLabel(order.course_type);
    return `${inviter}邀請您一同來參加${coach}的${fmt}家教班\n加入連結👉${joinUrl}`;
  }

  async function shareInvite() {
    const message = buildInviteMessage();
    // 1) 手機原生分享面板（Web Share API）——「按下去自動分享」最貼近的體驗
    if (navigator.share) {
      try {
        await navigator.share({ text: message });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return; // 使用者自行取消，不視為錯誤
        // 其餘情況往下退回 LINE / 複製
      }
    }
    // 2) 退回 LINE 分享（in-app 或無 Web Share API 時）
    try {
      window.open(`https://line.me/R/msg/text/?${encodeURIComponent(message)}`, '_blank');
      return;
    } catch { /* 再退回複製 */ }
    // 3) 最後退回複製整段訊息
    try {
      await navigator.clipboard.writeText(message);
      toast.success('邀請訊息已複製，貼到群組分享吧！');
    } catch {
      toast.error('分享失敗，請手動複製連結');
    }
  }

  async function copyAccount() {
    try {
      await navigator.clipboard.writeText(v.account_number || '');
      toast.success('已複製帳號！');
    } catch {
      toast.error('複製失敗，請手動複製');
    }
  }

  // U10：成員上傳自己的轉帳證明（先傳檔取得 URL，再記到本團我的那筆 member）
  function selectProofFile(file) {
    if (!file) return;
    if (!isPaymentProofCandidate(file)) {
      toast.error('請上傳 JPG、PNG、WebP、HEIC、HEIF 或 AVIF 圖片');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('圖片大小不得超過 5MB');
      return;
    }
    uploadedProofUrlRef.current = null;
    setProofFile(file);
  }

  async function handleConfirmPayment(m) {
    if (!/^\d{5}$/.test(transferLast5.trim())) return toast.error('請先填寫 5 位數字的轉帳末碼');
    if (!proofFile && !m?.has_payment_proof) return toast.error('請選擇匯款／轉帳證明');
    setProofBusy(true);
    // 末碼與證明「解耦」：圖片上傳失敗也要先把末碼存下供櫃檯對帳（同 EnrollStatusPage 修正）。
    let url = uploadedProofUrlRef.current;
    let uploadFailed = false;
    if (proofFile && !url) {
      try {
        const uploaded = await enrollmentsApi.uploadPaymentProof(proofFile, {
          targetType: 'group_order',
          targetId: id,
        });
        url = uploaded?.url || null;
        if (!url) throw new Error('no url');
        uploadedProofUrlRef.current = url;
      } catch {
        uploadFailed = true;
      }
    }
    try {
      const updated = await groupOrdersApi.uploadMyProof(id, {
        transfer_last_5: transferLast5.trim(),
        payment_proof_url: url || undefined,
        carrier: carrier.trim() || undefined,
      });
      if (carrier.trim()) localStorage.setItem('daos_invoice_carrier', carrier.trim());
      if (updated) setOrder(updated); else load();
      if (uploadFailed) {
        // 末碼已存，留著 proofFile 讓成員可直接重試上傳證明。
        toast.error('末碼已送出，但證明圖片上傳失敗，請稍後重新上傳證明');
      } else {
        uploadedProofUrlRef.current = null;
        setProofFile(null);
        toast.success('付款資料已送出，待櫃檯確認');
      }
    } catch (e) {
      toast.error(e?.response?.data?.error || '送出失敗，請重試');
    } finally {
      setProofBusy(false);
    }
  }

  async function doAction(kind) {
    setBusy(true);
    try {
      if (kind === 'submit') {
        await groupOrdersApi.submit(id);
        toast.success('已送審，等待櫃檯核准');
      } else {
        await groupOrdersApi.cancel(id);
        toast.success('團購已取消');
      }
      setConfirm(null);
      load();
    } catch (e) {
      const d = e?.response?.data;
      // U14：後端送審守門擋下時列出待補家庭（姓名後端已遮罩），並重抓最新狀態，
      // 讓別的裝置剛補齊的資料能即時反映到按鈕上。
      if (d?.code === 'MISSING_PAYMENT_PROOF' && Array.isArray(d.pending_members) && d.pending_members.length) {
        toast.error(`${d.pending_members.map((m) => m.parent_name).filter(Boolean).join('、')} 尚未備齊付款資料，請提醒後再送審`);
        setConfirm(null);
        load();
      } else {
        toast.error(d?.error || '操作失敗');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-brand-primary">
            {courseTypeLabel(order.course_type)} 團購
            {order.period_count > 1 && (
              <span className="ml-1.5 align-middle text-xs font-bold text-brand-gold">· {order.period_count} 期</span>
            )}
          </h2>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.cls}`}>{meta.label}</span>
        </div>
        <p className="mt-2 text-sm text-gray-700">
          目前 <span className="font-bold text-brand-primary">{order.total_students}</span> 人
          <span className="text-gray-400">（開團需 {order.min_students}–{order.max_students} 人）</span>
        </p>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div className={`h-full rounded-full transition-all ${reachedMin ? 'bg-brand-green' : 'bg-brand-gold'}`}
            style={{ width: `${Math.min(100, Math.round((order.total_students / order.max_students) * 100))}%` }} />
        </div>
        {order.note && <p className="mt-2 text-xs text-gray-500">備註：{order.note}</p>}
        {order.status === 'rejected' && order.reject_reason && (
          <p className="mt-2 rounded-lg bg-brand-error/5 px-2 py-1 text-xs text-brand-error">退回原因：{order.reject_reason}</p>
        )}
      </div>

      {order.is_leader && order.status === 'forming' && joinUrl && (
        <div className="mb-4 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
          <label className="mb-1 block text-xs font-medium text-gray-600">邀請其他學員加入</label>
          <button type="button" onClick={shareInvite}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-teal px-3 py-2.5 text-sm font-bold text-white active:bg-brand-primary">
            <span aria-hidden>📤</span> 分享邀請
          </button>
          <p className="mt-1.5 text-[11px] text-gray-500">分享給其他家長，用 LINE 登入即可加入。</p>
        </div>
      )}

      {['forming', 'submitted', 'approved'].includes(order.status) && !allPaymentConfirmed && (
        <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
          <h3 className="mb-2 text-xs font-bold text-gray-600">轉帳資訊</h3>
          <div className="space-y-1 text-sm text-gray-700">
            <div>戶名：{v.account_holder || '—'}</div>
            <div>銀行：{[v.bank_institution_name, v.bank_branch_name].filter(Boolean).join(' ') || '—'}</div>
          </div>
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-brand-primary/5 p-3">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-gray-500">帳號</div>
              <div className="truncate font-mono text-base font-bold text-brand-primary">{v.account_number || '—'}</div>
            </div>
            <button
              type="button"
              onClick={copyAccount}
              disabled={!v.account_number}
              className="shrink-0 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white active:bg-brand-primary disabled:bg-gray-300"
            >
              一鍵複製
            </button>
          </div>
          {!v.account_number && (
            <p className="mt-2 text-xs text-brand-error">此場館尚未設定轉帳帳號，請聯繫櫃台後再完成轉帳。</p>
          )}
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-bold text-gray-600">成員（{order.member_count} 個家庭）</h3>
          <button type="button" onClick={() => load()}
            className="text-xs font-bold text-brand-teal active:opacity-60">↻ 重新整理</button>
        </div>
        <div className="space-y-2">
          {(order.members || []).map((m) => {
            const proofState = m.payment_confirmed
              ? { label: '✓ 帳款已確認', cls: 'text-brand-green' }
              : (m.has_payment_proof ? { label: '已上傳，待確認', cls: 'text-brand-gold' } : { label: '未上傳證明', cls: 'text-gray-400' });
            // 末碼＋證明都送出後即唯讀（移除自行重編入口），需更改請聯繫櫃檯。
            const paymentLocked = m.is_self && m.has_payment_proof && !!m.transfer_last_5;
            const cardStateClass = m.payment_confirmed
              ? 'border-brand-green/40 bg-brand-green/5'
              : paymentLocked
                ? 'border-brand-gold/40 bg-brand-gold/5'
                : m.is_self
                  ? 'border-brand-teal/40 bg-brand-teal/5'
                  : 'border-gray-200 bg-white hover:border-brand-teal/40';
            return (
              <div key={m.id} className={`rounded-lg border px-3 py-2 transition-colors ${cardStateClass}`}>
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-gray-800">{m.parent_name}</span>
                      {m.is_leader && <span className="rounded bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-primary">團主</span>}
                      {m.is_self && <span className="rounded bg-brand-teal/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-teal">您</span>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-gray-500">學生：{(m.student_names || []).join('、') || '—'}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {/* U14：有折扣時顯示原價刪除線，讓家長看得出自己折了多少 */}
                    {m.discount_amount > 0 && (
                      <div className="text-[11px] text-gray-400 line-through">{money(m.original_amount)}</div>
                    )}
                    <div className="text-xs font-bold text-gray-700">{money(m.amount_due)}</div>
                    {m.discount_amount > 0 && (
                      <div className="text-[11px] font-medium text-brand-green">已折 {money(m.discount_amount)}</div>
                    )}
                    <div className={`text-[11px] font-medium ${proofState.cls}`}>{proofState.label}</div>
                  </div>
                </div>

                {/* 自己這筆：揪團中(forming)即可先轉帳並上傳付款資料，送審後(submitted)仍可補；櫃檯確認前皆可 */}
                {m.is_self && !m.payment_confirmed && ['forming', 'submitted'].includes(order.status) && (
                  <div className="mt-2 space-y-2">
                    <input
                      type="tel"
                      inputMode="numeric"
                      maxLength={5}
                      value={transferLast5}
                      disabled={proofBusy || paymentLocked}
                      onChange={(e) => setTransferLast5(e.target.value.replace(/\D/g, '').slice(0, 5))}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono focus:border-brand-teal focus:outline-none"
                      placeholder="轉帳末 5 碼"
                    />
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-500" htmlFor={`group-carrier-${m.id}`}>
                        電子發票載具條碼（選填）
                      </label>
                      <input
                        id={`group-carrier-${m.id}`}
                        type="text"
                        value={carrier}
                        disabled={proofBusy || !!m.carrier}
                        onChange={(e) => setCarrier(e.target.value.slice(0, 64))}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono focus:border-brand-teal focus:outline-none disabled:bg-gray-100"
                        placeholder="可直接刷入，例如 /ABC+123"
                      />
                    </div>
                    {paymentLocked ? (
                      <>
                        <p className="text-[11px] text-gray-400">付款資料已送出，需更改請聯繫櫃檯。</p>
                        {!m.carrier && (
                          <button
                            type="button"
                            disabled={proofBusy || !carrier.trim()}
                            onClick={() => handleConfirmPayment(m)}
                            className="w-full rounded-lg bg-brand-primary px-3 py-2 text-xs font-bold text-white disabled:bg-gray-300"
                          >
                            {proofBusy ? '儲存中…' : '補存電子發票載具'}
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <input
                          ref={proofInputRef}
                          type="file"
                          accept={PAYMENT_PROOF_ACCEPT}
                          className="hidden"
                          disabled={proofBusy}
                          onChange={(e) => selectProofFile(e.target.files?.[0])}
                        />
                        <button
                          type="button"
                          disabled={proofBusy}
                          onClick={() => proofInputRef.current?.click()}
                          className="w-full rounded-lg border border-dashed border-brand-teal/50 bg-white px-3 py-2 text-xs font-bold text-brand-teal disabled:opacity-50"
                        >
                          {proofFile ? `已選：${proofFile.name}` : (m.has_payment_proof ? '更換轉帳證明' : '選擇轉帳證明')}
                        </button>
                        <button
                          type="button"
                          disabled={proofBusy || !/^\d{5}$/.test(transferLast5.trim()) || (!proofFile && !m.has_payment_proof)}
                          onClick={() => handleConfirmPayment(m)}
                          className="w-full rounded-lg bg-brand-primary px-3 py-2 text-xs font-bold text-white disabled:bg-gray-300"
                        >
                          {proofBusy ? '送出中…' : '確認無誤，送出付款資料'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-gray-400">
          應繳＝單期費用 × 學生數{order.period_count > 1 ? ` × ${order.period_count} 期` : ''}；轉帳後上傳證明，櫃檯確認即開課。
        </p>
      </div>

      {/* U14 退回補件：狀態已轉回 forming，但 reject_reason 還在 → 家長必須看得到為什麼被退，
          否則只會看到「揪團中」卻不知道要補什麼。rejected（終止）由 NextActionBlock 另外處理。 */}
      {order.status === 'forming' && order.reject_reason && (
        <div className="mb-4 rounded-xl border border-brand-error/40 bg-brand-error/5 px-3 py-3">
          <div className="text-sm font-bold text-brand-error">此團購已被退回，請補件後重新送審</div>
          <p className="mt-1 text-xs leading-5 text-gray-700">退回原因：{order.reject_reason}</p>
          <p className="mt-1 text-[11px] leading-5 text-gray-500">
            這筆團購<strong>沒有被取消</strong>，名單與已繳資料都還在。補齊後團主即可再次送審。
          </p>
        </div>
      )}

      {/* 下一步行動模組：移到取消團購上方 */}
      <NextActionBlock
        order={order}
        reachedMin={reachedMin}
        allPaymentConfirmed={allPaymentConfirmed}
        selfMember={selfMember}
        selfPaymentReady={selfPaymentReady}
        missingPaymentCount={missingPaymentCount}
        allPaymentReady={allPaymentReady}
        unpaidCount={unpaidMembers.length}
        unpaidNames={unpaidMembers.map((m) => m.parent_name).filter(Boolean)}
        onGoCourses={() => navigate('/my-courses')}
        onSubmit={() => setConfirm('submit')}
      />

      {(order.is_leader && order.status === 'forming') || canCancelGroup ? (
        <div className="mt-4 space-y-2">
          {order.is_leader && order.status === 'forming' && (
            <>
              {/* 送審前警語：名單鎖定；證明改送審後各家上傳 */}
              <div className="rounded-lg border border-brand-gold/40 bg-brand-gold/5 px-3 py-2 text-[12px] leading-5 text-brand-gold">
                ⚠️ 送審後名單<strong>鎖定、不能再加人</strong>；全團都要備齊「轉帳末 5 碼 + 匯款證明」才能送審。
              </div>
              {/* 自動送審條件與後端 services/groupOrderSubmit.isFullHouse 一致：滿團＋全員付款齊備。 */}
              <div className="rounded-lg border border-brand-teal/40 bg-brand-teal/5 px-3 py-2 text-[12px] leading-5 text-brand-teal">
                ✅ 收滿 {order.max_students} 人、且全團都回傳付款資料時，系統會<strong>自動送審</strong>，您不必再按一次。
              </div>
              {/* 送審鈕已由上方 NextActionBlock 提供（人數達標＋全員付款齊備才顯示），此處只保留警語避免兩顆重複送審鈕。 */}
              {!reachedMin && (
                <p className="px-1 text-[12px] text-gray-500">還差 {order.min_students - order.total_students} 人才能送審。</p>
              )}
              {reachedMin && !allPaymentReady && (
                <p className="px-1 text-[12px] text-gray-500">
                  人數已達標，還有 {unpaidMembers.length} 個家庭未備齊付款資料，補齊後即可送審。
                </p>
              )}
            </>
          )}
          {canCancelGroup && (
            <button type="button" disabled={busy} onClick={() => setConfirm('cancel')}
              className="w-full rounded-lg border border-brand-error/40 py-2.5 text-sm font-bold text-brand-error">取消團購</button>
          )}
        </div>
      ) : null}

      <button type="button" onClick={() => navigate('/')}
        className="mt-4 w-full rounded-lg border border-gray-300 py-2.5 text-sm font-bold text-gray-700 active:bg-gray-100">
        回到首頁
      </button>

      <ConfirmModal
        open={confirm === 'submit'}
        title="確認送審？"
        confirmLabel="確認送審"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => doAction('submit')}
      >
        <p className="text-sm text-gray-600">
          全團付款資料已備齊。送審後名單<strong>鎖定、不能再加人</strong>，由櫃檯核對後開課。確定送審？
        </p>
      </ConfirmModal>

      <ConfirmModal
        open={confirm === 'cancel'}
        title="確認取消團購？"
        confirmLabel="確認取消"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => doAction('cancel')}
      >
        <p className="text-sm text-gray-600">取消後此團購將關閉，已加入的成員都會失效，此動作無法復原。</p>
      </ConfirmModal>
    </div>
  );
}

function NextActionBlock({
  order,
  reachedMin,
  allPaymentConfirmed,
  selfMember,
  selfPaymentReady,
  missingPaymentCount,
  allPaymentReady,
  unpaidCount,
  unpaidNames,
  onGoCourses,
  onSubmit,
}) {
  let title = '';
  let body = '';
  let primary = null;
  let tone = 'teal';

  if (order.status === 'forming') {
    tone = selfPaymentReady ? 'gold' : 'teal';
    if (order.is_leader) {
      // U14 送審三態：①人數未達標 ②人數到了但付款未齊（送審鈕不出現＝唯讀）③兩者皆備才可送審
      if (!reachedMin) {
        title = '先邀請其他家長加入';
        body = `還差 ${Math.max(0, order.min_students - order.total_students)} 人成團，用下方連結邀請家長加入；您也可先完成自己的付款。`;
      } else if (!allPaymentReady) {
        tone = 'gold';
        title = `人數已達標，還有 ${unpaidCount} 個家庭未交付款資料`;
        body = `${(unpaidNames || []).join('、') || '部分家庭'} 尚未備齊「轉帳末 5 碼 + 匯款證明」。請提醒他們到本頁補齊；收滿 ${order.max_students} 人且全部回傳後系統會自動送審。`;
      } else {
        title = '全員付款資料已齊，可以送審';
        body = order.total_students < order.max_students
          ? `目前 ${order.total_students} 人，還可以再收 ${order.max_students - order.total_students} 人。收滿會自動送審；不等了也可以現在就送出，送審後名單鎖定。`
          : '送審後名單鎖定，由櫃檯核對後開課。';
        primary = { label: '送審並鎖定名單', onClick: onSubmit };
      }
    } else {
      title = selfPaymentReady ? '付款資料已送出' : '已加入，可先完成付款';
      body = selfPaymentReady
        ? `等其他家庭回傳付款資料；收滿 ${order.max_students} 人且全團都回傳後會自動送審，再由櫃檯核對開課。`
        : '您已在團內，可先轉帳並在下方成員卡上傳付款資料，不必等團主送審；全團回傳齊全就會自動送審。';
    }
  } else if (order.status === 'submitted') {
    tone = selfPaymentReady ? 'gold' : 'teal';
    title = selfPaymentReady ? '付款資料已送出' : '請完成付款資料';
    body = selfPaymentReady
      ? '等待櫃檯核對，核准後即開課並進入我的課程。'
      : '請在下方自己的成員卡填轉帳末 5 碼並上傳證明。';
  } else if (order.status === 'approved') {
    tone = allPaymentConfirmed ? 'green' : 'gold';
    title = allPaymentConfirmed ? '課程已建立' : '團購已核准，等待對帳完成';
    body = allPaymentConfirmed
      ? '課程已進入我的課程，可查看詳情與選時段。'
      : `還有 ${missingPaymentCount} 筆帳款確認中，完成後即開課。`;
    primary = { label: '前往我的課程', onClick: onGoCourses };
  } else if (order.status === 'rejected') {
    tone = 'error';
    title = '團購已退回';
    body = order.reject_reason ? `退回原因：${order.reject_reason}` : '請依櫃檯說明修正後重新發起。';
  } else if (order.status === 'cancelled') {
    tone = 'gray';
    title = '團購已取消';
    body = '此團購已關閉，若仍要成團請重新發起。';
  }

  const toneClass = {
    teal: 'border-brand-teal/30 bg-brand-teal/5 text-brand-teal',
    gold: 'border-brand-gold/40 bg-brand-gold/5 text-brand-gold',
    green: 'border-brand-green/30 bg-brand-green/5 text-brand-green',
    error: 'border-brand-error/30 bg-brand-error/5 text-brand-error',
    gray: 'border-gray-200 bg-gray-50 text-gray-600',
  }[tone] || 'border-gray-200 bg-gray-50 text-gray-600';

  return (
    <div className={`mb-4 rounded-xl border px-3 py-3 ${toneClass}`}>
      <div className="text-sm font-bold">{title}</div>
      {body && <p className="mt-1 text-xs leading-5 text-gray-600">{body}</p>}
      {primary && (
        <button
          type="button"
          onClick={primary.onClick}
          className="mt-2 w-full rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white active:bg-brand-teal"
        >
          {primary.label}
        </button>
      )}
      {['forming', 'submitted'].includes(order.status) && selfMember && !selfMember.payment_confirmed && (
        <div className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-[11px] leading-5 text-gray-600">
          您這筆：{selfPaymentReady ? '已填付款資料，等待確認。' : '尚未完成付款資料。'}
        </div>
      )}
    </div>
  );
}

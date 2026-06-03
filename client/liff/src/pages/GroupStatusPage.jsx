import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import liff from '@line/liff';
import { groupOrdersApi } from '../api/groupOrders';
import { enrollmentsApi } from '../api/enrollments';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

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

// 非 LINE App 內（瀏覽器 / 預覽）為 true。此時顯示「測試用直連」網址（同網域 /liff/...，
// 不走 liff.line.me），讓開發者能用 demo 帳號在瀏覽器自測加入流程，不必拼 token。
function notInLineClient() {
  try { return !liff.isInClient(); } catch { return true; }
}
function buildTestJoinUrl(token) {
  return token ? `${window.location.origin}/liff/group/join/${token}` : '';
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

  const load = useCallback(() => {
    let alive = true;
    groupOrdersApi.get(id)
      .then((d) => alive && setOrder(d || null))
      .catch(() => alive && setOrder(null));
    return () => { alive = false; };
  }, [id]);

  useEffect(() => load(), [load]);
  useEffect(() => {
    const self = (order?.members || []).find((m) => m.is_self);
    if (self) setTransferLast5(self.transfer_last_5 || '');
  }, [order?.id, order?.members]);

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
  const joinUrl = order.is_leader ? buildJoinUrl(order.join_token) : null;
  // 測試用直連（僅非 LINE 瀏覽器顯示）：用 demo 帳號在瀏覽器自測加入用
  const testJoinUrl = order.is_leader && notInLineClient() ? buildTestJoinUrl(order.join_token) : null;

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast.success('邀請連結已複製，貼到群組分享吧！');
    } catch {
      toast.error('複製失敗，請手動複製');
    }
  }

  async function copyTestInvite() {
    try {
      await navigator.clipboard.writeText(testJoinUrl);
      toast.success('測試直連已複製（請在另一個瀏覽器以 demo 帳號開啟）');
    } catch {
      toast.error('複製失敗，請手動複製');
    }
  }

  // U10：成員上傳自己的轉帳證明（先傳檔取得 URL，再記到本團我的那筆 member）
  async function handleUploadMyProof(file) {
    if (!/^\d{5}$/.test(transferLast5.trim())) return toast.error('請先填寫 5 位數字的轉帳末碼');
    const self = (order?.members || []).find((m) => m.is_self);
    if (!file && !self?.has_payment_proof) return toast.error('請選擇匯款／轉帳證明');
    if (file && !['image/jpeg', 'image/png'].includes(file.type)) return toast.error('只接受 JPG / PNG 圖片');
    if (file && file.size > 5 * 1024 * 1024) return toast.error('圖片大小不得超過 5MB');
    setProofBusy(true);
    try {
      let url = null;
      if (file) {
        const uploaded = await enrollmentsApi.uploadPaymentProof(file);
        url = uploaded?.url || null;
        if (!url) throw new Error('no url');
      }
      const updated = await groupOrdersApi.uploadMyProof(id, {
        transfer_last_5: transferLast5.trim(),
        payment_proof_url: url || undefined,
      });
      if (updated) setOrder(updated); else load();
      toast.success('付款資料已送出，待櫃檯確認');
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
      toast.error(e?.response?.data?.error || '操作失敗');
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
          <div className="flex gap-2">
            <input readOnly value={joinUrl}
              className="flex-1 truncate rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-600" />
            <button type="button" onClick={copyInvite}
              className="shrink-0 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white">複製</button>
          </div>
          <p className="mt-1.5 text-[11px] text-gray-500">把連結分享給其他家長，請他們登入填寫學生資料一起報名。</p>
          {testJoinUrl && (
            <div className="mt-2 border-t border-dashed border-brand-teal/30 pt-2">
              <label className="mb-1 block text-[11px] font-medium text-amber-700">🧪 測試用直連（瀏覽器自測，請在另一個瀏覽器以 demo 帳號開啟）</label>
              <div className="flex gap-2">
                <input readOnly value={testJoinUrl}
                  className="flex-1 truncate rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-gray-600" />
                <button type="button" onClick={copyTestInvite}
                  className="shrink-0 rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-white">複製</button>
              </div>
            </div>
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
            return (
              <div key={m.id} className="rounded-lg bg-gray-50 px-3 py-2">
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
                    <div className="text-xs font-bold text-gray-700">{money(m.amount_due)}</div>
                    <div className={`text-[11px] font-medium ${proofState.cls}`}>{proofState.label}</div>
                  </div>
                </div>

                {/* 自己這筆：未確認帳款前可上傳 / 更換轉帳證明 */}
                {m.is_self && !m.payment_confirmed && ['forming', 'submitted'].includes(order.status) && (
                  <div className="mt-2 space-y-2">
                    <input
                      type="tel"
                      inputMode="numeric"
                      maxLength={5}
                      value={transferLast5}
                      disabled={proofBusy}
                      onChange={(e) => setTransferLast5(e.target.value.replace(/\D/g, '').slice(0, 5))}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono focus:border-brand-teal focus:outline-none"
                      placeholder="轉帳末 5 碼"
                    />
                    <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-brand-teal/50 bg-white px-3 py-2 text-xs font-bold text-brand-teal active:opacity-70">
                      📤 {proofBusy ? '上傳中…' : (m.has_payment_proof ? '更換轉帳證明' : '上傳轉帳證明')}
                      <input type="file" accept="image/jpeg,image/png" className="hidden"
                        disabled={proofBusy}
                        onChange={(e) => handleUploadMyProof(e.target.files?.[0])} />
                    </label>
                    {m.has_payment_proof && (
                      <button type="button" disabled={proofBusy} onClick={() => handleUploadMyProof(null)}
                        className="w-full rounded-lg border border-brand-teal bg-white px-3 py-2 text-xs font-bold text-brand-teal disabled:opacity-60">
                        {proofBusy ? '儲存中…' : '只儲存末 5 碼'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-gray-400">
          應繳金額＝單期費用 × 您的學生數{order.period_count > 1 ? ` × ${order.period_count} 期` : ''}。請先完成轉帳再上傳證明，櫃檯確認後即建立課程。
        </p>
      </div>

      {order.is_leader && order.status === 'forming' && (
        <div className="mt-4 space-y-2">
          {/* 送審前警語：名單鎖定；證明改送審後各家上傳 */}
          <div className="rounded-lg border border-brand-gold/40 bg-brand-gold/5 px-3 py-2 text-[12px] leading-5 text-brand-gold">
            ⚠️ 送審後成員與學生名單將<strong>無法再更改</strong>，也無法再加入新成員。送審後即進入等候審核，<strong>各家請於此頁完成轉帳並上傳證明</strong>，櫃檯核對後建立課程。
          </div>
          <button
            type="button"
            disabled={!reachedMin || busy}
            onClick={() => setConfirm('submit')}
            className="w-full rounded-lg bg-brand-primary py-3.5 text-base font-bold text-white active:bg-brand-teal disabled:bg-gray-300"
          >
            {reachedMin ? '送審（湊滿開團人數）' : `還差 ${order.min_students - order.total_students} 人才能送審`}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirm('cancel')}
            className="w-full rounded-lg border border-brand-error/40 py-2.5 text-sm font-bold text-brand-error">取消團購</button>
        </div>
      )}

      <ConfirmModal
        open={confirm === 'submit'}
        title="確認送審？"
        confirmLabel="確認送審"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => doAction('submit')}
      >
        <p className="text-sm text-gray-600">
          送審後名單將<strong>無法更改</strong>、也無法再加入新成員。在等候審核期間，
          <strong>請各家先完成轉帳並於本頁上傳轉帳證明</strong>；櫃檯核對名單與帳款後即建立課程。確定送審？
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

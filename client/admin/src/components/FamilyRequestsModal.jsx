import React, { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import StatusBadge from './StatusBadge';
import { useToast } from '../context/ToastContext';
import { familiesApi, RELATIONSHIP_OPTIONS, duplicatePlanText } from '../api/families';
import { formatTWDateTime } from '../utils/format';

// Z01 頁上方「家庭申請與建議」（規格 §7 第 3 點、§14）。
// 申請：家長從手機送來的合併申請 → 核准（自動建家庭或加入既有家庭，重複學員依 §9）／退回（要填原因）。
// 建議：同一個身分證掛在不同帳號、還沒人申請的孩子 → 櫃台確認後才建立。系統只建議，不自動建立。

function Kid({ title, name, birth, inRagic, periods, parentName, parentPhone, birthMatch }) {
  return (
    <div className="min-w-0 flex-1 rounded border border-gray-200 bg-white p-2">
      <div className="text-[11px] font-bold text-gray-500">{title}</div>
      <div className="font-semibold text-gray-800">{name || '—'}</div>
      <div className="text-gray-500">
        生日 {birth || '—'}
        {birthMatch === true && <span className="ml-1 text-brand-green">✓ 相符</span>}
        {birthMatch === false && <span className="ml-1 text-brand-error">✗ 不相符</span>}
      </div>
      <div className="text-gray-500">{inRagic ? 'Ragic 上的那份' : '不在 Ragic'}・課程／未對帳訂單 {periods ?? 0}</div>
      {parentName && <div className="text-gray-500">家長 {parentName}{parentPhone ? `（${parentPhone}）` : ''}</div>}
    </div>
  );
}

export default function FamilyRequestsModal({ onClose }) {
  const toast = useToast();
  const [tab, setTab] = useState('requests');
  const [requests, setRequests] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [applying, setApplying] = useState(null); // suggestion
  const [applyOwner, setApplyOwner] = useState('');
  const [applyMemberRel, setApplyMemberRel] = useState('');
  const [applyOwnerRel, setApplyOwnerRel] = useState('');

  async function load() {
    try { setRequests((await familiesApi.requests('pending'))?.items || []); } catch { setRequests([]); toast.error('讀取合併申請失敗'); }
    try { setSuggestions((await familiesApi.suggestions())?.items || []); } catch { setSuggestions([]); toast.error('讀取家庭建議失敗'); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function act({ run, ok }) {
    setBusy(true);
    try {
      await run();
      toast.success(ok);
      await load();
      return true;
    } catch (err) {
      toast.error(err?.response?.data?.error || '操作失敗');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const tabs = [
    ['requests', `申請${requests ? `（${requests.length}）` : ''}`],
    ['suggestions', `建議${suggestions ? `（${suggestions.length}）` : ''}`],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/50 p-3 md:p-8">
      <div className="h-fit w-full max-w-4xl overflow-hidden rounded-lg border border-gray-400 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-300 bg-gray-100 px-4 py-2.5">
          <h2 className="text-base font-bold text-brand-primary">家庭申請與建議</h2>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <div className="flex border-b border-gray-300 bg-gray-50 text-xs">
          {tabs.map(([k, t]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`border-r border-gray-300 px-4 py-2 font-bold ${tab === k ? 'bg-white text-brand-primary' : 'text-gray-500 hover:bg-white/60'}`}>{t}</button>
          ))}
        </div>

        <div className="space-y-3 p-4 text-xs">
          {tab === 'requests' && (
            <>
              <p className="text-gray-500">家長從個人頁送出的合併申請（已經比對過孩子的身分證字號與生日）。核准後申請人加入孩子所屬家長的家庭；對方還沒有家庭就自動建立，由孩子的所屬家長當擁有者。</p>
              {!requests && <p className="text-gray-400">載入中…</p>}
              {requests && requests.length === 0 && <p className="py-6 text-center text-gray-400">目前沒有待審核的申請</p>}
              {(requests || []).map((r) => (
                <div key={r.id} className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-gray-800">{r.applicant_name}</span>
                    <span className="font-mono text-gray-500">{r.applicant_phone}</span>
                    <StatusBadge tone="teal">{r.relationship_label}</StatusBadge>
                    <span className="text-gray-400">{formatTWDateTime(r.created_at)}</span>
                  </div>
                  {r.note && <p className="text-gray-600">備註：{r.note}</p>}
                  <div className="flex flex-col gap-2 md:flex-row">
                    <Kid title="要加入的孩子（保留這份）" name={r.target_name} birth={r.target_birth} inRagic={r.target_in_ragic}
                      periods={r.target_periods} parentName={r.owner_name} parentPhone={r.owner_phone} />
                    {r.dup_id && (
                      <Kid title="申請人名下的重複資料" name={r.dup_name} birth={r.dup_birth} inRagic={r.dup_in_ragic}
                        periods={r.dup_periods} birthMatch={r.dup_birth && r.target_birth ? r.dup_birth === r.target_birth : undefined} />
                    )}
                  </div>
                  <p className="rounded bg-white px-2 py-1 text-gray-700">
                    重複學員：{duplicatePlanText(r.duplicate_plan, { [r.target_id]: `${r.owner_name}名下的那份`, [r.dup_id]: `${r.applicant_name}名下的那份` })}
                  </p>
                  <div className="flex justify-end gap-2">
                    <button type="button" disabled={busy} onClick={() => { setRejecting(r); setRejectReason(''); }}
                      className="rounded border border-brand-error px-3 py-1 font-semibold text-brand-error disabled:opacity-50">退回</button>
                    <button type="button" disabled={busy} onClick={() => setApproving(r)}
                      className="rounded bg-brand-green px-3 py-1 font-semibold text-white disabled:opacity-50">核准</button>
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === 'suggestions' && (
            <>
              <p className="text-gray-500">同一個身分證字號掛在兩個家長帳號、還沒合併的孩子。系統只建議，櫃台確認後才會建立家庭。</p>
              {!suggestions && <p className="text-gray-400">載入中…</p>}
              {suggestions && suggestions.length === 0 && <p className="py-6 text-center text-gray-400">目前沒有建議</p>}
              {(suggestions || []).map((s) => (
                <div key={`${s.a.student_id}-${s.b.student_id}`} className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <div className="flex flex-col gap-2 md:flex-row">
                    <Kid title={`${s.a.parent_name} 名下`} name={s.a.name} birth={s.a.birth_date} inRagic={s.a.in_ragic}
                      periods={s.a.periods} parentName={s.a.parent_name} parentPhone={s.a.parent_phone} />
                    <Kid title={`${s.b.parent_name} 名下`} name={s.b.name} birth={s.b.birth_date} inRagic={s.b.in_ragic}
                      periods={s.b.periods} parentName={s.b.parent_name} parentPhone={s.b.parent_phone}
                      birthMatch={s.a.birth_date && s.b.birth_date ? s.a.birth_date === s.b.birth_date : undefined} />
                  </div>
                  <p className="rounded bg-white px-2 py-1 text-gray-700">
                    重複學員：{duplicatePlanText(s.duplicate_plan, { [s.a.student_id]: `${s.a.parent_name}名下的那份`, [s.b.student_id]: `${s.b.parent_name}名下的那份` })}
                  </p>
                  <div className="flex justify-end">
                    <button type="button" disabled={busy}
                      onClick={() => { setApplying(s); setApplyOwner(s.suggested_owner_parent_id || ''); setApplyMemberRel(''); setApplyOwnerRel(''); }}
                      className="rounded bg-brand-primary px-3 py-1 font-semibold text-white disabled:opacity-50">建立家庭…</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!approving}
        title="核准合併申請"
        confirmLabel="確認核准"
        busy={busy}
        onCancel={() => !busy && setApproving(null)}
        onConfirm={async () => { if (await act({ run: () => familiesApi.approveRequest(approving.id), ok: '已核准，申請人已加入家庭' })) setApproving(null); }}
      >
        {approving && (
          <div className="space-y-2">
            <p>「<b>{approving.applicant_name}</b>」（{approving.relationship_label}）加入「{approving.owner_name}」的家庭。</p>
            <p className="text-xs text-gray-600">
              {duplicatePlanText(approving.duplicate_plan, { [approving.target_id]: `${approving.owner_name}名下的那份`, [approving.dup_id]: `${approving.applicant_name}名下的那份` })}
            </p>
            <p className="text-xs text-gray-500">核准後會用 LINE 通知雙方。</p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!rejecting}
        title="退回合併申請"
        confirmLabel="確認退回"
        tone="danger"
        busy={busy}
        confirmDisabled={!rejectReason.trim()}
        onCancel={() => !busy && setRejecting(null)}
        onConfirm={async () => { if (await act({ run: () => familiesApi.rejectRequest(rejecting.id, rejectReason.trim()), ok: '已退回' })) setRejecting(null); }}
      >
        {rejecting && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">退回原因（必填，會用 LINE 告訴申請人）</span>
            <textarea rows={3} value={rejectReason} maxLength={200} onChange={(e) => setRejectReason(e.target.value)}
              placeholder="例：已電話確認不是同一個家庭"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
          </label>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!applying}
        title="依建議建立家庭"
        confirmLabel="確認建立"
        busy={busy}
        confirmDisabled={!applyOwner || !applyMemberRel}
        onCancel={() => !busy && setApplying(null)}
        onConfirm={async () => {
          const ok = await act({ run: () => familiesApi.applySuggestion({
            student_a_id: applying.a.student_id,
            student_b_id: applying.b.student_id,
            owner_parent_id: applyOwner,
            member_relationship: applyMemberRel,
            owner_relationship: applyOwnerRel || null,
          }), ok: '已建立家庭' });
          if (ok) setApplying(null);
        }}
      >
        {applying && (
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">擁有者（預設是 Ragic 上的那位家長）</span>
              <select value={applyOwner} onChange={(e) => setApplyOwner(e.target.value)} className="w-full rounded border border-gray-300 px-2 py-1">
                <option value="" disabled>選擇擁有者</option>
                <option value={applying.a.parent_id}>{applying.a.parent_name}（{applying.a.parent_phone}）</option>
                <option value={applying.b.parent_id}>{applying.b.parent_name}（{applying.b.parent_phone}）</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">另一位家長是孩子的（必填）</span>
              <select value={applyMemberRel} onChange={(e) => setApplyMemberRel(e.target.value)} className="w-full rounded border border-gray-300 px-2 py-1">
                <option value="" disabled>選擇關係</option>
                {RELATIONSHIP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">擁有者是孩子的（選填）</span>
              <select value={applyOwnerRel} onChange={(e) => setApplyOwnerRel(e.target.value)} className="w-full rounded border border-gray-300 px-2 py-1">
                <option value="">（不填）</option>
                {RELATIONSHIP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <p className="text-xs text-gray-500">
              {duplicatePlanText(applying.duplicate_plan, { [applying.a.student_id]: `${applying.a.parent_name}名下的那份`, [applying.b.student_id]: `${applying.b.parent_name}名下的那份` })}
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

import React, { useState } from 'react';
import ConfirmModal from './ConfirmModal';
import Collapsible from './Collapsible';
import { useToast } from '../context/ToastContext';
import { familyApi, RELATIONSHIP_OPTIONS } from '../api/family';
import { formatPlainDate, formatTWDateTime } from '../utils/format';

// 個人頁「我的家庭」（規格 §8、§14；擁有者 2026-09-23 調整）。block＝GET /parents/me 的 family 區塊；
// null＝功能沒開，整列不出現。申請表單的開關由個人頁控制（applyDraft），因為頂端的重複提示、
// 新增學員被擋時也要能帶資料打開它。

const inputCls = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-primary';

// 邀請家人加入（擁有者 2026-09-23）：擁有者，或還沒有家庭的家長（連結先放在準備中的家庭，有人加入才成立）。
// 平常只顯示按鈕，點下去才打開、產生連結（「按鈕式，點下去才打開」）；連結只能用一次、7 天有效、可作廢。
const fullUrl = (url) => (String(url || '').startsWith('/') ? `${window.location.origin}${url}` : url);

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  } catch { /* 落到下面（LINE 內建瀏覽器常沒有 clipboard API） */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

function InviteBox({ hasFamily, invites, onChanged }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const list = invites || [];

  async function create() {
    setBusy(true);
    try {
      await familyApi.createInvite();
      await onChanged();
    } catch (err) {
      toast.error(err?.response?.data?.error || '產生邀請連結失敗，請稍後再試', 4200);
    } finally {
      setBusy(false);
    }
  }
  async function openBox() {
    setOpen(true);
    if (!list.length) await create(); // 點下去才產生
  }
  async function revoke(id) {
    setBusy(true);
    try {
      await familyApi.revokeInvite(id);
      toast.success('已作廢這個邀請連結');
      await onChanged();
    } catch (err) {
      toast.error(err?.response?.data?.error || '作廢失敗，請稍後再試');
    } finally {
      setBusy(false);
    }
  }
  const shareHref = (inv) => `https://line.me/R/share?text=${encodeURIComponent(
    `邀請你加入我們的家庭，一起查看孩子的課程、幫忙繳費與簽到：${fullUrl(inv.url)}`)}`;

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={openBox}
        className="rounded-lg border border-brand-primary px-3 py-1.5 text-xs font-bold text-brand-primary disabled:opacity-60">
        {busy ? '產生中…' : '邀請家人加入'}
      </button>
    );
  }
  return (
    <div className="rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-2.5 text-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-gray-800">邀請家人加入</span>
        <button type="button" onClick={() => setOpen(false)} className="px-1 text-gray-400">收起</button>
      </div>
      <p className="mt-0.5 leading-4 text-gray-500">
        傳連結給家人，用 LINE 打開就能加入（限用一次、7 天有效）。{hasFamily ? '' : '有人加入後，您就是這個家庭的擁有者。'}
      </p>
      {list.map((inv) => (
        <div key={inv.id} className="mt-2 rounded-lg border border-gray-200 bg-white p-2">
          <div className="break-all font-mono text-gray-500">{fullUrl(inv.url)}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <a href={shareHref(inv)} target="_blank" rel="noopener noreferrer"
              className="rounded-lg bg-[#06C755] px-2.5 py-1 font-bold text-white">用 LINE 傳送</a>
            <button type="button" onClick={() => copyText(fullUrl(inv.url)).then(() => setCopiedId(inv.id)).catch(() => setCopiedId(null))}
              className="rounded-lg border border-gray-200 px-2.5 py-1 font-medium text-gray-700">
              {copiedId === inv.id ? '已複製 ✓' : '複製連結'}
            </button>
            <button type="button" disabled={busy} onClick={() => revoke(inv.id)}
              className="px-1 py-1 font-medium text-brand-error disabled:opacity-60">作廢</button>
            <span className="ml-auto text-gray-400">有效到 {formatTWDateTime(inv.expires_at)}</span>
          </div>
        </div>
      ))}
      <button type="button" disabled={busy} onClick={create}
        className="mt-2 rounded-lg border border-brand-primary px-3 py-1 text-xs font-bold text-brand-primary disabled:opacity-60">
        {busy ? '產生中…' : list.length ? '再產生一條' : '產生邀請連結'}
      </button>
    </div>
  );
}

// 外觀跟「編輯資料」一樣是橫條式折疊（擁有者 2026-09-23：放在編輯資料下方、字小一點）；
// 開關由個人頁控制，因為頂端「申請合併」、新增學員被擋時的「申請加入家庭」要能直接打開它。
export default function FamilyCard({ block, open, onToggle, applyDraft, setApplyDraft, onChanged }) {
  const toast = useToast();
  const [relationship, setRelationship] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [unbinding, setUnbinding] = useState(null); // 要解綁的家人
  const [rejecting, setRejecting] = useState(null); // 要拒絕的申請

  if (!block) return null;
  const { family, join_request: request, rebind_required: rebindRequired } = block;
  const pending = request?.status === 'pending' ? request : null;
  const incoming = block.incoming_requests || [];
  const isOwner = family?.role === 'owner';

  const studentName = String(applyDraft?.student_name || '').trim();
  const parentPhone = String(applyDraft?.parent_phone || '').trim();
  const canSubmit = studentName.replace(/\s/g, '').length >= 2 && /^09\d{8}$/.test(parentPhone) && relationship && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await familyApi.createRequest({ student_name: studentName, parent_phone: parentPhone, relationship, note: note.trim() || undefined });
      toast.success('已送出申請，對方家長同意後就會加入');
      setApplyDraft(null);
      setRelationship('');
      setNote('');
      await onChanged();
    } catch (err) {
      toast.error(err?.response?.data?.error || '申請送出失敗，請稍後再試', 4200);
    } finally {
      setBusy(false);
    }
  }

  async function run(fn, okText) {
    setBusy(true);
    try {
      await fn();
      toast.success(okText);
      await onChanged();
      return true;
    } catch (err) {
      toast.error(err?.response?.data?.error || '操作失敗，請稍後再試');
      return false;
    } finally {
      setBusy(false);
    }
  }

  // 家人名下的孩子，依所屬家長分組（唯讀）
  const groups = [];
  for (const kid of family?.students || []) {
    let g = groups.find((x) => x.owner === kid.owner_parent_id);
    if (!g) { g = { owner: kid.owner_parent_id, name: kid.owner_name, rel: kid.owner_relationship_label, kids: [] }; groups.push(g); }
    g.kids.push(kid);
  }

  // 收合時標題旁的狀態（有人等我同意時優先提示）
  const subtitle = incoming.length ? `${incoming.length} 筆申請等您同意`
    : family ? `共 ${(family.members || []).length} 人`
      : pending ? '等對方同意'
        : rebindRequired ? '需重新綁定' : '';

  return (
    <div className="mb-4">
      <Collapsible title="我的家庭" subtitle={subtitle} open={open} onToggle={onToggle} accent>
        <div className="space-y-2.5 text-[11px] leading-4 text-gray-600">
          {rebindRequired && (
            <p className="rounded-lg bg-amber-50 p-2 text-amber-900">LINE 帳號換過了，請洽櫃台重新綁定家庭。</p>
          )}

          {incoming.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900">
              <div className="text-xs font-bold">等您同意的申請</div>
              {incoming.map((r) => (
                <div key={r.id} className="mt-1.5 rounded-lg bg-white p-2 text-gray-700">
                  <div><b>{r.applicant_name}</b>（{r.relationship_label}）想加入您的家庭・孩子：{r.student_name}</div>
                  {r.note && <div className="text-gray-500">備註：{r.note}</div>}
                  <div className="text-gray-400">{formatTWDateTime(r.created_at)}</div>
                  <div className="mt-1 flex gap-1.5">
                    <button type="button" disabled={busy}
                      onClick={() => run(() => familyApi.approveRequest(r.id), `已同意，${r.applicant_name}現在是您的家人了`)}
                      className="rounded-lg bg-brand-primary px-3 py-1 text-xs font-bold text-white disabled:opacity-60">同意</button>
                    <button type="button" disabled={busy} onClick={() => setRejecting(r)}
                      className="rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium text-gray-600 disabled:opacity-60">拒絕</button>
                  </div>
                </div>
              ))}
              <p className="mt-1.5">同意後，對方可以一起查看孩子的課程、繳費與簽到。不認識的人請直接拒絕。</p>
            </div>
          )}

          {family ? (
            <>
              <div className="flex flex-wrap gap-1">
                {(family.members || []).map((m) => (
                  <span key={m.parent_id} className="inline-flex items-center gap-1 rounded-full bg-brand-primary/10 px-2 py-0.5 font-medium text-brand-primary">
                    {m.name}（{m.relationship_label}）{m.role === 'owner' ? '・擁有者' : ''}{m.is_self ? '・我' : ''}
                    {isOwner && m.role !== 'owner' && (
                      <button type="button" disabled={busy} onClick={() => setUnbinding(m)}
                        className="ml-0.5 font-bold text-brand-error disabled:opacity-60">解綁</button>
                    )}
                  </span>
                ))}
              </div>
              {groups.length > 0 && (
                <div className="space-y-1">
                  <div className="font-bold text-gray-600">家人名下的孩子</div>
                  {groups.map((g) => (
                    <div key={g.owner} className="rounded-lg border border-gray-100 p-2">
                      <div className="text-gray-400">{g.name}（{g.rel}）名下</div>
                      {g.kids.map((k) => (
                        <div key={k.id} className="mt-0.5 font-medium text-gray-900">
                          {k.name}<span className="ml-1 font-normal text-gray-500">{formatPlainDate(k.birth_date)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <p className="text-gray-400">家人可一起看課程、繳費、簽到與預約；孩子資料由所屬家長維護。</p>
              {block.can_invite && <InviteBox hasFamily invites={block.invites} onChanged={onChanged} />}
              {isOwner ? (
                <p className="text-gray-400">您是擁有者，可以邀請或解綁家人；要轉移擁有者請洽櫃台。</p>
              ) : (
                <button type="button" disabled={busy} onClick={() => setLeaving(true)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-600 disabled:opacity-60">退出家庭</button>
              )}
            </>
          ) : pending ? (
            <>
              <p className="rounded-lg bg-brand-teal/10 p-2 text-gray-700">
                <b>等對方同意</b>：以「{pending.relationship_label}」申請加入「{pending.target_student_name}」的家庭（{formatTWDateTime(pending.created_at)}），對方家長同意後就會加入。
              </p>
              <button type="button" disabled={busy} onClick={() => setCancelling(true)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-600 disabled:opacity-60">取消申請</button>
            </>
          ) : (
            <>
              {request?.status === 'rejected' && (
                <p className="rounded-lg bg-brand-error/5 p-2 text-brand-error">上次申請未通過：{request.reject_reason}</p>
              )}
              {block.can_invite && <InviteBox hasFamily={false} invites={block.invites} onChanged={onChanged} />}
              <div>
                <div className="text-xs font-bold text-gray-800">或申請加入家人的家庭</div>
                <p className="mt-0.5 text-gray-500">填孩子的名字和對方家長的手機，對方同意後就會加入。</p>
              </div>
              {!applyDraft && (
                <button type="button" onClick={() => setApplyDraft({ student_name: '', parent_phone: '' })}
                  className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-bold text-white">申請加入家庭</button>
              )}
            </>
          )}
        </div>

        {applyDraft && !family && !pending && (
          <form className="mt-3 grid gap-3 border-t border-gray-100 pt-3" onSubmit={submit} noValidate>
            <p className="text-[11px] leading-4 text-gray-500">填家裡一位孩子的名字，和孩子登記在的那位家長的手機；對方同意後就會加入。</p>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">孩子的名字</span>
              <input className={inputCls} value={applyDraft.student_name || ''} maxLength={40}
                onChange={(e) => setApplyDraft({ ...applyDraft, student_name: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">對方家長的手機</span>
              <input className={`${inputCls} font-mono`} inputMode="numeric" placeholder="09xxxxxxxx" value={applyDraft.parent_phone || ''}
                onChange={(e) => setApplyDraft({ ...applyDraft, parent_phone: e.target.value.replace(/[^\d]/g, '').slice(0, 10) })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">您是孩子的</span>
              <select className={inputCls} value={relationship} onChange={(e) => setRelationship(e.target.value)}>
                <option value="">請選擇</option>
                {RELATIONSHIP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">備註<span className="ml-1 font-normal text-gray-400">（選填）</span></span>
              <input className={inputCls} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例：我是孩子的阿姨，平常負責接送" />
            </label>
            <div className="flex gap-2">
              <button type="submit" disabled={!canSubmit} className="flex-1 rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white disabled:opacity-60">
                {busy ? '送出中...' : '送出申請'}
              </button>
              <button type="button" onClick={() => setApplyDraft(null)} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700">取消</button>
            </div>
          </form>
        )}
      </Collapsible>

      <ConfirmModal open={leaving} title="退出家庭？" confirmLabel="確定退出" cancelLabel="返回" tone="danger" busy={busy}
        onCancel={() => !busy && setLeaving(false)}
        onConfirm={async () => { await run(() => familyApi.leave(), '已退出家庭'); setLeaving(false); }}>
        退出後您只看得到自己名下的資料，家人也看不到您名下的孩子。孩子的課程與付款記錄不受影響；之後要再加入需要重新申請。
      </ConfirmModal>
      <ConfirmModal open={cancelling} title="取消申請？" confirmLabel="取消申請" cancelLabel="返回" busy={busy}
        onCancel={() => !busy && setCancelling(false)}
        onConfirm={async () => { await run(() => familyApi.cancelRequest(pending.id), '已取消申請'); setCancelling(false); }}>
        取消後可以再重新申請。
      </ConfirmModal>
      <ConfirmModal open={!!unbinding} title={`解綁「${unbinding?.name || ''}」？`} confirmLabel="確定解綁" cancelLabel="返回" tone="danger" busy={busy}
        onCancel={() => !busy && setUnbinding(null)}
        onConfirm={async () => { await run(() => familyApi.revokeMember(unbinding.parent_id), '已解綁'); setUnbinding(null); }}>
        解綁後他只看得到自己名下的資料，家人也看不到他名下的孩子。孩子的課程與付款記錄不受影響；之後要再加入需要重新邀請。
      </ConfirmModal>
      <ConfirmModal open={!!rejecting} title="拒絕這筆申請？" confirmLabel="確定拒絕" cancelLabel="返回" tone="danger" busy={busy}
        onCancel={() => !busy && setRejecting(null)}
        onConfirm={async () => { await run(() => familyApi.rejectRequest(rejecting.id), '已拒絕'); setRejecting(null); }}>
        {rejecting ? `${rejecting.applicant_name}（${rejecting.relationship_label}）不會加入您的家庭，對方會收到「申請未通過」的通知。` : ''}
      </ConfirmModal>
    </div>
  );
}

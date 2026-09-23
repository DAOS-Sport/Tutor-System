import React, { useState } from 'react';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';
import ConfirmModal from './ConfirmModal';
import { useToast } from '../context/ToastContext';
import { familyApi, RELATIONSHIP_OPTIONS } from '../api/family';
import { formatPlainDate, formatTWDateTime, todayTaipeiYMD } from '../utils/format';

// 個人頁「我的家庭」（規格 §8、§14）。block＝GET /parents/me 的 family 區塊；null＝功能沒開，整張卡不出現。
// 申請表單的開關由個人頁控制（applyDraft），因為頂端的重複提示、新增學員被擋時也要能帶資料打開它。

const inputCls = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-primary';
const TW_ID_RE = /^[A-Z][12]\d{8}$/;

export default function FamilyCard({ block, applyDraft, setApplyDraft, onChanged }) {
  const toast = useToast();
  const [relationship, setRelationship] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  if (!block) return null;
  const { family, join_request: request, rebind_required: rebindRequired } = block;
  const pending = request?.status === 'pending' ? request : null;

  const idNumber = String(applyDraft?.id_number || '').trim().toUpperCase();
  const birthDate = String(applyDraft?.birth_date || '').trim();
  const canSubmit = TW_ID_RE.test(idNumber) && /^\d{4}-\d{2}-\d{2}$/.test(birthDate) && relationship && !busy;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await familyApi.createRequest({ id_number: idNumber, birth_date: birthDate, relationship, note: note.trim() || undefined });
      toast.success('已送出申請，櫃台確認後會用 LINE 通知您');
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
    } catch (err) {
      toast.error(err?.response?.data?.error || '操作失敗，請稍後再試');
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

  return (
    <section className="mb-4 rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-bold text-gray-900">我的家庭</h3>

      {rebindRequired && (
        <p className="mt-2 rounded-lg bg-amber-50 p-2.5 text-xs leading-5 text-amber-900">
          您的 LINE 帳號換過了，家庭需要櫃台重新綁定後才會恢復。請聯絡櫃台協助。
        </p>
      )}

      {family ? (
        <div className="mt-2 space-y-3">
          {family.status === 'frozen' && (
            <p className="rounded-lg bg-gray-100 p-2.5 text-xs text-gray-700">家庭共用功能暫停中，目前只看得到自己名下的資料。如有疑問請聯絡櫃台。</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {(family.members || []).map((m) => (
              <span key={m.parent_id} className="rounded-full bg-brand-primary/10 px-2.5 py-1 text-xs font-medium text-brand-primary">
                {m.name}（{m.relationship_label}）{m.role === 'owner' ? '・擁有者' : ''}{m.is_self ? '・我' : ''}
              </span>
            ))}
          </div>
          {groups.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-bold text-gray-600">家人名下的孩子</div>
              {groups.map((g) => (
                <div key={g.owner} className="rounded-lg border border-gray-100 p-2.5 text-xs text-gray-700">
                  <div className="text-gray-500">{g.name}（{g.rel}）名下</div>
                  {g.kids.map((k) => (
                    <div key={k.id} className="mt-0.5 font-medium text-gray-900">
                      {k.name}<span className="ml-1 font-normal text-gray-500">{formatPlainDate(k.birth_date)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] leading-5 text-gray-400">
            家人可以一起查看孩子的課程、幫忙繳費、簽到與預約。孩子的基本資料由所屬的家長維護。
          </p>
          {family.role === 'owner' ? (
            <p className="text-[11px] text-gray-400">您是這個家庭的擁有者；要退出或調整成員請洽櫃台。</p>
          ) : (
            <button type="button" disabled={busy} onClick={() => setLeaving(true)}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 disabled:opacity-60">退出家庭</button>
          )}
        </div>
      ) : pending ? (
        <div className="mt-2 space-y-2 text-xs text-gray-700">
          <p className="rounded-lg bg-brand-teal/10 p-2.5 leading-5">
            <b>審核中</b>：您以「{pending.relationship_label}」申請加入「{pending.target_student_name}」的家庭（{formatTWDateTime(pending.created_at)} 送出）。櫃台確認後會用 LINE 通知您。
          </p>
          <button type="button" disabled={busy} onClick={() => setCancelling(true)}
            className="rounded-lg border border-gray-200 px-3 py-2 font-medium text-gray-600 disabled:opacity-60">取消申請</button>
        </div>
      ) : (
        <div className="mt-2 space-y-2 text-xs text-gray-600">
          {request?.status === 'rejected' && (
            <p className="rounded-lg bg-brand-error/5 p-2.5 text-brand-error">上次的申請未通過：{request.reject_reason}</p>
          )}
          <p className="leading-5">孩子的另一位家長或爺爺奶奶已經有帳號的話，可以申請加入同一個家庭。櫃台確認後，就能一起查看、繳費、簽到。</p>
          {!applyDraft && (
            <button type="button" onClick={() => setApplyDraft({ id_number: '', birth_date: '' })}
              className="rounded-lg bg-brand-primary px-3 py-2 text-xs font-bold text-white">申請加入家庭</button>
          )}
        </div>
      )}

      {applyDraft && !family && !pending && (
        <form className="mt-3 grid gap-3 border-t border-gray-100 pt-3" onSubmit={submit} noValidate>
          <p className="text-[11px] leading-5 text-gray-500">請填家裡其中一位孩子的身分證字號與生日，系統會找到孩子所屬的家長，再由櫃台確認。</p>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">孩子的身分證字號</span>
            <input className={inputCls} value={applyDraft.id_number}
              onChange={(e) => setApplyDraft({ ...applyDraft, id_number: e.target.value.toUpperCase() })} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">孩子的生日</span>
            <DateTimePicker value={applyDraft.birth_date} max={todayTaipeiYMD()} placeholder="出生年月日"
              onChange={(v) => setApplyDraft({ ...applyDraft, birth_date: v })} />
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
    </section>
  );
}

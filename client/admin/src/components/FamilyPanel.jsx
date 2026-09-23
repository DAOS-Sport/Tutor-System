import React, { useEffect, useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import StatusBadge from './StatusBadge';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { familiesApi, RELATIONSHIP_OPTIONS } from '../api/families';
import { formatTWDateTime } from '../utils/format';

// Z01 編輯視窗的「家庭」區塊（規格 §7 第 2 點）。每個動作按下去就生效（各自一支 API），
// 跟編輯視窗的「保存變更」無關。成員以 LINE userId 綁定：解綁＝清掉他在家庭裡的 userId，
// 孩子、訂單、上課紀錄都不動；主帳號換過 LINE 的成員顯示「需重新綁定」，再加一次就是重新綁定。

const ACTION_LABELS = {
  family_created: '建立家庭',
  member_added: '加入成員',
  member_rebound: '重新綁定 LINE',
  member_revoked: '櫃台解綁成員',
  member_left: '成員自己退出',
  relationship_changed: '修改關係',
  owner_transferred: '轉移擁有者',
  family_frozen: '凍結家庭',
  family_unfrozen: '解除凍結',
  pending_member_added: '預先登記手機',
  pending_member_removed: '取消預先登記',
  duplicate_resolved: '處理重複學員',
  request_approved: '核准合併申請',
};

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-xs focus:border-brand-teal focus:outline-none';

function RelationshipSelect({ value, onChange, disabled, allowEmpty = false }) {
  return (
    <select className={inputCls} value={value || ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {allowEmpty ? <option value="">（不填）</option> : <option value="" disabled>選擇關係</option>}
      {RELATIONSHIP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export default function FamilyPanel({ parent }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null); // { family } | null（載入中）
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ownerRel, setOwnerRel] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addRel, setAddRel] = useState('');
  const [pendPhone, setPendPhone] = useState('');
  const [pendRel, setPendRel] = useState('');
  const [revoking, setRevoking] = useState(null); // member
  const [revokeReason, setRevokeReason] = useState('');
  const [transferTo, setTransferTo] = useState(null); // member
  const [freezing, setFreezing] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  async function load() {
    setLoadError('');
    try {
      setData(await familiesApi.byParent(parent.id));
    } catch (err) {
      setData({ family: null });
      setLoadError(err?.response?.data?.error || '讀取家庭資料失敗');
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [parent.id]);

  async function act({ run, ok }) {
    setBusy(true);
    try {
      const r = await run();
      toast.success(r?.result?.rebound ? '已重新綁定到這位家長目前的 LINE' : ok);
      await load();
      return true;
    } catch (err) {
      toast.error(err?.response?.data?.error || '操作失敗');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const family = data?.family || null;
  const members = family?.members || [];

  return (
    <div className="overflow-hidden rounded border border-gray-300">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-teal-700 px-4 py-2 text-xs font-bold text-white">
        <span>家庭</span>
        <span className="font-normal text-teal-50">這一區的操作會立即生效，不用按「保存變更」</span>
      </div>

      <div className="space-y-4 bg-white p-4 text-xs">
        {!data && <p className="text-gray-400">載入中…</p>}
        {loadError && <p className="text-brand-error">{loadError}</p>}

        {data && !family && !loadError && (
          <div className="space-y-2">
            <p className="text-gray-600">這位家長還沒有家庭。建立後可以把爸爸、媽媽、爺爺奶奶等家人加進來，一起查看孩子的課程、繳費、簽到。</p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-gray-500">這位家長是孩子的</span>
              <RelationshipSelect value={ownerRel} onChange={setOwnerRel} disabled={busy} allowEmpty />
              <button type="button" disabled={busy}
                onClick={() => act({ run: () => familiesApi.create(parent.id, ownerRel), ok: '已建立家庭' })}
                className="rounded bg-brand-primary px-3 py-1 font-semibold text-white hover:bg-brand-teal disabled:opacity-50">
                以這位家長為擁有者建立家庭
              </button>
            </div>
          </div>
        )}

        {family && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone={family.status === 'frozen' ? 'errorSoft' : 'green'}>{family.status === 'frozen' ? '已凍結' : '使用中'}</StatusBadge>
              <span className="text-gray-600">{members.length} 人</span>
              <span className="text-gray-400">建立：{formatTWDateTime(family.created_at)}{family.created_by ? `・${family.created_by}` : ''}</span>
              {isAdmin && (
                <button type="button" disabled={busy} onClick={() => setFreezing(true)}
                  className={`ml-auto rounded border px-2 py-1 font-semibold ${family.status === 'frozen' ? 'border-brand-green text-brand-green' : 'border-brand-error text-brand-error'} disabled:opacity-50`}>
                  {family.status === 'frozen' ? '解除凍結' : '凍結家庭'}
                </button>
              )}
            </div>
            {family.status === 'frozen' && (
              <p className="rounded bg-brand-error-soft px-3 py-2 text-brand-error-strong">凍結中：全家暫時只能看到自己名下的資料。</p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-gray-600">
                    {['成員', '手機', '角色', '關係', 'LINE 綁定', '操作'].map((h) => <th key={h} className="p-2 font-bold">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {members.map((m) => (
                    <tr key={m.parent_id}>
                      <td className="p-2 font-medium">{m.name}{String(m.parent_id) === String(parent.id) && <span className="ml-1 text-gray-400">（本人）</span>}</td>
                      <td className="p-2 font-mono">{m.phone}</td>
                      <td className="p-2">{m.role === 'owner' ? <StatusBadge tone="primary">擁有者</StatusBadge> : '成員'}</td>
                      <td className="p-2">
                        <RelationshipSelect value={m.relationship} disabled={busy}
                          onChange={(v) => act({ run: () => familiesApi.setRelationship(family.id, m.parent_id, v), ok: '已修改關係' })} />
                      </td>
                      <td className="p-2">
                        {m.line_bound
                          ? <StatusBadge tone="green">有效</StatusBadge>
                          : <span title="這位家長的主帳號換過 LINE，家庭裡記的還是舊的；按「重新綁定」改成目前這支">
                              <StatusBadge tone="amber">需重新綁定</StatusBadge>
                            </span>}
                      </td>
                      <td className="space-x-2 whitespace-nowrap p-2">
                        {!m.line_bound && (
                          <button type="button" disabled={busy} className="font-semibold text-brand-teal hover:underline disabled:opacity-50"
                            onClick={() => act({ run: () => familiesApi.addMember(family.id, { parentId: m.parent_id, relationship: m.relationship || 'guardian' }), ok: '已重新綁定' })}>
                            重新綁定</button>
                        )}
                        {m.role !== 'owner' && (
                          <button type="button" disabled={busy} className="font-semibold text-brand-error hover:underline disabled:opacity-50"
                            onClick={() => { setRevoking(m); setRevokeReason(''); }}>解綁</button>
                        )}
                        {isAdmin && m.role !== 'owner' && (
                          <button type="button" disabled={busy} className="font-semibold text-brand-primary hover:underline disabled:opacity-50"
                            onClick={() => setTransferTo(m)}>設為擁有者</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 font-bold text-gray-700">加入成員（對方已經註冊）</div>
              <div className="flex flex-wrap items-center gap-2">
                <input className={`${inputCls} w-36 font-mono`} value={addPhone} placeholder="09xxxxxxxx"
                  onChange={(e) => setAddPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))} />
                <RelationshipSelect value={addRel} onChange={setAddRel} disabled={busy} />
                <button type="button" disabled={busy || addPhone.length !== 10 || !addRel}
                  onClick={async () => {
                    if (await act({ run: () => familiesApi.addMember(family.id, { phone: addPhone, relationship: addRel }), ok: '已加入成員' })) {
                      setAddPhone(''); setAddRel('');
                    }
                  }}
                  className="rounded bg-brand-primary px-3 py-1 font-semibold text-white hover:bg-brand-teal disabled:opacity-50">加入</button>
              </div>
              <p className="mt-1 text-gray-400">對方要先用 LINE 註冊並綁定；加入後會用 LINE 通知全家。</p>
            </div>

            <div className="rounded border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 font-bold text-gray-700">預先登記（對方還沒註冊）</div>
              {(family.pending_members || []).length > 0 && (
                <ul className="mb-2 space-y-1">
                  {family.pending_members.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{p.phone_canonical}</span>
                      <span>{p.relationship_label}</span>
                      <span className="text-gray-400">有效到 {formatTWDateTime(p.expires_at)}</span>
                      <button type="button" disabled={busy} className="font-semibold text-brand-error hover:underline disabled:opacity-50"
                        onClick={() => act({ run: () => familiesApi.removePending(family.id, p.id), ok: '已取消預先登記' })}>取消</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input className={`${inputCls} w-36 font-mono`} value={pendPhone} placeholder="09xxxxxxxx"
                  onChange={(e) => setPendPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 10))} />
                <RelationshipSelect value={pendRel} onChange={setPendRel} disabled={busy} />
                <button type="button" disabled={busy || pendPhone.length !== 10 || !pendRel}
                  onClick={async () => {
                    if (await act({ run: () => familiesApi.addPending(family.id, pendPhone, pendRel), ok: '已預先登記' })) {
                      setPendPhone(''); setPendRel('');
                    }
                  }}
                  className="rounded border border-brand-primary px-3 py-1 font-semibold text-brand-primary hover:bg-brand-primary/5 disabled:opacity-50">登記</button>
              </div>
              <p className="mt-1 text-gray-400">
                對方用這支手機註冊，而且註冊時填的孩子身分證字號與生日跟家裡的孩子相同，才會自動加入；
                不相符就不加入，請對方改從個人頁申請合併。登記 30 天內有效。
              </p>
            </div>

            <div>
              <button type="button" onClick={() => setShowLogs((v) => !v)} className="font-semibold text-brand-teal hover:underline">
                {showLogs ? '收合異動紀錄' : `異動紀錄（${(family.logs || []).length}）`}
              </button>
              {showLogs && (
                <ul className="mt-2 space-y-1 text-gray-600">
                  {(family.logs || []).map((l) => (
                    <li key={l.id}>
                      <span className="font-mono text-gray-400">{formatTWDateTime(l.created_at)}</span>
                      <span className="ml-2 font-semibold">{ACTION_LABELS[l.action] || l.action}</span>
                      {l.target_name && <span className="ml-1">・{l.target_name}</span>}
                      <span className="ml-2 text-gray-400">{l.actor}</span>
                      {l.detail?.reason && <span className="ml-2">原因：{l.detail.reason}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!revoking}
        title="解綁家庭成員"
        confirmLabel="確認解綁"
        tone="danger"
        busy={busy}
        confirmDisabled={!revokeReason.trim()}
        onCancel={() => !busy && setRevoking(null)}
        onConfirm={async () => {
          if (await act({ run: () => familiesApi.revokeMember(family.id, revoking.parent_id, revokeReason.trim()), ok: '已解綁' })) setRevoking(null);
        }}
      >
        {revoking && (
          <div className="space-y-3">
            <p>把「<b>{revoking.name}</b>」的 LINE 從這個家庭解綁。</p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-gray-600">
              <li>解綁後他只看得到自己名下的資料，家人也看不到他名下的孩子</li>
              <li>孩子、報名、上課紀錄<b>完全不動</b></li>
              <li>會用 LINE 通知全家與他本人</li>
            </ul>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">解綁原因（必填，會寫入異動紀錄）</span>
              <textarea rows={3} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
            </label>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!transferTo}
        title="轉移家庭擁有者"
        confirmLabel="確認轉移"
        busy={busy}
        onCancel={() => !busy && setTransferTo(null)}
        onConfirm={async () => {
          if (await act({ run: () => familiesApi.transferOwner(family.id, transferTo.parent_id), ok: '已轉移擁有者' })) setTransferTo(null);
        }}
      >
        {transferTo && <p>把擁有者改成「<b>{transferTo.name}</b>」。原擁有者會變成一般成員，之後可以被解綁。</p>}
      </ConfirmDialog>

      <ConfirmDialog
        open={freezing}
        title={family?.status === 'frozen' ? '解除凍結' : '凍結家庭'}
        confirmLabel={family?.status === 'frozen' ? '確認解除' : '確認凍結'}
        tone={family?.status === 'frozen' ? 'primary' : 'danger'}
        busy={busy}
        onCancel={() => !busy && setFreezing(false)}
        onConfirm={async () => {
          const next = family?.status !== 'frozen';
          if (await act({ run: () => familiesApi.freeze(family.id, next), ok: next ? '已凍結家庭' : '已解除凍結' })) setFreezing(false);
        }}
      >
        <p>{family?.status === 'frozen'
          ? '恢復家人之間互相查看、繳費、簽到。'
          : '凍結後全家暫時只能看到自己名下的資料（有爭議時使用）。資料不會刪除，隨時可以解除。'}</p>
      </ConfirmDialog>
    </div>
  );
}

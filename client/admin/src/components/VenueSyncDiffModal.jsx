import React, { useMemo, useState } from 'react';

const FIELD_LABELS = {
  name: '場館名稱',
  address: '地址',
  bank_institution_name: '收款銀行',
  bank_branch_name: '銀行分行',
  account_holder: '戶名',
  account_number: '帳號',
};

function Section({ color, title, count, children }) {
  const map = {
    green: 'border-green-300 bg-green-50',
    amber: 'border-amber-300 bg-amber-50',
    red:   'border-red-300 bg-red-50',
  };
  return (
    <div className={`rounded-lg border p-4 ${map[color]}`}>
      <div className="mb-2 text-sm font-bold text-gray-800">{title}（{count}）</div>
      {count === 0 ? (
        <div className="text-xs text-gray-500">無</div>
      ) : (
        <div className="space-y-2">{children}</div>
      )}
    </div>
  );
}

function Row({ checked, onToggle, disabled, disabledHint, children }) {
  return (
    <label className={`flex items-start gap-2 rounded bg-white p-2 ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <div className="flex-1 text-sm text-gray-700">
        {children}
        {disabled && disabledHint && (
          <div className="mt-1 text-xs text-amber-700">⚠ {disabledHint}</div>
        )}
      </div>
    </label>
  );
}

export default function VenueSyncDiffModal({ diff, onCancel, onConfirm }) {
  const { added = [], updated = [], removed = [] } = diff || {};
  const [pickAdded, setPickAdded] = useState(() => new Set(added.map(x => x.code)));
  // 全部欄位都被手動覆寫的 updated rows 預設不勾（後端會跳過，避免「勾了卻沒套用」的誤導）
  const [pickUpdated, setPickUpdated] = useState(() => new Set(
    updated.filter(u => Object.values(u.changes).some(c => !c.overridden)).map(x => x.code)
  ));
  const [pickRemoved, setPickRemoved] = useState(() => new Set(removed.filter(x => !x.overridden).map(x => x.code)));
  const [busy, setBusy] = useState(false);

  const totalSelected = pickAdded.size + pickUpdated.size + pickRemoved.size;
  const empty = added.length + updated.length + removed.length === 0;

  function toggle(set, setSet, key) {
    const n = new Set(set);
    n.has(key) ? n.delete(key) : n.add(key);
    setSet(n);
  }

  const updatedHasAllOverridden = useMemo(() => {
    const m = {};
    for (const u of updated) {
      m[u.code] = Object.values(u.changes).every(c => c.overridden);
    }
    return m;
  }, [updated]);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm({
        added: [...pickAdded],
        updated: [...pickUpdated],
        removed: [...pickRemoved],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <div className="text-base font-bold text-gray-900">Ragic 場館同步差異</div>
            <div className="text-xs text-gray-500">勾選要套用的變動，按下「確認套用」後才會實際寫入。</div>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto px-6 py-5">
          {empty && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center text-sm text-gray-500">
              目前所有場館已同步，無變動。
            </div>
          )}

          {!empty && (
            <>
              <Section color="green" title="新增" count={added.length}>
                {added.map((a) => (
                  <Row
                    key={a.code}
                    checked={pickAdded.has(a.code)}
                    onToggle={() => toggle(pickAdded, setPickAdded, a.code)}
                  >
                    <div className="font-medium">
                      {a.name} <span className="text-xs text-gray-400">({a.code})</span>
                      {a.reactivate && <span className="ml-2 rounded bg-green-200 px-1.5 py-0.5 text-xs">重新啟用</span>}
                    </div>
                    <div className="text-xs text-gray-500">{a.address || '（無地址）'}</div>
                  </Row>
                ))}
              </Section>

              <Section color="amber" title="更動" count={updated.length}>
                {updated.map((u) => {
                  const allOver = updatedHasAllOverridden[u.code];
                  return (
                    <Row
                      key={u.code}
                      checked={pickUpdated.has(u.code)}
                      onToggle={() => toggle(pickUpdated, setPickUpdated, u.code)}
                      disabled={allOver}
                      disabledHint={allOver ? '所有差異欄位皆已被後台手動覆寫，sync 不會寫入' : ''}
                    >
                      <div className="font-medium">
                        {u.name} <span className="text-xs text-gray-400">({u.code})</span>
                      </div>
                      <table className="mt-1 w-full text-xs">
                        <tbody>
                          {Object.entries(u.changes).map(([f, c]) => (
                            <tr key={f} className={c.overridden ? 'text-gray-400 line-through' : ''}>
                              <td className="py-0.5 pr-2 align-top text-gray-500">{FIELD_LABELS[f] || f}</td>
                              <td className="py-0.5 pr-2 align-top">{c.from || <span className="text-gray-300">（空）</span>}</td>
                              <td className="py-0.5 pr-2 align-top text-gray-400">→</td>
                              <td className="py-0.5 align-top">{c.to || <span className="text-gray-300">（空）</span>}</td>
                              {c.overridden && <td className="pl-2 text-amber-600">手動覆寫</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Row>
                  );
                })}
              </Section>

              <Section color="red" title="移除（軟刪除）" count={removed.length}>
                {removed.map((r) => (
                  <Row
                    key={r.code}
                    checked={pickRemoved.has(r.code)}
                    onToggle={() => toggle(pickRemoved, setPickRemoved, r.code)}
                    disabled={r.overridden}
                    disabledHint={r.overridden ? '此場館 active 狀態已被手動覆寫，sync 不會軟刪除' : ''}
                  >
                    <div className="font-medium">
                      {r.name} <span className="text-xs text-gray-400">({r.code})</span>
                    </div>
                    <div className="text-xs text-gray-500">會將 is_active 設為 false（保留 enrollment 關聯，不硬刪除）</div>
                  </Row>
                ))}
              </Section>
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-3">
          <div className="text-sm text-gray-500">
            {empty ? '無可套用項目' : `已勾選 ${totalSelected} 項`}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              取消
            </button>
            <button
              onClick={handleConfirm}
              disabled={empty || totalSelected === 0 || busy}
              className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
            >
              {busy ? '套用中…' : '確認套用'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

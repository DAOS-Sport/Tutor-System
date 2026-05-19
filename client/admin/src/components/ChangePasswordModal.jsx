import React, { useEffect, useState } from 'react';
import { authApi } from '../api/auth';
import { useToast } from '../context/ToastContext';

export default function ChangePasswordModal({ open, onClose }) {
  const toast = useToast();
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setOldPwd(''); setNewPwd(''); setConfirm(''); setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const lenOk = newPwd.length >= 4;
  const matchOk = newPwd && newPwd === confirm;
  const canSubmit = oldPwd && lenOk && matchOk && newPwd !== oldPwd && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await authApi.changePassword({ oldPassword: oldPwd, newPassword: newPwd });
      toast.success('密碼已更新，下次登入請使用新密碼');
      onClose?.();
    } catch (err) {
      const msg = err?.response?.data?.error || '修改密碼失敗';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose?.()}
      role="dialog" aria-modal="true" aria-label="修改密碼"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="mb-1 text-lg font-bold text-brand-primary">修改密碼</h3>
        <p className="mb-4 text-xs text-gray-500">輸入舊密碼與新密碼（至少 4 個字元）</p>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">舊密碼</span>
            <input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">新密碼</span>
            <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
            {newPwd && !lenOk && (
              <span className="mt-1 block text-xs text-brand-error">至少 4 個字元</span>
            )}
            {newPwd && oldPwd && newPwd === oldPwd && (
              <span className="mt-1 block text-xs text-brand-error">新密碼不可與舊密碼相同</span>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">確認新密碼</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
            {confirm && !matchOk && (
              <span className="mt-1 block text-xs text-brand-error">兩次輸入的新密碼不一致</span>
            )}
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onClose} disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50">
            取消
          </button>
          <button type="button" onClick={submit} disabled={!canSubmit}
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50">
            {busy ? '處理中…' : '更新密碼'}
          </button>
        </div>
      </div>
    </div>
  );
}

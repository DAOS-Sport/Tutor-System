import React, { useEffect, useMemo, useState } from 'react';
import { coursesApi } from '../api/courses';
import { checkinsApi } from '../api/checkins';

/**
 * U13 免預約自助簽到彈窗（checkin_mode='self' 的課程期）。
 *
 * 防「畫面沒更新」設計：開啟當下即向伺服器重抓本課程最新狀態（剩餘堂數／今日是否
 * 已簽到），不信任卡片上的舊資料；送出後由後端守門（每日一次 DB 唯一鍵、堂數上限），
 * 收到 409 顯示明確原因並讓外層刷新列表。網路失敗可放心重按——後端冪等，不會重複扣堂。
 */
export default function SelfCheckinModal({ course, onClose, onDone }) {
  const [info, setInfo] = useState(null);      // 伺服器最新狀態
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const open = !!course;

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  // 開啟即重抓最新狀態（server-authoritative）
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setInfo(null);
    setLoadError(null);
    coursesApi.get(course.id)
      .then((fresh) => {
        if (!alive) return;
        setInfo(fresh);
        // 預設全選（共班多位小孩通常一起上課）
        setSelected(new Set((fresh.students_detail || []).map((s) => s.id)));
      })
      .catch(() => {
        if (!alive) return;
        setLoadError('無法取得課程最新狀態，請檢查網路後重試');
      });
    return () => { alive = false; };
  }, [open, course?.id]);

  const students = info?.students_detail || [];
  const remaining = info ? Math.max(0, (info.total_sessions || 0) - (info.used_sessions || 0)) : null;
  const blocked = useMemo(() => {
    if (!info) return null;
    if (info.self_checked_in_today) {
      if (info.partner_checkin_name) {
        return `已由 ${info.partner_checkin_name} 完成簽到（整組共用堂數，每日限簽一次）；如需更正請洽櫃檯。`;
      }
      return info.partner_checkin_label
        ? `${info.partner_checkin_label}已代為簽到；如需更正請洽櫃檯。`
        : '今日已完成簽到（同一課程每日限簽一次）；如需更正請洽櫃檯。';
    }
    if (remaining <= 0) return '本期堂數已用完，如需續課請重新報名。';
    if (info.checkin_mode !== 'self') return '此課程為預約制，請改用「預約劃課」。';
    return null;
  }, [info, remaining]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (busy || !info || blocked || !selected.size) return;
    setBusy(true);
    try {
      const res = await checkinsApi.selfCheckin({
        coursePeriodId: info.course_period_id,
        studentIds: [...selected],
      });
      onDone?.({
        students: res.checked_in_students || [],
        remaining: res.remaining_sessions,
      });
    } catch (e) {
      const code = e?.response?.data?.code;
      const serverMsg = e?.response?.data?.error;
      const msg = serverMsg
        || (code ? '簽到未完成，請稍後再試' : '網路不穩定，請再按一次「確認簽到」（不會重複扣堂）');
      onDone?.({ error: msg, refresh: !!code });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-4 pb-5 sm:items-center sm:pb-0"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose?.(); }}
    >
      <div role="dialog" aria-modal="true" className="w-full max-w-[390px] rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="mb-1 text-center text-base font-bold text-brand-primary">今日上課簽到</h2>
        <p className="mb-3 text-center text-xs text-gray-500">
          簽到後將使用 1 堂課程堂數（每日限簽一次）
        </p>

        {loadError ? (
          <div className="rounded-xl bg-red-50 p-3 text-center text-sm text-red-600">{loadError}</div>
        ) : !info ? (
          <div className="py-6 text-center text-sm text-gray-400">正在確認課程最新狀態…</div>
        ) : blocked ? (
          <div className="rounded-xl bg-amber-50 p-3 text-center text-sm text-amber-700">{blocked}</div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between rounded-xl bg-gray-50 px-3 py-2 text-sm">
              <span className="text-gray-600">剩餘堂數</span>
              <span className="font-bold text-brand-primary">{remaining} / {info.total_sessions} 堂</span>
            </div>
            <div className="mb-1 text-xs font-medium text-gray-500">今日上課學員（可取消勾選未到課者）</div>
            <div className="mb-4 space-y-1.5">
              {students.map((s) => (
                <label key={s.id} className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() => toggle(s.id)}
                    className="h-4 w-4 accent-brand-primary"
                  />
                  <span className="text-sm font-medium text-gray-800">{s.name}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="flex-1 rounded-xl border border-gray-300 py-2.5 text-sm font-bold text-gray-600"
          >
            {blocked || loadError ? '關閉' : '取消'}
          </button>
          {!blocked && !loadError && (
            <button
              type="button"
              disabled={busy || !info || !selected.size}
              onClick={submit}
              className="flex-1 rounded-xl bg-brand-primary py-2.5 text-sm font-bold text-white disabled:opacity-50"
            >
              {busy ? '簽到中…' : `確認簽到（${selected.size} 位）`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

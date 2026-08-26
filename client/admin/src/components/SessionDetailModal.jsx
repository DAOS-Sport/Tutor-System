import React from 'react';
import Sheet from './Sheet';
import StatusBadge from './StatusBadge';
import { courseTypeLabel, checkinStatusLabel, formatTWDateTime, checkinSourceLabel } from '../utils/format';

const CHECKIN_TONE = { checked_in: 'green', not_yet: 'gray', absent: 'error' };

export default function SessionDetailModal({ session, venueName, onClose }) {
  if (!session) return null;
  return (
    // 原本在 375px 會發生什麼：這張卡置中浮在畫面正中央，底部那顆「關閉」落在螢幕
    // 垂直中線附近 —— 單手拿手機時拇指構不到，要換手或把手機往下滑。而且置中卡片
    // 沒有「往下滑可以關掉」的暗示，唯一的出路是瞄準右上角那顆 ✕。
    // 改成 md 以下貼底升起的面板（Sheet），md 以上完全維持原本的置中 max-w-md + rounded-lg。
    <Sheet
      z="z-30"
      maxWidth="md:max-w-md"
      desktopRounded="md:rounded-lg"
      label="課程詳情"
      onClose={onClose}
      header={(
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="text-base font-semibold text-brand-primary">課程詳情</h3>
          {/* 純文字 ✕ 的實際命中區只有字高（約 20px），手指按不準。
              手機放大到 44px；桌機是滑鼠、維持原本的緊密度。 */}
          <button onClick={onClose} aria-label="關閉" className="-mr-2 flex h-11 w-11 items-center justify-center text-gray-400 hover:text-gray-600 md:-mr-0 md:h-auto md:w-auto">✕</button>
        </div>
      )}
      footer={(
        <div className="flex justify-end border-t border-gray-100 px-4 py-3">
          {/* px-4 py-1.5 text-sm 實高約 32px，低於手指可靠命中的 44px；
              救生員站在池畔單手操作，按不到就是按不到。桌機列表密度不動。 */}
          <button
            onClick={onClose}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm hover:bg-gray-50 md:min-h-0"
          >關閉</button>
        </div>
      )}
    >
      <dl className="space-y-3 px-4 py-4 text-sm">
          <Row k="日期" v={<span className="font-mono">{session.date}</span>} />
          <Row k="時段" v={<span className="font-mono">{session.start} – {session.end}</span>} />
          <Row k="場館" v={venueName ? venueName(session.venue_id) : session.venue_id} />
          <Row k="教練" v={session.coach} />
          <Row k="組別" v={<StatusBadge tone="teal">{courseTypeLabel(session.course_type)}</StatusBadge>} />
          <Row k="學員" v={(session.students || []).join('、')} />
          <Row k="簽到" v={
            <StatusBadge tone={CHECKIN_TONE[session.checkin_status] || 'gray'}>
              {checkinStatusLabel(session.checkin_status)}
            </StatusBadge>
          } />
          {session.checkin_at && <Row k="簽到時間" v={<span className="font-mono">{formatTWDateTime(session.checkin_at)}</span>} />}

          {/* ── 備註 ──
              櫃檯反映：手動扣課與家長扣課的原因在畫面上完全看不到，出事時查不出
              「這堂到底是誰扣的、為什麼扣」。這裡把兩種來源都攤開：
                手動扣課 → manual_lesson_deductions 有自由文字原因
                自助簽到 → checkin_records 沒有文字欄位，但有來源與簽到人
              兩者不是二擇一：一堂課可能先被家長簽到、後來又被櫃檯手動處理。 */}
          {session.deduction_reason && (
            <Row k="手動扣課" v={
              <div className="space-y-1">
                <div className="whitespace-pre-wrap break-words text-gray-800">{session.deduction_reason}</div>
                <div className="text-[11px] text-gray-500">
                  {session.deducted_by && <span>操作者：{session.deducted_by}</span>}
                  {session.deducted_at && <span className="ml-2 font-mono">{formatTWDateTime(session.deducted_at)}</span>}
                </div>
                {/* 狀態實際值是 APPLIED / REVERSED，只有 REVERSED 才是退回。 */}
                {session.deduction_status === 'REVERSED' && (
                  <div className="rounded bg-brand-error-soft px-2 py-1 text-[11px] text-brand-error-strong">
                    此筆已退回
                    {session.deduction_reversal_reason ? `：${session.deduction_reversal_reason}` : ''}
                  </div>
                )}
                {session.deduction_status && !['APPLIED', 'REVERSED'].includes(session.deduction_status) && (
                  <div className="rounded bg-gray-100 px-2 py-1 text-[11px] text-gray-600">
                    狀態：{session.deduction_status}
                  </div>
                )}
              </div>
            } />
          )}

          {Array.isArray(session.checkin_details) && session.checkin_details.length > 0 && (
            <Row k="簽到明細" v={
              <div className="space-y-1">
                {session.checkin_details.map((d, i) => (
                  <div key={`${d.student || ''}-${d.at || ''}-${i}`} className="text-[11px] leading-tight">
                    <span className="font-medium text-gray-800">{d.student || '（不明學員）'}</span>
                    <span className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                      {checkinSourceLabel(d.source)}
                    </span>
                    {d.by && <span className="ml-1.5 text-gray-500">由 {d.by}</span>}
                    {d.at && <span className="ml-1.5 font-mono text-gray-400">{formatTWDateTime(d.at)}</span>}
                    {d.status && d.status !== 'ATTENDED' && (
                      <span className="ml-1.5 text-brand-error">（{d.status}）</span>
                    )}
                    {d.reversal_reason && (
                      <div className="text-brand-error">已註銷：{d.reversal_reason}</div>
                    )}
                  </div>
                ))}
              </div>
            } />
          )}
      </dl>
    </Sheet>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-14 shrink-0 text-xs text-gray-500">{k}</dt>
      <dd className="flex-1 text-gray-800">{v}</dd>
    </div>
  );
}

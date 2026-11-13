import React from 'react';

// 家教班課程使用期限及退費說明（老闆 2026-11-03 指示，家長端首頁告知；之後報名勾選同意也共用這一份）。
// 條文改版時：改 REFUND_POLICY_ITEMS，並把 REFUND_POLICY_VERSION 換成改版日期。
export const REFUND_POLICY_VERSION = '2026-11-03';
export const REFUND_POLICY_TITLE = '家教班課程使用期限及退費說明';
export const REFUND_POLICY_ITEMS = [
  ['使用期限', '每一期課程自購課（完成付款）日起一年內有效；一次購買多期，期限依期數累加。期限內可隨時預約上課，建議於期限內上完。'],
  ['七日內未上課', '購課後七日內且尚未上過任何一堂課，申請退費可全額退還。'],
  ['期限內退費', '期限內可隨時申請終止並退費。退費金額＝剩餘堂數 ×（實付總金額 ÷ 總堂數，含贈送堂數）－手續費新臺幣 50 元。'],
  ['期限屆滿', '期限屆滿後，未使用之剩餘堂數不受理退費。'],
  ['期限屆滿後仍可上課', '為保障學員權益，期限屆滿後剩餘堂數仍可繼續預約上完，不會因期限屆滿而取消。'],
  ['本學院原因', '因本學院無法提供課程，也無法安排其他場館或教練時，依法辦理退費，不收手續費，也不受前述期限限制。'],
  ['退款時間', '退費申請核准後，於十五個工作日內退還。'],
];

export function RefundPolicyList({ className = '' }) {
  return (
    <ol className={'list-decimal space-y-1.5 pl-5 text-[12px] leading-5 text-gray-700 ' + className}>
      {REFUND_POLICY_ITEMS.map(([head, body]) => (
        <li key={head}><span className="font-bold text-brand-primary">{head}：</span>{body}</li>
      ))}
    </ol>
  );
}

// 報名握手（老闆 2026-11-03：報名時要點下去才能報名）：報名、發起團購、加入團購共用。
// 勾選後，頁面送出時帶 policy_ack＝REFUND_POLICY_VERSION；後端 server/services/policyHandshake.js 驗證才放行建單。
export function PolicyAgreement({ checked, onChange }) {
  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <details className="mb-2">
        <summary className="cursor-pointer text-xs font-bold text-brand-primary">查看《{REFUND_POLICY_TITLE}》</summary>
        <RefundPolicyList className="mt-2" />
      </details>
      <label className="flex items-start gap-2 text-sm text-gray-800">
        <input
          type="checkbox" data-policy-ack className="mt-0.5 h-5 w-5 shrink-0"
          checked={checked} onChange={(e) => onChange(e.target.checked)}
        />
        <span>我已閱讀並同意《{REFUND_POLICY_TITLE}》</span>
      </label>
    </div>
  );
}

// 首頁卡片：預設收合只露標題與一行摘要，點開看全文。
export default function RefundPolicyNotice() {
  return (
    <details className="mb-5 rounded-2xl border border-brand-teal/30 bg-white p-4 shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
        <div>
          <div className="text-sm font-bold text-brand-primary">📢 {REFUND_POLICY_TITLE}</div>
          <div className="mt-0.5 text-[11px] text-gray-500">每期一年內有效・到期後剩餘堂數仍可上完・點開看完整說明</div>
        </div>
        <span aria-hidden="true" className="text-gray-400">›</span>
      </summary>
      <RefundPolicyList className="mt-3" />
      <p className="mt-2 text-[10px] text-gray-400">版本 {REFUND_POLICY_VERSION}・如有疑問請洽櫃檯</p>
    </details>
  );
}

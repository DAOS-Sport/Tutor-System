import React, { useState } from 'react';

/**
 * 共用「問題回報」按鈕 —— 登入 / 註冊流程出錯時改顯示本鈕，
 * 避免新教練 / 新家長卡在純 LOGO 空白頁。
 *
 * 行為：點擊 → 開啟 LINE 官方帳號聊天室，並把
 *   「問題類型 + 錯誤代碼 + 錯誤訊息 + 診斷資訊」預先填入訊息框，
 *   使用者只需按「送出」即可回報。
 *     - 教練端（audience="coach"）  → 回報到教練官方帳號（400）
 *     - 家長端（audience="parent"） → 回報到家長官方帳號
 *
 * 官方帳號目標由環境變數設定（client 端，須 VITE_ 前綴）：
 *   VITE_SUPPORT_LINE_COACH   教練端官方帳號（例：@400xxxx，或完整 https 連結）
 *   VITE_SUPPORT_LINE_PARENT  家長端官方帳號
 * 未設定時 fallback 走 LINE 一般分享（line.me/R/msg/text）讓使用者自選對象，
 * 按鈕仍可正常使用（與既有 ReferralPage 同款分享機制）。
 */

const SUPPORT_TARGET = {
  coach:  import.meta.env.VITE_SUPPORT_LINE_COACH  || '',
  parent: import.meta.env.VITE_SUPPORT_LINE_PARENT || '',
};

// 錯誤代碼 → 中文問題分類（讓使用者送出的訊息已自動歸類，客服一眼可辨）
export function classifyError(code) {
  const c = String(code || '');
  if (!c) return '登入 / 系統問題';
  if (/ID_TOKEN|LINE_VERIFY|line_denied|oauth_failed|no_profile|bad_state|bad_request/i.test(c)) return 'LINE 驗證 / 授權問題';
  if (/RAGIC|SYNC/i.test(c)) return '資料同步問題';
  if (/ALREADY_BOUND|AMBIGUOUS|NOT_FOUND|BIND_RACE|MISMATCH|REGISTERED|PHONE_EXISTS/i.test(c)) return '帳號綁定 / 比對問題';
  if (/RATE_LIMITED|429/i.test(c)) return '操作過於頻繁';
  if (/not_configured/i.test(c)) return '系統設定問題';
  if (/FORMAT_INVALID|INPUT_INVALID|REQUIRED|ID_NUMBER/i.test(c)) return '資料格式問題';
  return '其他登入 / 註冊問題';
}

function nowStr() {
  try {
    return new Date().toLocaleString('zh-TW', { hour12: false });
  } catch {
    return '';
  }
}

function buildReportText({ audience, errorCode, errorMessage, context, details }) {
  const lines = [
    '【夢想體育學院｜問題回報】',
    `身分：${audience === 'coach' ? '教練端' : '家長端'}`,
    `問題類型：${classifyError(errorCode)}`,
    `錯誤代碼：${errorCode || '（無）'}`,
    `錯誤訊息：${errorMessage || '（無）'}`,
  ];
  if (context) lines.push(`發生位置：${context}`);
  if (details && typeof details === 'object') {
    for (const [k, v] of Object.entries(details)) {
      if (v !== undefined && v !== null && v !== '') lines.push(`${k}：${v}`);
    }
  }
  lines.push(`時間：${nowStr()}`);
  lines.push('—');
  lines.push('（以上為系統自動帶入，請直接按送出即可；方便的話請補充您剛剛的操作步驟）');
  return lines.join('\n');
}

function buildLineUrl(target, text) {
  const t = encodeURIComponent(text);
  // 未設定官方帳號 → 用一般分享，讓使用者自選對象（確保按鈕一定可用）
  if (!target) return `https://line.me/R/msg/text/?${t}`;
  // 完整 https 連結（lin.ee / line.me 短連結等）→ 直接附帶預填文字
  if (/^https?:\/\//i.test(target)) {
    return target.includes('?') ? `${target}&text=${t}` : `${target}?text=${t}`;
  }
  // 官方帳號 basic id（@xxxx）→ 開啟該 OA 聊天室並預填文字
  const id = target.startsWith('@') ? target : `@${target}`;
  return `https://line.me/R/oaMessage/${id}/?${t}`;
}

export default function ReportIssueButton({
  audience = 'parent',
  errorCode = '',
  errorMessage = '',
  context = '',
  details = null,
  className = '',
}) {
  const [copied, setCopied] = useState(false);
  const text = buildReportText({ audience, errorCode, errorMessage, context, details });
  const target = SUPPORT_TARGET[audience] || '';

  function handleReport() {
    const url = buildLineUrl(target, text);
    try {
      window.open(url, '_blank');
    } catch {
      window.location.href = url;
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* 不支援 clipboard 時略過 */ }
  }

  return (
    <div className={`w-full ${className}`}>
      <button
        type="button"
        onClick={handleReport}
        className="w-full rounded-lg bg-[#06C755] py-3 text-base font-bold text-white active:opacity-90"
      >
        透過 LINE 回報問題
      </button>
      <button
        type="button"
        onClick={handleCopy}
        className="mt-2 w-full rounded-lg border border-gray-300 py-2 text-xs font-medium text-gray-600 active:bg-gray-50"
      >
        {copied ? '已複製錯誤資訊' : '複製錯誤資訊（備用）'}
      </button>
    </div>
  );
}

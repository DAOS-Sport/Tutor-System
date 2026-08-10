/**
 * 家長信件模板。
 *
 * 版型依 Owner 提供的既有 Ragic 通知信截圖：
 *   公司抬頭 → 主標 → 稱呼 → 灰底資訊區 → 提醒事項 → 深藍 CTA。
 * 原信不在本 repo（全 repo 搜「派發」0 命中，推測由 Ragic 寄出），所以截圖是
 * 唯一的版型依據，沒有原始 HTML 可比對。
 *
 * ── 為什麼用 table + inline style ──
 * Gmail / Outlook 會剝掉 <style> 區塊與大部分現代 CSS。email HTML 必須退回
 * table 排版 + 屬性內嵌樣式，不能用 flex/grid/class。
 *
 * ── 發票圖：附件，不是連結 ──
 * Owner 決定櫃檯上傳的發票照片直接附在信裡。用附件而不是連結是刻意的：
 * /uploads/* 是完全公開無認證的路徑（server/index.js），放連結等於任何拿到
 * 網址的人都看得到發票；附件只跟著這封信走。
 *
 * ── CTA：使用說明海報，不是按鈕 ──
 * Owner 決定把「點擊登入家教系統」按鈕換成使用說明海報。這其實比按鈕正確：
 * liff.line.me 深連結只有在 LINE App 內開啟才會自動登入，從 Email 點會落在
 * 一般瀏覽器，行為不保證。海報教的是「進場館官方帳號 → 圖文選單家教班」——
 * 那是真正走得通的路。海報檔不存在時退回原本的按鈕，信不會因此殘缺。
 */
const { formatRagicDate, formatTaipeiDateTime } = require('../utils/dateTime');

const NAVY = '#15316a';
const TEAL = '#31aeab';
const INK = '#333333';
const MUTED = '#777777';
const LINE = '#e4e7ec';
const PANEL = '#f5f6f8';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function courseTypeLabel(type) {
  const n = Number(type);
  return Number.isFinite(n) && n > 0 ? `1對${n}` : '—';
}

// 「狀態」欄：Owner 規格是一對一 / 一對多兩類，與「項目」（幾對幾）分開。
function groupModeLabel(type) {
  const n = Number(type);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n === 1 ? '一對一' : '一對多';
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `NT$ ${Math.round(n).toLocaleString('en-US')}`;
}

function periodLabel(order) {
  const no = Number(order?.period_number);
  const count = Number(order?.period_count);
  if (!Number.isFinite(no) || no <= 0) return '—';
  if (Number.isFinite(count) && count > 1) return `第 ${no} 期 / 共 ${count} 期`;
  return `第 ${no} 期`;
}

function studentsOf(order) {
  const s = order?.students;
  if (Array.isArray(s)) return s.filter(Boolean).join('、');
  return String(s || '').trim();
}

function row(label, value) {
  return `<tr>
    <td style="padding:9px 14px;border-bottom:1px solid ${LINE};color:${MUTED};font-size:13px;white-space:nowrap;vertical-align:top;width:96px;">${esc(label)}</td>
    <td style="padding:9px 14px;border-bottom:1px solid ${LINE};color:${INK};font-size:13px;font-weight:bold;vertical-align:top;">${value}</td>
  </tr>`;
}

/**
 * 對帳成功通知。
 *
 * 一張發票可能對應同一家庭的多筆子訂單（兄弟姊妹各一筆）。逐筆寄信的話家長會
 * 收到 N 封內容幾乎一樣的信，所以粒度是「家庭 × 發票」：共通欄位（館別／報名
 * 日期／發票號碼／金額合計）平鋪，各訂單差異（學員／項目／教練／期數）另列一表。
 * 只有一筆時就退化成 Owner 規格裡那張平鋪清單，不會多出一個空表。
 */
function reconcileSuccess({ parentName, venueName, orders = [], invoiceNumber, totalAmount, liffUrl, issuedAt,
                            guideImageCid = null, hasInvoiceAttachment = false }) {
  const list = Array.isArray(orders) ? orders.filter(Boolean) : [];
  const first = list[0] || {};
  const single = list.length === 1;
  const submitted = first.submitted_at || first.created_at;

  const subject = `【家教班報名成功通知】夢想體育-${venueName || '—'}（發票號碼：${invoiceNumber || '—'}）`;

  const rows = [];
  if (single) {
    rows.push(row('狀態', esc(groupModeLabel(first.course_type))));
    rows.push(row('項目', esc(courseTypeLabel(first.course_type))));
  }
  rows.push(row('館別', esc(venueName || '—')));
  rows.push(row('報名日期', esc(submitted ? formatRagicDate(submitted) : '—')));
  if (single) {
    rows.push(row('教練名稱', esc(first.coach || '—')));
    rows.push(row('費用', esc(money(first.final_price))));
    rows.push(row('期數', esc(periodLabel(first))));
  } else {
    rows.push(row('報名筆數', `${list.length} 筆（明細見下表）`));
    rows.push(row('費用合計', esc(money(totalAmount))));
  }
  rows.push(row('發票號碼', `<span style="font-family:Menlo,Consolas,monospace;letter-spacing:1px;">${esc(invoiceNumber || '—')}</span>`    + (hasInvoiceAttachment ? `<div style="margin-top:3px;color:${MUTED};font-size:11px;font-weight:normal;">發票影本已附於本信附件</div>` : '')));

  const detailTable = single ? '' : `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:14px;border-collapse:collapse;">
        <tr>
          ${['學員', '項目', '教練', '期數', '費用'].map((h) => `<th align="left" style="padding:7px 10px;background:${PANEL};border-bottom:1px solid ${LINE};color:${MUTED};font-size:12px;font-weight:normal;">${h}</th>`).join('')}
        </tr>
        ${list.map((o) => `<tr>
          <td style="padding:8px 10px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};">${esc(studentsOf(o) || '—')}</td>
          <td style="padding:8px 10px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};">${esc(courseTypeLabel(o.course_type))}</td>
          <td style="padding:8px 10px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};">${esc(o.coach || '—')}</td>
          <td style="padding:8px 10px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};">${esc(periodLabel(o))}</td>
          <td style="padding:8px 10px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};" align="right">${esc(money(o.final_price))}</td>
        </tr>`).join('')}
      </table>`;

  // 海報優先。cid: 是 email 內嵌圖片的標準作法（附件掛 Content-ID，body 用 cid: 引用），
  // 不走外部網址 —— 那會被大多數郵件客戶端預設擋掉，變成一個破圖框。
  const cta = guideImageCid ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:22px;">
        <tr>
          <td align="center" style="padding:0;">
            <img src="cid:${esc(guideImageCid)}" alt="新家教系統使用說明" width="544"
                 style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:8px;">
          </td>
        </tr>
      </table>` : (liffUrl ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:26px;">
        <tr>
          <td align="center" style="background:${NAVY};border-radius:8px;padding:0;">
            <a href="${esc(liffUrl)}" style="display:block;padding:15px 20px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">點擊登入家教系統</a>
          </td>
        </tr>
      </table>` : '');

  const html = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef0f3;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef0f3;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:'Noto Sans TC','Helvetica Neue',Arial,sans-serif;">

        <tr><td style="padding:20px 28px;border-bottom:3px solid ${TEAL};">
          <div style="color:${NAVY};font-size:17px;font-weight:bold;letter-spacing:1px;">夢想體育學院</div>
          <div style="color:${MUTED};font-size:11px;margin-top:2px;">DAOS 家教課程系統</div>
        </td></tr>

        <tr><td style="padding:26px 28px 0 28px;">
          <div style="color:${NAVY};font-size:19px;font-weight:bold;">家教班報名成功通知</div>
          <div style="margin-top:16px;color:${INK};font-size:14px;line-height:24px;">
            親愛的 ${esc(parentName || '家長')} 家長，您好：
          </div>
          <div style="margin-top:8px;color:${INK};font-size:14px;line-height:24px;">
            您的報名款項已完成對帳，課程已為您開通。以下為本次報名資訊：
          </div>
        </td></tr>

        <tr><td style="padding:18px 28px 0 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PANEL};border-radius:8px;border-collapse:collapse;">
            ${rows.join('')}
          </table>
          ${detailTable}
        </td></tr>

        <tr><td style="padding:22px 28px 0 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-left:4px solid ${TEAL};background:#f0fbfa;border-radius:4px;">
            <tr><td style="padding:12px 14px;">
              <div style="color:${NAVY};font-size:13px;font-weight:bold;">提醒事項</div>
              <div style="margin-top:5px;color:${INK};font-size:13px;line-height:21px;">上課當日請務必至系統完成簽到。</div>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:0 28px 28px 28px;">
          ${cta}
        </td></tr>

        <tr><td style="padding:16px 28px;background:${PANEL};color:${MUTED};font-size:11px;line-height:18px;">
          本信件由系統自動發送，請勿直接回覆。<br>
          如有任何問題，請洽各館櫃檯。${issuedAt ? `<br>對帳完成時間：${esc(formatTaipeiDateTime(issuedAt))}` : ''}
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // 純文字版：部分郵件客戶端（或使用者設定）只顯示 text/plain。
  // 沒有它的話那些人會收到一封空白信。
  const textLines = [
    '夢想體育學院｜家教班報名成功通知',
    '',
    `親愛的 ${parentName || '家長'} 家長，您好：`,
    '您的報名款項已完成對帳，課程已為您開通。',
    '',
  ];
  if (single) {
    textLines.push(`狀態：${groupModeLabel(first.course_type)}`);
    textLines.push(`項目：${courseTypeLabel(first.course_type)}`);
  }
  textLines.push(`館別：${venueName || '—'}`);
  textLines.push(`報名日期：${submitted ? formatRagicDate(submitted) : '—'}`);
  if (single) {
    textLines.push(`教練名稱：${first.coach || '—'}`);
    textLines.push(`費用：${money(first.final_price)}`);
    textLines.push(`期數：${periodLabel(first)}`);
  } else {
    textLines.push(`報名筆數：${list.length} 筆`);
    textLines.push(`費用合計：${money(totalAmount)}`);
    list.forEach((o) => {
      textLines.push(`  - ${studentsOf(o) || '—'}｜${courseTypeLabel(o.course_type)}｜${o.coach || '—'}｜${periodLabel(o)}｜${money(o.final_price)}`);
    });
  }
  textLines.push(`發票號碼：${invoiceNumber || '—'}`);
  textLines.push('');
  textLines.push('【提醒事項】上課當日請務必至系統完成簽到。');
  if (hasInvoiceAttachment) textLines.push('發票影本已附於本信附件。');
  textLines.push('');
  if (guideImageCid) {
    // 純文字版看不到內嵌圖，要把海報上的步驟寫出來，否則這些人拿不到任何指引。
    textLines.push('【如何進入家教系統】');
    textLines.push('1. 於 LINE 搜尋並加入你所屬場館的官方帳號');
    textLines.push('2. 點擊下方圖文選單的「家教班」');
    textLines.push('3. 依指示完成註冊／登入，即可查看課程、報名與簽到');
    textLines.push('（本信附有圖解說明，若無法顯示請洽現場櫃檯）');
  } else if (liffUrl) {
    textLines.push(`點擊登入家教系統：${liffUrl}`);
  }
  textLines.push('');
  textLines.push('本信件由系統自動發送，請勿直接回覆。如有任何問題，請洽各館櫃檯。');

  return { subject, html, text: textLines.join('\n') };
}

module.exports = {
  reconcileSuccess,
  __test__: { courseTypeLabel, groupModeLabel, money, periodLabel, esc },
};

'use strict';
// 對帳通知信補寄的排程（feature flag，預設關閉）。
//
// 為什麼不放進 server/cron/index.js：那支在 CLAUDE.md 凍結範圍內。這裡由 server/index.js
// 在 initCronJobs() 之後呼叫，沒開 flag 時什麼都不做 —— 不排程、不連 DB、不寄信。
//
// Autoscale 可能同時多台或縮到 0 台：多台時 runWithLock 讓同一輪只有一台跑，
// 而 sweepPendingMail 本身是「先認領再寄」，即使鎖失效也不會重複寄；縮到 0 台時
// 沒寄的信留在 pending，下一台起來後的下一輪補寄。
const cron = require('node-cron');

const FLAG = 'RECONCILE_MAIL_SWEEP';
const SCHEDULE = '*/5 * * * *';
const JOB_NAME = 'reconcile_mail_sweep';

function isEnabled(env = process.env) {
  return env[FLAG] === '1' && env.PREVIEW_SAFE_MODE !== '1';
}

async function runOnce() {
  const { runWithLock } = require('../cron/lock');
  const { sweepPendingMail } = require('./reconcileNotify');
  return runWithLock(JOB_NAME, () => sweepPendingMail());
}

/** 開 flag 才註冊排程；回傳 node-cron task，沒開回 null。 */
function startReconcileMailSweep(env = process.env) {
  if (!isEnabled(env)) {
    console.info(`[ReconcileMailSweep] disabled（設定 ${FLAG}=1 才會補寄）`);
    return null;
  }
  console.info(`[ReconcileMailSweep] enabled schedule="${SCHEDULE}"`);
  return cron.schedule(SCHEDULE, () => {
    runOnce().catch((e) => console.warn('[ReconcileMailSweep] 未預期例外：' + e.message));
  }, { timezone: 'Asia/Taipei' });
}

module.exports = { startReconcileMailSweep, isEnabled, runOnce, FLAG, SCHEDULE, JOB_NAME };

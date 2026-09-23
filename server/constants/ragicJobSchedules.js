/**
 * Ragic 狀態頁（/admin/ragic-status）顯示用的排程與名稱。
 *
 * 排程本身寫在 server/cron/index.js（凍結檔），這裡只是「給人看」的對照表。
 * 以前頁面把時間寫死在前端（「每 10 分鐘」「01:00 拉回」「02:00 備份」），跟實際排程
 * 對不上好幾個月都沒人發現；現在由 tests/ragic_status_page_test.js 逐條比對 cron/index.js，
 * 排程一改、這裡沒跟著改，測試就會紅。
 *
 *   direction：in＝Ragic → 系統；out＝系統 → Ragic；check＝只檢查、不搬資料
 *   cron：cron/index.js 裡 scheduleTaipei() 的運算式；null＝沒有排程，只能手動
 *   runner：該排程區塊裡實際呼叫的函式名（測試用它確認時間對應到正確的工作）
 */
const RAGIC_JOB_SCHEDULES = {
  backup:     { name: '家長與學員寫回 Ragic', sheet: 'Z01／Z02', direction: 'out',   cron: '30 0 * * *', text: '每天 00:30', runner: 'backupParentsStudentsToRagic' },
  pull:       { name: '從 Ragic 拉回家長與學員', sheet: 'Z01／Z02', direction: 'in', cron: '30 2 * * *', text: '每天 02:30', runner: 'pullParentsStudentsFromRagic' },
  quarantine: { name: '家長姓名檢查',       sheet: 'Z01',      direction: 'check', cron: '45 2 * * *', text: '每天 02:45', runner: 'quarantineBadZ01Names' },
  staff:      { name: '員工與教練',         sheet: 'H01',      direction: 'in',    cron: '30 3 * * *', text: '每天 03:30', runner: 'syncStaffFromRagic' },
  venues:     { name: '場館',               sheet: 'H05',      direction: 'in',    cron: '30 3 * * *', text: '每天 03:30', runner: 'syncVenuesFromRagic' },
  parents:    { name: '家長表連線測試',     sheet: 'Z01',      direction: 'check', cron: null,         text: '手動',       runner: null },
  students:   { name: '學員表連線測試',     sheet: 'Z02',      direction: 'check', cron: null,         text: '手動',       runner: null },
};

// 不是狀態頁上的工作卡片，但會碰 Ragic 的背景排程；只放在說明裡讓人知道整晚的順序。
const RAGIC_BACKGROUND_SCHEDULES = [
  { key: 'outbox',  name: '新註冊家長寫入 Ragic', cron: '10 0 * * *', text: '每天 00:10', runner: 'processRagicSyncOutbox' },
  { key: 'webhook', name: 'Ragic 即時通知重試',   cron: '* * * * *',  text: '每分鐘',     runner: 'retryRagicWebhooks' },
];

module.exports = { RAGIC_JOB_SCHEDULES, RAGIC_BACKGROUND_SCHEDULES };

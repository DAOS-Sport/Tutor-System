// 取得 admin JWT 給效能腳本用：node tests/perf/login_admin.js > /tmp/admin.jwt
// 預設讀 ADMIN_USERNAME / ADMIN_PASSWORD env，否則 manager/manager。
const { loginAdmin } = require('../e2e/_lib');
const u = process.env.ADMIN_USERNAME || 'manager';
const p = process.env.ADMIN_PASSWORD || 'manager';
loginAdmin(u, p).then((t) => process.stdout.write(t)).catch((e) => { console.error(e.message); process.exit(1); });

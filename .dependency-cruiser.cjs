module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error',
      comment: 'CommonJS 的循環 require 會在載入時拿到「半成品」模組——欄位是 undefined 但不報錯',
      from: {}, to: { circular: true } },
    { name: 'no-orphans', severity: 'warn',
      comment: '沒有人 import、自己也沒 import 別人的模組——通常是死碼',
      from: { orphan: true,
              pathNot: '(^|/)(index|.*\\.config)\\.js$|^server/scripts/|^scripts/|^tests/|^server/public/' },
      to: {} },
    { name: 'client-not-import-server', severity: 'error',
      comment: '前端不得 require 後端程式碼（會把伺服器邏輯與憑證打包進 bundle）',
      from: { path: '^client/' }, to: { path: '^server/' } },
    { name: 'route-not-import-sibling-route', severity: 'error',
      comment: 'route 之間互相 require（掛載子路由與 _ 開頭的共用模組除外）——'
             + '會讓中介層與副作用的執行順序變得無法推理',
      from: { path: '^server/routes/', pathNot: '^server/routes/admin\\.js$' },
      to:   { path: '^server/routes/', pathNot: '(^|/)_[^/]+\\.js$' } },
    { name: 'services-not-import-routes', severity: 'error',
      comment: 'service 反過來依賴 route＝分層倒轉',
      from: { path: '^server/services/' }, to: { path: '^server/routes/' } },
  ],
  options: { doNotFollow: { path: 'node_modules' }, exclude: 'node_modules|\\.pythonlibs|codebase-memory-mcp' },
};

/*
 * 用法（工具未列入 package.json，避免為了一支稽核工具而擴大相依）：
 *
 *   npm i -D --no-save --prefix /tmp/devtools dependency-cruiser@16
 *   /tmp/devtools/node_modules/.bin/depcruise server client tests scripts \
 *     --config .dependency-cruiser.cjs --output-type err
 *
 * 2026-08-11 首次跑出三項，逐一查證後的結論：
 *   ・server/middlewares/auth.js 是真死碼（0 次被 require，四個兄弟是 28/16/6/1 次）
 *   ・checkouts.js → enrollments.js 是真問題：它拿 Express Router 當命名空間偷渡
 *     三個函式（enrollmentRouter._checkoutInternals），業務邏輯住在 route 檔裡
 *   ・parentRefresh ↔ ragicAdmin 的循環是**誤報**：ragicAdmin 那個 require 在函式內，
 *     是刻意的延遲載入，正是化解循環的標準寫法。工具分不出來，人要判斷。
 */

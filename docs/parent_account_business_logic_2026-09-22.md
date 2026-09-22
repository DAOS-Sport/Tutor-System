# 家長帳號業務邏輯（從程式碼翻出）

盤點日期：2026-09-22（台北）
程式基準：`DAOS-Sport/Tutor-System`，分支 `fix/tutor-audit-20260918`，HEAD `bfacacd4`
（＝Draft PR #8。**正式環境跑的是 `76a5d51`**，PR #8 的修補尚未上線。）

---

## 0. 這份文件是什麼、怎麼讀

這不是設計文件，是**現況盤點**：把程式碼裡實際生效的規則翻出來寫成人看得懂的話。
每一條都附 `檔案:行號` 依據，可以自己去核。

每條規則標了來源：

| 標記 | 意思 |
|---|---|
| **實作中** | 程式真的這樣做 |
| **判準不一致** | 同一件事在不同入口判準不同 —— 這是最該注意的部分 |
| **只在文件裡** | `replit.md` / `docs/` / 註解寫過，但程式沒有對應實作或實作不同 |
| **查不清楚** | 追到某處卡住，需要人確認 |

怎麼產出的：16 個唯讀 agent 分八個面向讀碼，每個面向的規則再由另一個獨立 agent
**逐條開檔案回核**（確認 / 退回 / 補漏）。第 1 節的正式庫數字是我自己用唯讀 SQL 查的，
agent 全程禁止連資料庫。全程沒有修改任何檔案、沒有異動任何資料。

**看之前先知道兩件事：**

1. 「只在文件裡」不代表文件錯，而是**文件與程式已經漂移**。要照現況走請以程式為準。
2. 「判準不一致」大多不是立刻壞掉，而是**在特定資料形狀下才會顯形**。第 1 節的數字
   就是在說「這些形狀在正式環境有多常見」。

### 目錄

- [1. 正式環境資料輪廓](#1-正式環境資料輪廓唯讀查詢2026-09-22) —— 先看數字
- [2. 判準不一致總表（111 條）](#2-判準不一致總表) —— **最該先看**
  - 2.1 身分與 LINE 綁定 · 2.2 解綁與帳號救援 · 2.3 學員停學／復學 · 2.4 可見性
  - 2.5 簽到預約取消 · 2.6 報名付款退費 · 2.7 通知 · 2.8 Ragic 同步
- [3. 各面向完整規則（572 條）](#3-各面向完整規則) —— 當字典用，需要哪塊查哪塊


---

## 1. 正式環境資料輪廓（唯讀查詢，2026-09-22）

先看數字，再看規則 —— 規則的重要性取決於它管到多少人。

### 帳號與學員

| 項目 | 數量 |
|---|---|
| 家長總數 | **631** |
| 有綁 LINE 的家長 | **631（100%）** |
| 停用的家長（`parents.is_active=false`） | **0** |
| 學員總數 | **993** |
| 停學的學員（`students.is_active=false`） | **3** |
| 沒有任何學員的家長 | 0 |
| **有 2 個以上學員的家長** | **285（45%）** |

### 身分綁定

| 項目 | 數量 |
|---|---|
| `parent_line_uid_bindings` 總筆數 | 613（**全部 ACTIVE**） |
| 曾被撤銷的綁定（`revoked_at` 有值） | **0** |
| 一個家長綁多支 LINE | 0 |
| 一支 LINE 綁多個家長 | 0 |
| **家長有 `line_uid` 但 bindings 表沒有對應列** | **18** |
| `line_uid` 以 `demo:` 開頭（測試帳號） | 4 |
| `identity_claims`：SYNCED / MANUAL_REVIEW / 資料衝突 / schema 卡住 / 待同步 | 378 / 9 / 9 / 2 / 2 |
| `source_record_links`：真 UID 匯入 / 電話＋姓名比對 / 電話比對後補學員 | 622 / 2 / 1 |
| **`parent_identity_backoffice_tasks`** | **130，全部 OPEN**（身分查無 55、schema 卡住 58、資料衝突 9、學員比對歧義 8） |

兩個要注意的：**解綁從來沒有真的撤銷過任何一筆綁定紀錄**（`revoked_at` 全空），
以及 **130 筆人工待辦沒有任何一筆被處理過**。

### 課程與簽到

| 項目 | 數量 |
|---|---|
| 課期總數 | 591 |
| **簽到模式 = 自助簽到（`self`）** | **591（100%）** |
| 簽到模式 = 預約制 | 0 |
| 團報課期（`group_order_id`） | 49 |
| 家庭共班（`enrollment_batch_id`） | 272 |
| **跨家庭共享課期（名單含 2 家以上）** | **35** |
| **同一家長在同一課期有 2 個以上小孩** | **323 組 / 321 個課期 / 198 位家長 / 725 名學員** |

課堂與出席：

| 項目 | 數量 |
|---|---|
| 自助簽到產生的課堂（已完成） | 1008 堂 / 317 個課期 |
| 預約產生的課堂（已完成） | 443 堂 / 170 個課期 |
| **預約但已過時間仍停在 confirmed** | **32 堂 / 14 個課期**（＝Issue #7 說的那 32 堂） |
| 取消的課堂（預約 / 自助） | 20 / 14 |
| 簽到來源：家長 / 櫃檯 / 教練（歷史） | 1790 / 823 / 7 |
| 出席紀錄：ATTENDED / REVERSED | 2553 / 67 |
| **一堂課有 2 人以上出席** | **806 堂** |
| 手動扣課 / 扣課復活 | 460 / 34 |

三個關鍵事實：

- **`checkin_mode` 雖然全部是 `self`，預約那條路仍然活著**（443 堂已完成的預約課堂，
  最後一筆是今天）。`slots.js` 的預約端點不檢查 `checkin_mode`，所以兩種方式並存，
  不是二擇一。
- **整班一起出席是常態**：806 堂課有 2 人以上出席。
- **54% 的 active 課期是「同一家長多個小孩在同一期」**。任何以「一位學員」為單位的
  判斷，在這些課期上都要想清楚對兄弟姊妹的影響。


---

## 2. 判準不一致總表

這一節是整份文件最該先看的部分：**同一件事在不同入口有不同判準**。
慧娟案（學員被設停學後「不見了」）就是這類問題的一個實例。


### 2.1 身分與 LINE 綁定（14 條）

**1. replit.md 寫「production 必須設 REQUIRE_LINE_ID_TOKEN=1」，但這個開關對家長端完全沒有作用：家長的每一支登入／綁定／註冊端點都無條件要求並驗證 id_token，不管什麼環境。這個開關只有教練端在用。**
- 依據：文件：replit.md:144「production 必須設 `REQUIRE_LINE_ID_TOKEN=1`、`RAGIC_FIELD_Z01_LINE_UID=1006846`」；家長端：server/routes/auth.js:402-406 無條件 `if (!idToken) { res.status(400).json({ error: 'id_token 必填', code: 'ID_TOKEN_REQUIRED' }); return null; }`；旗標唯一使用者：server/routes/coaches.js:287 與 :300 `} else if (isLineVerificationRequired()) {` / `if (isLineVerificationRequired()) {`
- 註：證據對得上。grep isLineVerificationRequired 全 server/ 只有 lineAuth.js:149 定義處、:155 export 與 coaches.js 兩處使用，零家長端使用。補一個減輕因素：docs/line_setup.md:27、:162、:175 有把這個旗標明確限定在「教練 by-phone endpoint 不再接受首次綁定」，所以會誤導的只有 replit.md:144 那份裸列表。家長端比文件描述更嚴格，方向上是安全的。

**2. 程式在判斷「這支 LINE 是不是已經綁給別人了」時只看啟用中的家長，但資料庫的唯一鍵是不分啟用與否的。也就是說：如果有一筆已停用的舊家長還佔著同一支 LINE UID 或同一支手機，程式檢查會放行，但真正寫入時會被資料庫擋下。**
- 依據：程式檢查（只看 active）：server/routes/auth.js:853-854 「1) 本地 line_uid 已綁到不同手機（只看 active 記錄；inactive 舊列不應擋重新綁定）」＋`SELECT phone FROM parents WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`；資料庫（不分 active）：server/bootstrap/coreSchema.js:112 `line_uid VARCHAR(100) UNIQUE`
- 註：證據對得上。撞到時兩個入口呈現完全不同：新戶註冊被歸類成 ACCOUNT_RECOVERY_REQUIRED（server/services/z03IdentityClaim.js:102 `parents_line_uid_key: 'ACCOUNT_RECOVERY_REQUIRED'`）；Ragic 同步路徑則在 SAVEPOINT 內放棄寫 UID 重試一次、其餘欄位照常同步（server/services/parentSync.js:327-331）。補一筆：registerNewParentLocalFirst 的本地查詢（z03IdentityClaim.js:152-156）連 is_active 都不篩，所以它看得到停用列、反而不會撞鍵——三個入口對同一件事有三種行為。

**3. 系統裡有兩套並存、互不取代的「把 LINE 接上舊帳號」流程：舊的一次到位版（parent-bind-phone / parent-register-line）與新的封閉狀態機。LIFF 家長端從頭到尾只呼叫舊版；新版端點沒有任何前端在用。**
- 依據：程式碼註解自陳：server/routes/auth.js:492-495 「這三支是『新增』端點，與既有 parent-bind-phone/parent-register-line 並存，不互相取代……等前端完成對接封閉狀態機後，舊端點才會真正停用」；前端只有三支舊端點：client/liff/src/api/auth.js:7-54（parentLineLogin / parentBindPhone / parentRegisterLine），全 client/ grep `flow_token|flowToken|verify-phone|verify-student|/auth/bind|/auth/register` 零命中
- 註：證據對得上，但措辭要更正：新流程是**四支**端點不是三支——verify-phone（auth.js:505）、verify-student（:572）、bind（:666）、register（:1694），四支都掛 requireFlowToken。這是本面向最重要的一條：下面幾條「次數限制／速率限制／登記電話比對」的防線全部只長在沒人走的新流程上。任何「我們有防列舉、有 3 次上限」的說法，對實際使用者走的路徑都不成立。

**4. 實際使用者走的舊綁定流程（parent-bind-phone）與舊註冊流程（parent-register-line）沒有任何速率限制、也沒有任何認領失敗次數上限 —— 學員姓名可以無限次猜。**

- 誰能做：任何人（只要有一張有效的 LINE id_token）
- 依據：舊端點掛載處沒有任何限流中介層：server/routes/auth.js:841 `router.post('/parent-bind-phone', async (req, res) => {`、同檔 1666 `router.post('/parent-register-line', async (req, res) => {`（對照新端點 auth.js:505 `router.post('/verify-phone', requireFlowToken, verifyPhoneRateLimit, async (req, res) => {`）；掛載處亦無全域限流：server/index.js:72 `app.use('/api/auth', require('./routes/auth'));`
- 註：證據對得上，而且我額外確認過：grep -i 'ratelimit|helmet' 在 server/index.js 零命中，整個 app 層沒有任何全域限流中介層，所以 /api/auth 上的舊端點確實裸奔。前端認領失敗只是把畫面退回輸入頁讓你再試（client/liff/src/pages/LoginPage.jsx:340-343 `showPhoneEntry('學員姓名或登記手機號碼與資料不符，請確認後再試。')`），沒有計數。這是新舊流程差異造成的實質防線缺口。

**5. 同一件「學員姓名算不算對上」，系統裡有兩套不同的正規化規則：一套把姓名中間的空白全部刪掉（「王 小明」＝「王小明」），另一套只把連續空白壓成一個（「王 小明」≠「王小明」）。走哪一套取決於你是從哪個入口進來的。**
- 依據：刪除全部空白：server/services/identityNormalizer.js:20-26 `return String(value || '').normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();`；壓成單一空白：server/services/parentSync.js:680-682 `return String(v || '').trim().toLowerCase().normalize('NFKC').replace(/\s+/g, ' ');`
- 註：證據對得上（兩段的鏈式順序與引述略有差異，語意一致）。走 parentSync 那套（空白敏感）的：verify-student（auth.js:623）與 parent-bind-phone（auth.js:949）的認領比對。走 identityNormalizer 那套（空白不敏感）的：Z03 認領（z03IdentityClaim.js）、新戶註冊（auth.js:1194、1270 的 normalizeStudentName）、帳號恢復的學員比對（server/services/parentAccountRecovery.js:78 `normalizeStudentName(row.name) === studentNameNormalized`）。名字中間有空白的學員（常見於英文名或複姓輸入習慣）會在一個入口通過、另一個入口失敗。

**6. 「登記手機號碼」這道第二關卡的嚴格程度，會因為這個家庭的資料在哪裡而完全不同。如果家庭資料還停在本地待處理池（Z03，即舊客戶尚未開通者），系統只檢查你填的登記電話等於你上一步剛輸入的那支電話 —— 等於同一個號碼打兩次就過，實質上只有學員姓名一道關卡。只有在「這支電話已經綁給另一支 LINE、要走帳號恢復」時，才會真的拿去跟 Ragic 上登記的電話比對。**

- 誰能做：家長自己
- 依據：弱檢查（自己比自己）：server/routes/auth.js:260-271 `const claimPhone = normalizePhone(claim.phone || phone); const canonicalPhone = normalizePhone(phone); ... if (claimPhone !== canonicalPhone) { return res.status(409)... }`（之後 272-283 直接進 claimZ03Identity，不再比對任何來源電話）；強檢查（比 Ragic）：同檔 949 `const verdict = parentSync.classifyStudentPhoneClaim(ragicStudents, claim, mapped.phone || phone);`
- 註：證據對得上，而且比敘述更寬：`claim.phone || phone` 這個 fallback 意味著連「填」都可以省——claim 完全不帶 phone 時它會自動取用上一步的 phone，比較必然通過。舊客戶開通（Ragic Z01 的 UID 欄位空白）也會被 hydrate 進 Z03 後走弱檢查那條（auth.js:926-939）。所以正常舊生開通＝「電話＋學員姓名」兩要素；帳號恢復＝「電話＋學員姓名＋Ragic 登記電話」三要素。

**7. parent_line_uid_bindings（LINE UID 綁定歷程表）只有「帳號恢復換綁」會寫：把舊 UID 標成 REPLACED、寫入新 UID 為 ACTIVE。註冊、綁定、櫃台解除綁定都不會動它，而且正式程式沒有任何一行會讀這張表 —— 它不參與任何授權判斷。**

- 誰能做：沒有人（除帳號恢復自動寫入外）
- 依據：唯一寫入者：server/services/parentAccountRecovery.js:328-346（INSERT ACTIVE 舊 UID → `UPDATE parent_line_uid_bindings SET status='REPLACED',revoked_at=$2,replaced_by_uid_hash=$3` → INSERT ACTIVE 新 UID）；建表＋一次性回填：server/bootstrap/coreSchema.js:1519-1532；狀態定義 db/migrations/024_parent_identity_release_hardening.sql:124 `status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','REPLACED'))`
- 註：結論對，但兩處數字要更正：(1) grep 在 server/ 是 **7** 處命中（coreSchema.js 的 1519/1527/1528/1529 四行＋parentAccountRecovery.js 的 329/336/342 三行），不是 4 處；(2)「全系統沒有任何一行程式會讀」要限定在正式程式——tests/release/account_recovery_integration.js:221-222 有 SELECT COUNT(*) 拿它做斷言。實質結論不變：零 SELECT 在 server/，不參與授權。REVOKED 這個狀態值在程式裡從未被寫入。表上有兩個部分唯一索引（uid_hash where ACTIVE、canonical_parent_id where ACTIVE，coreSchema.js:1527-1528）。真相是 parents.line_uid。

**8. 櫃台解除綁定不會把 parent_line_uid_bindings 裡那支舊 UID 的 ACTIVE 紀錄改掉，所以稽核表上會留下「這支 UID 仍然 ACTIVE」而實際上早已解除。之後這位家長若走帳號恢復換綁，換綁流程會再插一筆同家長的 ACTIVE 紀錄。**
- 依據：解除綁定只寫 rebind_audit、不寫 bindings：server/routes/admin/customerParents.js:221-228 `INSERT INTO parent_line_uid_rebind_audit (...) VALUES ($1,$2,$3,$4,'ADMIN_BACKOFFICE',$5,$6,'ADMIN_UNBIND',gen_random_uuid(),NOW(),NOW())`（我逐行讀過整個 handler 178-275，無任何 parent_line_uid_bindings 操作）；換綁會補插：server/services/parentAccountRecovery.js:328-334 `INSERT INTO parent_line_uid_bindings (...) VALUES ($1,$2,'ACTIVE',...) ON CONFLICT DO NOTHING`
- 註：證據對得上。因為正式程式沒有讀這張表，目前不會造成功能故障；但若日後有人拿它當「這支 LINE 現在綁誰」的依據，資料是錯的。另外 uq_parent_line_uid_binding_active_parent（同一家長只能有一筆 ACTIVE）在解除綁定後仍被舊紀錄佔著——換綁時那筆 INSERT 帶 ON CONFLICT DO NOTHING（:332）所以不會炸，但緊接的 UPDATE ... WHERE status='ACTIVE'（:336-340）會把舊紀錄標成 REPLACED，等於用換綁替解除綁定補做了收尾。

**9. 註冊流程裡「同一支 LINE 對到多筆歷史來源、又挑不出唯一勝出者」那條路，程式會直接崩掉回 500，家長看到「註冊失敗」，而且該有的人工協處工單根本不會被建立。原因是回應裡引用了一個在這個函式裡不存在的變數。**
- 依據：server/routes/auth.js:1222-1227 `return res.status(409).json({ error: '同一 LINE 帳號有多筆歷史來源，需完成帳號確認', code: 'ACCOUNT_CONFIRMATION_REQUIRED', internalCode: 'MULTIPLE_UID_SOURCE_NO_WINNER', retryable: false, correlationId: duplicateUidCorrelationId, loginAllowed: false, ... })`；該變數唯一宣告處在另一個 handler：同檔 711 `const duplicateUidCorrelationId = crypto.randomUUID();`（位於 `router.post('/bind', ...)` 內，666-797），_registerParentCore 定義於 1055-1664，scope 不相通
- 註：證據對得上——我跑 grep duplicateUidCorrelationId 確認全檔只有三處：711（宣告，在 /bind 內）、722（同 handler 內合法使用）、1225（跨 scope 的非法引用）。同一個 handler 裡還有一段完全對稱的註解，記錄 /bind 端點曾有一模一樣的 bug 已修（auth.js:714-718 「sourceIds 在這個 scope 不存在（它宣告在 _registerParentCore 裡）……而沒有任何人知道他們卡住了」），但註冊端這一處還在。緩解因素：整段只在 PARENT_IDENTITY_RESOLVER_V2 打開時才會跑到（auth.js:1175），而該旗標預設關閉（server/config/ragicSchema.js:83）。

**10. 「這支手機在系統裡存不存在」這個問題，三個入口查的地方不一樣：新流程的電話驗證查「本地待處理池 Z03 ＋ Ragic 家長主檔」（完全不查本地家長表）；舊綁定流程查「本地啟用中家長 ＋ Z03 ＋ Ragic」；團報的免登入電話查詢則查「本地家長表，不分啟用與否」。**
- 依據：新流程（無以 phone 查本地 parents 的查詢）：server/routes/auth.js:524-552 `z03ByPhone = await ragicAdmin.findZ03RecordByPhone(phone); ... ragicRow = await ragic.getParentByPhone(phone); ... if (!ragicRow) { return respond(200, { status: 'not_found' }); }`；舊流程：同檔 863 `SELECT line_uid FROM parents WHERE phone = $1 AND is_active = TRUE LIMIT 1`；團報：server/routes/groupOrders.js:380 `SELECT id, name FROM parents WHERE phone = $1 LIMIT 1`
- 註：證據對得上。補一個精確化：verify-phone 仍會先用 lineUid（不是 phone）查本地啟用中家長走快速通道（auth.js:515），所以「完全不查本地家長表」要限定在「不用 phone 查」。另補查確認 findZ03RecordByPhone 讀的是本地表 `ragic_z03_records`（server/services/ragicAdmin.js:3644-3653），而且只認 status='pending' 或 (status='manual_review' AND reason_code='AMBIGUOUS_STUDENT_MATCH') 兩種狀態，已 resolved／dismissed 的列查不到。實務後果如原註所述：某支手機在本地是啟用中的家長，但在 Ragic／Z03 都查不到（例如 outbox 還沒回寫成功的新戶），新流程會回 not_found 把人導去註冊，註冊時卻會撞上 PHONE_ALREADY_BOUND_TO_OTHER_LINE 409 —— 一條死路。

**11. 新流程的「帳號恢復」永遠走不通，會把家長困在一個無法通過的關卡：綁定那一步要求「流程票上必須帶有已驗過的學員姓名」才願意開立帳號恢復案件，但整個系統沒有任何一處會把學員姓名寫進流程票 —— 連第三步（學員姓名驗證通過）簽出的新票也沒有。結果是：手機已被另一支 LINE 綁走的家長，在新流程裡只會一直收到「帳號恢復前必須重新完成學員驗證」，而重新驗證再多少次都不會改變結果。** 〔覆核時補上〕
- 依據：消費端：server/routes/auth.js:668 `const { phone, lineUid, studentName: verifiedStudentName } = req.flow;` → 同檔 710 `if (!verifiedStudentName) { ... return res.status(409).json({ error: '帳號恢復前必須重新完成學員驗證', code: 'ACCOUNT_RECOVERY_VERIFYING', ... }); }`，只有 :733-741 `requestAccountRecovery({ ... studentName: verifiedStudentName, ... })` 那條路會真的發驗證碼；生產端：grep signFlowToken( 在 server/routes/ 只有五處，全都不傳 studentName —— auth.js:475 `signFlowToken({ lineUid })`、:539 與 :559 與 :632 `signFlowToken({ lineUid, phone, attempts: 0 })`、:648 `signFlowToken({ lineUid, phone, attempts: nextAttempts })`；欄位本身是有的：server/middlewares/flowAuth.js:21 `function signFlowToken({ lineUid, phone = null, attempts = 0, studentName = null })`、:28、:51 `studentName: payload.studentName || null`

**12. 新流程對「舊客戶還在本地待處理池（Z03）」這群人的兩道指示互相打架：第二步查到電話落在 Z03 時，程式註解明寫要把人導去註冊表單補齊資料，並簽出一張帶著這支電話的流程票；但註冊端點看到票上有電話就一律判定為「撞號可疑行為」，轉人工待審、不讓完成註冊。等於註冊這條路對這批人是封死的。** 〔覆核時補上〕
- 依據：指示：server/routes/auth.js:521-523 「本地 Z03 已有殘缺記錄（未綁定/未開通）→ 電話存在但資料不完整，導去 S4 REGISTER_NEW 由註冊表單補齊」＋同檔 539-540 `const newToken = signFlowToken({ lineUid, phone, attempts: 0 }); return respond(200, { status: 'found', reason: 'z03_pending', flow_token: newToken });`（票上帶 phone）；封死處：同檔 1696-1715 `const { lineUid, phone } = req.flow; ... if (phone) { ... parentSync.auditClaim({ phone, lineUid, result: 'phone_collision_blocked', reason: 'register_phone_collision' }); return res.json({ status: 'pending_review', reason: 'phone_collision' }); }`（註解 1689-1693 假設「flowToken 帶有 phone 時，代表是從 S3 verify-student 三次驗證失敗的 phone_collision 轉入」，但 z03_pending 也會帶 phone）；規模線索：同檔 536-537 「命中這條分支的正是『註冊到一半沒完成』的那群人（正式站 873 支電話）」

**13. 「每次呼叫 API 都即時確認家長還在啟用中」這道檢查沒有套滿：團報分享連結的預覽與免登入電話查詢，以及優惠試算，走的是另一個寬鬆版的身分解析，它只驗簽章與票的類型，完全不回資料庫確認帳號狀態。所以已被停用或解除綁定的家長，手上那張還沒過期的通行證在這幾支端點上仍會被當成本人（會影響「這是不是你自己」「你是不是已在這一團」的判斷）。** 〔覆核時補上〕
- 依據：嚴格版（有 DB 檢查）：server/middlewares/parentAuth.js:42-48 `const r = await pool.query('SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE', [p.parentId]); if (!r.rowCount) return res.status(401)...`；寬鬆版（無 DB 檢查）：同檔 83-94 `function optionalParent(req, _res, next) { ... const p = jwt.verify(token, getSecret()); if (p.type === 'parent') { req.parent = { id: p.parentId, phone: p.phone, lineUid: p.lineUid || null }; } ... next(); }`；使用處：server/routes/groupOrders.js:350 `router.get('/by-token/:token', previewRateLimit, optionalParent, ...)`、:370 `router.post('/by-token/:token/lookup-phone', lookupRateLimit, optionalParent, ...)`（:396 `is_self: req.parent?.id === parent.id`）、server/routes/promotions.js:56 `router.post('/preview', optionalParent, ...)`；同款不對稱亦見 parentAuth.js:64-78：requireLiffUser 對 parent 做 is_active 檢查，對 coach 完全不做

**14. 「家長的 LINE UID 絕對不外流」這條只成立在家長端。後台的家長管理 API 會把完整未遮罩的 LINE UID 直接回給前端，而同一筆回應裡學員的身分證字號與血型卻是預設遮罩、要加參數並寫稽核才看得到原值。也就是說同一支 API 對兩種個資採兩套標準。** 〔覆核時補上〕
- 依據：UID 不遮罩：server/routes/admin/customerParents.js:35-37 `const PARENT_COLS = \`p.id, p.line_uid, p.phone, p.name, ...\`` ＋ 同檔 39-43 `function rowToParent(r, studentCount = 0) { return { id: r.id, line_uid: r.line_uid || null, line_bound: !!r.line_uid, ... } }`（另有一個現成的 line_bound 布林，顯示需求其實只要它）；學員個資遮罩：同檔 61-69 `id_number: reveal ? (r.id_number || '') : maskId(r.id_number), ... blood_type: reveal ? (r.blood_type || '') : maskBlood(r.blood_type)` ＋ 檔頭政策 同檔 18 「PII：身分證/血型預設遮罩，需帶 ?reveal=1（並寫稽核）才回原值」；對照家長端的處理：server/routes/auth.js:215-216 與 client/liff/src/api/client.js:69-70


### 2.2 解綁、自助重綁與帳號救援（12 條）

**15. 後台確認視窗告訴客服「Replit 與 Ragic 兩邊的舊 UID 都會清除」，但實際上 Ragic 那一步是盡力而為，失敗後舊 UID 仍留在 Ragic Z01 上。**

- 誰能做：櫃檯（看到的說明與實際行為不同）
- 依據：client/admin/src/pages/CustomerParentsPage.jsx:267 `<li>可以換成<b>不同的 LINE 帳號</b>綁定（Replit 與 Ragic 兩邊的舊 UID 都會清除）</li>` 對照 server/routes/admin/customerParents.js:241-243 `} catch (e) { ragicError = e.message; console.warn('[unbind-line] Ragic Z01 UID 清除失敗（本地已解除）:' ...`
- 註：確認視窗的文案是「一定會清」，只有事後的 API 回應與 toast 才會告知「沒清成功」。客服若只看確認視窗會以為兩邊都乾淨了。這條的實際後果見「夜間同步把舊 UID 寫回」那條。

**16. 客服解除綁定不會去動「綁定歷史表」parent_line_uid_bindings：舊 UID 那一列還維持 ACTIVE，於是「家長已無綁定」與「綁定歷史顯示仍綁著舊 UID」會長期不一致。只有帳號救援換綁這條路會維護這張表。**

- 誰能做：沒有人（兩條路徑各寫各的）
- 依據：server/routes/admin/customerParents.js:210-228（整段只 UPDATE parents 與 INSERT 稽核表；全端點無 parent_line_uid_bindings）對照 server/services/parentAccountRecovery.js:336-338 `UPDATE parent_line_uid_bindings SET status='REPLACED',revoked_at=$2, replaced_by_uid_hash=$3,updated_at=$2 WHERE canonical_parent_id=$1 AND status='ACTIVE'`
- 註：全 repo 對這張表的寫入只有 parentAccountRecovery.js:329 / :336 / :342 與 bootstrap 的一次性回填（server/bootstrap/coreSchema.js:1529）—— 我用 grep 掃過 server/ 與 client/ 全部確認。表上有兩條唯一索引：同一支 UID 只能有一列 ACTIVE、同一位家長只能有一列 ACTIVE（coreSchema.js:1527-1528）。

**17. 同一件事（這支電話已綁另一支 LINE），本地認領交易內部會依走到哪個分支拋出兩種不同代碼：ACCOUNT_RECOVERY_REQUIRED 或 PHONE_BOUND_TO_OTHER_UID。前者會讓家長端顯示「請完成手機所有權驗證或聯絡客服協助恢復」，但後端這條路完全沒有建立救援案件，所以客服手上沒有任何案件編號或驗證碼可以作業。**

- 誰能做：沒有人（兩邊判準不一致）
- 依據：server/services/z03IdentityClaim.js:493 `throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁定另一個 LINE UID', 409);` 與 :760 `throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁另一個 LINE UID', 409);`；對照 :871 與 :918 的 PHONE_BOUND_TO_OTHER_UID。前者在 server/routes/auth.js:305 被翻成 `syncState: err.code === 'ACCOUNT_RECOVERY_REQUIRED' ? 'ACCOUNT_RECOVERY_REQUIRED' : null`，client/liff/src/pages/LoginPage.jsx:97 顯示恢復文案
- 註：差別在分支位置，不在業務情境：:493 在「家庭內找不到同名學員且允許新增學員」分支（:480 `if (exactMatches.length === 0)` + `if (allowStudentAppend)`）、:760 在「多來源排不出主檔」分支、:871/:918 在正常認領主路徑。四個分支的業務意義都是同一件事。LoginPage.jsx:122-123 只有在回應帶 recovery_token 時才印案件編號，這四條都不會帶。

**18. 新版三段式登入流程（verify-phone → verify-student → bind）永遠走不到帳號救援：verify-student 驗證通過後簽發的流程票券沒有把學員姓名帶進去，所以 /bind 讀到的「已驗證學員姓名」一定是空的，必定落到「開一張後台工單 + 回 409」那條分支，該端點裡呼叫 requestAccountRecovery 的那段是死碼。**

- 誰能做：沒有人（新流程無法發起救援）
- 依據：server/routes/auth.js:632 `const newToken = signFlowToken({ lineUid, phone, attempts: 0 });`（驗證成功仍不帶 studentName）；server/middlewares/flowAuth.js:21 `function signFlowToken({ lineUid, phone = null, attempts = 0, studentName = null })`；server/routes/auth.js:710 `if (!verifiedStudentName) { ... return res.status(409)...`，:735 `recovery = await requestAccountRecovery({...})` 因此不可達
- 註：我 grep 過全 repo 的 signFlowToken 呼叫端（auth.js:475/539/559/632/648 + server/scripts/ 三支測試腳本），沒有任何一處傳 studentName，所以 flowAuth.js:51 `studentName: payload.studentName || null` 恆為 null。兩套端點並存（auth.js:488-496 註解說明「不互相取代」）。目前家長端還沒接新流程，所以影響是「一旦前端改接新流程，帳號救援就整條消失」。

**19. /bind（新流程）碰到「這支電話已綁另一支真實 LINE」時，回的是 409 ACCOUNT_RECOVERY_VERIFYING，並開一張後台工單，但後端並沒有任何案件真的進入「驗證中」狀態。**

- 誰能做：沒有人（狀態碼與實際狀態不符）
- 依據：server/routes/auth.js:724-731 `return res.status(409).json({ error: '帳號恢復前必須重新完成學員驗證', code: 'ACCOUNT_RECOVERY_VERIFYING', ... syncState: 'ACCOUNT_RECOVERY_VERIFYING' });`（此前只 createParentIdentityBackofficeTask，未寫入 parent_account_recovery_requests）
- 註：ACCOUNT_RECOVERY_VERIFYING 在正式的案件狀態機裡是「admin 已開始複核」的意思（server/services/parentAccountRecovery.js:10 狀態列舉、:287 `SET state='ACCOUNT_RECOVERY_VERIFYING' ... verification_method='MANUAL_VERIFIED'`）。家長端 MAP 也沒有這個碼（LoginPage.jsx:94-121），會直接顯示後端原文。

**20. 沒有任何後台畫面可以完成帳號換綁，也沒有任何畫面或 HTTP 端點可以查詢救援案件、換綁稽核、或系統自動開出的身分工單——這三張表沒有任何對外的讀取入口，只能直接查資料庫。**

- 誰能做：沒有人（僅 DB 可查；換綁需直接呼叫 API）
- 依據：client/admin/src 完全沒有 account-recovery / manual-complete / backoffice-task 相關頁面或 API 呼叫（grep `manual-complete|recovery_token|backoffice` 在 client/ 只命中 roles.js 的角色旗標與 LIFF 的驗證碼顯示）；身分工單表的存取只有 server/services/parentIdentityBackoffice.js:24 `INSERT INTO parent_identity_backoffice_tasks`；換綁稽核表只有 customerParents.js:222 / parentAccountRecovery.js:379 的 INSERT 與 ragicSyncOutbox.js:183 / :441 的 UPDATE
- 註：措辭已修正：原稿說「三張表全系統只有寫入、沒有讀取」，但 parent_account_recovery_requests 其實有內部 SELECT（parentAccountRecovery.js:172、179、197、255、433）——那些是服務自己的交易內讀取，不是可供人查詢的端點。parent_line_uid_rebind_audit 與 parent_identity_backoffice_tasks 則確實一次 SELECT 都沒有。程式有五個地方會持續產生身分工單（z03IdentityClaim.js:398 與 :572、ragicSyncOutbox.js:465、ragicAdmin.js:2580、auth.js:712 —— grep 確認就是這五處），工單表也有「未結案」專用索引（coreSchema.js:1571-1572），但沒有人看得到這些工單。

**21. 但救援路徑用來決定「要對哪一筆 Ragic Z01 做換綁」的查詢，是「拿回來的第一筆」：那支查詢沒有任何多筆檢查，救援案件就綁在這筆被任意挑中的來源上，之後的 Ragic 換綁也只改這一筆。**

- 誰能做：系統自動（同一件事三種判準）
- 依據：server/services/ragic.js:683-688 `const data = await query(process.env.RAGIC_FORM_Z01, { where: `${FIELD.Z01.PHONE},eq,${phone}`, naming: 'EID' }); const records = Object.values(data); return records[0] || null;`；救援端點把它直接當來源：server/routes/auth.js:969 `ragicRecordId: mapped.ragic_record_id,`
- 註：三種判準並存：資料庫層（findZ03RecordByPhone）>1 筆直接轉人工；認領層跑六級證據排序且明文禁止「取第一筆」；救援層取第一筆。救援案件的來源編號會被寫進 parent_account_recovery_requests.ragic_record_id（coreSchema.js:1495 NOT NULL）並在完成時做來源歸屬檢查（parentAccountRecovery.js:104-116），但檢查的是「這筆屬不屬於這位家長」，不是「這筆是不是正確的主檔」。

**22. 一支電話在本地對到多位在職家長時，救援直接回 ACCOUNT_RECOVERY_FAILED，不轉人工、不開工單、不留待辦；同樣的情況在一般認領流程是回 DATA_RECONCILIATION_PENDING／DUPLICATE_PARENT_IDENTITY，並把 Z03 列標成人工複核、建立認領案件、開一張後台工單。**

- 誰能做：沒有人（兩邊處理方式不一致）
- 依據：server/services/parentAccountRecovery.js:151-152 `if (candidates.length !== 1 || parentMatches.length !== 1) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery requires one canonical parent'); }`；對照 server/services/z03IdentityClaim.js:902-904 `reviewContext = { z03Ids: [family.id], sourceRecordId: family.z01_ragic_record_id, code: 'DUPLICATE_PARENT_IDENTITY' }; throw new Z03ClaimError('DUPLICATE_PARENT_IDENTITY', 'canonical phone 命中多個 parent', 409);` + :1071-1080 觸發 `_persistManualReview`（該函式在 :378-401 寫 identity_claims(MANUAL_REVIEW) 並開工單）
- 註：救援路徑整支服務都沒有呼叫 createParentIdentityBackofficeTask（我 grep server/services/parentAccountRecovery.js 全檔 475 行無此字串），所以救援被擋下的家長不會留下任何人工待辦。認領層的補救是在原交易 ROLLBACK 之後用獨立交易補寫（z03IdentityClaim.js:1070-1080）。

**23. 「這支電話已綁另一支 LINE」在不同入口有四種不同結局：(1) 舊手機綁定端點且家庭還在 Z03 佇列 → 409 PHONE_ALREADY_BOUND_TO_OTHER_LINE，叫家長聯絡客服，沒有案件；(2) 舊手機綁定端點且 Ragic Z01 已完整、認領通過 → 建立救援案件並回案件編號＋驗證碼；(3) 新流程 /bind → 409 ACCOUNT_RECOVERY_VERIFYING，開工單，沒有案件也沒有碼；(4) 本地認領交易內 → 依分支拋 ACCOUNT_RECOVERY_REQUIRED 或 PHONE_BOUND_TO_OTHER_UID，兩者都沒有案件。**

- 誰能做：沒有人（四個入口判準不一致）
- 依據：(1) server/routes/auth.js:895-899 `if (z03ByPhone?.parent?.line_uid && z03ByPhone.parent.line_uid !== lineUid) { return res.status(409).json({ error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理', code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE' }); }`；(2) 同檔 :986-998 `code: 'ACCOUNT_RECOVERY_REQUIRED' ... recovery_request_id, recovery_token, recovery_expires_at`；(3) 同檔 :724-731；(4) server/services/z03IdentityClaim.js:493 / :760 / :871 / :918
- 註：分支順序決定命運：Z03 檢查（auth.js 步驟 2，:886-905）排在 Ragic Z01 檢查（步驟 3，:906 起）之前，所以「舊客戶還沒畢業出 Z03」這群人永遠拿不到救援案件。另外還有第五個入口，見 added 清單裡的 parentSync._syncWithLock。

**24. 客服解除綁定之後，若當天 Ragic 那一步清除失敗，夜間同步會把舊 UID 寫回本地、家長又變回「已綁舊 LINE」：凌晨 02:30 的 Ragic→本地全量拉回讀到 Ragic 上還留著的舊 UID，而本地 line_uid 是空的，於是補值寫回；凌晨 00:30 的本地→Ragic 回寫只挑「line_uid 不為空」的列，所以 Ragic 上那個沒清掉的 UID 也不會被補清。**

- 誰能做：系統自動（無人介入即發生）
- 依據：server/services/parentSync.js:291 `line_uid=CASE WHEN $12::boolean THEN NULLIF($3,'') ELSE COALESCE(line_uid,NULLIF($3,'')) END,`（$12=overwriteLineUid，預設 false → 走 COALESCE 補值）；夜間拉回不帶該參數：server/services/ragicAdmin.js:3372-3378 `const local = await parentSync.upsertLocalParent(client, mapped, mapped.line_uid || null, { reactivate: false, venuesMap, preservePending: true });`；夜間回寫的篩選：server/services/ragicAdmin.js:2304 `WHERE is_active = TRUE AND line_uid IS NOT NULL AND line_uid <> ''`；排程時間 server/cron/index.js:455 `scheduleTaipei('30 0 * * *', ...)` 與 :469 `scheduleTaipei('30 2 * * *', ...)`
- 註：路徑我逐段驗過：Ragic 仍有真 UID → hasRealUid=true（ragicAdmin.js:3342-3346），本地已無 UID 所以 boundPhoneOfUid 為 undefined → phoneMatches=true（:3352-3354），isIncomplete=false（:3356）→ 進 upsertLocalParent 補值。原稿引的 :3342-3367 應更正為「未開通只進 Z03」分支在 :3359-3368（`if (isIncomplete)` → `_upsertZ03Record` → continue）。若 Ragic 那步清除成功，Ragic UID 欄位為空 → 判為未開通只進 Z03 佇列，不碰 parents，本地維持未綁定。也就是說解綁是否真的生效，完全取決於那個盡力而為的 Ragic 寫入有沒有成功。回寫那邊另有 `AND (ragic_record_id IS NULL OR last_synced_at IS NULL)`（:2307），解綁雖然把 last_synced_at 清成 NULL 符合這條，但仍被 line_uid 非空那條擋掉。

**25. 救援換綁在檢查「這支新 LINE UID 有沒有被別人用」時，只查家長主檔，不查綁定歷史表；綁定歷史表上有「同一支 UID 只能有一列 ACTIVE」的唯一索引，撞到時整筆換綁會以通用的 ACCOUNT_RECOVERY_FAILED（HTTP 500）失敗，訊息裡看不出真正原因。**

- 誰能做：系統自動（兩張表的唯一性判準不一致）
- 依據：server/services/parentAccountRecovery.js:311-315 `SELECT id FROM parents WHERE is_active=TRUE AND line_uid=$1 AND id<>$2 FOR UPDATE ... if (otherParent) throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'New LINE UID became active on another parent');`（只查 parents）；:341-346 直接 `INSERT INTO parent_line_uid_bindings ... VALUES ($1,$2,'ACTIVE',$3,$4)` 無 ON CONFLICT；索引定義 server/bootstrap/coreSchema.js:1527
- 註：會撞到的前提是綁定歷史表殘留了 ACTIVE 舊列——而客服解綁正好會製造這種殘留（見「解綁不會動綁定歷史表」那條）。錯誤只會被包成 :457-461 的通用 500，帶 causeCode/constraint/causeMessage。注意申請階段的同名檢查（:164-168）也只查 parents。

**26. 「這支電話已綁另一支 LINE」其實有第五個入口：家長端的資料刷新／註冊補資料路徑（refreshParentMirrorFromRagic → _syncWithLock）。同一個函式裡就有兩個不同代碼：先用 ACCOUNT_RECOVERY_REQUIRED 擋（但同樣不建立任何救援案件），若擋不掉、寫完發現本地 UID 還是別人的，再改用 PHONE_ALREADY_BOUND_TO_OTHER_LINE 叫家長聯絡客服。** 〔覆核時補上〕
- 依據：server/services/parentSync.js:537-540 `if (dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) { throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED', '此手機已綁定其他 LINE 帳號，需完成帳號恢復驗證'); }`；:548-551 `if (local.line_uid && local.line_uid !== lineUid) { throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE', '此手機已綁定其他 LINE 帳號，請聯絡客服處理'); }`；呼叫鏈 server/services/parentRefresh.js:201 `local = await parentSync._syncWithLock({...})` ← server/routes/auth.js:1617（parent-register-line）、server/routes/parents.js:364 與 :464（家長端 me/sync）


### 2.3 學員管理與停學／復學（17 條）

**27. 同一件事——「未綁 LINE 的家長，他的學員可不可以編輯」——兩個後台入口判準不一樣：學員資料頁只在「明確要改成在籍」時才擋；家長頁子表只要送出的學員陣列裡有任何一筆不是明確標成停學，整筆就 409，連單純改姓名都過不去。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/routes/admin/customerStudents.js:195 `if (b.is_active === true && !isRealLineUid(own.rows[0].parent_line_uid))` vs server/routes/admin/customerParents.js:331 `if (!parentHasRealLineUid && b.students.some((s) => s && (!s.id || s.is_active !== false))) { ... code: 'PARENT_UNBOUND_CANNOT_ACTIVATE_STUDENT' }`
- 註：核實無誤，而且更嚴重一點：customerParents.js:331 的擋門在 `for` 迴圈之前，是**整批 ROLLBACK**——同一次送出裡其他學員的合法修改、以及家長本人欄位的修改（:325 已寫入同一交易）全部一起被撤回。錯誤碼與學員資料頁完全相同（PARENT_UNBOUND_CANNOT_ACTIVATE_STUDENT），但訊息不同（「無法新增或啟用學員」vs「無法啟用」），從畫面上仍難分辨是哪一種。

**28. 停學學員仍然看得到自己的「上課記錄」。這支查詢只看「學員屬於這個家長」與「這一期名單還是 active」，完全不看學籍。**

- 誰能做：家長自己（看得到）
- 依據：server/routes/courses.js:24-28 `const conds = [ \`s.parent_id = $1\`, \`cpe.status = 'active'\`, \`cs.status IN ('confirmed','completed','pending_group_confirm')\` ];`；:67-68 `FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id`（全查詢無 is_active 條件）
- 註：對照組正確：同一家長的個人資料頁（parents.js:106）已完全看不到這個小孩，所以畫面上會出現「學員清單沒有小明、上課記錄一堆小明」。這支端點還會回小明的姓名（courses.js:62 `s.name AS student_name`），不只是筆數。

**29. 課程詳情頁判斷「這門課能不能操作（顯示簽到／預約按鈕）」，依據是「本家長在這一期有掛載學員」，而那份學員清單沒有排除停學學員。結果是停學學員的課仍然畫出可操作按鈕，按下去才被擋。**

- 誰能做：家長自己（看得到但用不了）
- 依據：server/routes/courses.js:552-561 `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name), '[]'::jsonb) FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = cper.id AND cpe.status = 'active' AND s.parent_id = $2) AS students_detail`；:619-620 `const ownStudents = Array.isArray(row.students_detail) ? row.students_detail : []; const canAccessPeriod = !!row.course_period_id && ownStudents.length > 0;`
- 註：文件宣告的對照正確（docs/entitlement_repair_2026-09-22.md:45-46）。要補一點：**/mine 也自己算了一份 canAccessPeriod**（courses.js:245，用 :160-169 那份同樣未過濾的 students_detail），所以「看得到但用不了」在課程列表頁與詳情頁**兩處**都在，不只詳情頁。原清單只提到 /mine 有同樣的子查詢，沒指出 /mine 也據此畫按鈕。

**30. 停學學員的學習歷程，家長仍然打得開。守門只看「名下有學員在這一期，狀態是 active 或 transferred_out」，不看學籍。**

- 誰能做：家長自己（看得到）
- 依據：server/routes/learn.js:153-160 `SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = $1 AND s.parent_id = $2 AND e.status IN ('active','transferred_out') LIMIT 1` → `if (!guard.rowCount) return res.status(403).json({ error: 'Forbidden' });`
- 註：transferred_out 刻意放行、停學是意外一起被放行，核實無誤（同一個查詢沒有 is_active 條件）。

**31. 預約頁：停學學員的家長打得開課程期的可預約時段頁（看得到教練空檔），但按下去預約會被擋。看的那支不看學籍，訂的那支看。**

- 誰能做：家長自己（看得到但用不了）
- 依據：看：server/routes/slots.js:215-224 `SELECT 1 FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $1 AND s.parent_id = $2 AND cpe.status = 'active' LIMIT 1` → 否則 403「無權檢視此課程期」；訂：server/routes/slots.js:297-306 `const entitledStudents = await assertCourseEntitlement(client, coursePeriodId); ... AND cpe.student_id = ANY($3::uuid[])` → 403「無權預約此課程期」
- 註：規則本身成立，但**錯誤碼的敘述要修正**：回什麼錯誤取決於這一期還有沒有別的在籍學員。(a) 跨家庭／共班課期還有其他在籍學員 → assertCourseEntitlement 回傳的名單排掉停學那位，接著 slots.js:306 回 403「無權預約此課程期」（原清單說的情況）。(b) 這一期名單已經沒有任何在籍學員（例如獨生子女停學）→ assertCourseEntitlement 直接拋 STUDENT_ENTITLEMENT_INACTIVE（courseEntitlements.js:131），slots.js:340 `if (err.status === 409) return res.status(409).json({ error: err.message, code: err.code });` 會如實回 409 + STUDENT_ENTITLEMENT_INACTIVE。所以「從錯誤訊息完全看不出是停學造成的」只在共享課期成立。

**32. 課程轉讓：停學學員仍然會出現在家長的轉讓對象下拉，而且後端不檢查學籍——停學學員可以真的把剩餘堂數轉給別的家庭。**

- 誰能做：家長自己（做得到）
- 依據：前端來源：client/liff/src/pages/TransferRequestPage.jsx:34 `const students = selected?.students_detail || [];`（即 courses.js:160-169 那份未過濾清單）；後端：server/services/transfers.js:60-70 `... JOIN students s ON s.id = cpe.student_id WHERE cp.id = $1 AND s.id = $2 AND s.parent_id = $3 AND cpe.status = 'active' AND cp.status = 'active'`（無 is_active）→ `if (!en.rowCount) throw ... 400`
- 註：「整個面向唯一一個停學學員還能造成實質資產移動的路徑」這個判斷經核對成立（其他停學能做的事都是唯讀）。只要 remaining > 0（transfers.js:71-72）就送得出申請，後續由 admin/manager 核准（adminResources.js:38）。

**33. 停學不會停掉推播。教練發布課程計畫或送出授課紀錄時，通知名單是「這一期 active 名單的所有家長」，沒有排除停學學員。**

- 誰能做：系統自動
- 依據：server/routes/learn.js:183-186 `ARRAY(SELECT DISTINCT pa.line_uid FROM course_period_enrollments e JOIN students s ON s.id = e.student_id JOIN parents pa ON pa.id = s.parent_id WHERE e.course_period_id = cp.id AND e.status = 'active' AND pa.line_uid IS NOT NULL) AS uids`；同檔 :204-207 同一份查詢
- 註：`parents.is_active` 也沒看，所以連登入已被封的停用家長帳號都還會收到 LINE 推播——核實無誤（兩支查詢的 WHERE 都只到 pa.line_uid IS NOT NULL）。

**34. 教練／櫃檯看到的班級名單也含停學學員。槽位／課表上的學員姓名清單沒有過濾學籍。**

- 誰能做：系統自動
- 依據：server/routes/slots.js:85-91 `COALESCE((SELECT json_agg(s.name ORDER BY s.name) FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'), '[]'::json) AS student_names`
- 註：對照正確（櫃檯手動扣課的出席名單有過濾：manualDeductions.js:335）。但漏掉範圍：同一種未過濾的 student_names 還出現在 **server/routes/sessions.js:350、390、434、478、524**（教練端今日／本週／歷史／歷史課期等 5 支）與 **server/routes/integrations.js:54-57**（行事曆整合）。所以「教練看到 3 個名字、櫃檯只登記 2 人出席」不只在週表，在教練端幾乎每一個名單畫面都會發生。

**35. 同一個例外，文件寫的條件與程式的條件不同：文件說是「單人課期」，程式的條件是「名單裡已經沒有任何在籍學員」——那可以是三人全部停學的共享課期。**

- 誰能做：櫃檯／主管／管理員
- 依據：docs/entitlement_repair_2026-09-22.md:106 `| **T1** | server/services/courseEntitlements.js | 名單查詢排除 is_active = false 的學員；唯一例外是**單人課期**中被呼叫端明確指名的那一位 | ...` vs server/services/courseEntitlements.js:116-121 `// 例外的條件是「名單裡已經沒有任何未停用的學員」，不是「名單只有一人」。... 用「只有一人」當條件會讓「全員停用的共享課期」被擋掉，那是對共享課期單獨加的硬擋，踩到凍結令第 3 條。`
- 註：程式註解本身就明文反駁文件，核實無誤。同一份文件的另一處（:106 同一格「為什麼」欄）也寫「單人課期停用學員的補登」，manualDeductions.js:333-334 的註解同樣寫「單人課期」——所以「單人課期」這個錯誤說法在文件與另一支程式的註解裡共三處，只有 courseEntitlements.js 的實作與註解是對的。交接以程式為準。

**36. 課程轉讓核准時，轉入方的學員是用「姓名字串完全相同」去找的，而且不看學籍——可能把課轉進一位已經休學的同名學員身上。**

- 誰能做：主管／管理員（核准動作的副作用）
- 依據：server/services/transfers.js:132-135 `const sExist = await client.query(\`SELECT id FROM students WHERE parent_id = $1 AND name = $2 LIMIT 1\`, [toParentId, sName]);`
- 註：三個入口三種答案，全部核實：團購 groupOrders.js:164-172 有加 `AND COALESCE(is_active, TRUE) = TRUE`；家長端新增學員 parents.js:631-636 遇停學就 409 要家長找櫃檯；轉讓核准這裡完全不看。裸字串比對（沒走 normalizeStudentName，不做 NFKC、不去空白）也核實無誤——對照 identityNormalizer.js:20-26 的 normalizeStudentName 會 NFKC + 去全部空白 + 轉小寫。而且這支查詢沒有 ORDER BY 就 LIMIT 1，同名多筆時命中哪一筆不確定。

**37. 團購加入流程建學員時，比對既有學員會排除停學的人，比對不到就直接新建——同一個身分證可以因此出現第二筆學員資料，而且不會有任何錯誤。**

- 誰能做：家長自己（做得到）
- 依據：server/routes/groupOrders.js:155-160 `SELECT id, name FROM students WHERE parent_id = $1 AND id_number = $2 AND COALESCE(is_active, TRUE) = TRUE LIMIT 1`，比對不到則 :178-182 `INSERT INTO students (parent_id, name, birth_date, gender, id_number, blood_type) VALUES ($1, $2, $3::date, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''))`
- 註：對照成立：同情境在個資頁是 409 STUDENT_INACTIVE_CONTACT_COUNTER（parents.js:631-636）。同一位家長、同一個小孩、同一個身分證，走個資頁被擋、走團購頁默默多出一筆在籍學員；因為 id_number 沒有唯一索引（第 41 條），資料庫不吭聲。第二層 name+birth 比對（groupOrders.js:164-172）同樣排除停學者，所以連改用姓名生日也接不回去。

**38. 團購加入流程建學員只要求姓名，身分證與生日都是選填、也不驗格式；家長端個人資料頁則要求身分證格式正確且生日必填。同一個「建學員」動作，兩個入口的把關強度完全不同。**

- 誰能做：家長自己
- 依據：server/routes/groupOrders.js:109-119 `function cleanNewStudents(arr) { ... id_number: s?.id_number ? String(s.id_number).trim().toUpperCase() : null, birth_date: s?.birth_date ? String(s.birth_date).trim() : null, ... }).filter((s) => s.name);` vs server/routes/parents.js:581 `if (!s.name || !s.birth_date || !ISO_DATE.test(s.birth_date) || !TW_ID.test(s.id_number))`
- 註：另一個差異也核實：個資頁必須先在 Ragic 嚴格寫成功才落地本地（parents.js:642-656 先 createStudentZ01Z02Strict / updateStudentZ01Z02Strict 再 persistStudentMirrorAfterRagic），團購是先落地本地、Ragic 回寫 best-effort 失敗只記 log（groupOrders.js:200-206 + ragicWriteback.js 的 warn-only 契約）。所以團購建出來的學員可能長期停在「本地有、Ragic 沒有」。

**39. Ragic 學員同步的比對鍵實際上只有「家庭內姓名精準相符」一項——身分證與 Ragic record id 都不參與比對。程式的說明註解與實作不一致。**

- 誰能做：系統自動
- 依據：註解 server/services/parentSync.js:344 ` *  匹配序：(parent_id, id_number) → (parent_id, ragic_record_id) → (parent_id, name, birth_date)。` vs 實作 :373-377 `const exactNameMatches = familyRows.filter((row) => normalizeStudentName(row.name) === incomingName); ... matched = exactNameMatches[0] || null;`（查詢 :369-370 撈了 id/name/birth_date/id_number/ragic_record_id，但只用 name 比）
- 註：核實無誤。連帶後果（小孩在 Ragic 端改名 → 比對不到 → 當新學員 INSERT 一筆、舊列留著）也成立，這正是同一個小孩兩筆資料的來源之一。補一個相關細節：同一段 :392-397 會先把「掛在別的家長名下」的同 ragic_record_id 佔用解除，所以 ragic_record_id 在這裡是「寫入時避讓唯一鍵」用的，不是比對鍵——跟註解說的「匹配序第二層」完全是兩件事。

**40. 兩條 Ragic 同步路徑對停學的處理完全相反：一般家長同步明文保護「已停學的不會被同步復活」；夜間 canonical Z01 匯入卻無條件把學員寫成在籍，會把停學的人復活。**

- 誰能做：系統自動
- 依據：保護：server/services/parentSync.js:420 `is_active   = CASE WHEN is_active = FALSE THEN is_active ELSE TRUE END,`；復活：server/services/ragicAdmin.js:2924-2925 `id_number = COALESCE(NULLIF(id_number,''), NULLIF($7,'')), is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()`（_syncCanonicalZ01Record，定義在 :2767）
- 註：風險最高的一條，全部核實。呼叫端兩處：ragicAdmin.js:3140 與 :3203（_reconcileZ01FromShadowImpl 定義在 :3164），:3485 再被上層排程叫。稽核會留 by_role='system'、by_user='ragic:canonical-z01-sync'（:2939-2942），從畫面不容易看出是同步幹的。同一支函式對家長列也是無條件 `is_active = TRUE`（:2855），所以被停用的家長帳號也會被這條路徑靜默復活登入權限——這點比原清單寫的更嚴重，值得單獨跟櫃檯講。

**41. 後台家長清單顯示的學員人數是「全部學員」，不是在籍學員。**

- 誰能做：系統自動（顯示）
- 依據：註解 server/routes/admin/customerParents.js:4 ` *   GET   /api/admin/customer-parents          → 家長清單（含啟用學員數、LINE 綁定狀態）` vs 實作 :113-115 `SELECT ${PARENT_COLS}, COUNT(s.id) AS student_count FROM parents p LEFT JOIN students s ON s.parent_id = p.id`（無 is_active 條件）；畫面 client/admin/src/pages/CustomerParentsPage.jsx:160 `{r.student_count} 位 →`
- 註：「清單看到 3 位、點進去只有 2 位在籍」成立。停學學員在後台看得到、只是用 `ORDER BY is_active DESC` 排到最後（customerParents.js:137、:385；customerStudents.js:83），正確。

**42. 課程聊天室完全不看學籍：停學學員的家長仍然看得到、也進得去該課期的聊天室，聊天室名單上還會顯示停學學員的姓名。這是「這位家長在這一期有沒有權限」這件事的第四種判準（前三種是上課記錄、學習歷程、預約頁），而且是唯一一個連唯讀清單都會把停學學員姓名揭露給同期其他家長看的地方。** 〔覆核時補上〕
- 依據：進聊天室的守門：server/routes/chat.js:114-118 `SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = $1 AND e.status = 'active' AND s.parent_id = $2` → `allowed = own.rowCount > 0;`（無 is_active）；聊天室清單與名單：server/services/chatRooms.js:71-73 `(SELECT array_agg(DISTINCT s.name) FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active') AS student_names`、:74-76 同款的 `array_agg(DISTINCT s.parent_id) AS parent_ids`、:138-145 `async function listRoomsForParent(parentId) { ... WHERE EXISTS (SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active' AND s.parent_id = $1) ... }`

**43. 家長編輯自己小孩時，身分證撞號一律回同一句 409，完全不分辨撞到誰——不管撞到的是自己名下的停學小孩、還是別的家庭的小孩，訊息都是「此身分證字號已有學員資料」。同一件事在新增學員時卻會分三種情況給三種不同處置（自己名下在籍→合併回 200、自己名下停學→叫你找櫃檯、別人名下→不揭露對方）。** 〔覆核時補上〕
- 依據：編輯：server/routes/parents.js:687-698 `SELECT id FROM students WHERE id_number = $1 AND id <> $2 LIMIT 1` → `if (dup.rowCount) { return res.status(409).json({ error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。', code: 'STUDENT_ID_DUPLICATED' }); }`（不看 parent_id、不看 is_active）vs 新增：server/routes/parents.js:612-645（同樣全系統比對，但 :625 分別人名下、:631 分自己名下停學、:638 合併在籍）。實務症狀：家長想幫小孩訂正身分證打錯的字，只要那組號碼在系統裡被任何一筆（含停學、含別家）佔著，他就改不動，而且從訊息看不出是自己家那位停學的小孩佔著。


### 2.4 家長看得到什麼（可見性與權限）（12 條）

**44. 教練名單與教練介紹照片這兩支端點不做上面那道即時確認——只要通行證還沒過期，已被停用的家長帳號仍然看得到教練清單。**

- 誰能做：沒有人刻意開啟；是兩支端點各自寫了自己的驗證
- 依據：server/routes/coaches.js:170-191 requireParentOrCoach — `const payload = jwt.verify(token, getJwtSecret());` … `else req.parent = { id: payload.parentId || payload.sub || null };`（整段沒有任何 DB 查核）；掛在 coaches.js:193 `router.get('/', requireParentOrCoach, …)` 與 coaches.js:504 `router.get('/:id/media', requireParentOrCoach, …)`
- 註：敘述與判準正確，行號微調：函式體是 coaches.js:170-191（原寫 174-186 落在函式中段）。兩邊對照：parentAuth.js:43-44 查 parents.is_active；coaches.js 這支只驗簽章。最長暴露窗口＝通行證剩餘效期（至多 12 小時）。

**45. 上課記錄頁不看學員在不在籍——只要學員仍掛在該課期的在籍名單中，被停用學員的上課紀錄與姓名就會繼續出現在家長的上課記錄裡。**

- 誰能做：沒有人；這是查詢條件本身的差異
- 依據：server/routes/courses.js:25-27 — `s.parent_id = $1`, `cpe.status = 'active'`, `cs.status IN ('confirmed','completed','pending_group_confirm')`；server/routes/courses.js:67-68 — `FROM course_period_enrollments cpe / JOIN students s ON s.id = cpe.student_id`（無 is_active）
- 註：確認為本面向最重要的發現。條件陣列實際落在 courses.js:25-27（原寫 24-28）。兩邊：個資頁 parents.js:106 過濾 `COALESCE(is_active, TRUE) = TRUE`；上課記錄 courses.js:67-68 不過濾。實際效果＝櫃檯停用學員後，家長個資頁看不到這個小孩，上課記錄仍顯示他的姓名與每一堂紀錄。replit.md:206 只寫了「新策略不再 soft-delete 學員」，沒有交代停用學員的歷史紀錄該不該顯示。

**46. 課程轉讓頁的「要轉讓哪一位學員」下拉，同樣不看在籍狀態，被停用的學員仍可被選出來當轉讓來源。**

- 誰能做：家長自己（選取）
- 依據：server/routes/courses.js:164-168 — `FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = cper.id AND cpe.status = 'active' AND s.parent_id = $2`（回傳欄位名 students_detail）
- 註：行號對得上。同一段查詢在報名狀態頁 server/routes/courses.js:556-559 完整重複一次，兩處都缺 is_active。對照組：報名流程選學員時是有過濾的（server/routes/enrollments.js:372-374）。

**47. 預約上課時段的「這一期是不是我的」守門，只認學員掛在這一期且該掛載為在籍，不看學員本身是否被停用。**

- 誰能做：家長自己（查詢）
- 依據：server/routes/slots.js:215-224 — `SELECT 1 FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $1 AND s.parent_id = $2 AND cpe.status = 'active' LIMIT 1`；不通過回 slots.js:224 403 '無權檢視此課程期'
- 註：行號完全對得上。同一支路由的「真的下訂時段」那一步（slots.js:297-306）會多比對一份由 assertCourseEntitlement 算出的有效名單（`AND cpe.student_id = ANY($3::uuid[])`），那份名單排除停用學員（server/services/courseEntitlements.js:127-128），所以停用學員看得到時段、按下去才被擋，且擋下來的訊息換成 slots.js:306 403 '無權預約此課程期'。

**48. 學習歷程的守門不看學員在籍狀態，而且額外接受「已轉出」的學員掛載——轉出後家長仍看得到那一期的學習歷程。**

- 誰能做：家長自己（唯讀）
- 依據：server/routes/learn.js:153-157 — `SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = $1 AND s.parent_id = $2 AND e.status IN ('active','transferred_out') LIMIT 1`
- 註：行號對得上（守門查詢 153-157，403 在 158）。全系統只有兩處承認 transferred_out：learn.js:157 與 server/services/learning.js:332。上課記錄（courses.js:26）、時段（slots.js:220）、聊天室（server/services/chatRooms.js:207）、評鑑邀請（server/services/evaluations.js:31）、簽到（server/routes/checkins.js:105、122、354）一律只認 'active'。結果：學員轉出後，家長的學習歷程還在，上課記錄與聊天室當場消失。狀態由轉讓核准寫入（server/services/transfers.js:151 `UPDATE course_period_enrollments SET status = 'transferred_out'`）。

**49. 家長簽到時，停用學員最終還是會被擋下來，但擋下來的位置與錯誤訊息跟其他入口不同：不是「不屬於你」，而是「已退費或不在有效課程名單中」。**

- 誰能做：家長自己（操作）
- 依據：server/routes/checkins.js:331-334 歸屬檢查 `SELECT 1 FROM students WHERE id = $1 AND parent_id = $2`（無 is_active，checkins.js:337 回 403）；真正擋下來的是 server/services/courseEntitlements.js:130-131 `if (!roster.length || (studentId && !roster.includes(studentId))) throw conflict('STUDENT_ENTITLEMENT_INACTIVE', '學員已退費或不在有效課程名單中')`（409）
- 註：行號全部對得上。補一層：POST /api/checkins 其實有三道門，第二道（checkins.js:354 條件 `cpe.status = 'active'`，不通過回 checkins.js:363 403 '該學員未在此課程名單中'）同樣不看 is_active，所以停用但仍掛在名單上的學員要到第三道才被擋。家長看到的是退費措辭，實際原因是被停用。刻意的例外：整期學員全部停用時櫃檯手動扣課仍可對指名學員補登出席（courseEntitlements.js:124-128 keepNamedInactive），家長端傳 requireActiveStudent:true 關掉這個例外（checkins.js:370-371），該處註解記明是 2026-09-22 取得擁有者同意的凍結檔改動。

**50. 「我的課程」課程卡是用手機號碼歸戶的，不是用帳號：只要一張報名單的家長手機、或它的額外家長手機欄位裡有這支號碼，這張卡就會出現在該家長的課程頁。**

- 誰能做：櫃檯（決定報名單上填哪些手機）
- 依據：server/routes/courses.js:222 — `WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)`（$1 = req.parent.phone，見 courses.js:129 `const phone = req.parent.phone;`）
- 註：行號完全對得上。兩邊：同一個檔案的上課記錄用帳號 id（courses.js:25 `s.parent_id = $1`），課程卡用手機（courses.js:222）。第三種寫法在付款單：帳號 id 或手機任一符合（server/routes/checkout.js:25-32）。三個入口對「這是我的」定義不同。

**51. 同一批跨家庭的人，在團購階段看不到彼此的真實姓名（會被遮罩），開課之後在學習歷程與聊天室房間卻看得到完整姓名。**

- 誰能做：沒有人；是三個模組各自決定
- 依據：遮罩側 server/routes/groupOrders.js:217-218 — `parent_name: isSelf ? m.parent_name : maskName(m.parent_name), student_names: isSelf ? (m.student_names || []) : maskNames(m.student_names || []),`；不遮罩側 server/services/learning.js:328-334（整期全名，畫在 LearningHistoryPage.jsx:88）與 server/services/chatRooms.js:71-73（整期全名，畫在 ChatRoomPage.jsx:150 房間副標）
- 註：確認為本面向第二重要的發現，行號對得上；僅修正一處對照：聊天室是「房間副標」揭露（ChatRoomPage.jsx:150 `role === 'coach' ? '' : (room.student_names || []).join('、')`），清單畫面對家長顯示的是教練名而非學員名。同一批人、同一段關係，只因為流程階段不同就換了一套個資標準。凍結令（CLAUDE.md:13）只涵蓋「簽到方家長姓名」的揭露，沒有涵蓋學習歷程與聊天室的學員姓名，所以這兩處的揭露找不到對應的政策依據。

**52. 聊天室的進入門檻是「名下有在籍學員掛在這一期」，學員一轉出就立刻進不去聊天室、也看不到過去的對話。**

- 誰能做：系統自動
- 依據：server/services/chatRooms.js:203-207 — `SELECT 1 FROM chat_rooms cr JOIN course_period_enrollments e ON e.course_period_id = cr.course_period_id JOIN students s ON s.id = e.student_id WHERE cr.id = $1 AND e.status = 'active' AND s.parent_id = $2`
- 註：行號微調（203-207，原寫 203-208）。清單側同一判準：chatRooms.js:141-144 的 EXISTS 也只認 'active'。兩邊：聊天室只認 'active'，學習歷程額外接受 'transferred_out'（server/routes/learn.js:157）。同一個學員轉出後，家長留得住學習歷程、留不住對話紀錄。

**53. 個資頁的回傳內容包含該家長的 LINE 使用者識別碼與 Ragic 紀錄編號；但登入端點刻意不回傳 LINE 識別碼。**

- 誰能做：沒有人；兩支端點各自決定回傳欄位
- 依據：洩出側 server/routes/parents.js:97-99 — `SELECT id, name, phone, line_uid, gender, email, primary_venue_id, identity, home_phone, home_address, line_id, ragic_record_id FROM parents WHERE id = $1`，parents.js:428 直接 `res.json(me)`；封鎖側 server/routes/auth.js:215-216 註解 `line_uid 只供後端驗證／簽 JWT 使用，不回傳給 LIFF，避免被 browser devtools、第三方 error reporter 或錯誤的前端 log 蒐集`
- 註：行號完全對得上。兩邊：登入（auth.js 的 _issue，auth.js:209-225）明確排除 line_uid；個資頁（parents.js 的 loadMe）整列回傳。GET /api/parents/me（parents.js:428）與 POST /api/parents/me/sync（parents.js:480-482 `res.json({ ...me, sync_status: syncStatus })`，連錯誤降級路徑 parents.js:488-489 也是）都受影響。

**54. 聊天室的兩支家長端點都會把這一期全部學員的姓名（含別家小孩）放進回應，但畫面只有房間內的副標會顯示出來；清單畫面對家長顯示的是教練名。也就是說「看得到的」與「拿得到的」在這裡不一致。** 〔覆核時補上〕
- 依據：後端不分家庭回傳：server/services/chatRooms.js:71-73 — `(SELECT array_agg(DISTINCT s.name) FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active') AS student_names`，經 chatRooms.js:125 `student_names: r.student_names || [],` 送出，家長清單（chatRooms.js:138-148 listRoomsForParent）與單一房間（chatRooms.js:213-218 getRoomMeta）共用同一段 ROOM_BASE_SELECT；前端只在房間副標畫出來：client/liff/src/pages/ChatRoomPage.jsx:150 `role === 'coach' ? '' : (room.student_names || []).join('、'),`；清單不畫：ChatListPage.jsx:60-62 家長分支取 `${r.coach?.name || '教練'} 教練`。ROOM_BASE_SELECT 同時被家長、教練、後台三個入口共用（chatRooms.js:138-177），所以無法只對家長收窄。

**55. 被櫃檯停用的學員，家長連「編輯」都不行：個資頁改學員資料只認在籍學員，對停用學員回「找不到學員」，與上課記錄仍顯示該學員姓名並存。** 〔覆核時補上〕
- 依據：server/routes/parents.js:683 — `WHERE id = $1 AND parent_id = $2 AND COALESCE(is_active, TRUE) = TRUE`；parents.js:686 `if (!cur.rowCount) return res.status(404).json({ error: '找不到學員' });`。對照 server/routes/courses.js:67-68 的上課記錄查詢完全不看 is_active，所以同一個小孩：上課記錄看得到名字、個資頁看不到、加不回來（parents.js:631-635）、也編輯不了。


### 2.5 簽到、預約與取消（10 條）

**56. #41 「每日限簽一次」只在自助簽到路徑成立。預約制的逐堂簽到完全沒有每日上限 —— 同一天排了兩堂就可以簽兩堂、扣兩堂。**

- 誰能做：家長自己
- 依據：自助側：server/routes/checkins.js:176-192 `… AND (cr.checked_in_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date LIMIT 1` → 409 ALREADY_CHECKED_IN_TODAY。預約制側：server/routes/checkins.js:322-458 全段無任何當日簽到次數或日期檢查（逐行讀過）
- 註：單向性有程式註解自認（server/routes/checkins.js:173-175「每日一次的 unique index 只涵蓋自助建立的課堂」）。這條的「一天扣兩堂」路徑我另外確認了機制前提：預約制簽到根本不看課程期的 checkin_mode（見 added 第 3 條），所以自助簽到制的期別只要留有舊預約課堂，兩條軌道就都走得通。

**57. #42 課程期到期日只擋自助簽到，不擋預約制簽到，也不擋預約新時段。**

- 誰能做：家長自己
- 依據：擋的那邊：server/routes/checkins.js:66 `(cp.expires_at >= (NOW() AT TIME ZONE 'Asia/Taipei')::date) AS not_expired` → :88-91 `code: 'PERIOD_EXPIRED'`。不擋的那邊：server/routes/checkins.js:322-458 與 server/routes/slots.js:267-351 完全沒有引用 expires_at
- 註：我用 grep 覆核全 repo（排除 node_modules）：expires_at 出現在 routes/services/cron 共 20 餘處，唯一當守門條件的就是 checkins.js:66；其餘是顯示（courses.js:288/670）、報表（admin/reports.js:97）、到期提醒 cron（cron/index.js:200）、建期時寫入（admin/enrollments.js）。櫃檯實務影響的描述正確。

**58. #43 停用學員的判準兩條路徑不一樣：預約制逐堂簽到會在守門就把停用學員擋掉；自助簽到只是在寫出席時把停用學員過濾掉，不擋整筆請求。**

- 誰能做：家長自己
- 依據：嚴格那邊：server/routes/checkins.js:370-371 `assertCourseEntitlement(client, ctx.rows[0].period_id, studentId, { requireActiveStudent: true })`。寬鬆那邊：server/routes/checkins.js:92 `assertCourseEntitlement(client, periodId)`（不指名學員、不帶 requireActiveStudent）＋ :124 `AND COALESCE(s.is_active, TRUE) = TRUE`
- 註：改嚴格的理由有註解背書（server/routes/checkins.js:366-369「原本會放行 → 寫入依 is_active 過濾成 0 筆 → … 堂數扣了、出席沒有、家長看到錯誤」，迴歸鎖 tests/course_entitlement_is_active_db_test.js，檔案存在）。自助側的寬鬆語意在 courseEntitlements.js:116-126 有刻意設計說明（`keepNamedInactive`）；不過自助側的 :130-132 仍會在 roster 全空時擋下（STUDENT_ENTITLEMENT_INACTIVE），所以「全員停用」實際上是被 courseEntitlements 擋掉、而不是產生零出席課堂 —— 這點把原條目的註記修正一下。

**59. #44 「今天是否已簽到」畫面上的判準跟伺服器的判準不一樣：畫面只看「今天有沒有自助簽到建立的課堂」，伺服器擋的是「今天有沒有任何有效簽到」。**

- 誰能做：系統（顯示與守門不一致）
- 依據：畫面側：server/routes/courses.js:575-579（/courses/:id）與 server/routes/courses.js:186-190（/courses/mine）`AND cs3.created_via = 'self_checkin' AND cs3.self_checkin_date = (NOW() AT TIME ZONE 'Asia/Taipei')::date AND cs3.status NOT IN ('cancelled_normal','cancelled_penalty') … AS self_checked_in_today`。守門側：server/routes/checkins.js:176-185（任何來源的當日 ATTENDED 都算）
- 註：症狀描述正確。按鈕的 disabled 條件在 client/liff/src/pages/MyCoursesPage.jsx:217-224（`disabled: !!cp.self_checked_in_today`），彈窗重抓最新狀態在 SelfCheckinModal.jsx:31-47、判斷在 :51-64 —— 重抓到的仍是同一個較窄的 self_checked_in_today。

**60. #45 「撤銷簽到」兩個後台入口的保護程度不一樣：專用的「撤銷自助簽到」入口會擋下教練已填上課紀錄的課堂，而「扣課復活」入口對任何已扣堂課堂都放行，沒有這道擋。**

- 誰能做：櫃檯／管理端（兩個入口權限資源不同：checkin vs revive）
- 依據：有擋：server/routes/admin/checkins.js:168-175 `if (hasRecord.rowCount && !['cancelled_normal','cancelled_penalty'].includes(row.status)) return res.status(409).json({ … code: 'SESSION_RECORD_EXISTS' })`，且 :182 傳 `allowCreatedVia: 'self_checkin'`。沒擋：server/routes/admin/sessions.js:507 `await reverseLessonDeduction(client, { sessionId: id, reason, reversedBy: by })`（沒有 allowCreatedVia、前面也沒有查 session_records —— 我逐行讀過 :473-537）
- 註：「兩個入口最後都走同一支 server/services/deductionRevival.js:14 reverseLessonDeduction、效果相同」覆核成立。所以同一筆「教練已寫紀錄」的自助簽到，從撤銷入口會被擋、從復活入口撤得掉。附帶差異：revive 還會走 DEDUCTION_REVIVAL_V2 的旗標／電話比對（見 #34 註記），撤銷入口沒有這層。

**61. #46 「剩餘堂數」與「尚可預約堂數」是兩個定義不同的數字，同一個課程期可能同時顯示「剩餘 5 堂」和「尚可預約 3 堂」。**

- 誰能做：系統（顯示定義不一致）
- 依據：剩餘堂數（已出席為分子）：server/routes/checkins.js:266-274 `COUNT(DISTINCT cr.course_session_id) … AND cr.attendance_status = 'ATTENDED'`、server/routes/courses.js:172-179 與 :543-550 `attended_sessions`，畫面用 client/liff/src/components/SelfCheckinModal.jsx:50 `Math.max(0, (info.total_sessions||0) - (info.used_sessions||0))`。尚可預約堂數（已排為分子）：server/routes/slots.js:246 `sessions_left: Math.max(0, Number(period.total_sessions) - Number(period.booked_sessions || 0))`，分子在 server/routes/slots.js:203 `COUNT(cs.id) FILTER (WHERE cs.status::text NOT LIKE 'cancelled%')`
- 註：同頁混用正確：client/liff/src/pages/MyLessonsPage.jsx:134-136 剩餘用已出席算，同頁 :167-172 的佔位卡張數用已排（`total - sortedRecords.length`）算。還有第三種算法在報表與到期提醒 —— 直接讀鏡射欄位 used_sessions（server/routes/admin/reports.js:97、server/cron/index.js:195），見 added 第 4 條。

**62. #47 自助簽到有兩個進入點（我的課程卡片、上課記錄頁），兩邊送給彈窗的「課程 id」定義不同 —— 上課記錄頁送的是課程期 id，但彈窗打的是「報名單」查詢端點，對不上，會顯示「無法取得課程最新狀態，請檢查網路後重試」。**

- 誰能做：家長自己（其中一個入口實際上開不起來）
- 依據：正確入口：client/liff/src/pages/MyCoursesPage.jsx:224 `onClick: () => setSelfCheckinTarget(cp)`（cp 來自 /courses/mine，`id: row.id` 是 admin_enrollments.id，courses.js:259）。對不上的入口：client/liff/src/pages/MyLessonsPage.jsx:245 `onSelfCheckin={() => setSelfCheckinPeriodId(enrollment.periodId)}` → :266 `course={selfCheckinPeriodId ? { id: selfCheckinPeriodId } : null}`，而 periodId 來自 :95 `periodId: c.course_period_id`。彈窗一律拿它打報名單端點：client/liff/src/components/SelfCheckinModal.jsx:37 `coursesApi.get(course.id)` → server/routes/courses.js:521 `router.get('/:id', requireParent, …)`，查詢條件 :611 `WHERE e.id = $1`（admin_enrollments.id TEXT，db/migrations/002_admin_tables.sql:78-79 `id TEXT PRIMARY KEY`）
- 註：行號小修：觸發點是 MyLessonsPage.jsx:245（原條目寫 266，那是 SelfCheckinModal 的 course prop）；courses.js 的路由起點是 :521、WHERE 在 :611。推論鏈覆核成立：TEXT 欄位吃 UUID 字串不會撞型別錯誤，只會 0 列 → 404「找不到此報名」（courses.js:614）→ 彈窗落到 loadError 分支（SelfCheckinModal.jsx:42-45）。我同樣沒有執行程式或連資料庫（任務鐵則），這條兩人都是純靜態追出來的，交接時建議實機點一次。

**63. #48 取消類型的命名在文件、測試與資料庫之間不一致：資料庫與程式用「正常取消／罰則取消（cancelled_normal / cancelled_penalty）」，文件與測試註解出現「逾時取消／cancelled_late」。**

- 誰能做：不適用（命名不一致）
- 依據：資料庫真相：server/bootstrap/coreSchema.js:24 `CREATE TYPE session_status AS ENUM ('pending_group_confirm','confirmed','completed','cancelled_normal','cancelled_penalty')`。文件：docs/architecture_v7.md:277「逾時取消」（同檔 :285 對應值寫的是 cancelled_penalty）。測試註解：tests/e2e/path_d_self_cancel.js:4「驗 status='cancelled_late'」，同檔 :28 實際跑 `for (const kind of ['normal','penalty'])`
- 註：正確。補一點：docs/architecture_v7.md:285 與 docs/dev_schedule.md:205 其實都寫對了值（cancelled_normal / cancelled_penalty），錯的只有中文標籤「逾時取消」與測試註解的 cancelled_late。影響有限。

**64. #49 那段沒被接線的取消函式用的是「堂數減一」的舊算法，跟全系統「重新計算已出席堂數」的算法相衝突。**

- 誰能做：沒有人（死碼；已被凍結令明令不得接線）
- 依據：舊算法：server/services/slots.js:141-146 `UPDATE course_periods SET used_sessions = used_sessions - 1 WHERE id = (SELECT course_period_id FROM course_sessions WHERE id = $1) AND used_sessions > 0`。現行算法：server/services/usageSync.js:25-28 `UPDATE course_periods SET used_sessions = $2 …`（$2 由呼叫端重算的權威出席數傳入）
- 註：CLAUDE.md:18 的警告文字覆核無誤。另外 cancelSession 也不會清 self_checkin_date、不會把 attendance 標 REVERSED、不寫稽核，跟現行的 reverseLessonDeduction（deductionRevival.js:97-152）差距不只堂數算法一項 —— 日後要做取消功能，這段不能直接復用。

**65. 預約制的逐堂簽到完全不看課程期的簽到模式：自助簽到制的課程期，只要還留著舊的預約課堂，家長照樣可以走預約制路徑把那一堂簽掉。判準只有單向 —— 自助簽到會擋「這期是預約制」，預約制簽到不擋「這期是自助簽到制」。** 〔覆核時補上〕
- 依據：擋的那邊：server/routes/checkins.js:80-83 `if (period.checkin_mode !== 'self') { … 'SELF_CHECKIN_NOT_ENABLED' }`。不擋的那邊：server/routes/checkins.js:322-458 全段沒有讀取 checkin_mode（該路由的 ctx 查詢 :340-357 連這個欄位都沒 SELECT）


### 2.6 報名、付款與退費（19 條）

**66. 同一件事（家長送出付款資料）四個入口的完成判準不一致：付款單頁與報名狀態頁的畫面都要求「末 5 碼＋匯款證明兩項齊備」才讓按鈕亮，但後端 API 只要三項（末 5 碼／證明／載具）任一有值就收；團報送審嚴格要求兩項齊備，櫃檯核准團報又放寬成兩項擇一。**

- 誰能做：家長自己
- 依據：client/liff/src/pages/CheckoutPage.jsx:197 `const submitDisabled = proofBusy || !validLast5 || (!proofFile && !checkout.has_payment_proof);`；server/routes/checkout.js:291-293 `if (!proofInput.clear && !nextProofUrl && !nextLast5 && !nextCarrier) ... code: 'PAYMENT_INFO_REQUIRED'`；server/services/groupOrderSubmit.js:46-54 `「付款齊備」在送審端比後台核准端嚴...送審端要求兩者都有`；server/routes/admin/groupOrders.js:404-407 `家長端 my-proof 允許「轉帳末 5 碼」或「匯款證明」擇一送出（櫃檯憑末 5 碼即可查帳），核准守門必須採同一標準：兩者皆缺才擋`
- 註：四處判準全部核對無誤，並補兩點：①報名狀態頁前端同樣要求兩項（EnrollStatusPage.jsx:100 `if (!proofFile && !enr.has_payment_proof) return toast.error('請選擇匯款／轉帳證明');`、:245 送出鈕 disabled 同條件）；②「只填載具」會被 API 收下卻**不會**推進待對帳（:291 必填檢查含 carrier、:296 狀態判定不含），家長會停在待繳款而自以為送出了。程式註解只替團報兩端的差異留了理由，一般報名 UI 與 API 的落差沒有任何註解。

**67. 同一張訂單，兩個對帳入口算出的總堂數可能不同：付款單批次對帳優先沿用訂單上已有的堂數，單筆對帳一律重算成「每期堂數 × 期數」並覆蓋。**

- 誰能做：櫃檯
- 依據：server/routes/admin/checkouts.js:295-297 `const total = row.order_kind === 'trial' ? 1 : (Number(row.total_sessions) || perPeriod * (Number(row.period_count) || 1));`；server/routes/admin/enrollments.js:1296 `const total = cur.rows[0].order_kind === 'trial' ? 1 : (perPeriod * periodCount);`
- 註：完全成立。家長端建單把一般訂單堂數寫死 6（enrollments.js:579 `paymentMethod, orderKind, isTrial ? 1 : 6,`），所以全站設定的每期堂數若不是 6，批次對帳＝6 堂、單筆對帳＝設定值。團報核准的訂單不寫 total_sessions（admin/groupOrders.js:513-515 欄位清單確認沒有這一欄），因此一定吃設定值。櫃檯手動建檔的訂單有寫（admin/enrollments.js:815 `total_sessions`＝periodSessions），批次對帳時會沿用。

**68. 「每期幾堂」有多個來源互不相通：家長報名頁試算讀「該場館所屬定價區」的設定，家長建單時寫死 6，對帳時讀全站設定，後端試上價推算也讀全站設定。**

- 誰能做：沒有人（僅設定可改）
- 依據：server/routes/courses.js:489 `z.sessions_per_period AS sessions_per_period`（FROM venues JOIN pricing_zones）；server/routes/enrollments.js:579 `isTrial ? 1 : 6,`；server/routes/admin/checkouts.js:287-288 `const settings = await getSettings(); const perPeriod = settings.sessions_per_period || 6;`；server/routes/enrollments.js:381-383 `SELECT key, value FROM admin_settings WHERE key IN ('sessions_per_period', 'trial_price', $1)`
- 註：敘述成立且比原文更嚴重：實際有**四個**來源（第四個是後端試上價推算，enrollments.js:381-385 → trialEnrollment.js:58 `Math.max(1, Math.trunc(Number(settings.sessions_per_period) || 6))`，讀全站設定）。而且建單當下 cfg 手上已經有定價區的值——courseConfig.js:84 `return { ...r.rows[0], zone, sessions_per_period: zone.sessions_per_period };`——卻沒被使用。base-price 端點的分區註解在 courses.js:485-487，行號對。

**69. 試上價的取值順序前後端不一致：後端在課別設定的試上價之外還會退回兩個舊全域設定鍵，前端只認課別設定、其餘一律用「單期價 ÷ 每期堂數」推算，而且推算用的每期堂數也是不同來源（前端用定價區、後端用全站設定）。**

- 誰能做：沒有人（僅設定可改）
- 依據：server/services/trialEnrollment.js:53-55 `const courseSpecific = positiveMoney(settings[`trial_price_course_${courseType}`]); const configured = courseSpecific || positiveMoney(settings.trial_price); if (configured) return Math.round(configured * m);`；client/liff/src/hooks/useEnrollmentPricing.js:35-37 `return Number.isFinite(configured) && configured > 0 ? Math.round(configured * m) : Math.round(unitPrice / sessionsPerPeriod);`
- 註：成立。前端 sessionsPerPeriod 來自 base-price 端點＝定價區值（useEnrollmentPricing.js:29 `Number(bootData?.sessionsPerPeriod)`；courses.js:489、:511）；後端推算退路用 admin_settings 全站值。畫面價≠成交價只會在「課別沒設試上價、但舊全域鍵有值」時發生，維持 uncertain：未連資料庫，無法確認 admin_settings 的 trial_price／trial_price_course_N 目前是否有值。

**70. 三個「取消待付款訂單」的入口，只有兩個會回沖優惠名額：家長自己取消、櫃檯取消整張付款單都會回沖，櫃檯取消單筆報名不會。**

- 誰能做：家長自己／櫃檯
- 依據：server/routes/courses.js:863 `await promotions.revertUsage({ adminEnrollmentId: row.id }, client);`；server/routes/admin/checkouts.js:512 `await promotions.revertUsage({ adminEnrollmentId: row.id }, client);`；server/routes/admin/enrollments.js:1708-1742（UPDATE status='cancelled' → UPDATE checkout_sessions → INSERT audit log，整段無 revertUsage）
- 註：逐行看完 admin/enrollments.js 的 /:id/cancel（1686-1753）確認沒有任何 revertUsage 呼叫，對照同檔退費路徑 :1663 有呼叫。對家長的影響如敘述：被櫃檯用單筆取消後，該筆占用的個人期數上限與平台總額度不會歸還，下次報名可能被判「您已達到該優惠活動的個人使用上限」（promotions.js:175）。這是本清單裡對家長金錢影響最直接的一條不一致。

**71. 「取消原因」只有退回補件會寫進家長看得到的欄位；櫃檯取消報名與取消整張付款單的原因只進後台稽核紀錄，家長端顯示的是空白。**

- 誰能做：櫃檯
- 依據：server/routes/admin/enrollments.js:1796 `cancel_reason = $2, returned_at = NOW(), returned_by = $3,`（return-for-fix）；同檔 :1738-1741 `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason) VALUES ($1, $2, $3, $4)`（cancel 只寫稽核）；server/routes/courses.js:275 `cancel_reason: row.cancel_reason || null,`
- 註：成立。付款單取消原因寫進付款單稽核 JSON（admin/checkouts.js:533 `'reason', $4::text`），而家長端讀付款單的 shapeCheckout 不回傳 audit_log 的 reason（services/checkouts.js:221-257 欄位清單）。另注意 admin 取消時 reason 非必填（:1691 空字串也放行），付款單取消則必填（admin/checkouts.js:473-474）。

**72. 取消付款單時，兩個入口對「連帶取消範圍」判準不同：付款單頁取消會把整張付款單下所有子訂單一起取消，報名狀態頁取消只取消當前那一筆，其餘子訂單留在待付款。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:377-381 `UPDATE admin_enrollments SET status = 'cancelled', updated_at = NOW() WHERE checkout_id = $1`；server/routes/courses.js:834-838 `UPDATE admin_enrollments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`
- 註：兩個後端入口的差異成立，付款單只在「已無其他非取消子訂單」時才標取消（courses.js:842-860 的 CASE WHEN NOT EXISTS）。**但原文的 UI 敘述要更正**：合併卡片的「取消訂單」不會只取消一筆——MyCoursesPage.jsx:171-176 `if (cp.is_checkout_aggregate && cp.checkout_id) { await checkoutApi.cancel(...) } else if (cp.is_checkout_aggregate && sub_order_ids.length) { await Promise.all(sub_order_ids.map((id) => coursesApi.cancelPending(id))) }`，兩條都是全取消。只取消一筆的入口是**報名狀態頁**（EnrollStatusPage.jsx:148 `await coursesApi.cancelPending(id)`），而該頁目前的活入口正是「退回補件」的 LINE 連結（admin/enrollments.js:1839 `/enroll-status/${notify.enrollmentId}`）。

**73. 同一張付款單的付款資料，家長端兩個入口的門檻不同：報名狀態頁入口不擋團報單、也不看團報流程狀態（只認手機＋子訂單狀態），團報專用入口要求必須是該團成員、只在揪團中／已送審開放、且櫃檯確認帳款後鎖死。**

- 誰能做：家長自己
- 依據：server/routes/courses.js:729-739（只檢查 parent_phone／extra_parent_phones、status='pending_payment'、payment_method≠on_site，全段無 group_order_id 檢查；對照同檔 :826-828 cancel 有擋團報）；server/routes/groupOrders.js:935-937 `if (!['forming','submitted'].includes(order.status)) ... code: 'NOT_UPLOADABLE'`；同檔 :939-968 `WHERE group_order_id = $1 AND parent_id = $2 ... if (member.payment_confirmed) ... code: 'ALREADY_CONFIRMED'`
- 註：不一致成立，但**繞道機制要更正**：原文說可以繞過「櫃檯已確認帳款不可改」——不可達。payment_confirmed 只在櫃檯對帳付款單時變 TRUE，而同一筆交易也把該家庭的子訂單轉成 confirmed（admin/checkouts.js:300 與 :325 同一交易），此時報名狀態頁入口會先撞 NOT_PENDING（courses.js:733）。真正可達的缺口有三個：①團報**核准後**團報入口整個關閉（status='approved' → NOT_UPLOADABLE），報名狀態頁入口卻仍開著；②身分判準不同——報名狀態頁接受額外家長手機，團報入口只認成員 parent_id；③從報名狀態頁寫進去的值只落在 admin_enrollments／checkout_sessions，**不會回寫 group_order_members**，團購狀態頁因此仍顯示未上傳（shapeMember 只讀成員列，groupOrders.js:227-232）。

**74. 建立付款單只認訂單上的主要家長手機，但檢視／上傳／取消付款單認主要手機、額外家長手機或付款單登記的家長本人。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:116-128 `WHERE enrollment_batch_id = $1 AND parent_phone = $2 AND status = 'pending_payment'` → `code: 'NO_OWN_SUB_ORDERS'`；同檔 :27-30 `if (checkout.parent_id && checkout.parent_id === parent.id) return true; ... o.parent_phone === phone || (o.extra_parent_phones || []).includes(phone)`
- 註：成立。家長端自建訂單不寫 extra_parent_phones（enrollments.js:567-571 欄位清單確認沒有這一欄），所以只有櫃檯手動建檔登記過配偶的單會踩到：配偶進得去既有付款單，卻無法在「尚未產生付款單」時按「上傳付款資料」去補建（MyCoursesPage.jsx:132 呼叫的就是 checkout route）。

**75. 課期到期日只擋簽到、不擋預約：自助簽到會檢查課期是否已過期並回「此課程期已到期」，家長預約時段完全不檢查到期日。**

- 誰能做：家長自己
- 依據：server/routes/checkins.js:66 `(cp.expires_at >= (NOW() AT TIME ZONE 'Asia/Taipei')::date) AS not_expired` ＋ :88-90 `if (!period.not_expired) ... code: 'PERIOD_EXPIRED'`；server/routes/slots.js:288-291 `SELECT id, coach_id, venue_id, course_type, status, total_sessions FROM course_periods WHERE id = $1 FOR UPDATE`
- 註：成立且已用 grep 覆核：`expires_at` 在 server/routes/slots.js 與 server/services/slots.js 完全不出現。可選時段查詢（slots.js:225）與預約（:309）都只看 status='active'。後果如敘述：已到期課期仍可預約未來時段並佔用教練時段，現場才簽不進去；試上 30 天到期最容易踩到。

**76. 退費金額 API 已回傳給家長端，但家長端畫面完全沒有顯示退款金額的地方，而且已退費的課程不會出現在「我的課程」任何分頁。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:294 `refund_amount: row.refund_amount != null ? Number(row.refund_amount) : null,`；client/liff/src/pages/MyCoursesPage.jsx:25 `// 'closed'（取消/退費）不出現在任何分頁。`（grep 確認 client/liff/src 全樹零個 refund_amount／refundAmount 引用）
- 註：成立。補一點入口事實：報名狀態頁的「已退費」徽章在 EnrollStatusPage.jsx:20 `refunded: { label: '已退費', ... }`，該頁路由 /enroll-status/:id（App.jsx:131）目前唯一的活連結是「退回補件」的 LINE 訊息（admin/enrollments.js:1839）——而退費**不發任何通知或連結**，所以退費後家長確實只能靠舊連結或問櫃檯。

**77. 對帳成功的通知走 Email（決策是「家長不用 LINE」），但退回補件、團報有人加入、團報送審這三件事仍然推 LINE 給家長。**

- 誰能做：系統自動
- 依據：server/routes/admin/checkouts.js:454 `// 家長端改走 Email（Owner 決定：家長不用 LINE）。`；server/routes/admin/enrollments.js:1837-1840 `if (notify && notify.uid) { const line = require('../../services/line'); ... line.pushMessage(notify.uid, line.templates.returnedForFix({`；server/services/groupOrderSubmit.js:129-131 `await line.pushMessage(row.line_uid, line.templates.groupSubmitted({`
- 註：成立，且推 LINE 給家長的事件比原文多一件：**團報退回補件**也推給全體成員（admin/groupOrders.js:691-698 `line.templates.returnedForFix(...)` 迴圈 push）。團報有人加入在 groupOrders.js:885-890。對帳信查不到 Email 只留 skipped、不改走 LINE：reconcileNotify.js:184-187 `// ...實測有 7.5% 的已對帳訂單用電話查不到 parent。const status = email ? 'pending' : 'skipped';`，行號與數字都對。

**78. 一般報名的最低學員數只有前端在把關：畫面要求一對 N 必須剛好湊滿 N 位，後端只檢查不超過上限、不檢查下限。**

- 誰能做：家長自己
- 依據：client/liff/src/pages/EnrollmentPage.jsx:90-94 `// 1對N 須剛好湊滿 N 位（min=max=courseType）...const minStudents = isTrial ? 1 : courseType;`（送出鈕條件 :127-133 `totalSelected >= minStudents`）；server/routes/enrollments.js:340-355（只有 `if (studentCount < 1)` 與 `studentCount > maxStudents` 兩道）
- 註：成立。直打 API 可以用 1 位學員買一對三，價格按 1 位算（:403 `original = unitPrice * studentCount * periodCount`），而且對帳時會因 sib.rowCount === 1 走單人 period 分支（admin/enrollments.js:315），開出一個只有 1 人的一對三課期。

**79. 「課期效期＝365 天 × 期數」、「總堂數＝每期堂數 × 期數」這兩條公式在現行三個建單入口下永遠只乘 1，因為三個入口都把每筆子訂單的期數寫成 1。**

- 誰能做：系統自動
- 依據：server/routes/admin/enrollments.js:408 `: String(365 * (Number(enrollment.period_count) || 1));`；server/routes/enrollments.js:572 `VALUES ($1,...,'pending_payment',$13,1,$14,$15,$16,$17,$18,$19,$20,0)`（第 15 欄 period_count 為常數 1）；server/routes/admin/groupOrders.js:516 `VALUES (...,'pending_payment',NOW(),$13,TRUE,1,$14,$15,$16,$17)`；server/routes/admin/enrollments.js:819 `VALUES ($1,...,'pending_payment',$12,$13,0,1,$14,...)`
- 註：三處欄位對位我逐欄數過，period_count 都是字面常數 1（家長 LIFF 的欄位清單在 enrollments.js:567-571、櫃檯建檔在 admin/enrollments.js:812-817、團報核准在 admin/groupOrders.js:513-515）。所以買 4 期＝4 筆各 1 期、各自 6 堂、各自 365 天。replit.md:262 對團報寫的 `total_sessions = 每期堂數 × 期數、expires_at = 365 × 期數` 與拆單後的實際行為不符，屬過期文件。

**80. 家長手冊寫推薦朋友可拿 9 折券、朋友報名可用 TRIAL50 體驗課 5 折，前端已停用並主動清掉瀏覽器殘留的券碼，但後端仍保留完整的 TRIAL50 驗證與兌換邏輯。**
- 依據：docs/manuals/parent.md:82 `給朋友：報名時可用 `TRIAL50` 體驗課 5 折。`；client/liff/src/pages/EnrollmentPage.jsx:47-50 `// 推薦折扣（TRIAL50）已停用（2026-07 全站優惠清除）：不再自動套用 pendingCoupon，並主動清掉既有使用者瀏覽器內殘留的 daos.pendingCoupon ... localStorage.removeItem('daos.pendingCoupon')`；server/routes/enrollments.js:412-430（TRIAL50 專屬 referral 驗證，FOR UPDATE 序列化）＋ :596-607 `const paid = await referrals.markTrialPaid(...)`
- 註：kind 保留 inconsistent 是對的（手冊、前端、後端三方不一致）。原文那句「試上單根本不吃券，而 TRIAL50 的設計用途正是體驗課折扣」我特別覆核過順序：TRIAL_COUPON_NOT_SUPPORTED（:406-409）**先於** TRIAL50 檢查（:412），所以 TRIAL50 永遠只能用在一般報名單上。uncertain 的部分維持：未連資料庫，無法確認 promotions 表裡 TRIAL50 是否還存在；若已刪除，手動輸入會先撞 COUPON_INVALID（promotions.js:155-157），那段專屬邏輯即為死碼。

**81. 教練停用後，一般報名會被擋下來，團報卻照樣可以開團：一般報名要求教練存在且在職，團報發起只確認教練這筆資料存在、不看是否停用，而且完全不指定教練也可以開團。** 〔覆核時補上〕
- 依據：server/routes/enrollments.js:323-329 `SELECT name, pricing_multiplier FROM coaches WHERE id = $1 AND is_active = TRUE` → `'coach not found or inactive'`；server/routes/groupOrders.js:548-552 `if (coachId) { const cr = await client.query(`SELECT id, pricing_multiplier FROM coaches WHERE id = $1`, [coachId]); if (!cr.rowCount) ... '教練不存在' }`；同檔 :495 `const coachId = p.coach_id ? String(p.coach_id).trim() : null;`

**82. 「付款資料兩項都送出就不能再改」有一個例外：家長可以刪除已上傳的匯款證明，刪掉之後鎖定就解除、可以重新上傳（末 5 碼沒有對應的清除功能）。這個能力只存在於 API，LIFF 畫面沒有任何刪除入口。** 〔覆核時補上〕
- 依據：server/services/paymentProof.js:26 `const clear = input.delete_payment_proof === true || input.payment_proof_action === 'delete';`；server/routes/checkout.js:279-280 `if (locked.rows[0].transfer_last_5 && locked.rows[0].payment_proof_url && !proofInput.clear && !(sameProof && sameLast5))`（同一旁路在 courses.js:750-751、groupOrders.js:974）；三個家長端入口都開 allowClear：checkout.js:271、courses.js:741、groupOrders.js:909

**83. 「我的課程」清單與付款單頁認人的方式不同：清單只認手機（訂單上的主要家長手機或被登記的額外家長手機），付款單頁另外接受「這張付款單登記的家長本人」。** 〔覆核時補上〕
- 依據：server/routes/courses.js:222 `WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)`（單筆報名狀態頁同樣只認手機，同檔 :617）；server/routes/checkout.js:27 `if (checkout.parent_id && checkout.parent_id === parent.id) return true;`

**84. 團報成員填的付款資料只寫在成員列上，團購狀態頁也只讀成員列；若同一個人改從報名狀態頁或付款單頁送出，值不會回寫成員列，團購狀態頁會一直顯示「未上傳」。** 〔覆核時補上〕
- 依據：server/routes/groupOrders.js:227-232 `transfer_last_5: isSelf ? (m.transfer_last_5 || '') : '', carrier: ..., has_payment_proof: !!m.payment_proof_url, has_payment_info: !!(m.payment_proof_url && String(m.transfer_last_5 || '').trim())`（全部讀 group_order_members）；server/routes/courses.js:769-790（只寫 admin_enrollments 與 checkout_sessions）


### 2.7 家長端通知（16 條）

**85. 上課提醒、到期提醒、MGM 體驗課提醒、期末評鑑邀請與提醒、課前規劃發布、授課記錄發布、課程轉讓、報名／團購退回補件、MGM 獎勵發放——這九類家長通知全部共用同一個事件開關 legacy，不能分開開關。開了 legacy 就是這九類一起開。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：server/services/line.js:85 `const event = opts.event || 'legacy';`；呼叫端只傳三個參數，如 cron/index.js:178 `await line.pushMessage(t.uid, msg, s.venue_id);`、learn.js:196、learn.js:220、transfers.js:54、admin/transfers.js:59、admin/enrollments.js:1840、admin/groupOrders.js:698、referrals.js:203、cron/index.js:225、:269、:322、:339
- 註：無誤。我把全庫 pushMessage 呼叫點列了一遍：共 22 處，其中只有 4 處帶事件代號（checkinNotify.js:149 教練／:179 家長、groupOrderSubmit.js:129、groupOrders.js:885），其餘 18 處全落入 legacy。

**86. 沒有帶業務主鍵的通知完全不去重——只會留紀錄，不會擋重複。任何重試、人工重按、cron 重跑都會讓家長再收到一次。目前家長端只有簽到、團報送審、團購加入這三類帶了業務主鍵。**

- 誰能做：系統自動
- 依據：server/services/pushGate.js:82 註解 `refId 為空時不做去重（仍會記錄），因為沒有業務主鍵可比。`；coreSchema.js:1791-1792 `-- 推播發送紀錄（含被安全閥擋下與失敗的）。notification_log 只記成功、只有 4 種 kind、而且只有 3 個 cron 呼叫點在用；route 層 13 個呼叫點完全不寫，重送就是重複推播。`
- 註：敘述正確，行號修正：那句註解在 pushGate.js:82（原寫 83）。實例也對上：admin/groupOrders.js:697-699 `for (const uid of notify.uids) { line.pushMessage(uid, msg, notify.venueId)` 全團推播、無 refId。

**87. 家長手冊寫「沒收到 LINE 推播 → 確認你已加場館官方帳號為好友且未封鎖」，但實際上所有推播都是從內部帳號 dreams400 發出的，加場館官方帳號好友不會讓家長收到任何通知。**
- 依據：docs/manuals/parent.md:94 `| 沒收到 LINE 推播 | 確認你已加場館官方帳號為好友且未封鎖 |`；對照 server/services/lineRouting.js:112-114（一律回 STAFF_CHANNEL）
- 註：無誤。lineRouting.js:18-24 記載了原因：LIFF 掛在 Login channel 2009958451（provider oshuoshuo），dreams400 同 provider 所以 uid 有效；四館 OA 屬舊系統 dream-dream 的 provider，同一組 uid 實測 0/60。

**88. 後台設定頁上的狀態判讀只看得到「家長簽到→通知教練」這一個事件。即使資料庫裡已經把家長端事件打開了，畫面仍會顯示「總開關已開，但沒有啟用任何事件 —— 仍然不會送出」。**
- 依據：client/admin/src/pages/SettingsPage.jsx:44 `const PUSH_EVENT_KEYS = PUSH_TOGGLES.filter((f) => f.key.startsWith('push_event_')).map((f) => f.key);`（PUSH_TOGGLES 於 :30-37 只含 push_enabled / push_dry_run / push_event_checkin_confirmed_coach）；SettingsPage.jsx:93-95 `const anyEvent = PUSH_EVENT_KEYS.some((k) => draft[k] === '1');` → `if (!anyEvent) return { ... text: '總開關已開，但沒有啟用任何事件 —— 仍然不會送出' };`
- 註：無誤。反向誤判也成立（畫面說不會送，實際家長在收）。

**89. 櫃檯在後台幫家長補簽到（後台「補簽到」與「手動扣課」兩支）不會發任何通知給家長，也不會通知教練。家長手冊寫的簽到流程正是這一條。**

- 誰能做：櫃檯（但不會產生通知）
- 依據：server/routes/admin/sessions.js:625-632 補簽到 `INSERT INTO checkin_records (course_session_id, student_id, checked_in_by_student_id, checked_in_source, checked_in_at) SELECT $1, cpe.student_id, cpe.student_id, 'staff', $2 ...` 之後沒有任何 notify 呼叫；server/routes/admin/manualDeductions.js:427-428 `// ── 2026-08-17：手動扣課不再發推播（owner 決定，選項 B）── // 原本這裡呼叫 notifyCheckinSafely(...)`；對照 docs/manuals/parent.md:63 `- 上課當天到場館 → 跟櫃檯說手機號碼 → 櫃檯在後台幫你完成簽到。`
- 註：無誤，而且我獨立驗過「零呼叫端」：全庫 grep notifyCheckin 只有 routes/checkins.js:281 與 :432 兩個呼叫點，兩支都掛 requireParent（checkins.js:45 `router.post('/self', requireParent, ...)`、:322 `router.post('/', requireParent, ...)`），admin/sessions.js 連 require 都沒有。checkinNotify.js:4 自稱「兩條簽到路徑（家長自助 / 櫃台補登）共用這裡」，與實際不符。

**90. cron 提醒只在「推播丟出例外」時才把發送權釋放、下次重試。被安全閥擋下來（總開關關、事件沒開、演練模式、撞每小時上限、當月額度用盡）不算例外——發送權會被永久燒掉，那一則之後即使閘門打開也永遠不會補送。**

- 誰能做：系統自動
- 依據：server/cron/index.js:177-183 `try { await line.pushMessage(t.uid, msg, s.venue_id); } catch (e) { console.warn(...); // push 失敗 → 釋放 claim 讓下次重試 await pool.query('DELETE FROM notification_log WHERE id = $1', [claim.rows[0].id])`；對照 line.js:96 `return { sent: false, reason: d.reason };`（被擋是回傳值，不是例外）
- 註：無誤。三支的行號：cron:177-183（上課提醒）、:225-229（到期提醒）、:269-273（MGM）。期末評鑑那一支更嚴重的部分也確認：cron:338-340 `try { await line.pushMessage(uid, msg, r.venue_id); await evaluations.markReminderSent(r.id); }` —— 被擋下來不會 throw，所以 markReminderSent 照樣執行，而 evaluations.js:106 的查詢條件是 `AND ce.reminder_sent_at IS NULL`，標了就再也撈不到。

**91. MGM 體驗課當日提醒：每天 09:30 跑，推給「推薦方」家長（不是被推薦的新客戶）。條件是推薦紀錄狀態為體驗課已付款、推薦人有綁 LINE，且該課期今天有課。單輪最多處理 100 筆。**

- 誰能做：系統自動
- 依據：server/cron/index.js:239 `scheduleTaipei('30 9 * * *', ...)`；:242-255 `SELECT rr.id, rr.referrer_parent_id, rp.line_uid AS referrer_uid ... WHERE rr.status = 'trial_paid' AND rp.line_uid IS NOT NULL AND EXISTS (SELECT 1 FROM course_sessions cs2 WHERE cs2.course_period_id = cp.id AND cs2.scheduled_at::date = CURRENT_DATE) LIMIT 100`；:269 `await line.pushMessage(row.referrer_uid, msg, row.venue_id || 'B');`
- 註：無誤。docs/flex_messages.md:27 第 18 項寫「接收對象：被推薦新客戶」，程式推的是推薦方；cron:238 的註解也是推薦方視角。`row.venue_id || 'B'` 硬寫死新北代號一事確認。要補一點：那個「今天有課」判斷的課期是怎麼找出來的有問題，見 added 第 5 條。

**92. 對帳信有「補寄」機制：撿出還卡在待寄狀態、建立超過 5 分鐘的信重新寄出（預設一次 20 封）。但這支函式目前沒有接上任何排程，也沒有任何後台入口在呼叫它——實際上沒有人會去撿那些卡住的信。**

- 誰能做：沒有人（函式存在但無入口）
- 依據：server/services/reconcileNotify.js:260-263 `/** * 補寄：撿出還卡在 pending 的（進程在寄信前掛掉、或當時 SMTP 暫時不通）。 * 可接到 cron，也可以人工呼叫。 */`；:264 `async function sweepPendingMail({ limit = 20, olderThanMinutes = 5 } = {})`——全庫（server/，排除 node_modules）只有這裡的定義、:284 的匯出，以及 admin/checkouts.js:456 的一句註解提到它，零實際呼叫端
- 註：無誤，我獨立跑過 grep 確認零呼叫。健康檢查看得到卡住的信（server/index.js:131-139 回 mail_outbox 過去 24 小時各狀態筆數），只是沒東西去處理。

**93. 家長端 PII 在推播裡的處理不一致：團購加入通知會把加入者的家長姓名遮罩成「王X明」，但課程轉讓通知把轉出方家長的完整姓名直接推給轉入方（兩個是不同家庭的陌生人）。**

- 誰能做：家長自己（觸發者）
- 依據：server/routes/groupOrders.js:886 `memberName: maskName(me?.parent_name || ''),`（規則見 server/utils/piiMask.js:24-30）；對照 server/routes/transfers.js:51 `fromParentName: m.from_name,`（未遮罩，來源 :43 `JOIN parents fp ON fp.id = $1`）
- 註：無誤。同一支 groupOrders.js 對回傳前端的團員清單也遮罩（:217-218、:1094），可見遮罩是該模組既有約定。

**94. 聊天室關鍵字警示推給主管時，訊息上標著「家長：」的那一欄，實際填進去的是家長發言內容的前 60 個字，不是家長姓名；教練欄一律是「—」。也就是家長的聊天內容會原文出現在主管的 LINE 上。**

- 誰能做：系統自動（家長／教練在聊天室發言觸發）
- 依據：server/services/line.js:694-700 `async function pushKeywordAlert(lineUserId, { venueId, keyword, chatRoomId, snippet }) { ... const messages = keywordAlert({ coachName: '—', parentName: snippet ? \`「${snippet}…」\` : '—', keyword, chatUrl });`；模板該欄版面在 line.js:470 `{ type: 'text', text: \`家長：${parentName}\`, size: 'sm' }`；內容來源 server/routes/_chatNotify.js:78 `snippet: (message?.content || '').slice(0, 60),`
- 註：敘述正確，行號修正：模板那一欄是 line.js:470（原寫 471）。收件人規則確認：_chatNotify.js:29-33 註解與 :43-46 `role = 'admin' OR (role = 'manager' AND venue_id = $1)`，staff 不收。docs/flex_messages.md:25 第 16 項只寫「場館主管」，沒提 admin 跨館全收。

**95. 發送紀錄裡的「場館」欄在不同入口記的不是同一種東西：有帶事件代號的四類通知記的是推播管道名稱（dreams400），其餘（cron、learn、轉讓、退回補件等）記的是真正的場館代號。**

- 誰能做：系統自動
- 依據：server/services/checkinNotify.js:188 第三個參數傳 `ch`（來自 :182 `resolveChannel({ kind: 'parent', venueId: r.parent_venue_id })`，值為 'dreams400'）；groupOrderSubmit.js:137、groupOrders.js:889、enrollmentNotify.js:136 同樣傳 channel；對照 cron/index.js:178 `await line.pushMessage(t.uid, msg, s.venue_id);`（傳真場館）
- 註：無誤。line.js:78-83 已把參數改名 venueIdForLog 並註明自 2026-08-12 起只寫紀錄、不決定送到哪裡，所以不影響送達，只影響「這則是哪一館的」這個查詢的可信度。

**96. 對帳信是家長唯一的 Email 通知，也是唯一不依賴 LINE 的通知。全系統只有一個寄信呼叫點、只有一種信件類型；其餘所有家長通知（簽到、上課提醒、到期提醒、退回補件、轉讓、評鑑邀請、團購相關、MGM 獎勵）一律只走 LINE。結論：沒綁 LINE 的家長，除了對帳成功那一封信，什麼通知都收不到，而且系統不會因此留下任何「這位家長沒被通知」的痕跡（NO_RECIPIENT_UID 只有在 SQL 沒先把他過濾掉時才寫得出來——四支提醒的 SQL 都先用 p.line_uid IS NOT NULL 濾掉了）。** 〔覆核時補上〕
- 依據：server/services/reconcileNotify.js:85 `const KIND = 'reconcile_success';`（mail_outbox 唯一 kind）；全庫 grep `mailer.sendMail` 只有 reconcileNotify.js:231 一處；對照 cron/index.js:156、:209 與 learn.js:186、:207 的 `AND p.line_uid IS NOT NULL`（在 SQL 就排除，不會進 pushGate 留紀錄）

**97. 「用手機號碼找家長」在系統裡有三套判準，不是兩套。（1）對帳信：正規化成純數字比對，且要求帳號有效、Email 非空，多筆取最近更新。（2）轉讓與退回補件推播：精確字串比對，不檢查帳號是否有效。（3）簽到、上課提醒、到期提醒、課前規劃、授課記錄、評鑑邀請：完全不用手機，走學員的家長外鍵（students.parent_id）。同一位家長在不同通知裡是用三種不同方式被認出來的，所以「A 通知收到了、B 通知沒收到」是可能的常態，而不是異常。** 〔覆核時補上〕
- 依據：（1）server/services/reconcileNotify.js:136-142 `regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = $1 AND is_active = TRUE`；（2）server/routes/transfers.js:39 `SELECT line_uid FROM parents WHERE phone = $1` 與 server/routes/admin/enrollments.js:1820 `WHERE phone = $1 AND line_uid IS NOT NULL LIMIT 1`；（3）server/services/checkinNotify.js:70 `LEFT JOIN parents p ON p.id = s.parent_id` 與 cron/index.js:154-155 `JOIN students st ON st.id = cpe.student_id JOIN parents p ON p.id = st.parent_id`

**98. 維運人員跑一次樣板煙霧測試，會吃掉家長推播當小時的配額。煙霧測試把每一則都以「已送出」寫進發送紀錄，而閘門的每小時上限算的是「全站已送出的總筆數、不分事件」——19 個模板的一輪測試就佔掉預設 50 則裡的 19 則。相對地 IT 告警完全不寫發送紀錄，所以不佔每小時配額，但一樣吃當月的 3,000 則額度。也就是說這兩條繞過閘門的路徑，對家長通知的干擾方式剛好相反。** 〔覆核時補上〕
- 依據：server/scripts/pushTemplateSmoke.js:116 `if (r.status >= 200 && r.status < 300) { status = 'sent'; ...}` → :125-128 `INSERT INTO line_push_log (...) VALUES ('template_smoke',$1,$2,'test',$3,$4,...)`；對照 server/services/pushGate.js:66-67 `SELECT COUNT(*)::int n FROM line_push_log WHERE status = 'sent' AND at >= NOW() - INTERVAL '1 hour'`（無 event 條件）；server/services/itAlert.js 全檔 grep line_push_log 零命中

**99. 期末評鑑邀請的收件人判準比其他提醒鬆一道：建立邀請時只看學員是否在籍，不要求家長有綁 LINE。沒綁 LINE 的家長照樣會被建立一筆邀請紀錄，然後在推播那一步被靜靜跳過。結果是評鑑表會累積一批「已邀請、永遠沒被通知、也永遠不會被填」的列，而且這些列不會被 7 天提醒撈出來補救（因為它們同樣沒有 uid，一撈到就直接標記為已提醒）。** 〔覆核時補上〕
- 依據：server/services/evaluations.js:29-31 `ARRAY(SELECT DISTINCT s.parent_id FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active') AS parent_ids`（無 line_uid 條件）；server/cron/index.js:317 `if (!uid) continue;`；對照 cron/index.js:156 其他提醒在 SQL 就 `AND p.line_uid IS NOT NULL`；放棄機制 cron/index.js:333 `if (!uid) { await evaluations.markReminderSent(r.id); continue; }`

**100. MGM 體驗課當日提醒的「今天有課」是用錯的課期判斷的。程式不是找被推薦人自己那一期，而是用「同一位教練 + 同一個場館」去撈課期——只要該教練在該館的任何一個課期今天有課，提醒就會發出去。同一教練在同一館開多期（常態）時，推薦方會在不是體驗課的日子收到「今天體驗課」的提醒。** 〔覆核時補上〕
- 依據：server/cron/index.js:249-250 `LEFT JOIN admin_enrollments ae ON ae.id = rr.experience_enrollment_id LEFT JOIN course_periods cp ON cp.coach_id = rr.coach_id AND cp.venue_id = ae.venue_id`；:251-255 `AND EXISTS (SELECT 1 FROM course_sessions cs2 WHERE cs2.course_period_id = cp.id AND cs2.scheduled_at::date = CURRENT_DATE)`（cp 是上面那個寬鬆 join 的結果，不是 rr.experience_enrollment_id 對應的課期）


### 2.8 Ragic 同步（家長側）（11 條）

**101. 軟刪除的家長／學員會不會因為 Ragic 同步復活，兩條路完全相反：家長登入／綁定／開場刷新那條（parentSync）只有「刻意登入／綁定」才允許重新啟用，背景刷新一律保留既有狀態；而每晚 02:30 的 Ragic 拉回走的是另一支 canonical import，那裡把家長與學員的 is_active **無條件設成 TRUE**——櫃檯停用的人只要 Ragic 上還在，當晚就會被重新啟用。**

- 誰能做：家長自己（登入／綁定時）；以及系統自動（每晚 02:30 拉回，或後台手動觸發 pull）
- 依據：有保護：server/services/parentSync.js:300 `is_active=CASE WHEN $14::boolean THEN TRUE ELSE is_active END,`（$14 = reactivate）＋ 學員端 parentSync.js:420 `is_active = CASE WHEN is_active = FALSE THEN is_active ELSE TRUE END,`；呼叫端 server/routes/parents.js:467 `reactivate: false,`。沒保護：server/services/ragicAdmin.js:2855 `is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()`（家長）與 ragicAdmin.js:2925 `is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()`（學員），整段 _syncCanonicalZ01Record 沒有任何 reactivate 參數。
- 註：原清單第 42 條把這條標成 implemented「背景排程不行」——只對 parentSync 那條路成立。更糟的是 cron 的註解明寫 `reactivate:false（不復活本地已軟刪的家長）`（server/cron/index.js:467），但 02:30 實際呼叫的 pullParentsStudentsFromRagic → _reconcileZ01FromShadowImpl → _syncCanonicalZ01Record 根本沒走 parentSync。業務後果具體：櫃檯停用的學員在家長端會消失（parents.js:106 只列 is_active），隔天又出現；而家長想自己重新加回來時會被擋在 409 STUDENT_INACTIVE_CONTACT_COUNTER（parents.js:631-636）。**此條未實跑驗證，是讀兩支 SQL 比對推得。**

**102. 同一份 Z01 資料，寫回 Ragic 的規則在兩條路上是相反的：註冊／認領路線走「白名單七欄 + 只填空白（聯絡欄位須本人驗證才可覆蓋）」；而家長改個資、櫃檯改檔、每日備份走的 writeback 路線，是把姓名、館別、電話、身分、性別、Email、住家電話、LINE ID、住家地址整組九個欄位無條件送上去覆蓋，另外還被強制補上第十欄 LINE UID。結果是：同一位家長，用註冊流程碰不到的欄位，改個資按一下就整組蓋掉 Ragic 上的值。**

- 誰能做：家長自己（PATCH /me）、櫃檯（後台編輯）、系統（每日備份）都走覆蓋那一條
- 依據：入口A（只填空白）server/services/parentRegistrationProfile.js:42 `if (oldText && !(contact && ownershipVerified)) return null;`；入口B（整筆覆蓋）server/services/ragicWriteback.js:54-64 `const payload = { [ragic.FIELD.Z01.PARENT_NAME]: row.name || '', [ragic.FIELD.Z01.VENUE]: venueName || …, [ragic.FIELD.Z01.PHONE]: row.phone || '', [IDENTITY], [GENDER], [EMAIL], [HOME_PHONE], [LINE_ID], [HOME_ADDRESS] };` 後接 ragicWriteback.js:65 `await ragic.syncParentProfileStrict(row, payload)`；強制補第十欄 server/services/ragic.js:1214-1217 `payloadByFieldId = { ...payloadByFieldId, [FIELD.Z01.LINE_UID]: lineUid };`；每日備份用同一份 payload：server/services/ragicAdmin.js:2216-2227
- 註：原清單這一條成立，再補三點：(1) 覆蓋路線送的是 `row.name || ''` 這種空字串，Ragic 端必填欄收到空值會整筆 INVALID，所以本地缺值時是「整筆失敗」而不是「蓋成空」；(2) 覆蓋路線還是會擋「Ragic 上是別人的 UID」（ragic.js:1227、1233 呼叫 _assertNoZ01LineUidConflict）；(3) 覆蓋路線內建自我修復：本地 ragic_record_id 在 Ragic 查無時會用手機重查，查不到就**在 Ragic 直接新建一筆 Z01**（ragic.js:1230-1231 → resolveParentRagicRecord → ragic.js:1172 `return await createParentRagicRecord(parent);`）。要對帳「Ragic 上的資料被誰改的」時，這兩條路必須分開看。

**103. 同一件事「家長在 App 上改自己家的資料」，個資與學員走的是相反的方向：改個資是本地先寫、Ragic 失敗也存得進去（回 sync_status='pending'）；新增／編輯學員卻是先同步寫進 Ragic，Ragic 失敗就整個動作失敗（回 502／504「資料暫時無法完成同步」），家長根本存不了。**

- 誰能做：家長自己（同一個個資頁上的兩個動作，成功條件不同）
- 依據：個資（本地先寫）server/routes/parents.js:551 `last_synced_at = NULL, updated_at = NOW()` + parents.js:570 `ragicWriteback.scheduleWriteback({ … })`；學員（Ragic 先寫）server/routes/parents.js:648 `sync = await ragic.createStudentZ01Z02Strict({ parent: parentForSync, student: s, startIndex: activeCount });` 與 parents.js:714 `const sync = await ragic.updateStudentZ01Z02Strict({ parent: parentForSync, student: syncStudent });`，失敗統一走 parents.js:146-173 `ragicError()` 回 502/504
- 註：櫃檯後台改學員（customerStudents.js:220）與團購加入建學員（groupOrders.js:202）都走「本地先寫」那一邊，所以同一位學員的資料由誰動，會決定 Ragic 失敗時擋不擋得住。另外學員寫入前還有一道：家長本人 Z01 資料不完整時會先去 Ragic 補查，補不到就回 Z01_INCOMPLETE 擋住（parents.js:183-190、605）。

**104. 「本地還沒回寫的編輯不能被 Ragic 舊值蓋掉」這道保護只存在於 parentSync 這條路（登入／綁定／開場刷新）。每晚 02:30 拉回時對「已綁 UID」的家長走的是另一支 canonical import，那裡沒有這個保護：電話直接覆蓋、家長姓名只要 Ragic 有值就覆蓋、學員姓名無條件覆蓋。**

- 誰能做：系統自動（每晚 02:30，或後台手動觸發 pull）
- 依據：有保護：server/services/parentSync.js:290 `name=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN name ELSE COALESCE(NULLIF($2,''),name) END,`（$13 = preservePending，同款保護套在 venue/gender/email/identity/home_phone/home_address/line_id 與學員的 parentSync.js:413-417）；沒保護：server/services/ragicAdmin.js:2844-2845 `phone = $2, name = COALESCE(NULLIF($3,''), name),` 與 ragicAdmin.js:2919 `name = $2,`（學員），整段 _syncCanonicalZ01Record 沒有任何 last_synced_at 判斷
- 註：排程鏈「推在拉之前」只縮小窗口、不移除；而 00:30 那支若因資料問題把該列隔離掉，該列就永遠處在「本地新、Ragic 舊」的狀態等著被蓋。這支 import 同時還無條件蓋 last_synced_at = NOW()（ragicAdmin.js:2855），等於把「這列還沒推上去」的旗子也一起清掉——下一輪備份不會再撈它。

**105. Ragic webhook 更新本地快照時沒有要求以數字欄位 ID 回傳（沒帶 naming='EID'），而全量拉回是帶的。家長 LINE UID 的讀取刻意只認數字欄位 1006846、不吃中文欄名，所以由 webhook 寫進快照的那一筆，讀起來會像「這位家長沒綁 LINE」。**

- 誰能做：Ragic（發 webhook 觸發）；系統自動
- 依據：webhook 側（沒帶 EID）server/services/ragicAdmin.js:4796-4798 `const record = await ragic.getRecordByRagicId(formPath, id, { ignoreFixedFilter: … }, { noCache: true });`（getRecordByRagicId 只把 params 原樣傳下去：server/services/ragic.js:387-393）；拉回側（帶 EID）ragicAdmin.js:2609 `const params = { naming: 'EID', order: '109,ASC' };`；讀取端無中文 fallback：server/config/ragicSchema.js:71-73
- 註：影響範圍的推論我重新驗過並成立：cron 的夜間拉回是全量，會先把整批 shadow 標 present_in_latest_pull=FALSE 再用 EID 覆蓋（ragicAdmin.js:2664-2669），正常情況會修正；真正會咬到的是「後台手動觸發 pull」——那條才是增量（ragicAdmin.js:3475 `const useIncremental = triggeredBy === 'manual' && !!watermark;`，且 2664 的重置被 `if (!useIncremental)` 跳過）。認領流程也直接讀 `shadow['1006846']` 當「這筆是否已綁別人」的判準（z03IdentityClaim.js:592、848），並且用它決定 skip_uid_write（z03IdentityClaim.js:692、1054），同樣受影響。**此條未實跑驗證，是兩側程式碼比對推得。**

**106. Z03 記錄的 LINE UID 欄位（line_uid_raw）在程式裡永遠是空字串——拉回時固定寫空值，讀出來也固定回空值。因此後台「Z03 升級成 Z01」時那段「若本地 Z03 已有 LINE UID，一併回寫 Ragic」的邏輯永遠不會執行，同一支函式回傳的 upgraded 也永遠是 false、事後的鏡像刷新永遠不跑。**

- 誰能做：後台使用者觸發升級；但 UID 回寫那段沒有人能觸發到
- 依據：寫入端固定空值：server/services/ragicAdmin.js:2509 `'', studentCountRaw, initialStatus, phoneCanonical, sourceUpdated.iso,`（INSERT 的第 12 個參數即 line_uid_raw，見 2472 欄位清單）；讀出端固定空值：ragicAdmin.js:3554-3556 `// Staging display data is never an identity credential. Canonical UID is read only from raw Ragic field 1006846 before a source enters Z03.` / `line_uid: '',`；死分支：ragicAdmin.js:3961-3965 `const realUid = parent.line_uid && … ? parent.line_uid : ''; if (realUid) payload[ragic.FIELD.Z01.LINE_UID] = realUid;` 與 3973-3984 `let upgraded = false; if (parent.line_uid && !…startsWith('demo:')) { … refreshed = await parentRefresh.refreshParentMirrorFromRagic({…}); upgraded = true; }`
- 註：設計上說得通（Z03 是暫存區，不該當身分憑證），但 3957-3960 與 3973 兩段註解寫的行為與實際不符，看程式的人會以為升級時會順便補 UID。升級本身仍會寫 Ragic（姓名／館別／電話／身分／性別／Email 六欄，ragicAdmin.js:3948-3967）並逐位學員回寫（3969-3971），只是 UID 那一欄碰不到。UID 實際只由家長登入／認領流程經 outbox 回寫。

**107. 註冊命中舊資料時「補資料 → 回寫 Ragic → Z03 畢業」這條整合函式已被永久停用，第一行就丟 LOCAL_FIRST_CLAIM_REQUIRED。實際走的是 local-first 的 claim + outbox。**

- 誰能做：沒有人
- 依據：server/services/ragicAdmin.js:3823-3826 `async function completeZ03Registration({…}) { const disabled = new Error('Z03 認領必須使用 local-first claim + transactional outbox'); disabled.code = 'LOCAL_FIRST_CLAIM_REQUIRED'; throw disabled;`（其後 3827-3868 整段不可達）
- 註：函式上方的 JSDoc（ragicAdmin.js:3818-3821）仍描述舊行為「回寫 Ragic 使用既有 found→update helper」。實際入口是 server/services/z03IdentityClaim.js 的 claimZ03Identity / completeTrueUidRegistration。連帶：ragic.completeParentOnRegisterInRagic（ragic.js:1113）唯一的呼叫端就是這段不可達程式（ragicAdmin.js:3854），所以那支「只填空白 + 寫 UID」的 helper 現在也是死程式。

**108. outbox 的「寫前確認 + 寫後驗證（readback）」不是每一張工作都做，而是看排入時有沒有在工作內容裡要求。要求了才會寫前確認目標記錄還在、UID 沒被別人佔走，並在寫後驗證 UID 與白名單欄位真的落地；沒要求的就直接寫、不驗。新建家長（CREATE_Z01_PARENT）那條路的寫後驗證則是無條件的。**

- 誰能做：系統自動（由排入者決定要不要驗）
- 依據：開關：server/services/ragicSyncOutbox.js:524 `const shouldReadback = forceReadback || ref.verify_readback;`，寫前 525-538、寫後 564-573 `if (shouldReadback) { … _assertReadback({ row: after, targetRecordId, expectedPatch: profilePatch, expectedUid: parent.line_uid }); }`。夜間批次的預設是不強制：ragicSyncOutbox.js:490 `forceReadback = false,`（processRagicSyncOutbox → processClaimedRagicSyncOutboxJob 不傳）；單筆重放才預設強制：ragicSyncOutbox.js:652 `forceReadback = true,`。排入端：z03IdentityClaim.js:342 `verify_readback: true`、z03IdentityClaim.js:691 `verify_readback: true`、**z03IdentityClaim.js:1053 `verify_readback: registrationCompletion`**（z03IdentityClaim.js:436 `const registrationCompletion = Boolean(parentProfile || studentInput || allowStudentAppend);`）、**server/services/parentAccountRecovery.js:396 的 payload 只有 `{ recovery_request_id, canonical_parent_id }`，完全沒有 verify_readback**。CREATE 那條無條件驗：ragicSyncOutbox.js:622 `_assertReadback({ row: await reader(recordId), targetRecordId: recordId, expectedUid: parent.line_uid });`
- 註：原清單第 27 條把這條寫成「綁定／改綁類的工作在寫入前後各讀一次」，實際不是。兩個具體缺口：(1) 帳號恢復的 REBIND 工作在夜間批次下**完全不驗**，寫前不檢查 Ragic 上現在是誰的 UID 就直接覆蓋；(2) 純認領（家長沒帶個資、沒帶學員）排出來的 BIND 工作 verify_readback=false。這也意味著「快照過期 → 寫回時會被第二道門擋下」這個安全論述，只在有帶 verify_readback 的那些工作上成立。

**109. LINE UID 回到 Ragic 的路不只 outbox 一條。家長（或櫃檯）**編輯一位既有學員**時，系統會在寫學員之前先把這位家長的 LINE UID 直接寫進 Ragic Z01；而**新增**學員不會。另外所有走 writeback／每日備份的家長回寫也都被強制附上 UID。所以「outbox 開關關著，UID 就永遠回不到 Ragic」並不成立。** 〔覆核時補上〕
- 依據：編輯學員會寫 UID：server/services/ragic.js:1457-1462 `async function updateStudentZ01Z02Strict({ parent, student }) { … await upsertParentStrict({ [FIELD.Z01.LINE_UID]: lineUid }, ragicRecordId);`（Z03 那條同款：ragic.js:1496）。新增學員不會：createStudentZ01Z02Strict（ragic.js:1450-1455）只呼叫 syncParentStudentsStrict，該函式只讀 UID 做衝突比對（ragic.js:1062-1065），不寫。writeback／備份強制附 UID：ragic.js:1214-1217 `payloadByFieldId = { ...payloadByFieldId, [FIELD.Z01.LINE_UID]: lineUid };`。程式自己也承認有第二條路：server/config/ragicSchema.js:92 `有些人有 Ragic 編號，是靠另一條直接寫入的備援補上的；備援沒跑到就整筆漏 —— 所以症狀是「有時成功有時失敗」而不是全壞。`

**110. 「本地→Ragic」的回寫在本地那筆 ragic_record_id 已失效時會自我修復，最後一步是**直接在 Ragic 新建一筆 Z01 家長**（不經 outbox、不經任何查重以外的守門）。觸發者可以是家長按一下「儲存個資」，也可以是每日 00:30 的備份。** 〔覆核時補上〕
- 依據：server/services/ragic.js:1218-1234 `let ragicRecordId = parent?.ragic_record_id || null; if (ragicRecordId) { const existing = await getParentRecordByRagicId(ragicRecordId); if (!existing) { console.warn('[parent-sync] 本地 ragic_record_id 在 Ragic 查無，改以手機重新定位', …); ragicRecordId = null; } … } if (!ragicRecordId) { ragicRecordId = await resolveParentRagicRecord({ ...parent, ragic_record_id: null }); … }`；server/services/ragic.js:1166-1172 `const record = await getParentByPhone(phone); if (record?._ragicId) return record._ragicId; console.log('[student-sync] resolveParent: Ragic 查無此家長，將新建 Z01', …); return await createParentRagicRecord(parent);`；同樣的自我修復也用在學員（ragicWriteback.js:93-94 的註解就是在講這件事）

**111. 「這是測試帳號」在家長端與寫入層的認定不一致：家長端 /me 系列只認 line_uid 以 demo: 開頭，而 Ragic 寫入層、即時回寫與每日備份還會另外擋 DEMOTEST_ 開頭。結果是 DEMOTEST_ 帳號在家長端走的是「正式路徑」（會去打 Ragic 做嚴格刷新、學員編輯 Ragic 失敗會擋住家長），但真的要寫 Ragic 時又被擋掉。** 〔覆核時補上〕

- 誰能做：系統自動（依帳號類型），但兩層判準不同
- 依據：家長端只認 demo:：server/routes/parents.js:420-421 `return String(parentRow?.line_uid || tokenLineUid || '').startsWith('demo:');` 與 parents.js:462 `&& !String(p.line_uid).startsWith('demo:')`；寫入／備份兩者都擋：server/services/ragicWriteback.js:49 與 95 `startsWith('demo:') || …startsWith('DEMOTEST_')`、server/services/ragicAdmin.js:2305-2306 與 2342-2343 `NOT LIKE 'demo:%' AND … NOT LIKE 'DEMOTEST_%'`、server/services/ragic.js:775 `if (uid.startsWith('demo:') || uid.startsWith('DEMOTEST_')) return '';`、server/config/ragicSchema.js:63 同款


---

## 3. 各面向完整規則


### 3.1 身分與 LINE 綁定


#### 實作中（45 條）

**1. 家長只能用 LINE 登入。系統不接受「只輸入手機號碼」或「手機＋密碼」登入，每一次登入都必須由 LIFF 取得 LINE 的身分票（id_token）交給後端向 LINE 驗證，驗出來的 LINE 使用者編號（UID）就是這個人的身分。**

- 誰能做：家長自己（只能透過 LINE／LIFF）
- 依據：server/routes/auth.js:437-440 「legacy `POST /api/auth/parent-login`（phone-only / phone+id_token 手機單因素登入）已刪除……家長登入一律走下面的 LINE-first 流程」；同檔 402-406 `const idToken = String(req.body?.id_token || '').trim(); if (!idToken) { res.status(400).json({ error: 'id_token 必填', code: 'ID_TOKEN_REQUIRED' });`
- 註：證據對得上。補查：grep 'parent-login' 全 repo 只剩三處註解（auth.js:8、auth.js:437、parentAuth.js:9），沒有任何路由掛載，路由確實已刪。OTP 那句也對：grep 'OTP' 在 server/ 原始碼只命中 auth.js:799 一行註解「No OTP provider is configured in this project」（另有的命中全在 server/public/liff 的前端打包檔，非後端邏輯）。

**2. 有一組固定的測試帳號可以用帳號密碼繞過 LINE 登入（家長 custom / custom2），但正式環境永遠關閉：只要 NODE_ENV=production，即使有人誤開開關也一律回「找不到此頁」。測試家長的身分編號是寫死的假 UID（demo:手機號），不是真的 LINE UID。**

- 誰能做：任何知道測試帳密的人（僅非正式環境）
- 依據：server/routes/auth.js:71-73 `if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEMO_LOGIN !== '1') { return res.status(404).json({ error: 'Not found' }); }`；同檔 114-121 `WHERE phone = $1 AND is_active = TRUE AND line_uid = $2`, [acct.phone, `demo:${acct.phone}`]；帳號表 auth.js:58-66
- 註：證據對得上。normalizeLineUid 在 server/config/ragicSchema.js:61-65 確實把 'demo:' / 'DEMOTEST_' 開頭一律收斂成空字串。補一筆：demo 教練走 fail-closed（找不到測試帳號教練就 404，絕不退回任何真實教練，auth.js:83-103），demo 家長找不到則回 500 DEMO_PARENT_MISSING。

**3. LINE 的身分票必須是公司自己的 LINE Login 頻道發出來的才算。系統先偷看票上寫的頻道編號，不在白名單（各場館一個＋員工一個）就連驗都不驗直接拒絕；驗完回來再比對一次頻道編號有沒有被半路換掉。**

- 誰能做：系統自動
- 依據：server/services/lineAuth.js:56-63 `const peeked = peekAudience(idToken); if (peeked && !allowed.includes(peeked)) { ... e.code = 'LINE_CHANNEL_MISCONFIGURED'; throw e; }`；同檔 118-128 `if (payload.aud && String(payload.aud) !== String(channelId)) { ... e.code = 'LINE_CHANNEL_MISCONFIGURED'; throw e; }`
- 註：證據對得上。補兩點：(1) 完全沒有 Login channel 設定時（allowedLoginChannels() 為空）也是直接拒絕，同樣回 LINE_CHANNEL_MISCONFIGURED（lineAuth.js:50-55），屬 fail-closed；(2) 偷看不到 aud 時會退回用環境變數的 LINE_LOGIN_CHANNEL_ID 驗（lineAuth.js:65，註解寫明是為相容舊 token 格式），此時白名單那道檢查等於沒作用。前端文案對應在 auth.js:396「系統設定異常，請聯繫客服協助處理（非您的操作問題）」。

**4. 每次登入成功都會順手記下「這支 LINE UID 是從哪個 Login 頻道進來的」，因為之後要推播訊息必須用同一個 provider 的頻道，跨 provider 必定推不到。記錄失敗絕對不會擋住登入。**

- 誰能做：系統自動
- 依據：server/services/lineIdentity.js:41-46 `UPDATE parents SET line_login_channel_id = $2, updated_at = NOW() WHERE line_uid = $1 AND line_login_channel_id IS DISTINCT FROM $2`；呼叫端 server/routes/auth.js:423-427 `try { await recordLoginChannel(profile.sub, profile.aud); } catch (chErr) { console.warn('[auth] 來源 channel 記錄略過：', chErr.message); }`
- 註：證據對得上。parents 與 coaches 兩張表都會被更新（lineIdentity.js:41-46），註解自述理由是「同一個 uid 可能是家長、也可能是教練（少數人兩者皆是）」。補一筆：同一組 (uid, channel) 有 10 分鐘的 in-process 快取（lineIdentity.js:20-21、35-36），所以不是每次登入都真的打 DB。

**5. 登入時會把 LINE 的暱稱（顯示名稱）抄一份存起來，供後台辨識用；這份暱稱跟家長本人的姓名是分開存的兩件事。抄寫失敗不會擋住登入。**

- 誰能做：系統自動（家長改 LINE 暱稱，下次登入就會更新）
- 依據：server/routes/auth.js:415-419 `await captureParentLineProfile({ lineUid: profile.sub, displayName: profile.name });` 外包 try/catch 只 `console.warn`；server/services/parentLineProfile.js:32-42 `INSERT INTO parent_line_profiles(line_uid,display_name,source,last_verified_at) ... ON CONFLICT (line_uid) DO UPDATE SET display_name=EXCLUDED.display_name`
- 註：證據對得上。line_uid 是 parent_line_profiles 的衝突鍵，與 parents.name 無關。補一筆：暱稱寫入前會過濾控制字元並截到 100 字（parentLineProfile.js:19-21），UID 也截到 100 字；暱稱為空時整筆不寫（同檔 31）。

**6. 判斷「你是不是已經有帳號了」只看本地資料：拿這支 LINE UID 去本地家長名單找，找到一筆在啟用中的家長就直接登入。登入這條路上完全不會去問 Ragic，Ragic 當掉、查詢失準或還沒同步都不會把正常使用者擋在門外。**

- 誰能做：系統自動
- 依據：server/routes/auth.js:464-469 「定案規則（2026-07-03）：登入只看本地 Z01 鏡像的 LINE UID……登入熱路徑不可因 Ragic 查詢失準、timeout 或未同步而刪資料/擋正常使用者」＋`if (await _respondExistingParentFastPath(res, lineUid, 'logged_in', true)) return;`；server/services/parentSync.js:36-43 `FROM parents WHERE line_uid=$1 AND is_active=TRUE`
- 註：證據對得上。快速通道在 parent-line-login 是 forceLocal=true 強制開啟（auth.js:469、233-234），其他端點受 EXISTING_USER_LOCAL_FASTPATH 控制（預設開，server/config/ragicSchema.js:82）。已停用或被刪除的家長這支 UID 就登不進去，會落到 need_phone_binding（auth.js:471-480）。

**7. 一支 LINE UID 最多只能對應一個家長帳號，一支手機號碼也最多只能對應一個家長帳號 —— 這是資料庫層的硬性限制，任何流程都繞不過。手機號碼還不可以留空。**

- 誰能做：沒有人（只有改資料庫結構才能放寬）
- 依據：server/bootstrap/coreSchema.js:112-113 `line_uid VARCHAR(100) UNIQUE,` / `phone VARCHAR(20) NOT NULL UNIQUE,`；db/migrations/001_initial_schema.sql:26 `CREATE TABLE parents (... line_uid VARCHAR(100) UNIQUE, phone VARCHAR(20) NOT NULL UNIQUE, ...)`
- 註：證據對得上。「一個家長可以有幾支 LINE」＝1（同一時間）；「一支 LINE 可以綁幾個家長」＝1。想換綁只能走帳號恢復或櫃台解除綁定。補一筆：ragic_record_id 也是 UNIQUE（001:26、parentSync.js:281-283 攔 uq_parents_ragic_record_id），所以「同一筆 Ragic 記錄對兩個本地家長」同樣被資料庫擋。

**8. 在新的流程裡，第一步（LINE 登入查無帳號）會發一張只有 10 分鐘有效的「流程票」。後面每一步都憑這張票，不再重複驗 LINE；票上綁定了發票時的 LINE UID，中途換人接手用不了。**

- 誰能做：系統自動（第一步簽發，auth.js:475）
- 依據：server/middlewares/flowAuth.js:19 `const FLOW_TTL_SECONDS = 10 * 60; // 修改 PROMPT §1：短效 10 分鐘`；同檔 21-33 `signFlowToken` 寫入 `{ type: 'flow', lineUid: uid, phone, attempts, studentName }`；同檔 35-53 `requireFlowToken`：`if (payload.type !== 'flow') { return res.status(403)... }`
- 註：證據對得上。票上會攜帶「已驗過的手機」與「已失敗次數」，所以重試計數不需要伺服器記狀態，重啟或多台機器都不受影響（flowAuth.js:10-11 註解自陳）。實務上這條規則目前沒有使用者走到。注意：flowAuth 的檔頭註解說「僅供 verify-phone / verify-student / bind / register 四端點掛載」，與我實際查到的掛載處一致。

**9. 新流程第二步只回答「這支手機存不存在」，不論存在或不存在都絕不回傳任何學員資料，學員名單要到第三步姓名對上才會出現。而且兩種答案的回應時間被強制拉平到至少 0.4 秒，避免從快慢反推答案。**

- 誰能做：家長自己（僅新流程，目前無前端使用）
- 依據：server/routes/auth.js:498-504 「命中一律**不回傳任何學員資料**（防列舉，修改 PROMPT §3.5）……一律拉平到固定下限（VERIFY_PHONE_MIN_MS）後才回應」＋`const VERIFY_PHONE_MIN_MS = 400;`；同檔 507-512 `const elapsed = Date.now() - _startedAt; const wait = VERIFY_PHONE_MIN_MS - elapsed; if (wait > 0) await new Promise((r) => setTimeout(r, wait));`
- 註：證據對得上。也刻意不區分「這支電話已綁給別的 LINE」與「單純存在」，一律回 found（auth.js:555-560 註解＋回應），避免用存在性洩漏綁定狀態。補一筆：時間拉平只包住 respond() 這條路，最外層 catch 的 500 也走 respond（auth.js:563），所以錯誤回應也被拉平。

**10. 新流程第二步有次數限制：同一組「來源 IP + LINE UID」5 分鐘內最多 5 次，超過回「嘗試次數過多，請 5 分鐘後再試」。刻意用 IP 加 UID 當鍵：只看 IP 會誤傷共用出口的學校或公司網路，只看 UID 擋不住同一支手機換 IP 硬灌。**

- 誰能做：系統自動
- 依據：server/middlewares/flowAuth.js:64-67 `const ATTEMPTS = new Map(); const WINDOW_MS = 5 * 60 * 1000; ... const MAX_ATTEMPTS = 5;`；同檔 70-82 `const key = `${ip}:${uid}`; ... if (rateLimitEnabled() && rec.count > MAX_ATTEMPTS) { ... return res.status(429).json({ error: '嘗試次數過多，請 5 分鐘後再試', code: 'RATE_LIMITED' }); }`；設計理由 同檔 60-62
- 註：證據對得上。是單機記憶體計數（in-process），多台機器各自計數；註解自陳「單機 MVP 夠用，正式部署改 Redis-backed」（flowAuth.js:57-58）。可用 RATE_LIMIT_ENABLED=0 整組關閉（server/middlewares/rateLimit.js:26-29）。補一筆：這支限流器沒有採用後來 rateLimit.js 定下的兩條教訓（「取不到可辨識位址就放行」「已超限不再累加」），它在拿不到 IP 時用字面值 'unknown' 當鍵——因為 key 還含 UID，不會造成 2026-08-26 那種全員鎖死。

**11. 新流程第三步的認領驗證有 3 次上限：學員姓名或登記電話對不上就扣一次，用完 3 次不再讓你重試，而是轉入人工待審，並且不論之後表單填什麼都不能完成正式註冊、也不能建出第二筆同電話家長。**

- 誰能做：家長自己（僅新流程，目前無前端使用）
- 依據：server/routes/auth.js:640-654 `const nextAttempts = attempts + 1; if (nextAttempts >= 3) { ... return res.json({ status: 'exhausted', reason: 'phone_collision' }); }` ＋ `attempts_remaining: 3 - nextAttempts`；轉審處 auth.js:1698-1715 `if (phone) { ... parentSync.auditClaim({ ... result: 'phone_collision_blocked' ... }); return res.json({ status: 'pending_review', reason: 'phone_collision' }); }`
- 註：證據對得上。註解明言這是「規格 §5/§7 明定的刻意行為，非疏漏」（auth.js:1687-1693）。機制上是靠流程票上沒有被清掉的 phone 欄位來認出「這是撞號轉進來的」。⚠ 但這個機制認人認得太寬：見我補的 added 第 2 條——verify-phone 的 z03_pending 分支也會簽出帶 phone 的票，於是那批人走 /register 一樣被當成 phone_collision。

**12. 「你是這個家庭的人」這件事是用知識證明的，不是用驗證碼：要拿出（1）這個家庭登記的手機號碼，加上（2）名下某位學員的姓名。姓名比對是正規化後的完全一致（全半形、大小寫、空白都先收斂），不做模糊比對、不做同音猜測。**

- 誰能做：家長自己
- 依據：server/services/parentSync.js:708-717 `classifyStudentPhoneClaim`：`const byName = (ragicStudents || []).find((s) => _normalizeStudentName(s.name) === _normalizeStudentName(name)); ... const expectedPhone = _normalizePhone(byName.registered_phone || parentPhone || ''); ... return phone === expectedPhone ? 'matched' : 'mismatch';`；註解 server/services/identityNormalizer.js:6-7 「They deliberately do not do fuzzy matching, transliteration, surname guessing, or national-id matching.」
- 註：證據對得上。「登記手機號碼」優先比對 Ragic 學員子表的 registered_phone，沒有這欄才退回比對 Z01 家長手機（parentSync.js:714）。補一筆：姓名或電話任一為空一律回 'mismatch'（同檔 711），expectedPhone 解不出來也回 'mismatch'（:715）——都是 fail-closed。

**13. 在舊綁定流程裡，如果這支 LINE 已經綁在另一支手機上，直接擋下，叫使用者用原手機登入或聯絡客服 —— 不會自動改綁。**

- 誰能做：沒有人（要換手機只能由櫃台解除綁定或走帳號恢復）
- 依據：server/routes/auth.js:854-860 `const dupLine = await pool.query(`SELECT phone FROM parents WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`, [lineUid]); if (dupLine.rowCount && dupLine.rows[0].phone !== phone) { return res.status(409).json({ error: '此 LINE 帳號已綁定其他手機，請改用原手機登入或聯絡客服', code: 'LINE_ALREADY_BOUND_TO_OTHER_PHONE' }); }`
- 註：證據對得上。註冊流程有同一道鏡像檢查（auth.js:1143-1149，文案略不同、少了「或聯絡客服」）。補一筆：註冊流程還有第三道同碼檢查在 Ragic 層（auth.js:1371-1379，以 getParentByLineUid 反查），所以註冊端這一條有本地＋Ragic 雙層。

**14. 在舊綁定流程裡，如果這支手機已經綁在另一支 LINE 上，不會在查 Ragic 之前就直接擋 —— 先記下來，以 Ragic 的家長主檔為權威；若 Ragic 那筆資料完整且 UID 寫回成功，後續刷新會覆蓋本地的舊 UID。但若手機是在本地待處理池（Z03）裡已綁別支 LINE，則直接擋下叫聯絡客服。**

- 誰能做：家長自己（但結果取決於資料在哪一層）
- 依據：先記不擋：server/routes/auth.js:861-864 「1b) 本地手機已綁到不同 line_uid：先記錄，不在查 Ragic 前直接擋。以 Ragic Z01 為權威；若後續 Z01 完整且 UID 寫回成功，refresh 階段會覆蓋本地舊 UID」＋`const localPhoneHasOtherUid = Boolean(dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid);`；Z03 直接擋：同檔 895-900 `if (z03ByPhone?.parent?.line_uid && z03ByPhone.parent.line_uid !== lineUid) { return res.status(409).json({ ... code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE' }); }`
- 註：證據對得上。localPhoneHasOtherUid 之後併入 needsAccountRecovery 判斷（auth.js:941 `const needsAccountRecovery = mapped.line_uid !== lineUid || localPhoneHasOtherUid;`），所以最終仍會要求走帳號恢復。註冊流程則相反：同一情況在寫任何 Ragic 之前就直接 409 擋下（auth.js:1151-1162），理由寫明是防「在『本地已綁 UID、Ragic 端 UID 空白』的漂移狀態下……知道電話的人可搶綁 Ragic UID 把原用戶鎖在門外」。

**15. 當一支手機在 Ragic 上已經綁了另一支真實 LINE 帳號時，系統不會自動改綁，而是開立一張「帳號恢復」案件：家長必須先通過學員驗證，系統才會發出一組 15 分鐘有效、只能用一次的驗證碼，家長要把案件編號與驗證碼提供給客服。**

- 誰能做：家長自己發起，但只有後台管理員能完成
- 依據：server/routes/auth.js:755-767 `return res.status(409).json({ error: '此手機已綁定其他 LINE 帳號，請完成帳號恢復驗證', code: 'ACCOUNT_RECOVERY_REQUIRED', ... recovery_request_id: recovery.recovery_request_id, recovery_token: recovery.recovery_token, recovery_expires_at: recovery.expires_at, replayed: recovery.replayed })`；TTL：server/services/parentAccountRecovery.js:39-42 `return Number.isFinite(configured) && configured >= 60_000 ? configured : 15 * 60 * 1000;`；一次性：同檔 205 `const token = crypto.randomBytes(32).toString('base64url');` 只存 sha256（:215 `sha256(token)`）
- 註：證據對得上。案件編號與驗證碼會直接顯示在家長畫面上並提示「請只提供給客服」（client/liff/src/pages/LoginPage.jsx:122-124）。TTL 可用 PARENT_ACCOUNT_RECOVERY_TTL_MS 調整，下限 60 秒。舊綁定流程有一條對稱的入口（auth.js:963-998，initiatedBy: 'parent-bind-phone'），文案為「此家庭已綁定其他 LINE 帳號」。

**16. 同一支手機開立帳號恢復案件有次數限制：預設 1 小時內最多 5 件，超過回 429。同一個家長同時只能有一件進行中的案件；若已有一件但已過期，會先把它鎖起來再讓新的建立。完全相同的請求（同家長＋同學員＋同來源＋同新 UID）會回同一件案子而不是開第二件。**

- 誰能做：家長自己發起（系統自動限流）
- 依據：server/services/parentAccountRecovery.js:196-203 `SELECT COUNT(*)::int AS n FROM parent_account_recovery_requests WHERE phone_canonical=$1 AND requested_at >= $2` ＋ `if (recentRequests >= recoveryRateLimit()) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Account recovery rate limit exceeded', 429); }`；冪等：同檔 170-177 `const requestKey = sha256([parent.id, student.id, sourceId, newUidHash].join(':')); ... if (existing) { await client.query('COMMIT'); return safeRecoveryResult(existing, null, true); }`；過期先鎖：同檔 184-194
- 註：證據對得上。重播（replayed）時不會重發驗證碼（token 傳 null，parentAccountRecovery.js:176）。上限與時間窗可用 PARENT_ACCOUNT_RECOVERY_RATE_LIMIT_MAX（下限 1）／_RATE_WINDOW_MS（下限 60 秒）調整（同檔 44-52）。補一筆：另有一道資料庫層防線 uq_parent_recovery_active_parent，並發撞上時轉成 ACCOUNT_RECOVERY_LOCKED（同檔 224-226）；且新 UID 若已屬於另一位啟用中家長，在建案階段就先 409 擋（同檔 164-168）。

**17. 帳號恢復只能由後台管理員（admin 角色）手動完成，而且三件事缺一不可：審核人、原因、證據參照。管理員還必須輸入家長手上那組驗證碼；驗證碼錯誤會累計失敗次數，過期或次數用完就把案件鎖住。**

- 誰能做：後台管理員（admin 角色），不含 manager / 櫃台
- 依據：server/routes/auth.js:803-807 `router.post('/parent-account-recovery/manual-complete', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {`；server/services/parentAccountRecovery.js:246-248 `if (!reviewer || !reviewReason || !evidence) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Reviewer, reason, and evidence reference are required', 400); }`；同檔 271-274 `if (!tokenValid || expired || attempts > Number(request.max_attempts)) { const locked = expired || attempts >= Number(request.max_attempts); ... }`
- 註：證據對得上。沒有任何自動換綁路徑（auth.js:799-802 註解自陳「No OTP provider is configured in this project. Account recovery therefore uses the approved manual path only」）。驗證碼比對用 timingSafeEqual（parentAccountRecovery.js:32-37），兩邊都是 sha256 hex 等長字串。審核人不是前端傳的，取自 JWT：auth.js:812 `approvedBy: req.adminUser?.username || req.adminUser?.sub`。

**18. 換綁本身是一次不可分割的交易：確認家長的手機與舊 UID 都沒變（用雜湊比對）、確認學員只對上唯一一位、確認 Ragic 來源紀錄真的屬於這個家長，然後才把 parents.line_uid 用「舊值相符才寫」的方式換掉，同時寫稽核、排入 Ragic 回寫佇列。任一步失敗整筆回滾，舊 UID 維持有效。**

- 誰能做：系統自動（在管理員核准後）
- 依據：server/services/parentAccountRecovery.js:297-299 `if (!parent || normalizePhone(parent.phone) !== request.phone_canonical || sha256(parent.line_uid) !== request.old_uid_hash) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Canonical parent identity changed before rebind'); }`；唯一學員 同檔 302-304 → resolveExactStudent（:83-88 `if (rows.length !== 1) throw ...`）；來源歸屬 同檔 305-310 → assertSourceOwnership（:109-113）；compare-and-set 同檔 347-351 `UPDATE parents SET line_uid=$2,updated_at=$3 WHERE id=$1 AND line_uid=$4 RETURNING *` ＋ `if (!reboundParent) throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Atomic parent rebind compare-and-set failed');`
- 註：證據對得上。另有兩把 advisory lock（舊 UID 與新 UID 各一，同檔 300-301）與「新 UID 已被別人啟用」的再檢查（:311-315）。失敗後會用「另一筆不碰 parents/students/outbox 的交易」單獨記下終局狀態（同檔 421-455，註解自陳「This transaction never touches parents, students or outbox」），讓稽核看得出為什麼舊 UID 沒被換掉。回寫 Ragic 走 outbox（同檔 389-397，operation='REBIND_Z01_LINE_UID'、field_id='1006846'）。

**19. 櫃台／客服解除某位家長的 LINE 綁定時，必須填寫原因（上限 500 字），系統會清掉本地的 LINE UID 並寫稽核（只存雜湊），然後才去清 Ragic 上的 UID 欄位。順序不可顛倒；Ragic 那步失敗只影響「家長改用另一支 LINE 重綁」的情況，回應會明講。學員、報名、上課紀錄、家長業務資料全部保留。**

- 誰能做：後台有 customer-parents 權限者（manager / 櫃台限自己場館，admin 全域）
- 依據：server/routes/admin/customerParents.js:179-181 `const reason = String(req.body?.reason || '').trim(); if (!reason) return res.status(400).json({ error: '請填寫解除綁定的原因', code: 'REASON_REQUIRED' }); if (reason.length > 500) return res.status(400).json({ ... code: 'REASON_TOO_LONG' });`；同檔 210-215 `UPDATE parents SET line_uid = NULL, last_synced_at = NULL, updated_at = NOW() WHERE id = $1`；同檔 229-240 `await client.query('COMMIT');` 之後才 `ragicWriter.writeField('Z01', parent.ragic_record_id, ragic.FIELD.Z01.LINE_UID, '', actor, 'admin-unbind-line', { reason })`；順序理由 同檔 170-176
- 註：證據對得上。目前沒綁 LINE 的家長會回 409 NOT_BOUND（同檔 201-207，用 isRealLineUid 判斷，demo:/DEMOTEST_ 視為沒綁）。稽核只落雜湊，new_uid_hash 放哨兵值 sha('ADMIN_UNBIND')（同檔 220-228）。last_synced_at 一併清成 NULL，理由寫在 211-212。權限來自 requireResource('customer-parents') + parentInScope 場館收斂（同檔 178、86-90）。

**20. 家長登入後拿到的通行證（JWT）有效 12 小時，裡面只帶家長編號、手機與 LINE UID。每一次呼叫 API 都會即時回資料庫確認這個家長還存在且在啟用中 —— 帳號被刪除或停用立刻失效，前端會收到 401 並登出。**

- 誰能做：系統自動
- 依據：server/middlewares/parentAuth.js:14 `const TTL = '12h';`；同檔 21-25 `const payload = { parentId, phone, type: 'parent' }; if (lineUid) payload.lineUid = lineUid; return jwt.sign(payload, getSecret(), { expiresIn: TTL });`；同檔 41-44 「每次請求都跟資料庫即時比對：帳號被刪除或停用(is_active=FALSE)即失效」＋`SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE`
- 註：證據對得上。資料庫查詢本身失敗會回 500「Auth check failed」而不是放行（parentAuth.js:45-48，fail-closed）。同樣的檢查也套在聊天室 WebSocket 連線（server/services/websocket.js:120-125）。⚠ 但這道檢查沒有套滿：見我補的 added 第 3 條，optionalParent 這個中介層完全沒做這個 DB 檢查。

**21. 通行證檢查只認「家長編號存在且啟用」這一件事，不會比對通行證裡的 LINE UID 是否還等於這個家長現在綁的 LINE。所以櫃台解除綁定、或帳號恢復把帳號換綁給新的 LINE 之後，舊 LINE 手上那張通行證在剩餘的有效期內（最多 12 小時）還是能繼續用。系統沒有任何主動失效通行證的機制。**

- 誰能做：沒有人（無法強制登出）
- 依據：server/middlewares/parentAuth.js:43-50 `const r = await pool.query('SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE', [p.parentId]); if (!r.rowCount) return res.status(401)...; req.parent = { id: p.parentId, phone: p.phone, lineUid: p.lineUid || null };`（無 line_uid 比對）；grep `token_version|tokenVersion|jti|revoke|blacklist|denylist` 於 parentAuth.js 與 routes/auth.js 零命中
- 註：證據對得上，我自己跑過那個 grep 確認零命中。櫃台若要「立刻踢出」只能把家長停用（is_active=FALSE），但那會連帶擋掉正常使用，而且依規則 38 這位家長解綁後也無法被重新啟用（PARENT_UNBOUND_CANNOT_ACTIVATE），等於停用就回不去——這是交接時值得讓櫃台知道的實務落差。

**22. 通行證分三種且不可互換：家長證（type=parent）、流程票（type=flow）、教練證（type=coach）。拿流程票去打家長業務 API 一律回 401 而不是 403 —— 刻意不讓呼叫端從狀態碼反推出「這是一張有效但類型不對的票」。三種票共用同一把簽章金鑰。**

- 誰能做：系統自動
- 依據：server/middlewares/parentAuth.js:36-39 「401 而非 403：故意不區分『沒有 token』跟『type 不對（例如誤帶 flowToken）』……規格 §7 PASS 判準」＋`if (p.type !== 'parent') return res.status(401).json({ error: 'Unauthorized', code: 'PARENT_TOKEN_REQUIRED' });`；共用金鑰 同檔 16-19 `const { getSecret: _adminGetSecret } = require('./adminAuth'); function getSecret() { return _adminGetSecret(); }`（flowAuth.js:16-17 同寫法）
- 註：證據對得上。金鑰來源：production 必須設 JWT_SECRET 且長度 ≥16，否則 getSecret() 直接 throw；非 production 會退回開發用 fallback 並印一次警告（server/middlewares/adminAuth.js:25-39）。反方向不對稱：requireFlowToken 對「type 不對」回的是 403 不是 401（flowAuth.js:44-46），所以刻意的模糊化只做在家長端。聊天室 HTTP 路由用 requireLiffUser 同時接受家長證與教練證，其他票回 403（parentAuth.js:64-78）。

**23. 家長的 LINE UID 絕對不會回傳給家長端（LIFF），也不會寫進瀏覽器的本機儲存。它只用於後端驗證與簽發通行證。**

- 誰能做：系統自動
- 依據：server/routes/auth.js:215-216 「line_uid 只供後端驗證／簽 JWT 使用，不回傳給 LIFF，避免被 browser devtools、第三方 error reporter 或錯誤的前端 log 蒐集」（_issue 回傳物件 209-226 中確實無 line_uid）；前端再去敏一次：client/liff/src/api/client.js:69-70 `const { line_uid, lineUid, token: _t, ...safe } = p; localStorage.setItem(USER_KEY, JSON.stringify({ role: 'parent', data: safe, token }));`
- 註：證據對得上，但範圍要收窄成「家長端／LIFF」：後台 API 會回完整未遮罩的 line_uid（server/routes/admin/customerParents.js:35 `PARENT_COLS` 含 `p.line_uid`、:42 `line_uid: r.line_uid || null`）。詳見我補的 added 第 4 條。教練登入回應也做同樣處理（auth.js:109 `const { line_uid, ragic_data_no, ...safe } = coach;`）。稽核 log 一律只落雜湊或末 4 碼（parentSync.js:719-728、auth.js:174-176）。

**24. 通行證過期造成的 401 不會把家長登出：前端會用當下的 LINE session 在背景換一張新的通行證再重試原請求，使用者無感。只有連背景換發也失敗，才會導回登入頁並顯示「登入階段已過期」。**

- 誰能做：系統自動（前端）
- 依據：client/liff/src/api/client.js:53-66 `function silentReauthParent() { ... const res = await axios.post('/api/auth/parent-line-login', { id_token: idToken }, ...); ... if (data?.status !== 'logged_in' || !token) return false;`；重試 同檔 123-130 `if (!wasCoach && !config._retriedAfterReauth) { ... config._retriedAfterReauth = true; return http.request(config); }`；提示：client/liff/src/pages/LoginPage.jsx:190-195 `if (sessionStorage.getItem('daos.liff.flashLogout')) { ... toast.info('登入階段已過期，請重新登入'); }`
- 註：證據對得上，但排除範圍比敘述更廣，值得寫清楚：不走這個攔截器的條件是 `config.skipAuthRedirect || isAuthBootstrapRequest(config.url) || isAuthBootstrapPath()`（client.js:110-112），其中 isAuthBootstrapRequest 涵蓋**所有** /auth/* 請求（同檔 42-45），isAuthBootstrapPath 則涵蓋停留在 /login、/bind、/register、/demo、/coach-portal **任一頁面時的所有請求**（同檔 24-28）。所以不是「登入／綁定／註冊三類請求」，而是整個 auth 家族＋這五個頁面上的一切請求。理由寫在 107-109：避免使用者在電話／註冊頁陷入 relogin loop。另外家長失敗時刻意不清 session（同檔 138-143），只有教練會被清。

**25. 舊的 LINE Login callback 連結不再是綁定端點：它不讀、不驗、不轉送任何 code / state / token / UID，只把人導回正式的 LIFF 綁定頁，由 LIFF 重新建立登入狀態，後端再以 id_token 驗一次才能進綁定流程。**

- 誰能做：系統自動
- 依據：server/routes/auth.js:443-452 「這不是 OAuth callback：不讀、不驗、不轉送 code/state/token/UID，避免把舊連結變成可重放的綁定端點」＋`res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); return res.redirect(303, '/liff/bind?source=legacy-callback');`；掛載 同檔 452 `router.get('/line/callback', redirectLegacyParentLineCallback);`
- 註：證據對得上。整個 handler 只有三行，確實沒碰 req.query。replit.md:239 另記載已移除前端死掉的 bindLineUid()（呼叫不存在的 /auth/bind-line、零呼叫點），並刻意不補後端，理由是「會復活未驗證 parentId 綁定的不安全設計」。補一筆：auth.js:1724-1726 有 `router.all('*')` 兜底回 404 `auth endpoint not found`，所以其他舊連結也不會意外命中別的 handler。

**26. 家長自己可以改的個人資料只有：姓名、館別、身分、性別、Email、住家電話、LINE ID、住家地址。其中姓名、館別、性別、Email 是必填，Email 還要通過格式檢查。手機號碼與 LINE UID 家長改不了 —— 手機在畫面上是唯讀，後端也不收這個欄位。家長資料沒有生日欄位（只有學員有）。**

- 誰能做：家長自己（姓名／館別／性別／Email／住家電話／LINE ID／住家地址）；手機只有櫃台能改；LINE UID 沒有人能直接改
- 依據：server/routes/parents.js:498-508 patch 白名單（name / primary_venue_id / identity / gender / email / home_phone / line_id / home_address，無 phone、無 line_uid）；必填 同檔 512-515 `const REQUIRED = [['name','家長姓名'],['primary_venue_id','館別'],['gender','性別'],['email','Email']];`；Email 格式 同檔 519-521；畫面唯讀 client/liff/src/pages/ProfilePage.jsx:280 `<input className="...bg-gray-50..." value={parentForm.phone} readOnly />`
- 註：證據對得上；只補一個小修正：identity 技術上仍在白名單裡（parents.js:502 `identity: cleanText(b.identity, 50) || '一般身分'`），只是 UI 已移除、沒帶時預設「一般身分」，所以「家長可改的欄位」嚴格說是 8 個而非 7 個——直接打 API 仍可設 identity。改完先存本地並標記待同步（last_synced_at=NULL），COMMIT 後才 best-effort 回寫 Ragic，失敗由每日補寫重試（parents.js:541-570）。demo 帳號只更新本地鏡像、不寫 Ragic（同檔 529-539）。

**27. 櫃台／客服可以改家長的手機號碼（值屬 Ragic、綁定關係屬本系統），撞到唯一鍵回 409「此行動電話已被其他家長使用」。但一般編輯永遠不會改 line_uid —— 唯一例外是專門的解除綁定端點。**

- 誰能做：後台有 customer-parents 權限者（manager / 櫃台限自己場館，admin 全域）
- 依據：server/routes/admin/customerParents.js:10-15 「登入身分欄（line_uid / is_active）：Replit 為權威 → 一般編輯「永不」改 line_uid。唯一例外是 POST /:id/unbind-line……phone：值屬 Ragic、綁定關係屬 Replit；此處允許客服改號，唯一鍵衝突回 409」；白名單 同檔 296-300 `const allow = { name: b.name, phone: b.phone, gender: b.gender, email: b.email, primary_venue_id: b.primary_venue_id, identity: b.identity, home_phone: b.home_phone, home_address: b.home_address, line_id: b.line_id };`；衝突訊息 同檔 398-400
- 註：證據對得上；白名單原引述被簡寫了，實際 9 個欄位（上面已列全），關鍵是其中沒有 line_uid。註解那句「櫃台改手機時不做台灣手機格式驗證」也對：customerParents.js:281 只檢查非空 `if (b.phone !== undefined && !String(b.phone).trim()) return res.status(400)...`，而家長端註冊／綁定一律要求 09xxxxxxxx（auth.js:178 `const TW_PHONE_RE = /^09\d{8}$/;`）。同一個欄位在兩個入口的格式門檻不同。

**28. 尚未綁定真實 LINE 的家長列不能被後台重新啟用，會回「此家長尚未綁定真實 LINE，無法啟用；請客戶完成 LINE 註冊綁定後會自動啟用」。啟用中的家長名單只收已綁 LINE 的人。**

- 誰能做：後台有 customer-parents 權限者（但這個動作會被擋）
- 依據：server/routes/admin/customerParents.js:306-317 「未綁 LINE UID 的列不得重新啟用；active 鏡像只收已綁列（夜間 pull 掃尾也會再停用，這裡直接擋下並說明，避免『啟用→隔天又被停用』的困惑）」＋`if (!parentHasRealLineUid) { await client.query('ROLLBACK'); return res.status(409).json({ error: '此家長尚未綁定真實 LINE，無法啟用；請客戶完成 LINE 註冊綁定後會自動啟用', code: 'PARENT_UNBOUND_CANNOT_ACTIVATE' }); }`
- 註：證據對得上。isRealLineUid（同檔 80-83）會把 demo: / DEMOTEST_ 前綴視為非真實 UID。注意方向性：擋的只有「啟用」，`b.is_active === false`（停用）不受這道檢查，任何時候都做得到（同檔 306-319 的 if 只包 true 分支）。

**29. 家長自己不能停用或移除學員：這條路徑保留但一律回 405，並引導「請洽櫃臺，或透過 LINE 官方帳號聯繫」。任何移除／轉出／寄掛異動一律由櫃台在 Ragic 端處理。**

- 誰能做：櫃台（在 Ragic 端）；家長自己不行
- 依據：server/routes/parents.js:744-753 「家長端『停用/刪除學員』已移除……政策：任何移除/轉出/寄掛異動一律由櫃台在 Ragic 端處理。保留路徑並回 405 + 明確引導」＋`router.delete('/me/students/:id', requireParent, (req, res) => { res.status(405).json({ error: '學員資料異動（停用 / 移除 / 轉出）請洽櫃臺，或透過 LINE 官方帳號聯繫。', code: 'STUDENT_REMOVAL_VIA_COUNTER' }); });`
- 註：證據對得上。前端按鈕已移除，這個 405 是防「直接打 API／用舊頁面」的後端守門。移除的兩個原因寫在 745-746：會把「停用」寫進 Ragic Z02「學員身分」欄覆蓋身分類別、以及破壞與已報名課程的連結製造孤兒資料。

**30. 註冊新家長時必填：家長姓名、手機（09xxxxxxxx）、Email（格式檢查）、性別、館別（必須是啟用中的場館），以及至少一位學員；每位學員必填姓名、身分證字號（格式檢查）、出生年月日（不可是未來日期）、性別、血型（限 A/B/O/AB/不清楚）。**

- 誰能做：家長自己
- 依據：server/routes/auth.js:1078-1088 `if (!email) return res.status(400).json({ error: 'Email 必填', code: 'EMAIL_REQUIRED' }); if (!EMAIL_RE.test(email)) ...; if (!gender) ... 'GENDER_REQUIRED'; ... const venueExists = await pool.query(`SELECT 1 FROM venues WHERE id = $1 AND is_active = TRUE`, [venueId]); if (!venueExists.rowCount) ... 'VENUE_NOT_FOUND'`；學員 同檔 1093-1140（1116-1121 `if (new Date(`${birthDate}T00:00:00+08:00`).getTime() > Date.now()) return res.status(400).json({ ... code: 'STUDENT_BIRTH_DATE_INVALID' })`）；血型集合 同檔 185 `const STUDENT_BLOOD_TYPES = new Set(['A', 'B', 'O', 'AB', '不清楚']);`
- 註：證據對得上。Email 於 2026-08-03 改為必填，原因寫在 auth.js:1071-1075：Ragic Z01「(報)Email」是必填欄，留空的家長寫不回 Ragic（INVALID 202），連帶讓他之後每次 /parents/me/sync 都失敗；註解並說明「既有留空者仍需另行補齊」。身分證格式是保守版 `/^[A-Z][12]\d{8}$/`（auth.js:180），不做檢查碼驗證。

**31. 同一支手機重複註冊永遠不會建出第二個家長：以手機為冪等鍵。Ragic 查無此電話 → 建新檔；已有此電話但未綁 LINE（舊客戶未開通）→ 就地開通並把 LINE UID 補上；已有此電話且已綁「別支」LINE → 一律擋下防帳號搶佔。**

- 誰能做：家長自己
- 依據：server/routes/auth.js:1027-1033 「家長 LINE 註冊（以電話號碼為冪等鍵，永不重複建立同號 Z01）……· 已有此電話且已綁『其他』LINE UID（已開通）→ 409 擋下（防帳號搶占）」；本地層 同檔 1156-1162 `if (dupPhoneLocal.rowCount && dupPhoneLocal.rows[0].line_uid && dupPhoneLocal.rows[0].line_uid !== lineUid) { return res.status(409).json({ error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理', code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE' }); }`；Ragic 層 同檔 1411-1415 `if (existing.line_uid && existing.line_uid !== lineUid) { return res.status(409).json(GENERIC_PHONE_CONFLICT); }`
- 註：證據對得上。同一支 LINE 已註冊過（手機相同）→ 409 LINE_ALREADY_REGISTERED 叫他走登入（auth.js:1168-1173）。新戶寫入用 Idempotency-Key 或依「UID＋手機＋學員姓名」算出的雜湊當冪等鍵；同鍵但內容不同會被擋（server/services/z03IdentityClaim.js:129 `const requestKey = String(idempotencyKey || _payloadHash({ uid, phoneCanonical, names: ... }))`、:145-147 `if (replay.payload_hash !== payloadHash) throw new Z03ClaimError('LOCAL_LINK_FAILED', '相同 idempotency key 的 payload 不一致', 409)`）。

**32. 新戶註冊採「先本地、後同步」：在一個資料庫交易裡建好家長、學員、身分認領紀錄，並排進 Ragic 回寫佇列，然後立刻讓家長登入。Ragic 寫入失敗永遠不會擋住登入。**

- 誰能做：系統自動
- 依據：server/routes/auth.js:1557-1571 `return res.json({ status: 'registered_and_logged_in', ... sync_state: localFirst.sync_state, sync_pending: true, internalCode: 'RAGIC_UID_WRITE_PENDING', retryable: true, ... loginAllowed: true, ... })`；交易本體 server/services/z03IdentityClaim.js:135-221（`BEGIN` → `pg_advisory_xact_lock(hashtext('canonical-parent:...'))` → `pg_advisory_xact_lock(hashtext('line-uid:...'))` → INSERT parents/students/identity_claims/ragic_sync_outbox → `COMMIT`）
- 註：證據對得上。受 PARENT_LOCAL_FIRST 開關控制（預設開，server/config/ragicSchema.js:84；關掉會走 auth.js:1588-1611 的 rollback-only legacy 路徑，那條會先寫 Ragic）。回寫 Ragic 的唯一途徑是 outbox worker，而它的開關 RAGIC_PARENT_OUTBOX 預設是關的 —— 註解自陳後果是「從 07/14 起累積 300+ 筆 pending、attempts 全是 0，家長每次開 App 都看到『Ragic Z01 查無剛寫入的會員資料』」，且「有些人有 Ragic 編號，是靠另一條直接寫入的備援補上的；備援沒跑到就整筆漏 —— 所以症狀是『有時成功有時失敗』而不是全壞」（server/config/ragicSchema.js:85-96）。

**33. 團報的分享連結提供一支免登入的電話查詢：輸入手機就能知道這支號碼在系統裡有沒有家長、名下有幾位學員（姓名遮罩）、以及是否已在這一團。限制是 5 分鐘 15 次。**

- 誰能做：任何拿到團報邀請碼的人（不需登入）
- 依據：server/routes/groupOrders.js:370-399 `router.post('/by-token/:token/lookup-phone', lookupRateLimit, optionalParent, async (req, res) => {` → `res.json({ found: true, parent_name: maskName(parent.name), students: maskNames(sr.rows.map((r) => r.name)), student_count: sr.rowCount, already_member: mm.rowCount > 0, is_self: req.parent?.id === parent.id, order_status: order.status, joinable: ... })`；限額 同檔 104-105 「lookup-phone 是枚舉風險面 → 較緊（15 / 5min，足夠正常確認流程）」＋`const lookupRateLimit = makeRateLimiter(15, 'lookup-phone');`
- 註：證據對得上。與 verify-phone 的防列舉設計（不回學員資料、拉平回應時間、5 次上限）方向相反：這裡會回學員數量與遮罩姓名，額度也寬三倍，而且沒有時間拉平。設計上是為了讓加入者確認自己選對家庭（同檔 367-369）。補一筆：這支限流器只以 IP 為鍵（同檔 87-102 的 makeRateLimiter），不像 flowAuth 那樣加 UID——因為呼叫端本來就不需登入，沒有 UID 可用。

**34. 聊天室的即時連線是把通行證放在網址查詢字串裡傳送的，連上後同樣會即時確認家長還在啟用中，否則立刻斷線。**

- 誰能做：系統自動
- 依據：server/services/websocket.js:110-114 `const url = new URL(req.url, 'http://localhost'); token = url.searchParams.get('token'); roomId = url.searchParams.get('room'); if (!token || !roomId) return ws.close(4400, 'Missing token or room'); payload = jwt.verify(token, getSecret());`；同檔 122-124 「家長被刪除/停用即斷線（與 requireParent 一致）」＋`SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE` → `if (!active || !active.rowCount) return ws.close(4001, 'Parent account not found');`
- 註：證據對得上。流程票（type=flow）連不上（會走到 else 分支回 4003 Unsupported token type，websocket.js:132-133）。DB 查詢用 `.catch(() => null)` 包住且 `!active` 也斷線（:123-124），所以查詢失敗＝斷線，是 fail-closed。通行證出現在 URL 而非 header，容易被中間層日誌記到 —— 屬既有事實，非本次評估項。

**35. 如果同一支 LINE UID 在本地對到超過一位啟用中的家長，系統不會猜，直接判為「資料待整理」而不是挑一筆登入。**

- 誰能做：系統自動
- 依據：server/services/parentSync.js:44-46 `if (rows.length > 1) { throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'LINE UID 命中多個 active parent'); }`（查詢在 36-43，`WHERE line_uid=$1 AND is_active=TRUE ORDER BY id`）
- 註：證據對得上。因為 parents.line_uid 有唯一鍵（coreSchema.js:112），理論上不會發生；這是縱深防禦。但在 parent-line-login 裡這個例外會被最外層 catch 吞成 500「登入失敗」（auth.js:481-484 `console.error('[auth/parent-line-login]', err); res.status(500).json({ error: '登入失敗', code: 'LOGIN_FAILED' });`），家長看不到真正原因。同一款「多筆命中就不猜」也套在 phone（parentSync.js:245-247）與新戶註冊（z03IdentityClaim.js:157）。

**36. 決定一個家長身分是「同一個人」的證據順序寫死為：LINE UID → 正規化手機 → 明確的來源連結。光有一個 Ragic 記錄編號永遠不算「這兩筆是同一個人」的證據；三種證據指向不同家長時直接判為待整理，不自動合併。**

- 誰能做：系統自動
- 依據：server/services/parentSync.js:234-235 「Canonical identity order: LINE UID -> phone -> explicit source link. A bare Ragic record id is never accepted as proof that two people are one.」；同檔 256-266 `const candidates = new Map([byUid, byPhone, byLink].filter(Boolean).map((row) => [String(row.id), row])); if (candidates.size > 1) { throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'LINE UID、canonical phone 與 source link 指向不同 parent'); } ... if (parent?.line_uid && lineUidForWrite && parent.line_uid !== lineUidForWrite) { throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED', 'canonical parent 已綁定另一個 LINE UID'); }`
- 註：證據對得上。手機比對時會用 regexp_replace 去掉非數字再比，所以 Ragic 端存成 09xx-xxx-xxx 也對得上（parentSync.js:239-244）。「來源連結」指 source_record_links 表（同檔 249-255），必須是明確的 canonical_parent_id 關聯才算。另補：光靠 ragic_record_id 撞鍵（uq_parents_ragic_record_id）時也是丟 DATA_RECONCILIATION_PENDING 而非自動合併（同檔 281-283「Ragic source id 已存在但缺少安全 source link」）。

**37. 註冊或綁定時家長填的個資只能「補空白」，不能覆蓋既有資料 —— 除非這次的認領驗證已通過（ownershipVerified），聯絡類欄位（Email、住家電話、住家地址、LINE ID）才允許被更新。家長姓名只有在原本是空的或是「未命名家長」時才會被填上。**

- 誰能做：家長自己（僅補空白；已通過認領驗證時可更新聯絡欄位）
- 依據：server/services/z03IdentityClaim.js:59-64 `name=CASE WHEN (name IS NULL OR BTRIM(name)='' OR name='未命名家長') AND $2<>'' THEN $2 ELSE name END, email=CASE WHEN $7::boolean AND $3<>'' THEN $3 WHEN (email IS NULL OR BTRIM(email)='') THEN NULLIF($3,'') ELSE email END, home_phone=... home_address=... line_id=...`（$7 = ownershipVerified，見 :68）；Ragic 側同規則 server/services/parentRegistrationProfile.js:38-49 `if (!newText || oldText === newText) return null; if (oldText && !(contact && ownershipVerified)) return null;`
- 註：證據對得上。注意姓名那條的不對稱：即使 ownershipVerified=true，姓名仍然只能補空白或覆蓋「未命名家長」，不像聯絡欄位可被更新。回寫 Ragic 的欄位有白名單（家長姓名／Email／行動電話／住家電話／住家地址／LINE ID／LINE UID），白名單外一律丟棄（parentRegistrationProfile.js:10-18、124-132）。每筆變更寫 parent_profile_patch_audit，只存新舊值的雜湊（同檔 24-26 的 _hash）。

**38. 家長填的資料要回寫到 Ragic 時，如果那筆 Ragic 記錄的 LINE UID 欄位已經有「別人的」UID，直接拒絕整個回寫；只有該欄位是空白時才會把這次的 UID 填進去。**

- 誰能做：系統自動
- 依據：server/services/parentRegistrationProfile.js:105-120 `const currentUid = _text(sourceProfile.line_uid, 200); const nextUid = _text(lineUid, 200); if (currentUid && nextUid && currentUid !== nextUid) { const err = new Error('Ragic source field 1006846 is already bound to another account'); err.code = 'ACCOUNT_RECOVERY_REQUIRED'; throw err; } if (includeUid && !currentUid && nextUid) { add({ field_id: ragic.FIELD.Z01.LINE_UID, old_value: '', new_value: nextUid, change_reason: 'FILL_BLANK', ownership_verified: true }); }`
- 註：證據對得上。Ragic 上的 LINE UID 只認數字欄位編號 1006846，即使同一筆資料也帶著中文欄名「家教系統uid」也不會退而讀它，避免 schema 漂移時誤認（server/config/ragicSchema.js:67-73 `刻意只讀數字 Field ID；即使 payload 同時帶有「家教系統uid」中文 key，也不得 fallback`）。同一道守門在 Z03 認領裡也有兩處（z03IdentityClaim.js:592-595 與 848-851，都是 `const remoteUid = String(shadow['1006846'] || '').trim(); if (remoteUid && remoteUid !== lineUid) throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', 'Ragic source 已綁定另一個 LINE UID', 409);`）。

**39. 每次開啟 App 時的背景刷新不是安全門檻：本地 UID 已經在登入時驗過了，所以 Ragic 上的 UID 還沒回寫（欄位空白）不會讓同步整個失敗；但 Ragic 上已經寫著「別支」UID 仍然會擋，那是真的兩支 LINE 搶同一支電話，必須人工處理。**

- 誰能做：系統自動
- 依據：server/services/parentRefresh.js:167-174 「嚴格模式（預設，註冊／綁定的寫入後驗證）：維持原行為，一律擋……寬鬆模式（背景刷新）：Z01 UID 為空 = 待回寫，放行並續做同步；Z01 已有「別的」UID 仍然擋」＋`const ragicUidEmpty = !String(mapped.line_uid || '').trim(); if (strictUidMatch || !ragicUidEmpty) { throw new ParentRefreshError('RAGIC_REFRESH_UID_MISMATCH', '重新讀取的 Ragic Z01 LINE UID 與本次操作不一致', 502); }`；呼叫端 server/routes/parents.js:470-473 「開頁刷新不是安全門檻（本地 UID 已由登入時驗過）」＋`strictUidMatch: false, reason: 'parents-me-sync',`
- 註：證據對得上。背景刷新失敗時保留既有鏡像、回 sync_status='stale'，絕不清空也不回空名單（parents.js:475-479）。同步成功後本地 UID 若仍不等於本次登入的 UID，會丟 LOCAL_UID_REFRESH_FAILED（parentRefresh.js:222-224）。補一筆：/me/sync 有節流（parents.js:458-462，last_synced_at 在 SYNC_THROTTLE_MS 內就標 fresh 不刷），且 demo: 開頭的 UID 一律跳過刷新（:462）。

**40. 註冊／綁定寫入 Ragic 之後的嚴格刷新，會要求這筆家長主檔六個欄位齊全才算完成：家長姓名、場館、電話、Email、LINE UID、性別；而且姓名不可以還是「電話佔位」那種假名。館別解析不到不再硬擋登入，只大聲記錄等夜間同步收斂。**

- 誰能做：系統自動
- 依據：server/services/parentRefresh.js:19-26 `const REQUIRED_Z01_FIELDS = [['name','家長姓名'],['primary_venue_id','場館'],['phone','電話'],['email','Email'],['line_uid','LINE UID'],['gender','性別']];`；佔位姓名 同檔 38 `getZ01MissingFields(mapped, { rejectPlaceholderName = true, requireLineUid = true })`；館別不擋 同檔 214-221 「場館解析不到（Ragic 館別名稱在本地 venues 查無……）不再硬擋登入/註冊——擋下只會把『資料層待收斂』升級成『使用者進不來』」
- 註：證據對得上。「身分」（identity）刻意不列為必填，否則舊資料 identity 空值的帳號會永遠卡在「新增學員」（parentRefresh.js:16-18）。demo: / DEMOTEST_ 開頭的 UID 一律視為「沒有 UID」（同檔 33-36 `_isMissingLineUid`），場館值為「待補登」也算缺（同檔 28-31）。舊綁定流程呼叫它時傳 requireLineUid:false，因為 UID 是在該流程裡才寫入（auth.js:1002）。

**41. 同一支手機在本地待處理池裡對到多個家庭（無法唯一判定）時，系統不會挑一個、也不會建第二個家庭：建立／沿用一個本地身分讓家長登得進去，把每一筆來源都保留成別名，不排任何 Ragic 寫入，並開一張人工複核工單。**

- 誰能做：系統自動（後續由後台人工挑主來源）
- 依據：server/services/z03IdentityClaim.js:756-758 「Phone ownership + exact student name has been verified, but no source is safe to make primary. Create/use one local identity, preserve every source as an alias, enqueue no Ragic write, and allow login.」；工單 同檔 572-579 `await createParentIdentityBackofficeTask({ client, parent, sourceRecordIds: families.map((row) => row.z01_ragic_record_id), reasonCode: 'MULTIPLE_SOURCE_NO_UNIQUE_WINNER', suggestedAction: 'Review source evidence and select the primary Z01; do not create another parent.', correlationId })`
- 註：證據對得上。回應狀態是 DATA_RECONCILIATION_PENDING（同檔 566-567、582），前端顯示「登入完成，歷史資料整理中，請勿重複註冊」（client/liff/src/pages/LoginPage.jsx:285、334）。工單裡家長姓名與電話都是遮罩後才存的（server/services/parentIdentityBackoffice.js:19-22 `maskName` / `maskPhone`）。這條路仍有一道 fail-closed：若 canonicalParent 已綁別支 UID 就不放行，丟 ACCOUNT_RECOVERY_REQUIRED（z03IdentityClaim.js:759-761）。

**42. 「多來源挑主來源」這件事會用到幾層證據，但能用到第幾層取決於一個灰度開關：開關沒生效時最多只能用前 3 層證據，生效才放到第 6 層。而這個開關的總閘門（PARENT_IDENTITY_RESOLVER_V2）預設是關的。**

- 誰能做：系統自動（範圍由部署環境變數決定）
- 依據：server/services/z03IdentityClaim.js:743 `maxPriority: canary.allowed ? 6 : 3,`（同檔 511 亦同）；閘門 server/services/parentIdentityCanary.js:25 `enabled: STABILITY_FLAGS.PARENT_IDENTITY_RESOLVER_V2 && phase !== 'off'`；預設值 server/config/ragicSchema.js:83 `get PARENT_IDENTITY_RESOLVER_V2() { return envFlag('PARENT_IDENTITY_RESOLVER_V2', false); }`
- 註：證據對得上。灰度可用名單（allowlist：UID 雜湊／電話／來源編號，parentIdentityCanary.js:43-45）或百分比（依 UID 雜湊分桶，同檔 17-19 `parseInt(sha256(value).slice(0, 8), 16) % 100`）。已經走快速通道登入的既有使用者一律排除在灰度外（同檔 35-37 `if (existingLocalLineUidFound) return { allowed: false, reason: 'EXISTING_USER_FAST_PATH_EXCLUDED', phase: 'fastpath' };`）。程式碼裡另有三個內建允許的來源編號 '149','6504','6786'（同檔 7 `INTERNAL_SOURCE_ALLOWLIST`），這三個是寫死的、不受環境變數控制。

**43. 所有認領驗證的結果都會寫進伺服器日誌供事後稽核，但只落手機與 LINE UID 的雜湊（各取前 12 碼），嚴禁把完整門號或 UID 寫進日誌。註冊失敗的診斷紀錄也只記「欄位有沒有填」與不可逆雜湊。**

- 誰能做：系統自動
- 依據：server/services/parentSync.js:719-728 「認領稽核：寫進伺服器日誌；門號雜湊、line_uid 遮罩，嚴禁落地完整 PII」＋`const phoneHash = phone ? crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 12) : null;`（uidHash 同款，:724-726）；server/routes/auth.js:338-348 「註冊失敗診斷只記欄位存在性與不可逆 hash；禁止把姓名、電話、身分證、LINE UID 寫入 log」＋`parent_fields: { name: Boolean(...), email: Boolean(...), gender: Boolean(...) }`
- 註：證據對得上。新戶註冊交易失敗時刻意不記 err.detail，因為 PostgreSQL 會把欄位值（電話、身分證）放進去（server/services/z03IdentityClaim.js:228 「不記 err.detail：pg 會把欄位值放進去（電話、身分證），那是個資」）。稽核結果值我在程式裡找到的有：passed / passed_no_id_on_file / failed / not_on_file_blocked / uid_conflict / recovery_required / phone_collision_blocked / need_verification（auth.js:628、709、946、951、985、1506、1714）。

**44. 只要本地已經有一筆綁著這支 LINE 的啟用中家長，綁定與註冊流程的每一支端點都會在讀取表單、比對認領資料之前就直接發通行證讓人登入。換句話說，「學員姓名＋登記電話」這道認領驗證只對「本地查無此 LINE」的人要求；一旦綁定關係在本地存在過，後續任何重新綁定或重新註冊的嘗試都不會再被要求證明身分。** 〔覆核時補上〕
- 依據：共用捷徑：server/routes/auth.js:233-247 `async function _respondExistingParentFastPath(res, lineUid, status = 'logged_in', forceLocal = false) { if (!forceLocal && !STABILITY_FLAGS.EXISTING_USER_LOCAL_FASTPATH) return false; const local = await parentSync.findActiveParentByLineUid(lineUid); if (!local) return false; ... res.json({ status, parent: { ...issued, students }, token: issued.token, local_fast_path: true, sync_state: 'LOCAL_LINKED' }); return true; }`；掛載處共六支，全部在任何驗證之前：同檔 469（parent-line-login，forceLocal=true）、:515（verify-phone）、:575（verify-student）、:669（bind）、:845（parent-bind-phone）、:1058（_registerParentCore）、:1697（register）；旗標預設開：server/config/ragicSchema.js:82 `get EXISTING_USER_LOCAL_FASTPATH() { return envFlag('EXISTING_USER_LOCAL_FASTPATH', true); }`

**45. 測試家長（demo 帳號）不只是登入方式不同，它在資料層是一條完全獨立的路：改個人資料、新增學員、編輯學員三個動作都會在寫入前分流，只更新本地鏡像、不回寫 Ragic、也不做寫入後的嚴格刷新；每次開 App 的背景同步也會整段跳過。判定條件只看 LINE UID 是不是以 demo: 開頭。** 〔覆核時補上〕
- 依據：判定：server/routes/parents.js:420-422 `function isDemoParent(parentRow, tokenLineUid) { return String(parentRow?.line_uid || tokenLineUid || '').startsWith('demo:'); }`；三處分流：同檔 529-539（PATCH /me，`console.log('[parent-sync] demo 帳號編輯：僅更新本地鏡像', ...)` 後直接 return）、:589（POST /me/students）、:701（學員編輯）；背景同步跳過：同檔 462 `if (!p.registration_pending && !fresh && p.line_uid && !String(p.line_uid).startsWith('demo:')) {`；demo 註冊已另行封死：server/routes/auth.js:1671-1678 `const demoNewUser = process.env.ALLOW_DEMO_LOGIN === '1' && req.body?.demo === true; if (demoNewUser) { res.status(410).json({ error: 'Demo 新用戶註冊已停用；請使用固定測試帳號登入', code: 'DEMO_REGISTER_DISABLED' }); return null; }`


#### 判準不一致（14 條）

**1. replit.md 寫「production 必須設 REQUIRE_LINE_ID_TOKEN=1」，但這個開關對家長端完全沒有作用：家長的每一支登入／綁定／註冊端點都無條件要求並驗證 id_token，不管什麼環境。這個開關只有教練端在用。**
- 依據：文件：replit.md:144「production 必須設 `REQUIRE_LINE_ID_TOKEN=1`、`RAGIC_FIELD_Z01_LINE_UID=1006846`」；家長端：server/routes/auth.js:402-406 無條件 `if (!idToken) { res.status(400).json({ error: 'id_token 必填', code: 'ID_TOKEN_REQUIRED' }); return null; }`；旗標唯一使用者：server/routes/coaches.js:287 與 :300 `} else if (isLineVerificationRequired()) {` / `if (isLineVerificationRequired()) {`
- 註：證據對得上。grep isLineVerificationRequired 全 server/ 只有 lineAuth.js:149 定義處、:155 export 與 coaches.js 兩處使用，零家長端使用。補一個減輕因素：docs/line_setup.md:27、:162、:175 有把這個旗標明確限定在「教練 by-phone endpoint 不再接受首次綁定」，所以會誤導的只有 replit.md:144 那份裸列表。家長端比文件描述更嚴格，方向上是安全的。

**2. 程式在判斷「這支 LINE 是不是已經綁給別人了」時只看啟用中的家長，但資料庫的唯一鍵是不分啟用與否的。也就是說：如果有一筆已停用的舊家長還佔著同一支 LINE UID 或同一支手機，程式檢查會放行，但真正寫入時會被資料庫擋下。**
- 依據：程式檢查（只看 active）：server/routes/auth.js:853-854 「1) 本地 line_uid 已綁到不同手機（只看 active 記錄；inactive 舊列不應擋重新綁定）」＋`SELECT phone FROM parents WHERE line_uid = $1 AND is_active = TRUE LIMIT 1`；資料庫（不分 active）：server/bootstrap/coreSchema.js:112 `line_uid VARCHAR(100) UNIQUE`
- 註：證據對得上。撞到時兩個入口呈現完全不同：新戶註冊被歸類成 ACCOUNT_RECOVERY_REQUIRED（server/services/z03IdentityClaim.js:102 `parents_line_uid_key: 'ACCOUNT_RECOVERY_REQUIRED'`）；Ragic 同步路徑則在 SAVEPOINT 內放棄寫 UID 重試一次、其餘欄位照常同步（server/services/parentSync.js:327-331）。補一筆：registerNewParentLocalFirst 的本地查詢（z03IdentityClaim.js:152-156）連 is_active 都不篩，所以它看得到停用列、反而不會撞鍵——三個入口對同一件事有三種行為。

**3. 系統裡有兩套並存、互不取代的「把 LINE 接上舊帳號」流程：舊的一次到位版（parent-bind-phone / parent-register-line）與新的封閉狀態機。LIFF 家長端從頭到尾只呼叫舊版；新版端點沒有任何前端在用。**
- 依據：程式碼註解自陳：server/routes/auth.js:492-495 「這三支是『新增』端點，與既有 parent-bind-phone/parent-register-line 並存，不互相取代……等前端完成對接封閉狀態機後，舊端點才會真正停用」；前端只有三支舊端點：client/liff/src/api/auth.js:7-54（parentLineLogin / parentBindPhone / parentRegisterLine），全 client/ grep `flow_token|flowToken|verify-phone|verify-student|/auth/bind|/auth/register` 零命中
- 註：證據對得上，但措辭要更正：新流程是**四支**端點不是三支——verify-phone（auth.js:505）、verify-student（:572）、bind（:666）、register（:1694），四支都掛 requireFlowToken。這是本面向最重要的一條：下面幾條「次數限制／速率限制／登記電話比對」的防線全部只長在沒人走的新流程上。任何「我們有防列舉、有 3 次上限」的說法，對實際使用者走的路徑都不成立。

**4. 實際使用者走的舊綁定流程（parent-bind-phone）與舊註冊流程（parent-register-line）沒有任何速率限制、也沒有任何認領失敗次數上限 —— 學員姓名可以無限次猜。**

- 誰能做：任何人（只要有一張有效的 LINE id_token）
- 依據：舊端點掛載處沒有任何限流中介層：server/routes/auth.js:841 `router.post('/parent-bind-phone', async (req, res) => {`、同檔 1666 `router.post('/parent-register-line', async (req, res) => {`（對照新端點 auth.js:505 `router.post('/verify-phone', requireFlowToken, verifyPhoneRateLimit, async (req, res) => {`）；掛載處亦無全域限流：server/index.js:72 `app.use('/api/auth', require('./routes/auth'));`
- 註：證據對得上，而且我額外確認過：grep -i 'ratelimit|helmet' 在 server/index.js 零命中，整個 app 層沒有任何全域限流中介層，所以 /api/auth 上的舊端點確實裸奔。前端認領失敗只是把畫面退回輸入頁讓你再試（client/liff/src/pages/LoginPage.jsx:340-343 `showPhoneEntry('學員姓名或登記手機號碼與資料不符，請確認後再試。')`），沒有計數。這是新舊流程差異造成的實質防線缺口。

**5. 同一件「學員姓名算不算對上」，系統裡有兩套不同的正規化規則：一套把姓名中間的空白全部刪掉（「王 小明」＝「王小明」），另一套只把連續空白壓成一個（「王 小明」≠「王小明」）。走哪一套取決於你是從哪個入口進來的。**
- 依據：刪除全部空白：server/services/identityNormalizer.js:20-26 `return String(value || '').normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();`；壓成單一空白：server/services/parentSync.js:680-682 `return String(v || '').trim().toLowerCase().normalize('NFKC').replace(/\s+/g, ' ');`
- 註：證據對得上（兩段的鏈式順序與引述略有差異，語意一致）。走 parentSync 那套（空白敏感）的：verify-student（auth.js:623）與 parent-bind-phone（auth.js:949）的認領比對。走 identityNormalizer 那套（空白不敏感）的：Z03 認領（z03IdentityClaim.js）、新戶註冊（auth.js:1194、1270 的 normalizeStudentName）、帳號恢復的學員比對（server/services/parentAccountRecovery.js:78 `normalizeStudentName(row.name) === studentNameNormalized`）。名字中間有空白的學員（常見於英文名或複姓輸入習慣）會在一個入口通過、另一個入口失敗。

**6. 「登記手機號碼」這道第二關卡的嚴格程度，會因為這個家庭的資料在哪裡而完全不同。如果家庭資料還停在本地待處理池（Z03，即舊客戶尚未開通者），系統只檢查你填的登記電話等於你上一步剛輸入的那支電話 —— 等於同一個號碼打兩次就過，實質上只有學員姓名一道關卡。只有在「這支電話已經綁給另一支 LINE、要走帳號恢復」時，才會真的拿去跟 Ragic 上登記的電話比對。**

- 誰能做：家長自己
- 依據：弱檢查（自己比自己）：server/routes/auth.js:260-271 `const claimPhone = normalizePhone(claim.phone || phone); const canonicalPhone = normalizePhone(phone); ... if (claimPhone !== canonicalPhone) { return res.status(409)... }`（之後 272-283 直接進 claimZ03Identity，不再比對任何來源電話）；強檢查（比 Ragic）：同檔 949 `const verdict = parentSync.classifyStudentPhoneClaim(ragicStudents, claim, mapped.phone || phone);`
- 註：證據對得上，而且比敘述更寬：`claim.phone || phone` 這個 fallback 意味著連「填」都可以省——claim 完全不帶 phone 時它會自動取用上一步的 phone，比較必然通過。舊客戶開通（Ragic Z01 的 UID 欄位空白）也會被 hydrate 進 Z03 後走弱檢查那條（auth.js:926-939）。所以正常舊生開通＝「電話＋學員姓名」兩要素；帳號恢復＝「電話＋學員姓名＋Ragic 登記電話」三要素。

**7. parent_line_uid_bindings（LINE UID 綁定歷程表）只有「帳號恢復換綁」會寫：把舊 UID 標成 REPLACED、寫入新 UID 為 ACTIVE。註冊、綁定、櫃台解除綁定都不會動它，而且正式程式沒有任何一行會讀這張表 —— 它不參與任何授權判斷。**

- 誰能做：沒有人（除帳號恢復自動寫入外）
- 依據：唯一寫入者：server/services/parentAccountRecovery.js:328-346（INSERT ACTIVE 舊 UID → `UPDATE parent_line_uid_bindings SET status='REPLACED',revoked_at=$2,replaced_by_uid_hash=$3` → INSERT ACTIVE 新 UID）；建表＋一次性回填：server/bootstrap/coreSchema.js:1519-1532；狀態定義 db/migrations/024_parent_identity_release_hardening.sql:124 `status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','REPLACED'))`
- 註：結論對，但兩處數字要更正：(1) grep 在 server/ 是 **7** 處命中（coreSchema.js 的 1519/1527/1528/1529 四行＋parentAccountRecovery.js 的 329/336/342 三行），不是 4 處；(2)「全系統沒有任何一行程式會讀」要限定在正式程式——tests/release/account_recovery_integration.js:221-222 有 SELECT COUNT(*) 拿它做斷言。實質結論不變：零 SELECT 在 server/，不參與授權。REVOKED 這個狀態值在程式裡從未被寫入。表上有兩個部分唯一索引（uid_hash where ACTIVE、canonical_parent_id where ACTIVE，coreSchema.js:1527-1528）。真相是 parents.line_uid。

**8. 櫃台解除綁定不會把 parent_line_uid_bindings 裡那支舊 UID 的 ACTIVE 紀錄改掉，所以稽核表上會留下「這支 UID 仍然 ACTIVE」而實際上早已解除。之後這位家長若走帳號恢復換綁，換綁流程會再插一筆同家長的 ACTIVE 紀錄。**
- 依據：解除綁定只寫 rebind_audit、不寫 bindings：server/routes/admin/customerParents.js:221-228 `INSERT INTO parent_line_uid_rebind_audit (...) VALUES ($1,$2,$3,$4,'ADMIN_BACKOFFICE',$5,$6,'ADMIN_UNBIND',gen_random_uuid(),NOW(),NOW())`（我逐行讀過整個 handler 178-275，無任何 parent_line_uid_bindings 操作）；換綁會補插：server/services/parentAccountRecovery.js:328-334 `INSERT INTO parent_line_uid_bindings (...) VALUES ($1,$2,'ACTIVE',...) ON CONFLICT DO NOTHING`
- 註：證據對得上。因為正式程式沒有讀這張表，目前不會造成功能故障；但若日後有人拿它當「這支 LINE 現在綁誰」的依據，資料是錯的。另外 uq_parent_line_uid_binding_active_parent（同一家長只能有一筆 ACTIVE）在解除綁定後仍被舊紀錄佔著——換綁時那筆 INSERT 帶 ON CONFLICT DO NOTHING（:332）所以不會炸，但緊接的 UPDATE ... WHERE status='ACTIVE'（:336-340）會把舊紀錄標成 REPLACED，等於用換綁替解除綁定補做了收尾。

**9. 註冊流程裡「同一支 LINE 對到多筆歷史來源、又挑不出唯一勝出者」那條路，程式會直接崩掉回 500，家長看到「註冊失敗」，而且該有的人工協處工單根本不會被建立。原因是回應裡引用了一個在這個函式裡不存在的變數。**
- 依據：server/routes/auth.js:1222-1227 `return res.status(409).json({ error: '同一 LINE 帳號有多筆歷史來源，需完成帳號確認', code: 'ACCOUNT_CONFIRMATION_REQUIRED', internalCode: 'MULTIPLE_UID_SOURCE_NO_WINNER', retryable: false, correlationId: duplicateUidCorrelationId, loginAllowed: false, ... })`；該變數唯一宣告處在另一個 handler：同檔 711 `const duplicateUidCorrelationId = crypto.randomUUID();`（位於 `router.post('/bind', ...)` 內，666-797），_registerParentCore 定義於 1055-1664，scope 不相通
- 註：證據對得上——我跑 grep duplicateUidCorrelationId 確認全檔只有三處：711（宣告，在 /bind 內）、722（同 handler 內合法使用）、1225（跨 scope 的非法引用）。同一個 handler 裡還有一段完全對稱的註解，記錄 /bind 端點曾有一模一樣的 bug 已修（auth.js:714-718 「sourceIds 在這個 scope 不存在（它宣告在 _registerParentCore 裡）……而沒有任何人知道他們卡住了」），但註冊端這一處還在。緩解因素：整段只在 PARENT_IDENTITY_RESOLVER_V2 打開時才會跑到（auth.js:1175），而該旗標預設關閉（server/config/ragicSchema.js:83）。

**10. 「這支手機在系統裡存不存在」這個問題，三個入口查的地方不一樣：新流程的電話驗證查「本地待處理池 Z03 ＋ Ragic 家長主檔」（完全不查本地家長表）；舊綁定流程查「本地啟用中家長 ＋ Z03 ＋ Ragic」；團報的免登入電話查詢則查「本地家長表，不分啟用與否」。**
- 依據：新流程（無以 phone 查本地 parents 的查詢）：server/routes/auth.js:524-552 `z03ByPhone = await ragicAdmin.findZ03RecordByPhone(phone); ... ragicRow = await ragic.getParentByPhone(phone); ... if (!ragicRow) { return respond(200, { status: 'not_found' }); }`；舊流程：同檔 863 `SELECT line_uid FROM parents WHERE phone = $1 AND is_active = TRUE LIMIT 1`；團報：server/routes/groupOrders.js:380 `SELECT id, name FROM parents WHERE phone = $1 LIMIT 1`
- 註：證據對得上。補一個精確化：verify-phone 仍會先用 lineUid（不是 phone）查本地啟用中家長走快速通道（auth.js:515），所以「完全不查本地家長表」要限定在「不用 phone 查」。另補查確認 findZ03RecordByPhone 讀的是本地表 `ragic_z03_records`（server/services/ragicAdmin.js:3644-3653），而且只認 status='pending' 或 (status='manual_review' AND reason_code='AMBIGUOUS_STUDENT_MATCH') 兩種狀態，已 resolved／dismissed 的列查不到。實務後果如原註所述：某支手機在本地是啟用中的家長，但在 Ragic／Z03 都查不到（例如 outbox 還沒回寫成功的新戶），新流程會回 not_found 把人導去註冊，註冊時卻會撞上 PHONE_ALREADY_BOUND_TO_OTHER_LINE 409 —— 一條死路。

**11. 新流程的「帳號恢復」永遠走不通，會把家長困在一個無法通過的關卡：綁定那一步要求「流程票上必須帶有已驗過的學員姓名」才願意開立帳號恢復案件，但整個系統沒有任何一處會把學員姓名寫進流程票 —— 連第三步（學員姓名驗證通過）簽出的新票也沒有。結果是：手機已被另一支 LINE 綁走的家長，在新流程裡只會一直收到「帳號恢復前必須重新完成學員驗證」，而重新驗證再多少次都不會改變結果。** 〔覆核時補上〕
- 依據：消費端：server/routes/auth.js:668 `const { phone, lineUid, studentName: verifiedStudentName } = req.flow;` → 同檔 710 `if (!verifiedStudentName) { ... return res.status(409).json({ error: '帳號恢復前必須重新完成學員驗證', code: 'ACCOUNT_RECOVERY_VERIFYING', ... }); }`，只有 :733-741 `requestAccountRecovery({ ... studentName: verifiedStudentName, ... })` 那條路會真的發驗證碼；生產端：grep signFlowToken( 在 server/routes/ 只有五處，全都不傳 studentName —— auth.js:475 `signFlowToken({ lineUid })`、:539 與 :559 與 :632 `signFlowToken({ lineUid, phone, attempts: 0 })`、:648 `signFlowToken({ lineUid, phone, attempts: nextAttempts })`；欄位本身是有的：server/middlewares/flowAuth.js:21 `function signFlowToken({ lineUid, phone = null, attempts = 0, studentName = null })`、:28、:51 `studentName: payload.studentName || null`

**12. 新流程對「舊客戶還在本地待處理池（Z03）」這群人的兩道指示互相打架：第二步查到電話落在 Z03 時，程式註解明寫要把人導去註冊表單補齊資料，並簽出一張帶著這支電話的流程票；但註冊端點看到票上有電話就一律判定為「撞號可疑行為」，轉人工待審、不讓完成註冊。等於註冊這條路對這批人是封死的。** 〔覆核時補上〕
- 依據：指示：server/routes/auth.js:521-523 「本地 Z03 已有殘缺記錄（未綁定/未開通）→ 電話存在但資料不完整，導去 S4 REGISTER_NEW 由註冊表單補齊」＋同檔 539-540 `const newToken = signFlowToken({ lineUid, phone, attempts: 0 }); return respond(200, { status: 'found', reason: 'z03_pending', flow_token: newToken });`（票上帶 phone）；封死處：同檔 1696-1715 `const { lineUid, phone } = req.flow; ... if (phone) { ... parentSync.auditClaim({ phone, lineUid, result: 'phone_collision_blocked', reason: 'register_phone_collision' }); return res.json({ status: 'pending_review', reason: 'phone_collision' }); }`（註解 1689-1693 假設「flowToken 帶有 phone 時，代表是從 S3 verify-student 三次驗證失敗的 phone_collision 轉入」，但 z03_pending 也會帶 phone）；規模線索：同檔 536-537 「命中這條分支的正是『註冊到一半沒完成』的那群人（正式站 873 支電話）」

**13. 「每次呼叫 API 都即時確認家長還在啟用中」這道檢查沒有套滿：團報分享連結的預覽與免登入電話查詢，以及優惠試算，走的是另一個寬鬆版的身分解析，它只驗簽章與票的類型，完全不回資料庫確認帳號狀態。所以已被停用或解除綁定的家長，手上那張還沒過期的通行證在這幾支端點上仍會被當成本人（會影響「這是不是你自己」「你是不是已在這一團」的判斷）。** 〔覆核時補上〕
- 依據：嚴格版（有 DB 檢查）：server/middlewares/parentAuth.js:42-48 `const r = await pool.query('SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE', [p.parentId]); if (!r.rowCount) return res.status(401)...`；寬鬆版（無 DB 檢查）：同檔 83-94 `function optionalParent(req, _res, next) { ... const p = jwt.verify(token, getSecret()); if (p.type === 'parent') { req.parent = { id: p.parentId, phone: p.phone, lineUid: p.lineUid || null }; } ... next(); }`；使用處：server/routes/groupOrders.js:350 `router.get('/by-token/:token', previewRateLimit, optionalParent, ...)`、:370 `router.post('/by-token/:token/lookup-phone', lookupRateLimit, optionalParent, ...)`（:396 `is_self: req.parent?.id === parent.id`）、server/routes/promotions.js:56 `router.post('/preview', optionalParent, ...)`；同款不對稱亦見 parentAuth.js:64-78：requireLiffUser 對 parent 做 is_active 檢查，對 coach 完全不做

**14. 「家長的 LINE UID 絕對不外流」這條只成立在家長端。後台的家長管理 API 會把完整未遮罩的 LINE UID 直接回給前端，而同一筆回應裡學員的身分證字號與血型卻是預設遮罩、要加參數並寫稽核才看得到原值。也就是說同一支 API 對兩種個資採兩套標準。** 〔覆核時補上〕
- 依據：UID 不遮罩：server/routes/admin/customerParents.js:35-37 `const PARENT_COLS = \`p.id, p.line_uid, p.phone, p.name, ...\`` ＋ 同檔 39-43 `function rowToParent(r, studentCount = 0) { return { id: r.id, line_uid: r.line_uid || null, line_bound: !!r.line_uid, ... } }`（另有一個現成的 line_bound 布林，顯示需求其實只要它）；學員個資遮罩：同檔 61-69 `id_number: reveal ? (r.id_number || '') : maskId(r.id_number), ... blood_type: reveal ? (r.blood_type || '') : maskBlood(r.blood_type)` ＋ 檔頭政策 同檔 18 「PII：身分證/血型預設遮罩，需帶 ?reveal=1（並寫稽核）才回原值」；對照家長端的處理：server/routes/auth.js:215-216 與 client/liff/src/api/client.js:69-70


#### 只在文件裡（程式沒有／不同）（2 條）

**1. replit.md 寫的「家長 LINE-first（自動 id_token → Ragic Z01 查詢 → 缺手機就綁手機）」以及「parent-line-login UID 查無時新增電話反查備援（改用電話反查 Ragic，命中同 UID 就照常登入）」，在現行程式裡已經不存在：登入端點完全不碰 Ragic，查不到本地資料就直接進手機綁定。**
- 依據：文件：replit.md:138「家長 **LINE-first**（自動 id_token → Ragic Z01 查詢 → 缺手機就綁手機 → 缺資料就註冊）」、replit.md:207「(a) `parent-line-login` UID 查無時新增「電話反查備援」——本地已綁此 UID 的家長改用電話反查 Ragic，命中同 UID 就照常登入」；程式：server/routes/auth.js:471-480 「找不到本地 Z01 → 進電話多方驗證/註冊補資料，不在登入路徑打 Ragic」＋`return res.json({ status: 'need_phone_binding', reason: 'local_z01_not_found', flow_token: flowToken })`
- 註：證據對得上。整支 parent-line-login handler（auth.js:458-485）我逐行讀過，確實零 Ragic 呼叫。文件描述的是 2026-07-03 定案前的行為。交接時要以程式為準，否則會誤判「為什麼 Ragic 有資料卻要我重新綁定」。

**2. 「舊客戶開通時，如果 Ragic 上存了學員身分證字號就必須姓名＋身分證都對上；Ragic 上沒存身分證則姓名精確對上即放行」這條 2026-07-03 政策，在現行程式裡走不到：判斷邏輯所在的整段程式碼位於一個無條件 return 之後，只有回滾情境才會執行。現行路徑走 claimZ03Identity，只比對學員姓名，完全不看身分證。**

- 誰能做：—（現行路徑無人走到）
- 依據：死碼位置：server/routes/auth.js:1439-1447 `return _completeLocalZ03Claim(req, res, { phone, lineUid, successStatus: 'registered_and_logged_in', allowStudentAppend: true, ... });` 緊接 auth.js:1448 `/* istanbul ignore next -- frozen rollback-only legacy code */`，身分證版判斷在 1471-1509；唯一呼叫者驗證：grep classifyStudentClaim 全 server/ 只有 parentSync.js:693 定義、:664 一個零呼叫者的 wrapper matchStudentClaim、:781 export，以及 auth.js:1478（即該死碼區塊內）
- 註：kind 改正：原列 [implemented]，但它描述的機制在現行程式無法執行，屬「文件／註解寫過、實作不同」。原註已正確指出死碼，只是 kind 沒跟著改。政策說明本身在 replit.md:208 與 auth.js:1464-1469 都存在且對得上（含「2/3 的學員端沒有身分證字號可比對」的理由）。稽核值 passed_no_id_on_file 也只在該死碼區塊寫入（auth.js:1504-1508）。交接重點：對舊客戶開通，現行實際只要「電話＋學員姓名」，不要對外宣稱有身分證這道關卡。


### 3.2 解綁、自助重綁與帳號救援


#### 實作中（40 條）

**1. 客服可以解除某位家長的 LINE 綁定。這個動作只解除「哪一支 LINE 能登入這個帳號」，學員、報名、上課紀錄、家長業務資料全部保留不動。**

- 誰能做：櫃檯／後台（被授予 customer-parents 權限的角色）
- 依據：server/routes/admin/customerParents.js:213 `UPDATE parents SET line_uid = NULL, last_synced_at = NULL, updated_at = NOW() WHERE id = $1`；整個端點（178-275）除此之外只 INSERT 稽核表，未出現 students / enrollments / course_period_enrollments 任何表
- 註：端點 POST /api/admin/customer-parents/:id/unbind-line。我逐行讀完 178-275 全段，確認沒有任何學員/報名相關寫入。註解在 :175「不動的東西：學員、報名、上課紀錄、家長的業務資料全部保留」。另外 last_synced_at 也被清成 NULL（:213），設計意圖見 :211-212 註解。

**2. 解除綁定的權限不是寫死的角色清單，而是讀「角色權限管理」設定表；manager/staff 只能對自己場館（primary_venue_id 在可見範圍內）的家長操作，admin 全域，不在範圍內一律當「找不到此家長」回 404。**

- 誰能做：櫃檯／後台（依角色權限設定，manager/staff 限自己場館）
- 依據：server/routes/admin/customerParents.js:178 `router.post('/:id/unbind-line', requireAdminAuth, requireResource('customer-parents'), ...)`；:188 `if (!(await parentInScope(client, req, req.params.id))) { ... return res.status(404).json({ error: '找不到此家長' })`；server/middlewares/adminAuth.js:82 `if (u.role === 'admin') return null;`
- 註：查無場館（primary_venue_id 為空）的家長只有 admin 動得了（adminAuth.js:96 註解 + isVenueInScope `if (!venueId) return false`）。requireResource 讀不到權限設定時一律拒絕（requireResource.js:52-55 `console.error(... 一律拒絕) ; return deny(res)`）。

**3. 解除綁定必須填寫原因，1 到 500 字之間；原因會連同操作人一起寫進換綁稽核表。**

- 誰能做：櫃檯
- 依據：server/routes/admin/customerParents.js:180 `if (!reason) return res.status(400).json({ error: '請填寫解除綁定的原因', code: 'REASON_REQUIRED' });`；:181 `if (reason.length > 500) ... code: 'REASON_TOO_LONG'`
- 註：前端在送出前也擋一次（client/admin/src/pages/CustomerParentsPage.jsx:109 `if (!reason) { toast.warning('請填寫解除原因'); return; }`）。原因與操作人寫進 parent_line_uid_rebind_audit 的 reason / initiated_by 欄（:222-228）。

**4. 沒有綁 LINE 的家長不能解綁；只綁著 demo 測試哨兵 UID（demo: 或 DEMOTEST_ 開頭）的家長也視為「沒有綁定」，一律回 409 NOT_BOUND。**

- 誰能做：沒有人（系統擋下）
- 依據：server/routes/admin/customerParents.js:80-82 `return !!s && !s.startsWith('demo:') && !s.startsWith('DEMOTEST_');`；:201 `if (!isRealLineUid(parent.line_uid)) { ... code: 'NOT_BOUND' }`

**5. 解除綁定的稽核紀錄只留 LINE UID 的 sha256 雜湊，完整 UID 不進資料庫也不進 log；因為稽核表的「新 UID」欄位不可為空，這裡放一個固定哨兵值，並用理由碼 ADMIN_UNBIND 標示「這筆是解綁、不是換綁」。**

- 誰能做：系統自動（隨解綁動作寫入）
- 依據：server/routes/admin/customerParents.js:226-228 `VALUES ($1,$2,$3,$4,'ADMIN_BACKOFFICE',$5,$6,'ADMIN_UNBIND',gen_random_uuid(),NOW(),NOW())` / `[parent.id, parent.ragic_record_id || null, sha(oldUid), sha('ADMIN_UNBIND'), actor, reason]`；欄位 NOT NULL 定義見 server/bootstrap/coreSchema.js:1538 `old_uid_hash CHAR(64) NOT NULL, new_uid_hash CHAR(64) NOT NULL`
- 註：寫的是同一張 parent_line_uid_rebind_audit；這筆沒有 recovery_request_id（該欄可為空，coreSchema.js:1537），靠 reason_code 與救援換綁區分。設計意圖見 :218-220 註解。

**6. 解除綁定的執行順序固定是「先清本地並 COMMIT，再清 Ragic Z01 的 LINE UID 欄位」；Ragic 那一步失敗不回滾本地，只在 API 回應裡告知客服「若要換一支 LINE 會被擋，請先人工清掉 Z01 的 LINE UID 欄位」。**

- 誰能做：系統自動（順序不可調）
- 依據：server/routes/admin/customerParents.js:229 `await client.query('COMMIT');`；:236-243 `ragicWriter.writeField('Z01', parent.ragic_record_id, ragic.FIELD.Z01.LINE_UID, '', ...) } catch (e) { ragicError = e.message; console.warn('[unbind-line] Ragic Z01 UID 清除失敗（本地已解除）:' ...`
- 註：家長在 Ragic 沒有對應紀錄（ragic_record_id 為空）時，Ragic 那步整個跳過並回報原因（:245-246 `ragicError = '此家長在 Ragic 沒有對應紀錄（ragic_record_id 為空）'`）。前端在 ragic_cleared 為 false 時用警告色而非成功色（CustomerParentsPage.jsx:115-116）。順序不可顛倒的理由寫在端點上方註解 :163-173。

**7. 解除綁定不會註銷家長手上已經簽出的登入憑證：登入憑證有效期 12 小時，每次請求只檢查「這個家長 id 還存在且在職」，不比對目前綁定的 LINE UID。手機被盜的情境下，解綁之後被盜端最多還能繼續操作到憑證自然過期。**

- 誰能做：沒有人（沒有強制登出機制）
- 依據：server/middlewares/parentAuth.js:14 `const TTL = '12h';`；:43 `SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE`（無 line_uid 比對）；:50 `req.parent = { id: p.parentId, phone: p.phone, lineUid: p.lineUid || null };`
- 註：requireLiffUser（parentAuth.js:67）與 optionalParent（:87-89）用同一套判準，也不比對 UID。要立刻切斷只能改走「停用家長」（is_active=FALSE），但停用會讓帳號整個不能用。交付文件也只說舊憑證「自然過期」（docs/parent-identity-release-evidence-2026-07-13.md:58 `Existing old JWTs naturally expire under the frozen JWT contract`）。

**8. 解除綁定之後家長重新綁定，走的是一般的「電話＋學員姓名認領」流程，不是帳號救援：系統靠 Ragic 來源記錄與家長的對應表（source_record_links）認回原本那位家長，確認電話一致且該家長目前沒綁任何 LINE，就直接把新 UID 寫進去，不需要任何人核准。**

- 誰能做：家長自己
- 依據：server/services/z03IdentityClaim.js:876-878 `if (linkedParent.line_uid !== lineUid) { await client.query('UPDATE parents SET line_uid=$2, updated_at=NOW() WHERE id=$1', [linkedParent.id, lineUid]); linkedParent.line_uid = lineUid;`
- 註：這條重綁路徑不寫 parent_line_uid_rebind_audit、不寫 parent_line_uid_bindings、不產生救援案件，也沒有複核人／原因／證據欄位（我讀完 855-930 全段確認）。等於「客服解綁 → 家長自助換 LINE」這條線上，換綁那一刻沒有任何稽核紀錄。

**9. 重綁時「認回原本的家長」的判準是：Ragic 來源記錄在對應表上指到的那位家長，其電話正規化後必須等於家長本次輸入的電話；不相等就回 409（來源已連結另一個家庭），不會建立第二位家長。**

- 誰能做：系統自動
- 依據：server/services/z03IdentityClaim.js:867-869 `if (normalizePhone(linkedParent.phone) !== phoneCanonical) { throw new Z03ClaimError('SOURCE_RECORD_ALREADY_LINKED', 'source record 已連結另一個 phone', 409); }`
- 註：另外若該來源已連結的學員姓名與本次認領的學員姓名正規化後不同，也回同一個 409（:873-875）。對應表上的家長不存在（孤兒連結）則回 ORPHAN_CLAIM_CONFLICT（:866）。

**10. 如果客服「沒有」先解綁，家長直接拿新 LINE 走認領流程，會在本地認領交易裡被擋下（該家長已綁另一支 LINE），而且不會產生任何救援案件與驗證碼。**

- 誰能做：沒有人（系統擋下）
- 依據：server/services/z03IdentityClaim.js:870-872 `if (linkedParent.line_uid && linkedParent.line_uid !== lineUid) { throw new Z03ClaimError('PHONE_BOUND_TO_OTHER_UID', '手機已綁定另一個 LINE UID', 409); }`；同檔 :917-919 主路徑同樣拋 PHONE_BOUND_TO_OTHER_UID
- 註：家長端錯誤訊息對照表沒有 PHONE_BOUND_TO_OTHER_UID 這一條（client/liff/src/pages/LoginPage.jsx:94-121 的 MAP 我逐項看過），所以會 fallback 到後端原文「手機已綁定另一個 LINE UID」（LoginPage.jsx:127 `if (serverMsg ...) return serverMsg`）——沒有案件編號，客服也沒有東西可以查。這是「換 LINE 帳號」情境最常撞到的一條死路。

**11. 帳號救援案件（會發出一次性驗證碼的那種）目前只有舊的手機綁定端點 /api/auth/parent-bind-phone 會建立，而且前提是家長已經通過「學員姓名＋該學員的登記手機號碼」認領驗證。**

- 誰能做：家長自己（在家長端 LIFF 輸入學員姓名與登記手機）
- 依據：server/routes/auth.js:965-971 `recovery = await requestAccountRecovery({ phone, studentName: claim.student_name, newLineUid: lineUid, ragicRecordId: mapped.ragic_record_id, initiatedBy: 'parent-bind-phone' });`；認領判準在 :949 `const verdict = parentSync.classifyStudentPhoneClaim(ragicStudents, claim, mapped.phone || phone);`
- 註：家長端 LIFF 確實只呼叫這支舊端點：我 grep 過 client/liff/src/ 完全找不到 verify-phone / verify-student / /auth/bind 的呼叫（零命中），只有 client/liff/src/api/auth.js:21 的 parent-bind-phone。認領規則：Ragic 學員子表有「登記電話」欄就比該欄，否則退回比對 Z01 家長手機（server/services/parentSync.js:712-716 `const expectedPhone = _normalizePhone(byName.registered_phone || parentPhone || '');`）。

**12. /bind 在上述情況開的後台工單，理由碼固定寫成「多筆 UID 來源選不出主檔」（MULTIPLE_UID_SOURCE_NO_WINNER），即使這次其實只有一筆來源記錄。**

- 誰能做：系統自動（標示與實情不符）
- 依據：server/routes/auth.js:719-722 `sourceRecordIds: [mapped.ragic_record_id].filter(Boolean), reasonCode: 'MULTIPLE_UID_SOURCE_NO_WINNER', suggestedAction: 'Review source links/student evidence, select one primary Z01, and retain the others as aliases.'`
- 註：同檔 :714-718 的註解說明這段原本引用了不存在的變數（sourceIds，宣告在 _registerParentCore 裡）會直接 500、工單根本不會被建立，修掉之後理由碼沿用了原本的字串。

**13. 帳號救援案件成立的必要條件，全部要同時成立（缺一就不受理）：這支電話在本地在職家長中只能對到「剛好一位」；那位家長現在必須已經綁著一支「不同的」LINE UID；名下必須剛好有一位姓名正規化後完全相符的在籍學員；Ragic Z01 那筆來源的 LINE UID 欄位（1006846）必須非空；那筆來源必須確實屬於這位家長；申請的新 UID 不能已經是另一位在職家長的登入 UID。**

- 誰能做：系統自動（判準無法由人放寬）
- 依據：server/services/parentAccountRecovery.js:151-152 `if (candidates.length !== 1 || parentMatches.length !== 1) throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery requires one canonical parent');`；:155-156 `if (!parent.line_uid || parent.line_uid === requestedUid) throw ... 'Recovery requires a different existing LINE UID'`；:83-87 `if (rows.length !== 1) throw ... 'Account recovery requires one exact canonical student match'`；:98-99 `if (!ragicOldUid) throw ... 'Ragic source does not contain a non-empty field 1006846'`；:109-112 `const parentOwnsSource = String(parent.ragic_record_id || '') === sourceId || String(link?.canonical_parent_id || '') === String(parent.id); if (!parentOwnsSource) throw ...`；:168 `if (otherUid) throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'New LINE UID belongs to another active parent', 409);`
- 註：因為要求「現在必須已綁著另一支 UID」，已經被客服解綁的家長不能走救援，只能走一般認領重綁。學員姓名比對是正規化後完全相等（:78 `normalizeStudentName(row.name) === studentNameNormalized`），不是模糊比對。另外若對應表上的來源已連到別的學員，也擋（:114-116）。

**14. 一位家長同一時間只能有一件進行中的救援案件。已經有一件未過期的案件時，換另一支新 LINE 再申請會被鎖住（ACCOUNT_RECOVERY_LOCKED）；如果那件已經過期，系統會先把它標成 LOCKED 再放行新的申請。**

- 誰能做：系統自動
- 依據：server/services/parentAccountRecovery.js:184-193 `if (active && new Date(active.expires_at).getTime() <= now.getTime()) { ... SET state='ACCOUNT_RECOVERY_LOCKED',locked_at=$2,last_error_code='RECOVERY_TOKEN_EXPIRED' ... } else if (active) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Another new LINE UID is already recovering this parent'); }`；資料庫層另有部分唯一索引 server/bootstrap/coreSchema.js:1508-1510 `uq_parent_recovery_active_parent ... WHERE state IN ('ACCOUNT_RECOVERY_REQUIRED','ACCOUNT_RECOVERY_VERIFYING','ACCOUNT_RECOVERY_VERIFIED','ACCOUNT_REBIND_PENDING')`
- 註：並發撞到那條唯一索引時會被翻成 ACCOUNT_RECOVERY_LOCKED「Concurrent recovery already owns this parent」（:224-226，判斷條件是 `err.code === '23505' && err.constraint === 'uq_parent_recovery_active_parent'`）。

**15. 同一支電話一小時內最多 5 次救援申請，超過回 429；一次性驗證碼有效 15 分鐘，最多試 5 次。三個數字都可以用環境變數調整（下限：時間至少 1 分鐘、次數至少 1 次）。**

- 誰能做：系統自動（數值由環境變數設定）
- 依據：server/services/parentAccountRecovery.js:39-52（PARENT_ACCOUNT_RECOVERY_TTL_MS / _RATE_LIMIT_MAX / _RATE_WINDOW_MS，預設 `15 * 60 * 1000` / `5` / `60 * 60 * 1000`，各自有 `>= 60_000` 或 `>= 1` 下限）；:201-203 `if (recentRequests >= recoveryRateLimit()) throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Account recovery rate limit exceeded', 429);`；max_attempts 預設值見 server/bootstrap/coreSchema.js:1499 `attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5`
- 註：次數上限是以「這支電話的所有申請筆數」計算，不分成功失敗（:196-200 `SELECT COUNT(*)::int AS n FROM parent_account_recovery_requests WHERE phone_canonical=$1 AND requested_at >= $2`）。

**16. 一次性驗證碼只會在案件「第一次建立」時發出一次。同一組（家長＋學員＋來源記錄＋申請的新 LINE UID）算出的案件鍵值固定不變，第二次以後的申請一律回「重播、不附驗證碼」——連原案件已經過期也一樣。家長弄丟驗證碼後，用同一支新 LINE 再也拿不到新的碼。**

- 誰能做：沒有人（沒有重發機制）
- 依據：server/services/parentAccountRecovery.js:170-177 `const requestKey = sha256([parent.id, student.id, sourceId, newUidHash].join(':')); let existing = ... WHERE request_key=$1 FOR UPDATE ...; if (existing) { await client.query('COMMIT'); return safeRecoveryResult(existing, null, true); }`
- 註：我確認這段（:170-177）排在過期檢查（:178-194）之前，且第二個參數 token 傳 null → safeRecoveryResult 的 `recovery_token: token` 為 null（:54-62）。家長端只有在回應帶 recovery_token 時才把驗證碼印出來（client/liff/src/pages/LoginPage.jsx:122-123 `if (code === 'ACCOUNT_RECOVERY_REQUIRED' && data.recovery_request_id && data.recovery_token)`），所以重播那次家長畫面上只有一句通用文案。要拿新碼只能換另一支 LINE 帳號（新 UID 雜湊不同 → 案件鍵值不同），或由人直接改資料庫。

**17. 一次性驗證碼是直接顯示在家長自己手機的錯誤訊息裡，由家長轉述給客服；系統不會另外寄送或通知客服。**

- 誰能做：家長自己（口述／轉貼給客服）
- 依據：client/liff/src/pages/LoginPage.jsx:123 `return `${MAP.ACCOUNT_RECOVERY_REQUIRED} 案件編號：${data.recovery_request_id}；一次性驗證碼：${data.recovery_token}（短效，請只提供給客服）。`;`（client/liff/src/pages/RegisterPage.jsx:101-102 同樣邏輯）
- 註：驗證碼只以 sha256 存在資料庫（parentAccountRecovery.js:215 `... requestedUid, sha256(token), initiatedBy,`；欄位 recovery_token_hash CHAR(64) NOT NULL，coreSchema.js:1498），系統事後無法還原原文。專案沒有接任何簡訊/推播服務（docs/parent-identity-release-evidence-2026-07-13.md:56 `No OTP provider exists in the project`）。

**18. 完成帳號換綁只有系統管理員（role='admin'）做得到，manager/staff 一律不行；而且五樣東西缺一不可：案件編號、家長那支一次性驗證碼、複核人、原因、證據編號。**

- 誰能做：系統管理員（admin）
- 依據：server/routes/auth.js:803-806 `router.post('/parent-account-recovery/manual-complete', requireAdminAuth, requireAdminRole('admin'), ...)`；server/services/parentAccountRecovery.js:246-248 `if (!reviewer || !reviewReason || !evidence) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Reviewer, reason, and evidence reference are required', 400); }`；案件編號與驗證碼為必要入參（auth.js:810-814 `recoveryRequestId: req.body?.recovery_request_id, recoveryToken: req.body?.recovery_token`）
- 註：原稿寫「四樣東西」但列了五項，已改為五樣。複核人取自登入者本身（auth.js:812 `approvedBy: req.adminUser?.username || req.adminUser?.sub`），不能由前端指定。requireAdminRole 不在清單就回 403（adminAuth.js:100-106）。專案沒有接簡訊驗證碼服務，所以人工核對是唯一路徑（auth.js:799-802 註解）。

**19. 完成換綁時，系統在同一個資料庫交易裡把所有條件重新驗一次（家長電話與舊 UID 雜湊沒變、學員仍唯一相符、Ragic 來源的舊 UID 沒被改過、新 UID 還沒被別人拿走），任一項不符就整筆回滾，舊 UID 保持有效。**

- 誰能做：系統自動
- 依據：server/services/parentAccountRecovery.js:297-299 `if (!parent || normalizePhone(parent.phone) !== request.phone_canonical || sha256(parent.line_uid) !== request.old_uid_hash) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Canonical parent identity changed before rebind'); }`；:305-310 `await assertSourceOwnership(client, { parent, student, ragicRecordId: request.ragic_record_id, expectedRagicUidHash: request.ragic_old_uid_hash })`；:351 `if (!reboundParent) throw ... 'Atomic parent rebind compare-and-set failed'`
- 註：換掉 parents.line_uid 用的是 compare-and-set（:348 `UPDATE parents SET line_uid=$2,updated_at=$3 WHERE id=$1 AND line_uid=$4 RETURNING *`），中途被別人改掉就回不了列、整筆失敗回滾。交易內會先對舊 UID 與新 UID 兩個雜湊各上一把 advisory lock（:300-301）。Ragic 來源 UID 被改過的檢查在 :101-103。

**20. 換綁成功那一刻在同一個交易內一次完成八件事：舊綁定列標成 REPLACED 並記下被誰取代、寫入新的 ACTIVE 綁定列、換掉家長的登入 UID、寫入換綁稽核、把身分認領案件推進「等 Ragic 同步」、丟一筆只改 Ragic 欄位 1006846 的同步工作、把 Z03 追蹤列一併更新，最後案件狀態變成 ACCOUNT_REBOUND。**

- 誰能做：系統自動（由 admin 的完成動作觸發）
- 依據：server/services/parentAccountRecovery.js:336-340（REPLACED + replaced_by_uid_hash）、:341-346（新 ACTIVE 列）、:348 `UPDATE parents SET line_uid=$2 ... WHERE id=$1 AND line_uid=$4`、:379 `INSERT INTO parent_line_uid_rebind_audit`、:355-369 identity_claims → 'ACCOUNT_REBIND_SYNC_PENDING'、:390-393 `INSERT INTO ragic_sync_outbox ... 'REBIND_Z01_LINE_UID','RAGIC','Z01',$3,$3,'1006846'`、:398-404 `UPDATE ragic_z03_records SET ... claim_state='ACCOUNT_REBIND_SYNC_PENDING'`、:406 `SET state='ACCOUNT_REBOUND'`
- 註：原稿寫「七件事」但列了八項（含 Z03 追蹤列），已改為八件。狀態機依序經過 VERIFYING → VERIFIED → REBIND_PENDING → REBOUND，每一步都寫一筆事件（:292、:321、:326、:411）。

**21. 換綁失敗時身分資料整筆回滾（家長、學員、同步佇列都不會有半套結果），但系統會另開一個「只寫案件狀態與事件」的交易，把失敗原因留下來，讓人看得出為什麼舊 UID 還有效。**

- 誰能做：系統自動
- 依據：server/services/parentAccountRecovery.js:421-426 `await client.query('ROLLBACK').catch(() => {});` + 註解「The identity mutation remains fully rolled back... This transaction never touches parents, students or outbox.」；:438-443 `UPDATE parent_account_recovery_requests SET state=$2,attempts=LEAST(attempts+1,max_attempts),last_error_code=$3, failed_at=... locked_at=...`
- 註：已經完成（ACCOUNT_REBOUND）的案件不會被這段覆寫（:427 `if (currentRequest && currentRequest.state !== RECOVERY_STATES.REBOUND)`、:436 再查一次 persisted.state）。這個補記交易本身失敗也會靜默回滾（:452-454 `} catch (_) { await client.query('ROLLBACK').catch(() => {}); }`）。失敗原因碼取自 err.code，被 LOCKED 以外的一律記成 ACCOUNT_RECOVERY_FAILED（:430-431）。

**22. 已完成的換綁案件再送一次：拿對驗證碼會回「已完成、這是重播」並回傳同一位家長，不會再做第二次變更；驗證碼不對則回 ACCOUNT_RECOVERY_LOCKED。**

- 誰能做：系統管理員（admin）
- 依據：server/services/parentAccountRecovery.js:259-265 `if (request.state === RECOVERY_STATES.REBOUND) { if (!recoveryTokenMatches(request, recoveryToken)) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'Recovery replay token is invalid', 409); } ... return { parent, state: request.state, replayed: true, correlation_id: request.correlation_id };`
- 註：驗證碼比對用的是時間恆定比較（:32-37 `crypto.timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(String(request.recovery_token_hash)))`）。這個重播分支排在最前面，所以不會累加 attempts。

**23. 換綁後舊 LINE UID 在本地不會被保留成可登入身分：家長的登入 UID 直接被換成新的，舊 UID 只以 sha256 雜湊留在綁定歷史（狀態 REPLACED）與換綁稽核裡。舊 LINE 帳號再開系統會被當成新用戶導去電話驗證。**

- 誰能做：系統自動
- 依據：server/services/parentAccountRecovery.js:336-340 `UPDATE parent_line_uid_bindings SET status='REPLACED',revoked_at=$2, replaced_by_uid_hash=$3,updated_at=$2 WHERE canonical_parent_id=$1 AND status='ACTIVE'`；登入只看本地 UID：server/routes/auth.js:464-469 `// 定案規則（2026-07-03）：登入只看本地 Z01 鏡像的 LINE UID。` + `if (await _respondExistingParentFastPath(res, lineUid, 'logged_in', true)) return;`
- 註：_respondExistingParentFastPath 只查本地（auth.js:235 `const local = await parentSync.findActiveParentByLineUid(lineUid);`），查無就回 need_phone_binding（auth.js:475-480）。換綁前已簽出的舊憑證仍可用到 12 小時到期（見「解綁不會註銷憑證」那條，判準相同）。

**24. Ragic 那一邊的 UID 改寫是事後非同步做的：同步工作成功才把案件與換綁稽核的同步狀態改成 SYNCED，失敗則留在 ACCOUNT_REBIND_SYNC_PENDING 並指數退避重試（上限 1 小時一次）；最終判定不可重試時會自動開一張後台工單。**

- 誰能做：系統自動
- 依據：server/services/ragicSyncOutbox.js:176-188 `UPDATE parent_account_recovery_requests r SET ragic_sync_state='SYNCED' ...` 與 `UPDATE parent_line_uid_rebind_audit a SET ragic_sync_state='SYNCED' ...`（都包在 :174 `if (isRebind)` 內）；:402 `const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, Number(job.attempts) - 1)));`；:460-474 `if (failure.outboxState !== 'retryable') { ... await createParentIdentityBackofficeTask({...})`
- 註：同一筆成功也把 identity_claims 推到 ACCOUNT_REBOUND（:160-163 `[job.claim_id, isRebind ? 'ACCOUNT_REBOUND' : 'SYNCED']`）。Ragic 同步失敗不影響本地換綁結果：家長已經可以用新 LINE 登入。

**25. 換綁那筆 Ragic 同步工作預設不做寫入前後的讀回驗證，也不套用「Ragic 上已經是別人的 UID 就停手」那道保護——它的用途就是覆蓋舊 UID。**

- 誰能做：系統自動
- 依據：server/services/parentAccountRecovery.js:393-396 的 payload 只帶 `JSON.stringify({ recovery_request_id: request.id, canonical_parent_id: parent.id })`（沒有 verify_readback、沒有 skip_uid_write）；server/services/ragicSyncOutbox.js:524 `const shouldReadback = forceReadback || ref.verify_readback;`、:533-537 `if (currentUid && currentUid !== parent.line_uid) { ... code = 'PARENT_LINE_UID_MISMATCH' ...`（整段包在 `if (shouldReadback)` 內）
- 註：對照一般綁定（BIND_Z01_LINE_UID）在註冊補資料情境會帶 verify_readback（z03IdentityClaim.js:1053 `verify_readback: registrationCompletion`）。單筆工作處理器的 forceReadback 預設 false（ragicSyncOutbox.js:490），批次入口預設 true（:652）—— 所以同一筆工作走批次會做讀回、走單筆不會。

**26. 一支電話在 Ragic Z01 對到多筆來源記錄時，一般認領流程有六級證據排序決定哪一筆是主檔（既有對應關係 → UID 相符 → 家長既有來源編號 → 學員來源證據 → 報名來源證據 → 唯一可寫的空白來源）；排不出唯一贏家就「不選」，改成：本地照樣建立／沿用一位家長讓家長登得進去，其餘每一筆都標成別名（MULTIPLE_SOURCE_ALIAS），不丟任何 Ragic 寫入，並開一張後台工單。**

- 誰能做：系統自動
- 依據：server/services/parentIdentityResolver.js:196-236（六級排序，每級都用 `oneWinner(...)` 要求候選收斂成剛好一筆）；server/services/z03IdentityClaim.js:720-721 註解 `// Evidence-only winner order. No ID ordering, timestamps or first-row // fallback may choose the primary source.`；:808 `VALUES ('RAGIC','Z01',$1,$2,$3,$4,'MULTIPLE_SOURCE_ALIAS')`
- 註：第 4～6 級要通過灰度旗標才會評估，否則只跑到第 3 級就回 NO_DECISION（z03IdentityClaim.js:743 `maxPriority: canary.allowed ? 6 : 3`；parentIdentityResolver.js:214-221 `if (maxPriority < 4) return { winnerSourceId: null, ... reason: 'CANARY_NOT_ENABLED' }`）。這條路的結果是家長能登入、資料標記 DATA_RECONCILIATION_PENDING、等人工收斂（:817-822）。

**27. 本地 Z03 待整理佇列裡，一支電話對到多筆家庭時，系統直接轉人工（禁止只取第一筆），並把所有命中的家庭編號帶出來。**

- 誰能做：系統自動
- 依據：server/services/ragicAdmin.js:3654-3659 `if (r.rowCount > 1) { const err = new Error('同一 canonical phone 命中多筆 active Z03 family，禁止 LIMIT 1'); err.code = 'MANUAL_REVIEW_REQUIRED'; err.reason = 'AMBIGUOUS_Z03_FAMILY'; err.z03Ids = r.rows.map((row) => row.id); throw err; }`
- 註：兩個呼叫端（auth.js:889 的 parent-bind-phone、auth.js:675 的 /bind）都把這個錯誤接住並改走「一定要帶已驗證學員姓名」的認領路徑（auth.js:676-679、:890-892）。

**28. Ragic 來源記錄與本地家長的對應表（source_record_links）是「一筆 Ragic Z01 記錄 ↔ 一位本地家長（可再指到一位學員）」的唯一對應；同時記錄 link_method 說明「憑什麼這樣連」（正常認領、第幾級證據判定、或別名）。這張表就是解綁後家長換一支 LINE 重綁時「認回原本是誰」的依據。**

- 誰能做：系統自動
- 依據：server/services/z03IdentityClaim.js:647-655 `INSERT INTO source_record_links (source_system,source_table,source_record_id,canonical_parent_id, canonical_student_id,claim_id,link_method) VALUES ('RAGIC','Z01',$1,$2,$3,$4,$5) ON CONFLICT (source_system,source_table,source_record_id) DO UPDATE SET ...`；link_method 取值見 :718 `'PHONE_AND_EXACT_STUDENT_NAME'`、:754 `MULTIPLE_SOURCE_PRIORITY_${resolution.priority}`、:557 / :808 `'MULTIPLE_SOURCE_ALIAS'`
- 註：救援完成時的來源歸屬檢查也讀這張表（parentAccountRecovery.js:104-108）。六級排序會把別名（ALIAS_METHODS）排除在「主對應」之外（parentIdentityResolver.js:194-195 `const primaryLinks = links.filter((row) => !ALIAS_METHODS.has(row.link_method) ...)`）。

**29. 身分認領案件表（identity_claims）記的是「某一筆來源記錄＋某位學員姓名」這一次認領／救援的狀態；救援完成會把它推進「等 Ragic 同步」（ACCOUNT_REBIND_SYNC_PENDING），Ragic 寫入確認後才變成 ACCOUNT_REBOUND。同一組（用途＋來源系統＋來源表＋來源編號＋學員姓名）只會有一筆，重送會累加版本號而不是長出新案件。**

- 誰能做：系統自動
- 依據：server/services/parentAccountRecovery.js:360-365 `VALUES ('ACCOUNT_RECOVERY','ACCOUNT_REBIND_SYNC_PENDING',...) ON CONFLICT (purpose,source_system,source_table,source_record_id,student_name_normalized) DO UPDATE SET state='ACCOUNT_REBIND_SYNC_PENDING', ... version=identity_claims.version+1`；server/services/ragicSyncOutbox.js:160-163 `UPDATE identity_claims SET state=$2 ... [job.claim_id, isRebind ? 'ACCOUNT_REBOUND' : 'SYNCED']`
- 註：救援用的 purpose 是 'ACCOUNT_RECOVERY'，一般認領是 'CLAIM_LEGACY'（z03IdentityClaim.js:972 `VALUES ('CLAIM_LEGACY','SYNC_PENDING',...)`）。若救援申請時本來就帶了案件編號，就走 UPDATE 而不是新建（parentAccountRecovery.js:370-377）。

**30. 身分工單（parent_identity_backoffice_tasks）是給人看的待辦：只存遮罩後的家長姓名與電話、涉及的來源編號、理由碼、建議動作；同一個關聯編號加同一個理由碼只會有一張（重複會更新而不是長出第二張），並預設標明「這張工單沒有動到任何權益」。**

- 誰能做：系統自動
- 依據：server/services/parentIdentityBackoffice.js:19-22 `const maskedParent = { name: maskName(parent?.name || ''), phone: maskPhone(parent?.phone || phone || '') };`；:28-32 `ON CONFLICT (correlation_id,reason_code) DO UPDATE SET ...`；:15 `rightsProtectionStatus = 'NO_RIGHTS_MUTATION',`
- 註：工單狀態欄位允許 OPEN/IN_REVIEW/RESOLVED/DISMISSED（coreSchema.js:1567），但沒有任何程式或畫面會把它從 OPEN 改掉（該表全 repo 只有 parentIdentityBackoffice.js:24 一個 INSERT，零 UPDATE、零 SELECT）。

**31. 換綁稽核表每個救援案件最多只能有一筆（唯一索引）；客服解綁寫進同一張表但沒有案件編號，靠理由碼 ADMIN_UNBIND 區分。這是唯一一張同時涵蓋「救援換綁」與「客服解綁」的稽核表。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:1544 `CREATE UNIQUE INDEX IF NOT EXISTS uq_parent_line_uid_rebind_request ON parent_line_uid_rebind_audit(recovery_request_id) WHERE recovery_request_id IS NOT NULL;`；解綁那筆見 server/routes/admin/customerParents.js:226 `...,'ADMIN_BACKOFFICE',$5,$6,'ADMIN_UNBIND',gen_random_uuid(),NOW(),NOW())`；救援那筆 reason_code 是 'ACCOUNT_RECOVERY_VERIFIED'（parentAccountRecovery.js:383）
- 註：「解綁後家長自己用新 LINE 重綁」那一刻（z03IdentityClaim.js:877）不會寫這張表，所以稽核上看得到「誰解綁」、看不到「後來綁成哪一支」。

**32. 換綁後如果 Ragic 同步一直失敗（Ragic 上仍是舊 UID），夜間拉回會因為「本地已綁的 UID 與 Ragic 不同」而對這一筆拋錯，該筆略過、本地新 UID 保持不動；錯誤逐筆記錄，不會中斷整輪同步。**

- 誰能做：系統自動
- 依據：server/services/parentSync.js:264-265 `if (parent?.line_uid && lineUidForWrite && parent.line_uid !== lineUidForWrite) { throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED', 'canonical parent 已綁定另一個 LINE UID'); }`；server/services/ragicAdmin.js:3396-3400 `} catch (err) { await client.query('ROLLBACK').catch(() => {}); const msg = _syncErrorMessage(err, ...); errors.push(msg); console.warn('[ragic-pull] parent sync failed ...`
- 註：也就是「本地有 UID」的情況下本地贏、Ragic 蓋不回來；只有「本地是空的」才會被 Ragic 補值（見上一條）。

**33. 救援換綁寫入綁定歷史時，先補一筆「舊 UID 的 ACTIVE 列」以防歷史缺漏，但衝突就跳過；接著把該家長「所有」ACTIVE 列一律標成 REPLACED。所以如果這位家長中間經歷過客服解綁＋自助重綁（那兩步都不寫這張表），歷史會記成「解綁前那支 UID 直接換成現在這支」，中間那一支不會出現。**

- 誰能做：系統自動
- 依據：server/services/parentAccountRecovery.js:328-334 `INSERT INTO parent_line_uid_bindings (canonical_parent_id,uid_hash,status,activated_at,correlation_id) VALUES ($1,$2,'ACTIVE',COALESCE($3::timestamptz,$4::timestamptz),$5) ON CONFLICT DO NOTHING`（$2 = request.old_uid_hash）；:336-340 `UPDATE ... SET status='REPLACED' ... WHERE canonical_parent_id=$1 AND status='ACTIVE'`
- 註：綁定歷史的狀態欄位允許 ACTIVE/REVOKED/REPLACED（coreSchema.js:1522），但程式從來不寫 REVOKED（grep 全 repo 只有這三處寫入，值只有 'ACTIVE' 與 'REPLACED'）——沒有任何「撤銷但未換新」的記錄方式，這正好對應「客服解綁不寫這張表」。

**34. 客服解除綁定不會處理該家長既有的救援案件：案件會留在進行中狀態，要等下一次救援申請進來、而且那筆已經過期，才會被標成 ACCOUNT_RECOVERY_LOCKED。**

- 誰能做：沒有人（沒有主動關閉機制）
- 依據：server/routes/admin/customerParents.js:178-275 整個解綁端點未出現 parent_account_recovery_requests（我逐行讀完）；唯一的清理點在 server/services/parentAccountRecovery.js:184-190 `if (active && new Date(active.expires_at).getTime() <= now.getTime()) { ... SET state='ACCOUNT_RECOVERY_LOCKED',locked_at=$2,last_error_code='RECOVERY_TOKEN_EXPIRED' ... }`
- 註：因為解綁後家長的 line_uid 變成空值，救援申請的前置條件（:155「必須已綁另一支 UID」）不成立，所以那筆舊案件實際上永遠不會被下一次申請觸發清理，除非家長又重綁後再次申請救援。留在進行中狀態的案件還會繼續占用 uq_parent_recovery_active_parent 這條唯一索引（coreSchema.js:1508-1510）。

**35. 登入時本地同一支 LINE UID 對到多位在職家長，會直接擋下（DATA_RECONCILIATION_PENDING），不會挑一位登入。**

- 誰能做：系統自動
- 依據：server/services/parentSync.js:44-45 `if (rows.length > 1) { throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'LINE UID 命中多個 active parent'); }`
- 註：家長主檔上 line_uid 有唯一鍵（parents_line_uid_key，不分在職與否，見 parentSync.js:527-528 註解「UNIQUE constraint parents_line_uid_key 不分 is_active」），所以這種情況只會出現在資料被直接改過的場合。

**36. 「Ragic 確認改綁成功後才允許覆蓋本地 LINE UID」這個開關（overwriteLineUid）全系統沒有任何地方打開過。因此本地那支「哪一支 LINE 能登入」只有三個動作改得動：客服解綁清成空、家長自助認領重綁、救援換綁。所有同步路徑都只能在「本地是空的」時候補值，永遠不能覆蓋既有綁定。** 〔覆核時補上〕
- 依據：server/services/parentSync.js:225 `async function upsertLocalParent(client, mapped, lineUid, { reactivate = true, venuesMap = null, overwriteLineUid = false, preservePending = true } = {})`；:544 `overwriteLineUid: allowRebind,` 而 server/services/parentRefresh.js:128 `allowRebind = false,` 且無任何呼叫端傳 true（grep `allowRebind` 全 repo 只命中 parentRefresh.js:128/:206、parentSync.js:519/:544）；另兩處明寫 false（parentSync.js:593、z03IdentityClaim.js:274）。三個真正會改 UID 的地方：customerParents.js:213（清空）、z03IdentityClaim.js:877（自助重綁）、parentAccountRecovery.js:348（救援換綁）

**37. 被停用（is_active=FALSE）的家長仍然占住他那支 LINE UID：綁定衝突檢查刻意不看在職狀態，因為家長主檔的 LINE UID 唯一鍵本身就不分在職與否。所以「把家長停用」不等於「釋放那支 LINE」——那支 LINE 要綁到別的家庭會被擋成 ACCOUNT_RECOVERY_REQUIRED。要真正釋放只能走客服解綁把 UID 清空。** 〔覆核時補上〕
- 依據：server/services/parentSync.js:527-534 `// dupLine：任何 phone 上（不限 is_active）都不能有同一 LINE UID，// 因為 UNIQUE constraint parents_line_uid_key 不分 is_active。` + `SELECT id, phone, is_active FROM parents WHERE line_uid = $1 LIMIT 1` → `if (dupLine.rowCount && dupLine.rows[0].phone !== phone) throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED', ...)`（對照下一段 dupPhone 查詢 :535-536 就有 `AND is_active = TRUE`）

**38. 綁定歷史表（parent_line_uid_bindings）從來沒有被任何登入、驗證或查詢邏輯讀取過——全系統只有救援換綁的三筆寫入加上啟動時的一次性回填，一次 SELECT 都沒有。所以它唯一的實際作用，是那兩條唯一索引造成的「擋人」效果：殘留的 ACTIVE 舊列會讓後續換綁整筆失敗。** 〔覆核時補上〕
- 依據：grep `parent_line_uid_bindings` 全 server/ + client/ 只有 5 處：server/bootstrap/coreSchema.js:1519（建表）、:1527-1528（兩條部分唯一索引）、:1529（bootstrap 回填 `INSERT ... SELECT p.id,encode(digest(p.line_uid,'sha256'),'hex'),'ACTIVE' ... ON CONFLICT DO NOTHING`）、server/services/parentAccountRecovery.js:329 / :336 / :342（救援換綁的三筆寫入）。登入判斷走的是 parents.line_uid（parentSync.js:36-42 findActiveParentByLineUid）

**39. 救援與衝突判斷所依賴的「依電話查 Ragic Z01」讀取器，必須用數字欄位 ID 的格式（naming:'EID'）才讀得到 LINE UID 欄位（1006846）。檔內註解記載：修正前少了這個參數，回應 key 是中文欄位名，導致這支函式拿回來的每一筆 line_uid 都是空字串，「這支電話已綁到別的 LINE 帳號」那道衝突檢查從上線起沒有擋過任何一次，救援案件也就不會被觸發。** 〔覆核時補上〕
- 依據：server/services/ragic.js:671-686 `// naming: 'EID' —— 讓回應的 key 是數字欄位 ID 而不是中文欄位名。... // 而是所有依賴 mapped.line_uid 的判斷全部失效 —— 包含「這支電話已綁到別的 // LINE 帳號」那道衝突檢查，它從上線起就沒有擋過任何一次。` + :683-686 `const data = await query(process.env.RAGIC_FORM_Z01, { where: `${FIELD.Z01.PHONE},eq,${phone}`, naming: 'EID' });`（現在的程式有帶）；受影響的判斷點：server/routes/auth.js:941 `const needsAccountRecovery = mapped.line_uid !== lineUid || localPhoneHasOtherUid;`、:705-708 `const hasOtherRealUid = Boolean(mapped.line_uid && mapped.line_uid !== lineUid && ...)`

**40. 客服解綁不檢查家長是否在職：端點只依 id 取出該筆家長（沒有 is_active 條件），所以已停用的家長也解得掉。搭配上面「停用的家長仍占住那支 LINE UID」那條，這實際上是唯一能把一支 LINE 從已停用帳號身上釋放出來的操作。** 〔覆核時補上〕
- 依據：server/routes/admin/customerParents.js:193-195 `SELECT id, name, phone, line_uid, ragic_record_id FROM parents WHERE id = $1 FOR UPDATE`（無 is_active 條件）；範圍檢查也只看場館 :86-90 `SELECT primary_venue_id FROM parents WHERE id = $1` → isVenueInScope


#### 判準不一致（12 條）

**1. 後台確認視窗告訴客服「Replit 與 Ragic 兩邊的舊 UID 都會清除」，但實際上 Ragic 那一步是盡力而為，失敗後舊 UID 仍留在 Ragic Z01 上。**

- 誰能做：櫃檯（看到的說明與實際行為不同）
- 依據：client/admin/src/pages/CustomerParentsPage.jsx:267 `<li>可以換成<b>不同的 LINE 帳號</b>綁定（Replit 與 Ragic 兩邊的舊 UID 都會清除）</li>` 對照 server/routes/admin/customerParents.js:241-243 `} catch (e) { ragicError = e.message; console.warn('[unbind-line] Ragic Z01 UID 清除失敗（本地已解除）:' ...`
- 註：確認視窗的文案是「一定會清」，只有事後的 API 回應與 toast 才會告知「沒清成功」。客服若只看確認視窗會以為兩邊都乾淨了。這條的實際後果見「夜間同步把舊 UID 寫回」那條。

**2. 客服解除綁定不會去動「綁定歷史表」parent_line_uid_bindings：舊 UID 那一列還維持 ACTIVE，於是「家長已無綁定」與「綁定歷史顯示仍綁著舊 UID」會長期不一致。只有帳號救援換綁這條路會維護這張表。**

- 誰能做：沒有人（兩條路徑各寫各的）
- 依據：server/routes/admin/customerParents.js:210-228（整段只 UPDATE parents 與 INSERT 稽核表；全端點無 parent_line_uid_bindings）對照 server/services/parentAccountRecovery.js:336-338 `UPDATE parent_line_uid_bindings SET status='REPLACED',revoked_at=$2, replaced_by_uid_hash=$3,updated_at=$2 WHERE canonical_parent_id=$1 AND status='ACTIVE'`
- 註：全 repo 對這張表的寫入只有 parentAccountRecovery.js:329 / :336 / :342 與 bootstrap 的一次性回填（server/bootstrap/coreSchema.js:1529）—— 我用 grep 掃過 server/ 與 client/ 全部確認。表上有兩條唯一索引：同一支 UID 只能有一列 ACTIVE、同一位家長只能有一列 ACTIVE（coreSchema.js:1527-1528）。

**3. 同一件事（這支電話已綁另一支 LINE），本地認領交易內部會依走到哪個分支拋出兩種不同代碼：ACCOUNT_RECOVERY_REQUIRED 或 PHONE_BOUND_TO_OTHER_UID。前者會讓家長端顯示「請完成手機所有權驗證或聯絡客服協助恢復」，但後端這條路完全沒有建立救援案件，所以客服手上沒有任何案件編號或驗證碼可以作業。**

- 誰能做：沒有人（兩邊判準不一致）
- 依據：server/services/z03IdentityClaim.js:493 `throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁定另一個 LINE UID', 409);` 與 :760 `throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', '手機已綁另一個 LINE UID', 409);`；對照 :871 與 :918 的 PHONE_BOUND_TO_OTHER_UID。前者在 server/routes/auth.js:305 被翻成 `syncState: err.code === 'ACCOUNT_RECOVERY_REQUIRED' ? 'ACCOUNT_RECOVERY_REQUIRED' : null`，client/liff/src/pages/LoginPage.jsx:97 顯示恢復文案
- 註：差別在分支位置，不在業務情境：:493 在「家庭內找不到同名學員且允許新增學員」分支（:480 `if (exactMatches.length === 0)` + `if (allowStudentAppend)`）、:760 在「多來源排不出主檔」分支、:871/:918 在正常認領主路徑。四個分支的業務意義都是同一件事。LoginPage.jsx:122-123 只有在回應帶 recovery_token 時才印案件編號，這四條都不會帶。

**4. 新版三段式登入流程（verify-phone → verify-student → bind）永遠走不到帳號救援：verify-student 驗證通過後簽發的流程票券沒有把學員姓名帶進去，所以 /bind 讀到的「已驗證學員姓名」一定是空的，必定落到「開一張後台工單 + 回 409」那條分支，該端點裡呼叫 requestAccountRecovery 的那段是死碼。**

- 誰能做：沒有人（新流程無法發起救援）
- 依據：server/routes/auth.js:632 `const newToken = signFlowToken({ lineUid, phone, attempts: 0 });`（驗證成功仍不帶 studentName）；server/middlewares/flowAuth.js:21 `function signFlowToken({ lineUid, phone = null, attempts = 0, studentName = null })`；server/routes/auth.js:710 `if (!verifiedStudentName) { ... return res.status(409)...`，:735 `recovery = await requestAccountRecovery({...})` 因此不可達
- 註：我 grep 過全 repo 的 signFlowToken 呼叫端（auth.js:475/539/559/632/648 + server/scripts/ 三支測試腳本），沒有任何一處傳 studentName，所以 flowAuth.js:51 `studentName: payload.studentName || null` 恆為 null。兩套端點並存（auth.js:488-496 註解說明「不互相取代」）。目前家長端還沒接新流程，所以影響是「一旦前端改接新流程，帳號救援就整條消失」。

**5. /bind（新流程）碰到「這支電話已綁另一支真實 LINE」時，回的是 409 ACCOUNT_RECOVERY_VERIFYING，並開一張後台工單，但後端並沒有任何案件真的進入「驗證中」狀態。**

- 誰能做：沒有人（狀態碼與實際狀態不符）
- 依據：server/routes/auth.js:724-731 `return res.status(409).json({ error: '帳號恢復前必須重新完成學員驗證', code: 'ACCOUNT_RECOVERY_VERIFYING', ... syncState: 'ACCOUNT_RECOVERY_VERIFYING' });`（此前只 createParentIdentityBackofficeTask，未寫入 parent_account_recovery_requests）
- 註：ACCOUNT_RECOVERY_VERIFYING 在正式的案件狀態機裡是「admin 已開始複核」的意思（server/services/parentAccountRecovery.js:10 狀態列舉、:287 `SET state='ACCOUNT_RECOVERY_VERIFYING' ... verification_method='MANUAL_VERIFIED'`）。家長端 MAP 也沒有這個碼（LoginPage.jsx:94-121），會直接顯示後端原文。

**6. 沒有任何後台畫面可以完成帳號換綁，也沒有任何畫面或 HTTP 端點可以查詢救援案件、換綁稽核、或系統自動開出的身分工單——這三張表沒有任何對外的讀取入口，只能直接查資料庫。**

- 誰能做：沒有人（僅 DB 可查；換綁需直接呼叫 API）
- 依據：client/admin/src 完全沒有 account-recovery / manual-complete / backoffice-task 相關頁面或 API 呼叫（grep `manual-complete|recovery_token|backoffice` 在 client/ 只命中 roles.js 的角色旗標與 LIFF 的驗證碼顯示）；身分工單表的存取只有 server/services/parentIdentityBackoffice.js:24 `INSERT INTO parent_identity_backoffice_tasks`；換綁稽核表只有 customerParents.js:222 / parentAccountRecovery.js:379 的 INSERT 與 ragicSyncOutbox.js:183 / :441 的 UPDATE
- 註：措辭已修正：原稿說「三張表全系統只有寫入、沒有讀取」，但 parent_account_recovery_requests 其實有內部 SELECT（parentAccountRecovery.js:172、179、197、255、433）——那些是服務自己的交易內讀取，不是可供人查詢的端點。parent_line_uid_rebind_audit 與 parent_identity_backoffice_tasks 則確實一次 SELECT 都沒有。程式有五個地方會持續產生身分工單（z03IdentityClaim.js:398 與 :572、ragicSyncOutbox.js:465、ragicAdmin.js:2580、auth.js:712 —— grep 確認就是這五處），工單表也有「未結案」專用索引（coreSchema.js:1571-1572），但沒有人看得到這些工單。

**7. 但救援路徑用來決定「要對哪一筆 Ragic Z01 做換綁」的查詢，是「拿回來的第一筆」：那支查詢沒有任何多筆檢查，救援案件就綁在這筆被任意挑中的來源上，之後的 Ragic 換綁也只改這一筆。**

- 誰能做：系統自動（同一件事三種判準）
- 依據：server/services/ragic.js:683-688 `const data = await query(process.env.RAGIC_FORM_Z01, { where: `${FIELD.Z01.PHONE},eq,${phone}`, naming: 'EID' }); const records = Object.values(data); return records[0] || null;`；救援端點把它直接當來源：server/routes/auth.js:969 `ragicRecordId: mapped.ragic_record_id,`
- 註：三種判準並存：資料庫層（findZ03RecordByPhone）>1 筆直接轉人工；認領層跑六級證據排序且明文禁止「取第一筆」；救援層取第一筆。救援案件的來源編號會被寫進 parent_account_recovery_requests.ragic_record_id（coreSchema.js:1495 NOT NULL）並在完成時做來源歸屬檢查（parentAccountRecovery.js:104-116），但檢查的是「這筆屬不屬於這位家長」，不是「這筆是不是正確的主檔」。

**8. 一支電話在本地對到多位在職家長時，救援直接回 ACCOUNT_RECOVERY_FAILED，不轉人工、不開工單、不留待辦；同樣的情況在一般認領流程是回 DATA_RECONCILIATION_PENDING／DUPLICATE_PARENT_IDENTITY，並把 Z03 列標成人工複核、建立認領案件、開一張後台工單。**

- 誰能做：沒有人（兩邊處理方式不一致）
- 依據：server/services/parentAccountRecovery.js:151-152 `if (candidates.length !== 1 || parentMatches.length !== 1) { throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Recovery requires one canonical parent'); }`；對照 server/services/z03IdentityClaim.js:902-904 `reviewContext = { z03Ids: [family.id], sourceRecordId: family.z01_ragic_record_id, code: 'DUPLICATE_PARENT_IDENTITY' }; throw new Z03ClaimError('DUPLICATE_PARENT_IDENTITY', 'canonical phone 命中多個 parent', 409);` + :1071-1080 觸發 `_persistManualReview`（該函式在 :378-401 寫 identity_claims(MANUAL_REVIEW) 並開工單）
- 註：救援路徑整支服務都沒有呼叫 createParentIdentityBackofficeTask（我 grep server/services/parentAccountRecovery.js 全檔 475 行無此字串），所以救援被擋下的家長不會留下任何人工待辦。認領層的補救是在原交易 ROLLBACK 之後用獨立交易補寫（z03IdentityClaim.js:1070-1080）。

**9. 「這支電話已綁另一支 LINE」在不同入口有四種不同結局：(1) 舊手機綁定端點且家庭還在 Z03 佇列 → 409 PHONE_ALREADY_BOUND_TO_OTHER_LINE，叫家長聯絡客服，沒有案件；(2) 舊手機綁定端點且 Ragic Z01 已完整、認領通過 → 建立救援案件並回案件編號＋驗證碼；(3) 新流程 /bind → 409 ACCOUNT_RECOVERY_VERIFYING，開工單，沒有案件也沒有碼；(4) 本地認領交易內 → 依分支拋 ACCOUNT_RECOVERY_REQUIRED 或 PHONE_BOUND_TO_OTHER_UID，兩者都沒有案件。**

- 誰能做：沒有人（四個入口判準不一致）
- 依據：(1) server/routes/auth.js:895-899 `if (z03ByPhone?.parent?.line_uid && z03ByPhone.parent.line_uid !== lineUid) { return res.status(409).json({ error: '此手機已綁定其他 LINE 帳號，請聯絡客服處理', code: 'PHONE_ALREADY_BOUND_TO_OTHER_LINE' }); }`；(2) 同檔 :986-998 `code: 'ACCOUNT_RECOVERY_REQUIRED' ... recovery_request_id, recovery_token, recovery_expires_at`；(3) 同檔 :724-731；(4) server/services/z03IdentityClaim.js:493 / :760 / :871 / :918
- 註：分支順序決定命運：Z03 檢查（auth.js 步驟 2，:886-905）排在 Ragic Z01 檢查（步驟 3，:906 起）之前，所以「舊客戶還沒畢業出 Z03」這群人永遠拿不到救援案件。另外還有第五個入口，見 added 清單裡的 parentSync._syncWithLock。

**10. 客服解除綁定之後，若當天 Ragic 那一步清除失敗，夜間同步會把舊 UID 寫回本地、家長又變回「已綁舊 LINE」：凌晨 02:30 的 Ragic→本地全量拉回讀到 Ragic 上還留著的舊 UID，而本地 line_uid 是空的，於是補值寫回；凌晨 00:30 的本地→Ragic 回寫只挑「line_uid 不為空」的列，所以 Ragic 上那個沒清掉的 UID 也不會被補清。**

- 誰能做：系統自動（無人介入即發生）
- 依據：server/services/parentSync.js:291 `line_uid=CASE WHEN $12::boolean THEN NULLIF($3,'') ELSE COALESCE(line_uid,NULLIF($3,'')) END,`（$12=overwriteLineUid，預設 false → 走 COALESCE 補值）；夜間拉回不帶該參數：server/services/ragicAdmin.js:3372-3378 `const local = await parentSync.upsertLocalParent(client, mapped, mapped.line_uid || null, { reactivate: false, venuesMap, preservePending: true });`；夜間回寫的篩選：server/services/ragicAdmin.js:2304 `WHERE is_active = TRUE AND line_uid IS NOT NULL AND line_uid <> ''`；排程時間 server/cron/index.js:455 `scheduleTaipei('30 0 * * *', ...)` 與 :469 `scheduleTaipei('30 2 * * *', ...)`
- 註：路徑我逐段驗過：Ragic 仍有真 UID → hasRealUid=true（ragicAdmin.js:3342-3346），本地已無 UID 所以 boundPhoneOfUid 為 undefined → phoneMatches=true（:3352-3354），isIncomplete=false（:3356）→ 進 upsertLocalParent 補值。原稿引的 :3342-3367 應更正為「未開通只進 Z03」分支在 :3359-3368（`if (isIncomplete)` → `_upsertZ03Record` → continue）。若 Ragic 那步清除成功，Ragic UID 欄位為空 → 判為未開通只進 Z03 佇列，不碰 parents，本地維持未綁定。也就是說解綁是否真的生效，完全取決於那個盡力而為的 Ragic 寫入有沒有成功。回寫那邊另有 `AND (ragic_record_id IS NULL OR last_synced_at IS NULL)`（:2307），解綁雖然把 last_synced_at 清成 NULL 符合這條，但仍被 line_uid 非空那條擋掉。

**11. 救援換綁在檢查「這支新 LINE UID 有沒有被別人用」時，只查家長主檔，不查綁定歷史表；綁定歷史表上有「同一支 UID 只能有一列 ACTIVE」的唯一索引，撞到時整筆換綁會以通用的 ACCOUNT_RECOVERY_FAILED（HTTP 500）失敗，訊息裡看不出真正原因。**

- 誰能做：系統自動（兩張表的唯一性判準不一致）
- 依據：server/services/parentAccountRecovery.js:311-315 `SELECT id FROM parents WHERE is_active=TRUE AND line_uid=$1 AND id<>$2 FOR UPDATE ... if (otherParent) throw new AccountRecoveryError('ACCOUNT_RECOVERY_LOCKED', 'New LINE UID became active on another parent');`（只查 parents）；:341-346 直接 `INSERT INTO parent_line_uid_bindings ... VALUES ($1,$2,'ACTIVE',$3,$4)` 無 ON CONFLICT；索引定義 server/bootstrap/coreSchema.js:1527
- 註：會撞到的前提是綁定歷史表殘留了 ACTIVE 舊列——而客服解綁正好會製造這種殘留（見「解綁不會動綁定歷史表」那條）。錯誤只會被包成 :457-461 的通用 500，帶 causeCode/constraint/causeMessage。注意申請階段的同名檢查（:164-168）也只查 parents。

**12. 「這支電話已綁另一支 LINE」其實有第五個入口：家長端的資料刷新／註冊補資料路徑（refreshParentMirrorFromRagic → _syncWithLock）。同一個函式裡就有兩個不同代碼：先用 ACCOUNT_RECOVERY_REQUIRED 擋（但同樣不建立任何救援案件），若擋不掉、寫完發現本地 UID 還是別人的，再改用 PHONE_ALREADY_BOUND_TO_OTHER_LINE 叫家長聯絡客服。** 〔覆核時補上〕
- 依據：server/services/parentSync.js:537-540 `if (dupPhone.rowCount && dupPhone.rows[0].line_uid && dupPhone.rows[0].line_uid !== lineUid) { throw new BindConflictError('ACCOUNT_RECOVERY_REQUIRED', '此手機已綁定其他 LINE 帳號，需完成帳號恢復驗證'); }`；:548-551 `if (local.line_uid && local.line_uid !== lineUid) { throw new BindConflictError('PHONE_ALREADY_BOUND_TO_OTHER_LINE', '此手機已綁定其他 LINE 帳號，請聯絡客服處理'); }`；呼叫鏈 server/services/parentRefresh.js:201 `local = await parentSync._syncWithLock({...})` ← server/routes/auth.js:1617（parent-register-line）、server/routes/parents.js:364 與 :464（家長端 me/sync）


#### 只在文件裡（程式沒有／不同）（1 條）

**1. 開發筆記寫著「parent-line-login 在 UID 查無時會用電話反查 Ragic 作備援」，程式沒有這段：該端點只查本地鏡像，查不到就直接發流程票券導向電話驗證，整支不打 Ragic。**

- 誰能做：系統自動（文件與實作不符）
- 依據：replit.md:207 ``(a) `parent-line-login` UID 查無時新增「電話反查備援」——本地已綁此 UID 的家長改用電話反查 Ragic，命中同 UID 就照常登入`` 對照 server/routes/auth.js:464-469 `// 定案規則（2026-07-03）：登入只看本地 Z01 鏡像的 LINE UID。... if (await _respondExistingParentFastPath(res, lineUid, 'logged_in', true)) return;`
- 註：原稿說「:471 之後只有 signFlowToken」，精確位置是 auth.js:475 `const flowToken = signFlowToken({ lineUid });`；:469-481 之間確實沒有任何 ragic 呼叫。對換手機情境的實際影響：家長換 LINE 後第一次開系統，一定會走電話驗證，不會有任何 Ragic 端的備援認回。


### 3.3 學員管理與停學／復學


#### 實作中（46 條）

**1. 學員的 is_active 代表「學籍」（在籍中／休‧退學），不是帳號能不能用。後台切換視窗明講這會影響日常扣課與簽到。**

- 誰能做：櫃檯／主管／管理員（後台）
- 依據：client/admin/src/pages/CustomerStudentsPage.jsx:114 `<StatusBadge tone={r.is_active ? 'green' : 'errorSoft'}>{r.is_active ? '在籍中' : '休/退學'}</StatusBadge>`；:168 `將學員「{name}」變更為 {is_active ? '休/退學' : '在籍中'}，會影響日常扣課與簽到。`
- 註：中文字不一致已核實：CustomerStudentsPage.jsx:114 用「在籍中／休‧退學」，但同一頁的操作按鈕（:118）寫「停用／啟用」，家長頁子表 RagicZ01Modal.jsx:177 又寫「在籍／停用」、:182 按鈕寫「停用／啟用」。同一個欄位三組詞彙，櫃檯溝通確實容易誤會。

**2. 新建的學員一律預設在籍。資料庫預設 TRUE，各建檔入口也明寫 TRUE 或不帶（吃預設）。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:1705 `ALTER TABLE students ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`；server/routes/parents.js:306-307 `(parent_id, name, ..., is_active, last_synced_at) VALUES ($1,...,TRUE,${syncedSql})`
- 註：補一個原清單沒列到的入口：舊版開發用註冊端點 server/routes/parents.js:799 `INSERT INTO students (parent_id, name, id_number, birth_date, gender)` 也不帶 is_active，同樣吃 DB 預設 TRUE（僅 ALLOW_LEGACY_PARENT_CREATE=1 且非 production 時可用，parents.js:791-794）。團購（groupOrders.js:179-180）與轉讓核准（transfers.js:140）不帶 is_active 的說法正確。

**3. 「停學」只存在本系統，永遠不會回寫 Ragic。學員停學或家長被停用的列，回寫排程直接略過。**

- 誰能做：系統自動
- 依據：server/services/ragicWriteback.js:89-91 `if (row.is_active === false || row.p_is_active === false) { console.warn('[ragic-writeback] student/parent 已停用，略過回寫（移除由櫃台在 Ragic 端處理）'...); return null; }`；同檔 :11-14 政策註解
- 註：deactivateStudentZ02Strict 現況核實：定義在 server/services/ragic.js:1491，全 repo 沒有任何呼叫端（唯一其他命中是 ragicWriteback.js:12 的註解），但它仍掛在 module.exports（ragic.js:1561），所以只是「沒人叫」不是「叫不到」。另外 :1488-1490 的 DEPRECATED 註解說明它現在也不再寫「學員身分」欄（upsertZ02ForParentStudent 對既有紀錄不碰該欄），所以即使被誤呼叫也不會覆蓋身分類別——比原清單描述更安全一層。實務後果（櫃檯在後台停學、Ragic 上看不出來）正確。

**4. 家長自己絕對不能停學、移除或轉出自己的小孩。直接打舊 API 一律 405 並導向櫃檯。**

- 誰能做：沒有人（家長端永久封閉）
- 依據：server/routes/parents.js:749-753 `router.delete('/me/students/:id', requireParent, (req, res) => { res.status(405).json({ error: '學員資料異動（停用 / 移除 / 轉出）請洽櫃臺，或透過 LINE 官方帳號聯繫。', code: 'STUDENT_REMOVAL_VIA_COUNTER' }); });`
- 註：兩個原因在 parents.js:745-746（原清單寫 :744-747，744 是段落標題行、747 是政策行，範圍無誤）。前端也已拔掉按鈕並在畫面寫明：client/liff/src/pages/ProfilePage.jsx:322「可新增或編輯學員資料。若需停用、移除或轉出學員（含暫時寄掛的小孩），請洽櫃台」。

**5. 家長端只能新增與編輯學員，不能改學籍。新增／編輯都必須通過身分證格式與生日檢核，否則 400。**

- 誰能做：家長自己
- 依據：server/routes/parents.js:581-583 `if (!s.name || !s.birth_date || !ISO_DATE.test(s.birth_date) || !TW_ID.test(s.id_number)) { return res.status(400).json({ error: '學員資料不完整或身分證格式錯誤' }); }`
- 註：PATCH /me/students/:id 定義在 parents.js:672，同一組檢核在 :674（原清單指的 :674 就是檢核那行）。TW_ID = `/^[A-Z][12]\d{8}$/`（parents.js:27），新式統編／居留證號進不來，正確。另核實家長端可寫欄位白名單不含 is_active：cleanStudentInput 出來的值只進 name/id_number/birth_date/gender/blood_type。

**6. 能改學籍的是後台三個角色：管理員、主管、櫃檯（預設都有），而且只能動「家長主場館落在自己權限範圍內」的學員。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/constants/adminResources.js:30 `{ key: 'customer-students', ... defaultRoles: ['admin', 'manager', 'staff'] }`；server/routes/admin/customerStudents.js:176 `if (!own.rowCount || !isVenueInScope(req, own.rows[0].v)) { await client.query('ROLLBACK'); return res.status(404).json({ error: '找不到此學員' }); }`
- 註：權限可調（requireResource 讀 F-A06 設定）正確。場館範圍靠家長 primary_venue_id 推導的註解在 customerStudents.js:67 `const scope = getScopedVenueIds(req); // 學員無場館鏡像 → 以家長 primary_venue_id 收斂`。

**7. 停學／復學有兩個後台入口：學員資料頁單筆改，或家長頁的學員子表整批改。兩邊都會留稽核。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/routes/admin/customerStudents.js:194 `if (typeof b.is_active === 'boolean') { args.push(b.is_active); sets.push(\`is_active = $${args.length}\`); }`；server/routes/admin/customerParents.js:357 `student_code=NULLIF($9,''), is_active=$10, last_synced_at=NULL, updated_at=NOW() WHERE id=$1`；:361 `s.student_code || '', s.is_active !== false]`
- 註：`s.is_active !== false` 的隱患成立，而且**兩處都有**：家長頁子表的既有學員更新（customerParents.js:361）與新建（:376）都用同一個寫法。前端漏傳 is_active 欄位，停學的人會被默默寫成在籍（等於無聲復學）；新列漏傳則一律建成在籍。這是這條規則裡最該交接的細節。

**8. 要把學員改回在籍（復學），所屬家長必須已綁定真實 LINE 帳號；沒綁就擋下並說明。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/routes/admin/customerStudents.js:195-200 `if (b.is_active === true && !isRealLineUid(own.rows[0].parent_line_uid)) { ... error: '此學員所屬家長尚未綁定真實 LINE，無法啟用', code: 'PARENT_UNBOUND_CANNOT_ACTIVATE_STUDENT' }`
- 註：isRealLineUid 定義在 customerStudents.js:32-35，`demo:` 與 `DEMOTEST_` 開頭的哨兵 UID 都算未綁，正確。理由的對照條是家長列本身的同型擋門（customerParents.js:306-316，錯誤碼 PARENT_UNBOUND_CANNOT_ACTIVATE）。

**9. 沒有任何人能刪除學員。系統沒有刪除端點，權威同步的硬刪函式是永久空殼，唯一能真的刪掉的方式是直接動資料庫。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：server/services/parentSync.js:176-180 `async function hardDeleteStudentIfSafe(client, studentId) { void client; void studentId; return false; }`；server/routes/admin/customerStudents.js 只有 4 條路由（:60 /、:96 /:id、:116 /:id/audit-logs、:163 PATCH /:id），無 router.delete；customerParents.js 亦無 router.delete
- 註：`grep -rn "DELETE FROM students" server/` 的命中要補一筆：除了 registerRobustness.js:134 與 registerWalkthrough.js:113（測試腳本），還有 **server/scripts/demo_cleanup_prod.sql:112**（測試帳號清理腳本，按 phone/name/line_uid 哨兵條件刪學員，註解寫「parents 刪除前必清，students.parent_id RESTRICT」）。原清單漏了這一支。外鍵 ON DELETE RESTRICT 在 coreSchema.js:133，正確。

**10. 停學後，家長在個人資料頁看不到這個小孩了——後端回傳的學員清單已過濾，前端再過濾一次。**

- 誰能做：系統自動
- 依據：server/routes/parents.js:104-107 `SELECT id, name, id_number, ... FROM students WHERE parent_id = $1 AND COALESCE(is_active, TRUE) = TRUE ORDER BY created_at ASC`；client/liff/src/pages/ProfilePage.jsx:144 `(profile?.students || []).filter((s) => s?.is_active !== false)`
- 註：GET /me（parents.js:424）、POST /me/sync（:440）與所有寫入後的回應共用同一個 loadMe()（parents.js:95），所以一律看不到，正確。

**11. 停學學員的資料家長也改不動：編輯端點查不到這個人，回「找不到學員」。**

- 誰能做：家長自己（被擋）
- 依據：server/routes/parents.js:680-686 `SELECT ... FROM students WHERE id = $1 AND parent_id = $2 AND COALESCE(is_active, TRUE) = TRUE` → `if (!cur.rowCount) return res.status(404).json({ error: '找不到學員' });`
- 註：訊息是「找不到學員」而不是「此學員已停學」，家長看不出原因，正確。

**12. 停學學員不能報名新課程（個人報名路徑），送出會回「所選學員不存在、已停用或不屬於您」。**

- 誰能做：家長自己（被擋）
- 依據：server/routes/enrollments.js:372-379 `SELECT id, name FROM students WHERE parent_id = $1 AND id = ANY($2::uuid[]) AND COALESCE(is_active, TRUE) = TRUE` → `res.status(403).json({ error: '所選學員不存在、已停用或不屬於您', code: 'STUDENT_NOT_AVAILABLE' })`
- 註：確實是少數把「已停用」明講在訊息裡的地方。

**13. 停學學員不能被選進團購單。用既有學員 id 加入時會被擋成「所選學員不存在或不屬於您」。**

- 誰能做：家長自己（被擋）
- 依據：server/routes/groupOrders.js:138-147 `SELECT id, name FROM students WHERE parent_id = $1 AND id = ANY($2::uuid[]) AND COALESCE(is_active, TRUE) = TRUE` → `err.code = 'STUDENT_NOT_OWNED'`
- 註：訊息說「不屬於您」、實際原因可能是停學，會誤導櫃檯，正確。

**14. 停學學員不能簽到。家長自助簽到與預約制簽到都在守門就被擋，回 STUDENT_ENTITLEMENT_INACTIVE，不會建幽靈課堂、不會扣堂。**

- 誰能做：家長自己（被擋）
- 依據：server/services/courseEntitlements.js:127-132 `const roster = rosterRows.filter(row => row.is_active || (keepNamedInactive && String(row.student_id) === named)).map(...); if (!roster.length || (studentId && !roster.includes(studentId))) { throw conflict('STUDENT_ENTITLEMENT_INACTIVE', '學員已退費或不在有效課程名單中'); }`；server/routes/checkins.js:370-371 `await assertCourseEntitlement(client, ctx.rows[0].period_id, studentId, { requireActiveStudent: true });`
- 註：conflict() 產生 status 409（courseEntitlements.js:3-5），正確。2026-09-22 修復與 checkins.js 凍結檔同意記錄（:366-369）都核實無誤。

**15. 停學學員的課程，在「我的課程」與課程詳情頁完全照原樣顯示。這兩支端點用報名單上的家長電話撈資料，根本不碰 students 表的學籍。**

- 誰能做：家長自己（看得到）
- 依據：server/routes/courses.js:222 `WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)`；server/routes/courses.js:617 `const owns = row.parent_phone === phone || (row.extra_parent_phones || []).includes(phone);`
- 註：「停學不影響付款／報名單層面的可見性；課程掛在報名單上不是掛在學員身上」這個結論成立。第三處同型判準在 courses.js:821（另一支端點的 owns 檢查），也是純電話比對。

**16. 「家長停用」跟「學員停學」是兩件不同的事。家長停用（parents.is_active=FALSE）是整個帳號登不進去，每一個 request 都即時跟資料庫比對，前端收到 401 並登出。**

- 誰能做：櫃檯／主管／管理員（後台）
- 依據：server/middlewares/parentAuth.js:41-44 `// 每次請求都跟資料庫即時比對：帳號被刪除或停用(is_active=FALSE)即失效，前端會收到 401 並登出。` / `SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE` → `res.status(401)... code: 'PARENT_NOT_FOUND'`
- 註：「停用家長不會自動停學他的小孩」核實無誤：customerParents.js:306-325 的 is_active 分支只 `UPDATE parents`，學員列完全不動。所以「家長登不進來、名下學員全部仍在籍、課期名單照算」確實會發生（而且照第 22 條，那位家長還收得到推播）。

**17. 復學的做法：後台把 is_active 改回在籍就結束了。不需要重新報名、不需要動課期名單，權益立刻回來。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/routes/admin/customerStudents.js:194（PATCH 只改 students 一張表，SET 清單不含任何 course_period_enrollments 操作）；docs/entitlement_repair_2026-09-22.md:38-40 `- **學員其實該復學**（帳號解綁重綁那一類，例如慧娟案）→ 由櫃檯在後台把 students.is_active 改回 true。資料就自然一致，不需要碰 course_period_enrollments。`
- 註：對稱性成立（停學從來沒動過 course_period_enrollments）。前置條件是第 8 條的「家長必須綁真實 LINE」。

**18. 兩個狀態欄位的分工：course_period_enrollments.status 管「這個人在這一期的名單裡嗎」，students.is_active 管「這個人還在籍嗎」。要看得到、用得到這一期，兩個條件必須同時成立。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:26 `DO $$ BEGIN CREATE TYPE enrollment_status AS ENUM ('active','transferred_out'); ...`；server/services/courseEntitlements.js:108-113 `SELECT cpe.student_id, COALESCE(s.is_active, TRUE) AS is_active FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $1 AND cpe.status = 'active' ...`
- 註：第三個獨立欄位（退費）正確：courseEntitlements.js:71-72 `if (!period || period.status !== 'active' || period.entitlement_state !== 'ACTIVE') { throw conflict('PERIOD_ENTITLEMENT_INACTIVE', '此課程期已停用或退費，無法簽到或扣課'); }`。補一句：守門其實還有第四道——來源報名的退費狀態（courseEntitlements.js:77-100，錯誤碼 ENROLLMENT_SOURCE_UNRESOLVED / ENROLLMENT_ENTITLEMENT_INACTIVE / REFUND_IDENTITY_REVIEW_REQUIRED），也跟停學互不相干。

**19. 停學完全不碰課期名單，所以會長期存在「停學學員仍掛在有效名單上」的資料，而且沒有任何自動清理。**

- 誰能做：系統自動（無人清理）
- 依據：停學路徑只寫 students 一張表：server/routes/admin/customerStudents.js:194、server/routes/admin/customerParents.js:357；docs/entitlement_repair_2026-09-22.md:23-34 `## 1. T1：停學學員仍掛在有效名單上（4 筆 / 3 課期 / 2 名學員）... 四筆**全部**落在「名單含 2 個以上家長」的跨家庭共享課期`
- 註：機制部分（停學不動名單、沒有介面能改名單、新資料會持續產生）是 implemented，由程式確認。但「4 筆 / 3 課期 / 2 名學員」與「used_sessions 全為 0」這些數字是 doc_only：只在 docs/entitlement_repair_2026-09-22.md:27-30、:48 出現，本次不連資料庫所以**無法重算**。交接時這兩個數字要標成「2026-09-22 當時的盤點值」，不能當現況。

**20. 停學學員被排除在有效名單外，只有一個例外：當整個課期名單裡已經沒有任何在籍學員、而呼叫端又明確指名了某位停學學員時，那一位仍算在名單內——這是留給櫃檯手動扣課補登出席用的。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/services/courseEntitlements.js:124-126 `const hasActive = rosterRows.some(row => row.is_active); const namedInRoster = named !== null && rosterRows.some(row => String(row.student_id) === named); const keepNamedInactive = namedInRoster && !hasActive && options.requireActiveStudent !== true;`
- 註：理由（不補登出席會變成沒有任何出席紀錄的幽靈 session）在同檔 :117-120 註解。櫃檯側對應實作 server/routes/admin/manualDeductions.js:335 `const attendanceRoster = rosterRes.rows.filter((r) => r.is_active || String(r.id) === String(studentId));`（註解在 :333-334）。

**21. 家長端的預約制簽到明確關掉上面那個例外——指名停學學員一律被擋，不走補登語意。**

- 誰能做：家長自己（被擋）
- 依據：server/routes/checkins.js:366-371 `// 2026-09-22（凍結檔改動，已取得擁有者同意）：這條路徑一定指名單一學員，停用學員必須在守門就被擋。...` / `const entitledStudents = await assertCourseEntitlement(client, ctx.rows[0].period_id, studentId, { requireActiveStudent: true });`
- 註：對照正確：家長自助簽到（checkins.js:92 `await assertCourseEntitlement(client, periodId);`）沒傳 requireActiveStudent，但它走 :93-96「所選學員必須全在 entitledStudents 內 → 否則 409 STUDENT_ENTITLEMENT_INACTIVE」，效果一樣是擋住。

**22. 簽到／出席的實際寫入也再過濾一次學籍，避免「守門放行、寫入落在別人家小孩身上」。**

- 誰能做：系統自動
- 依據：server/routes/checkins.js:392-395 `JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $3 AND cpe.status = 'active' AND cpe.student_id = ANY($4::uuid[]) AND COALESCE(s.is_active, TRUE) = TRUE`；同檔 :120-124 自助簽到 activeParticipants 查詢
- 註：雙層防線成立。修復前的病因（守門不看 is_active、寫入看，語意相反）記在 courseEntitlements.js:102-104 註解。

**23. 學員不能換家長。整個後端沒有任何一行程式會改 students.parent_id。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：`grep -rn "UPDATE students" server/` 的正式碼命中共 10 處：server/routes/parents.js:273、289；server/routes/admin/customerParents.js:354；server/routes/admin/customerStudents.js:210；server/services/parentSync.js:394、411；server/services/ragicAdmin.js:2259、2918；server/services/ragicSyncOutbox.js:554；server/services/ragicWriteback.js:120 —— 逐一讀過，沒有任何一個的 SET 清單含 parent_id
- 註：結論正確，但原清單的證據要修：是 **10 處不是 8 處**，而且漏列 **server/services/ragicSyncOutbox.js:554** `UPDATE students SET ragic_record_id=COALESCE(ragic_record_id,$2),last_synced_at=NOW(),updated_at=NOW() WHERE id=$1`（我已確認它也不動 parent_id）。Ragic 端把學員子表列搬到另一位家長時本地只解除舊列 ragic_record_id 佔用的說法正確（parentSync.js:392-407）。

**24. 唯一能讓「一個小孩的課跑到另一個家庭」的合法手段是課程轉讓：原學員在該期的名單標成已轉出，在轉入家長名下找／建一位學員，再開一筆新的 active 名單。學員本人不換家長。**

- 誰能做：家長自己送申請 + 主管核准
- 依據：server/services/transfers.js:149-160 `UPDATE course_period_enrollments SET status = 'transferred_out' WHERE course_period_id = $1 AND student_id = $2` / `INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1, $2, 'active') ON CONFLICT (course_period_id, student_id) DO NOTHING`
- 註：轉讓審核權限預設只給 admin / manager、櫃檯沒有，核實無誤（server/constants/adminResources.js:38 `{ key: 'transfers', ... defaultRoles: ['admin', 'manager'] }`）。另外轉入家長必須已經有帳號，否則核准會 400（transfers.js:121-125 `轉入手機 ${tr.to_phone} 尚未註冊家長帳號`）。

**25. 課程轉讓核准時若要新建轉入學員，只會有姓名一個欄位，連身分證、生日都沒有；姓名空白時還會直接寫入「轉入學員」四個字當名字。**

- 誰能做：主管／管理員（核准動作的副作用）
- 依據：server/services/transfers.js:131 `const sName = tr.to_student_name || '轉入學員';`；:139-143 `INSERT INTO students (parent_id, name) VALUES ($1, $2) RETURNING id`
- 註：「重複學員／資料極不完整學員的主要來源之一」成立。對照家長端新增學員一定要身分證格式正確＋生日（parents.js:581）。回寫 Ragic 是 best-effort（transfers.js:175-177）。這筆新學員也吃 DB 預設 is_active=TRUE（見第 2 條）。

**26. 家長端新增學員時，重複判斷是用身分證字號、而且是全系統範圍比對（不限自己名下）。**

- 誰能做：家長自己
- 依據：server/routes/parents.js:612-618 `SELECT id, parent_id, is_active, name, id_number, birth_date, gender, blood_type, student_code, ragic_record_id FROM students WHERE id_number = $1 LIMIT 1`
- 註：沒有 ORDER BY 就 LIMIT 1、同證號兩筆時命中不確定，核實無誤。

**27. 家長新增學員時撞到「自己名下、在籍、同身分證」的既有學員 → 不建第二筆，改成嚴格更新那一位，回 200。**

- 誰能做：家長自己
- 依據：server/routes/parents.js:638-645 `mergedExisting = true; fallbackStudentId = existing.id; expectedMin = activeCount; ... sync = await ragic.updateStudentZ01Z02Strict({ parent: parentForSync, student: { ...existing, ...s, _match_id_number: existing.id_number } });`
- 註：合併回 200、真新增回 201 的分流在 parents.js:665 `res.status(mergedExisting ? 200 : 201).json(me);`，正確。

**28. 家長新增學員時撞到「自己名下、已停學、同身分證」的既有學員 → 明確 409，訊息直接告訴家長去找櫃檯，不自動復學。**

- 誰能做：家長自己（被擋）
- 依據：server/routes/parents.js:631-636 `if (existing.is_active === false) { return res.status(409).json({ error: '此學員曾由櫃台停用或移除，請聯絡客服協助恢復或重新建檔。', code: 'STUDENT_INACTIVE_CONTACT_COUNTER' }); }`
- 註：前端有對應中文訊息（client/liff/src/pages/ProfilePage.jsx:67）。確實是整份規則裡對停學處理最清楚的一條。

**29. 家長新增學員時撞到「別人名下、同身分證」的既有學員 → 409，不揭露對方是誰。**

- 誰能做：家長自己（被擋）
- 依據：server/routes/parents.js:625-630 `if (String(existing.parent_id) !== String(req.parent.id)) { return res.status(409).json({ error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。', code: 'STUDENT_ID_DUPLICATED' }); }`
- 註：Ragic 端第二道同型檢查核實無誤：server/services/ragic.js:1073-1083，以身分證查 Z02，姓名或家長電話不符就拋 STUDENT_ID_NUMBER_EXISTS。

**30. 身分證字號在資料庫層並沒有唯一性保證——只有一般索引。所有「不准重複」都是應用層各自把關的。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:1710 `CREATE INDEX IF NOT EXISTS idx_students_id_number ON students(id_number) WHERE id_number IS NOT NULL;`（非 UNIQUE）；students 表唯一的唯一索引是 coreSchema.js:1870 `CREATE UNIQUE INDEX IF NOT EXISTS uq_students_ragic_record_id ON students(ragic_record_id) WHERE ragic_record_id IS NOT NULL;`
- 註：要補一層：連那個唯一索引都不是必然存在的——coreSchema.js:1863-1869 先檢查現有資料有沒有重複 ragic_record_id，有的話只 `RAISE WARNING '[coreSchema] students.ragic_record_id 有重複，保留原資料並略過唯一索引升級（需人工排查）'` 就跳過建索引。所以「任一入口漏查重、資料庫就收下」對身分證是絕對成立，對 Ragic 連結則要看那一套資料庫當初有沒有髒資料。

**31. 後台家長頁的學員子表新增學員，完全沒有任何查重——姓名有填就建。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/routes/admin/customerParents.js:369-377 `if (!String(s.name || '').trim()) continue; // 新列需有姓名才建` → `INSERT INTO students (parent_id, name, gender, birth_date, id_number, blood_type, student_code, is_active) VALUES ($1,$2,NULLIF($3,''),$4::date,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''), $8)`
- 註：第三個沒查重的建檔入口（另兩個是團購、轉讓核准）成立。撞 uq_students_ragic_record_id 才 409（同檔 :398-401）、身分證重複不會，也正確——但要注意那句 409 的訊息寫的是「唯一值衝突（電話 / 身分證 / Ragic 連結重複）」（:399），實際上身分證沒有唯一索引（第 41 條），這個訊息會讓櫃檯以為系統擋得住身分證重複。

**32. 同一個家庭裡出現兩位同名學員，會讓這一戶的 Ragic 同步整戶卡住，回「資料待人工核對」。**

- 誰能做：系統自動（阻擋）
- 依據：server/services/parentSync.js:373-376 `const exactNameMatches = familyRows.filter((row) => normalizeStudentName(row.name) === incomingName); if (exactNameMatches.length > 1) { throw new BindConflictError('DATA_RECONCILIATION_PENDING', '同一家庭內學員姓名精準命中多筆'); }`
- 註：normalizeStudentName 做 NFKC + 去全部空白 + 轉小寫（server/services/identityNormalizer.js:20-26），所以「王 小明」與「王小明」在這裡算同名、但在轉讓的裸字串比對（第 35 條）算不同人，核實無誤。夜間 canonical Z01 匯入遇同名是跳過該位並記 AMBIGUOUS_STUDENT_MATCH、不整戶擋（ragicAdmin.js:2904-2912），也正確。

**33. 帳號救援（家長換 LINE 帳號要重綁）需要在家長名下找到「恰好一位在籍、姓名精準相符」的學員。小孩被停學，或名下有兩位同名在籍學員，救援都會失敗。**

- 誰能做：系統自動（阻擋）
- 依據：server/services/parentAccountRecovery.js:74-88 `SELECT * FROM students WHERE parent_id=$1 AND is_active=TRUE ORDER BY id FOR UPDATE` → `.rows.filter((row) => normalizeStudentName(row.name) === studentNameNormalized)` → `if (rows.length !== 1) { throw new AccountRecoveryError(rows.length ? 'ACCOUNT_RECOVERY_FAILED' : 'IDENTITY_NOT_FOUND', 'Account recovery requires one exact canonical student match'); }`
- 註：停學的不直覺連帶後果成立：停學後那位家長的換手機／換 LINE 救援會壞掉，錯誤碼 IDENTITY_NOT_FOUND（看起來像「查無此人」），不會說是停學造成的。docs/entitlement_repair_2026-09-22.md:38 提到的「慧娟案」即這一類。

**34. 學員稽核紀錄記的是：哪一位學員、什麼時候、是新增還是編輯、誰改的、什麼身分改的、哪些欄位從什麼變成什麼、一行備註。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:226-234 `CREATE TABLE IF NOT EXISTS student_audit_logs ( id BIGSERIAL PRIMARY KEY, student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), action TEXT NOT NULL, -- 'create' | 'edit'  by_user TEXT, by_role TEXT, changes JSONB, note TEXT );`
- 註：action 只有 create / edit、沒有 delete（因為沒有刪除路徑），正確。

**35. 稽核追蹤的欄位是固定的 9 個白名單：所屬家長、姓名、生日、性別、身分證、血型、學員編號、學籍、Ragic 連結。白名單外的欄位（例如 last_synced_at、updated_at）不會進稽核。**

- 誰能做：系統自動
- 依據：server/services/studentAudit.js:5-8 `const STUDENT_AUDIT_FIELDS = Object.freeze([ 'parent_id', 'name', 'birth_date', 'gender', 'id_number', 'blood_type', 'student_code', 'is_active', 'ragic_record_id', ]);`
- 註：parent_id 永遠不會出現在 changes（沒有程式會改它，第 33 條）正確。生日特別處理避免時區偏一天在同檔 :12-18。另外要注意：後台兩個入口其實傳的是更窄的清單（customerStudents.js:217 與 customerParents.js:364 都只傳 8 欄、不含 ragic_record_id），所以「Ragic 連結變動」只會被同步路徑（用預設 9 欄）記到。

**36. 停學／復學一定會留稽核（is_active 在白名單內），但不會記錄原因——後台的停學確認視窗沒有原因欄，只送學籍值。**

- 誰能做：櫃檯／主管／管理員
- 依據：client/admin/src/pages/CustomerStudentsPage.jsx:83 `await customerStudentsApi.update(toggling.id, { is_active: next });`；server/routes/admin/customerStudents.js:217-218 `const changes = diffChanges(before, r.rows[0], ['name','gender','id_number','blood_type','student_code','birth_date','is_active']); await writeStudentAudit(client, req.params.id, 'edit', { byUser: adminActorName(req), byRole: req.adminUser?.role, changes, note: 'admin-student-edit' });`
- 註：note 是固定字串（'admin-student-edit' / 'admin-parent-student-edit'）不是操作者填的理由，正確。對照也核實：家長解除 LINE 綁定強制要填原因（customerParents.js:180 `if (!reason) return res.status(400).json({ error: '請填寫解除綁定的原因', code: 'REASON_REQUIRED' });`）且落地（:226-228 寫進 parent_line_uid_rebind_audit）。所以事後查「這個小孩為什麼被停學」，資料庫裡只查得到「誰在什麼時候把 true 改成 false」。

**37. 稽核紀錄與學員資料的修改必須在同一個交易裡；稽核寫失敗不准放過，兩筆是同一個商業寫入。**

- 誰能做：系統自動
- 依據：server/services/studentAudit.js:3-4 `// Callers must use the same transaction as the student mutation. Never catch an // audit failure and commit the mutation: both records are one business write.`；:33 `if (!byUser || !byRole) throw new Error('STUDENT_AUDIT_ACTOR_REQUIRED');`
- 註：所有寫入點都遵守，逐一核對過：parents.js:316-318（交易內 client）、customerParents.js:365 / :379（同一交易 client，COMMIT 在 :386）、customerStudents.js:218（COMMIT 在 :219）、groupOrders.js:184、transfers.js:144、parentSync.js:399/427/437、ragicAdmin.js:2939。少了操作者身分直接拋錯、不會寫出匿名稽核，正確。

**38. 沒有實際變動的編輯不會留紀錄。按了儲存但什麼都沒改，稽核是空的。**

- 誰能做：系統自動
- 依據：server/services/studentAudit.js:39 `if (action === 'edit' && !changes) return;`（diffChanges 無差異時回 null：:29 `return Object.keys(changes).length ? changes : null;`）
- 註：新增（create）相反：呼叫端沒傳 changes 時會回頭讀整列做完整快照（:34-38），正確。

**39. 稽核的「誰改的」分四類：家長自己、櫃檯／主管／管理員（記實際帳號與角色）、Ragic 同步、系統修補。**

- 誰能做：系統自動
- 依據：家長 server/services/studentAudit.js:47-49 `return { byUser: \`parent:${parentId}\`, byRole: 'parent', note };`；後台 server/routes/admin/customerStudents.js:218 `byUser: adminActorName(req), byRole: req.adminUser?.role`；同步 server/services/parentSync.js:427 `byUser: 'ragic:parent-sync', byRole: 'system'`；夜間匯入 server/services/ragicAdmin.js:2940 `byUser: 'ragic:canonical-z01-sync', byRole: 'system'`
- 註：其他 actor 全部核實：'system:ragic-link-reconciliation'（parents.js:281）、'ragic:parent-sync' + note 'ragic-link-reconciliation'（parentSync.js:400）、'legacy-development-registration'（parents.js:804，僅開發環境）、轉讓核准用核准者帳號＋角色（transfers.js:144，note 'transfer-approval'）、團購用家長身分（groupOrders.js:184）。schema 註解（coreSchema.js:232）列的 by_role 只有 'parent' | 'staff' | 'manager' | 'admin'，實際還有 'system' 沒寫進註解，正確。

**40. 後台的「編輯紀錄」只看得到最近 200 筆，沒有分頁、沒有篩選。**

- 誰能做：櫃檯／主管／管理員（唯讀）
- 依據：server/routes/admin/customerStudents.js:125-129 `SELECT id, at, action, by_user, by_role, changes, note FROM student_audit_logs WHERE student_id = $1 ORDER BY at DESC, id DESC LIMIT 200`
- 註：讀取一樣受場館範圍限制（同檔 :118-124），正確。Ragic 同步每次比對都可能寫一筆 edit（parentSync.js:427），所以活躍學員的 200 筆可能只涵蓋很短時間，這個推論成立。

**41. 學員稽核紀錄跟學員資料是連動刪除的：學員列一旦被刪掉，他的全部稽核紀錄一起消失。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:228 `student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,`
- 註：目前沒有刪除路徑所以不會發生，但直接在資料庫刪學員會連稽核一起消失，正確。反向的自我封鎖也成立：parentSync.js:152-158 的 STUDENT_REFERENCE_SPECS 把 student_audit_logs 也算成業務關聯（:157），所以只要留過一筆稽核就永遠不算「無 FK 殘留」——即使 DESTRUCTIVE_RECONCILE_ENABLED 被打開、hardDeleteStudentIfSafe 被實作回來，也幾乎沒有學員符合可硬刪條件。

**42. 家長帳號的 Ragic 同步節流是 5 分鐘：家長開頁時若上次成功同步在 5 分鐘內，直接回本地鏡像不打 Ragic。同步失敗一律保留既有資料，絕不清空、絕不回空名單。**

- 誰能做：系統自動
- 依據：server/routes/parents.js:24 `const SYNC_THROTTLE_MS = Number(process.env.PARENT_SYNC_THROTTLE_MS) || 5 * 60 * 1000;`；:476-478 `// 開頁同步不是簽 token 的安全門檻；失敗時保留既有鏡像，避免使用者進不了個資頁。` / `syncStatus = err.code === 'RAGIC_REFRESH_NOT_FOUND' ? 'not_found_in_ragic' : 'stale';`
- 註：開頁同步刻意用 reactivate=false（parents.js:467）所以「被移除的家長」不會因為開頁就復活，正確；學員那一側的復活保護在 parentSync.js:420。補一點：整支 /me/sync 失敗時還有第二層保底（parents.js:493-498，catch 裡再讀一次 loadMe 回 sync_status='error'）。

**43. demo 測試帳號的學員一律只寫本地、不進 Ragic，且新增學員只做查重不做 Ragic 嚴格同步。**

- 誰能做：系統自動
- 依據：server/routes/parents.js:420-422 `function isDemoParent(parentRow, tokenLineUid) { return String(parentRow?.line_uid || tokenLineUid || '').startsWith('demo:'); }`；:589-598 demo 分支只查 `SELECT id, parent_id FROM students WHERE id_number = $1 LIMIT 1` 再 persistStudentMirrorAfterRagic
- 註：理由在 :416-419（政策上 Z01 不收未綁／測試資料；嚴格刷新比對 UID 必然 mismatch 會弄壞編輯流程），正確。要補一個 demo 分支的缺口：它的查重沒有 is_active 條件，撞到自己名下停學的同證號學員時既不 409（不像正式路徑的 parents.js:631-636）也不 INSERT，結果是回 201 但清單完全沒變、家長看不出發生什麼事（parents.js:595-598）。

**44. 停學學員在家長端是完全碰不到的——連系統內部把資料落地本地的比對也跳過停學列。所以家長端任何寫入都不可能覆蓋到一位停學學員的資料，只會另外開新列。** 〔覆核時補上〕
- 依據：server/routes/parents.js:248-250 `SELECT id FROM students WHERE parent_id = $1 AND id_number = $2 AND COALESCE(is_active, TRUE) = TRUE LIMIT 1`；同函式 :256-259 `SELECT id FROM students WHERE parent_id = $1 AND ragic_record_id = $2 AND COALESCE(is_active, TRUE) = TRUE LIMIT 1`（persistStudentMirrorAfterRagic，定義在 :230）。配合第 39 條的 409 守門，家長端實際上完全無法從停學學員身上「續用」任何資料。

**45. 後台不能手動新增家長，一律回 410 並指回 Ragic 建檔流程。所以「新的一戶（家長＋小孩）」只有一條進系統的路：櫃台在 Ragic Z01 建檔 → 客戶用 LINE 註冊綁定 → 同步進本地。後台的學員建檔（第 44 條）只能加在已經存在的家長底下。** 〔覆核時補上〕
- 依據：server/routes/admin/customerParents.js:150-155 `router.post('/', requireAdminAuth, requireResource('customer-parents'), (req, res) => { res.status(410).json({ error: '手動新增家長已停用：請於 Ragic Z01 建檔，客戶完成 LINE 註冊綁定後會自動進入本系統', code: 'PARENT_CREATE_VIA_RAGIC' }); });`；理由註解在同檔 :148-149「未綁資料進 Z01（夜間 pull 又分流進 Z03，清不完的循環）」

**46. 家長要新增或編輯任何一位學員之前，系統會先檢查「家長本人的 Z01 必填欄位齊不齊」；不齊全時會即時回 Ragic 補查一次，補完還是不齊、或補回來的手機／LINE UID 與登入帳號不符，整個學員異動就會失敗。所以家長本人資料不完整時，他連小孩的名字都改不了。** 〔覆核時補上〕
- 依據：server/routes/parents.js:186 `assertParentReadyForStrictSync(base, lineUid);`（parentForStrictStudentSync 內，先試本地）→ :192-195 Ragic 補查 → :208-214 `if (base.phone && mapped.phone !== base.phone) { throw new ParentRefreshError('RAGIC_REFRESH_PHONE_MISMATCH', 'Ragic Z01 手機與目前登入帳號不一致', 502); }` / `RAGIC_REFRESH_UID_MISMATCH` → :224 `assertParentReadyForStrictSync(merged, lineUid);`；呼叫端在新增（:605）與編輯（:710）兩條路徑上都先跑這一支


#### 判準不一致（17 條）

**1. 同一件事——「未綁 LINE 的家長，他的學員可不可以編輯」——兩個後台入口判準不一樣：學員資料頁只在「明確要改成在籍」時才擋；家長頁子表只要送出的學員陣列裡有任何一筆不是明確標成停學，整筆就 409，連單純改姓名都過不去。**

- 誰能做：櫃檯／主管／管理員
- 依據：server/routes/admin/customerStudents.js:195 `if (b.is_active === true && !isRealLineUid(own.rows[0].parent_line_uid))` vs server/routes/admin/customerParents.js:331 `if (!parentHasRealLineUid && b.students.some((s) => s && (!s.id || s.is_active !== false))) { ... code: 'PARENT_UNBOUND_CANNOT_ACTIVATE_STUDENT' }`
- 註：核實無誤，而且更嚴重一點：customerParents.js:331 的擋門在 `for` 迴圈之前，是**整批 ROLLBACK**——同一次送出裡其他學員的合法修改、以及家長本人欄位的修改（:325 已寫入同一交易）全部一起被撤回。錯誤碼與學員資料頁完全相同（PARENT_UNBOUND_CANNOT_ACTIVATE_STUDENT），但訊息不同（「無法新增或啟用學員」vs「無法啟用」），從畫面上仍難分辨是哪一種。

**2. 停學學員仍然看得到自己的「上課記錄」。這支查詢只看「學員屬於這個家長」與「這一期名單還是 active」，完全不看學籍。**

- 誰能做：家長自己（看得到）
- 依據：server/routes/courses.js:24-28 `const conds = [ \`s.parent_id = $1\`, \`cpe.status = 'active'\`, \`cs.status IN ('confirmed','completed','pending_group_confirm')\` ];`；:67-68 `FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id`（全查詢無 is_active 條件）
- 註：對照組正確：同一家長的個人資料頁（parents.js:106）已完全看不到這個小孩，所以畫面上會出現「學員清單沒有小明、上課記錄一堆小明」。這支端點還會回小明的姓名（courses.js:62 `s.name AS student_name`），不只是筆數。

**3. 課程詳情頁判斷「這門課能不能操作（顯示簽到／預約按鈕）」，依據是「本家長在這一期有掛載學員」，而那份學員清單沒有排除停學學員。結果是停學學員的課仍然畫出可操作按鈕，按下去才被擋。**

- 誰能做：家長自己（看得到但用不了）
- 依據：server/routes/courses.js:552-561 `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) ORDER BY s.name), '[]'::jsonb) FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = cper.id AND cpe.status = 'active' AND s.parent_id = $2) AS students_detail`；:619-620 `const ownStudents = Array.isArray(row.students_detail) ? row.students_detail : []; const canAccessPeriod = !!row.course_period_id && ownStudents.length > 0;`
- 註：文件宣告的對照正確（docs/entitlement_repair_2026-09-22.md:45-46）。要補一點：**/mine 也自己算了一份 canAccessPeriod**（courses.js:245，用 :160-169 那份同樣未過濾的 students_detail），所以「看得到但用不了」在課程列表頁與詳情頁**兩處**都在，不只詳情頁。原清單只提到 /mine 有同樣的子查詢，沒指出 /mine 也據此畫按鈕。

**4. 停學學員的學習歷程，家長仍然打得開。守門只看「名下有學員在這一期，狀態是 active 或 transferred_out」，不看學籍。**

- 誰能做：家長自己（看得到）
- 依據：server/routes/learn.js:153-160 `SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = $1 AND s.parent_id = $2 AND e.status IN ('active','transferred_out') LIMIT 1` → `if (!guard.rowCount) return res.status(403).json({ error: 'Forbidden' });`
- 註：transferred_out 刻意放行、停學是意外一起被放行，核實無誤（同一個查詢沒有 is_active 條件）。

**5. 預約頁：停學學員的家長打得開課程期的可預約時段頁（看得到教練空檔），但按下去預約會被擋。看的那支不看學籍，訂的那支看。**

- 誰能做：家長自己（看得到但用不了）
- 依據：看：server/routes/slots.js:215-224 `SELECT 1 FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $1 AND s.parent_id = $2 AND cpe.status = 'active' LIMIT 1` → 否則 403「無權檢視此課程期」；訂：server/routes/slots.js:297-306 `const entitledStudents = await assertCourseEntitlement(client, coursePeriodId); ... AND cpe.student_id = ANY($3::uuid[])` → 403「無權預約此課程期」
- 註：規則本身成立，但**錯誤碼的敘述要修正**：回什麼錯誤取決於這一期還有沒有別的在籍學員。(a) 跨家庭／共班課期還有其他在籍學員 → assertCourseEntitlement 回傳的名單排掉停學那位，接著 slots.js:306 回 403「無權預約此課程期」（原清單說的情況）。(b) 這一期名單已經沒有任何在籍學員（例如獨生子女停學）→ assertCourseEntitlement 直接拋 STUDENT_ENTITLEMENT_INACTIVE（courseEntitlements.js:131），slots.js:340 `if (err.status === 409) return res.status(409).json({ error: err.message, code: err.code });` 會如實回 409 + STUDENT_ENTITLEMENT_INACTIVE。所以「從錯誤訊息完全看不出是停學造成的」只在共享課期成立。

**6. 課程轉讓：停學學員仍然會出現在家長的轉讓對象下拉，而且後端不檢查學籍——停學學員可以真的把剩餘堂數轉給別的家庭。**

- 誰能做：家長自己（做得到）
- 依據：前端來源：client/liff/src/pages/TransferRequestPage.jsx:34 `const students = selected?.students_detail || [];`（即 courses.js:160-169 那份未過濾清單）；後端：server/services/transfers.js:60-70 `... JOIN students s ON s.id = cpe.student_id WHERE cp.id = $1 AND s.id = $2 AND s.parent_id = $3 AND cpe.status = 'active' AND cp.status = 'active'`（無 is_active）→ `if (!en.rowCount) throw ... 400`
- 註：「整個面向唯一一個停學學員還能造成實質資產移動的路徑」這個判斷經核對成立（其他停學能做的事都是唯讀）。只要 remaining > 0（transfers.js:71-72）就送得出申請，後續由 admin/manager 核准（adminResources.js:38）。

**7. 停學不會停掉推播。教練發布課程計畫或送出授課紀錄時，通知名單是「這一期 active 名單的所有家長」，沒有排除停學學員。**

- 誰能做：系統自動
- 依據：server/routes/learn.js:183-186 `ARRAY(SELECT DISTINCT pa.line_uid FROM course_period_enrollments e JOIN students s ON s.id = e.student_id JOIN parents pa ON pa.id = s.parent_id WHERE e.course_period_id = cp.id AND e.status = 'active' AND pa.line_uid IS NOT NULL) AS uids`；同檔 :204-207 同一份查詢
- 註：`parents.is_active` 也沒看，所以連登入已被封的停用家長帳號都還會收到 LINE 推播——核實無誤（兩支查詢的 WHERE 都只到 pa.line_uid IS NOT NULL）。

**8. 教練／櫃檯看到的班級名單也含停學學員。槽位／課表上的學員姓名清單沒有過濾學籍。**

- 誰能做：系統自動
- 依據：server/routes/slots.js:85-91 `COALESCE((SELECT json_agg(s.name ORDER BY s.name) FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = cp.id AND cpe.status = 'active'), '[]'::json) AS student_names`
- 註：對照正確（櫃檯手動扣課的出席名單有過濾：manualDeductions.js:335）。但漏掉範圍：同一種未過濾的 student_names 還出現在 **server/routes/sessions.js:350、390、434、478、524**（教練端今日／本週／歷史／歷史課期等 5 支）與 **server/routes/integrations.js:54-57**（行事曆整合）。所以「教練看到 3 個名字、櫃檯只登記 2 人出席」不只在週表，在教練端幾乎每一個名單畫面都會發生。

**9. 同一個例外，文件寫的條件與程式的條件不同：文件說是「單人課期」，程式的條件是「名單裡已經沒有任何在籍學員」——那可以是三人全部停學的共享課期。**

- 誰能做：櫃檯／主管／管理員
- 依據：docs/entitlement_repair_2026-09-22.md:106 `| **T1** | server/services/courseEntitlements.js | 名單查詢排除 is_active = false 的學員；唯一例外是**單人課期**中被呼叫端明確指名的那一位 | ...` vs server/services/courseEntitlements.js:116-121 `// 例外的條件是「名單裡已經沒有任何未停用的學員」，不是「名單只有一人」。... 用「只有一人」當條件會讓「全員停用的共享課期」被擋掉，那是對共享課期單獨加的硬擋，踩到凍結令第 3 條。`
- 註：程式註解本身就明文反駁文件，核實無誤。同一份文件的另一處（:106 同一格「為什麼」欄）也寫「單人課期停用學員的補登」，manualDeductions.js:333-334 的註解同樣寫「單人課期」——所以「單人課期」這個錯誤說法在文件與另一支程式的註解裡共三處，只有 courseEntitlements.js 的實作與註解是對的。交接以程式為準。

**10. 課程轉讓核准時，轉入方的學員是用「姓名字串完全相同」去找的，而且不看學籍——可能把課轉進一位已經休學的同名學員身上。**

- 誰能做：主管／管理員（核准動作的副作用）
- 依據：server/services/transfers.js:132-135 `const sExist = await client.query(\`SELECT id FROM students WHERE parent_id = $1 AND name = $2 LIMIT 1\`, [toParentId, sName]);`
- 註：三個入口三種答案，全部核實：團購 groupOrders.js:164-172 有加 `AND COALESCE(is_active, TRUE) = TRUE`；家長端新增學員 parents.js:631-636 遇停學就 409 要家長找櫃檯；轉讓核准這裡完全不看。裸字串比對（沒走 normalizeStudentName，不做 NFKC、不去空白）也核實無誤——對照 identityNormalizer.js:20-26 的 normalizeStudentName 會 NFKC + 去全部空白 + 轉小寫。而且這支查詢沒有 ORDER BY 就 LIMIT 1，同名多筆時命中哪一筆不確定。

**11. 團購加入流程建學員時，比對既有學員會排除停學的人，比對不到就直接新建——同一個身分證可以因此出現第二筆學員資料，而且不會有任何錯誤。**

- 誰能做：家長自己（做得到）
- 依據：server/routes/groupOrders.js:155-160 `SELECT id, name FROM students WHERE parent_id = $1 AND id_number = $2 AND COALESCE(is_active, TRUE) = TRUE LIMIT 1`，比對不到則 :178-182 `INSERT INTO students (parent_id, name, birth_date, gender, id_number, blood_type) VALUES ($1, $2, $3::date, NULLIF($4,''), NULLIF($5,''), NULLIF($6,''))`
- 註：對照成立：同情境在個資頁是 409 STUDENT_INACTIVE_CONTACT_COUNTER（parents.js:631-636）。同一位家長、同一個小孩、同一個身分證，走個資頁被擋、走團購頁默默多出一筆在籍學員；因為 id_number 沒有唯一索引（第 41 條），資料庫不吭聲。第二層 name+birth 比對（groupOrders.js:164-172）同樣排除停學者，所以連改用姓名生日也接不回去。

**12. 團購加入流程建學員只要求姓名，身分證與生日都是選填、也不驗格式；家長端個人資料頁則要求身分證格式正確且生日必填。同一個「建學員」動作，兩個入口的把關強度完全不同。**

- 誰能做：家長自己
- 依據：server/routes/groupOrders.js:109-119 `function cleanNewStudents(arr) { ... id_number: s?.id_number ? String(s.id_number).trim().toUpperCase() : null, birth_date: s?.birth_date ? String(s.birth_date).trim() : null, ... }).filter((s) => s.name);` vs server/routes/parents.js:581 `if (!s.name || !s.birth_date || !ISO_DATE.test(s.birth_date) || !TW_ID.test(s.id_number))`
- 註：另一個差異也核實：個資頁必須先在 Ragic 嚴格寫成功才落地本地（parents.js:642-656 先 createStudentZ01Z02Strict / updateStudentZ01Z02Strict 再 persistStudentMirrorAfterRagic），團購是先落地本地、Ragic 回寫 best-effort 失敗只記 log（groupOrders.js:200-206 + ragicWriteback.js 的 warn-only 契約）。所以團購建出來的學員可能長期停在「本地有、Ragic 沒有」。

**13. Ragic 學員同步的比對鍵實際上只有「家庭內姓名精準相符」一項——身分證與 Ragic record id 都不參與比對。程式的說明註解與實作不一致。**

- 誰能做：系統自動
- 依據：註解 server/services/parentSync.js:344 ` *  匹配序：(parent_id, id_number) → (parent_id, ragic_record_id) → (parent_id, name, birth_date)。` vs 實作 :373-377 `const exactNameMatches = familyRows.filter((row) => normalizeStudentName(row.name) === incomingName); ... matched = exactNameMatches[0] || null;`（查詢 :369-370 撈了 id/name/birth_date/id_number/ragic_record_id，但只用 name 比）
- 註：核實無誤。連帶後果（小孩在 Ragic 端改名 → 比對不到 → 當新學員 INSERT 一筆、舊列留著）也成立，這正是同一個小孩兩筆資料的來源之一。補一個相關細節：同一段 :392-397 會先把「掛在別的家長名下」的同 ragic_record_id 佔用解除，所以 ragic_record_id 在這裡是「寫入時避讓唯一鍵」用的，不是比對鍵——跟註解說的「匹配序第二層」完全是兩件事。

**14. 兩條 Ragic 同步路徑對停學的處理完全相反：一般家長同步明文保護「已停學的不會被同步復活」；夜間 canonical Z01 匯入卻無條件把學員寫成在籍，會把停學的人復活。**

- 誰能做：系統自動
- 依據：保護：server/services/parentSync.js:420 `is_active   = CASE WHEN is_active = FALSE THEN is_active ELSE TRUE END,`；復活：server/services/ragicAdmin.js:2924-2925 `id_number = COALESCE(NULLIF(id_number,''), NULLIF($7,'')), is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()`（_syncCanonicalZ01Record，定義在 :2767）
- 註：風險最高的一條，全部核實。呼叫端兩處：ragicAdmin.js:3140 與 :3203（_reconcileZ01FromShadowImpl 定義在 :3164），:3485 再被上層排程叫。稽核會留 by_role='system'、by_user='ragic:canonical-z01-sync'（:2939-2942），從畫面不容易看出是同步幹的。同一支函式對家長列也是無條件 `is_active = TRUE`（:2855），所以被停用的家長帳號也會被這條路徑靜默復活登入權限——這點比原清單寫的更嚴重，值得單獨跟櫃檯講。

**15. 後台家長清單顯示的學員人數是「全部學員」，不是在籍學員。**

- 誰能做：系統自動（顯示）
- 依據：註解 server/routes/admin/customerParents.js:4 ` *   GET   /api/admin/customer-parents          → 家長清單（含啟用學員數、LINE 綁定狀態）` vs 實作 :113-115 `SELECT ${PARENT_COLS}, COUNT(s.id) AS student_count FROM parents p LEFT JOIN students s ON s.parent_id = p.id`（無 is_active 條件）；畫面 client/admin/src/pages/CustomerParentsPage.jsx:160 `{r.student_count} 位 →`
- 註：「清單看到 3 位、點進去只有 2 位在籍」成立。停學學員在後台看得到、只是用 `ORDER BY is_active DESC` 排到最後（customerParents.js:137、:385；customerStudents.js:83），正確。

**16. 課程聊天室完全不看學籍：停學學員的家長仍然看得到、也進得去該課期的聊天室，聊天室名單上還會顯示停學學員的姓名。這是「這位家長在這一期有沒有權限」這件事的第四種判準（前三種是上課記錄、學習歷程、預約頁），而且是唯一一個連唯讀清單都會把停學學員姓名揭露給同期其他家長看的地方。** 〔覆核時補上〕
- 依據：進聊天室的守門：server/routes/chat.js:114-118 `SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = $1 AND e.status = 'active' AND s.parent_id = $2` → `allowed = own.rowCount > 0;`（無 is_active）；聊天室清單與名單：server/services/chatRooms.js:71-73 `(SELECT array_agg(DISTINCT s.name) FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active') AS student_names`、:74-76 同款的 `array_agg(DISTINCT s.parent_id) AS parent_ids`、:138-145 `async function listRoomsForParent(parentId) { ... WHERE EXISTS (SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active' AND s.parent_id = $1) ... }`

**17. 家長編輯自己小孩時，身分證撞號一律回同一句 409，完全不分辨撞到誰——不管撞到的是自己名下的停學小孩、還是別的家庭的小孩，訊息都是「此身分證字號已有學員資料」。同一件事在新增學員時卻會分三種情況給三種不同處置（自己名下在籍→合併回 200、自己名下停學→叫你找櫃檯、別人名下→不揭露對方）。** 〔覆核時補上〕
- 依據：編輯：server/routes/parents.js:687-698 `SELECT id FROM students WHERE id_number = $1 AND id <> $2 LIMIT 1` → `if (dup.rowCount) { return res.status(409).json({ error: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。', code: 'STUDENT_ID_DUPLICATED' }); }`（不看 parent_id、不看 is_active）vs 新增：server/routes/parents.js:612-645（同樣全系統比對，但 :625 分別人名下、:631 分自己名下停學、:638 合併在籍）。實務症狀：家長想幫小孩訂正身分證打錯的字，只要那組號碼在系統裡被任何一筆（含停學、含別家）佔著，他就改不動，而且從訊息看不出是自己家那位停學的小孩佔著。


#### 只在文件裡（程式沒有／不同）（2 條）

**1. 反過來，「這個學員確實不再上課了，要把他從課期名單移除」目前沒有任何後台介面可以做，只能直接改資料庫。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：文件 docs/entitlement_repair_2026-09-22.md:41-43 `- **學員確實停學不再上課** → 把該學員在這些課期的 course_period_enrollments.status 改成非 active（沿用現有的退出狀態值，不要自創）。`；實作：`grep -rn "UPDATE course_period_enrollments" server/` 全 repo 只命中 server/services/transfers.js:151 `UPDATE course_period_enrollments SET status = 'transferred_out' WHERE course_period_id = $1 AND student_id = $2`（課程轉讓核准）
- 註：核實無誤，而且文件那句「沿用現有的退出狀態值」本身沒有可用的值可沿用：enrollment_status 列舉只有 active / transferred_out（coreSchema.js:26），transferred_out 的語意是「課轉給別人了」，用來代表「退出／停課」會讓轉讓報表跟停學混在一起。這是文件開了一條櫃檯做不到、而且連 DB 也沒有正確值可填的路。

**2. 權威同步不會軟刪除也不會硬刪除學員——文件寫的「只硬刪無業務 FK 的殘留」實際上沒有執行。**

- 誰能做：沒有人
- 依據：文件 replit.md:206 `新策略不再 soft-delete 學員：權威移除時只硬刪「無業務 FK」的本地殘留；有 FK 的列保留關聯`；實作 server/services/parentSync.js:176-180 `async function hardDeleteStudentIfSafe(client, studentId) { void client; void studentId; return false; }`（永久 no-op），且整段掃尾被旗標包著 :459 `if (authoritative && STABILITY_FLAGS.DESTRUCTIVE_RECONCILE_ENABLED) {`，旗標預設 false（server/config/ragicSchema.js:98 `get DESTRUCTIVE_RECONCILE_ENABLED() { return envFlag('DESTRUCTIVE_RECONCILE_ENABLED', false); }`）
- 註：雙重關閉（旗標預設關 + 函式本身回 false）核實無誤。實務結論成立：Ragic 端把學員從名單移掉，本地那一筆永遠留著、而且仍是在籍，沒有任何自動清理。


#### 查不清楚（1 條）

**1. 家長新增學員時傳給 Ragic 的「排在子表第幾列」參數其實沒被使用，實際列位是 Ragic 同步函式自己算的。**

- 誰能做：系統自動
- 依據：呼叫端 server/routes/parents.js:648 `sync = await ragic.createStudentZ01Z02Strict({ parent: parentForSync, student: s, startIndex: activeCount });` 但 server/services/ragic.js:1450 `async function createStudentZ01Z02Strict({ parent, student }) {`（簽名沒有 startIndex），列位由 server/services/ragic.js:1084 `Object.assign(payload, buildZ01StudentPayload(student, -(ids.length + 1), true));` 決定
- 註：「參數是死的」這半段已確定，而且**三個呼叫端都白傳**：parents.js:648、ragicWriteback.js:116、ragicAdmin.js:2255。我這次多讀了 buildZ01StudentPayload（ragic.js:1239-1251）：它把 rowIndex 直接接在欄位 id 後面（`payload[\`${field}_${rowIndex}\`]`）且允許負數（:1240 `if (!/^-?\d+$/.test(String(rowIndex))) throw ...`），同一次 payload 裡每位新學員取到不同的負數，所以在單次呼叫內不會互相覆蓋。卡在哪：負數索引在 Ragic 端的確切語意（是否一律當「新增列」、會不會影響既有列順序）只能在 Ragic 上驗，本次不連 Ragic，所以「是不是真的造成子表列順序問題」仍無法判定。


### 3.4 家長看得到什麼（可見性與權限）


#### 實作中（32 條）

**1. 家長登入後拿到一張 12 小時的通行證；之後每一次呼叫都會即時回資料庫確認這個帳號還在、且狀態為啟用，櫃檯一停用帳號，家長下一個動作就會被登出。**

- 誰能做：系統自動（生效條件由櫃檯在客戶管理把 parents.is_active 設為停用觸發）
- 依據：server/middlewares/parentAuth.js:43-44 — `const r = await pool.query('SELECT 1 FROM parents WHERE id = $1 AND is_active = TRUE', [p.parentId]); if (!r.rowCount) return res.status(401).json({ error: 'Parent account not found', code: 'PARENT_NOT_FOUND' });`
- 註：證據行號完全對得上。TTL 寫死 12h（parentAuth.js:14 `const TTL = '12h'`）。type !== 'parent' 回 401 不回 403 的理由寫在 parentAuth.js:36-39。補充：聊天室 HTTP 路由用的 requireLiffUser 也做同一道 DB 查核（parentAuth.js:67-68），但 optionalParent（parentAuth.js:83-94）不查，那支用在團購邀請碼預覽。

**2. 個資頁的學員清單只列在籍學員；被櫃檯停用的學員不會出現。**

- 誰能做：家長自己（唯讀）；在籍狀態只有櫃檯改得動
- 依據：server/routes/parents.js:104-107 — `SELECT id, name, id_number, … FROM students WHERE parent_id = $1 AND COALESCE(is_active, TRUE) = TRUE ORDER BY created_at ASC`
- 註：行號完全對得上。GET /api/parents/me（parents.js:424-428）與 POST /api/parents/me/sync（parents.js:441、480-482 `const me = await loadMe(req.parent.id); res.json({ ...me, sync_status: syncStatus });`）共用同一個 loadMe()，兩支行為一致。

**3. 報名時挑選學員會擋掉已停用的學員，訊息明講「已停用」。**

- 誰能做：家長自己
- 依據：server/routes/enrollments.js:372-374 — `SELECT id, name FROM students WHERE parent_id = $1 AND id = ANY($2::uuid[]) AND COALESCE(is_active, TRUE) = TRUE`；enrollments.js:379 — `'所選學員不存在、已停用或不屬於您', code: 'STUDENT_NOT_AVAILABLE'`
- 註：行號對得上。這是「有過濾」的對照組，證明 is_active 不是被系統性忽略，而是各入口自己決定。

**4. 通行證裡的手機號碼是登入那一刻的快照。櫃檯在家長登入後改了手機號碼，家長不重新登入的話，課程卡會用舊號碼去撈資料（可能撈成空的，或撈到號碼的前主人的單）。**

- 誰能做：櫃檯（改號）／系統自動（快照）
- 依據：server/middlewares/parentAuth.js:21-25 — `function signParentToken({ parentId, phone, lineUid = null }) { const payload = { parentId, phone, type: 'parent' }; … }`；server/routes/admin/customerParents.js:15 註解 `phone：值屬 Ragic、綁定關係屬 Replit；此處允許客服改號，唯一鍵衝突回 409`
- 註：行號完全對得上。暴露窗口最長 12 小時。以帳號 id 為準的端點（上課記錄、學習歷程、聊天、評鑑、轉讓）不受影響；手機歸戶的端點會錯：/courses/mine（courses.js:222）、/courses/:id（courses.js:616）、付款證明上傳（server/routes/uploads.js:54 與 64 皆用 `parent_phone = … OR … = ANY(COALESCE(extra_parent_phones,'{}'))`）。

**5. 報名單上的家長手機是櫃檯自由輸入的文字，系統不檢查這支號碼是不是真的對應到一個已註冊家長。櫃檯打錯一碼而剛好打中另一位已註冊家長時，那位家長的課程頁就會多出一張陌生人的訂單（含對方姓名、手機、學員姓名、金額）。**

- 誰能做：櫃檯（建單時輸入）
- 依據：db/migrations/002_admin_tables.sql:81-82 — `parent_phone TEXT NOT NULL, students TEXT[] NOT NULL`（無外鍵）；server/routes/admin/enrollments.js:790-792 — `const parentMatch = await client.query('SELECT id FROM parents WHERE phone = $1 LIMIT 1', [parentPhone]); const checkout = await createCheckoutSession(client, { parentId: parentMatch.rows[0]?.id || null,`
- 註：行號全部對得上；查到的 id 只拿去填付款單的 parentId，查不到就填 null 照建。學員姓名同樣是自由文字（server/routes/admin/enrollments.js:602-603 `? b.students.map((s) => String(s || '').trim()).filter(Boolean) : []`），沒有對應到學員檔案。這一條跟記憶中的「教練名孤兒」是同一類問題（自由文字當識別）。

**6. 單筆報名狀態頁也用手機比對；而且是先把整筆資料撈出來、再判斷有沒有權限，所以「報名編號存在但不是你的」回 403、「報名編號不存在」回 404，外部可以靠狀態碼分辨編號存不存在。**

- 誰能做：家長自己（查詢）
- 依據：server/routes/courses.js:614-618 — `if (!r.rowCount) return res.status(404).json({ error: '找不到此報名' });` … `const owns = row.parent_phone === phone || (row.extra_parent_phones || []).includes(phone); if (!owns) return res.status(403).json({ error: '無權檢視此報名' });`
- 註：行號完全對得上（404 在 614，403 在 618）。資料在 403 之前已經從資料庫讀出來（含轉帳帳號、末五碼），但沒有回傳給呼叫端。報名編號為可讀短碼（EMP…），非隨機 UUID。

**7. 被櫃檯加進「額外家長手機」的人（實務上是配偶），看得到整張課程卡：主要家長的姓名與手機、學員姓名、原價與實收金額、付款方式、匯款末五碼狀態、退費原因與退件時間。**

- 誰能做：櫃檯（只有後台 PATCH 報名單能寫入這個欄位，server/routes/admin/enrollments.js:1037-1039 與 1114 `extra_parent_phones = $12`）
- 依據：server/routes/courses.js:260-276 — `parent_name: row.parent_name, parent_phone: row.parent_phone, students: row.students || [], … cancel_reason: row.cancel_reason || null, returned_at: row.returned_at || null,`
- 註：行號微調：回傳區塊是 courses.js:260-276（returned_at 在 276，原寫 259-275 漏掉最後一行）。家長端沒有任何自助加入額外家長的路徑。

**8. 額外家長雖然看得到卡片，卻不能操作那一期（不能預約、不能簽到、不能看學習歷程）——因為「可操作」的判準改回帳號：名下必須有在籍學員掛在這一期。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:244-245 — `const ownStudents = Array.isArray(row.students_detail) ? row.students_detail : []; const canAccessPeriod = !!row.course_period_id && ownStudents.length > 0;`；courses.js:278 `course_period_id: canAccessPeriod ? row.course_period_id : null,`
- 註：行號微調（244-245，原寫 243-245）。同一張卡上「看得到」用手機、「動得了」用帳號，是刻意的兩層設計（courses.js:246-250 註解說明是為了避免前端點進去被 learn/slots 守衛 403）。副作用：舊資料只有課期、沒有在籍掛載時，卡片會顯示成不可操作的「課程開通處理中」。同樣邏輯在單筆報名狀態頁重複一次（courses.js:619-620、655）。

**9. 課程卡上的「已用堂數」是整個課期共用的池子：算的是這一期有任何人出席過的堂數，不分家庭、不分小孩；同一堂有三個小孩到場也只算一堂。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:173-179 — `SELECT COUNT(DISTINCT cs2.id)::int FROM course_sessions cs2 JOIN checkin_records cr ON cr.course_session_id = cs2.id WHERE cs2.course_period_id = cper.id AND cs2.status::text NOT LIKE 'cancelled%' AND cr.attendance_status = 'ATTENDED'`
- 註：行號微調（173-179，原寫 172-179）。報名狀態頁用同一段查詢（server/routes/courses.js:544-550）。程式註解自己寫明「不限本家庭，因家庭共班／團報共用同一堂數池」（courses.js:171-172）。實務意義：團報或家庭共班時，家長看到的剩餘堂數會因為別家小孩去上課而減少。

**10. 團報課期一旦有人簽到，同組其他家長會在上課記錄的按鈕上看到「已簽」加上簽到那位家長的全名（只有姓名，不含電話或帳號）。**

- 誰能做：系統自動（顯示）
- 依據：server/routes/courses.js:112-113 — `checked_in_by_name: showPartner ? (partnerName || null) : null, partner_checkin_label: showPartner ? partnerCheckinLabel(partnerName, partnerGender) : null,`
- 註：行號微調（112-113，原寫 110-114）。這是明確的政策決議，文件與程式對得上：CLAUDE.md:13 第 2 條、replit.md:39。此檔為凍結範圍（server/routes/courses.js:1-6 檔頭凍結標記明列 /lessons、/mine、/:id 的簽到方姓名揭露），改動需先取得擁有者同意。

**11. 非團報的課期（家庭共班、一般個別課）不揭露任何他人的簽到身分；教練或櫃檯代簽也不揭露。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:82 — `WHERE cp.group_order_id IS NOT NULL`（夥伴簽到的 LATERAL 解析整段只在團報期執行）；courses.js:107-109 `const ownByCoach = !!row.checkin_id && !ownAuthor; const showPartner = !!partnerParentId && !ownByCoach && (!row.checkin_id || String(ownAuthor) !== String(req.parent.id));`
- 註：行號完全對得上。判準是「這一期有沒有團購單號」，不是「有沒有跨家庭」。櫃檯手動建立的跨家庭共班沒有團購單號，所以走不揭露分支。課程卡與報名狀態頁的今日夥伴簽到也同樣以 `CASE WHEN cp.group_order_id IS NOT NULL THEN …` 為閘門（courses.js:191、580）。

**12. 家長自助簽到成功後，回覆只列自己家小孩的姓名，但會回傳整班實際被寫入出席的人數，所以家長知道「這一堂有幾個人被記出席」，只是不知道是誰。**

- 誰能做：家長自己（操作）
- 依據：server/routes/checkins.js:305-307 — `// 不把其他家庭的姓名透露給操作家長；後端仍已替完整 active roster 建 attendance。 checked_in_students: own.rows.map((s) => s.name), attendance_count: activeParticipants.rowCount,`
- 註：行號完全對得上。整班寫入由旗標 SHARED_CHECKIN_USAGE_V2 控制，目前對全部家長開啟（server/bootstrap/coreSchema.js:493 `VALUES ('SHARED_CHECKIN_USAGE_V2', TRUE, '{}'::text[])`；空白名單＝全部人，見 server/services/featureFlags.js:33-35 `if (!flag.allowedPhones?.length) return true;`）。CLAUDE.md:16 第 5 條規定不得縮窄。

**13. 學習歷程頁的標頭會列出這一期全部學員的姓名，包含別家小孩的姓名，沒有遮罩。**

- 誰能做：系統自動（顯示）
- 依據：server/services/learning.js:328-334 — `(SELECT array_agg(s.name ORDER BY s.name) FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = cp.id AND cpe.status IN ('active','transferred_out')) AS student_names`；顯示在 client/liff/src/pages/LearningHistoryPage.jsx:88 `學員：{studentNames.join('、')}`（來源 LearningHistoryPage.jsx:72 `const studentNames = period?.student_names || [];`）
- 註：行號對得上，前端確實有畫出來（與聊天室清單不同，見 rejected 第 22 條）。沒有任何 parent_id 過濾，也包含已轉出的學員姓名。跨家庭共班或團報的家長都會看到。另外：學員超過一位時，LearningHistoryPage.jsx:101-112 還會畫出一排以「別家小孩姓名」為標籤的切換鈕。

**14. 學習歷程的課前規劃與每堂授課記錄的班級層文字是綁在課期上、不分學員的，所以同一期的每個家長看到的是同一份內容；只有已發布／已送出的版本會外流。**

- 誰能做：教練（撰寫並發布）
- 依據：server/services/learning.js:342 — `SELECT * FROM lesson_plans WHERE course_period_id = $1 AND status = 'published'`；learning.js:346-349 — `SELECT sr.*, cs.scheduled_at … WHERE sr.course_period_id = $1 AND sr.status = 'submitted'`
- 註：行號對得上；草稿（未 published / 未 submitted）不外流。措辭修正：原敘述「不分學員」只對班級層欄位成立——`SELECT sr.*` 連帶把 session_records.student_records（依學員姓名分格的個別記錄）整包回傳，那部分是分學員的，而且每位家長都看得到全部學員的格子。詳見 added 第 1 條。

**15. 聊天室訊息的發送者名稱會顯示成「家長姓名（該家長在這一期的學員姓名）」，所以跨家庭共班的家長在對話裡看得到其他家長的姓名以及他們小孩的姓名。**

- 誰能做：系統自動（顯示）
- 依據：server/routes/chat.js:73-76 — `for (const p of r.rows) { const names = Array.isArray(p.student_names) ? p.student_names.filter(Boolean) : []; parentMap.set(p.id, names.length ? `${p.name}（${names.join('、')}）` : p.name); }`
- 註：行號完全對得上。括號內的學員只取該發話家長自己的小孩（chat.js:68 `AND s.parent_id = p.id`），所以呈現是「別家家長姓名（他家小孩姓名）」。沒有 isSelf 判斷、沒有遮罩。教練訊息顯示成「姓名＋教練」（chat.js:51 `coachMap.set(c.id, `${c.name} 教練`)`）。

**16. 團購狀態頁看得到別家有沒有繳費、有沒有上傳證明（是／否），但看不到別家的匯款末五碼、發票載具與證明圖片網址；金額與學生人數則看得到。**

- 誰能做：家長自己（同團成員）
- 依據：server/routes/groupOrders.js:227-232 — `transfer_last_5: isSelf ? (m.transfer_last_5 || '') : '', carrier: isSelf ? (m.carrier || '') : '', has_payment_proof: !!m.payment_proof_url, … has_payment_info: !!(m.payment_proof_url && String(m.transfer_last_5 || '').trim()),`
- 註：行號完全對得上。文件也對得上：replit.md:246「若屬團報則導去團購狀態頁（可見其他家庭繳費狀態）」。團購詳情限本團成員（groupOrders.js:735-736 `const isMember = loaded.members.some((m) => m.parent_id === req.parent.id); if (!isMember) return res.status(403)`，且 groupOrders.js:409 `router.use(requireParent)` 之後才掛這支）；邀請碼預覽頁未登入也能看，走 optionalParent 的遮罩版（groupOrders.js:350-360）。

**17. 期末評鑑以帳號歸戶，邀請名單在課期結束時由「當時在籍的學員」推導出他們的家長；一位家長在同一期只會有一張評鑑單。**

- 誰能做：系統自動（發出邀請）／家長自己（填寫）
- 依據：server/services/evaluations.js:29-31 — `ARRAY(SELECT DISTINCT s.parent_id FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active') AS parent_ids`；歸戶 evaluations.js:56 `WHERE ce.parent_id = $1`
- 註：行號對得上，僅「已提交不可重送」實際在 evaluations.js:79（原寫 78）`if (cur.submitted_at) { const e = new Error('已提交，不可重複送出'); e.status = 409; throw e; }`。唯一性由 `ON CONFLICT (course_period_id, parent_id) DO NOTHING`（evaluations.js:41）保證，所以一位家長有兩個小孩在同一期也只會收到一張。單筆讀取同樣以 parent_id 鎖住（evaluations.js:70）。

**18. 家長端完全沒有課堂明細端點：/api/sessions 底下每一支都是教練專用。家長要看課堂只能透過上課記錄那一支彙總查詢。**

- 誰能做：沒有人（家長沒有入口）
- 依據：server/routes/sessions.js:161、299、342、378、417、473、511 — 七支路由全部是 GET 且全部掛 requireCoach（例：`router.get('/:id', requireCoach, async (req, res) => {`，sessions.js:511；其餘六支另加 requireCoachOwner('coachId')）
- 註：行號完全對得上，七支無一例外。對得上凍結令 CLAUDE.md:18「server/routes/sessions.js 現為全唯讀」，並有迴歸鎖 tests/coach_checkin_removed_test.js（檔頭自述以白名單＋全掃描斷言教練 router 全為 GET，並附掃描失效偵測）。前端也只在教練頁呼叫（client/liff/src/pages/CoachSessionPage.jsx:57 `sessionsApi.detail(id)`、SessionRecordFormPage.jsx:44 `sessionsApi.detail(sessionId)`，兩處都在 `if (!coach?.id …) return;` 之後）。

**19. 家長不能自己停用或移除學員；打過去一律回「請洽櫃臺」。**

- 誰能做：沒有人（家長端已封）；只有櫃檯在 Ragic／後台處理
- 依據：server/routes/parents.js:749-753 — `router.delete('/me/students/:id', requireParent, (req, res) => { res.status(405).json({ error: '學員資料異動（停用 / 移除 / 轉出）請洽櫃臺，或透過 LINE 官方帳號聯繫。', code: 'STUDENT_REMOVAL_VIA_COUNTER' });`
- 註：行號完全對得上。路徑刻意保留回 405 當後端守門，前端按鈕已移除（parents.js:744-748 的政策說明：避免把「停用」寫進 Ragic Z02 學員身分欄、避免破壞與已報名課程的連結製造孤兒資料）。

**20. 家長新增學員時，如果輸入的身分證字號已經存在於系統（不論屬於哪一個家長），會收到「此身分證字號已有學員資料」。這個比對是全表的，不限自己名下。**

- 誰能做：家長自己（輸入）
- 依據：server/routes/parents.js:612-618 — `SELECT id, parent_id, is_active, name, … FROM students WHERE id_number = $1 LIMIT 1`（無 parent_id 條件）；parents.js:625-629 不同家長時回 409 `'此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。', code: 'STUDENT_ID_DUPLICATED'`
- 註：行號對得上。同一個身分證字號若屬於自己名下且在籍，會改走「嚴格更新既有資料」分支（parents.js:638-646），回 200 而非 201。訊息本身不回傳對方姓名或家長資訊，但回應足以確認「這個身分證字號在系統裡有沒有建檔」。編輯學員時同樣是全表比對（parents.js:687-692 `SELECT id FROM students WHERE id_number = $1 AND id <> $2 LIMIT 1`）。

**21. 曾被櫃檯停用的學員，家長沒辦法用同一組身分證字號重新加回來，必須聯絡客服。**

- 誰能做：沒有人（家長端封鎖）；恢復只能由櫃檯
- 依據：server/routes/parents.js:631-635 — `if (existing.is_active === false) { return res.status(409).json({ error: '此學員曾由櫃台停用或移除，請聯絡客服協助恢復或重新建檔。', code: 'STUDENT_INACTIVE_CONTACT_COUNTER' }); }`
- 註：行號完全對得上。這條與「上課記錄仍顯示停用學員」並存：家長看得到那個小孩的歷史紀錄，卻在個資頁看不到他、也加不回來、也編輯不了（編輯查詢 parents.js:683 帶 `COALESCE(is_active, TRUE) = TRUE`，停用學員回 404『找不到學員』）。

**22. 推薦紀錄頁會把被推薦人的完整手機號碼顯示給推薦人，沒有遮罩。**

- 誰能做：系統自動（顯示）
- 依據：server/routes/referrals.js:62 — `rr.referee_phone, rr.created_at, rr.reward_issued_at`（WHERE 只有 referrals.js:65 `rr.referrer_parent_id = $1`）；原值直接輸出於 referrals.js:74 `status: x.status, referee_phone: x.referee_phone,`
- 註：敘述正確，行號微調：SELECT 在 referrals.js:61-66、輸出在 referrals.js:74（原寫 61-73 沒蓋到輸出那行）。號碼本來是推薦人自己輸入或對方憑連結填入的，但系統其他地方（團購頁 server/routes/groupOrders.js:217-218）對他家資料是遮罩的，此處沒有。

**23. 付款單的歸屬判準是「帳號相符，或這張付款單底下任何一筆子訂單的家長手機／額外家長手機相符」；通過之後看得到該付款單全部子訂單的家長姓名、手機、額外家長手機、學員姓名、匯款末五碼與證明圖片。**

- 誰能做：家長自己（本人或配偶／額外家長）
- 依據：server/routes/checkout.js:25-32 — `if (checkout.parent_id && checkout.parent_id === parent.id) return true; const phone = parent.phone; return (checkout.sub_orders || []).some((o) => (o.parent_phone === phone || (o.extra_parent_phones || []).includes(phone)));`；子訂單內容 server/services/checkouts.js:341-353 `'parent_name', ae.parent_name, 'parent_phone', ae.parent_phone, 'extra_parent_phones', ae.extra_parent_phones, 'students', ae.students, … 'transfer_last_5', ae.transfer_last_5, 'payment_proof_url', ae.payment_proof_url,`
- 註：行號對得上（證明圖片欄位實際在 checkouts.js:353）。設計上一張付款單＝一個家庭：團購核准時每個家庭各自開一張付款單（server/routes/admin/groupOrders.js:479-489 註解『每個家庭有自己的 checkout / idempotency batch』＋`const memberBatchId = randomUUID();`），所以正常情況不會跨家庭。跨家庭外洩只會發生在櫃檯把兩家的報名單掛到同一張付款單上。

**24. 教練照片只有在介紹通過審核並發布之後家長才看得到；查無此人或未發布一律回空陣列，不回 403。但教練清單本身不卡審核狀態，所以家長會在清單看到介紹還沒發布的教練（只是點進去沒有照片）。**

- 誰能做：主管（審核）／系統自動（顯示）
- 依據：卡審核側 server/routes/coaches.js:508-515 — `SELECT intro_review_status FROM coaches WHERE id = $1 AND is_active = TRUE AND COALESCE(is_placeholder, FALSE) = FALSE` … `if (c.rows[0]?.intro_review_status !== 'published') return res.json([]);`；不卡側 server/routes/coaches.js:210-215 清單條件只有 `s.active = TRUE`、`c.is_active = TRUE` 與待分配佔位名排除
- 註：行號對得上（published 檢查在 coaches.js:515）。清單回傳欄位包含 bio、bio_rich_text、bio_detail、intro_review_status（server/routes/coaches.js:101-115 的 PUBLIC_COACH_FIELDS），所以未發布教練的自介文字仍會出現在清單，只有圖片被卡。

**25. 上課記錄一次最多回 500 筆，超過就被截斷，沒有分頁也沒有任何提示。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:90-91 — `ORDER BY cs.scheduled_at DESC LIMIT 500`
- 註：行號完全對得上。筆數是「學員 × 課堂」的乘積（courses.js:67-71 的 JOIN 展開），多小孩多期的家庭較容易碰到。前端有日期／教練／組別篩選（courses.js:29-44），但篩選是送到後端再套 LIMIT，不是前端切片。

**26. 可預約時段只列該課期指定教練、在該課期指定場館、狀態為可預約的空檔；預設範圍是今天起 30 天。**

- 誰能做：教練（開放時段）／家長自己（查詢與預約）
- 依據：server/routes/slots.js:234-239 — `WHERE cas.coach_id = $1 AND cas.venue_id = $2 AND cas.status = 'available' AND cas.start_at >= $3 AND cas.start_at < $4`；預設區間 slots.js:191-194 `req.query.from ? … : parseTaipeiDateBoundary(todayInTaipei())` / `addCalendarDays(ymdInTaipei(fromDate), 30)`
- 註：行號完全對得上。上限 120 筆（slots.js:240 `LIMIT 120`）。下訂時會再驗一次時段與課期的教練、場館是否一致，不一致回 409 SLOT_MISMATCH（slots.js:313-316）；時段被搶走回 409 SLOT_UNAVAILABLE（slots.js:317-320）。

**27. 課期還沒開通或已結束時，可預約時段頁不是回「無權限」，而是回一個空的時段清單加上 0 可用堂數。**

- 誰能做：系統自動
- 依據：server/routes/slots.js:225-226 — `if (period.status !== 'active') { return res.json({ period, sessions_left: 0, slots: [] }); }`
- 註：行號對得上（225-226，原寫 225-227）。退費會把課期狀態改成 refunded（server/services/courseEntitlements.js:142-144）。修正原註：真的按下預約時收到的不是 PERIOD_NOT_ACTIVE——assertCourseEntitlement 在 slots.js:297 就先跑，任何 status !== 'active' 的課期都會在 courseEntitlements.js:70-72 拋 409 PERIOD_ENTITLEMENT_INACTIVE『此課程期已停用或退費，無法簽到或扣課』，並由 slots.js:341 的 `if (err.status === 409)` 原樣回給家長；slots.js:309-312 的 PERIOD_NOT_ACTIVE 分支因此到不了。另外 period 物件即使在非 active 時也照樣回傳（含教練名、場館名、總堂數）。

**28. 可預約時段頁顯示的「剩餘可排堂數」是整期共用的：已購堂數減掉這一期所有人已排、未取消的堂數，不分家庭。**

- 誰能做：系統自動
- 依據：server/routes/slots.js:203 — `COUNT(cs.id) FILTER (WHERE cs.status::text NOT LIKE 'cancelled%')::int AS booked_sessions`（LEFT JOIN course_sessions 只以 course_period_id 相連，slots.js:207）；slots.js:246 `sessions_left: Math.max(0, Number(period.total_sessions) - Number(period.booked_sessions || 0))`
- 註：行號完全對得上。與課程卡的「已用堂數」（以出席計算，courses.js:173-179）是兩套不同的數字：這裡算「已排」，課程卡算「已出席」。家長在兩個畫面會看到不一樣的剩餘數。下訂時的容量檢查用的是第三段查詢（slots.js:323-326），同樣不分家庭。

**29. 學習歷程網址帶了非 UUID 格式的編號（例如舊版前端誤帶報名編號）時，回「查無此課程」而不是系統錯誤。**

- 誰能做：系統自動
- 依據：server/routes/learn.js:150-151 — `if (!/^[0-9a-f]{8}-…$/i.test(req.params.periodId || '')) { return res.status(404).json({ error: '查無此課程' }); }`
- 註：行號對得上（150-151，原寫 150-152）。同樣的防呆也在可預約時段（server/routes/slots.js:186-189，訊息為『課程期不存在』）與評鑑（server/routes/evaluations.js:16 定義 UUID_RE、evaluations.js:30 檢查回 404）。這是為了避免資料庫型別錯誤（22P02）被當成 500。

**30. 課程卡在「同一個課期、非團購、已開通或已上完」時會把多筆子訂單合併成一張卡，學員姓名取聯集、金額加總；合併只發生在這位家長本來就看得到的卡片之間，不會因為合併而多看到別人的單。**

- 誰能做：系統自動（合併）／櫃檯（決定報名單怎麼分批）
- 依據：server/routes/courses.js:327-329 — `const mergeable = !row.group_order_id && row.course_period_id && (row.lifecycle === 'active' || row.lifecycle === 'completed');`；合併後 courses.js:341-343 `students: Array.from(new Set(sorted.flatMap((row) => row.students || []).filter(Boolean))), original_price: sorted.reduce(…)`
- 註：kind 由 uncertain 改為 implemented：不需要查資料庫也能定案。合併的輸入是 shapedRows，而 shapedRows 來自已經被 courses.js:222 `WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)` 過濾過的 r.rows，所以進到合併池的每一張卡本來就是這位家長看得到的。若櫃檯真把兩家湊進同一個 enrollment_batch_id，這位家長也只會拿到自己那一筆（除非他的手機同時被填在另一家的報名單上——那時外洩的原因是第 12 條的自由文字手機，不是合併）。合併本身不擴大可見範圍。

**31. 授課記錄裡的「個別學員記錄」是逐位學員分開寫的，但家長端不分家庭全部攤開：同一期的每位家長都看得到每一位學員（含別家小孩）的姓名，以及該小孩的待加強、回家練習與備註；學員超過一位時畫面還會給一排以各學員姓名為標籤的切換鈕，可以單獨挑別家小孩來看。** 〔覆核時補上〕
- 依據：server/services/learning.js:346-349 — `SELECT sr.*, cs.scheduled_at, cs.duration_minutes … WHERE sr.course_period_id = $1 AND sr.status = 'submitted'`（`sr.*` 整包含 student_records，無任何 parent_id/student_id 過濾）；欄位語意 server/bootstrap/coreSchema.js:629 `student_records JSONB NOT NULL DEFAULT '{}'::jsonb, -- { mode, records: { studentName: fields } }`；畫面 client/liff/src/pages/LearningHistoryPage.jsx:29 `const visibleRows = selectedStudent ? rows.filter(([name]) => name === selectedStudent) : rows;` 與 LearningHistoryPage.jsx:36 `<div className="text-xs font-bold text-brand-teal">{name}</div>`（標題「個別學員記錄」在 LearningHistoryPage.jsx:34，掛載點 LearningHistoryPage.jsx:151 `<StudentRecords data={r.student_records} selectedStudent={selectedStudent} />`，切換鈕 LearningHistoryPage.jsx:101-112）；教練可寫的姓名範圍是整期全部學員（server/services/learning.js:152 `const studentRecords = _studentRecords(fields?.student_records, studentNames);` + learning.js:130-136 以整期學員姓名當白名單）。原清單第 21 條只說學習歷程「不分學員、大家看同一份」，漏掉了這一層真正分學員的內容。

**32. 任何已登入家長都可以一次撈到全公司在職教練的完整名冊，沒有分頁、沒有場館限制，且回傳內容包含教練的計價倍率、資深標記、任職場館、自介全文與介紹審核狀態。** 〔覆核時補上〕
- 依據：server/routes/coaches.js:193-218 — `router.get('/', requireParentOrCoach, …)`，WHERE 只有 `s.active = TRUE AND c.is_active = TRUE` 與待分配佔位名排除，`venueWhere` 只在家長自己帶 venueId 時才加，沒有 LIMIT；回傳欄位白名單 server/routes/coaches.js:101-115 PUBLIC_COACH_FIELDS 含 `'pricing_multiplier', 'multiplier', 'bio', 'bio_rich_text', 'bio_detail', 'intro_review_status'`。程式註解自陳問題規模：coaches.js:177-180「這支會一次吐出全部在職教練的姓名、任職場館、資深標記、價格倍率與介紹審核狀態 —— 正式站實測 165 筆」，並說明已從「完全公開」收成「需登入」。


#### 判準不一致（12 條）

**1. 教練名單與教練介紹照片這兩支端點不做上面那道即時確認——只要通行證還沒過期，已被停用的家長帳號仍然看得到教練清單。**

- 誰能做：沒有人刻意開啟；是兩支端點各自寫了自己的驗證
- 依據：server/routes/coaches.js:170-191 requireParentOrCoach — `const payload = jwt.verify(token, getJwtSecret());` … `else req.parent = { id: payload.parentId || payload.sub || null };`（整段沒有任何 DB 查核）；掛在 coaches.js:193 `router.get('/', requireParentOrCoach, …)` 與 coaches.js:504 `router.get('/:id/media', requireParentOrCoach, …)`
- 註：敘述與判準正確，行號微調：函式體是 coaches.js:170-191（原寫 174-186 落在函式中段）。兩邊對照：parentAuth.js:43-44 查 parents.is_active；coaches.js 這支只驗簽章。最長暴露窗口＝通行證剩餘效期（至多 12 小時）。

**2. 上課記錄頁不看學員在不在籍——只要學員仍掛在該課期的在籍名單中，被停用學員的上課紀錄與姓名就會繼續出現在家長的上課記錄裡。**

- 誰能做：沒有人；這是查詢條件本身的差異
- 依據：server/routes/courses.js:25-27 — `s.parent_id = $1`, `cpe.status = 'active'`, `cs.status IN ('confirmed','completed','pending_group_confirm')`；server/routes/courses.js:67-68 — `FROM course_period_enrollments cpe / JOIN students s ON s.id = cpe.student_id`（無 is_active）
- 註：確認為本面向最重要的發現。條件陣列實際落在 courses.js:25-27（原寫 24-28）。兩邊：個資頁 parents.js:106 過濾 `COALESCE(is_active, TRUE) = TRUE`；上課記錄 courses.js:67-68 不過濾。實際效果＝櫃檯停用學員後，家長個資頁看不到這個小孩，上課記錄仍顯示他的姓名與每一堂紀錄。replit.md:206 只寫了「新策略不再 soft-delete 學員」，沒有交代停用學員的歷史紀錄該不該顯示。

**3. 課程轉讓頁的「要轉讓哪一位學員」下拉，同樣不看在籍狀態，被停用的學員仍可被選出來當轉讓來源。**

- 誰能做：家長自己（選取）
- 依據：server/routes/courses.js:164-168 — `FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = cper.id AND cpe.status = 'active' AND s.parent_id = $2`（回傳欄位名 students_detail）
- 註：行號對得上。同一段查詢在報名狀態頁 server/routes/courses.js:556-559 完整重複一次，兩處都缺 is_active。對照組：報名流程選學員時是有過濾的（server/routes/enrollments.js:372-374）。

**4. 預約上課時段的「這一期是不是我的」守門，只認學員掛在這一期且該掛載為在籍，不看學員本身是否被停用。**

- 誰能做：家長自己（查詢）
- 依據：server/routes/slots.js:215-224 — `SELECT 1 FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $1 AND s.parent_id = $2 AND cpe.status = 'active' LIMIT 1`；不通過回 slots.js:224 403 '無權檢視此課程期'
- 註：行號完全對得上。同一支路由的「真的下訂時段」那一步（slots.js:297-306）會多比對一份由 assertCourseEntitlement 算出的有效名單（`AND cpe.student_id = ANY($3::uuid[])`），那份名單排除停用學員（server/services/courseEntitlements.js:127-128），所以停用學員看得到時段、按下去才被擋，且擋下來的訊息換成 slots.js:306 403 '無權預約此課程期'。

**5. 學習歷程的守門不看學員在籍狀態，而且額外接受「已轉出」的學員掛載——轉出後家長仍看得到那一期的學習歷程。**

- 誰能做：家長自己（唯讀）
- 依據：server/routes/learn.js:153-157 — `SELECT 1 FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = $1 AND s.parent_id = $2 AND e.status IN ('active','transferred_out') LIMIT 1`
- 註：行號對得上（守門查詢 153-157，403 在 158）。全系統只有兩處承認 transferred_out：learn.js:157 與 server/services/learning.js:332。上課記錄（courses.js:26）、時段（slots.js:220）、聊天室（server/services/chatRooms.js:207）、評鑑邀請（server/services/evaluations.js:31）、簽到（server/routes/checkins.js:105、122、354）一律只認 'active'。結果：學員轉出後，家長的學習歷程還在，上課記錄與聊天室當場消失。狀態由轉讓核准寫入（server/services/transfers.js:151 `UPDATE course_period_enrollments SET status = 'transferred_out'`）。

**6. 家長簽到時，停用學員最終還是會被擋下來，但擋下來的位置與錯誤訊息跟其他入口不同：不是「不屬於你」，而是「已退費或不在有效課程名單中」。**

- 誰能做：家長自己（操作）
- 依據：server/routes/checkins.js:331-334 歸屬檢查 `SELECT 1 FROM students WHERE id = $1 AND parent_id = $2`（無 is_active，checkins.js:337 回 403）；真正擋下來的是 server/services/courseEntitlements.js:130-131 `if (!roster.length || (studentId && !roster.includes(studentId))) throw conflict('STUDENT_ENTITLEMENT_INACTIVE', '學員已退費或不在有效課程名單中')`（409）
- 註：行號全部對得上。補一層：POST /api/checkins 其實有三道門，第二道（checkins.js:354 條件 `cpe.status = 'active'`，不通過回 checkins.js:363 403 '該學員未在此課程名單中'）同樣不看 is_active，所以停用但仍掛在名單上的學員要到第三道才被擋。家長看到的是退費措辭，實際原因是被停用。刻意的例外：整期學員全部停用時櫃檯手動扣課仍可對指名學員補登出席（courseEntitlements.js:124-128 keepNamedInactive），家長端傳 requireActiveStudent:true 關掉這個例外（checkins.js:370-371），該處註解記明是 2026-09-22 取得擁有者同意的凍結檔改動。

**7. 「我的課程」課程卡是用手機號碼歸戶的，不是用帳號：只要一張報名單的家長手機、或它的額外家長手機欄位裡有這支號碼，這張卡就會出現在該家長的課程頁。**

- 誰能做：櫃檯（決定報名單上填哪些手機）
- 依據：server/routes/courses.js:222 — `WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)`（$1 = req.parent.phone，見 courses.js:129 `const phone = req.parent.phone;`）
- 註：行號完全對得上。兩邊：同一個檔案的上課記錄用帳號 id（courses.js:25 `s.parent_id = $1`），課程卡用手機（courses.js:222）。第三種寫法在付款單：帳號 id 或手機任一符合（server/routes/checkout.js:25-32）。三個入口對「這是我的」定義不同。

**8. 同一批跨家庭的人，在團購階段看不到彼此的真實姓名（會被遮罩），開課之後在學習歷程與聊天室房間卻看得到完整姓名。**

- 誰能做：沒有人；是三個模組各自決定
- 依據：遮罩側 server/routes/groupOrders.js:217-218 — `parent_name: isSelf ? m.parent_name : maskName(m.parent_name), student_names: isSelf ? (m.student_names || []) : maskNames(m.student_names || []),`；不遮罩側 server/services/learning.js:328-334（整期全名，畫在 LearningHistoryPage.jsx:88）與 server/services/chatRooms.js:71-73（整期全名，畫在 ChatRoomPage.jsx:150 房間副標）
- 註：確認為本面向第二重要的發現，行號對得上；僅修正一處對照：聊天室是「房間副標」揭露（ChatRoomPage.jsx:150 `role === 'coach' ? '' : (room.student_names || []).join('、')`），清單畫面對家長顯示的是教練名而非學員名。同一批人、同一段關係，只因為流程階段不同就換了一套個資標準。凍結令（CLAUDE.md:13）只涵蓋「簽到方家長姓名」的揭露，沒有涵蓋學習歷程與聊天室的學員姓名，所以這兩處的揭露找不到對應的政策依據。

**9. 聊天室的進入門檻是「名下有在籍學員掛在這一期」，學員一轉出就立刻進不去聊天室、也看不到過去的對話。**

- 誰能做：系統自動
- 依據：server/services/chatRooms.js:203-207 — `SELECT 1 FROM chat_rooms cr JOIN course_period_enrollments e ON e.course_period_id = cr.course_period_id JOIN students s ON s.id = e.student_id WHERE cr.id = $1 AND e.status = 'active' AND s.parent_id = $2`
- 註：行號微調（203-207，原寫 203-208）。清單側同一判準：chatRooms.js:141-144 的 EXISTS 也只認 'active'。兩邊：聊天室只認 'active'，學習歷程額外接受 'transferred_out'（server/routes/learn.js:157）。同一個學員轉出後，家長留得住學習歷程、留不住對話紀錄。

**10. 個資頁的回傳內容包含該家長的 LINE 使用者識別碼與 Ragic 紀錄編號；但登入端點刻意不回傳 LINE 識別碼。**

- 誰能做：沒有人；兩支端點各自決定回傳欄位
- 依據：洩出側 server/routes/parents.js:97-99 — `SELECT id, name, phone, line_uid, gender, email, primary_venue_id, identity, home_phone, home_address, line_id, ragic_record_id FROM parents WHERE id = $1`，parents.js:428 直接 `res.json(me)`；封鎖側 server/routes/auth.js:215-216 註解 `line_uid 只供後端驗證／簽 JWT 使用，不回傳給 LIFF，避免被 browser devtools、第三方 error reporter 或錯誤的前端 log 蒐集`
- 註：行號完全對得上。兩邊：登入（auth.js 的 _issue，auth.js:209-225）明確排除 line_uid；個資頁（parents.js 的 loadMe）整列回傳。GET /api/parents/me（parents.js:428）與 POST /api/parents/me/sync（parents.js:480-482 `res.json({ ...me, sync_status: syncStatus })`，連錯誤降級路徑 parents.js:488-489 也是）都受影響。

**11. 聊天室的兩支家長端點都會把這一期全部學員的姓名（含別家小孩）放進回應，但畫面只有房間內的副標會顯示出來；清單畫面對家長顯示的是教練名。也就是說「看得到的」與「拿得到的」在這裡不一致。** 〔覆核時補上〕
- 依據：後端不分家庭回傳：server/services/chatRooms.js:71-73 — `(SELECT array_agg(DISTINCT s.name) FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active') AS student_names`，經 chatRooms.js:125 `student_names: r.student_names || [],` 送出，家長清單（chatRooms.js:138-148 listRoomsForParent）與單一房間（chatRooms.js:213-218 getRoomMeta）共用同一段 ROOM_BASE_SELECT；前端只在房間副標畫出來：client/liff/src/pages/ChatRoomPage.jsx:150 `role === 'coach' ? '' : (room.student_names || []).join('、'),`；清單不畫：ChatListPage.jsx:60-62 家長分支取 `${r.coach?.name || '教練'} 教練`。ROOM_BASE_SELECT 同時被家長、教練、後台三個入口共用（chatRooms.js:138-177），所以無法只對家長收窄。

**12. 被櫃檯停用的學員，家長連「編輯」都不行：個資頁改學員資料只認在籍學員，對停用學員回「找不到學員」，與上課記錄仍顯示該學員姓名並存。** 〔覆核時補上〕
- 依據：server/routes/parents.js:683 — `WHERE id = $1 AND parent_id = $2 AND COALESCE(is_active, TRUE) = TRUE`；parents.js:686 `if (!cur.rowCount) return res.status(404).json({ error: '找不到學員' });`。對照 server/routes/courses.js:67-68 的上課記錄查詢完全不看 is_active，所以同一個小孩：上課記錄看得到名字、個資頁看不到、加不回來（parents.js:631-635）、也編輯不了。


#### 覆核時退回的敘述（1 條，程式其實不是這樣）

**1. ~~[原第 22 條] 聊天室清單與聊天室標題顯示的是這一期全部學員的姓名，含別家小孩。（證據：server/services/chatRooms.js:71-73；顯示在 client/liff/src/pages/ChatListPage.jsx:61 與 ChatRoomPage.jsx:141）~~**

- 程式實際：後端那半對，前端兩個引用的行號都指到「教練分支」，家長走的是另一支。ChatListPage.jsx:60-62 `const peer = role === 'coach' ? (r.student_names || []).join('、') || '家長' : `${r.coach?.name || '教練'} 教練`;` —— 家長在聊天室清單看到的是教練名，不是學員名；頭像字母同理（ChatListPage.jsx:71 `role === 'coach' ? (r.student_names?.[0]?.[0] …) : (r.coach?.name?.[0] …)`）。ChatRoomPage.jsx:140-142 的 peerName 也是同一個三元式，家長看到的標題是「○○ 教練」。家長端真正會看到整期學員姓名的是房間「副標」：ChatRoomPage.jsx:150 `role === 'coach' ? '' : (room.student_names || []).join('、')`。另外後端確實把整期學員姓名（不分家庭）放進兩支端點的回應（chatRooms.js:71-73 的 ROOM_BASE_SELECT，經 chatRooms.js:125 `student_names: r.student_names || [],` 輸出），所以清單畫面雖然沒畫出來，資料仍在回應裡。正確版本已放進 added 第 3 條。


### 3.5 簽到、預約與取消


#### 實作中（45 條）

**1. #1 每一個課程期都有自己的「簽到模式」開關，只有兩種值：預約制（booking）或自助簽到（self）。同一個家庭的不同課程期可以一個預約制、一個自助簽到。**

- 誰能做：系統（欄位定義）
- 依據：db/migrations/030_self_checkin_mode.sql:12-16 `ALTER TABLE course_periods ADD COLUMN IF NOT EXISTS checkin_mode TEXT NOT NULL DEFAULT 'booking';` ／ `CHECK (checkin_mode IN ('booking','self'))`；server/bootstrap/coreSchema.js:783-784 同一組 CHECK 約束
- 註：「期別層級、不是課程或場館層級」正確。但原條目後半句「新課程期一律預設為預約制」不成立 —— 見 rejected 第 1 條與 added 第 1 條：現行預設值是自助簽到。

**2. #2 簽到模式只能由後台切換，家長沒有任何入口可以改。可以單期切換，也可以「整館一次切換」；整館切換只影響該場館狀態為進行中的課程期。切換有變動時會寫一筆稽核紀錄掛在該期的來源報名單上。**

- 誰能做：櫃檯／主管（依後台角色權限的 checkin-modes 資源；admin 永遠可以 —— server/services/rolePermissions.js:5「admin 永遠全開」）
- 依據：server/routes/admin/periods.js:97 `router.patch('/:id/checkin-mode', requireAdminAuth, requireResource('checkin-modes')…`；server/routes/admin/periods.js:164-166 `UPDATE course_periods SET checkin_mode = $2 … WHERE venue_id = $1 AND status = 'active' AND checkin_mode <> $2`
- 註：補兩點：(1) 稽核只在該期有 anchor 報名單（admin_enrollment_id 有值）時才寫（server/routes/admin/periods.js:124）；(2) 兩支端點都受場館範圍限制（getScopedVenueIds，:113-117、:156-159）。「切換前後相同不寫稽核（changed=false）」正確。

**3. #3 自助簽到（免預約）只有在課程期的簽到模式是「自助簽到」時才能用。預約制的課程期按自助簽到會被擋，訊息為「此課程為預約制，請先預約課程再簽到」。**

- 誰能做：家長自己
- 依據：server/routes/checkins.js:80-83 `if (period.checkin_mode !== 'self') { … code: 'SELF_CHECKIN_NOT_ENABLED' }`
- 註：這道檢查是單向的：反過來，預約制逐堂簽到完全不看 checkin_mode —— 見 added 第 3 條。

**4. #4 自助簽到要求課程期狀態為「進行中」。非進行中（尚未開通、已結束、已退費）一律擋下，訊息為「此課程期目前非進行中，無法簽到」。**

- 誰能做：家長自己
- 依據：server/routes/checkins.js:84-87 `if (period.status !== 'active') { … code: 'PERIOD_NOT_ACTIVE' }`
- 註：註記正確：server/services/courseEntitlements.js:71 會再要求 `period.status='active' && entitlement_state='ACTIVE'`。

**5. #5 自助簽到會檢查課程期的到期日：以台北時間的今天算，過了到期日就不能再簽，訊息為「此課程期已到期，請洽櫃檯」。到期日等於今天還算沒到期。**

- 誰能做：家長自己
- 依據：server/routes/checkins.js:66 `(cp.expires_at >= (NOW() AT TIME ZONE 'Asia/Taipei')::date) AS not_expired`；server/routes/checkins.js:88-91 `code: 'PERIOD_EXPIRED'`
- 註：我用 grep 覆核全 repo（排除 node_modules）：expires_at 當守門條件的只有 checkins.js:66 這一處，其餘都是顯示、報表或建期時寫入。支持 #42。

**6. #6 同一個課程期每天只能自助簽到一次。這條限制綁在「課程期」上，不是綁在學員上 —— 共享課期（家庭共班、團報）只要有一個家庭簽了，那一天整期就用掉了。**

- 誰能做：家長自己（限制由系統強制）
- 依據：db/migrations/030_self_checkin_mode.sql:21-23 `CREATE UNIQUE INDEX … ON course_sessions(course_period_id, self_checkin_date) WHERE created_via = 'self_checkin' AND self_checkin_date IS NOT NULL;`（server/bootstrap/coreSchema.js:792-794 同一索引）
- 註：三層保護正確：DB 唯一鍵、送出前的當日查詢（checkins.js:176-192）、advisory lock（checkins.js:60 `self-checkin:${periodId}`）。撞鍵時回 409 ALREADY_CHECKED_IN_TODAY（checkins.js:243-249）。「同一位學員同時在兩個課程期，兩期各可簽一次」正確。

**7. #7 「今天此課程期已經有任何有效簽到紀錄」就不能再自助簽到 —— 不論那筆是家長在預約課堂上按的、櫃檯補登的、還是歷史上教練代簽的。訊息為「今日此課程已有簽到紀錄（每日限一堂）；如需更正請洽櫃檯」。**

- 誰能做：家長自己（限制由系統強制）
- 依據：server/routes/checkins.js:176-185 `WHERE cs.course_period_id = $1 AND cs.status NOT IN ('cancelled_normal','cancelled_penalty') AND cr.attendance_status = 'ATTENDED' AND (cr.checked_in_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date`；:186-192 `code: 'ALREADY_CHECKED_IN_TODAY'`
- 註：程式註解（checkins.js:173-175）自己寫明這是過渡保護、且 unique index 只涵蓋自助建立的課堂。單向性正確，見 #41。

**8. #8 自助簽到當天如果已經排了一堂還沒簽到的預約課堂，系統不會另外開一堂，而是直接把那一堂簽掉，避免家長看起來被扣兩堂。**

- 誰能做：系統自動
- 依據：server/routes/checkins.js:196-204 `SELECT id, scheduled_at FROM course_sessions WHERE course_period_id = $1 AND status IN ('confirmed','completed') AND (scheduled_at AT TIME ZONE 'Asia/Taipei')::date = …`；:210-216 `UPDATE course_sessions SET status='completed', … session_deducted = TRUE`
- 註：關鍵註記正確且重要：走這條時不檢查堂數上限（checkins.js:218-219 註解明說「只有『需要新建課堂』時才檢查」），已超額的期別還是簽得進去。補一點：同一天若有兩堂預約課堂，只會簽掉最早的那一堂（ORDER BY scheduled_at LIMIT 1）。回傳 reused_booked_session=true。

**9. #9 自助簽到的堂數上限：該課程期「沒有被取消的課堂數」達到購買堂數就不能再簽，訊息為「本期堂數已用完，如需續課請重新報名」。已排還沒上的預約課堂也算佔了一堂。**

- 誰能做：家長自己（限制由系統強制）
- 依據：server/routes/checkins.js:220-228 `SELECT COUNT(*)::int AS n FROM course_sessions WHERE course_period_id = $1 AND status NOT IN ('cancelled_normal','cancelled_penalty')` → `if (cap.rows[0].n >= period.total_sessions) … code: 'NO_SESSIONS_LEFT'`
- 註：註記正確：上限用「已排堂數」，跟家長畫面上的「剩餘堂數」（已出席算）是兩個數字。見 #46。

**10. #10 自助簽到成立時，系統即時補建一堂當日課堂：上課時間＝按下按鈕的當下、時長固定 60 分鐘、狀態直接記為已完成、教練帶該課程期的教練。這堂課不佔用教練開出的可預約時段。**

- 誰能做：系統自動
- 依據：server/routes/checkins.js:232-240 `INSERT INTO course_sessions (course_period_id, coach_id, scheduled_at, duration_minutes, status, completed_at, created_via, self_checkin_date, session_deducted) VALUES ($1, $2, NOW(), 60, 'completed', NOW(), 'self_checkin', (NOW() AT TIME ZONE 'Asia/Taipei')::date, TRUE)`
- 註：「不佔用教練時段」正確：INSERT 沒有 availability_slot_id，教練的 coach_availability_slots 不會被改成 booked。但它會吃掉「可預約堂數」的分母（#9／#23 的容量分子）。

**11. #11 家長按自助簽到時，勾選哪些學員不影響出席名單。系統只用送上來的學員名單做權限檢查（必須是自己的小孩、且在本期在籍名單中），實際出席是後端自己重新抓「本期完整在籍名單」寫進去 —— 包含別人家的小孩。**

- 誰能做：家長自己（實際生效範圍由系統決定）
- 依據：server/routes/checkins.js:99-100 註解「v2 對共享課期的實際 attendance 會由後端重新取得完整 active roster，不能信任某一位家長送來的清單…」；server/routes/checkins.js:116-128 `const activeParticipants = useSharedUsageV2 ? await client.query('… WHERE cpe.course_period_id = $1 AND cpe.status = 'active' AND cpe.student_id = ANY($2::uuid[]) AND COALESCE(s.is_active, TRUE) = TRUE', [periodId, entitledStudents]) : own`
- 註：精確化：後端重抓的名單是 entitledStudents（已排除退費／停用學員），不是無條件的全班。前端已拿掉勾選框，理由寫在 client/liff/src/components/SelfCheckinModal.jsx:66-74。開關 SHARED_CHECKIN_USAGE_V2 全量開啟確認於 server/bootstrap/coreSchema.js:492-497 `allowed_phones = '{}'`（且 ON CONFLICT DO UPDATE 每次啟動都會把舊 canary 覆蓋成全量）。

**12. #12 出席名單會排除已停用的學員。自助簽到寫出席時只寫「未停用」的在籍學員。**

- 誰能做：系統自動
- 依據：server/routes/checkins.js:124 `AND COALESCE(s.is_active, TRUE) = TRUE`；server/services/courseEntitlements.js:108-129 名單一律排除停用學員
- 註：例外正確（server/routes/admin/manualDeductions.js:333-335 `attendanceRoster = rosterRes.rows.filter((r) => r.is_active || String(r.id) === String(studentId))`；courseEntitlements.js:126 `keepNamedInactive`）。補一點邊界：checkins.js:124 的過濾只在 SHARED_CHECKIN_USAGE_V2 生效的分支；旗標關閉時走的 `own` 查詢（checkins.js:101-108）沒有 is_active 過濾。目前旗標全量開啟，所以走的是嚴格那條。

**13. #13 退費或權益停用的學員不能簽到。整期退費／來源報名被取消，整期都不能簽；團報部分退費時只有還在付費的那幾位學員能簽；資料對不起來（找不到來源報名、團報缺家長識別、家庭共班部分退費無法對到人）一律擋下並要求人工核對，不會猜。**

- 誰能做：系統自動（擋下後需櫃檯人工處理）
- 依據：server/services/courseEntitlements.js:71-73 `if (!period || period.status !== 'active' || period.entitlement_state !== 'ACTIVE') throw conflict('PERIOD_ENTITLEMENT_INACTIVE', '此課程期已停用或退費，無法簽到或扣課')`；:77-88 `ENROLLMENT_SOURCE_UNRESOLVED` / `REFUND_IDENTITY_REVIEW_REQUIRED` / `ENROLLMENT_ENTITLEMENT_INACTIVE`
- 註：生效範圍覆核無誤：自助簽到（checkins.js:92）、預約制簽到（checkins.js:370）、選時段預約（slots.js:297）、櫃檯補簽到（admin/sessions.js:619）、櫃檯手動扣課都會呼叫。fail-closed 設計有程式註解背書（courseEntitlements.js:75-78「原本這裡會因為 closed.length === 0 而一路放行（fail-open）」）。

**14. #14 家長重複送出自助簽到（雙擊、斷網重送、多裝置同時按）不會重複扣堂。如果今天已經成功建過自助課堂，系統回傳同一堂課的成功結果，而不是報錯。**

- 誰能做：系統自動
- 依據：server/routes/checkins.js:137-171 `if (existingSelf.rowCount) { … return res.json({ ok: true, idempotent: true, session_id: existing.id …`
- 註：前端文案一致：client/liff/src/components/SelfCheckinModal.jsx:91「網路不穩定，請再按一次『簽到』（不會重複扣堂）」。

**15. #15 簽到成功後，家長畫面上的「剩餘堂數」＝購買堂數 − 已出席堂數。已出席堂數＝「這個課程期底下、有有效出席紀錄、且課堂沒被取消的『不同課堂』數」—— 同一堂有兩個小孩也只算一堂。**

- 誰能做：系統自動
- 依據：server/routes/checkins.js:266-274 `SELECT COUNT(DISTINCT cr.course_session_id)::int AS n FROM checkin_records cr JOIN course_sessions cs … WHERE cs.course_period_id = $1 AND cs.status::text NOT LIKE 'cancelled%' AND cr.attendance_status = 'ATTENDED'`；同一算法在 server/routes/courses.js:172-179 與 :543-550
- 註：鏡射欄位說法正確（server/services/usageSync.js:10-12「堂數真相永遠是 course_sessions + checkin_records…只是 legacy 顯示欄位」），同步範圍（anchor 單／同團報同期／同批次同期）確認於 usageSync.js:29-39。

**16. #16 預約制的逐堂簽到：家長對某一堂已預約的課堂按簽到。前提是那堂課的狀態是「已確認」或「已完成」；其他狀態（例如歷史上的等待同組確認）會被擋。**

- 誰能做：家長自己
- 依據：server/routes/checkins.js:372-382 `const freshSession = await client.query('SELECT status FROM course_sessions WHERE id = $1 FOR UPDATE'…)` → `if (!['confirmed','completed'].includes(sessionStatus)) { … code: 'SESSION_NOT_CHECKINABLE' }`
- 註：pending_group_confirm 會拿到專屬文案「此課程仍在等待同組家長確認，暫不可簽到」（checkins.js:377-378），但該狀態已不會再產生新資料（見 #24）。

**17. #17 預約制簽到只認「這個學員是我的小孩」＋「這個學員在這堂課所屬課程期的在籍名單中」。兩個條件缺一就擋（分別回「學員不屬於該家長」與「該學員未在此課程名單中」）。**

- 誰能做：家長自己
- 依據：server/routes/checkins.js:331-338 `SELECT 1 FROM students WHERE id = $1 AND parent_id = $2` → 403「學員不屬於該家長」；server/routes/checkins.js:352-355 `AND EXISTS (SELECT 1 FROM course_period_enrollments cpe WHERE cpe.course_period_id = cp.id AND cpe.student_id = $2 AND cpe.status = 'active')` → 403「該學員未在此課程名單中」

**18. #18 預約制簽到一樣是「一方簽到＝整組生效」：家長替自己小孩按一次簽到，系統會把那一堂的整組在籍學員（含別的家庭）都記成出席，整期共扣一堂。**

- 誰能做：家長自己（實際生效範圍由系統決定）
- 依據：server/routes/checkins.js:386-398 `INSERT INTO checkin_records … SELECT $1, cpe.student_id, cpe.student_id, 'parent', $2 FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $3 AND cpe.status = 'active' AND cpe.student_id = ANY($4::uuid[]) AND COALESCE(s.is_active, TRUE) = TRUE`
- 註：精確化：「整組」仍排除已停用學員與無權益（退費）學員 —— 原條目的程式片段把 :394-395 兩個過濾條件漏掉了。凍結項目引用正確（CLAUDE.md:13）。此分支由 SHARED_CHECKIN_USAGE_V2 控制，旗標關閉時只寫自己那一位（checkins.js:399-408）。

**19. #19 一方簽到後，同組其他家長的按鈕變成不可再簽，並顯示是誰簽的。團報期會顯示簽到方家長的全名；家庭共班／一般期不揭露他人身分。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:78-88 `WHERE cp.group_order_id IS NOT NULL AND cr2.course_session_id = cs.id AND cr2.attendance_status = 'ATTENDED' AND cr2.checked_in_by_parent_id <> $1 ORDER BY cr2.checked_in_at LIMIT 1`；client/liff/src/pages/MyLessonsPage.jsx:23-26 `return !r.checked_in_at && !r.checked_in_by_name && !r.partner_checkin_label && ['confirmed','completed'].includes(r.session_status)`
- 註：「櫃檯／教練代簽不會被標成夥伴代簽」正確：LATERAL 是 `JOIN parents p2 ON p2.id = cr2.checked_in_by_parent_id`，櫃檯／教練來源那欄為 NULL（courses.js:94-95 註解亦載明）。「我的課程」卡片上的同一機制在 courses.js:191-200 與 :580-593。

**20. #20 預約制簽到不限上課當天，隨時可以補簽 —— 包括還沒到的未來課堂。系統不檢查課堂的排定時間。**

- 誰能做：家長自己
- 依據：client/liff/src/pages/MyLessonsPage.jsx:20-21 註解「（不限上課當天，隨時可補簽）」；server/routes/checkins.js:322-458 全段無任何 scheduled_at 的日期或時間比較（逐行讀過）
- 註：確認：家長可以在課程還沒上之前就把堂數簽掉。前端唯一的門檻是那一格必須已經有預約課堂（confirmed/completed）。

**21. #21 預約（挑時段）：家長只看得到「跟自己課程期同一位教練、同一個場館」且狀態為可預約的時段。預設範圍是今天起算 30 天，最多顯示 120 筆。**

- 誰能做：家長自己
- 依據：server/routes/slots.js:229-241 `WHERE cas.coach_id = $1 AND cas.venue_id = $2 AND cas.status = 'available' AND cas.start_at >= $3 AND cas.start_at < $4 ORDER BY cas.start_at LIMIT 120`；server/routes/slots.js:191-194 預設 from＝台北今天、to＝+30 天
- 註：註記正確且我另外覆核了前端：client/liff/src/components/SlotPicker.jsx:50-52 也送 from=今天、to=+30，且整個元件沒有任何「已過時間」過濾（grep 無 now/past/Date.now 命中）。預約端（slots.js:267-351）也不比對 start_at 與現在時間 —— 所以今天已經過去的時段只要教練沒關掉就選得下去。

**22. #22 要看／要預約某課程期的時段，家長名下必須有至少一位在籍學員掛在該期。沒有就回「無權檢視此課程期」／「無權預約此課程期」。**

- 誰能做：家長自己
- 依據：server/routes/slots.js:215-224 `SELECT 1 FROM course_period_enrollments cpe JOIN students s ON s.id = cpe.student_id WHERE cpe.course_period_id = $1 AND s.parent_id = $2 AND cpe.status = 'active'` → 403「無權檢視此課程期」；server/routes/slots.js:298-306 → 403「無權預約此課程期」
- 註：共同家長那段描述正確，但行號要更正：`canAccessPeriod = !!row.course_period_id && ownStudents.length > 0` 實際在 server/routes/courses.js:245（/courses/mine）與 server/routes/courses.js:620（/courses/:id），不是 260-263。收斂成「課程開通處理中」的按鈕在 client/liff/src/pages/MyCoursesPage.jsx:234。

**23. #23 預約成立的條件：課程期必須是進行中、時段必須仍是可預約、時段的教練與場館必須跟課程期一致、已排（未取消）堂數不得達到購買堂數。訊息分別是「此課程期尚未開通或已結束」「此時段已被預約或不可選」「此時段與課程期的教練或場館不符」「可預約堂數已用完」。**

- 誰能做：家長自己
- 依據：server/routes/slots.js:309-330 `PERIOD_NOT_ACTIVE` / `SLOT_MISMATCH` / `SLOT_UNAVAILABLE`；`SELECT COUNT(*)::int AS n FROM course_sessions WHERE course_period_id = $1 AND status::text NOT LIKE 'cancelled%'` → `NO_SESSIONS_LEFT`
- 註：補兩道原條目沒列到的前置關卡（順序在這四道之前）：退費／權益檢查 server/routes/slots.js:297 `assertCourseEntitlement(client, coursePeriodId)`，以及「名下要有在籍學員」server/routes/slots.js:298-306。容量用「未取消課堂數」正確，自助簽到補建的課堂也算在內。

**24. #24 預約一律即時成立，不需要任何人確認 —— 團報、家庭共班也一樣：任一位家長預約，整組的課表立刻同步出現這一堂。系統不再有「等待同組家長同意」的關卡。**

- 誰能做：家長自己（任一位組員家長）
- 依據：server/routes/slots.js:332-335 註解「一律即時確認（政策變更）：團報/家庭共班不再走 pending_group_confirm」＋ `const session = await bookSlot1v1(slotId, coursePeriodId, client);`；server/services/slots.js:100-108 `INSERT INTO course_sessions (…) SELECT $1, cas.id, cas.start_at, cas.duration_minutes, 'confirmed', …`
- 註：凍結項目第 1 條（CLAUDE.md:12）正確。bookSlot1vN 已移除（server/services/slots.js:118-120 註解）、逾時自動確認 cron 已移除（server/cron/index.js:129-130），enum 值 pending_group_confirm 保留（server/bootstrap/coreSchema.js:24）。

**25. #25 預約成功後，那個時段會被標記為已預約並綁到這堂課上；同一個時段不會被兩組人搶到。並發保護用「同一位教練一把鎖」，跟教練開時段用的是同一把。**

- 誰能做：系統自動
- 依據：server/services/slots.js:111-114 `UPDATE coach_availability_slots SET status = 'booked', booked_session_id = $1 WHERE id = $2`；server/routes/slots.js:285 `SELECT pg_advisory_xact_lock(hashtext($1))`, [String(slot.coach_id)]（與 server/services/slots.js:50 createSlot 同一把鎖）
- 註：搶輸回「此時段已被預約，請改選其他時段」（server/routes/slots.js:343-345）。另外 INSERT 本身帶 `WHERE cas.status = 'available'`（services/slots.js:104），空回列就 throw，是第二層保護。

**26. #26 時段衝突（同一位教練時間重疊）是在「教練開時段」的時候檢查的，不是在家長預約的時候。家長預約時系統不再重算衝突。**

- 誰能做：系統自動（檢查點在教練端）
- 依據：server/services/slots.js:9 註解「核心：衝突偵測在『教練新增槽位時』執行，而非學員預約時」；server/services/slots.js:29-32 `WHERE cas.coach_id = $1 AND cas.status IN ('available','pending_group_confirm','booked') AND ($2::timestamptz < cas.start_at + …)`
- 註：「跨場館一起算」正確：detectConflict 的 WHERE 只綁 coach_id，沒有 venue_id 條件。

**27. #27 預約不會動堂數。全系統的已用堂數只認簽到紀錄，預約只是「先佔一格」—— 預約完但沒簽到，畫面上的剩餘堂數不會少，但「可預約堂數」會少一格。**

- 誰能做：系統自動
- 依據：server/routes/slots.js:265-266 註解「選槽『不』異動 used_sessions —— 全系統堂數以 checkin_records 為準，used_sessions 無任何 +1 處，動它會破壞既有計數」
- 註：我覆核過：整支 POST /:id/book（slots.js:267-351）確實沒有任何 used_sessions 寫入。這是 #46 兩個數字定義不同的根因。

**28. #28 家長沒有任何方式可以自己撤銷已經完成的簽到。按錯只能請櫃檯處理。前端確認彈窗也直接寫明「簽到後將無法取消」。**

- 誰能做：沒有人（家長端無入口）；更正一律由櫃檯走後台
- 依據：server/routes/checkins.js:43 註解「家長不可自行撤銷（營運規則）；誤點由櫃檯走 DELETE /api/admin/checkins/self-sessions/:id」；client/liff/src/pages/MyLessonsPage.jsx:291 `確定要為 … 簽到嗎？簽到後將無法取消。`
- 註：覆核無誤：server/routes/checkins.js 整檔只有兩支 `router.post`（:45 `/self`、:322 `/`），沒有 DELETE 或 PATCH。

**29. #29 櫃檯撤銷自助簽到：只能撤銷「自助簽到建立的課堂」，而且要填撤銷原因。撤銷後那一堂的全部出席改標為已衝正、課堂轉為正常取消、當天的簽到名額釋放（家長當天可以重簽）。歷史紀錄不刪，全程留稽核。**

- 誰能做：櫃檯（依後台角色權限的 checkin 資源；且只能動自己場館範圍內的課堂 —— server/routes/admin/checkins.js:159-163）
- 依據：server/routes/admin/checkins.js:139-141 `router.delete('/self-sessions/:sessionId', requireAdminAuth, requireResource('checkin')…` ＋ `if (!reason) return res.status(400).json({ error: '請填寫撤銷原因'…`；server/services/deductionRevival.js:104-110 `SET status = 'cancelled_normal', … session_deducted = FALSE, self_checkin_date = NULL`
- 註：「預約制課堂不能走這個入口」正確（admin/checkins.js:164-167 回「僅自助簽到課堂可用此方式撤銷」）。稽核對「共享此期的全部訂單」各寫一筆（deductionRevival.js:145-152），重複按只歸還一次（lesson_deduction_reversals 的 UNIQUE(course_session_id)，coreSchema.js:479）。

**30. #30 如果教練已經替那一堂填了上課紀錄，櫃檯就不能從「撤銷自助簽到」入口撤掉，必須先跟教練確認。**

- 誰能做：沒有人（需先與教練處理）
- 依據：server/routes/admin/checkins.js:168-175 `SELECT 1 FROM session_records WHERE course_session_id = $1 LIMIT 1` → 409「教練已填寫此堂上課紀錄，請先與教練確認後再處理」（code SESSION_RECORD_EXISTS）
- 註：「這道擋只存在於這一個入口」正確 —— 我逐段讀過 server/routes/admin/sessions.js:473-537 的 revive，沒有查 session_records。見 #45。

**31. #31 教練不能簽到、也不能扣堂。教練端只看得到簽到狀態（唯讀）。簽到一律由家長自己按或櫃檯補登。**

- 誰能做：沒有人（教練端無此路徑）
- 依據：CLAUDE.md:18「`POST /api/sessions/:id/checkins` 已整支刪除，`server/routes/sessions.js` 現為全唯讀。不得以任何形式復活」；server/routes/sessions.js 的路由定義全部是 GET（:161, :299, :342, :378, :417, :473, :511 —— grep `^router.` 無任何 post/patch/delete）
- 註：迴歸測試檔存在：tests/coach_checkin_removed_test.js。歷史 `checked_in_source='coach'` 的顯示分支必須保留（CLAUDE.md:18），server/services/checkinNotify.js:15-18 也為此保留「coach 來源列不通知教練」的條件。

**32. #32 櫃檯可以替家長補簽到某一堂已排的課堂，並自由指定簽到時間。補簽到會對那一堂的整組在籍學員各寫一筆來源為「櫃檯」的出席，整期共扣一堂；已簽過的學員不重複寫。已取消的課堂不能補簽。**

- 誰能做：櫃檯／管理端（依後台角色權限的 sessions 資源；限自己場館 —— admin/sessions.js:613-615）
- 依據：server/routes/admin/sessions.js:589 `router.post('/:id/backfill-checkin', requireAdminAuth, requireResource('sessions')…`；server/routes/admin/sessions.js:624-633 `INSERT INTO checkin_records (…) SELECT $1, cpe.student_id, cpe.student_id, 'staff', $2 FROM course_period_enrollments cpe WHERE cpe.course_period_id = $3 AND cpe.status = 'active' AND cpe.student_id = ANY($4::uuid[])`
- 註：三點精確化：(1)「整組在籍」其實是 entitledStudents（admin/sessions.js:619 assertCourseEntitlement），已排除退費與停用學員；(2) 除了「已取消不可補簽」（:616-618）還有一道狀態閘：課堂必須是 confirmed/completed（:620-623）；(3) 原條目的註記正確 —— 這條路徑不檢查每日一次、也不檢查課程期到期日（我讀完整段確認沒有 expires_at 或當日簽到查詢）。

**33. #33 櫃檯可以在沒有預先排課的情況下直接手動扣一堂：系統開一堂已完成的課堂，把整組在籍學員記成出席，整期扣一堂，並寫進扣課帳（含當時的名單快照）。剩餘可扣堂數不足 1 時擋下。**

- 誰能做：櫃檯／管理端（依後台角色權限的 manual-deduction 資源）
- 依據：server/routes/admin/manualDeductions.js:189 `router.post('/', requireAdminAuth, requireResource('manual-deduction')…`；server/routes/admin/manualDeductions.js:348-352 `const remainingBefore = Math.max(0, total - reserved); if (remainingBefore < 1) { … code: 'INSUFFICIENT_SESSIONS' }`
- 註：正確。補：剩餘用「未取消課堂數」當分子（manualDeductions.js:337-344，與 #9／#23 同款，不是已出席數）；名單快照寫進 manual_lesson_deductions.roster_snapshot（:380-390）。「櫃檯指名的學員即使停用也會留下出席紀錄」確認於 manualDeductions.js:333-335。凍結項目第 3 條（CLAUDE.md:14）引用正確。

**34. #34 櫃檯可以做「扣課復活」把一堂已扣的課歸還：該堂全部出席改標為已衝正、課堂轉為正常取消、堂數即時回算，必須填歸還原因，重複按只歸還一次。**

- 誰能做：櫃檯／主管／管理員（依後台角色權限的 revive 資源；限自己場館 —— admin/sessions.js:500-503）
- 依據：server/routes/admin/sessions.js:473 `router.post('/:id/revive', requireAdminAuth, requireResource('revive')…`；server/routes/admin/sessions.js:507 `const result = await reverseLessonDeduction(client, { sessionId: id, reason, reversedBy: by });`
- 註：行號小修：reverseLessonDeduction 的呼叫在 :507（不是 505）。2026-08-07 放寬角色的理由有程式註解背書（admin/sessions.js:469-472）。要補一道原條目沒提的前置條件：新版復活只在 `flag.enabled && row.v2_phone_match` 時走（:505-507），否則落到舊分支、只有 cancelled_penalty 的課堂能處理（:517-521）。因為 DEDUCTION_REVIVAL_V2 是 enabled=TRUE、allowed_phones='{}'（coreSchema.js:503-505，`cardinality($2)=0` 時 phone match 恆真），實務上等於全量開放。

**35. #35 退費／取消報名時，該課程期底下「已排但還沒有人簽到」的未來課堂會被自動取消，對應的教練時段釋回可預約。已經簽到的歷史不動。**

- 誰能做：系統自動（由退費／取消流程觸發）
- 依據：server/services/courseEntitlements.js:145-151 `UPDATE course_sessions cs SET status = 'cancelled_normal' … WHERE course_period_id = $1 AND status IN ('confirmed','pending_group_confirm') AND NOT EXISTS (SELECT 1 FROM checkin_records cr WHERE cr.course_session_id = cs.id AND cr.attendance_status = 'ATTENDED')` ＋ `UPDATE coach_availability_slots SET status = 'available', booked_session_id = NULL`
- 註：「目前唯一會釋回已預約時段的程式路徑」覆核成立：grep `coach_availability_slots SET status = 'available'` 只有這一處＋教練端解封（routes/slots.js 的 unblock）。整期也會被改成 status='refunded'、entitlement_state='MANUAL_REVIEW'（courseEntitlements.js:142-144）。

**36. #36 家長會在簽到後收到 LINE 簽到確認通知；教練也會收到（兩者是獨立開關）。推播失敗不影響簽到本身，同一筆簽到只通知一次。**

- 誰能做：系統自動
- 依據：server/services/checkinNotify.js:15-23 註解「家長：一律通知（他要知道小孩到了、這堂課被計走了）」「兩者是『獨立的事件開關』」「一律 best-effort：推播失敗絕不能影響簽到本身」「去重靠 pushGate 的 refId（checkin_records.id）」；server/routes/checkins.js:281 與 :432 `notifyCheckinSafely(…)`
- 註：行號小修：註解實際在 checkinNotify.js:14-23（家長那行是 :19）。「教練來源的歷史簽到列不通知教練」確認於 checkinNotify.js:15-18。

**37. #37 上課前一小時系統會推播提醒給該課程期的全部在籍學員家長（教練不收上課提醒）。同一堂同一個收件人只推一次。**

- 誰能做：系統自動（每小時排程）
- 依據：server/cron/index.js:135-147 `scheduleTaipei('0 * * * *', …)` ＋ `WHERE cs.status IN ('confirmed','pending_group_confirm') AND cs.scheduled_at BETWEEN $1 AND $2`；server/cron/index.js:159-162 註解「教練不收上課提醒」＋ `const targets = ps.rows.map((r) => ({ uid: r.line_uid, role: 'parent' }))`
- 註：「未來 60–120 分鐘」正確（cron/index.js:137-138）。補兩點：只推給有綁 LINE 的家長（`p.line_uid IS NOT NULL`，:156）；去重靠 notification_log 的 claim-first 寫法，推播失敗會把 claim 刪掉讓下輪重試（:166-183）。line.js:282 的 sessionReminder 保留了 role='coach' 分支但無人使用（:280-281 註解）。

**38. 全站的簽到模式預設值是「自助簽到」，而且部署時做過一次性全站切換：所有既有課程期（含已結束、已退費的）都被改成自助簽到，之後新開通的課程期也繼承自助簽到。櫃檯手動切回預約制的期別不會被後續重啟覆蓋。** 〔覆核時補上〕
- 依據：db/migrations/031_self_checkin_default.sql:10-13 `UPDATE course_periods SET checkin_mode = 'self' … WHERE checkin_mode <> 'self';` ＋ `ALTER TABLE course_periods ALTER COLUMN checkin_mode SET DEFAULT 'self';`；server/bootstrap/coreSchema.js:2187-2191 `if (flag.rowCount) { … UPDATE course_periods SET checkin_mode = 'self' … WHERE checkin_mode <> 'self' }`（旗標 system_flags 'u13_self_checkin_default_20260714'）

**39. 體驗課（試上）簽到是完全獨立的第三條軌道：櫃檯是對「報名單」按簽到，只在報名單上蓋一個體驗課簽到時間戳，不建課堂、不寫出席紀錄、不扣堂；簽成功會順手發放推薦獎勵（9 折券＋LINE 推播）給推薦人。同一張報名單只能簽一次，第二次回「報名已簽到或狀態已變動」。已退費／已取消的報名不能簽，且限自己場館。** 〔覆核時補上〕
- 依據：server/routes/admin/sessions.js:697 `router.post('/checkin', requireAdminAuth, requireResource('checkin')…`；:718-723 `UPDATE admin_enrollments SET experience_checked_in_at = COALESCE(experience_checked_in_at, NOW()) WHERE id = $1 AND status NOT IN ('refunded','cancelled') AND experience_checked_in_at IS NULL RETURNING id` → 409 ENROLLMENT_CHECKIN_UNCHANGED；:733 `referrals.issueRewardForEnrollment(enrollmentId, …)`

**40. 堂數快到期提醒：課程期的到期日剛好是「今天＋N 天」時（N 取後台設定 expiry_notice_days，沒設就是 60 天），系統在當天早上 09:00 推播給該期全部在籍且有綁 LINE 的家長。訊息上的剩餘堂數讀的是鏡射欄位、不是即時重算。** 〔覆核時補上〕
- 依據：server/cron/index.js:191-203 `scheduleTaipei('0 9 * * *', …)` ＋ `WHERE cp.status = 'active' AND cp.expires_at = CURRENT_DATE + (SELECT COALESCE((SELECT value::INTEGER FROM admin_settings WHERE key='expiry_notice_days'), 60))`；:195 `(cp.total_sessions - cp.used_sessions) AS remaining`

**41. 期末評鑑邀請是由「最後一堂的簽到」觸發的：系統每小時檢查，某課程期排定時間最晚的那一堂在最近 25 小時內有有效出席，就對該期每位家長建立評鑑邀請並推播；7 天沒填會再提醒一次。試上（單堂體驗）期不發評鑑邀請。** 〔覆核時補上〕
- 依據：server/cron/index.js:288-307 `WHERE cp.status IN ('active','completed') AND COALESCE(cp.is_experience_course, FALSE) = FALSE AND EXISTS (SELECT 1 FROM checkin_records cr WHERE cr.course_session_id = ls.session_id AND cr.attendance_status = 'ATTENDED' AND cr.checked_in_at >= NOW() - INTERVAL '25 hours')`；:327-329 7 天提醒

**42. 家長端唯一能自己按的「取消」是取消還沒對帳的一般報名單：必須是自己的單（本人或共同家長手機）、且狀態還在待付款對帳，才取消得掉。已進入處理流程回「此報名已進入處理流程，無法由家長取消」；團報單一律回「團報請至團購狀態頁處理取消」由團主處理。課程開通之後，家長端沒有任何取消入口（課堂不行、整期也不行）。** 〔覆核時補上〕
- 依據：server/routes/courses.js:803-833 `router.post('/:id/cancel', requireParent, …)` ＋ `if (row.group_order_id) … 'GROUP_ORDER_CANCEL_REQUIRED'` ＋ `if (row.status !== 'pending_payment') … 'NOT_PENDING'`

**43. 被取消的課堂會從家長的「上課記錄」直接消失，變回一張「未預約」佔位卡 —— 家長看不到「這堂被取消了」的任何痕跡。不論是退費自動取消、櫃檯撤銷自助簽到、還是扣課復活，結果都一樣。** 〔覆核時補上〕
- 依據：server/routes/courses.js:24-28 `conds = [ 's.parent_id = $1', "cpe.status = 'active'", "cs.status IN ('confirmed','completed','pending_group_confirm')" ]`（已取消的課堂不在清單內）；client/liff/src/pages/MyLessonsPage.jsx:167-172 `placeholderCount = Math.max(0, (enrollment?.total || 0) - sortedRecords.length)`

**44. 同一位學員在同一堂課只會有一筆出席紀錄，重複寫入一律忽略 —— 這是家長、櫃檯、手動扣課三條寫入路徑都靠的同一道底層保護。** 〔覆核時補上〕
- 依據：server/bootstrap/coreSchema.js:424-435 `CREATE TABLE IF NOT EXISTS checkin_records ( … UNIQUE(course_session_id, student_id) )`；三條寫入路徑都帶 `ON CONFLICT (course_session_id, student_id) DO NOTHING`（server/routes/checkins.js:260、:396、server/routes/admin/sessions.js:631）

**45. 出席紀錄有兩種狀態：有效出席（ATTENDED）與已衝正（REVERSED）。撤銷簽到／扣課復活不刪紀錄，只把狀態改成已衝正，所以全系統所有「已用堂數」的算法都必須加上「只算有效出席」這個條件。** 〔覆核時補上〕
- 依據：server/bootstrap/coreSchema.js:465-469 `ADD COLUMN IF NOT EXISTS attendance_status TEXT NOT NULL DEFAULT 'ATTENDED'` ＋ `CHECK (attendance_status IN ('ATTENDED','REVERSED'))`；server/services/deductionRevival.js:97-103 `UPDATE checkin_records SET attendance_status = 'REVERSED', reversed_by = $2, reversal_reason = $3, reversed_at = NOW() WHERE course_session_id = $1 AND attendance_status = 'ATTENDED'`


#### 判準不一致（10 條）

**1. #41 「每日限簽一次」只在自助簽到路徑成立。預約制的逐堂簽到完全沒有每日上限 —— 同一天排了兩堂就可以簽兩堂、扣兩堂。**

- 誰能做：家長自己
- 依據：自助側：server/routes/checkins.js:176-192 `… AND (cr.checked_in_at AT TIME ZONE 'Asia/Taipei')::date = (NOW() AT TIME ZONE 'Asia/Taipei')::date LIMIT 1` → 409 ALREADY_CHECKED_IN_TODAY。預約制側：server/routes/checkins.js:322-458 全段無任何當日簽到次數或日期檢查（逐行讀過）
- 註：單向性有程式註解自認（server/routes/checkins.js:173-175「每日一次的 unique index 只涵蓋自助建立的課堂」）。這條的「一天扣兩堂」路徑我另外確認了機制前提：預約制簽到根本不看課程期的 checkin_mode（見 added 第 3 條），所以自助簽到制的期別只要留有舊預約課堂，兩條軌道就都走得通。

**2. #42 課程期到期日只擋自助簽到，不擋預約制簽到，也不擋預約新時段。**

- 誰能做：家長自己
- 依據：擋的那邊：server/routes/checkins.js:66 `(cp.expires_at >= (NOW() AT TIME ZONE 'Asia/Taipei')::date) AS not_expired` → :88-91 `code: 'PERIOD_EXPIRED'`。不擋的那邊：server/routes/checkins.js:322-458 與 server/routes/slots.js:267-351 完全沒有引用 expires_at
- 註：我用 grep 覆核全 repo（排除 node_modules）：expires_at 出現在 routes/services/cron 共 20 餘處，唯一當守門條件的就是 checkins.js:66；其餘是顯示（courses.js:288/670）、報表（admin/reports.js:97）、到期提醒 cron（cron/index.js:200）、建期時寫入（admin/enrollments.js）。櫃檯實務影響的描述正確。

**3. #43 停用學員的判準兩條路徑不一樣：預約制逐堂簽到會在守門就把停用學員擋掉；自助簽到只是在寫出席時把停用學員過濾掉，不擋整筆請求。**

- 誰能做：家長自己
- 依據：嚴格那邊：server/routes/checkins.js:370-371 `assertCourseEntitlement(client, ctx.rows[0].period_id, studentId, { requireActiveStudent: true })`。寬鬆那邊：server/routes/checkins.js:92 `assertCourseEntitlement(client, periodId)`（不指名學員、不帶 requireActiveStudent）＋ :124 `AND COALESCE(s.is_active, TRUE) = TRUE`
- 註：改嚴格的理由有註解背書（server/routes/checkins.js:366-369「原本會放行 → 寫入依 is_active 過濾成 0 筆 → … 堂數扣了、出席沒有、家長看到錯誤」，迴歸鎖 tests/course_entitlement_is_active_db_test.js，檔案存在）。自助側的寬鬆語意在 courseEntitlements.js:116-126 有刻意設計說明（`keepNamedInactive`）；不過自助側的 :130-132 仍會在 roster 全空時擋下（STUDENT_ENTITLEMENT_INACTIVE），所以「全員停用」實際上是被 courseEntitlements 擋掉、而不是產生零出席課堂 —— 這點把原條目的註記修正一下。

**4. #44 「今天是否已簽到」畫面上的判準跟伺服器的判準不一樣：畫面只看「今天有沒有自助簽到建立的課堂」，伺服器擋的是「今天有沒有任何有效簽到」。**

- 誰能做：系統（顯示與守門不一致）
- 依據：畫面側：server/routes/courses.js:575-579（/courses/:id）與 server/routes/courses.js:186-190（/courses/mine）`AND cs3.created_via = 'self_checkin' AND cs3.self_checkin_date = (NOW() AT TIME ZONE 'Asia/Taipei')::date AND cs3.status NOT IN ('cancelled_normal','cancelled_penalty') … AS self_checked_in_today`。守門側：server/routes/checkins.js:176-185（任何來源的當日 ATTENDED 都算）
- 註：症狀描述正確。按鈕的 disabled 條件在 client/liff/src/pages/MyCoursesPage.jsx:217-224（`disabled: !!cp.self_checked_in_today`），彈窗重抓最新狀態在 SelfCheckinModal.jsx:31-47、判斷在 :51-64 —— 重抓到的仍是同一個較窄的 self_checked_in_today。

**5. #45 「撤銷簽到」兩個後台入口的保護程度不一樣：專用的「撤銷自助簽到」入口會擋下教練已填上課紀錄的課堂，而「扣課復活」入口對任何已扣堂課堂都放行，沒有這道擋。**

- 誰能做：櫃檯／管理端（兩個入口權限資源不同：checkin vs revive）
- 依據：有擋：server/routes/admin/checkins.js:168-175 `if (hasRecord.rowCount && !['cancelled_normal','cancelled_penalty'].includes(row.status)) return res.status(409).json({ … code: 'SESSION_RECORD_EXISTS' })`，且 :182 傳 `allowCreatedVia: 'self_checkin'`。沒擋：server/routes/admin/sessions.js:507 `await reverseLessonDeduction(client, { sessionId: id, reason, reversedBy: by })`（沒有 allowCreatedVia、前面也沒有查 session_records —— 我逐行讀過 :473-537）
- 註：「兩個入口最後都走同一支 server/services/deductionRevival.js:14 reverseLessonDeduction、效果相同」覆核成立。所以同一筆「教練已寫紀錄」的自助簽到，從撤銷入口會被擋、從復活入口撤得掉。附帶差異：revive 還會走 DEDUCTION_REVIVAL_V2 的旗標／電話比對（見 #34 註記），撤銷入口沒有這層。

**6. #46 「剩餘堂數」與「尚可預約堂數」是兩個定義不同的數字，同一個課程期可能同時顯示「剩餘 5 堂」和「尚可預約 3 堂」。**

- 誰能做：系統（顯示定義不一致）
- 依據：剩餘堂數（已出席為分子）：server/routes/checkins.js:266-274 `COUNT(DISTINCT cr.course_session_id) … AND cr.attendance_status = 'ATTENDED'`、server/routes/courses.js:172-179 與 :543-550 `attended_sessions`，畫面用 client/liff/src/components/SelfCheckinModal.jsx:50 `Math.max(0, (info.total_sessions||0) - (info.used_sessions||0))`。尚可預約堂數（已排為分子）：server/routes/slots.js:246 `sessions_left: Math.max(0, Number(period.total_sessions) - Number(period.booked_sessions || 0))`，分子在 server/routes/slots.js:203 `COUNT(cs.id) FILTER (WHERE cs.status::text NOT LIKE 'cancelled%')`
- 註：同頁混用正確：client/liff/src/pages/MyLessonsPage.jsx:134-136 剩餘用已出席算，同頁 :167-172 的佔位卡張數用已排（`total - sortedRecords.length`）算。還有第三種算法在報表與到期提醒 —— 直接讀鏡射欄位 used_sessions（server/routes/admin/reports.js:97、server/cron/index.js:195），見 added 第 4 條。

**7. #47 自助簽到有兩個進入點（我的課程卡片、上課記錄頁），兩邊送給彈窗的「課程 id」定義不同 —— 上課記錄頁送的是課程期 id，但彈窗打的是「報名單」查詢端點，對不上，會顯示「無法取得課程最新狀態，請檢查網路後重試」。**

- 誰能做：家長自己（其中一個入口實際上開不起來）
- 依據：正確入口：client/liff/src/pages/MyCoursesPage.jsx:224 `onClick: () => setSelfCheckinTarget(cp)`（cp 來自 /courses/mine，`id: row.id` 是 admin_enrollments.id，courses.js:259）。對不上的入口：client/liff/src/pages/MyLessonsPage.jsx:245 `onSelfCheckin={() => setSelfCheckinPeriodId(enrollment.periodId)}` → :266 `course={selfCheckinPeriodId ? { id: selfCheckinPeriodId } : null}`，而 periodId 來自 :95 `periodId: c.course_period_id`。彈窗一律拿它打報名單端點：client/liff/src/components/SelfCheckinModal.jsx:37 `coursesApi.get(course.id)` → server/routes/courses.js:521 `router.get('/:id', requireParent, …)`，查詢條件 :611 `WHERE e.id = $1`（admin_enrollments.id TEXT，db/migrations/002_admin_tables.sql:78-79 `id TEXT PRIMARY KEY`）
- 註：行號小修：觸發點是 MyLessonsPage.jsx:245（原條目寫 266，那是 SelfCheckinModal 的 course prop）；courses.js 的路由起點是 :521、WHERE 在 :611。推論鏈覆核成立：TEXT 欄位吃 UUID 字串不會撞型別錯誤，只會 0 列 → 404「找不到此報名」（courses.js:614）→ 彈窗落到 loadError 分支（SelfCheckinModal.jsx:42-45）。我同樣沒有執行程式或連資料庫（任務鐵則），這條兩人都是純靜態追出來的，交接時建議實機點一次。

**8. #48 取消類型的命名在文件、測試與資料庫之間不一致：資料庫與程式用「正常取消／罰則取消（cancelled_normal / cancelled_penalty）」，文件與測試註解出現「逾時取消／cancelled_late」。**

- 誰能做：不適用（命名不一致）
- 依據：資料庫真相：server/bootstrap/coreSchema.js:24 `CREATE TYPE session_status AS ENUM ('pending_group_confirm','confirmed','completed','cancelled_normal','cancelled_penalty')`。文件：docs/architecture_v7.md:277「逾時取消」（同檔 :285 對應值寫的是 cancelled_penalty）。測試註解：tests/e2e/path_d_self_cancel.js:4「驗 status='cancelled_late'」，同檔 :28 實際跑 `for (const kind of ['normal','penalty'])`
- 註：正確。補一點：docs/architecture_v7.md:285 與 docs/dev_schedule.md:205 其實都寫對了值（cancelled_normal / cancelled_penalty），錯的只有中文標籤「逾時取消」與測試註解的 cancelled_late。影響有限。

**9. #49 那段沒被接線的取消函式用的是「堂數減一」的舊算法，跟全系統「重新計算已出席堂數」的算法相衝突。**

- 誰能做：沒有人（死碼；已被凍結令明令不得接線）
- 依據：舊算法：server/services/slots.js:141-146 `UPDATE course_periods SET used_sessions = used_sessions - 1 WHERE id = (SELECT course_period_id FROM course_sessions WHERE id = $1) AND used_sessions > 0`。現行算法：server/services/usageSync.js:25-28 `UPDATE course_periods SET used_sessions = $2 …`（$2 由呼叫端重算的權威出席數傳入）
- 註：CLAUDE.md:18 的警告文字覆核無誤。另外 cancelSession 也不會清 self_checkin_date、不會把 attendance 標 REVERSED、不寫稽核，跟現行的 reverseLessonDeduction（deductionRevival.js:97-152）差距不只堂數算法一項 —— 日後要做取消功能，這段不能直接復用。

**10. 預約制的逐堂簽到完全不看課程期的簽到模式：自助簽到制的課程期，只要還留著舊的預約課堂，家長照樣可以走預約制路徑把那一堂簽掉。判準只有單向 —— 自助簽到會擋「這期是預約制」，預約制簽到不擋「這期是自助簽到制」。** 〔覆核時補上〕
- 依據：擋的那邊：server/routes/checkins.js:80-83 `if (period.checkin_mode !== 'self') { … 'SELF_CHECKIN_NOT_ENABLED' }`。不擋的那邊：server/routes/checkins.js:322-458 全段沒有讀取 checkin_mode（該路由的 ctx 查詢 :340-357 連這個欄位都沒 SELECT）


#### 只在文件裡（程式沒有／不同）（3 條）

**1. #38 「家長自助取消課程」—— 距上課 24 小時前取消歸還 1 堂、24 小時內取消扣堂、兩者都釋回時段、並推播通知教練與家長。**

- 誰能做：沒有人（程式裡沒有任何入口）
- 依據：docs/architecture_v7.md:274-277 表格「正常取消｜距上課時間 > 24 小時｜歸還 1 堂｜槽位釋回 available」「逾時取消｜距上課時間 ≤ 24 小時｜扣堂，不歸還｜槽位釋回 available」；docs/architecture_v7.md:282「點選『取消本堂課』」；docs/dev_schedule.md:201-207；docs/uat_playbook.md:91-93
- 註：我獨立覆核過「沒有落地」這件事：(1) `cancelSession` 定義在 server/services/slots.js:125，grep 全 repo 的呼叫點只有 tests/e2e/path_d_self_cancel.js:39 直接呼叫函式；(2) CLAUDE.md:18 明列它是死碼且不得接進任何 requireCoach 端點；(3) LIFF 端沒有取消課堂的按鈕（grep 只找到 checkout/courses/group-orders 的『取消報名』）；(4) 後台也沒有 —— server/routes/admin/sessions.js 的路由只有 GET ×5 ＋ revive／backfill-checkin／checkin 三支 POST，沒有取消課堂的端點。全 repo 會把課堂轉成取消狀態的只有三處：退費流程（courseEntitlements.js:146）、撤銷簽到／扣課復活（deductionRevival.js:106）、舊 cancelled_penalty→cancelled_normal 分支（admin/sessions.js:521）。

**2. #39 「取消通知教練」的 Flex 訊息模板（含正常取消／逾時取消兩種文案）已經寫好但沒有接線。**

- 誰能做：沒有人
- 依據：server/services/line.js:302-306 註解「⚠️ 未接線：全 server 沒有任何呼叫點（2026-08-10 查證）。Owner 決定教練端只保留『家長簽到』一種通知，預約／取消類不推，故不接」＋ `function selfCancelToCoach({ studentName, scheduledAt, cancelType })`
- 註：覆核成立：grep `selfCancelToCoach` 只命中定義（line.js:306）、匯出（line.js:1023）、smoke 腳本（server/scripts/pushTemplateSmoke.js:52）、模板驗證測試（tests/e2e/flex_templates_verify.js:27）。`slotBooked`（line.js:234）同樣只有這四類命中 —— 所以家長預約成功後確實不會收到 LINE 推播，只會收到上課前一小時的提醒。

**3. #40 家長手冊寫「上課當天到場館→跟櫃檯說手機號碼→櫃檯在後台幫你完成簽到」，也就是簽到只有櫃檯能做。**

- 誰能做：文件說只有櫃檯；程式上家長自己就能簽
- 依據：docs/manuals/parent.md:62-64「## 六、簽到（Phase 2）」「上課當天到場館 → 跟櫃檯說手機號碼 → 櫃檯在後台幫你完成簽到。」「簽到成功後堂數進度會 +1。」
- 註：正確。另外同一份手冊 docs/manuals/parent.md:57-60 說「預約完成（會收到 LINE 推播提醒）」，這句也對不上程式（slotBooked 未接線，見 #39）。交接時這兩章都要重寫。


#### 覆核時退回的敘述（1 條，程式其實不是這樣）

**1. ~~#1 後半句：「新課程期一律預設為預約制（booking）。」證據引 db/migrations/030_self_checkin_mode.sql:12 的 `DEFAULT 'booking'`。~~**

- 程式實際：程式現況相反：全站預設是「自助簽到」。migration 030 的 DEFAULT 'booking' 已被後續改掉 —— db/migrations/031_self_checkin_default.sql:13 `ALTER TABLE course_periods ALTER COLUMN checkin_mode SET DEFAULT 'self';`，而每次啟動都會跑的 server/bootstrap/coreSchema.js:780-781 也是 `ADD COLUMN IF NOT EXISTS checkin_mode TEXT NOT NULL DEFAULT 'self'` ＋ `ALTER COLUMN checkin_mode SET DEFAULT 'self'`。更關鍵的是還有一次性全站切換：db/migrations/031_self_checkin_default.sql:10-11 與 server/bootstrap/coreSchema.js:2188-2189 `UPDATE course_periods SET checkin_mode = 'self' WHERE checkin_mode <> 'self'`（以 system_flags 'u13_self_checkin_default_20260714' 冪等，只跑一次）。coreSchema.js:775-777 的註解寫明「'self'（免預約自助簽到，2026-07-14 起全站預設）」。所以正確敘述是：對帳開通新建的課程期預設為自助簽到；預約制是後台逐期或整館切回來的例外。這個方向反了會讓整份交接文件對「哪一組規則是常態」判斷錯誤 —— #41／#42／#44 那幾條不一致，落在自助簽到那側的是多數家庭，不是少數。


### 3.6 報名、付款與退費


#### 實作中（57 條）

**1. 家長要買課，必須先在 LIFF 建立「報名單」，這張單一開始一定是待付款狀態；正式課期不會在此時產生，要等櫃檯對帳通過。**

- 誰能做：家長自己
- 依據：server/routes/enrollments.js:11-12 `不在本任務範圍：core course_periods 真實寫入；本路由只建立 admin_enrollments (pending_payment) 等管理後台對帳通過後再 promote 為正式 course_period。`；同檔 :572 `VALUES ($1,...,'pending_payment',$13,1,$14,...)`
- 註：三個建單入口都寫 pending_payment：家長 LIFF（enrollments.js:572）、櫃檯手動建檔（admin/enrollments.js:818 `VALUES (...,'pending_payment',$12,`）、團報核准（admin/groupOrders.js:516 `VALUES (...,'pending_payment',NOW(),$13,TRUE,1,...)`）。三處行號與內容都對得上。

**2. 每次送出報名都必須帶一組「這次送出的識別碼」（request_id 或 Idempotency-Key），沒帶就直接退件；同一組識別碼重送同樣內容只會回原本那張付款單，不會重複建單、不會重複扣折價券名額。**

- 誰能做：家長自己
- 依據：server/services/idempotency.js:12-18 `if (!requestId) { return { error: '每次建單都必須提供 Idempotency-Key 或 request_id', code: 'REQUEST_ID_REQUIRED', status: 400 }; }`；server/routes/enrollments.js:139-143 `await acquireRequestLock(client, { actorId: req.parent.id, operation: ENROLLMENT_OPERATION, requestId: idempotencyKey });`；同檔 :178-179 `await client.query('COMMIT'); return res.status(200).json(idempotentCheckoutResponse(existingCheckout));`
- 註：IDEMPOTENCY_PAYLOAD_MISMATCH 在 :160、IDEMPOTENCY_IN_PROGRESS 在 :167，範圍對。修正一處敘述：前端不是「每次進報名頁」產生 UUID，而是「第一次按下送出時」才產生並記在 ref（EnrollmentPage.jsx:150 `if (!submitRequestIdRef.current) submitRequestIdRef.current = createSubmitRequestId();`），成功導頁後在 :174／:183 清掉。因此同一頁重複按送出會沿用同一組識別碼（這正是防重複建單的設計）。

**3. 報名金額一律由伺服器重算，前端傳來的原價與實收金額完全被忽略；顯示價與成交價的唯一共同來源是「該場館所屬定價區的課別設定」。**

- 誰能做：沒有人（僅 DB／後台設定可改）
- 依據：server/routes/enrollments.js:254 `// ── 後端重算 (server-authoritative)：完全忽略 client 的 original_price ──`；同檔 :333-334 `const unitPrice = resolveUnitPrice(basePrice, multiplier, cfg.tier_prices);`；server/services/courseConfig.js:74-84 `const zone = await resolveZone(db, { venueId, zoneId }); ... WHERE pricing_zone_id = $1 AND course_type = $2`
- 註：已逐行確認 enrollments.js 全檔沒有任何地方讀 p.original_price／p.final_price（前端仍會送，EnrollmentPage.jsx:164-165）。單期單生價規則如敘述：coursePricing.js:37-40，明價優先、0 元是合法明價（:20-21 註解明寫）。讀價一律走 courseConfig，查不到就丟例外、不會退回別區（courseConfig.js:7-12）。

**4. 場館停用、該場館未開放此課程組別、組別被停用、組別未設價、教練不存在或已停用 —— 任何一項不成立就不能報名（一律擋在建單，不會先收錢再說）。**

- 誰能做：沒有人（僅 DB／後台設定可改）
- 依據：server/routes/enrollments.js:279-283 `if (vr.rows[0].is_active === false) ... code: 'VENUE_INACTIVE'`；同檔 :302-309 `COURSE_TYPE_INACTIVE` / `PRICE_NOT_CONFIGURED`；同檔 :323-329 `SELECT name, pricing_multiplier FROM coaches WHERE id = $1 AND is_active = TRUE` → `'coach not found or inactive'`
- 註：場館先驗再讀價的理由在 :265-266 註解，行號對。已成立的舊訂單不受場館停用影響（:278 註解「已售出課程不受影響」）。補一點：這五道檢查是「一般報名」的，團報發起端的教練檢查較鬆——見 added 第 1 條。

**5. 家長只能替自己名下、狀態有效的學員報名；選到別人的小孩、已停用的小孩、或重複勾同一位，整筆退件。**

- 誰能做：家長自己
- 依據：server/routes/enrollments.js:372-379 `WHERE parent_id = $1 AND id = ANY($2::uuid[]) AND COALESCE(is_active, TRUE) = TRUE` → `code: 'STUDENT_NOT_AVAILABLE'`；同檔 :368-370 `if (new Set(submittedStudentIds).size !== submittedStudentIds.length) ... code: 'DUPLICATE_STUDENT'`
- 註：身分綁定如敘述：:242-243 註解＋:244-246 從 parents 表讀真實姓名電話，前端送的 parent_name/phone/id 全丟。另有 :469-471 STUDENT_RESOLUTION_MISMATCH 縱深防禦（解析後數量不符就整筆 500 失敗，寧可失敗也不建金額脫鉤的單）。

**6. 一次報名最多買 6 期；超過或非整數會被夾回合法範圍而不是退件。**

- 誰能做：家長自己
- 依據：server/routes/enrollments.js:336-339 `const n = parseInt(p.period_count, 10); return Number.isInteger(n) ? Math.min(6, Math.max(1, n)) : 1;`
- 註：團報同樣 1–6 且同樣是夾擠不退件（groupOrders.js:56-57 `PERIOD_COUNT_MIN/MAX`、:60-64 `normalizePeriodCount`）。

**7. 一對二以上的課，單次報名學員數不得超過課型人數上限（超額請分次報名或改走團報）；一對一則不設上限——多個小孩就是各自獨立的一對一課。**

- 誰能做：家長自己
- 依據：server/routes/enrollments.js:349-355 `const maxStudents = Number(cfg.max_students) || 1; if (!isTrial && maxStudents > 1 && studentCount > maxStudents) ... code: 'STUDENT_COUNT_EXCEEDS_COURSE_TYPE'`
- 註：刻意略過一對一的理由在 :344-348 註解，行號對。試上不受此限同樣寫在該段註解。實務上一對一多學員只能直打 API 才做得到（前端上限＝courseType，見第 65 條）。

**8. 一張報名單會依「學員 × 期數」拆成多筆子訂單，每筆只代表 1 位學員的 1 期；折扣按比例攤到每一筆、餘數補最後一筆，使所有子訂單金額加總嚴格等於付款單總額。**

- 誰能做：系統自動
- 依據：server/routes/enrollments.js:476-478 `// 2 位學員買 4 期 → 建 8 筆 admin_enrollments，每筆只代表 1 位學員的 1 期。`；同檔 :560-562 `const d = (orderIndex < childOrderCount - 1) ? Math.round(totalDiscount / childOrderCount) : (totalDiscount - discountAllocated);`
- 註：加總恆等已核算：sum(final) = 期數×學員數×單價 − totalDiscount = preview.finalPrice（:564 `Math.max(0, perChildOriginal - d)` 只在單價小於攤到的折扣時才會破壞恆等，正常定價不會）。折扣門檻以整筆 periodCount 計算的說明在 :479。

**9. 同一批多筆子訂單共用一張付款單（checkout），家長看到、轉出的就是這張付款單的總額；總額由子訂單金額即時重算，不是報名當下寫死的數字。**

- 誰能做：系統自動
- 依據：server/services/checkouts.js:149-160 `SET total_amount = COALESCE((SELECT SUM(ae.final_price) FROM admin_enrollments ae WHERE ae.checkout_id = cs.checkout_id), cs.total_amount)`
- 註：建單時先以 preview.finalPrice 落地（enrollments.js:496），再由 refreshCheckoutTotal 以子訂單加總覆蓋（enrollments.js:610、checkout.js:186）。行號對。

**10. 匯款／轉帳資料不在報名當下填，而是訂單成立後在付款單頁或報名狀態頁補填。**

- 誰能做：家長自己
- 依據：server/routes/enrollments.js:125-126 `// 匯款／轉帳證明在訂單成立後於狀態頁補填；若前端帶值，會在取得 request advisory lock 與 ledger 後再做真實 storage lookup。`；同檔 :228-233 `const proofInput = await parseProofInput(p);`
- 註：向後相容如敘述：建單仍收 transfer_last_5（:127-130 格式檢查）與 payment_proof_url（:228 即時驗真實檔案）。前端報名頁不送這兩個欄位（EnrollmentPage.jsx:152-169 的 payload 無付款欄位）。

**11. 轉帳末 5 碼必須是 5 位數字；匯款證明必須是系統剛上傳成功、真實存在於檔案儲存區的圖片（JPG／JFIF／PNG／WebP／HEIC／HEIF／AVIF，5MB 以內），不看副檔名而是驗檔案內容。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:241-242 `if (last5 && !/^\d{5}$/.test(last5)) ... code: 'TRANSFER_LAST5_INVALID'`；server/services/paymentProof.js:7 `const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(?:jpe?g|jfif|png|webp|heic|heif|avif)$/i;`；同檔 :51 `if (!await exists(value)) return invalidProof();`
- 註：**行號更正**：PROOF_URL_RE 在 paymentProof.js:7（不是 :186），objectExists 檢查在 :51（不是 :230）——該檔全長只有 68 行。內容完全對得上。503 PAYMENT_PROOF_LOOKUP_FAILED 在 :52-60；5MB 上限在 uploads.js:17 `const PROOF_MAX_BYTES = 5 * 1024 * 1024;`，magic bytes 驗證在 services/receiptImage.js（uploads.js:90 呼叫）。

**12. 上傳匯款證明時必須指明要掛到哪一張付款單／報名單／團報，而且系統會驗這張單真的屬於這位家長（本人手機或被登記的額外家長手機；團報則須為該團成員），否則 403。**

- 誰能做：家長自己
- 依據：server/routes/uploads.js:47-56 `WHERE cs.checkout_id::text = $1 AND (cs.parent_id = $2 OR EXISTS (... ae.parent_phone = $3 OR $3 = ANY(COALESCE(ae.extra_parent_phones, '{}')) ...))`；同檔 :77-81 `code: 'PAYMENT_PROOF_TARGET_FORBIDDEN'`
- 註：target_type='unassigned' 的孤兒檔案在 :36，行號對。團報目標認的是成員身分（parent_id），不是手機（:69-74 `FROM group_order_members WHERE group_order_id::text = $1 AND parent_id = $2`）——這與「檢視付款單認手機」是不同判準，值得在交接文件並列。

**13. 只要填了末 5 碼或上傳了證明其中任一項，付款單就從「待繳款」變成「待對帳」，進入櫃檯的對帳清單。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:296-298 `const nextStatus = (nextLast5 || nextProofUrl) ? CHECKOUT_STATUS.PENDING_RECONCILE : CHECKOUT_STATUS.PENDING_PAYMENT;`；server/services/checkouts.js:26-30 `function paymentStateFromProof({...}) { if (paymentMethod === 'on_site') return CHECKOUT_STATUS.PENDING_PAYMENT; return transferLast5 || paymentProofUrl ? ... }`
- 註：現場付費永遠留在待繳款：checkouts.js:27（建單時）＋ checkout.js:260-265（上傳端直接擋 on_site）。補一個實務細節：「只填發票載具」會被 API 接受（不觸發 PAYMENT_INFO_REQUIRED）但**不會**推進待對帳——checkout.js:291 的必填檢查含 carrier，:296 的狀態判定不含 carrier。報名狀態頁入口同樣行為（courses.js:761、:779）。

**14. 末 5 碼與匯款證明「兩項都送出」之後，家長就不能自己再改，要改必須聯繫櫃檯。只填了一項時還可以補齊另一項。**

- 誰能做：家長自己（改動需櫃檯）
- 依據：server/routes/checkout.js:279-282 `if (locked.rows[0].transfer_last_5 && locked.rows[0].payment_proof_url && !proofInput.clear && !(sameProof && sameLast5)) ... code: 'PAYMENT_LOCKED'`；server/routes/courses.js:750-753 同一條件同一錯誤碼
- 註：同內容重送視為冪等（sameProof && sameLast5）正確。**重要補充**：鎖定條件含 `!proofInput.clear`，也就是「刪除證明」是合法的旁路——詳見 added 第 2 條。

**15. 現場付費的訂單不能上傳轉帳證明，也不能在建單時帶轉帳資料。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:260-265 `if (locked.rows[0].payment_method === 'on_site') ... code: 'ON_SITE_PAYMENT_NO_TRANSFER_PROOF'`；server/routes/enrollments.js:234-239 `if (paymentMethod === PAYMENT_METHOD.ON_SITE && (last5 || paymentProofUrl)) ... code: 'ON_SITE_PAYMENT_FIELDS_NOT_ALLOWED'`
- 註：報名狀態頁入口也有同一道擋（courses.js:737-739）。前端付款單頁在 on_site 時直接不顯示上傳表單（CheckoutPage.jsx:187 `const isOnSite = checkout.payment_method === 'on_site';`、:193 `canUpload = !isOnSite && ...`）。

**16. 家長只能取消「還沒被櫃檯處理」的報名；一旦對帳通過（課程已開通）就不能自己取消，要走退費流程。**

- 誰能做：家長自己
- 依據：server/routes/courses.js:830-832 `if (row.status !== 'pending_payment') ... '此報名已進入處理流程，無法由家長取消', code: 'NOT_PENDING'`；server/routes/checkout.js:372-374 `if (!children.rows.length || children.rows.some((row) => row.status !== 'pending_payment')) ... code: 'NOT_PENDING'`
- 註：釋放優惠名額：courses.js:862-863、checkout.js:384-385，行號對。付款單頁的判準更嚴——整張單裡只要有一筆已離開待付款就整張不能取消。

**17. 團報的單子不能由單一家庭自己取消，必須回團購狀態頁由團主處理，避免破壞已送審的名單。**

- 誰能做：團主
- 依據：server/routes/courses.js:826-828 `if (row.group_order_id) ... '團報請至團購狀態頁處理取消', code: 'GROUP_ORDER_CANCEL_REQUIRED'`；server/routes/checkout.js:368-370 `if (children.rows.some((row) => row.group_order_id)) ... 同一錯誤碼`
- 註：兩處都對。注意這道團報守門只存在於「取消」，不存在於「上傳付款資料」——見第 60 條。

**18. 付款單頁只認「本人或被登記的額外家長手機、或這張付款單登記的家長本人」才能檢視／上傳／取消。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:25-31 `if (checkout.parent_id && checkout.parent_id === parent.id) return true; ... (checkout.sub_orders || []).some((o) => (o.parent_phone === phone || (o.extra_parent_phones || []).includes(phone)))`
- 註：憑證規則正確：parentAuth.js:50 `req.parent = { id: p.parentId, phone: p.phone, lineUid: ... }`、:14 `const TTL = '12h'`、:43-44 每次請求即時查 `is_active = TRUE`，停用即 401。

**19. 「我的課程」的狀態詞彙：待對帳＝還沒繳費確認、進行中＝已對帳開通且堂數未用完、已完成＝堂數用畢、已結束＝取消或退費。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:236-242 `if (s === 'cancelled' || s === 'refunded') return 'closed'; if ((s === 'confirmed' || s === 'active') && total > 0 && used >= total) return 'completed'; if (s === 'confirmed' || s === 'active') return 'active'; return 'pending_payment';`
- 註：confirmed→active 的正規化在 :230，理由註解在 :226-229，行號對。單筆報名狀態頁用同一份邏輯的複製（courses.js:632-638），兩處目前一致但是兩份程式碼。注意「已結束（closed）」只是後端詞彙，前端沒有這個分頁（見第 71 條）。

**20. 同一張付款單下多筆待對帳子訂單，在「我的課程」會合併成一張卡片顯示（學員合併、金額用付款單總額），只有非團報的待對帳單才合併。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:352-354 `const pendingGroupKey = row.lifecycle === 'pending_payment' && !row.group_order_id ? (row.checkout_id || (row.enrollment_batch_id ? `batch:${row.enrollment_batch_id}` : null)) : null;`；同檔 :377-398 聚合卡片（:387 `final_price: totalAmount`）
- 註：聚合卡片堂數固定 0 在 :393-395、needs_checkout_route 在 :381，行號對。前端補建付款單的入口是 MyCoursesPage.jsx:130-135 `checkoutApi.route({ enrollment_batch_id: cp.enrollment_batch_id })`。

**21. 同一批已對帳開通的家庭共班（同一批多位小孩共用一個課期）在「我的課程」合併成一張課程卡，學員合併、金額加總，避免 3 位小孩顯示成 3 期 18 堂。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:320-322 `// U12 家庭共班顯示合併：...合併鍵＝course_period_id（非團報、已開通才會共用）`；同檔 :327-329 `const mergeable = !row.group_order_id && row.course_period_id && (row.lifecycle === 'active' || row.lifecycle === 'completed');`
- 註：取消／退費列維持獨立（mergeable 要求 active/completed）正確；一對一天然不合併（各自獨立 period）正確。但要注意合併鍵是 course_period_id，所以「一次買 4 期」對帳後會變成 4 張卡——見 added 第 6 條。

**22. 堂數真相以「正式課期的有效出席堂數」為準，且同一堂多位小孩只算一堂；家庭共班與團報共用同一堂數池。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:170-171 `-- 已用堂數＝該共享 period 下有有效出席的「堂數」（DISTINCT session）。-- 不限本家庭，因家庭共班／團報共用同一堂數池；同堂多位小孩仍只算一堂。`；同檔 :173-178 `SELECT COUNT(DISTINCT cs2.id)::int ... AND cr.attendance_status = 'ATTENDED'`
- 註：單筆報名狀態頁同樣算法（courses.js:542-550）。退費試算也用同一個「班級層級 DISTINCT session」定義（admin/enrollments.js:1460-1466）。

**23. 就算訂單已對帳，若該課期底下沒有掛到這位家長任一在籍學員，家長端會顯示「課程開通處理中」且不能預約、不能看學習歷程。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:245 `const canAccessPeriod = !!row.course_period_id && ownStudents.length > 0;`；同檔 :248-250 `// 舊資料可能只有 admin_enrollments.status=active ... 若仍回 course_period_id，家長點學習歷程/預約會被 learn/slots 權限守衛 403。`
- 註：前端就是把這個狀態畫成停用按鈕「課程開通處理中」（MyCoursesPage.jsx:233-234）。ownStudents 來自 :160-169 的 `cpe.status = 'active' AND s.parent_id = $2` 子查詢。

**24. 櫃檯對帳通過（必填發票號碼＋發票照片）才算付款完成：子訂單轉「已確認」、付款單轉「已付款」、當下自動開通正式課期並把學員掛進名單，家長收到一封對帳成功的 Email。**

- 誰能做：櫃檯
- 依據：server/routes/admin/checkouts.js:298-310 `SET status = 'confirmed', total_sessions = $2, ... invoice_number = $3, invoice_image_url = $4`；同檔 :400-402 `SET payment_status = 'paid'`；同檔 :418-421 `await ensureGroupCoursePeriod(client, row, total); const ids = (await ensureSoloCoursePeriod(client, row, total)) || [];`
- 註：發票必填規則在 admin/checkouts.js:39-56（號碼格式 `/^[A-Z]{2}\d{8}$/` 在 :23）。「只建課期與名單、不建課堂」的說明在 admin/enrollments.js:256-258，行號對。對帳信走 outbox：admin/checkouts.js:426-441 enqueue（交易內）＋ :457 deliverOutbox（交易外）。學員掛名單＝admin/enrollments.js:224-229 寫 course_period_enrollments。

**25. 對帳只能對「待繳款／待對帳」的付款單，而且該付款單底下每一筆子訂單都必須還在待付款狀態，否則整張退件要求重新整理。**

- 誰能做：櫃檯
- 依據：server/routes/admin/checkouts.js:253-255 `if (![CHECKOUT_STATUS.PENDING_PAYMENT, CHECKOUT_STATUS.PENDING_RECONCILE].includes(checkoutRow.payment_status)) ... '此付款單狀態非待對帳'`；同檔 :273-275 `if (children.rows.some((row) => row.status !== 'pending_payment')) ... '此付款單含有非待對帳子訂單，請重新整理後再試'`
- 註：同一組守門也用在櫃檯取消整張付款單（:491-493、:507-509）。

**26. 一張付款單若混到兩個以上家庭（歷史資料），對帳時必須分別填每個家庭一張發票，發票號碼不可重複；家庭是用家長手機判定，缺手機就每筆各自一家，寧可多開也不合併兩戶發票。**

- 誰能做：櫃檯
- 依據：server/services/checkoutFamilies.js:5-6 `家庭判定只用家長手機，不用學員姓名猜測；缺手機時採每筆訂單獨立分組，寧可要求多開、不可誤合併兩戶發票。`；同檔 :12-15 `const phone = normalizeFamilyPhone(order?.parent_phone); if (phone) return `phone:${phone}`; return `order:${String(order?.id || '')}`;`；server/routes/admin/checkouts.js:85-88 `code: 'FAMILY_INVOICES_REQUIRED'`；同檔 :115-116 `code: 'FAMILY_INVOICE_NUMBER_DUPLICATE'`
- 註：**行號更正**：checkoutFamilies.js 全長 52 行，該段註解在 :5-6（不是 :69-70）。內容完全對得上。admin/checkouts.js 的兩個錯誤碼行號正確。

**27. 對帳清單（給外部對帳系統讀的資料源）只列待繳款與待對帳的付款單，並會把團報成員自己上傳的證明與上傳流水帳一併算進「有無匯款證明」。**

- 誰能做：系統自動
- 依據：server/routes/reconciliation.js:19 `SELECT checkout_id FROM checkout_sessions WHERE payment_status = ANY($1::text[]) ORDER BY created_at DESC`；server/services/checkouts.js:273 `-- 團報家長的原始上傳來源在 group_order_members，不可只讀 checkout / enrollment。`；同檔 :197-202 `for (const candidate of [row.payment_proof_url, ...subOrders.map(...), ...groupMemberProofUrls, ...ledgerProofUrls])`
- 註：Bearer token 只存 SHA-256、未設定回 503：reconciliation.js:12-17，行號對。上傳流水帳（payment_proof_uploads）的歸戶條件涵蓋額外家長手機（checkouts.js:301-321）。

**28. 試上是一般報名的子型態，不是另一條建單路徑：一律現場付費（就算前端送轉帳也被強制改成現場付費）、以「每人每堂」計價、不吃折價券、每筆子訂單固定 1 堂、對帳後各自開通一個獨立的體驗課期。**

- 誰能做：家長自己
- 依據：server/services/trialEnrollment.js:33-38 `// 試上一律現場付費（2026-07：移除試上轉帳選項）...即使前端／API 傳入 bank_transfer，試上也強制成 on_site（後端為權威來源）。if (orderKind === ORDER_KIND.TRIAL) { return PAYMENT_METHOD.ON_SITE; }`；server/routes/enrollments.js:403-408 `const original = (isTrial ? trialPrice : unitPrice) * studentCount * periodCount; ... code: 'TRIAL_COUPON_NOT_SUPPORTED'`；同檔 :579 `paymentMethod, orderKind, isTrial ? 1 : 6,`
- 註：ON_SITE_TRIAL_ONLY 在 :121-122、試上不受人數上限在 :350，行號都對。獨立體驗課期＝ensureSoloCoursePeriod 對 trial 排除共班分支（admin/enrollments.js:304 `if (enrollment.enrollment_batch_id && enrollment.order_kind !== 'trial')`）＋is_experience_course=TRUE（:426）。

**29. 該課程組別若沒在後台打開「可試上」開關，就不能下試上單；試上價沒設定也不能下單（不會退回用一般價硬算）。**

- 誰能做：沒有人（僅後台設定可改）
- 依據：server/routes/enrollments.js:312-314 `if (isTrial && cfg.trial_enabled !== true) ... code: 'TRIAL_NOT_ENABLED'`；同檔 :398-400 `if (isTrial && trialPrice <= 0) ... code: 'TRIAL_PRICE_NOT_CONFIGURED'`
- 註：取值順序 trialEnrollment.js:46-59 如敘述（課別 trial_price → trial_price_course_N → trial_price → 單期價÷每期堂數），行號對。前端也會在 trial_enabled=false 時把深連結切回一般報名（EnrollmentPage.jsx:61-67）。

**30. 試上價要乘教練加成係數（固定價與舊全域設定值都乘），畫面價與成交價用同一條規則。**

- 誰能做：沒有人（僅 DB／設定可改）
- 依據：server/services/trialEnrollment.js:11-14 `2026-09-07 規格改變（使用者決定）：試上價**要乘教練係數**。...固定價與 admin_settings 舊鍵都乘；推算退路的 basePrice 上游已含係數，不再重乘。`；同檔 :50-51 `const fromConfig = positiveMoney(configTrialPrice); if (fromConfig) return Math.round(fromConfig * m);`
- 註：前端同規則：useEnrollmentPricing.js:33-37 `const m = Number(bootData?.coach?.multiplier) > 0 ? ... : 1; return ... Math.round(configured * m) : Math.round(unitPrice / sessionsPerPeriod);`。倍率權威值來自 DB（enrollments.js:390-391），行號對。但「畫面價＝成交價」只在課別已設試上價時成立——見第 56 條。

**31. 試上開通的課期效期只有 30 天，一般報名是 365 天 × 期數。**

- 誰能做：系統自動
- 依據：server/routes/admin/enrollments.js:404-408 `// 試上（order_kind='trial'）＝單堂體驗：效期縮短為 30 天（政策 2026-07-16...）const validityDays = enrollment.order_kind === 'trial' ? '30' : String(365 * (Number(enrollment.period_count) || 1));`
- 註：共用課期不帶體驗旗標、一律 365 分支：家庭共班 admin/enrollments.js:385-389、團報 :196-201，行號都對。但因三個建單入口都把 period_count 寫成 1，`365 × 期數` 實際永遠是 365——見第 66 條。

**32. 試上單付款／開票後（不用等上完課）就可以按「續報一般課程」，帶著同一位教練、同一場館、同一組別跳到一般報名頁；缺教練資料時退回選場館重挑。**

- 誰能做：家長自己
- 依據：client/liff/src/pages/MyCoursesPage.jsx:188-190 `// 試上續報（D1）：付款/開票後（lifecycle=active）即可續報，不 gate 完成狀態；`；同檔 :195-200 `if (coachId && venueId && courseType) { navigate(`/enroll?venue=${venueId}&courseType=${courseType}&coach=${coachId}`); } else if (courseType) { navigate(`/venue?courseType=${courseType}`); }`
- 註：續報按鈕只掛在 order_kind='trial' 卡片（:255-267，completed 與 active 各一組）。一般課程沒有任何續報入口（:256 `const actions = !isTrialOrder ? baseActions : ...`，非試上卡片不追加按鈕）。?coupon= 預填在 EnrollmentPage.jsx:34-35。

**33. 團報＝多個家庭一起上同一班（跨家庭，用團購編號綁定）；家庭共班＝同一位家長多個小孩同一批報名共用一個課期（用批次編號綁定）。兩者的名單、付款與取消規則完全不同。**

- 誰能做：系統自動
- 依據：server/routes/groupOrders.js:14-15 `不更動既有 /api/enrollments 一般報名路徑；團購是平行的新流程，待櫃檯核准後（admin/groupOrders.js）才會為每位成員產生 admin_enrollments。`；server/routes/admin/enrollments.js:300-301 `// U12 家庭共班判定：同批（enrollment_batch_id）同期（period_number）存在多筆兄弟訂單，且課型為一對二以上 → 走「共用 period」模式`
- 註：家庭共班要「本期全部兄弟訂單都已對帳」才開通：admin/enrollments.js:324-335（`const waiting = sib.rows.filter((row) => row.status !== 'confirmed'); if (waiting.length) ... return`），行號對。

**34. 一對一課程不提供團報（前端拔掉入口、後端也擋）。**

- 誰能做：家長自己
- 依據：server/routes/groupOrders.js:510-512 `// 一對一（1V1, course_type===1）不開放團購... if (courseType === 1) return res.status(400).json({ error: '一對一課程不提供團購', code: 'GROUP_NOT_ALLOWED_1V1' });`

**35. 團報人數上下限完全照課程組別的後台設定，不再做全域 2–6 夾擠；人數一律以「學生數」計算（一個家庭可帶多位小孩）。**

- 誰能做：沒有人（僅後台設定可改）
- 依據：server/routes/groupOrders.js:48-53 `// 團報人數上下限「以課程組別設定（course_type_configs.min/max）為唯一來源」：不再做全域 [2,6] 硬性夾擠 ... function effectiveBounds(cfgMin, cfgMax) { const max = Math.max(1, Number(cfgMax) || 1); const min = Math.min(max, Math.max(1, Number(cfgMin) || 1)); }`；同檔 :793-803 `if (curTotal + bound.names.length > order.max_students) ... code: 'OVER_CAPACITY'`（curTotal 由 `SUM(array_length(student_names,1))` 算學生數）
- 註：舊團仍存 1–6（replit.md:258 `注意：**修正前建立的舊團報單**仍存著 1–6`）正確。**另發現**：同檔 :542-543 的註解還寫著「再經全域夾擠：min 至少 GROUP_MIN_FLOOR(2)、max 至多 GROUP_MAX_CEIL(6)」，與 effectiveBounds 已移除夾擠的事實不符——是過期註解，讀碼的人會被誤導。

**36. 團報的折扣在「團主發起當下」就鎖定成快照，之後促銷被下架或改內容都不影響這個團；而且每個家庭各自獨立算折扣，不是折總額再按人數攤分 —— 保證「看到的金額＝轉帳的金額＝核准的金額」。**

- 誰能做：團主（發起時）
- 依據：server/routes/groupOrders.js:571-574 `// ── U14 團購優惠：發起時驗券並「鎖定快照」...快照落地後，即使促銷被下架或改內容，本團金額也不會變`；同檔 :283-287 `為什麼是每家獨立算，而不是「折總額再按人數攤分」：攤分的分母（全團學生數）會隨新成員加入而變動 → 已經照畫面金額轉完帳的家庭金額會被改掉。`
- 註：名額在加入當下扣＋名額滿時該家照原價加入：:639-641 與 :832-834，行號對。發起者遇名額滿→整團不帶折扣（:656-669 ROLLBACK TO SAVEPOINT 後清掉 promotion_id/snapshot）。落地欄位是 group_order_members.original_amount/discount_amount/final_amount（:631-637）。

**37. 團報只吃有明確勾選「可用於團購」的促銷；既有促銷預設不會被團報自動套用。**

- 誰能做：沒有人（僅後台促銷設定可改）
- 依據：server/services/promotions.js:23-25 `// U14 通路維度：團購路徑只吃有明確勾選「可用於團購」的促銷。// 欄位預設 FALSE，所以既有促銷一律不會被團購自動套用 ... if (isGroupOrder && !p.applicable_to_group_orders) return false;`
- 註：isGroupOrder 只有團報路徑會傳 true（groupOrders.js:588），一般報名不傳（enrollments.js:441-449），所以一般報名行為不變。

**38. 團報成員在「揪團中」或「已送審」階段都可以自己轉帳並上傳付款資料，不必等團主送審；櫃檯一旦確認帳款就不能再改。**

- 誰能做：家長自己（該成員本人）
- 依據：server/routes/groupOrders.js:905-907 `// 團報流程：揪團中(forming)或送審後(submitted)皆可由各家自行轉帳並上傳付款資料...櫃檯已「確認帳款」後不可再改`；同檔 :935-937 `if (!['forming', 'submitted'].includes(order.status)) ... code: 'NOT_UPLOADABLE'`；同檔 :966-968 `if (member.payment_confirmed) ... code: 'ALREADY_CONFIRMED'`
- 註：三個獨立欄位鎖 PAYMENT_PROOF_LOCKED / TRANSFER_LAST5_LOCKED / CARRIER_LOCKED 在 :981-992，唯一例外「只補填漏掉的載具」在 :971-973，行號全對。payment_confirmed 只有在櫃檯對帳付款單時才會變 TRUE（admin/checkouts.js:324-334），admin/groupOrders.js 沒有獨立的「確認帳款」端點。

**39. 團報送審＝鎖定名單（送審後別人加不進來），但不影響收款；團主可手動送審，若全團付款資料齊備又剛好滿團，系統會自動送審。**

- 誰能做：團主／系統自動
- 依據：server/services/groupOrderSubmit.js:64-74 `自動送審的額外門檻：必須滿團（人數達 max_students）。用 max 而不是 min 是刻意的 —— 送審會鎖名單...一對三（min 2 / max 3）若在第 2 家付完款當下就自動送出，第 3 家永遠加不進來。`；server/routes/groupOrders.js:1027-1034 `if (order.status === 'forming') { const readiness = await evaluateSubmitReadiness(client, order); if (readiness.ok && isFullHouse(order, readiness.total)) { ... } }`
- 註：名單鎖定＝加入端要求 status='forming'（groupOrders.js:769-771 NOT_FORMING）。並發只有一邊成功：markSubmitted 條件式 UPDATE（groupOrderSubmit.js:88-93 `WHERE id = $1 AND status = 'forming'`），行號對。櫃檯代為送審走同一份判定（admin/groupOrders.js:251）。

**40. 只有團主可以送審、只有團主可以取消整團；成員加入後沒有「自己退出」的功能。**

- 誰能做：團主
- 依據：server/routes/groupOrders.js:1066-1068 `if (order.leader_parent_id !== req.parent.id) ... '只有團主可以送審'`；同檔 :1128 `if (o.rows[0].leader_parent_id !== req.parent.id) return res.status(403).json({ error: '只有團主可以取消' });`；同檔 :1134 `WHERE id=$1 AND status IN ('forming','submitted')`
- 註：「沒有退出端點」這個結論正確（全檔沒有任何刪除 group_order_members 的路由）。但**寫入端點不只四支**：家長端還有 POST /（發起，:491）、PUT /draft（:454）、DELETE /draft（:480）、POST /by-token/:token/lookup-phone（:370），連同 join/my-proof/submit/cancel 共 8 支。已核准的團不能取消（:1134 的狀態條件）正確。

**41. 團報核准成團時，櫃檯的核准動作才「回頭」為每個家庭各自產生一張付款單與該家庭的 N 期訂單，金額一律沿用家長加入當下落地的金額（不重算），付款單隨即進入待對帳清單。**

- 誰能做：櫃檯
- 依據：server/routes/admin/groupOrders.js:463-465 `// U14：有促銷的團，金額在「加入當下」就落地到 member 列（家長照那個金額轉帳），這裡一律沿用落地值，不重算 —— 重算會與家長已匯出的金額不一致。`；同檔 :489-498 `const checkout = await createCheckoutSession(client, { parentId: m.parent_id, enrollmentBatchId: memberBatchId, totalAmount: amt.final, ... })`；同檔 :511-516 `INSERT INTO admin_enrollments ... VALUES (...,'pending_payment',NOW(),$13,TRUE,1,$14,...)`
- 註：每家獨立 checkout＋獨立批次的理由在 :479-482，單期金額回推與末期補餘在 :484-488、:505-510，行號全對。舊團（final_amount 為 NULL）才回到動態計算（:466-474）。也就是團報家長確實是「先付錢、後才有訂單」。

**42. 團報成員自己上傳的匯款證明，在核准時會逐筆重驗檔案是否還存在：檔案失效但有末 5 碼 → 丟棄失效引用照樣核准並留稽核；連末 5 碼都沒有 → 整團擋下；檔案儲存區暫時查不到 → 整筆回滾要求重試。**

- 誰能做：櫃檯
- 依據：server/routes/admin/groupOrders.js:423-429 `// member proof 可能來自舊資料，或在上傳後、核准前被 bucket 管理作業移除...storage 暫時查不到（503 LOOKUP_FAILED）一律 rollback`；同檔 :435-436 `if (proofInput.code === 'PAYMENT_PROOF_LOOKUP_FAILED' || !hasLast5) { await client.query('ROLLBACK');`；同檔 :457 `proofByMemberId.set(member.id, null);`
- 註：失效時會寫一筆團購稽核（:451-456），且成員列原始資料不動、只是不複製到新訂單。

**43. 退費完全由櫃檯執行，家長端沒有任何退費申請入口；退款金額 =（剩餘堂數 ÷ 總堂數）× 實收金額，再扣手續費（預設 10%，櫃檯可逐筆改成其他比率或固定金額，改動會寫進稽核紀錄）。**

- 誰能做：櫃檯
- 依據：server/routes/admin/enrollments.js:1514-1515 `const remainRatio = Math.max(0, (total - used) / total); const amounts = calculateRefundAmounts([enrollment], remainRatio, default_fee_rate, feeRateOverride, feeAmountOverride);`；同檔 :1446 `const default_fee_rate = settings.refund_fee_rate ?? 0.1;`；server/services/refundReasons.js:67 `const refund_amount = fixed ? gross[i] - (next - allocated) : Math.round(Number(row.final_price) * remainRatio * (1 - fee_rate));`
- 註：家長端無退費端點已逐支核對：courses.js 只有 lessons/mine/types/base-price/:id/:id/payment-proof/:id/cancel；checkout.js 只有 route/:id/:id/payment-proof/:id/cancel。手續費夾在 0–100%、兩種模式不可並用在 refundReasons.js:43-57（`if (supplied(rateInput) && supplied(amountInput)) invalid('手續費只能選擇金額或百分比其中一種')`）。改動寫稽核在 admin/enrollments.js:1578-1583（feeNote）。已退費／已取消不可再退在 :1592-1594。

**44. 退費理由必須從固定清單選一項（公司因素-未媒合到教練／公司因素-場地因素／個人因素-生病生理／個人因素-一般正常退費／其他）並填詳述；理由只寫進後台稽核紀錄，家長端看不到。**

- 誰能做：櫃檯
- 依據：server/services/refundReasons.js:13-19 `const REFUND_REASONS = [{ code: 'company_no_coach', label: '公司因素 - 未媒合到教練' }, ... { code: 'personal_normal', label: '個人因素 - 一般正常退費' }, { code: 'other', label: '其他' }];`；server/routes/admin/enrollments.js:1551-1562 `if (!REFUND_REASON_CODES.includes(category)) ... if (!detail) ... '詳述原因必填'`
- 註：家長端回傳欄位確認：courses.js:294-298 只有 refund_amount／invoice_*，:275-276 只有 cancel_reason（退回補件用）與 returned_at，沒有退費理由。舊呼叫端只送 reason 字串仍接受（:1560）。

**45. 家庭共班的退費一律「整班整期」：本期全部兄弟訂單同一筆交易一起退，各筆按同一剩餘比例逐筆計算退款後加總，逐筆入帳以便對回發票。不支援只退其中一個小孩。**

- 誰能做：櫃檯
- 依據：server/routes/admin/enrollments.js:1601-1604 `if (preview.family_shared) { // U12 家庭共班：退費一律「整班整期」——本期全部兄弟訂單同交易一起退，共用 period 轉 refunded...不支援退單一小孩（營運規則：不會有單一小孩中途退出）。`；同檔 :1620-1622 `if (refundable.size !== preview.sibling_ids.length) ... '本期訂單已變動，請重新試算後確認'`
- 註：試上明確排除在 :1455-1458（`enrollment.order_kind !== 'trial'`），行號對。已用堂數取共用 period 的 DISTINCT 出席（:1460-1466）。

**46. 退費後對家長端的實際影響：該課期停用、未來「還沒上、也沒人簽到」的課堂會被取消並把教練時段釋回可預約，歷史出席紀錄保留；這張訂單也不再出現在「我的課程」任何分頁。**

- 誰能做：系統自動
- 依據：server/services/courseEntitlements.js:142-144 `UPDATE course_periods SET status = 'refunded', entitlement_state = CASE WHEN entitlement_state = 'ACTIVE' THEN 'MANUAL_REVIEW' ELSE entitlement_state END`；同檔 :145-151 `UPDATE course_sessions ... WHERE course_period_id = $1 AND status IN ('confirmed','pending_group_confirm') AND NOT EXISTS (SELECT 1 FROM checkin_records cr WHERE ... attendance_status = 'ATTENDED')` ＋ `UPDATE coach_availability_slots SET status = 'available'`；client/liff/src/pages/MyCoursesPage.jsx:25 `// 'closed'（取消/退費）不出現在任何分頁。`
- 註：課期要「所有來源訂單都已退費／取消」才停用：courseEntitlements.js:139 `if (!linked.length || linked.some(row => !['refunded','cancelled'].includes(row.status))) continue;`，行號對。

**47. 退費或取消後，家長不能再對那個課期簽到或預約；系統查不到來源訂單、或同一課期出現部分退費而無法判定是哪位學員時，一律擋下並要求人工核對，不會放行也不會誤擋還在付費的兄弟。**

- 誰能做：系統自動
- 依據：server/services/courseEntitlements.js:77-79 `if (!linked.length) { throw conflict('ENROLLMENT_SOURCE_UNRESOLVED', '找不到此課程期的來源報名，無法確認退費狀態，請先人工核對'); }`；同檔 :85-88 `REFUND_IDENTITY_REVIEW_REQUIRED` / `ENROLLMENT_ENTITLEMENT_INACTIVE`；同檔 :71-72 `if (!period || period.status !== 'active' || period.entitlement_state !== 'ACTIVE') throw conflict('PERIOD_ENTITLEMENT_INACTIVE', ...)`
- 註：fail-open → fail-closed 的說明在 :75-76，行號對。團報部分退費要求人工核對家長識別在 :91-100。這道守門同時掛在自助簽到（checkins.js:92）與預約（slots.js:297）。

**48. 取消或退費會把該筆報名占用的優惠名額回沖，家長的個人使用上限與平台總額度都會還回去。**

- 誰能做：系統自動
- 依據：server/routes/admin/enrollments.js:1663 `await promotions.revertUsage({ adminEnrollmentId: id }, client);`；server/routes/courses.js:862-863 `// 取消即釋放此報名占用的優惠用量（同交易內，以 admin_enrollment_id 冪等；無 usage 則 no-op）。await promotions.revertUsage({ adminEnrollmentId: row.id }, client);`
- 註：家庭共班退費逐筆回沖（:1631）。團報取消以整團回沖（groupOrders.js:1144 `await promotions.revertUsage({ groupOrderId: req.params.id })`，best-effort、失敗只 warn）。例外（櫃檯單筆取消不回沖）見第 57 條——已確認。另注意團報「退回補件」刻意不回沖（admin/groupOrders.js:651-654）。

**49. 櫃檯可以把「付款資料有問題」或「已被取消」的單退回補件：狀態回到待付款、末 5 碼與匯款證明被清空供重填，家長會在報名狀態頁看到退回原因並收到 LINE 通知。**

- 誰能做：櫃檯
- 依據：server/routes/admin/enrollments.js:1793-1800 `SET status = 'pending_payment', cancel_reason = $2, returned_at = NOW(), returned_by = $3, payment_proof_url = NULL, transfer_last_5 = NULL`；server/routes/courses.js:273-276 `// U14 退回補件：讓家長看得到「為什麼被退」。原本 reason 只寫進 audit log ... cancel_reason: row.cancel_reason || null, returned_at: row.returned_at || null,`
- 註：必須清空付款欄位的理由在 :1762-1763，可退回的狀態限 pending_payment/cancelled 在 :1786-1790，行號都對。LINE 通知帶的連結是 `/enroll-status/${notify.enrollmentId}`（:1839）——這是報名狀態頁目前唯一的活入口，與第 59、63 條有關。

**50. 折價券的判準：必須啟用中、在檔期內、總使用次數未用盡、平台總期數額度未滿、該家長個人期數上限未滿、適用於本次的組別／場館／期數門檻／教練加成級距，指定家長的券只有該家長能用。家長「手動輸入」的券失敗就整筆退回；「系統自動套用」的券若在送出瞬間失效，會降級成原價讓報名照樣成立。**

- 誰能做：家長自己
- 依據：server/services/promotions.js:160-182 `COUPON_NOT_ACTIVE / COUPON_OUT_OF_WINDOW / COUPON_EXHAUSTED / ... COUPON_OUT_OF_SCOPE / COUPON_NOT_OWNER`；server/routes/enrollments.js:524-526 `//  - 家長「明確輸入折價券」（couponCode 有值）失敗 → 整筆退回...//  - 「自動套用」促銷...若在此被用盡/失效 → 不中止一筆全額原本就有效的報名；降級為全額`；同檔 :542-544 `const softFail = ... ['COUPON_EXHAUSTED','COUPON_EXPIRED','COUPON_NOT_ACTIVE','COUPON_NOT_STARTED'].includes(err.code); if (explicitCoupon || !softFail) throw err;`
- 註：需代碼與私人券都不自動套用在 promotions.js:197-198，百分比券 discount_value 是保留比例在 :49-51，行號都對。個人期數上限是「已用期數＋本次期數 > 上限」才擋（:172-176）。

**51. 匯款帳戶以各場館自己維護的設定為準，該館沒設才退回全站舊值；家長在付款單頁看到的帳號就是這個來源。**

- 誰能做：沒有人（僅後台場館設定可改）
- 依據：server/routes/courses.js:563-568 `-- 匯款帳戶以 admin_venues（F-A03 場館設定，各館各自維護）為準；-- 該館尚未設定時才退回 venues 表既有值，避免顯示空白 ... COALESCE(NULLIF(av.account_holder, ''), v.account_holder) AS account_holder`
- 註：三處同一套取值：付款單（services/checkouts.js:267-270）、團報頁（groupOrders.js:249-252）、報名狀態頁（courses.js:565-568）。付款單頁的「場館」取第一筆子訂單的場館（checkouts.js:265、378-383），一張跨場館的付款單只會顯示一組帳號。

**52. 發票載具由家長自行填寫（選填、64 字上限），會在對帳開發票時被帶進發票資料；前端會把上次填的載具記在手機瀏覽器裡下次自動帶入。**

- 誰能做：家長自己
- 依據：server/routes/courses.js:690-691 `// 載具（選填）：電子發票手機條碼載具，trim + 上限長度，空字串視為未填。const carrier = typeof req.body?.carrier === 'string' ? req.body.carrier.trim().slice(0, 64) : '';`；client/liff/src/pages/EnrollStatusPage.jsx:125-126 `// 載具快取：記住本次填寫，下次報名/付款自動帶入（純前端 localStorage）。if (carrier.trim()) localStorage.setItem('daos_invoice_carrier', carrier.trim());`
- 註：對帳時 ae.carrier 有值優先、否則用同團同電話的成員載具補回：services/checkouts.js:354-358，行號對。對帳會把載具寫回 admin_enrollments 與 group_order_members（admin/checkouts.js:306、:328）。

**53. 對帳開票之後，家長在課程詳情頁看得到發票號碼與發票照片連結，以及實付金額、到期日與堂數進度。** 〔覆核時補上〕
- 依據：server/routes/courses.js:295-298 `invoice_number: row.invoice_number || null, invoice_image_url: row.invoice_image_url || null, invoice_url: ..., invoice_issued_at: ...`；client/liff/src/pages/CourseDetailPage.jsx:161-166 `{course.invoice_number && (<div ...>發票號碼：...</div>)} {course.invoice_image_url && (<a href={course.invoice_image_url} ...>`

**54. 訂單一成立，家長一律被導到付款單頁；現場付費（試上）在那裡看到的是「現場付款」指示，不是銀行帳號，而且沒有上傳付款資料的表單。** 〔覆核時補上〕
- 依據：server/services/checkouts.js:19-22 `target_page: '/checkout/payment-view', action_required: rawState.toLowerCase() === CHECKOUT_STATUS.PAID ? 'NONE' : paymentMethod === 'on_site' ? 'DISPLAY_ON_SITE_PAYMENT' : 'DISPLAY_BANK_INFO'`；client/liff/src/pages/CheckoutPage.jsx:193 `const canUpload = !isOnSite && ['pending_payment','pending_reconcile'].includes(checkout.payment_status);`

**55. 付款單一旦離開「待繳款／待對帳」（已付款或已取消），家長就不能再上傳或修改付款資料。** 〔覆核時補上〕
- 依據：server/routes/checkout.js:267-269 `if (![CHECKOUT_STATUS.PENDING_PAYMENT, CHECKOUT_STATUS.PENDING_RECONCILE].includes(locked.rows[0].payment_status)) ... '此付款單狀態無法再上傳證明', code: 'NOT_PENDING'`；server/routes/courses.js:733-735 同義（看子訂單 status）

**56. 一次買多期的訂單，在對帳前看到的是一張合併卡片，對帳後會變成每期一張卡（買 4 期＝4 張），因為合併只發生在「同一個課期」上，而每一期各自開一個課期。** 〔覆核時補上〕
- 依據：server/routes/courses.js:322 `合併鍵＝course_period_id（非團報、已開通才會共用）`；server/routes/admin/enrollments.js:415-427 `INSERT INTO course_periods (... admin_enrollment_id, is_experience_course, period_number) VALUES (...)`（每筆子訂單各自一個課期，period_number 隨報名單）

**57. 退回補件時，被清空的付款欄位範圍不對稱：只有被退的那一筆子訂單的末 5 碼與證明被清掉，但整張付款單的付款欄位與狀態都被退回「待繳款」——同一張付款單的其他子訂單也一起退回待繳款狀態。** 〔覆核時補上〕
- 依據：server/routes/admin/enrollments.js:1793-1800 `UPDATE admin_enrollments SET status = 'pending_payment', ... payment_proof_url = NULL, transfer_last_5 = NULL WHERE id = $1`；同檔 :1802-1811 `UPDATE checkout_sessions SET payment_status = 'pending_payment', ... payment_proof_url = NULL, transfer_last_5 = NULL WHERE checkout_id = $1`


#### 判準不一致（19 條）

**1. 同一件事（家長送出付款資料）四個入口的完成判準不一致：付款單頁與報名狀態頁的畫面都要求「末 5 碼＋匯款證明兩項齊備」才讓按鈕亮，但後端 API 只要三項（末 5 碼／證明／載具）任一有值就收；團報送審嚴格要求兩項齊備，櫃檯核准團報又放寬成兩項擇一。**

- 誰能做：家長自己
- 依據：client/liff/src/pages/CheckoutPage.jsx:197 `const submitDisabled = proofBusy || !validLast5 || (!proofFile && !checkout.has_payment_proof);`；server/routes/checkout.js:291-293 `if (!proofInput.clear && !nextProofUrl && !nextLast5 && !nextCarrier) ... code: 'PAYMENT_INFO_REQUIRED'`；server/services/groupOrderSubmit.js:46-54 `「付款齊備」在送審端比後台核准端嚴...送審端要求兩者都有`；server/routes/admin/groupOrders.js:404-407 `家長端 my-proof 允許「轉帳末 5 碼」或「匯款證明」擇一送出（櫃檯憑末 5 碼即可查帳），核准守門必須採同一標準：兩者皆缺才擋`
- 註：四處判準全部核對無誤，並補兩點：①報名狀態頁前端同樣要求兩項（EnrollStatusPage.jsx:100 `if (!proofFile && !enr.has_payment_proof) return toast.error('請選擇匯款／轉帳證明');`、:245 送出鈕 disabled 同條件）；②「只填載具」會被 API 收下卻**不會**推進待對帳（:291 必填檢查含 carrier、:296 狀態判定不含），家長會停在待繳款而自以為送出了。程式註解只替團報兩端的差異留了理由，一般報名 UI 與 API 的落差沒有任何註解。

**2. 同一張訂單，兩個對帳入口算出的總堂數可能不同：付款單批次對帳優先沿用訂單上已有的堂數，單筆對帳一律重算成「每期堂數 × 期數」並覆蓋。**

- 誰能做：櫃檯
- 依據：server/routes/admin/checkouts.js:295-297 `const total = row.order_kind === 'trial' ? 1 : (Number(row.total_sessions) || perPeriod * (Number(row.period_count) || 1));`；server/routes/admin/enrollments.js:1296 `const total = cur.rows[0].order_kind === 'trial' ? 1 : (perPeriod * periodCount);`
- 註：完全成立。家長端建單把一般訂單堂數寫死 6（enrollments.js:579 `paymentMethod, orderKind, isTrial ? 1 : 6,`），所以全站設定的每期堂數若不是 6，批次對帳＝6 堂、單筆對帳＝設定值。團報核准的訂單不寫 total_sessions（admin/groupOrders.js:513-515 欄位清單確認沒有這一欄），因此一定吃設定值。櫃檯手動建檔的訂單有寫（admin/enrollments.js:815 `total_sessions`＝periodSessions），批次對帳時會沿用。

**3. 「每期幾堂」有多個來源互不相通：家長報名頁試算讀「該場館所屬定價區」的設定，家長建單時寫死 6，對帳時讀全站設定，後端試上價推算也讀全站設定。**

- 誰能做：沒有人（僅設定可改）
- 依據：server/routes/courses.js:489 `z.sessions_per_period AS sessions_per_period`（FROM venues JOIN pricing_zones）；server/routes/enrollments.js:579 `isTrial ? 1 : 6,`；server/routes/admin/checkouts.js:287-288 `const settings = await getSettings(); const perPeriod = settings.sessions_per_period || 6;`；server/routes/enrollments.js:381-383 `SELECT key, value FROM admin_settings WHERE key IN ('sessions_per_period', 'trial_price', $1)`
- 註：敘述成立且比原文更嚴重：實際有**四個**來源（第四個是後端試上價推算，enrollments.js:381-385 → trialEnrollment.js:58 `Math.max(1, Math.trunc(Number(settings.sessions_per_period) || 6))`，讀全站設定）。而且建單當下 cfg 手上已經有定價區的值——courseConfig.js:84 `return { ...r.rows[0], zone, sessions_per_period: zone.sessions_per_period };`——卻沒被使用。base-price 端點的分區註解在 courses.js:485-487，行號對。

**4. 試上價的取值順序前後端不一致：後端在課別設定的試上價之外還會退回兩個舊全域設定鍵，前端只認課別設定、其餘一律用「單期價 ÷ 每期堂數」推算，而且推算用的每期堂數也是不同來源（前端用定價區、後端用全站設定）。**

- 誰能做：沒有人（僅設定可改）
- 依據：server/services/trialEnrollment.js:53-55 `const courseSpecific = positiveMoney(settings[`trial_price_course_${courseType}`]); const configured = courseSpecific || positiveMoney(settings.trial_price); if (configured) return Math.round(configured * m);`；client/liff/src/hooks/useEnrollmentPricing.js:35-37 `return Number.isFinite(configured) && configured > 0 ? Math.round(configured * m) : Math.round(unitPrice / sessionsPerPeriod);`
- 註：成立。前端 sessionsPerPeriod 來自 base-price 端點＝定價區值（useEnrollmentPricing.js:29 `Number(bootData?.sessionsPerPeriod)`；courses.js:489、:511）；後端推算退路用 admin_settings 全站值。畫面價≠成交價只會在「課別沒設試上價、但舊全域鍵有值」時發生，維持 uncertain：未連資料庫，無法確認 admin_settings 的 trial_price／trial_price_course_N 目前是否有值。

**5. 三個「取消待付款訂單」的入口，只有兩個會回沖優惠名額：家長自己取消、櫃檯取消整張付款單都會回沖，櫃檯取消單筆報名不會。**

- 誰能做：家長自己／櫃檯
- 依據：server/routes/courses.js:863 `await promotions.revertUsage({ adminEnrollmentId: row.id }, client);`；server/routes/admin/checkouts.js:512 `await promotions.revertUsage({ adminEnrollmentId: row.id }, client);`；server/routes/admin/enrollments.js:1708-1742（UPDATE status='cancelled' → UPDATE checkout_sessions → INSERT audit log，整段無 revertUsage）
- 註：逐行看完 admin/enrollments.js 的 /:id/cancel（1686-1753）確認沒有任何 revertUsage 呼叫，對照同檔退費路徑 :1663 有呼叫。對家長的影響如敘述：被櫃檯用單筆取消後，該筆占用的個人期數上限與平台總額度不會歸還，下次報名可能被判「您已達到該優惠活動的個人使用上限」（promotions.js:175）。這是本清單裡對家長金錢影響最直接的一條不一致。

**6. 「取消原因」只有退回補件會寫進家長看得到的欄位；櫃檯取消報名與取消整張付款單的原因只進後台稽核紀錄，家長端顯示的是空白。**

- 誰能做：櫃檯
- 依據：server/routes/admin/enrollments.js:1796 `cancel_reason = $2, returned_at = NOW(), returned_by = $3,`（return-for-fix）；同檔 :1738-1741 `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user, reason) VALUES ($1, $2, $3, $4)`（cancel 只寫稽核）；server/routes/courses.js:275 `cancel_reason: row.cancel_reason || null,`
- 註：成立。付款單取消原因寫進付款單稽核 JSON（admin/checkouts.js:533 `'reason', $4::text`），而家長端讀付款單的 shapeCheckout 不回傳 audit_log 的 reason（services/checkouts.js:221-257 欄位清單）。另注意 admin 取消時 reason 非必填（:1691 空字串也放行），付款單取消則必填（admin/checkouts.js:473-474）。

**7. 取消付款單時，兩個入口對「連帶取消範圍」判準不同：付款單頁取消會把整張付款單下所有子訂單一起取消，報名狀態頁取消只取消當前那一筆，其餘子訂單留在待付款。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:377-381 `UPDATE admin_enrollments SET status = 'cancelled', updated_at = NOW() WHERE checkout_id = $1`；server/routes/courses.js:834-838 `UPDATE admin_enrollments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`
- 註：兩個後端入口的差異成立，付款單只在「已無其他非取消子訂單」時才標取消（courses.js:842-860 的 CASE WHEN NOT EXISTS）。**但原文的 UI 敘述要更正**：合併卡片的「取消訂單」不會只取消一筆——MyCoursesPage.jsx:171-176 `if (cp.is_checkout_aggregate && cp.checkout_id) { await checkoutApi.cancel(...) } else if (cp.is_checkout_aggregate && sub_order_ids.length) { await Promise.all(sub_order_ids.map((id) => coursesApi.cancelPending(id))) }`，兩條都是全取消。只取消一筆的入口是**報名狀態頁**（EnrollStatusPage.jsx:148 `await coursesApi.cancelPending(id)`），而該頁目前的活入口正是「退回補件」的 LINE 連結（admin/enrollments.js:1839 `/enroll-status/${notify.enrollmentId}`）。

**8. 同一張付款單的付款資料，家長端兩個入口的門檻不同：報名狀態頁入口不擋團報單、也不看團報流程狀態（只認手機＋子訂單狀態），團報專用入口要求必須是該團成員、只在揪團中／已送審開放、且櫃檯確認帳款後鎖死。**

- 誰能做：家長自己
- 依據：server/routes/courses.js:729-739（只檢查 parent_phone／extra_parent_phones、status='pending_payment'、payment_method≠on_site，全段無 group_order_id 檢查；對照同檔 :826-828 cancel 有擋團報）；server/routes/groupOrders.js:935-937 `if (!['forming','submitted'].includes(order.status)) ... code: 'NOT_UPLOADABLE'`；同檔 :939-968 `WHERE group_order_id = $1 AND parent_id = $2 ... if (member.payment_confirmed) ... code: 'ALREADY_CONFIRMED'`
- 註：不一致成立，但**繞道機制要更正**：原文說可以繞過「櫃檯已確認帳款不可改」——不可達。payment_confirmed 只在櫃檯對帳付款單時變 TRUE，而同一筆交易也把該家庭的子訂單轉成 confirmed（admin/checkouts.js:300 與 :325 同一交易），此時報名狀態頁入口會先撞 NOT_PENDING（courses.js:733）。真正可達的缺口有三個：①團報**核准後**團報入口整個關閉（status='approved' → NOT_UPLOADABLE），報名狀態頁入口卻仍開著；②身分判準不同——報名狀態頁接受額外家長手機，團報入口只認成員 parent_id；③從報名狀態頁寫進去的值只落在 admin_enrollments／checkout_sessions，**不會回寫 group_order_members**，團購狀態頁因此仍顯示未上傳（shapeMember 只讀成員列，groupOrders.js:227-232）。

**9. 建立付款單只認訂單上的主要家長手機，但檢視／上傳／取消付款單認主要手機、額外家長手機或付款單登記的家長本人。**

- 誰能做：家長自己
- 依據：server/routes/checkout.js:116-128 `WHERE enrollment_batch_id = $1 AND parent_phone = $2 AND status = 'pending_payment'` → `code: 'NO_OWN_SUB_ORDERS'`；同檔 :27-30 `if (checkout.parent_id && checkout.parent_id === parent.id) return true; ... o.parent_phone === phone || (o.extra_parent_phones || []).includes(phone)`
- 註：成立。家長端自建訂單不寫 extra_parent_phones（enrollments.js:567-571 欄位清單確認沒有這一欄），所以只有櫃檯手動建檔登記過配偶的單會踩到：配偶進得去既有付款單，卻無法在「尚未產生付款單」時按「上傳付款資料」去補建（MyCoursesPage.jsx:132 呼叫的就是 checkout route）。

**10. 課期到期日只擋簽到、不擋預約：自助簽到會檢查課期是否已過期並回「此課程期已到期」，家長預約時段完全不檢查到期日。**

- 誰能做：家長自己
- 依據：server/routes/checkins.js:66 `(cp.expires_at >= (NOW() AT TIME ZONE 'Asia/Taipei')::date) AS not_expired` ＋ :88-90 `if (!period.not_expired) ... code: 'PERIOD_EXPIRED'`；server/routes/slots.js:288-291 `SELECT id, coach_id, venue_id, course_type, status, total_sessions FROM course_periods WHERE id = $1 FOR UPDATE`
- 註：成立且已用 grep 覆核：`expires_at` 在 server/routes/slots.js 與 server/services/slots.js 完全不出現。可選時段查詢（slots.js:225）與預約（:309）都只看 status='active'。後果如敘述：已到期課期仍可預約未來時段並佔用教練時段，現場才簽不進去；試上 30 天到期最容易踩到。

**11. 退費金額 API 已回傳給家長端，但家長端畫面完全沒有顯示退款金額的地方，而且已退費的課程不會出現在「我的課程」任何分頁。**

- 誰能做：系統自動
- 依據：server/routes/courses.js:294 `refund_amount: row.refund_amount != null ? Number(row.refund_amount) : null,`；client/liff/src/pages/MyCoursesPage.jsx:25 `// 'closed'（取消/退費）不出現在任何分頁。`（grep 確認 client/liff/src 全樹零個 refund_amount／refundAmount 引用）
- 註：成立。補一點入口事實：報名狀態頁的「已退費」徽章在 EnrollStatusPage.jsx:20 `refunded: { label: '已退費', ... }`，該頁路由 /enroll-status/:id（App.jsx:131）目前唯一的活連結是「退回補件」的 LINE 訊息（admin/enrollments.js:1839）——而退費**不發任何通知或連結**，所以退費後家長確實只能靠舊連結或問櫃檯。

**12. 對帳成功的通知走 Email（決策是「家長不用 LINE」），但退回補件、團報有人加入、團報送審這三件事仍然推 LINE 給家長。**

- 誰能做：系統自動
- 依據：server/routes/admin/checkouts.js:454 `// 家長端改走 Email（Owner 決定：家長不用 LINE）。`；server/routes/admin/enrollments.js:1837-1840 `if (notify && notify.uid) { const line = require('../../services/line'); ... line.pushMessage(notify.uid, line.templates.returnedForFix({`；server/services/groupOrderSubmit.js:129-131 `await line.pushMessage(row.line_uid, line.templates.groupSubmitted({`
- 註：成立，且推 LINE 給家長的事件比原文多一件：**團報退回補件**也推給全體成員（admin/groupOrders.js:691-698 `line.templates.returnedForFix(...)` 迴圈 push）。團報有人加入在 groupOrders.js:885-890。對帳信查不到 Email 只留 skipped、不改走 LINE：reconcileNotify.js:184-187 `// ...實測有 7.5% 的已對帳訂單用電話查不到 parent。const status = email ? 'pending' : 'skipped';`，行號與數字都對。

**13. 一般報名的最低學員數只有前端在把關：畫面要求一對 N 必須剛好湊滿 N 位，後端只檢查不超過上限、不檢查下限。**

- 誰能做：家長自己
- 依據：client/liff/src/pages/EnrollmentPage.jsx:90-94 `// 1對N 須剛好湊滿 N 位（min=max=courseType）...const minStudents = isTrial ? 1 : courseType;`（送出鈕條件 :127-133 `totalSelected >= minStudents`）；server/routes/enrollments.js:340-355（只有 `if (studentCount < 1)` 與 `studentCount > maxStudents` 兩道）
- 註：成立。直打 API 可以用 1 位學員買一對三，價格按 1 位算（:403 `original = unitPrice * studentCount * periodCount`），而且對帳時會因 sib.rowCount === 1 走單人 period 分支（admin/enrollments.js:315），開出一個只有 1 人的一對三課期。

**14. 「課期效期＝365 天 × 期數」、「總堂數＝每期堂數 × 期數」這兩條公式在現行三個建單入口下永遠只乘 1，因為三個入口都把每筆子訂單的期數寫成 1。**

- 誰能做：系統自動
- 依據：server/routes/admin/enrollments.js:408 `: String(365 * (Number(enrollment.period_count) || 1));`；server/routes/enrollments.js:572 `VALUES ($1,...,'pending_payment',$13,1,$14,$15,$16,$17,$18,$19,$20,0)`（第 15 欄 period_count 為常數 1）；server/routes/admin/groupOrders.js:516 `VALUES (...,'pending_payment',NOW(),$13,TRUE,1,$14,$15,$16,$17)`；server/routes/admin/enrollments.js:819 `VALUES ($1,...,'pending_payment',$12,$13,0,1,$14,...)`
- 註：三處欄位對位我逐欄數過，period_count 都是字面常數 1（家長 LIFF 的欄位清單在 enrollments.js:567-571、櫃檯建檔在 admin/enrollments.js:812-817、團報核准在 admin/groupOrders.js:513-515）。所以買 4 期＝4 筆各 1 期、各自 6 堂、各自 365 天。replit.md:262 對團報寫的 `total_sessions = 每期堂數 × 期數、expires_at = 365 × 期數` 與拆單後的實際行為不符，屬過期文件。

**15. 家長手冊寫推薦朋友可拿 9 折券、朋友報名可用 TRIAL50 體驗課 5 折，前端已停用並主動清掉瀏覽器殘留的券碼，但後端仍保留完整的 TRIAL50 驗證與兌換邏輯。**
- 依據：docs/manuals/parent.md:82 `給朋友：報名時可用 `TRIAL50` 體驗課 5 折。`；client/liff/src/pages/EnrollmentPage.jsx:47-50 `// 推薦折扣（TRIAL50）已停用（2026-07 全站優惠清除）：不再自動套用 pendingCoupon，並主動清掉既有使用者瀏覽器內殘留的 daos.pendingCoupon ... localStorage.removeItem('daos.pendingCoupon')`；server/routes/enrollments.js:412-430（TRIAL50 專屬 referral 驗證，FOR UPDATE 序列化）＋ :596-607 `const paid = await referrals.markTrialPaid(...)`
- 註：kind 保留 inconsistent 是對的（手冊、前端、後端三方不一致）。原文那句「試上單根本不吃券，而 TRIAL50 的設計用途正是體驗課折扣」我特別覆核過順序：TRIAL_COUPON_NOT_SUPPORTED（:406-409）**先於** TRIAL50 檢查（:412），所以 TRIAL50 永遠只能用在一般報名單上。uncertain 的部分維持：未連資料庫，無法確認 promotions 表裡 TRIAL50 是否還存在；若已刪除，手動輸入會先撞 COUPON_INVALID（promotions.js:155-157），那段專屬邏輯即為死碼。

**16. 教練停用後，一般報名會被擋下來，團報卻照樣可以開團：一般報名要求教練存在且在職，團報發起只確認教練這筆資料存在、不看是否停用，而且完全不指定教練也可以開團。** 〔覆核時補上〕
- 依據：server/routes/enrollments.js:323-329 `SELECT name, pricing_multiplier FROM coaches WHERE id = $1 AND is_active = TRUE` → `'coach not found or inactive'`；server/routes/groupOrders.js:548-552 `if (coachId) { const cr = await client.query(`SELECT id, pricing_multiplier FROM coaches WHERE id = $1`, [coachId]); if (!cr.rowCount) ... '教練不存在' }`；同檔 :495 `const coachId = p.coach_id ? String(p.coach_id).trim() : null;`

**17. 「付款資料兩項都送出就不能再改」有一個例外：家長可以刪除已上傳的匯款證明，刪掉之後鎖定就解除、可以重新上傳（末 5 碼沒有對應的清除功能）。這個能力只存在於 API，LIFF 畫面沒有任何刪除入口。** 〔覆核時補上〕
- 依據：server/services/paymentProof.js:26 `const clear = input.delete_payment_proof === true || input.payment_proof_action === 'delete';`；server/routes/checkout.js:279-280 `if (locked.rows[0].transfer_last_5 && locked.rows[0].payment_proof_url && !proofInput.clear && !(sameProof && sameLast5))`（同一旁路在 courses.js:750-751、groupOrders.js:974）；三個家長端入口都開 allowClear：checkout.js:271、courses.js:741、groupOrders.js:909

**18. 「我的課程」清單與付款單頁認人的方式不同：清單只認手機（訂單上的主要家長手機或被登記的額外家長手機），付款單頁另外接受「這張付款單登記的家長本人」。** 〔覆核時補上〕
- 依據：server/routes/courses.js:222 `WHERE parent_phone = $1 OR $1 = ANY(extra_parent_phones)`（單筆報名狀態頁同樣只認手機，同檔 :617）；server/routes/checkout.js:27 `if (checkout.parent_id && checkout.parent_id === parent.id) return true;`

**19. 團報成員填的付款資料只寫在成員列上，團購狀態頁也只讀成員列；若同一個人改從報名狀態頁或付款單頁送出，值不會回寫成員列，團購狀態頁會一直顯示「未上傳」。** 〔覆核時補上〕
- 依據：server/routes/groupOrders.js:227-232 `transfer_last_5: isSelf ? (m.transfer_last_5 || '') : '', carrier: ..., has_payment_proof: !!m.payment_proof_url, has_payment_info: !!(m.payment_proof_url && String(m.transfer_last_5 || '').trim())`（全部讀 group_order_members）；server/routes/courses.js:769-790（只寫 admin_enrollments 與 checkout_sessions）


#### 只在文件裡（程式沒有／不同）（6 條）

**1. replit.md 寫「試上固定價不吃教練係數」，程式現在是吃的。**
- 依據：replit.md:163 `F-A07 `trial_price` 有設＝每人固定價（不吃教練係數、含「待分配」卡）`；server/services/trialEnrollment.js:11-12 `2026-09-07 規格改變（使用者決定）：試上價**要乘教練係數**。`
- 註：kind 正確。程式與前端都已改成乘係數（trialEnrollment.js:50-55、useEnrollmentPricing.js:33-37）。replit.md:163 是 2026-07-16 那一輪的舊紀錄未更新；同檔 :160 關於「試上效期 30 天」的紀錄則與程式一致。

**2. replit.md 寫團報「後台逐家確認帳款＋核准名單（需全員上傳）＋兩者成立自動建檔」是待做，現況確實沒有：名單核准這件事只有欄位與家長端的回傳值，全系統沒有任何地方寫入它。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：replit.md:253 `**里程碑2（待做）**：後台逐家「確認帳款」+「核准名單(需全員上傳)」+ 兩者成立自動建檔...**現階段後台仍走舊 approve/reconcile**。`；server/routes/groupOrders.js:335 `roster_approved: !!order.roster_approved,`
- 註：已用 grep 覆核全 repo：roster_approved 只出現在 4 個地方——DDL 兩處（server/bootstrap/coreSchema.js:1075-1077、db/migrations/021_release_ops_hardening.sql:65-67）與讀取一處（groupOrders.js:335），沒有任何 UPDATE。預設 FALSE，因此家長端拿到的 roster_approved 恆為 false。行號全對。

**3. 家長手冊寫「1 對 2、1 對 3 課程輸入合報家長手機、勾選對方學員」，這條路已被移除，現在跨家庭合報只能走團報。**
- 依據：docs/manuals/parent.md:46 `1 對 2、1 對 3 課程：輸入合報家長手機 → 系統查到對方學員 → 勾選對方要合報的學員。`；client/liff/src/pages/EnrollmentPage.jsx:115 `// U4：移除「帶出他人學員」流程後，報名只能選自己名下的學員（同組改走 U5–U8 團購）。`
- 註：server/routes/parents.js:5-6 也記載 GET /by-phone 因越權查詢被移除、任何 /by-phone 請求落到 catch-all 回 404，行號對（grep 確認 parents.js 已無 by-phone 路由；coaches.js 的 by-phone 是教練登入，無關）。後端也擋：enrollments.js:372-374 只查 `parent_id = $1` 名下學員。

**4. 家長手冊寫「報名頁看到銀行帳號 → 轉帳 → 回 LIFF 填末 5 碼 → 送出」，實際流程是先送出報名建立訂單，付款資料在之後的付款單頁／報名狀態頁才填。**
- 依據：docs/manuals/parent.md:51-53 `7. 看到「銀行帳號」區塊 → 點一鍵複製 → 用網銀／ATM 轉帳。 8. 回到 LIFF → 填轉帳金額末 5 碼 → 確認摘要彈窗 → 送出。`；server/routes/enrollments.js:125-126 `// 匯款／轉帳證明在訂單成立後於狀態頁補填`
- 註：前端佐證：EnrollmentPage.jsx:126 `// 付款資料在訂單成立後才填，讓一般報名與團報到尾端才分岔。`，且送出 payload 不含付款欄位（:152-169）。銀行帳號是在付款單頁才顯示（CheckoutPage.jsx:186-191）。

**5. 家長手冊寫「我的課有 4 個分頁：全部／待對帳／進行中／已結束」，實際是 3 個分頁（全部／進行中／待審核），且取消與退費的課程不出現在任何分頁。**
- 依據：docs/manuals/parent.md:27 `- 4 個分頁：全部 / 待對帳 / 進行中 / 已結束。`；client/liff/src/pages/MyCoursesPage.jsx:26-30 `const TABS = [{ key: 'all', label: '全部' }, { key: 'active', label: '進行中' }, { key: 'review', label: '待審核' }];`
- 註：分頁語意在 :21-25 註解（review＝pending_payment 的報名＋forming/submitted 團報；closed 不出現）。計數在 :110-114。

**6. 家長手冊寫「上課當天到場館跟櫃檯說手機號碼，櫃檯在後台幫你簽到」，現況全站預設是家長自助簽到。**
- 依據：docs/manuals/parent.md:63 `- 上課當天到場館 → 跟櫃檯說手機號碼 → 櫃檯在後台幫你完成簽到。`；replit.md:185 `**（同日追加）自助簽到改為全站預設**（migration 031＋bootstrap）：營運決策——所有場館所有課程直接用自助簽到。`
- 註：與本面向的關聯如敘述：堂數是否被扣由家長自己按簽到決定（checkins.js:45 POST /self，requireParent）。簽到規則本身屬凍結範圍（courses.js:1-6、MyCoursesPage.jsx:1-6 的凍結標頭），未細列。


### 3.7 家長端通知


#### 實作中（52 條）

**1. 所有 LINE 推播都必須先通過同一道安全閥，而這道閘門的預設值是「全部不送」：總開關預設關、演練模式預設開。設定讀不到（資料庫查不到、連線失敗）也一律當成關閉。**

- 誰能做：沒有人（僅 DB 可改 admin_settings）
- 依據：server/services/pushGate.js:30 `const DEFAULTS = { push_enabled: 0, push_dry_run: 1, push_max_per_hour: 50 };`；pushGate.js:44-47 `} catch (e) { // 讀不到設定 → 維持 DEFAULTS（總開關 0）＝ 什麼都不送。 console.warn('[pushGate] 讀取設定失敗，套用最保守預設：' + e.message); }`
- 註：逐字核對無誤。檔頭 pushGate.js:4-8 的理由也確認：19 個模板長期全失敗，token 修好會「同時」對全體客戶群發。

**2. 總開關（push_enabled）關著的時候，任何一種通知的個別開關開了也沒用，一則都不會送出，紀錄上的理由是 DISABLED_GLOBAL。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：server/services/pushGate.js:58 `if (!isOn(s[SETTING.enabled])) return { allow: false, reason: 'DISABLED_GLOBAL' };`（isOn 定義在 :36 `const isOn = (v) => Number(v) === 1;`）
- 註：無誤。補一點：判定是「只有 1 才算開」，值寫成 true/'yes' 等都視為關。

**3. 每一種通知各有自己的獨立開關（admin_settings 的 push_event_<事件代號>），沒有明確設成 1 的事件一律視為關閉。家長端目前用到的事件代號有四個：checkin_confirmed_parent（簽到）、group_submitted（團報送審）、group_member_joined（有人加入團購）、legacy（其餘全部）。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：server/services/pushGate.js:33 `const EVENT_KEY = (event) => 'push_event_' + event;`；pushGate.js:59 `if (!isOn(s[EVENT_KEY(event)])) return { allow: false, reason: 'DISABLED_EVENT:' + event };`
- 註：四個代號逐一對上：checkinNotify.js:30 `const EVENT_PARENT = 'checkin_confirmed_parent';`、groupOrderSubmit.js:138、routes/groupOrders.js:890、line.js:85 預設值 legacy。我另外全庫掃過 `event: '` 的每一處，家長端沒有第五個代號（customerParents.js:250 的 admin_unbind_line 是 console.log 稽核行，不是推播事件）。

**4. 演練模式（push_dry_run）開著的時候，通知會照常寫進發送紀錄、狀態記成 dry_run，但實際上一則都不會送出。這是最容易誤判的組合——看起來一切正常。**

- 誰能做：後台（admin 可在系統設定頁取消勾選演練模式）
- 依據：server/services/line.js:117-119 `if (d.dryRun) { await pushGate.finish({ id, status: 'dry_run', reason: d.redirected ? 'REDIRECTED_TO_TEST_UID' : null }); return { sent: false, reason: 'DRY_RUN' };`
- 註：「誰能做」要改：演練模式在後台白名單內（admin/settings.js:26 `'push_enabled', 'push_dry_run', 'push_max_per_hour',`），不是只能改 DB。警示文字確認在 client/admin/src/pages/SettingsPage.jsx:96。

**5. 每小時實際送出量有上限（預設 50 則）。計算方式是「過去一小時內全站狀態為已送出的總則數」，不分事件、不分收件人。撞到上限後的通知直接被擋，理由記 RATE_LIMIT:<目前量>/<上限>。**

- 誰能做：後台（admin 可在系統設定頁改上限數字）
- 依據：server/services/pushGate.js:65-68 `SELECT COUNT(*)::int n FROM line_push_log WHERE status = 'sent' AND at >= NOW() - INTERVAL '1 hour'` → `if (c.rows[0].n >= cap) return { allow: false, reason: 'RATE_LIMIT:' + c.rows[0].n + '/' + cap };`
- 註：無誤，含 RATE_CHECK_FAILED 的部分（pushGate.js:69-72 `// 查不到用量就不敢放行` → `return { allow: false, reason: 'RATE_CHECK_FAILED:' + e.message };`）。這條上限「不分事件」的副作用見 added 第 3 條。

**6. 收件人沒有 LINE 帳號（line_uid 為空）時，通知不會送出，紀錄理由為 NO_RECIPIENT_UID。**

- 誰能做：系統自動
- 依據：server/services/pushGate.js:60 `if (!uid) return { allow: false, reason: 'NO_RECIPIENT_UID' };`
- 註：無誤。順序上它排在總開關與事件開關之後，所以閘門關著時理由會是 DISABLED_*，不會是 NO_RECIPIENT_UID。

**7. 去重規則：同一個事件 + 同一個業務主鍵 + 同一個收件人，只會送一次。發送失敗的那一列不納入去重，所以失敗可以重送。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:1810-1812 `CREATE UNIQUE INDEX IF NOT EXISTS uniq_push_log_dedupe ON line_push_log(event, ref_id, recipient_uid) WHERE ref_id IS NOT NULL AND status <> 'failed';`；pushGate.js:85-91 先 `INSERT ... VALUES ($1,$2,$3,$4,$5,'sending') ON CONFLICT DO NOTHING RETURNING id` → `return r.rowCount ? r.rows[0].id : null;`
- 註：無誤。

**8. 被閘門擋下來的通知也一定會留一筆紀錄（狀態 skipped + 原因），這樣「為什麼家長沒收到」查得出來。唯一不補寫紀錄的情況是「被去重擋掉」，因為既有的那一列本身就是紀錄。**

- 誰能做：系統自動
- 依據：server/services/pushGate.js:104-113 `async function logSkipped(...)` → `INSERT INTO line_push_log (..., status, reason) VALUES ($1,$2,$3,$4,$5,'skipped',$6) ON CONFLICT DO NOTHING`；line.js:111-114 `// 不再補寫一筆 skipped ...` → `return { sent: false, reason: 'DUPLICATE' };`
- 註：無誤。

**9. 環境變數設了測試收件人（LINE_PUSH_TEST_UID）時，全站每一則推播都改送到那一個 LINE 帳號，原本的家長收不到，紀錄上標 REDIRECTED_TO_TEST_UID。**

- 誰能做：沒有人（只能改部署環境變數）
- 依據：server/services/pushGate.js:75-76 `const testUid = String(process.env.LINE_PUSH_TEST_UID || '').trim(); return { allow: true, dryRun: isOn(s[SETTING.dryRun]), uid: testUid || uid, redirected: !!testUid };`
- 註：無誤。pushGate.js:53 另有一句約束呼叫端：`uid 在測試模式下會被改寫 —— 呼叫端必須用回傳的 uid，不可用原本傳入的`，line.js:99 `const uid = d.uid;` 確實照做。

**10. 全站所有推播只走一個 LINE 官方帳號（內部帳號 dreams400），不分場館、不分家長或教練。四個場館自己的官方帳號推不到家長（帳號編號屬於另一個 provider，實測 60 位家長 0 位收得到），這條路已經被移除。**

- 誰能做：系統自動
- 依據：server/services/lineRouting.js:112-114 `async function resolveChannel({ kind, venueId }) { if (kind === 'coach') return { channel: STAFF_CHANNEL, reason: 'coach_fixed' }; return { channel: STAFF_CHANNEL, reason: venueId ? 'parent_venue_' + venueId : 'parent_no_venue' };`；lineRouting.js:99 `const STAFF_CHANNEL = process.env.LINE_STAFF_CHANNEL_KEY || 'dreams400';`
- 註：無誤。實際取 token 的地方也確認不看場館：line.js:59-74 的 getToken() 只查 STAFF_CHANNEL。line.js:79-83 的參數註解已改名 venueIdForLog。

**11. 缺 LINE 金鑰（token）時所有推播都會失敗，而且這種失敗算「可重試」：系統不會留下佔位紀錄，下一次還會再試。這是刻意的——順序反過來會留下永遠卡住、之後再也送不出去的紀錄。**

- 誰能做：系統自動
- 依據：server/services/line.js:100-108 `// 先確定拿得到 token 再佔位。順序反過來的話，缺 token 會留下永遠卡在 sending 的紀錄` → `try { token = getToken(); } catch (e) { await pushGate.logSkipped({ ...meta, uid, reason: 'NO_TOKEN:' + e.message }); throw e; }`
- 註：無誤。

**12. 當月 LINE 推播額度用盡（官方帳號回 429「已達每月上限」）時，該則通知直接記失敗、不重試，而且全站暫停嘗試 60 秒。官方帳號每月額度是 3,000 則，全場館共用。**

- 誰能做：系統自動
- 依據：server/services/line.js:146-150 `if (r.status === 429 && r.data?.message === 'You have reached your monthly limit.') { _quotaBlocked = { token, until: Date.now() + 60_000 }; await pushGate.finish({ id, status: 'failed', httpStatus: 429, ..., reason: 'MONTHLY_QUOTA_EXHAUSTED' });`
- 註：無誤。3,000 則的說明見 client/admin/src/pages/SettingsPage.jsx:41 `hint: 'dreams400 全場館共用，每月 3,000 則額度'` 與 checkinNotify.js:91。暫停期間的攔截在 line.js:124-127（進入前先檢查 _quotaBlocked，也記 failed）。

**13. 推播對 LINE 的等待上限是 10 秒。超過就當失敗，不會把觸發它的那個操作（例如簽到、對帳）一起拖住。**

- 誰能做：系統自動
- 依據：server/services/line.js:133-134 `// 沒有 timeout 的話，LINE 慢回應會把呼叫它的那個 HTTP request 一起拖住。` `timeout: 10000,`
- 註：無誤。

**14. 後台系統設定頁只能改四個推播參數：總開關、演練模式、每小時上限、以及「家長簽到→通知教練」。家長端的每一種通知開關都不在白名單裡——也就是說目前沒有任何後台操作可以把家長端通知打開，只能直接改資料庫。**

- 誰能做：沒有人（僅 DB 可改家長端事件開關）
- 依據：server/routes/admin/settings.js:26-27 `'push_enabled', 'push_dry_run', 'push_max_per_hour',` / `'push_event_checkin_confirmed_coach',`；settings.js:52 `if (!ALLOWED_KEYS.includes(k)) continue;`
- 註：無誤，含「靜靜忽略、不報錯」那一點：白名單外的鍵走 continue，之後 res.json 回整包合併結果，呼叫端拿到 200。另：這條路由要 requireAdminAuth + requireResource('settings')（settings.js:48）。

**15. 系統的公開健康檢查端點會回報目前推播閘門的狀態與「哪些事件開著」的清單，但不回任何金鑰。這是用來分辨「沒收到」到底是閘門沒開還是環境沒吃到金鑰。**

- 誰能做：任何人（公開端點）
- 依據：server/index.js:150-152 `const gate = require('./services/pushGate'); const line = require('./services/line'); push = { ...(await gate.describe()), tokens: line.tokenSummary() };`；pushGate.js:121-132 `describe()` 回 `{ enabled, dryRun, maxPerHour, eventsOn }`
- 註：無誤。pushGate.js:118-119 註解明說「事件代號本身不是機密」。同一支 /health 也回 mail_outbox 過去 24 小時各狀態筆數（index.js:131-139）。

**16. 家長自己在 LIFF 上完成簽到後，系統會推播「已完成簽到」給該學員的家長本人，每一筆簽到一則。同一堂共班課有幾個學員簽到，對應的家長就各收一則。**

- 誰能做：家長自己（觸發者）
- 依據：server/services/checkinNotify.js:179-189 `const res = await line.pushMessage(r.parent_uid, line.templates.checkinConfirmed({ studentName: r.student_name, ... }), ch, { event: EVENT_PARENT, refId: 'p:' + r.checkin_id, recipientKind: 'parent' });`；checkinNotify.js:19 `家長：一律通知（他要知道小孩到了、這堂課被計走了）。`
- 註：無誤。收件人是走 students.parent_id 外鍵（loadCheckins 的 `LEFT JOIN parents p ON p.id = s.parent_id`），不是用手機號碼查 —— 見 added 第 2 條。

**17. 簽到通知的內容包含：學員全名、簽到時間（台北時間）、教練姓名、場館名稱，以及一顆「查看上課紀錄」按鈕。按鈕只在有設定家長端 LIFF 網址時才出現。**

- 誰能做：系統自動
- 依據：server/services/line.js:742-758 `function checkinConfirmed({ studentName, coachName, venueName, checkedInAt, liffUrl })` → altText `${studentName} 已完成簽到`、四列內容、`...(liffUrl ? { footer: { ... flexButton('查看上課紀錄', liffUrl, BRAND.teal) } } : {})`；checkinNotify.js:186 `liffUrl: process.env.LIFF_URL_PARENT || process.env.LIFF_URL || ''`
- 註：無誤。教練與場館兩列也是條件顯示（查不到就整列不出現）。內文固定附一句「本堂課已計入上課紀錄。」

**18. 家長自助簽到那支路由，每個到場學員都會各觸發一次「整堂課的通知計算」——共班 3 人就跑 3 輪、每輪都重新掃整堂課的所有簽到列。實際送出的則數靠去重收斂回正確數量，但嘗試次數是人數的平方。**

- 誰能做：家長自己（觸發者）
- 依據：server/routes/checkins.js:279-281 `for (const s of activeParticipants.rows) { // 簽到通知（教練／家長）。fire-and-forget... notifyCheckinSafely(sessionRow.id, null);`（第二個參數 null＝不限學員，loadCheckins 的 studentIds 過濾整段跳過）
- 註：無誤。精確次數是 N×(N+1)：每輪 N 則家長 + 1 則教練。多餘的那些各自會跑一次設定查詢、一次用量查詢，並寫一筆 skipped/DUPLICATE。

**19. 上課前提醒：每小時整點跑一次，抓「未來 60 到 120 分鐘內」的課堂，推給該課期所有在籍學員的家長。教練不收上課提醒。**

- 誰能做：系統自動
- 依據：server/cron/index.js:135-138 `scheduleTaipei('0 * * * *', async () => { ... const start = new Date(Date.now() + 60 * 60 * 1000); const end = new Date(Date.now() + 120 * 60 * 1000);`；cron/index.js:159-162 `// 教練不收上課提醒。Owner 決定教練端只保留「家長簽到」一種通知` → `const targets = ps.rows.map((r) => ({ uid: r.line_uid, role: 'parent' }));`
- 註：無誤。docs/flex_messages.md:16 第 7 項仍寫「學員/家長、教練」。另注意 cron/index.js:133 的程式註解也還寫著「推給教練 + 該堂所有學員之家長」——註解與程式相反。

**20. 上課前提醒的收件人條件：學員必須在該課期的名單中且狀態為在籍（course_period_enrollments.status='active'），且該學員的家長有綁定 LINE 帳號。同一個家長在同一堂課只算一次（DISTINCT）。**

- 誰能做：系統自動
- 依據：server/cron/index.js:153-156 `SELECT DISTINCT p.line_uid FROM course_period_enrollments cpe JOIN students st ON st.id = cpe.student_id JOIN parents p ON p.id = st.parent_id WHERE cpe.course_period_id = $1 AND cpe.status='active' AND p.line_uid IS NOT NULL`
- 註：敘述正確，但「四處逐字相同」要改成「四處語意相同、寫法不同」：cron/index.js:153-156 與 :206-209 用 cpe/st/p 別名寫 `cpe.status='active'`，learn.js:182-186 與 :203-207 用 e/s/pa 別名寫 `e.status = 'active'`，是四份各自維護的複製品而非同一段文字。另外「都沒有檢查 parents.is_active」我獨立確認無誤（四段 SQL 皆無 is_active），與對帳信的 reconcileNotify.js:139 `AND is_active = TRUE` 不同。第五個同語意但判準更鬆的地方見 added 第 4 條。

**21. cron 的提醒用另一張表去重（notification_log），規則是「同一種提醒 + 同一個業務主鍵 + 同一個收件人只送一次」，而且是「先搶發送權、搶到才推」，避免並發雙發。**

- 誰能做：系統自動
- 依據：server/cron/index.js:166-172 `// claim send-right first：插入成功才推播，杜絕並發雙發` → `INSERT INTO notification_log (kind, ref_id, recipient_uid) VALUES ('session_reminder_1h', $1, $2) ON CONFLICT DO NOTHING RETURNING id` → `if (!claim.rowCount) continue;`；server/bootstrap/coreSchema.js:1787 `UNIQUE(kind, ref_id, recipient_uid)`
- 註：機制描述正確，但「四支」是錯的，改成三支：只有上課提醒（cron:167）、到期提醒（cron:214）、MGM 當日提醒（cron:259）三處寫 notification_log。期末評鑑那一支（cron:283-345，含邀請與 7 天提醒）完全沒有用到這張表，它靠 course_evaluations 的 ON CONFLICT 與 reminder_sent_at 欄位自理。全庫 grep notification_log 在 server/ 只有這 3 個 INSERT 與 3 個對應的 DELETE。

**22. 堂數到期提醒：每天早上 09:00 跑，條件是課期狀態為進行中，且到期日剛好等於「今天 + 提醒天數」。提醒天數讀系統設定 expiry_notice_days，沒設就用 60 天。因為是「剛好等於」而不是「小於等於」，某一天 cron 沒跑成功，那一批課期就整批錯過、不會補。**

- 誰能做：後台（admin 可改 expiry_notice_days，該鍵在白名單 admin/settings.js:19）
- 依據：server/cron/index.js:199-202 `WHERE cp.status = 'active' AND cp.expires_at = CURRENT_DATE + ( SELECT COALESCE((SELECT value::INTEGER FROM admin_settings WHERE key='expiry_notice_days'), 60) )`
- 註：無誤。內容欄位確認在 cron/index.js:220-223 `line.templates.expiryReminder({ coachName: cp.coach_name, remainingSessions: cp.remaining, expiresAt: ..., liffUrl: `${LIFF_URL}/my-courses` })`；剩餘堂數是 `(cp.total_sessions - cp.used_sessions)`（cron:196）。

**23. 期末評鑑邀請：每小時第 5 分鐘跑，條件是該課期最後一堂的出席點名發生在最近 25 小時內。試上課（單堂體驗）不發評鑑邀請。已建立邀請的家長不會重複建立，但推播本身沒有去重紀錄——邀請建立成功而推播被擋，家長就再也收不到那一則邀請通知。**

- 誰能做：系統自動
- 依據：server/cron/index.js:300-301 `-- 試上期（單堂體驗）不發期末評鑑邀請（政策 2026-07-16...）` + `AND COALESCE(cp.is_experience_course, FALSE) = FALSE`；:303-306 `AND EXISTS (SELECT 1 FROM checkin_records cr WHERE cr.course_session_id = ls.session_id AND cr.attendance_status = 'ATTENDED' AND cr.checked_in_at >= NOW() - INTERVAL '25 hours')`；:322 `try { await line.pushMessage(uid, msg, row.venue_id); } catch (e) { console.warn('[Cron/eval] push invite failed:', e.message); }`
- 註：無誤。evaluations.js:45 `if (ins.rowCount) created.push(ins.rows[0]);` 確認只有「這一輪新建的」才進推播清單。另外課期狀態條件是 `cp.status IN ('active','completed')`（cron:298），敘述沒提到。還有一處文件與程式不一致：cron:281 的註解寫「最近 24 小時內」，SQL 是 25 小時。

**24. 期末評鑑 7 天提醒：邀請發出超過 7 天、家長還沒填、且還沒提醒過，就推一次提醒並標記為已提醒。家長沒綁 LINE 的情況直接標記為已提醒（等於放棄），不會等他日後綁定。**

- 誰能做：系統自動
- 依據：server/cron/index.js:333 `if (!uid) { await evaluations.markReminderSent(r.id); continue; }`；server/services/evaluations.js:105-107 `WHERE ce.submitted_at IS NULL AND ce.reminder_sent_at IS NULL AND ce.invited_at < NOW() - INTERVAL '7 days'`
- 註：無誤。

**25. 課前規劃發布、授課記錄送出：教練在 LIFF 上發布後，系統推播給該課期所有在籍學員的家長，逐一推送、失敗只記 log、完全沒有去重。教練重複發布一次，家長就再收一則。**

- 誰能做：教練（觸發者）
- 依據：server/routes/learn.js:195-197 `for (const uid of uids) { try { await line.pushMessage(uid, msg, venue_id); } catch (e) { console.warn('[learn] push plan to', uid, e.message); } }`；呼叫端 learn.js:72、:102 皆為 `.catch(...)` fire-and-forget
- 註：無誤。授課記錄通知內容確認只有教練姓名與 月/日（learn.js:217-218 `sessionRecordPublished({ coachName: row.coach_name, sessionDate: dateStr, liffUrl })`，dateStr 由 :215-216 組成），連結到 /history/<periodId>。兩支路由都掛 requireCoach（learn.js:67、:98）。

**26. 課程轉讓申請：家長送出轉讓申請後，系統推播給「轉入方」家長，內容含轉出方家長的完整姓名、課程資訊（教練＋組別）與剩餘堂數。轉入方是用手機號碼查的。**

- 誰能做：家長自己（觸發者）
- 依據：server/routes/transfers.js:39 `const target = await pool.query('SELECT line_uid FROM parents WHERE phone = $1', [to_phone]);`；transfers.js:50-54 `line.templates.transferRequest({ fromParentName: m.from_name, courseInfo, sessionsRemaining: t.sessions_remaining })` → `await line.pushMessage(uid, msg, m.venue_id);`
- 註：無誤。docs/flex_messages.md:23 第 14 項寫「接收對象：場館主管」，程式推的是轉入方家長。補一點：手機格式在 transfers.js:29 先擋成 `/^09\d{8}$/`，但反查是精確字串比對，DB 裡存成帶橫線或 +886 的就查不到人（只會靜靜不推）。

**27. 課程轉讓審核結果：主管在後台核准或駁回後，系統同時推播給轉出方與轉入方兩位家長，內容含結果、課程資訊與主管填的備註。轉入方若還不是會員（查不到）就只推轉出方。**

- 誰能做：後台（主管核准／駁回）
- 依據：server/routes/admin/transfers.js:57-60 `const msg = line.templates.transferReviewed({ approved, courseInfo, note }); for (const uid of [m.from_uid, m.to_uid].filter(Boolean)) { try { await line.pushMessage(uid, msg, m.venue_id); }`（to_uid 來自 :51 `LEFT JOIN parents tp ON tp.id = $2`）
- 註：無誤，沒有去重鍵（主管重按就重送）也確認。

**28. 報名退回補件：櫃檯在後台把報名退回時，系統推播給該筆報名的家長，內容含退回原因、以及「轉帳末 5 碼與匯款證明已清空，請重新填寫」的提示，連結到該筆報名的狀態頁。家長是用報名單上的手機號碼查的（精確字串比對）。**

- 誰能做：後台（櫃檯／主管退回）
- 依據：server/routes/admin/enrollments.js:1819-1822 `const p = await client.query('SELECT line_uid FROM parents WHERE phone = $1 AND line_uid IS NOT NULL LIMIT 1', [row.parent_phone]);`；:1840-1845 `line.pushMessage(notify.uid, line.templates.returnedForFix({ title: '您的報名已退回補件', reason, hint: '原本的轉帳末 5 碼與匯款證明已清空，請重新填寫並上傳。', liffUrl }), notify.venueId)`
- 註：無誤。推播在交易外、best-effort（:1835 `// best-effort 通知家長（交易外；失敗只記 log，不影響已落地的退回結果）`）。

**29. 團購退回補件：櫃檯退回團購時，系統推播給該團「全體」有綁 LINE 的成員家長，內容含退回原因。有清空付款資料時才會加上「部分家庭的付款資料已清空」的提示。**

- 誰能做：後台（櫃檯／主管退回）
- 依據：server/routes/admin/groupOrders.js:670-674 `SELECT p.line_uid FROM group_order_members m JOIN parents p ON p.id = m.parent_id WHERE m.group_order_id = $1 AND p.line_uid IS NOT NULL`；:691-699 `hint: notify.resetCount ? '部分家庭的付款資料已清空，請重新填寫轉帳末 5 碼並上傳證明。' : null` → `for (const uid of notify.uids) { line.pushMessage(uid, msg, notify.venueId)`
- 註：無誤。沒有去重鍵、也不區分哪幾家被清空，都確認。

**30. 團購有人加入：有家庭加入團購時，系統推播通知團主（發起人），內容是「加入者姓名（遮罩）、目前人數／下限／上限、是否已達成團下限」。團主自己加入自己的團不會通知自己。加入者姓名一律遮罩成「王X明」的形式。**

- 誰能做：家長自己（加入者觸發）
- 依據：server/routes/groupOrders.js:876 `if (order.leader_parent_id && order.leader_parent_id !== req.parent.id) {`；:885-890 `line.pushMessage(leaderUid, line.templates.groupMemberJoined({ memberName: maskName(me?.parent_name || ''), total, min: order.min_students, max: order.max_students, reachedMin: total >= order.min_students, liffUrl }), ..., { event: 'group_member_joined', refId: 'j:' + order.id + ':' + req.parent.id, recipientKind: 'parent' })`
- 註：無誤。遮罩規則確認在 server/utils/piiMask.js:24-30（1 字不遮、2 字變「王X」、3 字以上變「王X明」，以 code point 切避免 emoji 被切半）。

**31. 團報送審完成：團報送審後，系統推播通知全團每一個家庭。內容只有總人數、場館、組別與連結，不含任何人的姓名。去重鍵是「這一團 + 這位家長」，所以送審→退回→再送審不會重複打擾（要重送得走退回流程的通知）。**

- 誰能做：家長自己（送審者觸發）
- 依據：server/services/groupOrderSubmit.js:129-138 `await line.pushMessage(row.line_uid, line.templates.groupSubmitted({ total: totalStudentCount, venueName: row.venue_name, courseType: row.course_type ? '1 對 ' + row.course_type : null, liffUrl }), ch, { event: 'group_submitted', refId: 'gs:' + orderId + ':' + row.parent_id, recipientKind: 'parent' });`；收件人條件 :117-118 `WHERE m.group_order_id = $1 AND p.line_uid IS NOT NULL AND p.line_uid <> ''`
- 註：無誤。補一點：這支的連結處理跟 cron/learn 不同——groupOrderSubmit.js:122-123 兩個環境變數都沒設時 liffUrl 是空字串（效果是不顯示按鈕），不會產生死連結。

**32. MGM 獎勵發放：推薦獎勵核發時推播給推薦方家長，內容含折價券代碼、折數與有效期。但只有在推薦紀錄同時存有 LINE 帳號「與」場館代號時才會推——缺場館代號就靜靜不推、只記 log。**

- 誰能做：系統自動（體驗課對帳後）
- 依據：server/services/referrals.js:197 `if (line && r.referrer_line_uid && r.referrer_venue) {`；:203 `await line.pushMessage(r.referrer_line_uid, messages, r.referrer_venue);`（內容 :199-201 `couponDetails: \`折價券代碼 ${code}（9 折，60 天內可用）\``）
- 註：無誤。場館代號自 2026-08-12 起只寫進紀錄（line.js:79-83），卻被當成推播前置條件——這點成立。

**33. cron 與 learn 推播裡按鈕的網址，是用環境變數 LIFF_URL_PARENT（舊版 LIFF_URL 為備援）接上路徑組出來的。兩個都沒設時會退回一個寫死的無效網址（https://liff.line.me/-），按鈕變死連結而不會報錯。**

- 誰能做：沒有人（只能改部署環境變數）
- 依據：server/cron/index.js:25 `const LIFF_URL = process.env.LIFF_URL_PARENT || process.env.LIFF_URL || 'https://liff.line.me/-';`；同樣的三段式 fallback 在 learn.js:193、learn.js:217、admin/enrollments.js:1839、admin/groupOrders.js:690、groupOrders.js:884
- 註：無誤。但「例外只有簽到通知一支」要改成兩支：checkinNotify.js:186 與 groupOrderSubmit.js:122-123 都是退回空字串＝不顯示按鈕。replit.md:53 記錄的自動接路徑（/my-courses、/evaluation/:id、/history/:periodId、/referral）也對上。

**34. 對帳成功通知家長走 Email，不走 LINE。這是刻意分線：家長要的是發票與金額（Email），教練要的是誰來上課（LINE 推播）。**

- 誰能做：後台（櫃檯對帳）
- 依據：server/routes/admin/checkouts.js:454 `// 家長端改走 Email（Owner 決定：家長不用 LINE）。`；server/services/enrollmentNotify.js:4 `* 家長端走 Email（services/reconcileNotify.js），這裡不碰家長。兩條線刻意分開：`
- 註：無誤，行號修正：enrollmentNotify 那句在第 4 行（原寫 5）。

**35. 對帳信的粒度是「一個家庭 × 一張發票」一封，不是一筆訂單一封。兄弟姊妹各一筆但同一張發票，只會寄一封、明細列在信裡的表格。去重鍵是「付款單編號 + 家庭」（新版）或「報名單編號」（舊版單筆入口）。**

- 誰能做：後台（櫃檯對帳）
- 依據：server/routes/admin/checkouts.js:430-432 `const mailId = await enqueueReconcileMail(client, { // 去重鍵：同一張付款單的同一個家庭只會有一封。 refId: \`${req.params.checkoutId}:${invoice.familyKey}\`,`；server/routes/admin/enrollments.js:1397-1398 `const mailOutboxId = await enqueueReconcileMail(client, { refId: String(id),`；coreSchema.js:1840-1842 `CREATE UNIQUE INDEX ... ON mail_outbox(kind, ref_id, recipient) WHERE status <> 'failed';`
- 註：無誤。checkouts.js:426 的迴圈是 `for (const invoice of invoicePlans)` 再 filter 同家庭訂單，粒度描述正確。

**36. 對帳信是「先在對帳交易內排進待寄佇列，交易外才真的寄出」。排隊這一步整段包在還原點（SAVEPOINT）裡，就算佇列表壞掉或欄位對不上，對帳本身照樣完成——不會因為寄不出信而把已經收到錢的對帳整筆退回。**

- 誰能做：系統自動
- 依據：server/services/reconcileNotify.js:153 `await client.query('SAVEPOINT mail_enqueue');`；:198-201 `try { await client.query('ROLLBACK TO SAVEPOINT mail_enqueue'); } catch (_) {...}` + `console.warn('[reconcileNotify] 排信失敗（對帳不受影響）：' + e.message);`；實際寄出在交易外 admin/checkouts.js:457 `await deliverOutbox(mailOutboxIds);`（COMMIT 在 :443）
- 註：無誤，行號微調：SAVEPOINT 那一行是 153（原寫 152-157，該範圍涵蓋整個 try/catch）。連 SAVEPOINT 都下不去時直接 `return null` 放棄排信（:155-157）。

**37. 對帳信的收件人是「用家長手機號碼反查到的 Email」。比對時兩邊都只留數字（去掉空白、橫線、+886），而且只找帳號仍有效、Email 非空的家長；有多筆時取最近更新的那一筆。**

- 誰能做：系統自動
- 依據：server/services/reconcileNotify.js:136-142 `SELECT email FROM parents WHERE regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = $1 AND is_active = TRUE AND COALESCE(btrim(email), '') <> '' ORDER BY updated_at DESC LIMIT 1`
- 註：無誤。檔頭 :128-132 記載的歷史也對上。「推播那邊仍是精確比對且不檢查 is_active」確認（transfers.js:39、admin/enrollments.js:1820）——完整的三套判準見 added 第 2 條。

**38. 查不到家長 Email 時，系統仍然會在待寄佇列留一列、狀態記成「已略過」、原因記 NO_PARENT_EMAIL。不留的話這筆就從帳上消失、沒人知道這位家長其實沒收到通知。實測約 7.5% 的已對帳訂單用電話查不到家長。**

- 誰能做：系統自動
- 依據：server/services/reconcileNotify.js:186-187 `const status = email ? 'pending' : 'skipped'; const reason = email ? null : 'NO_PARENT_EMAIL';`；:184-185 `// 查無 email 也要留一列。不留的話這筆就從帳上消失了... 實測有 7.5% 的已對帳訂單用電話查不到 parent。`
- 註：無誤。

**39. Email 地址是遷移用的暫用值 example@gmail.com 時，信一律不寄出，狀態記成已略過、原因 PLACEHOLDER_RECIPIENT。不可寄出付款或學員資訊到這個地址。家長端個人資料頁看到這個值時會顯示提示，要家長自己去改。**

- 誰能做：家長自己（可在個人資料頁改 Email）
- 依據：server/services/mailer.js:131-133 `if ([original, target].some((address) => String(address).trim().toLowerCase() === 'example@gmail.com')) { return Object.assign(result, { status: 'skipped', reason: 'PLACEHOLDER_RECIPIENT' }); }`；client/liff/src/pages/ProfilePage.jsx:263 `目前信箱為暫用資料，無法接收通知。請更新為您自己的 Email。`
- 註：無誤。「佇列先產生 pending 再被改成 skipped」也對：reconcileNotify.js:136-142 不排除這個地址。另注意檢查對象含改寫後的 target，所以測試收件人設成這個值也會被擋。

**40. 沒設 SMTP 憑證時，對帳信自動進入演練模式：狀態記成 dry_run，不報錯、不擋對帳流程。演練不等於寄成功——佇列與紀錄都嚴格分開這兩種狀態。**

- 誰能做：沒有人（只能改部署環境變數）
- 依據：server/services/mailer.js:135-140 `if (!isConfigured()) { return Object.assign(result, { status: 'dry_run', dryRun: true, reason: 'SMTP_NOT_CONFIGURED' }); } if (c.dryRun) { ... reason: 'MAIL_DRY_RUN' }`；reconcileNotify.js:240 `// dry_run 是「沒寄出」，狀態照實記錄，不可以寫成 sent。`
- 註：無誤。狀態回寫在 reconcileNotify.js:241-248（`sent_at` 只有 status='sent' 才填）。

**41. 環境變數設了測試收件人（MAIL_TEST_RECIPIENT）時，所有對帳信改寄到那個位址，原收件人記在主旨前綴裡。與 LINE 推播的測試收件人是同一個設計。**

- 誰能做：沒有人（只能改部署環境變數）
- 依據：server/services/mailer.js:124-128 `if (c.testRecipient) { target = c.testRecipient; subj = \`[原收件人 ${original}] ${subject}\`; result.to = target; }`
- 註：無誤。

**42. 對帳信內容包含：主旨帶場館短名與發票號碼；信內含家長姓名、場館全名、報名日期時間、教練姓名、費用、期數、發票號碼，多筆時另附「學員／項目／教練／期數／費用」明細表。櫃檯上傳的發票照片會當附件寄出，上限 8MB。**

- 誰能做：系統自動
- 依據：server/services/emailTemplates.js:111 `const subject = \`【家教班報名成功通知】夢想體育-${venueName || '—'}（發票號碼：${invoiceNumber || '—'}）\`;`；emailTemplates.js:148 明細表欄位 `['學員', '項目', '教練', '期數', '費用'].map(...)`（只在 `single` 為 false 時產生，:145）；reconcileNotify.js:34 `const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;`
- 註：無誤。補一點：信內場館用全名，是程式固定組出來的 `夢想體育學院-${venueName}游泳池`（emailTemplates.js:117），主旨刻意維持短名（:115 註解說明是為了手機列表不被截斷）。

**43. 發票照片讀不到、超過 8MB、或讀取出錯時，信照寄、只是少一個附件，並把原因（INVOICE_IMAGE_NOT_FOUND / TOO_LARGE / READ_FAILED）記進該筆的紀錄裡。**

- 誰能做：系統自動
- 依據：server/services/reconcileNotify.js:64-79 `if (!buf) { out.notes.push('INVOICE_IMAGE_NOT_FOUND'); } else if (buf.length > MAX_ATTACHMENT_BYTES) { out.notes.push('INVOICE_IMAGE_TOO_LARGE'); }` + `catch (e) { out.notes.push('INVOICE_IMAGE_READ_FAILED'); console.warn('[reconcileNotify] 讀發票圖失敗（信照寄）：' + e.message); }`
- 註：無誤。原因併進 reason 欄的那一步在 :238-239 `if (att.notes.length) res.reason = [res.reason, att.notes.join(',')].filter(Boolean).join(' | ');`。

**44. 對帳信裡「點擊登入家教系統」那顆按鈕，優先帶家長去他所屬場館的 LINE 官方帳號聊天室、並預先填好觸發關鍵字（預設「新家教系統登入」）；該場館沒有對應官方帳號時（25 個場館目前只有 4 個有）退回原本的 LIFF 連結。按鈕在任何情況下都不會變成死連結。**

- 誰能做：系統自動
- 依據：server/services/reconcileNotify.js:107-109 `const oa = venueOaDeepLink(venueId, OA_LOGIN_KEYWORD); if (oa) return { loginUrl: oa, loginVia: 'oa', loginKeyword: OA_LOGIN_KEYWORD }; return { loginUrl: liffUrl(), loginVia: 'liff', loginKeyword: OA_LOGIN_KEYWORD };`；server/services/lineRouting.js:92-96 `return \`https://line.me/R/oaMessage/${encodeURIComponent(id)}/?${encodeURIComponent(text)}\`;`
- 註：無誤。關鍵字必須與各館 OA 端逐字相同（lineRouting.js:61-63）、oaMessage 只帶入不自動送出（lineRouting.js:86-88，信裡對應說明在 emailTemplates.js:179）、深連結不受跨 provider 障礙影響（lineRouting.js:42-45）都對上。補一點：OA basic ID 格式不合（lineRouting.js:70 的 `OA_ID_RE`）時當作沒設定，退回 LIFF，不會偷偷用內建值（:78 註解）。

**45. 家長沒有任何方式可以關閉或調整通知——沒有偏好設定、沒有退訂連結、沒有分類開關。家長端唯一能「不收」的做法是不綁 LINE、或在 LINE 裡封鎖官方帳號；Email 那邊連退訂機制都沒有。**

- 誰能做：沒有人
- 依據：全庫（server/routes、server/services、server/models、db、client/liff/src、client/admin/src）搜尋 `opt_out|unsubscribe|退訂|關閉通知|notify_enabled|notification_pref` 零命中；家長端個人資料頁的可編輯欄位是 client/liff/src/pages/ProfilePage.jsx:276-312（家長姓名／手機唯讀／館別／性別／Email／住家電話／LINE ID／住家地址）與 :344-363（學員資料），沒有任何通知相關欄位
- 註：敘述正確，證據指向修正：原引的 246-267 是頁首卡片與兩則提示橫幅，真正的欄位清單在 276-312。另外 client/liff/src/pages/ 下 36 個頁面沒有任何通知中心／未讀清單頁，所以連「站內補看」的替代路徑也沒有。

**46. 家長端沒有任何密碼或驗證碼類的通知——這個系統沒有接簡訊／OTP 服務，家長登入一律走 LINE 身分驗證。家長換手機、重新綁定 LINE 帳號（帳號恢復流程）全程不會發出任何通知，既不通知舊帳號也不通知新帳號。**

- 誰能做：後台（admin 角色手動核可帳號恢復，auth.js:806 `requireAdminRole('admin')`）
- 依據：server/routes/auth.js:799-802 `// No OTP provider is configured in this project. Account recovery therefore // uses the approved manual path only: an admin must cite evidence and present // the parent's short-lived, single-use recovery token. ...`；server/services/parentAccountRecovery.js 全檔對 line/mail/notify 零命中（唯一的外送是 :390 `INSERT INTO ragic_sync_outbox`）
- 註：敘述正確，證據指向修正：憑證是由「發放」端點回傳的——auth.js:764 與 auth.js:995 `recovery_token: recovery.recovery_token,`（來源 parentAccountRecovery.js:58 `recovery_token: token,`）；原引的 809-815 是「核銷」端點收下 req.body.recovery_token 的地方。結論不變：憑證只在 API 回應裡、由 admin 當面出示，不經任何通知管道，所以「別人的 LINE 被綁到我的家長帳號」原持有人收不到通知。

**47. 唯一含明文密碼的 LINE 推播是「員工帳號密碼重設」，收件人是員工本人，不是家長。且該員工必須同時有 LINE 帳號與所屬場館才會推。**

- 誰能做：後台（admin 重設員工密碼）
- 依據：server/routes/admin/staff.js:1291 `if (lineUid && staff.venue_id) {`；:1295-1302 `const messages = lineService.templates.adminPasswordReset({ employeeName, employeeId, loginUsername, defaultPassword, loginUrl }); ... await lineService.pushMessage(lineUid, messages, staff.venue_id);`
- 註：無誤。lineUid 取自 `adminUser.line_uid || staff.coach_line_uid`（staff.js:1290），所以教練兼員工時可能推到教練的 LINE。

**48. 簽到通知給教練的內容是學員全名清單，完全不顯示家長姓名；共班跨家庭時不會硬挑一位家長當代表。一堂課只推一則（不是一人一則），因為共班是一次原子寫入整班。**

- 誰能做：家長自己（簽到觸發）
- 依據：server/services/checkinNotify.js:152-153 `// 不再傳 parentName —— 2026-08-11 起樣板主標是學員名單，完全不顯示家長。`；:140 `// refId 用 sessionId 而不是 checkin_id，讓去重索引把「一堂課」收斂成一則。`；:109-110 `const parentLabel = parents.length === 1 ? parents[0] : (parents.length > 1 ? parents.length + ' 位家長' : null);`（保留但未傳給模板）
- 註：無誤（這條是教練端規則，列在這裡作為對照）。「可以只開教練端」確認在 checkinNotify.js:21 與兩個獨立事件代號（:29、:30）。另：歷史上 checked_in_source='coach' 的列不通知教練（:97 的 filter）。

**49. 有兩條 LINE 推播路徑完全不經過安全閥、不受總開關與演練模式約束：IT 告警（教練登入查無時推給 IT 群組）與維運用的樣板煙霧測試腳本。兩者都不是家長端功能，但共用同一支官方帳號金鑰，會吃掉同一份每月額度。**

- 誰能做：系統自動（IT 告警）／維運人員手動執行腳本
- 依據：server/services/itAlert.js:13 `const PUSH_URL = 'https://api.line.me/v2/bot/message/push';` + :20-24 自己讀 LINE_MESSAGING_TOKENS 挑 dreams400（`const preferred = process.env.IT_ALERT_MESSAGING_KEY || 'dreams400';`）；server/scripts/pushTemplateSmoke.js:9-10 `*   - 不經過 pushGate 的事件開關 —— 這是維運人員手動觸發的一次性動作，`，實際送出在 :112 直接 axios.post
- 註：無誤，兩處行號微調：煙霧測試的 uid 格式驗證在 :36-38（原寫 34-37），--apply 預設演練在 :29（原寫 27）。兩者的紀錄行為不同、後果也不同，見 added 第 3 條。

**50. 上課提醒的課堂狀態條件仍然包含已凍結的「等待同組確認」狀態，不只是「已確認」。這個狀態的新資料不會再產生，但舊資料還在。**

- 誰能做：系統自動
- 依據：server/cron/index.js:146 `WHERE cs.status IN ('confirmed','pending_group_confirm')`；對照 cron/index.js:129-130 `// （已移除）1vN 槽位逾時自動確認 cron：團報預約不再產生 pending_group_confirm，// 舊 pending 資料由 bootstrap/coreSchema.js 的冪等遷移一次轉正。`與 CLAUDE.md 凍結令第 1 條
- 註：無誤。註解說舊資料已「一次轉正」，查詢條件卻還留著，看不出是刻意保險還是遺留——標 uncertain 的部分維持。

**51. 通知排程沒有跨執行實例的鎖。系統有一套 cron 單一執行權的租約機制，但目前只有 Ragic 同步在用；家長通知排程完全沒接，靠的是各自的「先搶發送權」去重。**

- 誰能做：系統自動
- 依據：server/cron/lock.js:4-6 描述四層鎖；`grep -rn "cronLock|runWithLock"` 只命中 server/services/ragicAdmin.js:44 `const cronLock = require('../cron/lock');` 與 :4495 `cronLock.runWithLock('ragic_sync', ...)`；server/cron/index.js 的 require 清單（:11-22）完全沒有 cron/lock
- 註：無誤。lock.js:5 提到的旗標層在程式裡也不存在——server/index.js:421 `initCronJobs();` 無條件呼叫，全庫 grep ENABLE_CRON 零命中。docs/ragic_sync_audit.md:144 已記載過同一件事。另外要注意：期末評鑑那一支連「先搶發送權」都沒有（見第 26、27 條修正），所以它是四支裡唯一雙重曝險的。

**52. 推播失敗（非額度用盡的其他錯誤，例如家長封鎖了官方帳號、HTTP 500）會把例外丟給呼叫端。所有家長端呼叫端都接住它、只記 log，絕不影響已經完成的業務動作（簽到、對帳、退回、轉讓都已經寫進資料庫了）。**

- 誰能做：系統自動
- 依據：server/services/line.js:152-155 `throw Object.assign(new Error('LINE push failed: HTTP ' + r.status + ' ' + body.slice(0, 200)), { httpStatus: r.status });` → catch 內先 `await pushGate.finish({ id, status: 'failed', ... })` 再 `throw e;`；呼叫端範例 checkinNotify.js:201-205 `function notifyCheckinSafely(sessionId, studentIds, db) { Promise.resolve().then(...).catch((e) => console.warn('[checkinNotify] 未預期例外：' + e.message)); }`
- 註：無誤。我逐一檢查 22 個呼叫點，家長端全部有 try/catch 或 .catch()。這類失敗不納入去重（索引條件 status <> 'failed'），所以下次同樣觸發還會再試。


#### 判準不一致（16 條）

**1. 上課提醒、到期提醒、MGM 體驗課提醒、期末評鑑邀請與提醒、課前規劃發布、授課記錄發布、課程轉讓、報名／團購退回補件、MGM 獎勵發放——這九類家長通知全部共用同一個事件開關 legacy，不能分開開關。開了 legacy 就是這九類一起開。**

- 誰能做：沒有人（僅 DB 可改）
- 依據：server/services/line.js:85 `const event = opts.event || 'legacy';`；呼叫端只傳三個參數，如 cron/index.js:178 `await line.pushMessage(t.uid, msg, s.venue_id);`、learn.js:196、learn.js:220、transfers.js:54、admin/transfers.js:59、admin/enrollments.js:1840、admin/groupOrders.js:698、referrals.js:203、cron/index.js:225、:269、:322、:339
- 註：無誤。我把全庫 pushMessage 呼叫點列了一遍：共 22 處，其中只有 4 處帶事件代號（checkinNotify.js:149 教練／:179 家長、groupOrderSubmit.js:129、groupOrders.js:885），其餘 18 處全落入 legacy。

**2. 沒有帶業務主鍵的通知完全不去重——只會留紀錄，不會擋重複。任何重試、人工重按、cron 重跑都會讓家長再收到一次。目前家長端只有簽到、團報送審、團購加入這三類帶了業務主鍵。**

- 誰能做：系統自動
- 依據：server/services/pushGate.js:82 註解 `refId 為空時不做去重（仍會記錄），因為沒有業務主鍵可比。`；coreSchema.js:1791-1792 `-- 推播發送紀錄（含被安全閥擋下與失敗的）。notification_log 只記成功、只有 4 種 kind、而且只有 3 個 cron 呼叫點在用；route 層 13 個呼叫點完全不寫，重送就是重複推播。`
- 註：敘述正確，行號修正：那句註解在 pushGate.js:82（原寫 83）。實例也對上：admin/groupOrders.js:697-699 `for (const uid of notify.uids) { line.pushMessage(uid, msg, notify.venueId)` 全團推播、無 refId。

**3. 家長手冊寫「沒收到 LINE 推播 → 確認你已加場館官方帳號為好友且未封鎖」，但實際上所有推播都是從內部帳號 dreams400 發出的，加場館官方帳號好友不會讓家長收到任何通知。**
- 依據：docs/manuals/parent.md:94 `| 沒收到 LINE 推播 | 確認你已加場館官方帳號為好友且未封鎖 |`；對照 server/services/lineRouting.js:112-114（一律回 STAFF_CHANNEL）
- 註：無誤。lineRouting.js:18-24 記載了原因：LIFF 掛在 Login channel 2009958451（provider oshuoshuo），dreams400 同 provider 所以 uid 有效；四館 OA 屬舊系統 dream-dream 的 provider，同一組 uid 實測 0/60。

**4. 後台設定頁上的狀態判讀只看得到「家長簽到→通知教練」這一個事件。即使資料庫裡已經把家長端事件打開了，畫面仍會顯示「總開關已開，但沒有啟用任何事件 —— 仍然不會送出」。**
- 依據：client/admin/src/pages/SettingsPage.jsx:44 `const PUSH_EVENT_KEYS = PUSH_TOGGLES.filter((f) => f.key.startsWith('push_event_')).map((f) => f.key);`（PUSH_TOGGLES 於 :30-37 只含 push_enabled / push_dry_run / push_event_checkin_confirmed_coach）；SettingsPage.jsx:93-95 `const anyEvent = PUSH_EVENT_KEYS.some((k) => draft[k] === '1');` → `if (!anyEvent) return { ... text: '總開關已開，但沒有啟用任何事件 —— 仍然不會送出' };`
- 註：無誤。反向誤判也成立（畫面說不會送，實際家長在收）。

**5. 櫃檯在後台幫家長補簽到（後台「補簽到」與「手動扣課」兩支）不會發任何通知給家長，也不會通知教練。家長手冊寫的簽到流程正是這一條。**

- 誰能做：櫃檯（但不會產生通知）
- 依據：server/routes/admin/sessions.js:625-632 補簽到 `INSERT INTO checkin_records (course_session_id, student_id, checked_in_by_student_id, checked_in_source, checked_in_at) SELECT $1, cpe.student_id, cpe.student_id, 'staff', $2 ...` 之後沒有任何 notify 呼叫；server/routes/admin/manualDeductions.js:427-428 `// ── 2026-08-17：手動扣課不再發推播（owner 決定，選項 B）── // 原本這裡呼叫 notifyCheckinSafely(...)`；對照 docs/manuals/parent.md:63 `- 上課當天到場館 → 跟櫃檯說手機號碼 → 櫃檯在後台幫你完成簽到。`
- 註：無誤，而且我獨立驗過「零呼叫端」：全庫 grep notifyCheckin 只有 routes/checkins.js:281 與 :432 兩個呼叫點，兩支都掛 requireParent（checkins.js:45 `router.post('/self', requireParent, ...)`、:322 `router.post('/', requireParent, ...)`），admin/sessions.js 連 require 都沒有。checkinNotify.js:4 自稱「兩條簽到路徑（家長自助 / 櫃台補登）共用這裡」，與實際不符。

**6. cron 提醒只在「推播丟出例外」時才把發送權釋放、下次重試。被安全閥擋下來（總開關關、事件沒開、演練模式、撞每小時上限、當月額度用盡）不算例外——發送權會被永久燒掉，那一則之後即使閘門打開也永遠不會補送。**

- 誰能做：系統自動
- 依據：server/cron/index.js:177-183 `try { await line.pushMessage(t.uid, msg, s.venue_id); } catch (e) { console.warn(...); // push 失敗 → 釋放 claim 讓下次重試 await pool.query('DELETE FROM notification_log WHERE id = $1', [claim.rows[0].id])`；對照 line.js:96 `return { sent: false, reason: d.reason };`（被擋是回傳值，不是例外）
- 註：無誤。三支的行號：cron:177-183（上課提醒）、:225-229（到期提醒）、:269-273（MGM）。期末評鑑那一支更嚴重的部分也確認：cron:338-340 `try { await line.pushMessage(uid, msg, r.venue_id); await evaluations.markReminderSent(r.id); }` —— 被擋下來不會 throw，所以 markReminderSent 照樣執行，而 evaluations.js:106 的查詢條件是 `AND ce.reminder_sent_at IS NULL`，標了就再也撈不到。

**7. MGM 體驗課當日提醒：每天 09:30 跑，推給「推薦方」家長（不是被推薦的新客戶）。條件是推薦紀錄狀態為體驗課已付款、推薦人有綁 LINE，且該課期今天有課。單輪最多處理 100 筆。**

- 誰能做：系統自動
- 依據：server/cron/index.js:239 `scheduleTaipei('30 9 * * *', ...)`；:242-255 `SELECT rr.id, rr.referrer_parent_id, rp.line_uid AS referrer_uid ... WHERE rr.status = 'trial_paid' AND rp.line_uid IS NOT NULL AND EXISTS (SELECT 1 FROM course_sessions cs2 WHERE cs2.course_period_id = cp.id AND cs2.scheduled_at::date = CURRENT_DATE) LIMIT 100`；:269 `await line.pushMessage(row.referrer_uid, msg, row.venue_id || 'B');`
- 註：無誤。docs/flex_messages.md:27 第 18 項寫「接收對象：被推薦新客戶」，程式推的是推薦方；cron:238 的註解也是推薦方視角。`row.venue_id || 'B'` 硬寫死新北代號一事確認。要補一點：那個「今天有課」判斷的課期是怎麼找出來的有問題，見 added 第 5 條。

**8. 對帳信有「補寄」機制：撿出還卡在待寄狀態、建立超過 5 分鐘的信重新寄出（預設一次 20 封）。但這支函式目前沒有接上任何排程，也沒有任何後台入口在呼叫它——實際上沒有人會去撿那些卡住的信。**

- 誰能做：沒有人（函式存在但無入口）
- 依據：server/services/reconcileNotify.js:260-263 `/** * 補寄：撿出還卡在 pending 的（進程在寄信前掛掉、或當時 SMTP 暫時不通）。 * 可接到 cron，也可以人工呼叫。 */`；:264 `async function sweepPendingMail({ limit = 20, olderThanMinutes = 5 } = {})`——全庫（server/，排除 node_modules）只有這裡的定義、:284 的匯出，以及 admin/checkouts.js:456 的一句註解提到它，零實際呼叫端
- 註：無誤，我獨立跑過 grep 確認零呼叫。健康檢查看得到卡住的信（server/index.js:131-139 回 mail_outbox 過去 24 小時各狀態筆數），只是沒東西去處理。

**9. 家長端 PII 在推播裡的處理不一致：團購加入通知會把加入者的家長姓名遮罩成「王X明」，但課程轉讓通知把轉出方家長的完整姓名直接推給轉入方（兩個是不同家庭的陌生人）。**

- 誰能做：家長自己（觸發者）
- 依據：server/routes/groupOrders.js:886 `memberName: maskName(me?.parent_name || ''),`（規則見 server/utils/piiMask.js:24-30）；對照 server/routes/transfers.js:51 `fromParentName: m.from_name,`（未遮罩，來源 :43 `JOIN parents fp ON fp.id = $1`）
- 註：無誤。同一支 groupOrders.js 對回傳前端的團員清單也遮罩（:217-218、:1094），可見遮罩是該模組既有約定。

**10. 聊天室關鍵字警示推給主管時，訊息上標著「家長：」的那一欄，實際填進去的是家長發言內容的前 60 個字，不是家長姓名；教練欄一律是「—」。也就是家長的聊天內容會原文出現在主管的 LINE 上。**

- 誰能做：系統自動（家長／教練在聊天室發言觸發）
- 依據：server/services/line.js:694-700 `async function pushKeywordAlert(lineUserId, { venueId, keyword, chatRoomId, snippet }) { ... const messages = keywordAlert({ coachName: '—', parentName: snippet ? \`「${snippet}…」\` : '—', keyword, chatUrl });`；模板該欄版面在 line.js:470 `{ type: 'text', text: \`家長：${parentName}\`, size: 'sm' }`；內容來源 server/routes/_chatNotify.js:78 `snippet: (message?.content || '').slice(0, 60),`
- 註：敘述正確，行號修正：模板那一欄是 line.js:470（原寫 471）。收件人規則確認：_chatNotify.js:29-33 註解與 :43-46 `role = 'admin' OR (role = 'manager' AND venue_id = $1)`，staff 不收。docs/flex_messages.md:25 第 16 項只寫「場館主管」，沒提 admin 跨館全收。

**11. 發送紀錄裡的「場館」欄在不同入口記的不是同一種東西：有帶事件代號的四類通知記的是推播管道名稱（dreams400），其餘（cron、learn、轉讓、退回補件等）記的是真正的場館代號。**

- 誰能做：系統自動
- 依據：server/services/checkinNotify.js:188 第三個參數傳 `ch`（來自 :182 `resolveChannel({ kind: 'parent', venueId: r.parent_venue_id })`，值為 'dreams400'）；groupOrderSubmit.js:137、groupOrders.js:889、enrollmentNotify.js:136 同樣傳 channel；對照 cron/index.js:178 `await line.pushMessage(t.uid, msg, s.venue_id);`（傳真場館）
- 註：無誤。line.js:78-83 已把參數改名 venueIdForLog 並註明自 2026-08-12 起只寫紀錄、不決定送到哪裡，所以不影響送達，只影響「這則是哪一館的」這個查詢的可信度。

**12. 對帳信是家長唯一的 Email 通知，也是唯一不依賴 LINE 的通知。全系統只有一個寄信呼叫點、只有一種信件類型；其餘所有家長通知（簽到、上課提醒、到期提醒、退回補件、轉讓、評鑑邀請、團購相關、MGM 獎勵）一律只走 LINE。結論：沒綁 LINE 的家長，除了對帳成功那一封信，什麼通知都收不到，而且系統不會因此留下任何「這位家長沒被通知」的痕跡（NO_RECIPIENT_UID 只有在 SQL 沒先把他過濾掉時才寫得出來——四支提醒的 SQL 都先用 p.line_uid IS NOT NULL 濾掉了）。** 〔覆核時補上〕
- 依據：server/services/reconcileNotify.js:85 `const KIND = 'reconcile_success';`（mail_outbox 唯一 kind）；全庫 grep `mailer.sendMail` 只有 reconcileNotify.js:231 一處；對照 cron/index.js:156、:209 與 learn.js:186、:207 的 `AND p.line_uid IS NOT NULL`（在 SQL 就排除，不會進 pushGate 留紀錄）

**13. 「用手機號碼找家長」在系統裡有三套判準，不是兩套。（1）對帳信：正規化成純數字比對，且要求帳號有效、Email 非空，多筆取最近更新。（2）轉讓與退回補件推播：精確字串比對，不檢查帳號是否有效。（3）簽到、上課提醒、到期提醒、課前規劃、授課記錄、評鑑邀請：完全不用手機，走學員的家長外鍵（students.parent_id）。同一位家長在不同通知裡是用三種不同方式被認出來的，所以「A 通知收到了、B 通知沒收到」是可能的常態，而不是異常。** 〔覆核時補上〕
- 依據：（1）server/services/reconcileNotify.js:136-142 `regexp_replace(COALESCE(phone, ''), '\D', '', 'g') = $1 AND is_active = TRUE`；（2）server/routes/transfers.js:39 `SELECT line_uid FROM parents WHERE phone = $1` 與 server/routes/admin/enrollments.js:1820 `WHERE phone = $1 AND line_uid IS NOT NULL LIMIT 1`；（3）server/services/checkinNotify.js:70 `LEFT JOIN parents p ON p.id = s.parent_id` 與 cron/index.js:154-155 `JOIN students st ON st.id = cpe.student_id JOIN parents p ON p.id = st.parent_id`

**14. 維運人員跑一次樣板煙霧測試，會吃掉家長推播當小時的配額。煙霧測試把每一則都以「已送出」寫進發送紀錄，而閘門的每小時上限算的是「全站已送出的總筆數、不分事件」——19 個模板的一輪測試就佔掉預設 50 則裡的 19 則。相對地 IT 告警完全不寫發送紀錄，所以不佔每小時配額，但一樣吃當月的 3,000 則額度。也就是說這兩條繞過閘門的路徑，對家長通知的干擾方式剛好相反。** 〔覆核時補上〕
- 依據：server/scripts/pushTemplateSmoke.js:116 `if (r.status >= 200 && r.status < 300) { status = 'sent'; ...}` → :125-128 `INSERT INTO line_push_log (...) VALUES ('template_smoke',$1,$2,'test',$3,$4,...)`；對照 server/services/pushGate.js:66-67 `SELECT COUNT(*)::int n FROM line_push_log WHERE status = 'sent' AND at >= NOW() - INTERVAL '1 hour'`（無 event 條件）；server/services/itAlert.js 全檔 grep line_push_log 零命中

**15. 期末評鑑邀請的收件人判準比其他提醒鬆一道：建立邀請時只看學員是否在籍，不要求家長有綁 LINE。沒綁 LINE 的家長照樣會被建立一筆邀請紀錄，然後在推播那一步被靜靜跳過。結果是評鑑表會累積一批「已邀請、永遠沒被通知、也永遠不會被填」的列，而且這些列不會被 7 天提醒撈出來補救（因為它們同樣沒有 uid，一撈到就直接標記為已提醒）。** 〔覆核時補上〕
- 依據：server/services/evaluations.js:29-31 `ARRAY(SELECT DISTINCT s.parent_id FROM course_period_enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_period_id = cp.id AND e.status = 'active') AS parent_ids`（無 line_uid 條件）；server/cron/index.js:317 `if (!uid) continue;`；對照 cron/index.js:156 其他提醒在 SQL 就 `AND p.line_uid IS NOT NULL`；放棄機制 cron/index.js:333 `if (!uid) { await evaluations.markReminderSent(r.id); continue; }`

**16. MGM 體驗課當日提醒的「今天有課」是用錯的課期判斷的。程式不是找被推薦人自己那一期，而是用「同一位教練 + 同一個場館」去撈課期——只要該教練在該館的任何一個課期今天有課，提醒就會發出去。同一教練在同一館開多期（常態）時，推薦方會在不是體驗課的日子收到「今天體驗課」的提醒。** 〔覆核時補上〕
- 依據：server/cron/index.js:249-250 `LEFT JOIN admin_enrollments ae ON ae.id = rr.experience_enrollment_id LEFT JOIN course_periods cp ON cp.coach_id = rr.coach_id AND cp.venue_id = ae.venue_id`；:251-255 `AND EXISTS (SELECT 1 FROM course_sessions cs2 WHERE cs2.course_period_id = cp.id AND cs2.scheduled_at::date = CURRENT_DATE)`（cp 是上面那個寬鬆 join 的結果，不是 rr.experience_enrollment_id 對應的課期）


#### 只在文件裡（程式沒有／不同）（2 條）

**1. 文件 docs/flex_messages.md 列出 18 種通知，其中 7 種的模板在程式裡沒有任何呼叫端，家長永遠不會收到：報名成功（第1項）、課程開通（第2項）、1v1 選槽成功（第3項）、1vN 同組確認邀請／確認成功／拒絕（第4-6項）、學員自助取消給教練（第8項）。另外 line.js 裡還有一支「發票開立」模板（invoiceIssued）連文件都沒列、也沒有呼叫端。**

- 誰能做：沒有人
- 依據：docs/flex_messages.md:10-17 列出第 1-8 項；我逐一跑 `grep -rn "templates\.<name>" server/routes server/services server/cron server/scripts` 對 enrollmentSuccess / courseActivated / slotBooked / groupConfirmInvite / groupConfirmSuccess / groupConfirmReject / selfCancelToCoach / invoiceIssued / keywordAlert 全部 0 命中（模板定義在 line.js:187、211、234、253、306、571、460）
- 註：無誤。1vN 同組確認三項被凍結令明文禁止復活（CLAUDE.md 凍結範圍第 1 條）。選槽成功（第 3 項）確實沒有取代方案——我 grep 過 server/routes/slots.js，pushMessage 與 line. 共 0 命中，但 docs/manuals/parent.md:60 仍寫「點選 → 確認 → 預約完成（會收到 LINE 推播提醒）」。keywordAlert 有呼叫端但走 line.js:694 的高階函式。

**2. 文件寫「每次發送都記錄在 notification_logs 供診斷追蹤」，但那張表（db/migrations 建的舊表）從來沒有接線。實際在用的是兩張不同的表：cron 用的 notification_log（只記成功、四種類型），與安全閥寫的 line_push_log（每一則的每一種結局都記）。**
- 依據：docs/flex_messages.md:33 `4. 在 \`notification_logs\` 記錄每次發送（供診斷追蹤）`；replit.md:240 `注意：\`notification_logs\` 表仍未接線，屬 backlog。`；實際兩張表在 server/bootstrap/coreSchema.js:1781（notification_log）與 :1794（line_push_log），舊表在 db/migrations/001_initial_schema.sql:64
- 註：敘述正確，一個數字要修：notification_log 實際只有三種 kind 在用（session_reminder_1h、expiry_reminder、mgm_trial_today），coreSchema.js:1791 的註解自己寫「4 種 kind」也是舊的。交接重點不變：查「通知有沒有送出去」要查 line_push_log。


### 3.8 Ragic 同步（家長側）


#### 實作中（67 條）

**1. 名單與身分以 Ragic 為權威，系統裡的家長／學員只是「可靠鏡像」；課程、堂數、簽到這些活動紀錄一律只看本地，與 Ragic 同步無關。**

- 誰能做：系統自動（架構前提，無人可單次改變）
- 依據：server/services/parentSync.js:8 `名單/身分以 Ragic 為權威；本地 parents/students 為可靠鏡像。`；server/routes/parents.js:440 `活動紀錄（課程/堂數/簽到）一律讀本地，與本同步無關。`
- 註：敘述正確。原清單引 parentSync.js:11-13 / parents.js:438，實際在 8 / 440。**全份清單的行號普遍有 1～34 行的位移**（ragicAdmin.js 位移最大，例如原引 2525 實際 2556、原引 2475 實際 2509），推測是覆核者讀的快照略舊；我逐條重新定位過，本表的行號是現在工作樹的實際位置。

**2. Z01 是 Ragic 的家長主檔（底下掛一張學員子表，子表 ID 1001119）；Z02 是學員主檔；Z03 不是 Ragic 的表單，而是本系統裡的一張「尚未綁定 LINE 的 Ragic 家長待整理佇列」（ragic_z03_records）。系統不會把任何東西推去 Ragic 的 Z03。**

- 誰能做：系統自動
- 依據：server/config/ragicSchema.js:36-37 `get Z01() { return process.env.RAGIC_FORM_Z01; }, // 家長主檔（+ 學員子表格）` / `get Z02() ... // 學員主檔`；ragicSchema.js:141 `const Z01_STUDENTS_SUBTABLE_ID = '1001119';`；server/services/ragicAdmin.js:4305-4307 `決策(P1.1 #10，2026-07-07 定案，won't-do)：Ragic 端 Z01→Z03 表單 push 不做。`
- 註：正確。程式裡仍有多處把 Z03 說成「Ragic 端另行建置中的表單」（ragicAdmin.js:4212、4485 附近的 TODO(Z03)、replit.md:220 的「卡住待續」），是同一個已放棄的計畫留下的措辭。

**3. 家長的 LINE 身分憑證只認 Z01 的數字欄位 1006846「家教系統uid」一個來源；就算 Ragic 回傳的資料裡同時有中文欄名「家教系統uid」，也一律不採用。**

- 誰能做：系統自動（欄位定義寫死在 ragicSchema.js，改動需改程式）
- 依據：server/config/ragicSchema.js:71-73 `function getTrueRagicLineUid(record) { return normalizeLineUid(record?.[RAGIC_Z01_FIELDS.PARENT_SYSTEM_LINE_UID]); }`；ragicSchema.js:49-52 `const LINE_UID_FIELD = { Z01: '1006846', H01: '1003633' };`
- 註：規則正確，但**原清單的註解是錯的**：Z01 這個欄位並沒有 env 覆寫。ragicSchema.js:49-52 兩個欄位都是字面常數，全 server/ 目錄 grep `RAGIC_FIELD_Z01_LINE_UID` 零命中。檔內第 42-43 行自己寫「禁止 env 覆寫」，第 47 行卻寫「Z01 仍保留 env 覆寫」——第 47 行是過期敘述（另見我補的 doc_only 條）。

**4. Ragic Z01 只收「已經綁好 LINE 的會員」。沒綁 LINE 的家長（櫃檯手建、歷史殘留）與 demo / DEMOTEST 測試帳號，一律不推上 Ragic。**

- 誰能做：系統自動
- 依據：server/services/ragicWriteback.js:49-52 `if (!row.line_uid || String(row.line_uid).startsWith('demo:') || String(row.line_uid).startsWith('DEMOTEST_')) { console.warn('[ragic-writeback] parent 未綁 LINE UID（或 demo 帳號），略過回寫（Z01 不收未綁/測試資料）'); return null; }`；每日備份同政策 server/services/ragicAdmin.js:2304-2306 `WHERE is_active = TRUE AND line_uid IS NOT NULL AND line_uid <> '' AND line_uid NOT LIKE 'demo:%' AND line_uid NOT LIKE 'DEMOTEST_%'`
- 註：正確。家長沒綁 UID 時連名下學員也不回寫（ragicWriteback.js:93-98、ragicAdmin.js:2341-2343），理由如原註所述。

**5. 已停用的家長或學員不回寫 Ragic。停用、移除、轉出一律由櫃檯直接在 Ragic 端處理；家長端「刪除學員」的路徑保留但一律回「請洽櫃臺」。**

- 誰能做：櫃檯（在 Ragic 端）；家長不行；系統不會代寫
- 依據：server/services/ragicWriteback.js:42-45 `if (row.is_active === false) { console.warn('[ragic-writeback] parent 已停用，略過回寫（移除由櫃台在 Ragic 端處理）'); return null; }`；server/routes/parents.js:749-753 `router.delete('/me/students/:id', requireParent, (req, res) => { res.status(405).json({ error: '學員資料異動（停用 / 移除 / 轉出）請洽櫃臺…', code: 'STUDENT_REMOVAL_VIA_COUNTER' })`
- 註：正確。原因寫在 server/config/ragicSchema.js:158-160（原清單引 151-155）：Z02「學員身分」是身分類別欄，不可當停用狀態欄。

**6. 每晚從 Ragic 拉回時，一筆 Z01 要進「本地家長鏡像」還是進「Z03 待整理佇列」，唯一判準就是 1006846 這個欄位有沒有值。姓名齊不齊、電話對不對、有沒有 LINE 對話網址，都不參與這個判斷。**

- 誰能做：系統自動（每晚 02:30；後台「Ragic 狀態」頁可手動觸發 pull）
- 依據：server/services/ragicAdmin.js:3190-3200 `// Sole split rule: only the exact frozen LINE UID field participates.` / `const trueLineUid = _trueZ01LineUid(z01Row); … if (!trueLineUid) { await _upsertZ03Record(client, ragicRecordId, mapped, z01Row); await client.query('COMMIT'); stagedZ03++; continue; }`
- 註：正確。舊版三條件分流＋破壞性清掃保留供比對但第一行就 throw：ragicAdmin.js:3289-3290 `_reconcileZ01FromShadowLegacyDisabled` → `DESTRUCTIVE_RECONCILE_DISABLED`。

**7. 已經有 LINE UID 的 Z01 記錄，程式層面禁止被寫進 Z03 佇列（會直接報錯 Z03_TRUE_LINE_UID_PRESENT）。**

- 誰能做：系統自動（硬性守門，所有入口共用同一個 _upsertZ03Record）
- 依據：server/services/ragicAdmin.js:2441-2445 `if (_trueZ01LineUid(z01Row)) { const err = new Error('真正 LINE UID 已存在的 Z01 record 不得進入 Z03'); err.code = 'Z03_TRUE_LINE_UID_PRESENT'; throw err; }`

**8. 進 Z03 的那一筆，如果電話不是合法的台灣手機號（09 開頭共 10 碼），直接標成「待人工處理（manual_review）」而不是「待處理（pending）」，並自動開一張後台任務；理由碼 INVALID_CANONICAL_PHONE。系統不會替它自動配對或另開一個家庭。**

- 誰能做：系統自動判定；後續要靠櫃檯／管理員在 Ragic 改對電話
- 依據：server/services/ragicAdmin.js:2463-2467 `const validMobile = isCanonicalMobilePhone(phoneCanonical); const initialStatus = tomb.rowCount || !validMobile ? 'manual_review' : 'pending';`；ragicAdmin.js:2579-2587 `if (!validMobile) { await createParentIdentityBackofficeTask({ … reasonCode: 'INVALID_CANONICAL_PHONE', suggestedAction: 'Correct the misplaced Ragic mobile field after source review; do not auto-link or create a duplicate family.' }) }`；判準本體 server/services/identityNormalizer.js:28-30 `/^09\d{8}$/.test(normalizePhone(value))`

**9. Z03 的狀態一旦離開「待處理」就不會被排程翻回去：已 resolved 的永遠 resolved；已 manual_review 或已被人工 dismissed 的，往後每輪拉回都只會落在 manual_review。**

- 誰能做：系統自動；狀態的初始判定由排程給，人工可用後台動作改
- 依據：server/services/ragicAdmin.js:2487-2491 `status = CASE WHEN ragic_z03_records.status = 'resolved' THEN 'resolved' WHEN ragic_z03_records.status IN ('manual_review','dismissed') THEN 'manual_review' ELSE EXCLUDED.status END`
- 註：同一個 ON CONFLICT 對 classification（2492-2496）與 reason_code（2497-2502）套同一條保護。

**10. Z03 的強制刪除會留下墓碑（tombstone）。之後每次拉回都先查墓碑，命中就整筆跳過，Ragic 那邊的原始 Z01 完全不動。只有管理員（admin）能做這個動作。**

- 誰能做：管理員（admin）；櫃檯不行
- 依據：server/services/ragicAdmin.js:4164-4172 `INSERT INTO ragic_z03_deleted_tombstones (z01_ragic_record_id, deleted_by, reason) … cleanReason ? 'ADMIN_HARD_DELETE:'+cleanReason : 'ADMIN_HARD_DELETE'`；跳過端 ragicAdmin.js:2457-2458 `const hardDeleted = String(tomb.rows[0]?.reason || '').startsWith('ADMIN_HARD_DELETE'); if (hardDeleted) return { skipped: true, reason: 'ADMIN_HARD_DELETE' };`；server/routes/admin/ragicZ03.js:97 `router.delete('/:id', requireAdminRole('admin'), …)`
- 註：正確。歷史遺留的舊墓碑走另一條路（ragicAdmin.js:2464-2467）：不跳過，改標 manual_review + LEGACY_TOMBSTONE_RETAINED。

**11. Z01 學員子表的每一列進 Z03 時都會被分類並標上原因：整列全空＝範本空列、沒名字＝STUDENT_NAME_MISSING、同一家同名重複＝DUPLICATE_CANDIDATE、缺生日或生日格式無效＝INVALID_ROW。分類只是標記，不會擋掉整筆家長。**

- 誰能做：系統自動
- 依據：server/services/ragicAdmin.js:2537-2554 `if (!anyContent) { classification='EMPTY_TEMPLATE_ROW'; studentReason='EMPTY_TEMPLATE_ROW'; } else if (!normalizedName) { classification='INVALID_ROW'; studentReason='STUDENT_NAME_MISSING'; } else if ((normalizedCounts.get(normalizedName)||0) > 1) { classification='DUPLICATE_CANDIDATE'; … } else if (!String(s.birth_date_raw||'').trim()) { … 'STUDENT_BIRTH_DATE_MISSING' } else if (!_sourceUpdatedTime(...).iso) { … 'STUDENT_BIRTH_DATE_INVALID' }`
- 註：敘述正確；嚴格說「分類」與「原因碼」是兩欄，原清單把兩者混著寫（例如沒名字的 classification 是 INVALID_ROW、reason_code 才是 STUDENT_NAME_MISSING）。

**12. 櫃檯在 Z03 頁面刪掉某一列學員，也會留該列的墓碑，往後拉回不會再長回來。**

- 誰能做：有 ragic-z03 權限的後台使用者（server/routes/admin/ragicZ03.js:26 `router.use(requireResource('ragic-z03'))`，這條走 PATCH /:id/draft，不需 admin 角色）
- 依據：server/services/ragicAdmin.js:4067-4074 `INSERT INTO ragic_z03_deleted_student_tombstones (z01_ragic_record_id, source_row_key, deleted_by, reason) VALUES ($1,$2,$3,'ADMIN_STUDENT_CLEAN_DELETE')`；讀取端 ragicAdmin.js:2556 `if (deletedStudentKeys.has(sourceRowKey)) continue;`

**13. 註冊熱路徑（家長填完電話要比對舊資料）只查本地：先比本地 Z01 鏡像，沒有才查本地 Z03 佇列，兩處都不會在使用者等待時去打 Ragic。只有本地 Z03 還沒被排程拉入、但 Ragic 查得到時，才會即時把那筆讀進 Z03（純讀入，不回寫 Ragic）。**

- 誰能做：家長自己（觸發）；系統自動執行
- 依據：server/services/ragicAdmin.js:3634-3635 `資料流向定案（2026-07-03）：填完電話 → 比對本地 Z01 → 沒資料才來 Z03 核對，兩處都不在熱路徑打 Ragic。`；ragicAdmin.js:3675-3686 `這是 read-only hydrate；真正回寫 Ragic 只發生在家長完成註冊驗證後。` / `async function hydrateZ03RecordFromRagicRow(z01Row) { … await _upsertZ03Record(client, ragicRecordId, mapped, z01Row);`

**14. 同一支手機在 Z03 佇列命中多筆家庭時，註冊／綁定流程不會猜任一筆，直接丟 MANUAL_REVIEW_REQUIRED（理由 AMBIGUOUS_Z03_FAMILY）並把所有命中的 Z03 編號記下來。**

- 誰能做：沒有人自動解；需後台人工處理
- 依據：server/services/ragicAdmin.js:3654-3659 `if (r.rowCount > 1) { const err = new Error('同一 canonical phone 命中多筆 active Z03 family，禁止 LIMIT 1'); err.code='MANUAL_REVIEW_REQUIRED'; err.reason='AMBIGUOUS_Z03_FAMILY'; err.z03Ids = r.rows.map((row) => row.id); throw err; }`
- 註：查詢條件只收 status='pending' 或 (manual_review 且 reason_code='AMBIGUOUS_STUDENT_MATCH')（ragicAdmin.js:3646-3647），其餘 manual_review／resolved 不攔熱路徑。

**15. 家長端「註冊／認領」流程能寫回 Ragic Z01 的欄位只有七個：家長姓名、Email、行動電話、住家電話、住家地址、LINE ID、家教系統uid。不在白名單的欄位（例如館別、身分、性別）就算資料裡有也會被丟掉。**

- 誰能做：家長自己（透過註冊／認領流程）
- 依據：server/services/parentRegistrationProfile.js:10-18 `const PROFILE_PATCH_ALLOWLIST = Object.freeze(new Set([ …PARENT_NAME, EMAIL, PHONE, HOME_PHONE, HOME_ADDRESS, LINE_ID, LINE_UID ]));`；過濾點 parentRegistrationProfile.js:124-131 `function sanitizeAllowlistedProfilePatch(value) { … if (!PROFILE_PATCH_ALLOWLIST.has(String(fieldId))) continue;`
- 註：白名單只管這一條路。同一位家長改個資／櫃檯改檔／每日備份走的是另一條，會整組覆蓋九欄＋強制補 UID（見 inconsistent 那條）。

**16. 註冊／認領寫回 Ragic 時的原則是「只填空白」：Ragic 該欄原本有值就不動。唯一例外是聯絡類欄位（Email／手機／住家電話／地址／LINE ID）在「已完成本人驗證」時可以覆蓋。家長姓名不算聯絡欄位，所以 Ragic 上已有姓名時永遠不會被家長改掉。**

- 誰能做：家長自己（覆蓋聯絡欄位需通過本人驗證 ownershipVerified）
- 依據：server/services/parentRegistrationProfile.js:41-48 `if (!newText || oldText === newText) return null; if (oldText && !(contact && ownershipVerified)) return null; … change_reason: oldText ? 'VERIFIED_CONTACT_UPDATE' : 'FILL_BLANK'`；姓名未帶 contact：parentRegistrationProfile.js:71-76
- 註：原清單的註解要修正一處：稽核**不是**每一次欄位變更都落一筆——LINE UID 的變更被明確排除（parentRegistrationProfile.js:144 `if (String(change.field_id) === String(ragic.FIELD.Z01.LINE_UID)) continue;`，理由是 UID 已有 identity_claim_events + outbox 稽核）。其餘欄位只存雜湊（parentRegistrationProfile.js:145-153 `old_value_hash, new_value_hash`）。

**17. Ragic 上那筆 Z01 的 1006846 已經是別人的 LINE UID 時，註冊／認領的寫回直接拒絕並要求走帳號恢復流程，絕不覆蓋。**

- 誰能做：沒有人（只有帳號恢復流程經人工驗證後可改綁）
- 依據：server/services/parentRegistrationProfile.js:105-111 `const currentUid = _text(sourceProfile.line_uid, 200); … if (currentUid && nextUid && currentUid !== nextUid) { const err = new Error('Ragic source field 1006846 is already bound to another account'); err.code='ACCOUNT_RECOVERY_REQUIRED'; throw err; }`；同義守門 server/services/ragic.js:791-798 `_assertNoZ01LineUidConflict`
- 註：這道門在寫入層是齊的（ragic.js:1227、1233、1461、1496 都呼叫 _assertNoZ01LineUidConflict）。但 outbox 的 REBIND 工作是刻意要覆蓋的，而它在夜間批次下**不做**寫前檢查——見下方 inconsistent 的 readback 那條。

**18. Ragic 端的「學員編號」（1001132）由 Ragic 自己用公式產生。系統不會替新學員生成編號；Z01 學員子表永遠不寫這一欄，Z02 主檔則是「本地已經有編號才原樣送回、空值不送」。**

- 誰能做：Ragic 自動產生；系統只會把本地已有的同一個值送回去
- 依據：Z01 子表不寫：server/services/ragic.js:1249 `// 1001132 is calculated by Ragic's source-sheet formula; never overwrite it.`（buildZ01StudentPayload 內）；Z02 條件式送回：ragic.js:1371 `...(String(student.student_code || '').trim() ? { [FIELD.Z02.STUDENT_CODE]: student.student_code } : {}),`（buildZ02StudentPayload，上方註解 `學員編號由 Ragic 產生；本地已有編號才傳送，空值不覆寫`）
- 註：原敘述「系統一律不寫」過度概括——Z02 主檔確實會送這一欄。實務差別：若本地的 student_code 是舊值或已被 Ragic 改過，編輯學員時會用本地值蓋回 Ragic。

**19. Ragic 端的「學員身分」（1002178）只在第一次建立學員時寫一次「01.一般生」，之後任何編輯都不碰這個欄位——它是身分類別欄，不是啟用／停用狀態欄。**

- 誰能做：系統自動（只在建立時）
- 依據：server/services/ragic.js:1439-1443 `// 只有 Ragic 端尚無此學員時才算「首次建立」→ 設一次身分類別「01.一般生」；既有紀錄一律不碰「學員身分」欄` / `if (!z02Record) return (await createStudentZ01Z02Strict({ parent, student })).z02; const setIdentity = false;`；payload 端 ragic.js buildZ02StudentPayload `if (setIdentity) payload[FIELD.Z02.STUDENT_STATUS] = '01.一般生';`；欄位警語 server/config/ragicSchema.js:158-160

**20. 寫回 Ragic 的「館別」必須送場館名稱而不是本地代碼；送代碼 Ragic 不認得，會當成空值讓整筆變成「館別為必填」而失敗。**

- 誰能做：系統自動
- 依據：server/services/ragic.js:22-27 `Ragic 的「館別」欄位（Z01 1002174 / Z02 1002175）存的是場館「名稱」… 若把代碼原樣寫進 Ragic，Ragic 不認得 → 視為空值 → 整筆 status:INVALID「欄位 館別 為必填」`；轉換點 server/services/ragicWriteback.js:53 `const venueName = await ragic.venueLabel(row.primary_venue_id);`（每日備份 ragicAdmin.js:2215 同）
- 註：新建家長時若本地沒有館別，送的是字面「待補登」（ragic.js:1009、1183）。

**21. 寫回 Ragic 的 outbox worker 只認三種家長工作：新建 Z01 家長（CREATE_Z01_PARENT）、把 LINE UID 綁到既有 Z01（BIND_Z01_LINE_UID）、帳號恢復後改綁 LINE UID（REBIND_Z01_LINE_UID）。其他操作直接被 worker 拒絕。**

- 誰能做：系統自動（由註冊／認領／帳號恢復流程排入）
- 依據：server/services/ragicSyncOutbox.js:512-516 `if (!['BIND_Z01_LINE_UID','REBIND_Z01_LINE_UID','CREATE_Z01_PARENT'].includes(job.operation)) { const err = new Error('unsupported outbox operation'); err.code='RAGIC_OUTBOX_OPERATION_UNSUPPORTED'; throw err; }`
- 註：這是「outbox 這條路」的完整清單，不等於「家長資料寫回 Ragic 的完整清單」——writeback／每日備份／編輯學員都不經 outbox（見我補的 added 條）。

**22. parent outbox 的狀態機：pending（剛排入）→ processing（被領走）→ synced（成功）／retryable（暫時性錯誤，等下輪）／blocked_retry_exhausted（重試次數用完）／blocked_schema（Ragic 欄位或驗證問題）／blocked_data_conflict（資料衝突）。判準是：逾時、429、5xx、連線層錯誤＝可重試；400／422 或 schema 類錯誤碼＝schema 卡住；其餘＝資料衝突。**

- 誰能做：系統自動
- 依據：server/services/ragicSyncOutbox.js:42-52 `const retryable = RETRYABLE_CODES.has(code) || httpStatus === 429 || httpStatus >= 500; if (retryable && attempts < maxAttempts) return { outboxState:'retryable' … } if (retryable) return { outboxState:'blocked_retry_exhausted' … } if (SCHEMA_CODES.has(code) || httpStatus===400 || httpStatus===422) return { outboxState:'blocked_schema' … } return { outboxState:'blocked_data_conflict' … }`

**23. 每一筆最多重試 8 次；退避時間是 30 秒起、每次翻倍、上限 1 小時。被領走後若 15 分鐘沒有結果（worker 掛掉）會被下一輪回收重領，但不會因此多打一次 Ragic——超過重試預算就直接判 RAGIC_RETRY_EXHAUSTED。**

- 誰能做：系統自動
- 依據：server/bootstrap/coreSchema.js:1425 `max_attempts INTEGER NOT NULL DEFAULT 8,`；server/services/ragicSyncOutbox.js:402 `const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, Number(job.attempts) - 1)));`；回收條件 ragicSyncOutbox.js:70 `state = 'processing' AND updated_at < NOW() - INTERVAL '15 minutes'`；ragicSyncOutbox.js:509-511 `if (Number(job.attempts) > Number(job.max_attempts)) throw Object.assign(new Error('Outbox retry budget exhausted'), { code: 'RAGIC_RETRY_EXHAUSTED' });`
- 註：原註解正確：worker 一天只跑一輪，30 秒起算的退避實務上幾乎無意義。

**24. 寫回 Ragic 的 worker 一天只跑一次，時間是台北 00:10，排在 00:30 的全量備份之前；一次把佇列排空，最多 60 輪 × 20 筆 ＝ 1200 筆。代價是：家長註冊完，Ragic 上要等到當晚才看得到，櫃檯當天在 Ragic 查不到新戶。**

- 誰能做：系統自動（排程）
- 依據：server/cron/index.js:88-97 `scheduleTaipei('10 0 * * *', async () => { if (!ragicAdmin.ragicEnabled() || !process.env.RAGIC_FORM_Z01 || !STABILITY_FLAGS.RAGIC_PARENT_OUTBOX) return; … for (let round = 0; round < 60; round += 1) { r = await processRagicSyncOutbox({ limit: 20 });`；代價明說在 cron/index.js:85-87
- 註：補一點：後台「Ragic 狀態」頁**無法**手動觸發這一支。JOB_RUNNERS 只有 staff / venues / parents / students / backup / pull / quarantine（server/routes/admin/ragicStatus.js:34-42），全 server/routes/ 目錄也沒有任何地方呼叫 processRagicSyncOutbox。

**25. 這支寫回 Ragic 的 worker 由開關 RAGIC_PARENT_OUTBOX 控制，程式預設「關」。關著的時候註冊照樣成功（本地先寫），佇列只會一直累積、UID 不會由這條路回到 Ragic。**

- 誰能做：部署環境設 RAGIC_PARENT_OUTBOX=1（不改程式）
- 依據：server/config/ragicSchema.js:96 `get RAGIC_PARENT_OUTBOX() { return envFlag('RAGIC_PARENT_OUTBOX', false); }`；server/services/ragicSyncOutbox.js:691-693 `if (!STABILITY_FLAGS.RAGIC_PARENT_OUTBOX && !idempotencyKey) { return { ...result, skipped: true, reason: 'RAGIC_PARENT_OUTBOX_DISABLED' }; }`；cron/index.js:89 同旗標檔在進入點
- 註：原敘述「UID 永遠不會回到 Ragic」講得太強，要改成「不會由 outbox 這條路回去」。程式自己的註解就承認有第二條（ragicSchema.js:92 `有些人有 Ragic 編號，是靠另一條直接寫入的備援補上的`）——那條是 writeback／每日備份／編輯學員，它們會強制附上 UID，見我補的 added 條。本次唯讀盤查沒有查正式環境 env，現在到底開沒開無法從程式碼斷定。

**26. worker 開工前必須先確認 Ragic 的 1006846 欄位「還是原來那個欄位」：名稱是「家教系統uid」、全表唯一、不是唯讀，而且這份驗證是有效期內取得的。任一項不符就整支 worker 停手（RAGIC_SCHEMA_NOT_VERIFIED），一筆都不領、也不寫；家長的本地登入完全不受影響。**

- 誰能做：系統自動（驗證每 5 分鐘自動更新一次：server/cron/index.js:52-60，註解說預設 TTL 15 分鐘）
- 依據：server/services/ragicSchemaFreshness.js:250-258 `const isFresh = evidence && evidence.verified === true && String(evidence.field_id) === UID_FIELD_ID && evidence.field_name === UID_FIELD_NAME && evidence.attr_no_dup === true && evidence.attr_ro === false && new Date(evidence.expires_at).getTime() > now.getTime();`；停手點在領工作之前 server/services/ragicSyncOutbox.js:694-702；記錄文案 ragicSyncOutbox.js:314 `message: 'worker stopped before claiming a job; local parent login remains available'`
- 註：「15 分鐘內」不是寫死在這個判斷裡的，判斷讀的是 evidence.expires_at；15 分鐘是產生 evidence 時的 TTL 預設值。

**27. 新建 Z01 家長前一定先查重，而且查重失敗不代表「這個人不在 Ragic」：只要本地已經知道 ragic_record_id，就拿它去定位既有那筆，絕不建第二筆。**

- 誰能做：系統自動
- 依據：server/services/ragicSyncOutbox.js:579-592 `let remote = await _findRemoteByTrueUid(parent.line_uid); … // 查重找不到，不代表這個人不在 Ragic —— 只代表那筆記錄上還沒有 UID。 if (!remote && parent.ragic_record_id) { recordId = String(parent.ragic_record_id); remote = await reader(recordId); if (!remote || _recordIdOf(remote) !== recordId) throw … 'RAGIC_UNCONFIRMED_WRITE'; }`
- 註：CREATE 這條路的寫後驗證是無條件的（ragicSyncOutbox.js:622 `_assertReadback({ row: await reader(recordId), targetRecordId: recordId, expectedUid: parent.line_uid })`），與 BIND／REBIND 不同。

**28. 用 UID 查 Ragic 若查到兩筆以上，判 RAGIC_UID_DUPLICATE 停手，不挑任一筆。**

- 誰能做：沒有人自動解；需人工在 Ragic 清掉重複
- 依據：server/services/ragicSyncOutbox.js:273-278 `const matches = (page.rows || []).filter((row) => getTrueRagicLineUid(row) === uid); if (matches.length > 1) { const err = new Error('Ragic field 1006846 contains duplicate LINE UID sources'); err.code = 'RAGIC_UID_DUPLICATE'; throw err; }`
- 註：這個錯誤碼在 syncFailureLog 被歸成 permanent（syncFailureLog.js:35），所以也會被每日備份的隔離機制排除，不會每輪重打。

**29. 毒資料隔離：如果連「把失敗寫進資料庫」這一步本身都炸掉，系統會把 Postgres 的 where／table／column／detail 全印出來，並用一句最小的 UPDATE 把那一筆標成 blocked_data_conflict（錯誤碼前綴 DB_）。目的是讓一筆壞資料不會再被 15 分鐘回收撿起來，也不會把當晚整條佇列一起拖住。**

- 誰能做：系統自動
- 依據：server/services/ragicSyncOutbox.js:381-397 `catch (dbErr) { … console.error('[ragic-outbox] _markFailure 本身失敗，隔離該筆 job=%s …  where=%s  table=%s column=%s  detail=%s' …); const quarantineCode = 'DB_' + code; await db.query(\`UPDATE ragic_sync_outbox SET state='blocked_data_conflict', last_error_code=$2 …\`) }`
- 註：背景在 ragicSyncOutbox.js:365-379：2026-09-07 正式站 2 筆卡在 processing、attempts 56/45、錯誤碼全空，一筆壞資料把佇列拖住 45 天。批次層也補了同樣的印法（cron/index.js:99-104）。

**30. 任何非「可重試」的失敗，都會自動開一張後台待辦任務，並帶上建議動作；schema 類的建議是「補齊 Ragic 必填欄位後重放同一筆」，資料衝突類的建議明確寫「不得改動訂單、付款、課程與點名」。**

- 誰能做：系統自動開單；後台人工處理
- 依據：server/services/ragicSyncOutbox.js:460-475 `if (failure.outboxState !== 'retryable') { … await createParentIdentityBackofficeTask({ … suggestedAction: failure.claimState === 'SYNC_BLOCKED_SCHEMA' ? 'Complete the required Ragic profile schema fields, then replay the same outbox job.' : 'Reconcile the source conflict without changing orders, payments, lessons, or attendance.' }) }`

**31. 家長註冊新戶：整個過程完全不等 Ragic。同一個交易裡建好本地家長與學員、開一張 identity_claim、排一筆 CREATE_Z01_PARENT 進佇列，然後直接發 token 讓人登入，回傳 sync_pending，前端只顯示「登入完成，Ragic 資料正在背景同步」。**

- 誰能做：家長自己
- 依據：server/services/z03IdentityClaim.js:206-212 `INSERT INTO ragic_sync_outbox (…operation…) VALUES ($1,$2,'CREATE_Z01_PARENT','RAGIC','Z01',$3,$4::jsonb,'pending',$5,'1006846')`；server/routes/auth.js:1542-1571 `const localFirst = await registerNewParentLocalFirst({…}); … return res.json({ status:'registered_and_logged_in', … sync_pending: true, internalCode:'RAGIC_UID_WRITE_PENDING', loginAllowed: true })`；前端 client/liff/src/pages/RegisterPage.jsx:323-326
- 註：這條路由旗標 PARENT_LOCAL_FIRST 控制（auth.js:1540；ragicSchema.js:84 預設 true）。旗標關掉會走舊的同步寫 Ragic 路徑。

**32. 舊客認領（電話＋學員姓名對上 Z03）同樣是本地先成立：本地連結完成、Z03 標 resolved、排一筆 BIND_Z01_LINE_UID，然後回 SYNC_PENDING。Ragic 沒回寫成功不影響這位家長之後的使用。**

- 誰能做：家長自己
- 依據：server/services/z03IdentityClaim.js:1045-1056 `INSERT INTO ragic_sync_outbox (…) VALUES ($1,$2,'BIND_Z01_LINE_UID','RAGIC','Z01',$3,$4::jsonb,'pending',$5,$3,'1006846') ON CONFLICT (idempotency_key) DO NOTHING`；緊接 1057-1065 `UPDATE ragic_z03_records SET status='resolved', classification='RESOLVED', reason_code='CLAIM_LINKED_LOCAL', claim_state='SYNC_PENDING' …`
- 註：若快照上的 UID 已經等於這位家長（remoteUid === lineUid），排進去的工作會帶 skip_uid_write: true，只補白名單個資、不重寫 UID（z03IdentityClaim.js:1054）。

**33. 帳號恢復（換手機、LINE 換帳號）改綁 UID：本地用 compare-and-set 原子換綁並留完整稽核鏈，Ragic 端的改綁排成 REBIND_Z01_LINE_UID 由 worker 補；worker 成功才把恢復申請與稽核列標成 SYNCED。**

- 誰能做：後台審核人員（需人工驗證證據，verification_method='MANUAL_VERIFIED'）；家長只能提出申請
- 依據：server/services/parentAccountRecovery.js:347-351 `UPDATE parents SET line_uid=$2,updated_at=$3 WHERE id=$1 AND line_uid=$4 RETURNING *` + `if (!reboundParent) throw new AccountRecoveryError('ACCOUNT_RECOVERY_FAILED', 'Atomic parent rebind compare-and-set failed')`；排入 parentAccountRecovery.js:389-397；成功回沖 server/services/ragicSyncOutbox.js:174-189
- 註：換綁同時把舊 UID 綁定列標 REPLACED、新列標 ACTIVE（parentAccountRecovery.js:335-346）。這張工作的 payload 沒帶 verify_readback（見下方 inconsistent）。

**34. 家長改自己的個資（PATCH /me）：先在單一交易存下使用者輸入並把該列標成「待同步」（last_synced_at = NULL），交易提交後才 fire-and-forget 回寫 Ragic。回傳 sync_status='pending'。回寫失敗只記 warn，不擋家長，該列留待每晚 00:30 的備份重試。**

- 誰能做：家長自己
- 依據：server/routes/parents.js:547-556 `UPDATE parents SET name = $2, primary_venue_id = $3, … last_synced_at = NULL, updated_at = NOW() WHERE id = $1`；parents.js:570-572 `ragicWriteback.scheduleWriteback({ parentId: req.parent.id, reason: 'parent-profile-update' }); … res.json({ ...me, sync_status: 'pending' })`；失敗只 warn：server/services/ragicWriteback.js:152-154
- 註：後端另有一層必填：姓名／館別／性別／Email 缺一就 400 FIELD_REQUIRED，Email 還要過格式（parents.js:512-521）。demo 帳號走另一個分支，只寫本地、且不標 last_synced_at = NULL（parents.js:529-539）。

**35. 櫃檯／後台改家長或學員資料、團購加入建新學員、對帳與轉讓建學員，走的都是同一條「本地先寫、best-effort 回寫、失敗留待每日備份」路線。**

- 誰能做：櫃檯／管理員（後台）、家長（團購加入）
- 依據：server/routes/admin/customerParents.js:390-394 `ragicWriteback.scheduleWriteback({ parentId: parentTouched ? req.params.id : null, studentIds: touchedStudentIds, reason:'admin-parent-patch' })`；server/routes/admin/customerStudents.js:220 `ragicWriteback.scheduleWriteback({ studentIds: [req.params.id], reason: 'admin-student-patch' })`；server/routes/groupOrders.js:202-205；server/services/transfers.js:176

**36. 開場刷新（每次打開 App 的 POST /me/sync）失敗時一律保留既有鏡像、絕不清空也絕不回空名單，只把狀態標成 stale（Ragic 查無這個人則標 not_found_in_ragic）。註冊寫回還在排隊的家長根本不打 Ragic，直接回 pending_ragic。近 5 分鐘內同步過也直接回資料庫。**

- 誰能做：家長自己（自動觸發）
- 依據：server/routes/parents.js:458-461 `const fresh = last > 0 && (Date.now() - last) < SYNC_THROTTLE_MS; let syncStatus = p.registration_pending ? 'pending_ragic' : (fresh ? 'fresh' : 'synced');`；parents.js:462 `if (!p.registration_pending && !fresh && p.line_uid && !String(p.line_uid).startsWith('demo:')) {`；parents.js:477-478 `console.warn('[parents/me/sync] refresh 失敗，保留既有鏡像：', err.message); syncStatus = err.code === 'RAGIC_REFRESH_NOT_FOUND' ? 'not_found_in_ragic' : 'stale';`；節流值 parents.js:24
- 註：補兩點：(1) registration_pending 的判準是「這位家長還沒有 ragic_record_id，且 outbox 裡還有 pending/processing 的 CREATE_Z01_PARENT」（parents.js:445-451）；(2) 前端不只是靜默——AuthContext 在合併資料時把 sync_status 直接解構丟掉（client/liff/src/context/AuthContext.jsx:82 `const { line_uid, lineUid, sync_status, ...safe } = me;`），所以 stale / not_found_in_ragic 這些狀態沒有任何 UI 呈現。

**37. 開場刷新對「Ragic 上 UID 欄位還空著」是放行的（strictUidMatch=false），但「Ragic 上是別人的 UID」照擋。註冊／綁定當下的寫入後驗證維持嚴格，一律要驗到 UID 真的生效。**

- 誰能做：系統自動
- 依據：server/services/parentRefresh.js:171-174 `const ragicUidEmpty = !String(mapped.line_uid || '').trim(); if (strictUidMatch || !ragicUidEmpty) { throw new ParentRefreshError('RAGIC_REFRESH_UID_MISMATCH', …, 502); }`（預設 strictUidMatch = true，parentRefresh.js:135）；呼叫端 server/routes/parents.js:472-473 `strictUidMatch: false, reason: 'parents-me-sync'`
- 註：放寬的理由寫在 parentRefresh.js:158-170：outbox 沒開導致 UID 永遠空著，嚴格模式會讓這些家長「永遠同步失敗」。開場刷新同時也把 requireComplete 關掉（parents.js:468），所以 Z01 必填不全也不擋登入。

**38. 本地家長的 line_uid 不會被任何 Ragic 同步路徑覆蓋。SQL 用 COALESCE 保護，只有明確傳 overwriteLineUid=true 才允許覆蓋——而全系統沒有任何呼叫端會傳 true。唯一能改綁的路徑是帳號恢復流程。**

- 誰能做：沒有人（除帳號恢復流程 parentAccountRecovery.js:347-351）
- 依據：server/services/parentSync.js:291 `line_uid=CASE WHEN $12::boolean THEN NULLIF($3,'') ELSE COALESCE(line_uid,NULLIF($3,'')) END,`（$12 = overwriteLineUid）；夜間 canonical import 亦同 server/services/ragicAdmin.js:2846 `line_uid = COALESCE(line_uid, $4),`
- 註：我自己重跑過覆核：`grep -rn "allowRebind|overwriteLineUid" server/` 只有 parentRefresh.js:128/206（宣告預設 false 並原樣傳下）、parentSync.js:225/306/519/544/593、z03IdentityClaim.js:274（明寫 false）。沒有任何呼叫端傳 true。原註解的結論成立。

**39. 學員的身分證字號只會在本地那一欄是空的時候被 Ragic 補上，本地已經有值就絕不被 Ragic 蓋掉。**

- 誰能做：系統自動（只補空白）
- 依據：server/services/parentSync.js:418 `id_number   = COALESCE(id_number, NULLIF($5,'')),`；夜間 canonical import 同義 server/services/ragicAdmin.js:2924 `id_number = COALESCE(NULLIF(id_number,''), NULLIF($7,'')),`（該處註解 ragicAdmin.js:2878-2879 `National ID is copied into a blank local field, never used as a match/merge key here.`）

**40. 沒有任何 Ragic 同步路徑會刪除本地家長或學員。破壞性收斂由開關 DESTRUCTIVE_RECONCILE_ENABLED 控制（預設關），而且就算打開，實際執行刪除的函式已經是空實作、永遠回 false。**

- 誰能做：沒有人（只能在資料庫直接改）
- 依據：server/services/parentSync.js:176-180 `async function hardDeleteStudentIfSafe(client, studentId) { void client; void studentId; return false; }`；家長端 parentSync.js:506-511 `// Compatibility no-op: identity reconciliation is permanently non-destructive and no feature flag may reactivate hard deletion.` / `return false;`；旗標 server/config/ragicSchema.js:98 `get DESTRUCTIVE_RECONCILE_ENABLED() { return envFlag('DESTRUCTIVE_RECONCILE_ENABLED', false); }`（全 server/ 只有 parentSync.js:459 一處讀它）

**41. Ragic 的館別存的是場館名稱、本地存的是代碼，比對時會先試代碼、再試名稱、最後試「去掉結尾括號備註後的名稱」；正規化後撞名的兩個場館視為無法判斷，寧可留本地既有值也不亂配。**

- 誰能做：系統自動
- 依據：server/services/parentSync.js:70-76 `if (map.byId.has(code)) return code; if (map.byName.has(code)) return map.byName.get(code); return map.byNormName.get(_normalizeVenueName(code)) || null;`；撞名處理 parentSync.js:86-94 `if (byNormName.has(norm) && byNormName.get(norm) !== row.id) { ambiguous.add(norm); continue; } … for (const k of ambiguous) byNormName.delete(k);`
- 註：修正前的災情寫在 parentSync.js:50-53 與 58-62：永遠拿 Ragic 名稱去比對 venues.id，上千筆家長的 primary_venue_id 被靜默清成空、登入時再被 LOCAL_VENUE_REFRESH_FAILED 擋下。

**42. Ragic webhook（Z01／Z02）只會更新本地的 Ragic 快照表（ragic_z01_shadow／ragic_z02_shadow），不會直接動到家長或學員資料。Ragic 那邊改的內容要進到家長／學員鏡像，只能靠每晚 02:30 的全量拉回，或該家長下次登入時的即時刷新。**

- 誰能做：Ragic（發 webhook）；系統自動接收（每分鐘一輪：server/cron/index.js:63-71）
- 依據：server/services/ragicAdmin.js:4790-4813 `async function _projectWebhookRecord(client, job) { … const record = await ragic.getRecordByRagicId(formPath, id, …); … shadowUpdated = await _upsertWebhookShadow(client, code, record); }`；寫入只碰 shadow 表 ragicAdmin.js:4764-4775
- 註：webhook 的 Z01／Z02「刪除」也不刪本地快照，只標 present_in_latest_pull=FALSE 與 missing_since（ragicAdmin.js:4729-4737）——來源歷史從不刪除。

**43. webhook 端點要帶共享密鑰（X-Ragic-Webhook-Secret）；沒設密鑰時，非 production 環境放行、production 一律 401。一次最多 100 筆純數字 record id。處理失敗回 503 + Retry-After: 30 讓 Ragic 重送。**

- 誰能做：Ragic（憑密鑰）
- 依據：server/routes/ragicWebhook.js:6-16 `const secret = String(process.env.RAGIC_WEBHOOK_SECRET || '').trim(); if (!secret) return process.env.NODE_ENV !== 'production'; const got = String(req.get('X-Ragic-Webhook-Secret') || req.get('X-Webhook-Secret') || req.query.secret || '').trim(); return got && got === secret;`；ragicWebhook.js:22-23 `if (!result.ok) res.set('Retry-After', '30'); res.status(result.ok ? 200 : 503)`；server/services/ragicAdmin.js:4826-4828 `if (!ids.length || ids.length > 100 || ids.some(id => !/^\d+$/.test(id))) throw invalid('webhook payload requires 1-100 numeric record ids');`
- 註：密鑰也接受放在 query string（`req.query.secret`），這在日誌裡會留下明文。

**44. webhook 佇列（ragic_webhook_inbox）以「表＋record id」去重合併，同一筆重複通知只會累加 revision 而不是排兩份工作；已完成的再被通知會重新變回待處理並把 attempts 歸零。每次處理都重新去 Ragic 撈最新資料，不信任 webhook 帶來的內容。**

- 誰能做：系統自動
- 依據：server/services/ragicWebhookInbox.js:3-4 `// Webhooks describe a record's latest projection, not an instruction to mutate business data. Coalesce by source identity and refetch on every attempt.`；ragicWebhookInbox.js:9-14 `ON CONFLICT (sheet_code,ragic_record_id) DO UPDATE SET … revision=ragic_webhook_inbox.revision+1, state=CASE WHEN ragic_webhook_inbox.state='completed' THEN 'pending' ELSE … END, attempts=CASE WHEN … 'completed' THEN 0 ELSE … END`

**45. 夜間同步鏈固定是「推在拉之前」：00:10 寫回 Ragic 的 outbox → 00:30 本地往 Ragic 的全量備份 → 02:30 從 Ragic 拉回並分流 Z03 → 02:45 姓名品質掃描。順序顛倒會把 Ragic 的舊值灌回本地，並讓已經修好的佔位姓名又被塞進 Z03。**

- 誰能做：系統自動；後台「Ragic 狀態」頁可手動單獨觸發 backup / pull / quarantine（server/routes/admin/ragicStatus.js:34-42）
- 依據：server/cron/index.js:442-449 `//   #1 00:30 本地 → Ragic 回寫（推）/ #2 02:30 Ragic Z01/Z02 → 本地 + Z03 分流（拉）/ #3 02:45 Z01 姓名品質掃描 … 順序顛倒（舊行為：01:00 拉、02:00 推）會把 Ragic 的舊值灌回本地/Z03`；實際排程 cron/index.js:88 `scheduleTaipei('10 0 * * *'`、455 `scheduleTaipei('30 0 * * *'`、469 `scheduleTaipei('30 2 * * *'`、487 `scheduleTaipei('45 2 * * *'`
- 註：要修正原清單的一句：00:10 的 outbox **不在** 後台可手動觸發的清單裡，只有 backup / pull / quarantine 三支可以。

**46. 02:30 的拉回有前置條件：00:30 那支「本地→Ragic」在近 3 小時內必須有成功紀錄，否則整支跳過並記 log。02:45 的姓名掃描也套同一條件，另外還要求 Z01 快照是近期成功拉回的。**

- 誰能做：系統自動
- 依據：server/cron/index.js:472-475 `if (!(await ragicAdmin.hasRecentBackupSuccess(3))) { console.warn('[Cron/RagicPull#2] 跳過：#1（00:30 本地→Ragic 回寫）近 3 小時內無成功紀錄，先修復回寫再拉回，避免堵塞 Z03'); return; }`；掃描端同條件 cron/index.js:490-493，另加 server/services/ragicAdmin.js:4243-4246 `if (!(await hasRecentSuccessfulPull())) { … return { synced: 0, skipped: true, error: msg }; }`（預設視窗 24 小時，ragicAdmin.js:53）
- 註：程式註解與程式在這裡互相打架：cron/index.js:454 與 467 都寫「hasRecentBackupSuccess 目前只觀測、不阻擋」，但 472-475 的程式確實會 return 跳過。以程式為準——會阻擋。

**47. 每日備份（本地→Ragic）只處理「待同步」的列：ragic_record_id 為空或 last_synced_at 為空，每輪家長與學員各最多 200 筆，依 updated_at 由舊到新。**

- 誰能做：系統自動
- 依據：server/services/ragicAdmin.js:2307-2310 `AND (ragic_record_id IS NULL OR last_synced_at IS NULL) AND ${syncFailureLog.stuckExclusionSql('parents','Z01_Z02_BACKUP','parent')} ORDER BY updated_at ASC LIMIT $1` / `[BACKUP_BATCH_LIMIT]`；學員端 ragicAdmin.js:2344-2347；批次上限 ragicAdmin.js:2212 `const BACKUP_BATCH_LIMIT = 200;`

**48. 備份會把「上次資料異動之後就一直因為資料問題失敗」的列隔離掉，不再每輪重打 Ragic；而且這個隔離會自癒——櫃檯把 Email 補齊、把撞號的身分證改掉，資料的 updated_at 一變就自動脫離隔離、下一輪重試。被隔離的筆數不算當輪失敗。**

- 誰能做：系統自動；解除隔離靠櫃檯把資料改對
- 依據：server/services/syncFailureLog.js:134-147 `return \`NOT EXISTS ( SELECT 1 FROM ragic_sync_failures f WHERE f.form_code='${formCode}' AND f.entity_kind='${entityKind}' AND f.local_id = ${alias}.id AND f.error_kind='permanent' AND f.occurred_at >= ${lastChangedAt} )\`;`；不計入失敗 server/services/ragicAdmin.js:2365-2367 `// 被隔離的不算本輪失敗 —— 它們是待人工處理的資料問題，不是同步壞掉。`
- 註：學員的「最後異動時間」刻意取 GREATEST(學員自己, 家長)（ragicAdmin.js:2345-2346 傳入 `'GREATEST(s.updated_at, p.updated_at)'`），理由寫在 syncFailureLog.js:122-132：正式庫 90 筆隔離學員裡 69 筆（橫跨 55 位家長）是因為「家長缺 Email」失敗，而櫃檯補的是 parents 那一列。

**49. 錯誤分類的判準（決定要不要一直重試）：逾時／5xx／連線層＝暫時性；Ragic 欄位驗證錯誤、身分證撞號、本地唯一鍵衝突（23505）、UID 欄位 schema 不符、UID 重複＝永久性，會被隔離。訊息裡出現「INVALID 數字」「為必填」也一律判永久性。落庫前會把 Email／手機／身分證／LINE UID 全部代換掉，不存個資。**

- 誰能做：系統自動
- 依據：server/services/syncFailureLog.js:28-37 `const PERMANENT_CODES = new Set(['RAGIC_VALIDATION_ERROR','STUDENT_ID_NUMBER_EXISTS','RAGIC_APPLICATION_ERROR','RAGIC_UID_FIELD_SCHEMA_MISMATCH','RAGIC_UID_DUPLICATE','RAGIC_HTTP_CLIENT_ERROR']);`；syncFailureLog.js:40 `const PERMANENT_MESSAGE_RE = /INVALID\s+\d+|為必填|欄位.*不存在|not found|invalid field/i;`；23505 在 syncFailureLog.js:77；去識別化 syncFailureLog.js:49-54

**50. 從 Ragic 拉回分兩段：先「無腦寫快照」（只呼叫 Ragic API + 完整性／schema 漂移把關，不跑任何清洗邏輯），再從快照跑分流與 upsert。全系統只有這一支會打 Z01 全量查詢。快照寫入失敗會整個交易回滾並回報實際落地 0 筆。**

- 誰能做：系統自動
- 依據：server/services/ragicAdmin.js:2602-2605 `// P1.1 決策9：無腦 shadow 寫入——只呼叫 Ragic API + 完整性/schema-drift 把關，不跑任何畢業判斷/quarantine/upsert 邏輯。這支是全系統「唯一」打 Z01 全量查詢的地方`；回滾回報 ragicAdmin.js:2722-2725 `await client.query('ROLLBACK')… // ROLLBACK 已撤銷整個交易——回報實際持久化筆數 0` / `return _withFreshness({ synced: 0, error: … })`

**51. 全量拉回會做三道把關才算成功：分頁完整性掃描、用數字欄位 ID 再撈一次並比對兩份的 record id 集合必須完全相同（不同就整輪放棄、錯誤碼 RAGIC_Z01_EID_SOURCE_SET_MISMATCH）、寫完再數一次筆數必須對得上。**

- 誰能做：系統自動
- 依據：server/services/ragicAdmin.js:2634-2635 `const gateError = await _checkZ01IntegrityGate(integrity); if (gateError) return …`；ragicAdmin.js:2641-2647 `const sameIds = normalIds.size === eidIds.size && [...normalIds].every((id) => eidIds.has(id)); if (!sameIds) { return _withFreshness({ synced: 0, error: \`RAGIC_Z01_EID_SOURCE_SET_MISMATCH normal=… eid=…\` }, freshness); }`；筆數核對 ragicAdmin.js:2705-2706 `if (persisted.rows[0].n !== presentIds.length) throw new Error('Z01 source/shadow count mismatch');`
- 註：三道把關**只在全量**生效：完整性 gate（2633-2636）、missing 標記（2693-2703）、筆數核對（2704-2707）全都包在 `if (!useIncremental)` 裡。手動觸發的增量拉回不做這些。Z02 那側的筆數核對則是無條件（2719-2720）。

**52. Ragic 來源的歷史從不刪除。一筆 Z01 在 Ragic 消失時，本地快照只標「不在最新一次拉回中」與「從何時開始消失」，而且這個判定只在「完整且通過完整性檢查的全量拉回」之後才允許下。**

- 誰能做：系統自動
- 依據：server/services/ragicAdmin.js:2693-2702 `// Source history is never deleted. Missing is an observable state and is only assigned after a complete, integrity-checked full pull.` + `UPDATE ragic_z01_shadow SET missing_since = COALESCE(missing_since, NOW()) WHERE NOT (ragic_record_id = ANY($1::text[])) AND present_in_latest_pull = FALSE`

**53. 拉回時也刻意不做「Ragic 沒有的本地家長就自動停用」這件事——因為分頁上限若靜默截斷會誤殺還在的人。**

- 誰能做：沒有人
- 依據：server/services/ragicAdmin.js:2396-2398 `// 刻意不做「Ragic 沒有的本地家長 → 自動停用」：一來 RAGIC_MAX_PAGES 上限若靜默截斷會誤殺還在的人，二來這個方向本來就該跟 H01/H05 一樣先進待審核，不在這次範圍。`

**54. 姓名品質掃描（02:45）只偵測與記錄，不回寫 Ragic。判準有兩層：整串去掉電話格式符號後是純數字；或去符號後長度 8–11 且數字過半。命中就寫進本地 ragic_z01_quarantine 追蹤表。已被管理員永久排除（有 tombstone）的不再列入。**

- 誰能做：系統自動（只記錄）；修正要人工在 Ragic 或 Z03 頁面做
- 依據：server/services/ragicAdmin.js:4226-4230 `const stripped = String(name || '').trim().replace(/[\s\-()（）.]/g, ''); … if (/^\d+$/.test(stripped)) return true; const digitCount = (stripped.match(/\d/g) || []).length; return stripped.length >= 8 && stripped.length <= 11 && digitCount * 2 > stripped.length;`；tombstone 跳過 ragicAdmin.js:4274-4278；不推 Ragic 的結論 ragicAdmin.js:4305-4308
- 註：另有 Tier 2「完全不含中文字」只做統計、不觸發追蹤（ragicAdmin.js:4233-4238、4267）。掃描讀的是 ragic_z01_shadow，不再重打 Ragic（4247-4257）。

**55. 櫃檯在 Z03 頁面按「修正姓名」時，只會用 partial update 寫回 Ragic Z01 的姓名一個欄位，不動同一筆的其他欄位；而且修正後的姓名不能還是純數字（電話），否則下一輪拉回又會依同一條線把它分流回 Z03。**

- 誰能做：有 ragic-z03 權限的後台使用者（server/routes/admin/ragicZ03.js:77 PATCH /:id）
- 依據：server/services/ragicAdmin.js:4115-4118 `// 修正後的姓名不能還是純數字（電話號碼），否則下一輪 pull 會依同一條線又把它分流回 Z03。` / `if (isPlaceholderParentName(name)) throw new Error('這個姓名看起來仍是電話號碼，請確認後再送出'); await ragic.upsertParentStrict({ [ragic.FIELD.Z01.PARENT_NAME]: name }, row.z01_ragic_record_id);`

**56. Z03「必填齊全才能升級成正式 Z01 鏡像」的檢核項目是：家長姓名（且不能是佔位電話）、角色身份、場館（不能是「待補登」）、電話、Email、性別，加上至少一位有姓名的學員，且每位學員要有學員編號或身分證字號之一。**

- 誰能做：後台使用者填、系統檢核
- 依據：server/services/ragicAdmin.js:3577-3600 `const required = [['name','家長姓名'],['identity','角色身份'],['primary_venue_id','場館'],['phone','電話'],['email','Email'],['gender','性別']]; … if (parent.primary_venue_id === '待補登' …) missing.push(…) … if (parent.name && isPlaceholderParentName(parent.name) …) missing.push(…) … if (!validStudents.length) missing.push({ key:'students' …}) … if (!s.id_number && !s.student_code) missing.push({ key: \`students.${idx}.student_code\` …`
- 註：status='dismissed' 的列直接跳過升級（ragicAdmin.js:3938-3940）。

**57. 家長的「認領驗證」（證明這個舊資料是我）分四種結果而不是只有「對／不對」：姓名＋身分證都對＝通過；姓名對上但 Ragic 那筆身分證欄本來就空＝no_id_on_file（資料缺口，不是使用者打錯）；姓名對不上任何現有學員＝not_on_file（視為新學生，不是衝突）；姓名對上但身分證不同＝mismatch。也支援「姓名＋登記手機」的替代驗證，Ragic 學員子表有登記電話欄就比那欄，沒有才退回比家長電話。**

- 誰能做：家長自己
- 依據：server/services/parentSync.js:697-701 `const byName = (ragicStudents||[]).find((s) => _normalizeStudentName(s.name) === _normalizeStudentName(name)); if (!byName) return 'not_on_file'; const ragicId = String(byName.id_number||'').trim().toUpperCase(); if (!ragicId) return 'no_id_on_file'; return ragicId === id ? 'matched' : 'mismatch';`；手機版 parentSync.js:708-717 `const expectedPhone = _normalizePhone(byName.registered_phone || parentPhone || '');`；稽核只落雜湊 parentSync.js:720-728
- 註：姓名或身分證任一沒填就直接回 mismatch（parentSync.js:696）。「登記電話」這個欄位是從 Z03 學員列帶出來的（ragicAdmin.js:3570）。

**58. Ragic 缺 Email 的家長不會被擋在門外，但會留下明確的 log 痕跡。原因是 Ragic Z01 的 Email 是必填欄，所以這些人之後會寫不回 Ragic、加不了學員、每次開 App 都看到「Ragic Z01 查無會員資料」——擋下他們只是把資料品質問題換成一個新的停擺。**

- 誰能做：系統自動（只記錄）；補 Email 要櫃檯做
- 依據：server/services/parentSync.js:215-223 `function _warnMissingEmail(parent, source) { if (String(parent?.email || '').trim()) return; … console.warn(\`[parent-upsert] 建檔缺 Email：…（來源 ${source}…）\` + ' —— 此家長無法寫回 Ragic、無法新增學員，需請櫃檯補齊 Email。'); }`（呼叫點 parentSync.js:286，只在 INSERT 新家長時）
- 註：同處註解（parentSync.js:199-213）記了 2026-08-29 的盤點：555 位在職家長裡 59 位缺 Email（10.6%），牽連 75 位學員；系統有十二處會建立本地家長，但 Email 必填只有註冊表單那一道在擋。家長自己改個資時後端也會擋（parents.js:512-521）。

**59. 家長／學員的身分收斂順序固定是「LINE UID → 正規化手機 → 明確的來源連結」。單有一個 Ragic record id 永遠不能證明兩筆是同一個人；同一支手機即使帶著另一個 Ragic record id 進來，也只補一筆來源別名（source_record_links），不會多開一個人。三種證據指向不同家長時，一律丟 DATA_RECONCILIATION_PENDING 交人工。**

- 誰能做：系統自動；衝突需人工
- 依據：server/services/parentSync.js:234-235 `// Canonical identity order: LINE UID -> phone -> explicit source link. A bare Ragic record id is never accepted as proof that two people are one.`；衝突擋點 parentSync.js:256-259 `const candidates = new Map([byUid, byPhone, byLink].filter(Boolean)…); if (candidates.size > 1) { throw new BindConflictError('DATA_RECONCILIATION_PENDING', 'LINE UID、canonical phone 與 source link 指向不同 parent'); }`；夜間 import 同款 ragicAdmin.js:2803-2810 `MEMBER_MERGE_REQUIRED`
- 註：同一支手機命中多個 parent 也直接擋（parentSync.js:245-247）；指向的手機不一致時錯誤碼是 ACCOUNT_RECOVERY_REQUIRED（parentSync.js:261-266）。

**60. 同一支手機上的綁定／註冊／刷新會被序列化（在手機號上取 advisory lock），避免「檢查在交易外、寫入在交易內」之間的縫造成誤綁；夜間拉回的正式 import 也固定用「先鎖手機、再鎖來源記錄」的同一個上鎖順序。**

- 誰能做：系統自動
- 依據：server/services/parentSync.js:524-525 `await client.query('BEGIN'); await client.query(\`SELECT pg_advisory_xact_lock(hashtext($1))\`, [\`parent_bind:${phone}\`]);`；夜間 import server/services/ragicAdmin.js:2775-2781 `// One lock order for every formal Z01 import: canonical phone first, source record second.` + `pg_advisory_xact_lock(hashtext($1), hashtext($2))`
- 註：鎖名在不同入口不完全一致：parentSync._syncWithLock 用 `parent_bind:<phone>`，而 linkFromRagicRecordLocalFirst（parentSync.js:589-590）、z03IdentityClaim（z03IdentityClaim.js:268-270）與夜間 import 用 `canonical-parent:<phone>` + `ragic-z01:<id>`。不同名的 advisory lock 互不排斥，所以「登入綁定」與「認領／夜間 import」兩群之間並沒有真的互相序列化。

**61. 「認領時判斷這筆 Ragic 家長是不是已經綁給別人」讀的是本地快照（ragic_z01_shadow），不是即時去問 Ragic。也就是說這道檢查最舊可能是前一晚 02:30 的狀態。**

- 誰能做：系統自動
- 依據：server/services/z03IdentityClaim.js:588-595 `const shadow = (await client.query(\`SELECT raw_data FROM ragic_z01_shadow WHERE ragic_record_id=$1 FOR UPDATE\`, [family.z01_ragic_record_id])).rows[0]?.raw_data || {}; const remoteUid = String(shadow['1006846'] || '').trim(); if (remoteUid && remoteUid !== lineUid) { throw new Z03ClaimError('ACCOUNT_RECOVERY_REQUIRED', 'Ragic source 已綁定另一個 LINE UID', 409); }`（同樣邏輯另見 z03IdentityClaim.js:844-851）
- 註：同一個 remoteUid 也決定「這張 outbox 工作要不要寫 UID」（skip_uid_write: remoteUid === lineUid，z03IdentityClaim.js:692、1054），所以快照過期不只影響擋不擋，也影響會不會補寫。第二道門在寫回時（ragicSyncOutbox.js:532-537 用 live 讀擋 PARENT_LINE_UID_MISMATCH）——但那道門本身是條件式的，見下一條。

**62. 家長端所有讀寫都不直接相信 Ragic 回傳的資料形狀：用 UID 或手機查 Z01 一律帶 naming='EID' 要求數字欄位 ID，否則回來的物件裡讀不到 UID——這個漏洞曾讓「這支電話已綁到別的 LINE 帳號」那道衝突檢查從上線起一次都沒擋過。**

- 誰能做：系統自動
- 依據：server/services/ragic.js:670-686 `async function getParentByPhone(phone) { // naming: 'EID' —— 讓回應的 key 是數字欄位 ID 而不是中文欄位名。… 後果不只是 log 上那句「Z01 LINE UID 尚未回寫」（實測 479/479 其實都寫好了），而是所有依賴 mapped.line_uid 的判斷全部失效 …` + `const data = await query(process.env.RAGIC_FORM_Z01, { where: \`${FIELD.Z01.PHONE},eq,${phone}\`, naming: 'EID' });`；同理 getParentByLineUid（ragic.js:696-703）、getParentRecordByRagicId（ragic.js:1255）
- 註：「所有」要打個折：webhook 那條路就沒帶 EID（見上方 inconsistent 那條）。

**63. Ragic 寫入只有 status:'SUCCESS' 算成功；'INVALID'（欄位驗證失敗，例如必填缺漏）與 'ERROR' 都代表沒寫進去。回 200 卻既無 SUCCESS 也無 record id 的，也一律當失敗。**

- 誰能做：系統自動
- 依據：server/services/ragic.js:142-144 `// Ragic 寫入成功為 status:'SUCCESS'；'ERROR'(系統錯) / 'INVALID'(欄位驗證失敗，如必填缺漏) 等都代表沒寫進去。先前多處只擋 'ERROR' → 'INVALID' 被當成功靜默吞掉、整筆沒落地。` / `function _assertWriteOk(data)`；ragic.js:151-158 補防「回 200 但無 SUCCESS 也無 record id」→ 拋錯

**64. demo 哨兵帳號（line_uid 以 demo: 開頭）的家長，個資與學員一律只動本地鏡像：不寫 Ragic、不做嚴格刷新。理由是嚴格刷新會拿 Ragic 的 UID 跟哨兵值比對，必然不符而讓整個編輯流程壞掉。**

- 誰能做：系統自動（依帳號類型）
- 依據：server/routes/parents.js:416-422 `// demo 哨兵帳號 … /me 系列一律走「本地鏡像 only」——不寫 Ragic、不做嚴格刷新 … (2) 嚴格刷新會比對 Ragic 端 line_uid 與哨兵值 → 必然 UID_MISMATCH，整個編輯流程會壞掉。` / `function isDemoParent(parentRow, tokenLineUid) { return String(parentRow?.line_uid || tokenLineUid || '').startsWith('demo:'); }`（分支點 parents.js:462、529、589、701）
- 註：這裡的判斷只看 `demo:`，不看 `DEMOTEST_`，而寫入層與備份層是兩者都擋——見我補的 added 條。

**65. 家長端／櫃檯端編輯或新增學員時，會把家長的姓名、電話、性別、身分、Email 與館別整組覆蓋寫進該學員的 Ragic Z02 主檔——不只是學員自己的欄位。** 〔覆核時補上〕
- 依據：server/services/ragic.js buildZ02StudentPayload `[FIELD.Z02.VENUE]: await venueLabel(parent.primary_venue_id), [FIELD.Z02.PARENT_PHONE]: parent.phone || '', [FIELD.Z02.PARENT_ACCOUNT]: parent.phone || '', [FIELD.Z02.PARENT_NAME]: parent.name || '', [FIELD.Z02.PARENT_GENDER]: _toPhysGender(parent.gender), [FIELD.Z02.PARENT_IDENTITY]: parent.identity || '一般身分', [FIELD.Z02.PARENT_EMAIL]: parent.email || '',`（欄位對照 server/config/ragicSchema.js:167-175）；呼叫鏈 server/routes/parents.js:714 → ragic.js:1468 upsertZ02ForParentStudent → ragic.js:1443 buildZ02StudentPayload

**66. 家長端「新增學員」的身分證撞號有三種不同結果：撞到別人家 → 409 請確認／聯絡客服（STUDENT_ID_DUPLICATED）；撞到自己家但那位學員已被停用 → 409 請聯絡客服恢復（STUDENT_INACTIVE_CONTACT_COUNTER）；撞到自己家且在籍 → 不報錯，改成把既有那一筆做「嚴格更新」，回 200 而不是 201。** 〔覆核時補上〕

- 誰能做：家長自己；解除停用只能由櫃檯／客服處理
- 依據：server/routes/parents.js:612-645 `const dup = await pool.query(\`SELECT … FROM students WHERE id_number = $1 LIMIT 1\`, [s.id_number]); if (dup.rowCount) { const existing = dup.rows[0]; if (String(existing.parent_id) !== String(req.parent.id)) return res.status(409).json({ … code: 'STUDENT_ID_DUPLICATED' }); if (existing.is_active === false) return res.status(409).json({ … code: 'STUDENT_INACTIVE_CONTACT_COUNTER' }); mergedExisting = true; … sync = await ragic.updateStudentZ01Z02Strict({ … })` + parents.js:665 `res.status(mergedExisting ? 200 : 201).json(me);`

**67. 舊的公開家長註冊端點（POST /api/parents）已封閉：一律回 410「家長註冊請改走 LINE 驗證流程」。只有在非 production 環境且明確設了 ALLOW_LEGACY_PARENT_CREATE=1 時才放行，而那條路建出來的家長不寫 Ragic、也不排任何佇列。** 〔覆核時補上〕

- 誰能做：沒有人（production）；開發環境的部署設定
- 依據：server/routes/parents.js:756-764 `const allowLegacyCreate = process.env.ALLOW_LEGACY_PARENT_CREATE === '1' && process.env.NODE_ENV !== 'production'; if (!allowLegacyCreate) { return res.status(410).json({ error: '家長註冊請改走 LINE 驗證流程', code: 'LINE_REGISTER_REQUIRED' }); }`；該路徑的 INSERT（parents.js:789-806）完全沒有 line_uid、也沒有任何 ragicWriteback／outbox 呼叫


#### 判準不一致（11 條）

**1. 軟刪除的家長／學員會不會因為 Ragic 同步復活，兩條路完全相反：家長登入／綁定／開場刷新那條（parentSync）只有「刻意登入／綁定」才允許重新啟用，背景刷新一律保留既有狀態；而每晚 02:30 的 Ragic 拉回走的是另一支 canonical import，那裡把家長與學員的 is_active **無條件設成 TRUE**——櫃檯停用的人只要 Ragic 上還在，當晚就會被重新啟用。**

- 誰能做：家長自己（登入／綁定時）；以及系統自動（每晚 02:30 拉回，或後台手動觸發 pull）
- 依據：有保護：server/services/parentSync.js:300 `is_active=CASE WHEN $14::boolean THEN TRUE ELSE is_active END,`（$14 = reactivate）＋ 學員端 parentSync.js:420 `is_active = CASE WHEN is_active = FALSE THEN is_active ELSE TRUE END,`；呼叫端 server/routes/parents.js:467 `reactivate: false,`。沒保護：server/services/ragicAdmin.js:2855 `is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()`（家長）與 ragicAdmin.js:2925 `is_active = TRUE, last_synced_at = NOW(), updated_at = NOW()`（學員），整段 _syncCanonicalZ01Record 沒有任何 reactivate 參數。
- 註：原清單第 42 條把這條標成 implemented「背景排程不行」——只對 parentSync 那條路成立。更糟的是 cron 的註解明寫 `reactivate:false（不復活本地已軟刪的家長）`（server/cron/index.js:467），但 02:30 實際呼叫的 pullParentsStudentsFromRagic → _reconcileZ01FromShadowImpl → _syncCanonicalZ01Record 根本沒走 parentSync。業務後果具體：櫃檯停用的學員在家長端會消失（parents.js:106 只列 is_active），隔天又出現；而家長想自己重新加回來時會被擋在 409 STUDENT_INACTIVE_CONTACT_COUNTER（parents.js:631-636）。**此條未實跑驗證，是讀兩支 SQL 比對推得。**

**2. 同一份 Z01 資料，寫回 Ragic 的規則在兩條路上是相反的：註冊／認領路線走「白名單七欄 + 只填空白（聯絡欄位須本人驗證才可覆蓋）」；而家長改個資、櫃檯改檔、每日備份走的 writeback 路線，是把姓名、館別、電話、身分、性別、Email、住家電話、LINE ID、住家地址整組九個欄位無條件送上去覆蓋，另外還被強制補上第十欄 LINE UID。結果是：同一位家長，用註冊流程碰不到的欄位，改個資按一下就整組蓋掉 Ragic 上的值。**

- 誰能做：家長自己（PATCH /me）、櫃檯（後台編輯）、系統（每日備份）都走覆蓋那一條
- 依據：入口A（只填空白）server/services/parentRegistrationProfile.js:42 `if (oldText && !(contact && ownershipVerified)) return null;`；入口B（整筆覆蓋）server/services/ragicWriteback.js:54-64 `const payload = { [ragic.FIELD.Z01.PARENT_NAME]: row.name || '', [ragic.FIELD.Z01.VENUE]: venueName || …, [ragic.FIELD.Z01.PHONE]: row.phone || '', [IDENTITY], [GENDER], [EMAIL], [HOME_PHONE], [LINE_ID], [HOME_ADDRESS] };` 後接 ragicWriteback.js:65 `await ragic.syncParentProfileStrict(row, payload)`；強制補第十欄 server/services/ragic.js:1214-1217 `payloadByFieldId = { ...payloadByFieldId, [FIELD.Z01.LINE_UID]: lineUid };`；每日備份用同一份 payload：server/services/ragicAdmin.js:2216-2227
- 註：原清單這一條成立，再補三點：(1) 覆蓋路線送的是 `row.name || ''` 這種空字串，Ragic 端必填欄收到空值會整筆 INVALID，所以本地缺值時是「整筆失敗」而不是「蓋成空」；(2) 覆蓋路線還是會擋「Ragic 上是別人的 UID」（ragic.js:1227、1233 呼叫 _assertNoZ01LineUidConflict）；(3) 覆蓋路線內建自我修復：本地 ragic_record_id 在 Ragic 查無時會用手機重查，查不到就**在 Ragic 直接新建一筆 Z01**（ragic.js:1230-1231 → resolveParentRagicRecord → ragic.js:1172 `return await createParentRagicRecord(parent);`）。要對帳「Ragic 上的資料被誰改的」時，這兩條路必須分開看。

**3. 同一件事「家長在 App 上改自己家的資料」，個資與學員走的是相反的方向：改個資是本地先寫、Ragic 失敗也存得進去（回 sync_status='pending'）；新增／編輯學員卻是先同步寫進 Ragic，Ragic 失敗就整個動作失敗（回 502／504「資料暫時無法完成同步」），家長根本存不了。**

- 誰能做：家長自己（同一個個資頁上的兩個動作，成功條件不同）
- 依據：個資（本地先寫）server/routes/parents.js:551 `last_synced_at = NULL, updated_at = NOW()` + parents.js:570 `ragicWriteback.scheduleWriteback({ … })`；學員（Ragic 先寫）server/routes/parents.js:648 `sync = await ragic.createStudentZ01Z02Strict({ parent: parentForSync, student: s, startIndex: activeCount });` 與 parents.js:714 `const sync = await ragic.updateStudentZ01Z02Strict({ parent: parentForSync, student: syncStudent });`，失敗統一走 parents.js:146-173 `ragicError()` 回 502/504
- 註：櫃檯後台改學員（customerStudents.js:220）與團購加入建學員（groupOrders.js:202）都走「本地先寫」那一邊，所以同一位學員的資料由誰動，會決定 Ragic 失敗時擋不擋得住。另外學員寫入前還有一道：家長本人 Z01 資料不完整時會先去 Ragic 補查，補不到就回 Z01_INCOMPLETE 擋住（parents.js:183-190、605）。

**4. 「本地還沒回寫的編輯不能被 Ragic 舊值蓋掉」這道保護只存在於 parentSync 這條路（登入／綁定／開場刷新）。每晚 02:30 拉回時對「已綁 UID」的家長走的是另一支 canonical import，那裡沒有這個保護：電話直接覆蓋、家長姓名只要 Ragic 有值就覆蓋、學員姓名無條件覆蓋。**

- 誰能做：系統自動（每晚 02:30，或後台手動觸發 pull）
- 依據：有保護：server/services/parentSync.js:290 `name=CASE WHEN $13::boolean AND last_synced_at IS NULL THEN name ELSE COALESCE(NULLIF($2,''),name) END,`（$13 = preservePending，同款保護套在 venue/gender/email/identity/home_phone/home_address/line_id 與學員的 parentSync.js:413-417）；沒保護：server/services/ragicAdmin.js:2844-2845 `phone = $2, name = COALESCE(NULLIF($3,''), name),` 與 ragicAdmin.js:2919 `name = $2,`（學員），整段 _syncCanonicalZ01Record 沒有任何 last_synced_at 判斷
- 註：排程鏈「推在拉之前」只縮小窗口、不移除；而 00:30 那支若因資料問題把該列隔離掉，該列就永遠處在「本地新、Ragic 舊」的狀態等著被蓋。這支 import 同時還無條件蓋 last_synced_at = NOW()（ragicAdmin.js:2855），等於把「這列還沒推上去」的旗子也一起清掉——下一輪備份不會再撈它。

**5. Ragic webhook 更新本地快照時沒有要求以數字欄位 ID 回傳（沒帶 naming='EID'），而全量拉回是帶的。家長 LINE UID 的讀取刻意只認數字欄位 1006846、不吃中文欄名，所以由 webhook 寫進快照的那一筆，讀起來會像「這位家長沒綁 LINE」。**

- 誰能做：Ragic（發 webhook 觸發）；系統自動
- 依據：webhook 側（沒帶 EID）server/services/ragicAdmin.js:4796-4798 `const record = await ragic.getRecordByRagicId(formPath, id, { ignoreFixedFilter: … }, { noCache: true });`（getRecordByRagicId 只把 params 原樣傳下去：server/services/ragic.js:387-393）；拉回側（帶 EID）ragicAdmin.js:2609 `const params = { naming: 'EID', order: '109,ASC' };`；讀取端無中文 fallback：server/config/ragicSchema.js:71-73
- 註：影響範圍的推論我重新驗過並成立：cron 的夜間拉回是全量，會先把整批 shadow 標 present_in_latest_pull=FALSE 再用 EID 覆蓋（ragicAdmin.js:2664-2669），正常情況會修正；真正會咬到的是「後台手動觸發 pull」——那條才是增量（ragicAdmin.js:3475 `const useIncremental = triggeredBy === 'manual' && !!watermark;`，且 2664 的重置被 `if (!useIncremental)` 跳過）。認領流程也直接讀 `shadow['1006846']` 當「這筆是否已綁別人」的判準（z03IdentityClaim.js:592、848），並且用它決定 skip_uid_write（z03IdentityClaim.js:692、1054），同樣受影響。**此條未實跑驗證，是兩側程式碼比對推得。**

**6. Z03 記錄的 LINE UID 欄位（line_uid_raw）在程式裡永遠是空字串——拉回時固定寫空值，讀出來也固定回空值。因此後台「Z03 升級成 Z01」時那段「若本地 Z03 已有 LINE UID，一併回寫 Ragic」的邏輯永遠不會執行，同一支函式回傳的 upgraded 也永遠是 false、事後的鏡像刷新永遠不跑。**

- 誰能做：後台使用者觸發升級；但 UID 回寫那段沒有人能觸發到
- 依據：寫入端固定空值：server/services/ragicAdmin.js:2509 `'', studentCountRaw, initialStatus, phoneCanonical, sourceUpdated.iso,`（INSERT 的第 12 個參數即 line_uid_raw，見 2472 欄位清單）；讀出端固定空值：ragicAdmin.js:3554-3556 `// Staging display data is never an identity credential. Canonical UID is read only from raw Ragic field 1006846 before a source enters Z03.` / `line_uid: '',`；死分支：ragicAdmin.js:3961-3965 `const realUid = parent.line_uid && … ? parent.line_uid : ''; if (realUid) payload[ragic.FIELD.Z01.LINE_UID] = realUid;` 與 3973-3984 `let upgraded = false; if (parent.line_uid && !…startsWith('demo:')) { … refreshed = await parentRefresh.refreshParentMirrorFromRagic({…}); upgraded = true; }`
- 註：設計上說得通（Z03 是暫存區，不該當身分憑證），但 3957-3960 與 3973 兩段註解寫的行為與實際不符，看程式的人會以為升級時會順便補 UID。升級本身仍會寫 Ragic（姓名／館別／電話／身分／性別／Email 六欄，ragicAdmin.js:3948-3967）並逐位學員回寫（3969-3971），只是 UID 那一欄碰不到。UID 實際只由家長登入／認領流程經 outbox 回寫。

**7. 註冊命中舊資料時「補資料 → 回寫 Ragic → Z03 畢業」這條整合函式已被永久停用，第一行就丟 LOCAL_FIRST_CLAIM_REQUIRED。實際走的是 local-first 的 claim + outbox。**

- 誰能做：沒有人
- 依據：server/services/ragicAdmin.js:3823-3826 `async function completeZ03Registration({…}) { const disabled = new Error('Z03 認領必須使用 local-first claim + transactional outbox'); disabled.code = 'LOCAL_FIRST_CLAIM_REQUIRED'; throw disabled;`（其後 3827-3868 整段不可達）
- 註：函式上方的 JSDoc（ragicAdmin.js:3818-3821）仍描述舊行為「回寫 Ragic 使用既有 found→update helper」。實際入口是 server/services/z03IdentityClaim.js 的 claimZ03Identity / completeTrueUidRegistration。連帶：ragic.completeParentOnRegisterInRagic（ragic.js:1113）唯一的呼叫端就是這段不可達程式（ragicAdmin.js:3854），所以那支「只填空白 + 寫 UID」的 helper 現在也是死程式。

**8. outbox 的「寫前確認 + 寫後驗證（readback）」不是每一張工作都做，而是看排入時有沒有在工作內容裡要求。要求了才會寫前確認目標記錄還在、UID 沒被別人佔走，並在寫後驗證 UID 與白名單欄位真的落地；沒要求的就直接寫、不驗。新建家長（CREATE_Z01_PARENT）那條路的寫後驗證則是無條件的。**

- 誰能做：系統自動（由排入者決定要不要驗）
- 依據：開關：server/services/ragicSyncOutbox.js:524 `const shouldReadback = forceReadback || ref.verify_readback;`，寫前 525-538、寫後 564-573 `if (shouldReadback) { … _assertReadback({ row: after, targetRecordId, expectedPatch: profilePatch, expectedUid: parent.line_uid }); }`。夜間批次的預設是不強制：ragicSyncOutbox.js:490 `forceReadback = false,`（processRagicSyncOutbox → processClaimedRagicSyncOutboxJob 不傳）；單筆重放才預設強制：ragicSyncOutbox.js:652 `forceReadback = true,`。排入端：z03IdentityClaim.js:342 `verify_readback: true`、z03IdentityClaim.js:691 `verify_readback: true`、**z03IdentityClaim.js:1053 `verify_readback: registrationCompletion`**（z03IdentityClaim.js:436 `const registrationCompletion = Boolean(parentProfile || studentInput || allowStudentAppend);`）、**server/services/parentAccountRecovery.js:396 的 payload 只有 `{ recovery_request_id, canonical_parent_id }`，完全沒有 verify_readback**。CREATE 那條無條件驗：ragicSyncOutbox.js:622 `_assertReadback({ row: await reader(recordId), targetRecordId: recordId, expectedUid: parent.line_uid });`
- 註：原清單第 27 條把這條寫成「綁定／改綁類的工作在寫入前後各讀一次」，實際不是。兩個具體缺口：(1) 帳號恢復的 REBIND 工作在夜間批次下**完全不驗**，寫前不檢查 Ragic 上現在是誰的 UID 就直接覆蓋；(2) 純認領（家長沒帶個資、沒帶學員）排出來的 BIND 工作 verify_readback=false。這也意味著「快照過期 → 寫回時會被第二道門擋下」這個安全論述，只在有帶 verify_readback 的那些工作上成立。

**9. LINE UID 回到 Ragic 的路不只 outbox 一條。家長（或櫃檯）**編輯一位既有學員**時，系統會在寫學員之前先把這位家長的 LINE UID 直接寫進 Ragic Z01；而**新增**學員不會。另外所有走 writeback／每日備份的家長回寫也都被強制附上 UID。所以「outbox 開關關著，UID 就永遠回不到 Ragic」並不成立。** 〔覆核時補上〕
- 依據：編輯學員會寫 UID：server/services/ragic.js:1457-1462 `async function updateStudentZ01Z02Strict({ parent, student }) { … await upsertParentStrict({ [FIELD.Z01.LINE_UID]: lineUid }, ragicRecordId);`（Z03 那條同款：ragic.js:1496）。新增學員不會：createStudentZ01Z02Strict（ragic.js:1450-1455）只呼叫 syncParentStudentsStrict，該函式只讀 UID 做衝突比對（ragic.js:1062-1065），不寫。writeback／備份強制附 UID：ragic.js:1214-1217 `payloadByFieldId = { ...payloadByFieldId, [FIELD.Z01.LINE_UID]: lineUid };`。程式自己也承認有第二條路：server/config/ragicSchema.js:92 `有些人有 Ragic 編號，是靠另一條直接寫入的備援補上的；備援沒跑到就整筆漏 —— 所以症狀是「有時成功有時失敗」而不是全壞。`

**10. 「本地→Ragic」的回寫在本地那筆 ragic_record_id 已失效時會自我修復，最後一步是**直接在 Ragic 新建一筆 Z01 家長**（不經 outbox、不經任何查重以外的守門）。觸發者可以是家長按一下「儲存個資」，也可以是每日 00:30 的備份。** 〔覆核時補上〕
- 依據：server/services/ragic.js:1218-1234 `let ragicRecordId = parent?.ragic_record_id || null; if (ragicRecordId) { const existing = await getParentRecordByRagicId(ragicRecordId); if (!existing) { console.warn('[parent-sync] 本地 ragic_record_id 在 Ragic 查無，改以手機重新定位', …); ragicRecordId = null; } … } if (!ragicRecordId) { ragicRecordId = await resolveParentRagicRecord({ ...parent, ragic_record_id: null }); … }`；server/services/ragic.js:1166-1172 `const record = await getParentByPhone(phone); if (record?._ragicId) return record._ragicId; console.log('[student-sync] resolveParent: Ragic 查無此家長，將新建 Z01', …); return await createParentRagicRecord(parent);`；同樣的自我修復也用在學員（ragicWriteback.js:93-94 的註解就是在講這件事）

**11. 「這是測試帳號」在家長端與寫入層的認定不一致：家長端 /me 系列只認 line_uid 以 demo: 開頭，而 Ragic 寫入層、即時回寫與每日備份還會另外擋 DEMOTEST_ 開頭。結果是 DEMOTEST_ 帳號在家長端走的是「正式路徑」（會去打 Ragic 做嚴格刷新、學員編輯 Ragic 失敗會擋住家長），但真的要寫 Ragic 時又被擋掉。** 〔覆核時補上〕

- 誰能做：系統自動（依帳號類型），但兩層判準不同
- 依據：家長端只認 demo:：server/routes/parents.js:420-421 `return String(parentRow?.line_uid || tokenLineUid || '').startsWith('demo:');` 與 parents.js:462 `&& !String(p.line_uid).startsWith('demo:')`；寫入／備份兩者都擋：server/services/ragicWriteback.js:49 與 95 `startsWith('demo:') || …startsWith('DEMOTEST_')`、server/services/ragicAdmin.js:2305-2306 與 2342-2343 `NOT LIKE 'demo:%' AND … NOT LIKE 'DEMOTEST_%'`、server/services/ragic.js:775 `if (uid.startsWith('demo:') || uid.startsWith('DEMOTEST_')) return '';`、server/config/ragicSchema.js:63 同款


#### 只在文件裡（程式沒有／不同）（7 條）

**1. 文件寫「學員比對是三層：身分證 → Ragic record id → 姓名＋生日」，程式實際只用「家庭內姓名正規化後精準相等」一層。身分證與 record id 有讀出來但沒參與比對。**

- 誰能做：系統自動
- 依據：文件：server/services/parentSync.js:344 `匹配序：(parent_id, id_number) → (parent_id, ragic_record_id) → (parent_id, name, birth_date)。`；程式：parentSync.js:373-377 `const exactNameMatches = familyRows.filter((row) => normalizeStudentName(row.name) === incomingName); if (exactNameMatches.length > 1) throw new BindConflictError('DATA_RECONCILIATION_PENDING', '同一家庭內學員姓名精準命中多筆'); matched = exactNameMatches[0] || null;`
- 註：實務後果：Ragic 上把某位學員的姓名改掉（例如改錯字），同步時會比不到既有那一列而新增一位學員；而同一家庭兩位同名學員會讓整位家長的同步丟 DATA_RECONCILIATION_PENDING。夜間 canonical import 是同樣的「只比姓名」邏輯（ragicAdmin.js:2908），這一點兩邊一致。ragicId 唯一還有用到的地方是「解除別的家長對這個 rid 的佔用」（parentSync.js:392-407）。

**2. 文件寫「權威移除：Ragic 權威清單已不含、且先前已同步過的學員，只硬刪沒有業務 FK 的本地殘留」，程式已完全不做任何刪除：破壞性收斂開關預設關，而且執行刪除的函式是空實作。文件同段提到的「待人工複核的姓名＋生日候選不可被掃掉」保護，其候選清單也是一個永遠空的陣列。**

- 誰能做：沒有人（只能在資料庫直接改）
- 依據：文件：server/services/parentSync.js:14-15 `權威移除：Ragic 權威清單已不含、且先前已同步過（ragic_record_id 非空）的學員，只硬刪「沒有業務 FK」的本地殘留`；程式：parentSync.js:176-180 `hardDeleteStudentIfSafe` 空實作回 false；永遠空的候選清單：parentSync.js:359-361 `// tier-3（name+birth）候選的既有列 id …` / `const reviewCandidateIds = [];`（我 grep 全檔只有 361 宣告、485 使用，無任何 push）
- 註：另有兩張參照規格表（STUDENT_REFERENCE_SPECS / PARENT_REFERENCE_SPECS，parentSync.js:153-174）與 _hasAnyReference（parentSync.js:141-151）也因此沒有實際作用——_hasAnyReference 全檔無呼叫端。

**3. replit.md 仍寫家長註冊是「寫 Z01 主表 + 子表格學生；子表格 dotted key 1001119_0_1001115；Z02 由 Ragic 自動產生」。實際上現行註冊是 local-first + outbox，Z01 dotted 子表寫法也已被判定為會靜默丟資料。**

- 誰能做：家長自己（實際流程）
- 依據：文件：replit.md:141 `POST /api/auth/parent-register-line → registered_and_logged_in（寫 Z01 主表 + 子表格學生；子表格 dotted key 1001119_0_1001115；Z02 由 Ragic 自動產生）`；.agents/memory/ragic-z01-z02-students.md `Z01's student subtable (stid 1001119) is NOT a writable subtable … dotted-key POST → returns SUCCESS but silently drops the rows`；現行入口 server/routes/auth.js:1542 `const localFirst = await registerNewParentLocalFirst({…})`
- 註：要修正原清單的兩句：(1) 現行學員寫入**仍然走 Z01 dotted 子表**，只是改用負數列號當「新列」並在寫後嚴格驗證——server/services/ragic.js:1084 `Object.assign(payload, buildZ01StudentPayload(student, -(ids.length + 1), true));` → 1089 POST 到 Z01 record path → 1095-1108 重讀 Z01 與 Z02 比對 student_code／姓名／家長電話，不符就丟 RAGIC_UNCONFIRMED_WRITE。所以「學員以 Z02 為主路徑」不準確，Z02 是用來確認落地的。(2) 記憶檔標的「addStudentsToParentInRagic 仍走壞掉的機制」已過期：ragic.js:1142-1150 現在轉呼叫 syncParentStudentsStrict，跟家長端走同一條含驗證的路。

**4. 文件寫的夜間排程時間與程式不符：replit.md 與多處程式註解寫拉回是 01:00／01:30、姓名掃描 01:10，程式實際是 02:30 與 02:45。**

- 誰能做：系統自動
- 依據：文件：replit.md:219 `排程 01:00（台北，排在既有 02:00 backup job 之前…）` 與 replit.md:220 `_quarantineBadZ01NamesImpl() 排程 01:10`；程式註解也過期：server/services/ragicAdmin.js:2295 `推了會在 01:30 pull 被分流進 Z03 佇列`、ragicAdmin.js:4108 `下一輪 01:00 pull`、ragicAdmin.js:3958 `不寫則每日 01:00 pull`、server/services/parentRefresh.js:216 `每晚 01:30 pull`；程式實際：server/cron/index.js:469 `scheduleTaipei('30 2 * * *'` 與 487 `scheduleTaipei('45 2 * * *'`
- 註：要更正原清單的一處引用：「推了會在 01:30 pull 被分流進 Z03」這句**不在** ragicWriteback.js:46-47（那裡現在只寫「夜間 pull」沒有時間），而是在 ragicAdmin.js:2295。備份時間（00:30）文件與程式一致；推拉順序也已從舊的「先拉後推」改成「先推後拉」（cron/index.js:442-449）。

**5. 程式註解與 replit.md 都說 Z01 的「家教系統uid」欄位 ID 可以用環境變數覆寫、並要求 production 設 RAGIC_FIELD_Z01_LINE_UID=1006846。程式裡沒有任何地方讀這個環境變數，欄位 ID 是寫死的常數。** 〔覆核時補上〕

- 誰能做：沒有人（要換欄位只能改程式）
- 依據：文件面：server/config/ragicSchema.js:47 `Z01 仍保留 env 覆寫；H01 若 Ragic 真正換欄位，必須改 code + 文件一起審核。` 與 replit.md:144 `production 必須設 REQUIRE_LINE_ID_TOKEN=1、RAGIC_FIELD_Z01_LINE_UID=1006846`；程式面：ragicSchema.js:49-52 `const LINE_UID_FIELD = { Z01: '1006846', H01: '1003633' };`（字面常數，無 env），且 `grep -rn "RAGIC_FIELD_Z01_LINE_UID" server/` 零命中。同檔 42-43 行自己也寫「禁止 env 覆寫」——檔內兩段註解互相矛盾。

**6. replit.md 說「PATCH /api/parents/me 成功後會把 ragic_z01_quarantine 對應那筆標 resolved（姓名治癒）」。現行 PATCH /me 完全沒有這段程式；唯一會標 resolved 的地方是登入／綁定時的嚴格刷新。所以家長自己在 App 上把電話佔位姓名改成真名，不會讓姓名品質追蹤那筆畢業。** 〔覆核時補上〕

- 誰能做：家長自己（但只在下次登入／綁定觸發嚴格刷新時才生效）
- 依據：文件：replit.md:220 `Z01 治癒不用另寫——PATCH /api/parents/me 早就會把改過的姓名同步寫回 Z01（syncParentProfileStrict），這次只在該次 PATCH 成功後加一段：偵測到「原本是佔位亂填名、現在被改成正常姓名」就把 ragic_z01_quarantine 對應那筆標 resolved_at（routes/parents.js）。`；程式：server/routes/parents.js:496-577 的 PATCH /me 全段沒有相關呼叫；`grep -rn markPlaceholderNameResolved server/` 只有三處——定義 server/services/ragicAdmin.js:4195、匯出 5092、唯一呼叫端 server/services/parentRefresh.js:226-228（refreshParentMirrorFromRagic，且需 markZ03Resolved=true，而 /me/sync 這條路沒傳、預設是 true 但 requireComplete=false 下仍會走到）

**7. parents.js 裡那份「家長 Z01 payload」組裝函式（唯一一份會把 LINE UID 明確放進 payload 的）已經沒有任何呼叫端，是死程式；而 ragic.js 的註解還在指示呼叫端要用它來組 payload。** 〔覆核時補上〕

- 誰能做：沒有人
- 依據：死程式：server/routes/parents.js:130-144 `function ragicParentPayload(parent, venueName) { … if (parent.line_uid) payload[ragic.FIELD.Z01.LINE_UID] = parent.line_uid; return payload; }`，`grep -n ragicParentPayload server/routes/parents.js` 只有第 130 行的定義本身；過期註解：server/services/ragic.js:1207 `payloadByFieldId：以 Field ID 為 key 的 Z01 欄位（caller 用 ragicParentPayload 組好）。`


---

本文件共 519 條規則，其中判準不一致 111 條。

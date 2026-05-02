# SurveyJS Creator 評估報告

> **評估目的**：判斷是否將 [`surveyjs/survey-creator`](https://github.com/surveyjs/survey-creator) 整合進 DAOS 家教課系統。
> **評估對象**：駿斯運動事業（夢想體育學院 DAOS）
> **撰寫日期**：2026-05-02
> **資料來源**：GitHub repo、npm registry、surveyjs.io 官方定價頁
> **TL;DR**：**不建議整合**。授權費高（$589 USD/開發者第一年起）、套件巨大（Creator 核心 unpacked 78MB）、與 DAOS 既有的 Ragic 結構化欄位耦合度低。建議先用 React 自寫表單應付目前需求，未來真有「客戶自助設計問卷」需求時再考慮 OSS 替代品（Formily 或 RJSF）。

---

## 1. 是什麼、解決什麼問題

### 1.1 SurveyJS Creator 是什麼
- **產品形態**：商用、客戶端 JavaScript / TypeScript 套件，安裝在自家 React/Vue/Angular/Knockout app 裡
- **發行方**：愛沙尼亞商 Devsoft Baltic OÜ（surveyjs.io），自 2015 年營運
- **核心能力**：
  1. 拖拉式表單設計器（admin 用）— 給後台人員「不寫程式」就能設計表單
  2. 條件邏輯 / 分支 GUI — 例如「若年齡 < 12 顯示家長簽名欄」
  3. CSS 主題編輯器 — 預覽不同配色與排版
  4. 輸出 / 輸入：JSON Schema（自家格式，**非** JSON Schema Draft 7）
  5. 搭配 **`survey-react-ui`**（MIT，免費）在前端把 schema 渲染成實際表單
- **典型流程**：
  ```
  [admin 拖拉設計] → [Creator 產出 JSON schema] → [存進你的 DB]
                                                         ↓
                              [LIFF / 前台用 survey-react-ui 渲染填答]
                                                         ↓
                              [收集答案 → 回傳後端 → 存進你的 DB]
  ```

### 1.2 它解決的「問題」
- 「**頻繁變動的表單**，你不想每次新需求都讓工程師改 React 程式碼重 deploy」
- 例：問卷、意見回饋、招募、入學申請、客製化合約資料蒐集
- 對於**欄位很穩定**的系統，它的價值會大幅縮水

### 1.3 它跟 Google Forms / Typeform 的差別
- Google Forms / Typeform：**SaaS、答案在他們家 DB**、不能完全嵌入 LIFF、品牌客製度低
- SurveyJS Creator：**self-hosted、答案完全在你家 DB**、可深度嵌入 LIFF、但要你付授權費

---

## 2. 授權與費用（重要）

### 2.1 授權形態
- **商用 EULA**（Devsoft Baltic OÜ End-User License Agreement），不是 OSS
- LICENSE 原文寫得很硬：「不同意條款者**不得 install / copy / use / evaluate**」— 連評估試裝都禁止
- **Per-developer seat**：每個寫程式的開發者都要一個 seat，端使用者（學員/家長/教練）人數無上限

### 2.2 公開定價（surveyjs.io/pricing 抓取確認）
| 方案 | 第一年（USD/dev） | 第二年起續約 |
|------|-------------------|---------------|
| **Creator 單買** | $589 | ≈$239（原價 40%） |
| Creator + PDF Generator | $949 | ≈$429 |
| Creator + PDF + Dashboard | $1,069 | — |
| Enterprise（多 dev / 客製合約）| $2,369+ | — |
| Form Library 單買（純 `survey-react-ui`） | **$0（MIT 免費）** | $0 |

### 2.3 對 DAOS 的實際成本
- 你目前**單人開發** → 1 個 seat = 第一年 USD $589 ≈ **NTD 19,000**
- 第二年起：每年 USD $239 ≈ **NTD 7,700**
- 5 年總成本估算：≈ **NTD 50,000**（約 $589 + $239 × 4）
- 若未來新增 1 名工程師再加一份

### 2.4 條款踩雷點
- **不能把 SurveyJS 拿來再賣**或包成競品（Section 5）
- **不能轉售 / 轉讓 license**（Section 3）
- 12 個月後不續約：可繼續用「當時版本」但**收不到更新**
- Redistributables 限定 `*.css, *.js, fonts/*, *.d.ts` — 部署到 production 沒問題
- **授權要記帳**：合規上要留採購記錄、發票、license key 證明

### 2.5 規避授權的「灰色地帶」（不建議）
有人會把 SurveyJS Creator 從 npm 直接裝來「先做、之後再買」。這在合規上等同侵權；對一個有正式公司名（駿斯運動事業）營運的系統來說，**強烈不建議**走這條路。被告的成本遠大於 $589。

---

## 3. 套件規模與依賴分析

### 3.1 npm registry 數據（latest = 2.5.22）
| 套件 | unpacked | license | 用途 |
|------|----------|---------|------|
| `survey-creator-core` | **78 MB** | EULA（付費）| Creator 核心（編輯器邏輯、UI controls） |
| `survey-creator-react` | 2.2 MB | EULA（付費）| Creator 的 React 包裝 |
| `survey-core` | 43 MB | **MIT** | Form Library 核心（schema 處理） |
| `survey-react-ui` | 5.1 MB | **MIT** | Form Library 的 React 渲染器 |
| **合計（Creator 全套）** | **≈128 MB** | 混合 | — |

### 3.2 對 client/admin bundle 的影響預估
- 目前 `client/admin` 只有 React + Router + Axios + Tailwind，build 後 main bundle 大概 < 200KB gzipped
- 加上 Creator 後，**lazy chunk 預估 ~700KB - 1.2MB gzipped**（不含 `ace-builds` 程式編輯器，那又是 +400KB）
- 影響：admin 後台首次載入「表單設計頁」會明顯卡 1-2 秒（4G 行動網路上更慘）
- 對策：必須 React.lazy + Suspense 包起來，只在需要時載入

### 3.3 對 client/liff bundle 的影響預估（**重要**）
- 如果 LIFF 端**只渲染表單**，可以**只裝 `survey-core` + `survey-react-ui`**（兩個都是 MIT 免費）
- LIFF 端 lazy chunk 預估 ~250KB gzipped — 還可接受
- **絕對不要**在 LIFF 端裝 Creator（既花錢又拖慢學員手機）

### 3.4 React 18 / Vite 5 相容性
- 官方 README 寫支援 React，npm peerDeps 沒鎖死版本
- 社群回報 React 18 + Vite 5 OK，但有些人遇到 SSR / hydration 問題（DAOS 是 SPA，無關）

---

## 4. 與 DAOS 整合方案草圖

### 4.1 兩種架構

#### 方案 A：Creator 全部在 admin（最常見）
```
┌─────────── admin (React + Vite) ─────────────┐
│  /admin/forms/new      ← Creator 拖拉編輯    │
│  /admin/forms/:id/edit ← Creator 拖拉編輯    │
│         ↓ 存 schema (POST /api/forms)        │
└──────────────────────────────────────────────┘
                       ↓
              Postgres `forms` table
              (id, title, schema JSONB, owner_id, ...)
                       ↓
┌─────────── liff (React + Vite) ──────────────┐
│  /liff/form/:id  ← survey-react-ui 渲染填答   │
│         ↓ 提交 (POST /api/form-responses)    │
└──────────────────────────────────────────────┘
                       ↓
              Postgres `form_responses` table
              (id, form_id, user_id, answers JSONB, ...)
```
- admin 端裝 `survey-creator-react`（**付費**）
- liff 端只裝 `survey-react-ui`（免費）
- 新增 server route：`POST/GET /api/forms`、`POST/GET /api/form-responses`

#### 方案 B：Creator 寫在獨立內部工具（省 bundle）
- 把 Creator 拆到一個獨立小頁面 `/admin/forms-editor`，跟主 admin 分開 build
- 優點：主 admin bundle 不被 Creator 拖大
- 缺點：要多維護一個 build target

**推薦**：若真要做，**方案 A + lazy load**

### 4.2 與 Ragic 對接策略（重要難題）

DAOS 現有資料分工（`docs/architecture_v7.md` §四）：

| 資料 | 儲存位置 |
|------|----------|
| 教練、場館 | Ragic H01/H05（**唯讀**） |
| 家長 Z01、學員 Z02 | Ragic ↔ 系統（**雙向同步**） |

**SurveyJS Creator 跟 Ragic 對接的天然摩擦**：
1. **schema 的擁有者是誰？** — Ragic 表單欄位是 Ragic 後台手動建的；SurveyJS schema 是 Creator 拖出來的。如果讓 Creator 設計的問卷答案要回寫到 Z01/Z02，**就會出現「兩個地方都能改 schema」的雙頭馬車**
2. **field 命名衝突** — Ragic 欄位是中文（如「身分證字號」「行動電話」），Creator schema 是英文 key（如 `idNumber`、`phone`），**需要額外的 mapping 表**
3. **Field ID 寫回的設計目標被破壞** — 你原本就有任務在規劃「改用 Field ID 寫回 Ragic 避免中文欄位被改名失效」，引入動態 schema 會讓這層更難設計
4. **適用面窄** — Creator 真正適合的是「不對應 Ragic 欄位、純粹蒐集資料」的場景，例如：
   - 學員入學意願調查
   - 課後滿意度問卷
   - 教練年度評鑑表
   - 一次性活動報名（夏令營、親子日）

**建議的對接邊界**：
> SurveyJS 設計的問卷**只存 Postgres**，不寫進 Ragic。如果某些答案需要進 Ragic，由後端寫一個明確的 mapping function（如 `formAnswers → upsertStudent(z02Data)`），把映射邏輯放在 server 程式碼裡而不是 schema 裡。

---

## 5. 替代方案比較

| 方案 | 授權 | 費用 | bundle | 內建拖拉編輯器 | 與 DAOS 契合 | 維護成本 |
|------|------|------|--------|----------------|--------------|----------|
| **SurveyJS Creator** | 商用 EULA | $589/dev/年 | 大（~1MB gz） | ✅ 業界最完整 | 中 | 低（買來即用） |
| **SurveyJS Form Library 單用** | MIT | 免費 | 中（~250KB gz） | ❌ 自己寫管理介面 | 中 | 中（要自做 admin） |
| **Formily（阿里巴巴）** | MIT | 免費 | 小（~400KB gz） | ✅ 有官方 designer | 高 | 中（中文文件齊） |
| **react-jsonschema-form (RJSF)** | Apache-2.0 | 免費 | 中（~600KB gz） | ❌ 純渲染器 | 中 | 高（schema 編輯要自寫） |
| **Form.io (formiojs + @formio/react)** | MIT（OSS）+ SaaS 加值 | OSS 免費；SaaS $99/月起 | **巨大**（34MB unpacked, 30+ deps） | ✅ 有 OSS designer | 低（依賴 jQuery 風格） | 中 |
| **自建 react-hook-form + Tailwind** | MIT | 免費 | 極小（~50KB gz） | ❌ 無 | **最高** | 高（每個表單都要寫） |
| **Tally / Typeform 嵌入** | SaaS | $0–29/月 | ~0（iframe） | ✅ | 低（外部頁，無法深嵌 LIFF） | 極低 |

### 5.1 三個值得認真考慮的替代品

#### A. SurveyJS Form Library 單用（不買 Creator）
- 你**自己用 React 寫一個簡單的「欄位編輯器」**（5-10 種欄位類型就夠用），輸出 SurveyJS 相容的 JSON schema
- 用 `survey-react-ui`（**免費 MIT**）渲染
- **0 元**取得 80% 的價值；只是少了「拖拉介面」

#### B. Formily（阿里巴巴出品）
- 完全 MIT、中文文件齊、含 designer
- bundle 比 SurveyJS 小一個量級
- **缺點**：在台灣社群用得少，Stack Overflow 答案少

#### C. 簡化的 react-hook-form 自建
- 你目前 DAOS 真正需要「動態表單」的場景**可能只有 3-5 個**（家長意願調查、課後問卷之類）
- 直接把這 3-5 個寫死成 React 元件，每個 < 100 行
- **總工時 < 一週**，比學 SurveyJS + 整合 + 付費還快

---

## 6. 建議結論

### 6.1 結論：**不建議整合 SurveyJS Creator**

理由排序：
1. **DAOS 現階段沒有「動態表單」的剛性需求** — 你的核心是「課程、預約、簽到、堂數、Ragic 同步」，這些欄位都是穩定的，不需要拖拉設計器
2. **與 Ragic 雙向同步的設計衝突** — Creator 的 schema 自由度跟 Ragic 的固定欄位是反向的，整合會增加長期維護負擔
3. **NTD 19,000 第一年的成本** — 對小型內部系統不划算，且要每年續訂維護
4. **Creator 78MB unpacked + 1MB gzipped chunk** — 對 admin 體驗有實質傷害，要寫 lazy load 才能緩解
5. **更便宜更好的替代品存在** — `survey-react-ui` 本身免費，缺的只是「拖拉介面」這個 UX 糖

### 6.2 短期建議（0-3 個月）
- **不裝任何套件**
- 真的遇到動態表單需求時，**用 react-hook-form + Tailwind 寫死 3-5 個常用表單**
- 把欄位 mapping 表寫進 `server/services/ragic.js` 旁邊一個新檔 `server/services/form-mapping.js`

### 6.3 中期建議（3-12 個月）
- 若課後回饋 / 滿意度問卷的需求多到「想自己改題目」，**評估免費版 SurveyJS Form Library + 自己寫個簡化版欄位編輯器**
- schema 存 Postgres，**不要回寫 Ragic**；Ragic 只存最終結構化結果

### 6.4 長期建議（一年以上）
- 若真的有「客戶自助設計問卷」這種商業需求（例如要賣給其他運動教室），**那時再認真評估付費 SurveyJS Creator**
- 屆時整合成本（買 license + lazy load + UX 整合）才會回本

### 6.5 若使用者仍想整合：必要的後續任務
若你看完仍想推進，**追加以下 follow-up tasks**（不要跟本評估混在同一任務裡）：

1. **建立 `forms` / `form_responses` 資料表 schema 與 migration**
2. **server 端新增 `/api/forms` CRUD 與 `/api/form-responses` 收集端點**
3. **client/admin 端整合 Creator + lazy load**（需先採購 license）
4. **client/liff 端整合 `survey-react-ui` 渲染**
5. **撰寫 form answer → Ragic mapping function（如有需要）**
6. **完成採購流程**（買 license、留發票、把 license key 存 secret）

---

## 7. 附錄

### 7.1 資料來源
- LICENSE 全文：https://github.com/surveyjs/survey-creator/blob/master/LICENSE
- 定價頁：https://surveyjs.io/pricing（評估日期 2026-05-02 抓取）
- npm metadata：https://registry.npmjs.org/{package-name}（即時查詢）
- DAOS 架構參考：`docs/architecture_v7.md`、`docs/ragic_api.md`、`server/services/ragic.js`

### 7.2 名詞釋義
- **EULA** — End-User License Agreement，使用者授權合約（商用版常用）
- **per-developer seat** — 每個用 SDK 寫程式的開發者都要一張授權，端使用者不算
- **Redistributables** — 可以跟你的 app 一起部署到生產環境的檔案
- **gzipped** — 經過 gzip 壓縮後的大小，瀏覽器實際下載的量
- **lazy load** — 只在使用者點到那個頁面時才下載對應的 JS chunk

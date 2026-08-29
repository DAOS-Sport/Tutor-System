cd /home/runner/workspace
rm -f patch1.py patch2.py patch3.py mut.py mut2.py walk.js probe.js probe2.js probe3.js cols.js
echo "=== 要提交的東西 ==="
git status --porcelain
git add -A
git commit -q -F - <<'MSGEOF'
註冊失敗不再是一句看不懂的話：交易錯誤留痕，並補上真正會撞到的唯一鍵

家長回報「註冊填一填就跳掉」查了好幾週查不出來，原因不在難查，
而在於根本沒有東西可查：registerNewParentLocalFirst 是新戶註冊唯一的
寫入交易，它的 catch 直接把原始錯誤換成 LOCAL_LINK_FAILED 丟出去，
沒有 log、沒有 cause。正式站的紀錄裡因此永遠只有「本地新會員 transaction
失敗」，撞在哪一張表、哪一條約束，一個字都沒有。

在 dev 用 server/scripts/registerWalkthrough.js 實際跑一次就抓到了：
  code=23505
  constraint=identity_claims_purpose_source_system_source_table_source_r_key

兩處修正：

1. 交易失敗時把 code / constraint / table / column 記下來。不記 err.detail
   —— pg 會把欄位值放進去（電話、身分證），那是個資。

2. _classifyConstraint 補上這條 5 欄唯一索引。它原本不在對照表裡，於是
   掉進兜底的 LOCAL_LINK_FAILED，而那個碼帶 retryable:false +
   loginAllowed:false —— 對家長就是一條沒有出口的死路。歸到
   DATA_RECONCILIATION_PENDING 才會走人工複核。
   （另外查證過：uq_parents_ragic_record_id 那三個名字都存在，只是以
   唯一「索引」而非 table constraint 的形式，對照表本身沒問題。）

正式站現況：294 筆 NEW_REGISTRATION claim，0 筆缺 replay 列、0 筆孤兒，
所以這條路徑目前沒有在害人。修的是「下次發生時看得見」，不是止血。

附上走查腳本：需要一台跑著的伺服器，用自簽 flowToken 走 S2→S5，
跳過的只有 LINE 的 id_token 驗證。連跑三次 21/21，涵蓋表單驗證、
落地資料、outbox、重複註冊、同電話換 LINE、以及家長自己補 Email。
單元測試 82/82，新增的對照表測試已做突變驗證（拿掉那行會紅）。
MSGEOF
git log --oneline -1 | cat


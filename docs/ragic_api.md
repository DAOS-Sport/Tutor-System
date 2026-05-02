# Ragic API 整合說明

## 整合原則（資料分工）
| 資料 | 方向 | 說明 |
|---|---|---|
| H01 教練在職狀態 | Ragic → 系統（唯讀）| 每次進入系統即時 API 查詢 |
| H05 場館清單 | Ragic → 系統（唯讀）| 每次進入系統即時 API 查詢 |
| Z01 家長資料 | Ragic ↔ 系統（雙向）| 即時雙向同步 |
| Z02 學員資料 | Ragic ↔ 系統（雙向）| 即時雙向同步 |

## API 呼叫範例

### 查詢在職教練
```
GET https://www.ragic.com/{account}/hr/1?api&在職狀態=在職
Authorization: Basic {base64(api_key)}
```

### 查詢場館清單
```
GET https://www.ragic.com/{account}/hr/5?api&履約狀態=履約中
Authorization: Basic {base64(api_key)}
```

### 依手機查詢家長
```
GET https://www.ragic.com/{account}/student/1?api&行動電話=09xxxxxxxx
```

### 新建家長記錄（回寫）
```
POST https://www.ragic.com/{account}/student/1?api
Content-Type: application/json
Body: {"家長姓名": "...", "行動電話": "09...", ...}
```

## Ragic 欄位對應表

### H01 → coaches 表
| Ragic 欄位 | coaches 欄位 |
|---|---|
| 員工編號 | ragic_employee_id |
| 姓名 | name |
| 手機 | phone |
| Email | email |
| 在職狀態 | is_active |
| 教學項目 | specialties |

### H05 → venues 表
| Ragic 欄位 | venues 欄位 |
|---|---|
| 部門編號 | id |
| 部門名稱 | name |
| 完整地址 | full_address |
| 總機構名稱 | bank_institution_name |
| 分支機構名稱 | bank_branch_name |
| 戶名 | account_holder |
| 帳號 | account_number |

### Z01 → parents 表
| Ragic 欄位 | parents 欄位 |
|---|---|
| 家長姓名 | name |
| (報)行動電話 | phone |
| (報)性別 | gender |
| (報)Email | email |
| 館別 | primary_venue_id |

### Z02 → students 表
| Ragic 欄位 | students 欄位 |
|---|---|
| 學員姓名 | name |
| 出生年月日 | birth_date |
| (學)性別 | gender |
| 身分證字號 | id_number |
| 血型 | blood_type |

# Ragic Field ID Export Archive

Purpose: keep Ragic database field definition exports under version control so field-ID changes appear in git diff before code changes ship.

Current frozen H01 fields used by the app:

| Sheet | Field | Field ID | Code Source |
|---|---|---:|---|
| H01 | 資料編號 | `3000934` | `server/config/ragicSchema.js` `H01.DATA_NO` |
| H01 | 個人LINE ID | `1003633` | `server/config/ragicSchema.js` `H01.LINE_UID` |

Policy:

- H01 staff alignment uses `3000934` in the background only.
- H01 LINE login UID reads only `1003633`.
- `400Line訊息` / `chat.line.biz` is not a UID source and is not pulled or parsed.

TODO: Chumg/HR manual step required. Download the Ragic database field definition document from Ragic admin and commit the exported file in this directory.

# 駿斯品牌色系規範

## 色彩系統（駿斯色彩計畫）

| 角色 | 色名 | Hex | CMYK | 用途 |
|---|---|---|---|---|
| 主色 | 深海藍 | `#15316a` | C100 M94 Y38 K2 | Header、主要按鈕、標題 |
| 輔助色1 | 青碧綠 | `#31aeab` | C70 M8 Y36 K0 | 次要按鈕、Active、連結、Flex 按鈕 |
| 輔助色2 | 草地綠 | `#97bf36` | C47 M6 Y92 K0 | 成功狀態、徽章、正向提示 |
| 警示色 | 橘黃 | `#e8a020` | — | 到期提醒、待處理警示 |
| 資深教練 | 金色 | `#c9a84c` | — | 資深教練專屬識別徽章 |
| 背景 | 白 | `#ffffff` | — | 頁面背景 |
| 卡片 | 淺灰 | `#f5f5f5` | — | 卡片區塊 |
| 文字 | 深灰 | `#2d2d2d` | — | 主要文字 |

## TailwindCSS 自訂色彩設定（tailwind.config.js）
```js
module.exports = {
  theme: {
    extend: {
      colors: {
        brand: {
          primary: '#15316a',
          teal:    '#31aeab',
          green:   '#97bf36',
          amber:   '#e8a020',
          gold:    '#c9a84c',
        }
      }
    }
  }
}
```

## LINE Flex Message 色彩對應
```js
const FLEX_COLORS = {
  header_default:  '#15316a',
  header_success:  '#31aeab',
  header_complete: '#97bf36',
  header_warning:  '#e8a020',
  header_senior:   '#c9a84c',
  header_danger:   '#e24b4a',
  button_primary:  '#31aeab',
  button_success:  '#97bf36',
  button_danger:   '#e24b4a',
  text_white:      '#ffffff',
};
```

## 品牌 Logo
- 品牌名稱：夢想體育學院 DAOS
- 副標：駿斯運動事業股份有限公司
- 使用位置：系統 Header、LIFF 首頁

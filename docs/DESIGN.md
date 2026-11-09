# 後台設計系統

單檔 `public/index.html`（Vanilla JS，無框架、無建置）。Tokens 定義在 `:root`，並以 `prefers-color-scheme` 提供深色模式。

## 色彩（取自 VUCA LOGO：炭灰＋香檳金）
| Token | 淺色 | 深色 | 用途 |
|---|---|---|---|
| `--bg0/1/2/3` | #f6f5f1 / #fff / #efede7 / #e6e3db | #0c0c0b / #141413 / #1c1c1a / #262624 | 頁面／列表／輸入與按下／分隔 |
| `--text / text2 / text3` | #1b1a17 / #5c5850 / #726e64 | #ecebe6 / #a3a097 / #88857d | 主文／次要／提示 |
| `--gold` | #c2ab78 | #cdb98d | **僅用於**：主要 CTA、選中狀態、品牌標記 |
| `--ok / warn / bad` | #297347 / #855a00 / #b0372a | #62b883 / #dcab47 / #ec7b6e | 狀態（只在異常時強調） |

主要文字配色組合已以腳本驗算對比度，皆達 4.5:1 以上（WCAG 2.2 AA）。

## 字體（繁中優化：字距 .01em、行高 1.6）
頁面標題 22/600 · 區塊標題 16/600 · 內文 14.5/400 · 次要 12.5/400 · 主要數據 26/500 · 操作標籤 13.5/500。
輸入框固定 16px（避免 iOS 自動縮放）。

## 間距／尺寸
4px 基準；頁面左右 16px；區塊間距 28px；列表列距 12/16px；觸控裝置所有可點元件至少 44px。
圓角：控制項 6px、列表 10px、面板 14px。

## 元件
列表列（`.row`）、分組清單（`.list`）、底部面板（`sheet()`，桌面為置中對話框）、開關（`.switch`）、分段分頁（`.tabs-h`）、篩選標籤（`.chip`）、橫幅（`.banner`）、提示（`.note`）、空狀態（`empty()`）、骨架（`.sk`）、Toast（最多 3 則、相同訊息不重複）。

## 狀態
Default／Hover（僅桌面 `@media (hover:hover)`）／Active／Focus（`:focus-visible` 金色外框）／Loading（按鈕 `aria-busy` + 轉圈）／Success／Error（欄位標紅 + 說明可採取的行動）／Disabled／Empty。支援 `prefers-reduced-motion`。

## 版面
- 手機：頂欄 + 底部分頁（含 safe-area、未處理數量徽章）。
- 桌面（≥900px）：左側欄 + 置中內容欄（696px）。
- 路由為 hash（`#/posts/settings`），支援瀏覽器返回；有未儲存修改時，離開前會確認。

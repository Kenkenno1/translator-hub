# 即時翻譯 PWA

中文（台灣國語）語音 → 13 種語言即時口譯，跑在手機瀏覽器/PWA。
基於 OpenAI `gpt-realtime-translate`（2026-05 發布）。

## 功能

- **小聲講 → 大聲翻譯**：手機麥克風收小聲說話，喇叭放出翻譯後的語音
- **13 種輸出語言**：英、日、韓、西、法、德、葡、義、俄、印地、印尼、越、中
- **30 秒無聲自動斷線**：避免連線忘記關，預算爆掉
- **計費即時顯示**：顯示本次費用（翻譯 $0.034/min + 轉錄 $0.017/min = ~$0.051/min）
- **PWA 可安裝**：加入主畫面當原生 APP 用
- **可離線開啟外殼**：Service Worker 快取 UI，但翻譯本身仍需網路

## 架構

```
Phone PWA ──POST /session──▶ Cloudflare Worker ──/realtime/translations/client_secrets──▶ OpenAI
   │                              │
   │◀────── ephemeral token ──────┘
   │
   └──WebRTC SDP/audio──▶ /v1/realtime/translations/calls (gpt-realtime-translate)
```

Worker 負責 mint 短效 token，PWA 直接用 token 跟 OpenAI 建 WebRTC。
**PWA 不會看到真正的 OPENAI_API_KEY。**

## 部署步驟

### 1. 部署 Cloudflare Worker（mint token 用）

```bash
cd worker
npm install -g wrangler        # 第一次才需要
wrangler login                  # 登入 Cloudflare 帳號
wrangler secret put OPENAI_API_KEY   # 貼你的 OpenAI key (sk-...)
wrangler secret put APP_PIN          # 自訂一組長亂碼 (16+ 字元)
wrangler deploy
```

部署完會給你一個 `https://voice-translator-token-minter.<your-subdomain>.workers.dev` URL。此專案目前已在前端固定使用既有 Worker URL；若你重做自己的部署，請同步更新 `app.js` / `index.html` 的 Worker URL。

### 2. 部署 PWA 到 GitHub Pages

把 `voice_translator_pwa/` 整包推到 `kenkenno1.github.io/translator-hub/voice-translator/` 下（或你習慣的路徑）。
Pages 啟用後就會有 HTTPS 網址。

可以用既有的 push-to-hub skill：
```
/push-to-hub
```

### 3. 第一次使用

1. 手機瀏覽器開 PWA URL（HTTPS 必需，否則麥克風用不了）
2. 自動跳出設定：
   - **Worker URL**：已固定、唯讀，不需要手填
   - **PIN**：填入步驟 1 設定的 APP_PIN
   - 無聲自動斷線秒數：預設 30 秒
   - 麥克風模式：Whisper（小聲講）/ Studio（乾淨環境）
3. 點「測試 Worker 連線」確認 token mint 正常
4. 點「🔊 喇叭測試」確認音訊有從**大喇叭**（不是聽筒）出來
   - 如果聲音很小 → 表示 iOS 把音訊路由到聽筒了。改用 Safari 分頁、藍牙喇叭或耳機
5. 選翻譯目標語言，按麥克風大圓鈕，開始講話

### 4. 安裝到主畫面（可選）

- **iOS Safari**：分享 → 加入主畫面
- **Android Chrome**：選單 → 安裝 APP / 加入主畫面

## 重要使用注意

### 🔴 30 秒無聲自動斷線

只要 30 秒沒講話就會自動斷線。這是**故意的**，避免你忘記關連線、整個小時被計費。
要繼續就再點麥克風重新開始。

### 💰 計費

- 翻譯模型：$0.034/分鐘
- 轉錄模型：$0.017/分鐘（顯示中文原文用）
- 合計：約 $0.051/分鐘 ≈ NT$1.65/分鐘
- UI 即時顯示本次費用，斷線時也會顯示總共多少

### 🔊 iOS 聲音路由

iOS 在某些情況會把 WebRTC 音訊當成「電話音訊」走聽筒（小聲）而不是大喇叭。
**喇叭測試**就是用來檢查這個。如果測試聲音小：

1. 從 PWA 模式切回 Safari 分頁打開（很多時候就解決了）
2. 連藍牙喇叭
3. 插耳機（聲音去耳機）

### 🔒 安全

- Worker 用 PIN 擋公開 abuse；PIN 不安全 = 任何人可以打你的 OpenAI 額度
- PIN 存在手機 localStorage（明文）。手機掉了要記得到 Cloudflare 換 PIN
- CORS 鎖死 `https://kenkenno1.github.io`，本地測試會放寬到 localhost

## 開發 / 本地測試

### Worker 本機跑

```bash
cd worker
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars 填入真值
wrangler dev    # 在 http://localhost:8787
```

### PWA 本機跑

需要 HTTPS 或 localhost 才能用 getUserMedia。最簡單：

```bash
# 在 voice_translator_pwa/ 根目錄
python -m http.server 8000
# 然後設定裡 Worker URL 填 http://localhost:8787
```

開 `http://localhost:8000` 即可。

## 改 PWA 外殼後必須做的事 ⚠️

每次修改 `index.html`、`app.js`、`styles.css`、`manifest.webmanifest`、`sw.js`、icons 任何一個之後，**必須在 `sw.js` bump `CACHE_NAME`**：

```js
// sw.js
const CACHE_NAME = 'voice-translator-v1';   // → v2, v3, ...
```

不 bump 的後果：使用者已經安裝的 PWA 會繼續從舊 cache 讀檔，看不到新版。Service Worker 用 cache-first 策略服務 same-origin 請求，cache key 是 `CACHE_NAME`。新 SW 啟動時會自動清掉舊 cache（看 `activate` handler），但前提是 `CACHE_NAME` 要不一樣它才知道是新版。

建議流程：
1. 改 shell 檔
2. `sw.js` 改 `CACHE_NAME` 數字 +1（或用日期 `voice-translator-2026-05-11`）
3. push 到 GitHub Pages
4. 使用者下次開 PWA → 新 SW install → activate → claim clients → 立刻服務新版

## iOS 注意事項詳解

iOS Safari 對 WebRTC + audio 路由有歷史問題，**安裝成 PWA 後尤甚**：

1. **Audio 可能走聽筒不走大喇叭**：當 mic 啟用 + audio 同時播放，iOS 會把整個 audio session 當「電話對話」處理，把輸出路由到聽筒（小聲）。沒辦法用程式強制改回大喇叭。
2. **解法**：
   - **第一次使用 → 必跑「🔊 喇叭測試」**。測試會用真實 session 的條件（mic active + audio element）放一聲嗶聲，聽得到就 OK
   - 如果嗶聲很小：**不要按麥克風開始翻譯**。改用：
     - Safari 分頁直接開（不要當 PWA 安裝）
     - 連藍牙喇叭
     - 插耳機
3. **iOS PWA 偵測**：APP 進來會用 `display-mode: standalone` 偵測，自動顯示警告 banner
4. **WebKit `getUserMedia` 在 standalone 模式有 bug 紀錄**（`bugs.webkit.org/show_bug.cgi?id=273938`），如果麥克風完全失效，回去 Safari 分頁試

## 檔案說明

```
voice_translator_pwa/
├── index.html              UI 結構
├── app.js                  WebRTC + 無聲偵測 + 狀態管理
├── styles.css              手機優先深色主題
├── manifest.webmanifest    PWA manifest（可安裝）
├── sw.js                   Service Worker（快取外殼）
├── icon.svg                向量 icon（現代瀏覽器用）
├── icon-192.png            PWA icon (Android/iOS)
├── icon-512.png            PWA icon (splash screen)
├── _gen_icons.py           PNG icon 產生器（一次性執行）
├── README.md               本檔
└── worker/
    ├── worker.js           Cloudflare Worker（mint token）
    ├── wrangler.toml       Worker config
    ├── .dev.vars.example   本機 secret 範本
    └── .gitignore
```

## 已知問題 / 待測

- iOS PWA standalone 模式下 WebRTC 偶有 bug，APP 內已加警告 banner（標示「先按喇叭測試」）
- Translation endpoint 不發 VAD events（已驗證 OpenAI 官方文件），client-side RMS detection 是唯一的 silence/budget guard
- RMS baseline 校準在使用者邊講話邊連線時會把 threshold 推高，但設計上偏保守（threshold 高 → 更容易斷線 → 預算更安全）
- 計費精確值需上線後跟 OpenAI 帳單對帳
- Worker rate limit 用 in-memory `Map`，屬於 per-isolate best-effort：多個 Cloudflare isolates 會稀釋 hit count，cold start 也會清空（個人用可接受，要硬上限需升 KV/DO）

## 版本

- **v1.1.8** — 2026-05-10 — 使用者介面改成英文：主畫面、settings drawer、toast/error 文案、manifest/PWA 名稱與空 transcript placeholder 全部英文化；`CACHE_NAME` bump 至 `voice-translator-v10`。
- **v1.1.7** — 2026-05-10 — Worker upstream JSON parse hardening（OpenAI 200/非 JSON 時回 `502 upstream_invalid_json`）、`startSession` cancellation token（避免 connecting 期間取消後舊 async flow 又啟動付費 WebRTC session）、remote audio `play()` 失敗 toast、live/connecting/closing 鎖住目標語言、Service Worker 只清 `voice-translator-*` cache 避免刪同 origin 其他 app cache；`CACHE_NAME` bump 至 `voice-translator-v9`。
- **v1.1.6** — 2026-05-10 — PIN persistence 再加保守保存路徑：`input` / `change` / `blur` 都會保存，離開頁面時若設定 drawer 開著也會同步，降低手機瀏覽器事件差異造成 PIN 沒記住的風險；`CACHE_NAME` bump 至 `voice-translator-v8`。
- **v1.1.5** — 2026-05-10 — 固定 Cloudflare Worker URL（公開部署資訊，不再要求使用者手填）；Worker PIN 仍只存在使用者裝置 localStorage，並在輸入時立即保存，做到每台裝置輸入一次後長期記住；`CACHE_NAME` bump 至 `voice-translator-v7`。
- **v1.1.4** — 2026-05-10 — 修正 v1.1.3 在 service worker 新舊檔案混搭時可能讓設定按鈕打不開的問題：移除 HTML inline `display:none`，改由 `showDrawer()` / `hideDrawer()` 在初始化、開啟、關閉時統一控制 `hidden` + `style.display`；`CACHE_NAME` bump 至 `voice-translator-v6`。
- **v1.1.3** — 2026-05-10 — 針對設定 drawer 收合再加 inline display fallback：HTML 初始 `style="display: none"`，`openDrawer()`/`closeDrawer()` 同步寫入 `style.display`，避免舊 CSS 或瀏覽器對 `[hidden]` 的處理差異造成側欄看似關不掉；`CACHE_NAME` bump 至 `voice-translator-v5`。
- **v1.1.2** — 2026-05-10 — 修復 `hidden` attribute 被 component CSS `display` 規則覆蓋的問題，加入全域 `[hidden] { display: none !important; }`，讓設定 drawer、backdrop、toast/banner 等 UI 能可靠收合；`CACHE_NAME` bump 至 `voice-translator-v4`。
- **v1.1.1** — 2026-05-10 — 設定表單同步 hardening：測試 Worker 連線、喇叭測試、開始翻譯前都會先把 drawer 內的 Worker URL / PIN / mic mode / silence timeout 寫回 settings + localStorage，避免「測試成功但未關設定」時下一步仍讀舊設定；`CACHE_NAME` bump 至 `voice-translator-v3`。補準 Worker rate limit caveat：in-memory limiter 是 per-isolate best-effort，不是全域硬上限。
- **v1.1.0** — 2026-05-10 — Patch series A-F：silence contract（RMS baseline + p90 校準 + 移除 dead VAD/transcript fallback）、warning timer leak fix、cost meter 10s 保留、graceful `session.close`（user_stop 2s window）、worker rate limit reorder + 2KB body cap、speaker test 改 mic+audio element 模擬真實 routing、iOS banner 加強、CACHE_NAME 治理。備份：`app(backup-2026-05-10-v1.0.0).js`
- **v1.0.0** — 2026-05-10 — 初版（6 個 patch 之前的 baseline）

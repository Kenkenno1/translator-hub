# Voice Translator PWA 再現規格書

版本：v1.0  
日期：2026-05-10  
語言：台灣華語  
目的：讓 Codex、Claude Code、其他 LLM coding agent 或人類開發者可以依照本文件重做一個功能等價的手機 PWA。

---

## 0. 給 LLM 的使用說明

這份文件不是產品介紹，也不是 README。它是「再現規格」：請依照它重建同等功能，而不是自由發想新產品。

實作時請遵守：

- 先做可運作的 PWA + Worker + WebRTC 翻譯主流程，再做 UI polish。
- 不要把 OpenAI API key 寫進前端。
- 不要把 APP_PIN 寫死在公開前端。
- Worker URL 可以是公開部署值；PIN 必須由使用者在裝置上輸入一次並存在 localStorage。
- 不要假設 OpenAI translation endpoint 會發 VAD events；無聲預算保護只能依賴 client-side RMS。
- 每次修改 PWA shell 檔案時，必須 bump service worker `CACHE_NAME`。
- 實機測試比靜態檢查重要；手機喇叭路由、麥克風、WebRTC、無聲斷線都必須實測。

本文件中的「目前部署值」是現有專案的狀態；若要複製成新專案，請替換成新專案自己的值。

---

## 1. 產品企畫書

### 1.1 產品一句話

手機 PWA，使用者小聲講中文（台灣國語）後，透過 OpenAI Realtime Translation 即時翻譯成指定語言，並從手機大喇叭播放。

### 1.2 目標使用者

- 需要臨場口譯輔助的人。
- 希望用手機直接完成語音輸入、翻譯、外放的人。
- 可能在公共場合小聲講中文，因此麥克風模式要支援 whisper-like input。
- 使用者不一定是工程師，所以設定流程要盡量少。

### 1.3 核心價值

- 不需要安裝 native app。
- 不需要把 OpenAI API key 放在手機前端。
- 使用 WebRTC 直接連 OpenAI，降低延遲。
- 30 秒預設無聲自動斷線，降低忘記關閉造成的成本風險。
- 可安裝成 PWA，並保留離線開啟 shell 的能力。

### 1.4 v1 必備功能

- 手機優先 PWA UI。
- Cloudflare Worker mint ephemeral token。
- Browser 透過 WebRTC 連 OpenAI `/v1/realtime/translations/calls`。
- 支援 13 種目標語言。
- 顯示中文原文 transcript。
- 顯示目標語言 transcript。
- 播放翻譯後 audio。
- 喇叭測試，協助判斷 iOS 是否走大喇叭。
- RMS client-side 無聲偵測。
- 可調 silence timeout，預設 30 秒。
- 手動停止時送 `session.close` 做 graceful flush。
- silence/error 時立即斷線保預算。
- Cost meter 顯示估算費用。
- PIN 在本機保存，使用者輸入一次即可。

### 1.5 v1 不做

- 多人對話模式。
- 長期 transcript history。
- 使用者帳號系統。
- 真正全域 hard rate limit。
- OpenAI 帳單 API 對帳。
- 後台 dashboard。
- 多裝置同步 PIN。

---

## 2. 系統架構

### 2.1 高階架構

```text
手機瀏覽器 / PWA
  |
  | HTTPS POST /session
  v
Cloudflare Worker token minter
  |
  | 使用 server-side OPENAI_API_KEY
  | POST /v1/realtime/translations/client_secrets
  v
OpenAI Realtime Translation client secret
  |
  | ephemeral token 回傳給瀏覽器
  v
手機瀏覽器建立 RTCPeerConnection
  |
  | SDP offer + ephemeral token
  v
OpenAI /v1/realtime/translations/calls
  |
  | remote audio track + data channel server events
  v
手機播放翻譯音訊 + 顯示 transcript
```

### 2.2 前端責任

前端負責：

- 取得麥克風。
- 建立 WebRTC peer connection。
- 把 local mic track 加到 peer connection。
- 接收 OpenAI remote audio track 並指定給 `<audio>`。
- 開啟 data channel 接收 transcript / session events。
- 執行 RMS 無聲偵測。
- 控制 silence timeout / graceful close / cleanup。
- 管理 UI 狀態、settings、localStorage、cost meter。
- 註冊 service worker。

前端不得：

- 持有 OpenAI API key。
- 將 APP_PIN 寫死到公開程式碼。
- 依賴 server VAD events。

### 2.3 Worker 責任

Worker 負責：

- 提供 `GET /` health check。
- 提供 `POST /session`。
- 驗證 APP_PIN。
- 驗證 target language。
- 呼叫 OpenAI client secrets endpoint。
- 回傳 ephemeral token 給前端。
- CORS 限制部署 origin。
- body size cap。
- best-effort per-IP rate limit。

Worker 不負責：

- 傳送使用者音訊。
- 代理 WebRTC media。
- 儲存 transcript。
- 計算真實帳單。

---

## 3. 部署值與可替換值

本文件用三種標籤區分值的性質：

- `[合約值]`：實作合約，重做時應照規格保留，除非整體設計也一起重審。
- `[部署值]`：目前專案的部署值，重做成新專案時要替換。
- `[私密值]`：secret 或個人憑證，永遠不可寫入公開前端或公開 repo。

### 3.1 目前部署值

目前專案的公開 PWA：

```text
[部署值]
https://kenkenno1.github.io/translator-hub/voice-translator/
```

目前專案的 Worker URL：

```text
[部署值]
https://voice-translator-token-minter.lucky0623.workers.dev
```

目前 service worker cache name：

```js
[部署值]
const CACHE_NAME = 'voice-translator-v9';
```

### 3.2 新專案必須替換的值

若複製成新專案，請替換：

- GitHub Pages URL。
- Cloudflare Worker name。
- Worker URL。
- Cloudflare account。
- `ALLOWED_ORIGIN`。
- `DEFAULT_WORKER_URL`。
- `wrangler.toml` 內的 Worker name。
- `[私密值]` `OPENAI_API_KEY` secret。
- `[私密值]` `APP_PIN` secret。

### 3.3 絕對不能複製到公開 repo 的值

不得提交：

- OpenAI API key。
- APP_PIN 明文。
- `.dev.vars`。
- 任何含 secret 的 terminal log。

---

## 4. 檔案結構

建議重建時使用下列結構：

```text
voice_translator_pwa/
├── index.html
├── app.js
├── styles.css
├── sw.js
├── manifest.webmanifest
├── icon.svg
├── icon-192.png
├── icon-512.png
├── _gen_icons.py
├── README.md
├── DEPLOY_SMOKE_TEST_CHECKLIST.md
├── VOICE_TRANSLATOR_REPRODUCTION_SPEC.md
└── worker/
    ├── worker.js
    ├── wrangler.toml
    ├── .dev.vars.example
    └── .gitignore
```

### 4.1 `index.html`

提供：

- PWA meta tags。
- manifest link。
- stylesheet link。
- hidden `<audio id="translated-audio" autoplay playsinline>`。
- 主畫面按鈕與狀態 UI。
- transcript panels。
- settings drawer。
- iOS standalone warning banner。
- toast container。

重要 DOM ids：

```text
mic-btn
mic-hint
silence-ring-fg
state-pill
cost-meter
cost-value
cost-duration
target-lang
target-lang-label
speaker-test-btn
src-text
dst-text
translated-audio
ios-standalone-banner
settings-toggle
settings-close
settings-drawer
drawer-backdrop
cfg-worker-url
cfg-pin
cfg-silence
cfg-silence-out
test-connection
test-connection-result
toast
```

### 4.2 `app.js`

核心前端邏輯：

- settings/localStorage。
- WebRTC。
- RMS 無聲偵測。
- graceful close。
- speaker test。
- cost meter。
- service worker registration。

localStorage：

```js
[合約值：若要相容同 origin 既有資料，請保留]
const SETTINGS_KEY = 'vt_settings_v1';
```

新專案可自行命名 settings key，但若是在同一個 origin / path 上替換既有部署，改名會讓使用者已保存的 PIN 與設定失效。

### 4.3 `worker/worker.js`

Cloudflare Worker：

- `/session` token minter。
- PIN compare。
- CORS。
- body cap。
- best-effort rate limit。
- OpenAI client secret request。

### 4.4 `sw.js`

Service Worker：

- install 時 cache app shell。
- activate 時刪舊 cache。
- same-origin GET cache-first。
- cross-origin / non-GET bypass。
- navigation fallback to `index.html`。

---

## 5. 前端功能規格

### 5.1 初始狀態

頁面載入後：

- state = `idle`。
- silence ring reset。
- settings controls 從 localStorage hydrate。
- Worker URL 固定為 `DEFAULT_WORKER_URL`。
- init 同步執行 iOS standalone 偵測，必要時顯示 warning banner。
- `window.load` 後註冊 service worker。
- 若 PIN 尚未設定，600ms 後自動打開 settings drawer。

### 5.2 Settings

Settings drawer 包含：

- Cloudflare Worker URL（固定、readonly）。
- Worker PIN（password input）。
- silence timeout slider：10 到 120 秒，step 5 秒。
- mic mode radio：
  - `whisper`
  - `studio`
- 測試 Worker 連線按鈕。

Worker URL 是公開部署值，可以寫進前端。

PIN 是私密值，不可寫死在前端。PIN 只可：

- 由使用者輸入。
- 存在同裝置同 origin 的 localStorage。
- 送到 Worker `/session` 做驗證。

PIN 保存條件：

不能只靠 form submit 或單一 `change` 事件保存。手機瀏覽器，特別是 iOS Safari，可能在使用者切 app、關 PWA、或未正式 blur input 時不觸發某些事件。因此 PIN 保存路徑刻意冗餘：每個合理保存點都要寫上。

- `input`
- `change`
- `blur`
- 關閉 settings drawer。
- pagehide 時若 drawer 開著。
- 開始翻譯前。
- 喇叭測試前。
- 測試 Worker 連線前。

### 5.3 Worker 連線測試

按下「測試 Worker 連線」時：

1. 同步 settings。
2. `GET {workerUrl}/` health check。
3. `POST {workerUrl}/session`：

```json
{
  "targetLanguage": "en",
  "pin": "<APP_PIN>"
}
```

成功條件：

- HTTP 200。
- JSON response 有 `ephemeral`。

UI 顯示：

- 成功：提示已取得 ephemeral token，但只顯示短前綴。
- 失敗：顯示 HTTP status 與 error code。

注意：這會 mint 一個 ephemeral token，但不會開始 WebRTC session。

### 5.4 語言選擇

支援 13 種 output language：

```text
en, es, pt, fr, ja, ru, zh, de, ko, hi, id, vi, it
```

UI label：

```js
{
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  it: 'Italiano',
  ru: 'Русский',
  hi: 'हिन्दी',
  id: 'Indonesia',
  vi: 'Tiếng Việt',
  zh: '中文'
}
```

`target-lang` 在 `connecting` / `live` / `closing` 期間必須 disabled。目標語言是在 mint token / SDP session 建立時固定，不能讓 UI label 先切到新語言而實際 session 仍輸出舊語言。

### 5.5 麥克風模式

`whisper` 模式：

```js
{
  echoCancellation: true,
  // 故意關閉。手機 noise suppression 可能把小聲講話的氣音吃掉；
  // whisper mode 依靠 AGC 補強音量，但不做瀏覽器端消音。
  noiseSuppression: false,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 24000
}
```

用途：小聲講話、手機環境。

`studio` 模式：

```js
{
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 24000
}
```

用途：乾淨環境或外接設備。

`sampleRate: 24000` 是 advisory；瀏覽器/WebRTC 仍可能自行 resample。連線後要 log `track.getSettings()` 方便實機 debug。

---

## 6. WebRTC 翻譯流程

### 6.1 開始 session

使用者按 mic：

1. 同步 settings。
2. 若 PIN 空白，打開 settings drawer。
3. state -> `connecting`。
4. reset cost meter。
5. `getUserMedia({ audio: buildMicConstraints() })`。
6. POST Worker `/session` 取得 ephemeral。
7. 建立 `RTCPeerConnection`。
8. 加入 mic track。
9. 收 remote track，指定給 `<audio>`。
10. 建立 data channel `oai-events`。
11. create offer。
12. `setLocalDescription(offer)`。
13. POST SDP offer 到 OpenAI。
14. 收 answer SDP。
15. `setRemoteDescription(answer)`。
16. state -> `live`。
17. start cost meter。
18. start silence timer。
19. start RMS analyser。
20. request wake lock。

`startSession()` 必須有 cancellation token。若使用者在 `connecting` 期間再次按 mic 取消，舊 async flow 必須在 `getUserMedia`、Worker fetch、SDP POST 前後檢查 token；尤其要在 POST SDP 到 OpenAI 前 bail，避免使用者以為取消但舊 flow 又開啟付費 WebRTC session。

### 6.2 OpenAI WebRTC endpoint

SDP exchange endpoint：

```text
POST https://api.openai.com/v1/realtime/translations/calls
Authorization: Bearer <ephemeral>
Content-Type: application/sdp
Body: <local offer SDP>
```

重要：此 endpoint 不加 query string。

### 6.3 Data channel server events

Translation endpoint 已知事件：

```text
session.input_transcript.delta
session.output_transcript.delta
session.output_audio.delta
session.created
session.updated
session.closed
error
```

處理規則：

- `session.input_transcript.delta`：append 到中文原文區。
- `session.output_transcript.delta`：append 到譯文區。
- transcript delta 視為強 speech signal，呼叫 `onSpeechActivity()`。
- `session.output_audio.delta` 不需要手動播放，WebRTC remote track 已處理音訊。只 log 第一次。
- remote track 指到 `<audio>` 後要呼叫 `audio.play()`；若被瀏覽器 autoplay policy 擋下，要 toast 告知使用者音訊沒播放但翻譯仍在進行、仍會計費。
- `session.closed`：resolve graceful close waiter。
- unknown event：console.log，避免未來 API 變更完全無聲。

不應再處理：

```text
input_audio_buffer.speech_started
input_audio_buffer.speech_stopped
conversation.item.input_audio_transcription.delta
response.audio_transcript.delta
response.output_audio_transcript.delta
```

原因：這些不是 current translation endpoint 的 server event 合約。

---

## 7. 無聲偵測與預算保護

### 7.1 設計前提

OpenAI Realtime Translation endpoint 不發 VAD events。

因此：

- Translation endpoint 完全不發 `input_audio_buffer.speech_started` / `input_audio_buffer.speech_stopped`。
- 唯一的 silence/budget guard 是 client-side RMS。
- 不要寫 server VAD 處理路徑；在 translation endpoint 上那會是 dead code。

### 7.2 常數

```js
const RMS_NOISE_FLOOR = 0.012;
const RMS_K = 2.5;
const RMS_BASELINE_FRAMES = 5;
const RMS_SPEECH_FRAMES_REQUIRED = 3;
const RMS_CHECK_INTERVAL_MS = 200;
```

### 7.3 Baseline phase

連線後前 1 秒：

- 每 200ms 收一個 RMS sample。
- 共 5 frames。
- 不觸發 speech activity。
- 排序後取 p90。
- 5 samples 時 p90 會退化成 max，這是可接受的保守設計。
- threshold = `max(p90 * RMS_K, RMS_NOISE_FLOOR)`。

### 7.4 Active phase

每 200ms：

- RMS > threshold：`rmsConsecutiveAbove += 1`。
- 達到 3 個連續 frame 後，呼叫 `onSpeechActivity()`。
- 低於 threshold：counter reset。
- 達標後持續講話時，每個 above-threshold frame 都可 reset silence timer。

### 7.5 Silence timeout

預設 30 秒，可調 10-120 秒。

timeout 行為：

- `stopSession('silence')`
- 直接 cleanup / close peer connection。
- 不走 graceful `session.close`。

原因：silence timeout 是預算保護，必須優先切斷。

### 7.6 Warning ring

UI ring：

- `stroke-dashoffset` 從 578 到 0。
- duration = silence timeout。
- 最後 10 秒加 warning class。
- 每次 speech activity 重啟 timer 時必須清掉舊 warning timeout。

---

## 8. 停止與 cleanup

### 8.1 State machine

```text
idle
  -> connecting
  -> live
  -> closing
  -> idle

live
  -> silenced
  -> idle

live / connecting
  -> error
  -> idle
```

狀態：

- `idle`：待機。
- `connecting`：正在取 mic、token、SDP。
- `live`：正在翻譯。
- `closing`：使用者手動停止後，等待 server flush。
- `silenced`：無聲自動斷線。
- `error`：錯誤狀態。

### 8.2 User stop

使用者在 live / connecting 時按 mic 停止：

- 若 data channel open 且 reason 是 `user_stop`：
  - state -> `closing`
  - 立即清 silence/RMS/warning timers
  - send data channel event：

```json
{ "type": "session.close" }
```

  - 等 `session.closed` 或 2000ms timeout。
  - cleanup。
  - state -> `idle`

- 若不是 user stop，跳過 graceful。

### 8.3 Graceful timeout

```js
const GRACEFUL_CLOSE_TIMEOUT_MS = 2000;
```

timeout 不應卡住 UI，不 reject。

### 8.4 Cleanup 必須處理

- clear RMS timer。
- clear silence timer。
- clear warning timer。
- stop mic tracks。
- close data channel。
- close peer connection。
- clear remote audio `srcObject`。
- close AudioContext。
- clear cost timer。
- clear cost meter hide timer。
- `gracefulCloseResolver = null`。
- release wake lock。
- reset `_loggedAudioDelta`。
- reset RMS phase state。

cleanup 應該是 idempotent，可以被錯誤路徑、手動停止路徑、connection lost 路徑重複呼叫而不拋錯。

### 8.5 Cost meter

費用估算：

```js
const PRICE_TRANSLATE_PER_MIN = 0.034;
const PRICE_WHISPER_PER_MIN = 0.017;
const PRICE_PER_SEC_TOTAL =
  (PRICE_TRANSLATE_PER_MIN + PRICE_WHISPER_PER_MIN) / 60;
```

顯示：

- live 時每秒更新。
- 斷線後保留約 10 秒。
- label 改為「本次費用（已結束）」。

---

## 9. 喇叭測試

### 9.1 問題背景

iOS / 手機瀏覽器可能因 mic active + audio playback 被判定為通話情境，導致聲音走聽筒而非大喇叭。

### 9.2 測試目標

讓使用者在付費 WebRTC session 前先確認輸出音訊路由。

### 9.3 實作方式

喇叭測試應：

- 僅允許在 `idle` / `silenced` / `error` 狀態執行。
- 防止 reentry。
- 呼叫 `getUserMedia()`，使用同一套 mic constraints。
- 建立 AudioContext。
- oscillator -> gain -> MediaStreamDestination。
- 把 destination stream 指給同一個 `<audio id="translated-audio">`。
- `await audio.play()`，若被 autoplay policy 擋下，顯示失敗。
- 播放 880Hz 短 tone，含 attack/release ramp。
- finally 停 mic tracks、清自己的 audio srcObject、關 AudioContext、reset running flag。

### 9.4 限制

這不是完整 WebRTC remote track 模擬。它只能覆蓋：

- mic active。
- audio 由同一 `<audio>` element 播放。

若使用者測到聽筒或聲音小，不應開始付費 session；應改用 Safari tab、Bluetooth speaker、耳機或其他輸出。

---

## 10. Worker API 合約

### 10.1 `GET /`

用途：health check。

Response：

```json
{
  "ok": true,
  "service": "voice-translator-token-minter"
}
```

### 10.2 `POST /session`

Request：

```json
{
  "targetLanguage": "en",
  "pin": "<APP_PIN>"
}
```

Success：

```json
{
  "ephemeral": "ek_...",
  "expires_at": 1778410442
}
```

Error examples：

```json
{ "error": "invalid_json" }
{ "error": "invalid_pin" }
{ "error": "invalid_target_language" }
{ "error": "payload_too_large", "max_bytes": 2048 }
{ "error": "rate_limited" }
{ "error": "upstream_invalid_json" }
{ "error": "upstream_error", "status": 400, "detail": "..." }
```

### 10.3 OpenAI client secret request

Worker 向 OpenAI 發送：

```http
POST https://api.openai.com/v1/realtime/translations/client_secrets
Authorization: Bearer <OPENAI_API_KEY>
Content-Type: application/json
```

Body：

```json
{
  "session": {
    "model": "gpt-realtime-translate",
    "audio": {
      "input": {
        "transcription": { "model": "gpt-realtime-whisper" },
        "noise_reduction": { "type": "near_field" }
      },
      "output": { "language": "en" }
    }
  }
}
```

### 10.4 OpenAI response shape

Worker 應支援兩種 response shape：

```js
const ephemeral = data.value || data.client_secret?.value;
const expires_at = data.expires_at || data.client_secret?.expires_at;
```

---

## 11. Worker 安全規格

### 11.1 Secrets

Cloudflare secrets：

```text
OPENAI_API_KEY
APP_PIN
```

設定方式：

```powershell
cd worker
wrangler secret put OPENAI_API_KEY
wrangler secret put APP_PIN
```

### 11.2 PIN compare

Worker runtime 沒有 Node 的 `crypto.timingSafeEqual`，所以需手寫 constant-time string compare。

需求：

- 不因長度不同 early return。
- loop 長度使用兩字串最大長度。
- 用 XOR 累積 diff。

### 11.3 Pre-auth order

`POST /session` 檢查順序：

1. method/path。
2. env sanity。
3. rate limit。
4. body size cap。
5. JSON parse。
6. PIN check。
7. target language check。
8. upstream OpenAI。

原因：錯 PIN 也應計入 throttle， oversized body 不應先讀完整 body。

### 11.4 Body size cap

合法 body 小於 200 bytes。cap 設為：

```js
const MAX_BODY_BYTES = 2048;
```

以 `content-length` 先擋明顯 oversized payload。

限制：missing content-length 或 chunked request 不能靠這條硬擋，只能由 runtime limit / rate limit 緩解。

### 11.5 Rate limit

目前是 Worker module-level `Map`：

```js
const rateLimitWindow = 60_000;
const rateLimitMax = 6;
const ipHits = new Map();
```

這是 best-effort，不是硬上限。

即使如此，rate limit 仍必須實作，且必須放在 PIN check 之前。它在 high-volume burst 時仍能擋下部分請求；只是不能期待低量第 7 次一定觸發 429。

限制：

- 每個 Cloudflare isolate 有自己的 `Map`。
- 多 isolates 會稀釋 hit count。
- cold start 會清空。
- 低量 6-12 次請求不一定 429。
- 高量 burst 可能部分 429。

若需要硬上限，應改用：

- Cloudflare KV：較小改動，eventual consistency 可接受。
- Durable Object：強一致，實作較重。
- Cloudflare WAF / Rate Limiting rule：平台層控制。

v1 個人使用可接受此 caveat，因為錯 PIN 不會觸發 OpenAI 成本。

### 11.6 CORS

`ALLOWED_ORIGIN` 應設為 GitHub Pages origin：

```js
[部署值：重做時替換成自己的前端 origin]
const ALLOWED_ORIGIN = 'https://kenkenno1.github.io';
```

dev 可允許：

```text
http://localhost:<port>
http://127.0.0.1:<port>
```

CORS 是 defense-in-depth，不是主要 auth；主要 auth 是 PIN。

---

## 12. Service Worker 規格

### 12.1 Cache strategy

SHELL_FILES：

```js
[
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
]
```

策略：

- install：`cache.addAll(SHELL_FILES)`。
- install 完成：`self.skipWaiting()`。
- activate：刪除舊 cache，`clients.claim()`。
- fetch：
  - non-GET bypass。
  - cross-origin bypass。
  - same-origin GET cache-first。
  - navigation offline fallback to `index.html`。

### 12.2 Cache name discipline

每次修改以下檔案都要 bump `CACHE_NAME`：

- `index.html`
- `app.js`
- `styles.css`
- `manifest.webmanifest`
- icons
- `sw.js`

不 bump 的後果：已安裝 PWA 可能永遠吃舊 shell。

目前值：

```js
const CACHE_NAME = 'voice-translator-v9';
```

新專案可用：

```js
const CACHE_NAME = 'voice-translator-v1';
```

之後每次 shell change bump 到 v2、v3。

---

## 13. UI / CSS 實作注意事項

### 13.1 `hidden` 屬性

全域必須有：

```css
[hidden] {
  display: none !important;
}
```

原因：component CSS 若設定 `display: flex`，可能覆蓋瀏覽器對 `hidden` 的預設隱藏效果，造成 settings drawer 關不掉。

### 13.2 Drawer 顯示控制

不要只依賴 `hidden`。建議同步控制：

```js
function showDrawer() {
  drawer.hidden = false;
  backdrop.hidden = false;
  drawer.style.display = 'flex';
  backdrop.style.display = 'block';
}

function hideDrawer() {
  drawer.hidden = true;
  backdrop.hidden = true;
  drawer.style.display = 'none';
  backdrop.style.display = 'none';
}
```

### 13.3 iOS banner

iOS standalone PWA 顯示提醒：

- 先按喇叭測試。
- 確認聲音從大喇叭出來。
- 再開始計費 session。
- 若聲音小或走聽筒，改 Safari 分頁或外接輸出。

不要強制阻擋使用者開始 session；只提示。

---

## 14. PWA manifest

需求：

- `display: "standalone"`
- `start_url: "./"`
- `scope: "./"`
- icons：
  - SVG any。
  - PNG 192x192。
  - PNG 512x512。
- theme color / background color 與深色 UI 相符。

---

## 15. 部署流程

### 15.1 Worker

```powershell
npm install -g wrangler
wrangler login
cd C:\Users\User\Desktop\voice_translator_pwa\worker
wrangler secret put OPENAI_API_KEY
wrangler secret put APP_PIN
wrangler deploy
```

部署後確認：

```powershell
Invoke-WebRequest https://<worker>.workers.dev/
```

### 15.2 PWA

#### 15.2.1 目前部署做法

將 PWA shell 部署到 HTTPS static hosting，例如 GitHub Pages。

目前專案做法：

- source root：`C:\Users\User\Desktop\voice_translator_pwa\`
- GitHub Pages repo subdir：`translator-hub/voice-translator/`
- Push 到 GitHub Pages。

這一段是 `[部署值]`，只是目前專案的維運參考；新專案不必沿用同一個 repo 或 path。

#### 15.2.2 新專案可選平台

新專案可選：

- GitHub Pages。
- Cloudflare Pages。
- Netlify。
- Vercel static hosting。

必須是 HTTPS，否則 mobile `getUserMedia()` / service worker 會受限。

---

## 16. Smoke Test 規格

### 16.1 Worker tests

必測：

- `GET /` -> 200。
- invalid JSON -> 400 `invalid_json`。
- wrong PIN -> 401 `invalid_pin`。
- oversized body -> 413 `payload_too_large`。
- invalid target language with correct PIN -> 400 `invalid_target_language`。
- correct PIN -> 200 with `ephemeral`。

Rate limit：

- 若 6-12 次不出現 429，不一定是 bug。
- 高量 burst 應可能部分出現 429。
- 文件中需標註 per-isolate best-effort。

### 16.2 Desktop PWA tests

必測：

- Page load 200。
- manifest parse。
- `sw.js` cache name 是最新版。
- settings drawer 可開可關。
- Worker URL readonly 且正確。
- PIN 輸入後 reload 仍存在。
- 測試 Worker 連線成功。

### 16.3 Phone tests

必測：

- 手機打開 deployed HTTPS URL。
- 第一次輸入 PIN。
- 測試 Worker 連線成功。
- 喇叭測試從大喇叭出聲。
- mic start 後 state 從 connecting 到 live。
- 小聲說中文，能聽到目標語言 audio。
- source transcript 有中文。
- target transcript 有目標語言。
- console 可看到 RMS baseline log。
- 手動停止時顯示 closing，約 2 秒內回 idle。
- 無聲 timeout 會斷線。
- cost meter 顯示並在結束後保留約 10 秒。

### 16.4 Cost sanity

估算公式：

```text
seconds / 60 * 0.051
```

例如 30 秒：

```text
30 / 60 * 0.051 = 0.0255 USD
```

UI cost 是估算，不是官方帳單。

實機 smoke test 後可等 OpenAI dashboard 更新，再比對 UI 估算與 dashboard 用量。若偏差長期大於 10%，應重查 `PRICE_TRANSLATE_PER_MIN` / `PRICE_WHISPER_PER_MIN` 是否已被供應商更新。

---

## 17. 常見失敗與修正方向

### 17.1 設定側邊欄關不掉

可能原因：

- CSS `display: flex` 覆蓋 hidden。
- 舊 service worker cache。

修正：

- 全域 `[hidden] { display: none !important; }`。
- `showDrawer()` / `hideDrawer()` 同步寫 `style.display`。
- bump `CACHE_NAME`。
- 手機關掉 PWA 後重開。

### 17.2 測試 Worker 成功，但按 mic 還說沒設定

可能原因：

- PIN 沒即時同步到 settings/localStorage。

修正：

- 測試 Worker、喇叭測試、startSession 前都呼叫 `syncSettingsFromControls({ persist: true })`。
- PIN input/change/blur/pagehide 都保存。

### 17.3 低量 wrong PIN 不出現 429

原因：

- Cloudflare Worker module-level Map 是 per-isolate。

處理：

- 文件標為 best-effort。
- 不擋 phone smoke test。
- 真 hard cap 後續升 KV/DO。

### 17.4 無聲 timeout 永遠不觸發

可能原因：

- RMS threshold 太低。
- AGC 把背景噪音放大。

修正：

- baseline p90。
- threshold = `max(p90 * 2.5, 0.012)`。
- 3 consecutive frames 才算 speech。

### 17.5 iOS 聲音從聽筒出來

處理：

- 先跑喇叭測試。
- 若小聲或走聽筒，不開始 paid session。
- 改 Safari tab、Bluetooth speaker、耳機。

---

## 18. 給 Codex / Claude Code 的建議實作順序

### Phase 1：靜態 shell

1. 建立 `index.html`。
2. 建立 `styles.css`。
3. 建立 `manifest.webmanifest`。
4. 建立 icons。
5. 建立 `sw.js`，先讓 PWA 可開啟。

驗收：

- `python -m http.server 8000` 可開頁。
- setting drawer 可開關。
- manifest parse OK。

### Phase 2：Worker

1. 建立 `worker/worker.js`。
2. 實作 health check。
3. 實作 `/session` body parse / PIN / language validate。
4. 實作 OpenAI client secret call。
5. 實作 CORS / body cap / rate limit。
6. 部署 Worker。

驗收：

- wrong PIN 401。
- correct PIN 200 ephemeral。

### Phase 3：WebRTC

1. `getUserMedia()`。
2. `RTCPeerConnection`。
3. data channel。
4. SDP exchange。
5. remote audio playback。
6. transcript event handling。

驗收：

- 真機可聽到翻譯。

### Phase 4：預算保護

1. RMS analyser。
2. baseline calibration。
3. silence timer。
4. ring warning。
5. cleanup。
6. cost meter。

驗收：

- 無聲會自動斷線。
- 說話會 reset timer。

### Phase 5：手機 hardening

1. speaker test。
2. iOS banner。
3. wake lock。
4. graceful close。
5. settings persistence。
6. service worker cache bump discipline。

驗收：

- 手機實測流程通過。

---

## 19. 再現用 LLM Prompt 範本

可以把以下 prompt 交給 coding agent：

```text
請依照 VOICE_TRANSLATOR_REPRODUCTION_SPEC.md 實作一個手機 PWA。

工作方式：
1. 先閱讀整份 spec。
2. 不要把 OpenAI API key 或 APP_PIN 寫入前端。
3. 建立 Cloudflare Worker token minter。
4. 建立 PWA 前端，使用 WebRTC 連 OpenAI Realtime Translation。
5. Translation endpoint 不發 VAD events；請使用 RMS baseline silence guard。
6. 每次修改 app shell 檔案都 bump service worker CACHE_NAME。
7. 實作完成後跑 node --check、Worker smoke test、PWA local smoke test。
8. 最後提供 deploy + phone smoke test checklist。
9. 每個 patch 完成後列出改動摘要與驗證結果，等待使用者確認再進下一步。

請優先完成可運作版本，不要重寫成不同架構。
```

---

## 20. 驗收條件

此 APP 視為再現成功，需同時滿足：

- Worker secret 設定後，correct PIN 可 mint ephemeral。
- PWA 在 HTTPS 上可開啟並可安裝。
- 手機可授權 mic。
- WebRTC SDP exchange 成功。
- 中文語音可翻譯成至少 English。
- audio 從預期輸出路由播放。
- transcript 顯示 source / target。
- 手動停止會進入 closing 並回 idle。
- 無聲 timeout 會自動斷線。
- cost meter 大致符合 `seconds / 60 * 0.051`。
- 重開頁面後 PIN 仍保留在同裝置 localStorage。
- Service worker 已使用最新 cache name。

---

## 21. 最重要的設計邊界

若只能記住五件事，請記住：

1. OpenAI API key 只能在 Worker。
2. PIN 不能寫死在公開前端，只能本機保存。
3. Translation endpoint 沒有 VAD events，RMS 是唯一 silence guard。
4. iOS 音訊路由一定要先做喇叭測試。
5. PWA shell 改動一定要 bump service worker cache name。

---

## 22. 常數總表

重做時請集中確認下列常數。除非需求改變，標為 `[合約值]` 的項目應照本 spec 保留。

### 22.1 前端常數

```js
[合約值]
const OPENAI_REALTIME_TRANSLATE_URL =
  'https://api.openai.com/v1/realtime/translations/calls';

[部署值：重做時替換成自己的 Worker URL]
const DEFAULT_WORKER_URL =
  'https://voice-translator-token-minter.lucky0623.workers.dev';

[合約值]
const PRICE_TRANSLATE_PER_MIN = 0.034;
const PRICE_WHISPER_PER_MIN = 0.017;
const PRICE_PER_SEC_TOTAL =
  (PRICE_TRANSLATE_PER_MIN + PRICE_WHISPER_PER_MIN) / 60;

[合約值]
const RING_CIRCUMFERENCE = 578;

[合約值]
const RMS_NOISE_FLOOR = 0.012;
const RMS_K = 2.5;
const RMS_BASELINE_FRAMES = 5;
const RMS_SPEECH_FRAMES_REQUIRED = 3;
const RMS_CHECK_INTERVAL_MS = 200;

[合約值]
const GRACEFUL_CLOSE_TIMEOUT_MS = 2000;

[合約值：若需相容既有 localStorage，請保留]
const SETTINGS_KEY = 'vt_settings_v1';
```

### 22.2 Worker 常數

```js
[合約值]
const ALLOWED_LANGS = new Set([
  'en', 'es', 'pt', 'fr', 'ja', 'ru', 'zh',
  'de', 'ko', 'hi', 'id', 'vi', 'it',
]);

[部署值：重做時替換成自己的前端 origin]
const ALLOWED_ORIGIN = 'https://kenkenno1.github.io';

[合約值]
const rateLimitWindow = 60_000;
const rateLimitMax = 6;
const MAX_BODY_BYTES = 2048;
```

### 22.3 Service Worker 常數

```js
[部署值：每次 shell change 都要 bump]
const CACHE_NAME = 'voice-translator-v9';
```

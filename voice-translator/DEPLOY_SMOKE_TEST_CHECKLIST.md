# Voice Translator PWA Deploy + Smoke Test Checklist

Use this checklist after the v1.1.8 English UI patch. Keep the first paid smoke test short.

## 0. Preflight

- [ ] Confirm files are the expected hardened version:
  - `app.js`
  - `worker/worker.js`
  - `sw.js`
  - `index.html`
  - `README.md`
- [ ] Confirm `sw.js` has `CACHE_NAME = 'voice-translator-v10'`.
- [ ] Confirm README version says `v1.1.8`.
- [ ] Keep DevTools console available on desktop for first local checks.

## 1. Worker Deploy

- [ ] Open PowerShell in `C:\Users\User\Desktop\voice_translator_pwa\worker`.
- [ ] Set or confirm secrets:
  ```powershell
  wrangler secret put OPENAI_API_KEY
  wrangler secret put APP_PIN
  ```
- [ ] Deploy Worker:
  ```powershell
  wrangler deploy
  ```
- [ ] Save the Worker URL, for example `https://voice-translator-token-minter.<subdomain>.workers.dev`.

## 2. Worker Smoke Test

- [ ] Wrong PIN returns `401 invalid_pin`.
- [ ] Oversized JSON body returns `413 payload_too_large`.
- [ ] Correct PIN returns JSON containing `ephemeral`.
- [ ] Repeated requests eventually return `429 rate_limited` near 6 requests/minute.

## 3. PWA Deploy

- [ ] Push `voice_translator_pwa/` to the GitHub Pages target path.
- [ ] Open the deployed HTTPS URL in a normal browser tab.
- [ ] Hard refresh once.
- [ ] In DevTools Application tab, verify the active service worker is current.
- [ ] Confirm cache storage contains `voice-translator-v10`, not only older `voice-translator-v*` caches.

## 4. First Phone Setup

- [ ] Open the deployed HTTPS URL on the phone.
- [ ] Confirm Worker URL is fixed/read-only in Settings.
- [ ] Enter APP_PIN in Settings.
- [ ] Tap `測試 Worker 連線`; expect success.
- [ ] Set silence timeout to `30 秒`.
- [ ] Keep output language as English for the first test.

## 5. Speaker Route Test

- [ ] Tap `🔊 喇叭測試`.
- [ ] Confirm the tone is clearly from the loud speaker, not the earpiece.
- [ ] If the tone is quiet or from the earpiece, do not start a paid session. Try Safari tab, Bluetooth speaker, or headphones.
- [ ] Try quick repeated taps; only one speaker test should run at a time.
- [ ] Try tapping mic while speaker test is running; app should ask you to wait.

## 6. Paid WebRTC Smoke Test

- [ ] Tap mic to start.
- [ ] Confirm state moves `連線中...` to `翻譯中`.
- [ ] Whisper: `你好，今天天氣很好`.
- [ ] Confirm translated audio plays from the expected output route.
- [ ] Confirm source transcript appears in Chinese.
- [ ] Confirm target transcript appears in English.
- [ ] Watch console for RMS baseline log and note threshold value.
- [ ] Stop manually after one short sentence.
- [ ] Confirm state briefly shows `結束中...`.
- [ ] Confirm final cost remains visible for about 10 seconds.

## 7. Silence Timeout Test

- [ ] Start a new session and do not speak.
- [ ] Confirm session auto-disconnects after the configured silence timeout.
- [ ] Confirm toast uses the configured number of seconds.
- [ ] Confirm countdown warning ring only enters warning state near the final 10 seconds.
- [ ] Repeat with brief speech, then silence; timer should reset after speech.

## 8. Graceful Stop Test

- [ ] Start a session.
- [ ] Speak a short sentence and immediately tap stop.
- [ ] Confirm app enters `結束中...`.
- [ ] Confirm it returns to idle within about 2 seconds.
- [ ] Check console for `session.close` / `session.closed` or timeout log.
- [ ] Confirm no silence-timeout toast appears during manual stop.

## 9. Language Rotation

- [ ] Test Japanese with one short sentence.
- [ ] Test Korean with one short sentence.
- [ ] Confirm the language selector is disabled while live/connecting/closing.

## 10. iOS PWA Specific

- [ ] Add to Home Screen.
- [ ] Launch standalone PWA.
- [ ] Confirm the iOS warning banner appears.
- [ ] Run speaker test before paid session.
- [ ] If mic or speaker routing fails, retry in Safari tab and record the difference.

## 11. Cost Sanity

- [ ] Record session duration shown in UI.
- [ ] Calculate expected cost: `seconds / 60 * 0.051`.
- [ ] Confirm UI cost is close to expected.
- [ ] Later, compare OpenAI billing/usage against approximate total test duration.

## 12. Pass / Fail Notes

- Worker URL:
- Phone model / OS:
- Browser / PWA mode:
- Speaker route result:
- RMS baseline threshold:
- Translation latency:
- Silence timeout result:
- Graceful stop result:
- Cost sanity:
- Issues to fix before wider use:

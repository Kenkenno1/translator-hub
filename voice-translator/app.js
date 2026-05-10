/**
 * 即時翻譯 PWA — Realtime client
 *
 * Flow:
 *   1. Tap mic → fetch ephemeral from Cloudflare Worker
 *   2. Open WebRTC PeerConnection to OpenAI /v1/realtime/translations/calls
 *   3. Stream mic → server, play translated audio track to <audio>
 *   4. Listen on data channel for transcript + VAD events
 *   5. Auto-disconnect after configurable silence (default 30s)
 */

// ===================== Constants =====================

const OPENAI_REALTIME_TRANSLATE_URL =
  'https://api.openai.com/v1/realtime/translations/calls';

const PRICE_TRANSLATE_PER_MIN = 0.034; // gpt-realtime-translate
const PRICE_WHISPER_PER_MIN = 0.017; // gpt-realtime-whisper transcription
const PRICE_PER_SEC_TOTAL =
  (PRICE_TRANSLATE_PER_MIN + PRICE_WHISPER_PER_MIN) / 60;

const RING_CIRCUMFERENCE = 578; // 2 * pi * 92, matches CSS

// ----- Silence detection (RMS-based) -----
// Translation endpoint (gpt-realtime-translate) does NOT emit VAD events
// (verified against https://developers.openai.com/api/reference/resources/realtime/translation-server-events).
// RMS is the SOLE silence-detection path, so it must be robust:
//   1. Calibrate to ambient noise during the first second (avoids AGC-amplified
//      background noise constantly resetting the silence timer).
//   2. Require N consecutive above-threshold frames before counting as speech
//      (rejects single-frame transients).
const RMS_NOISE_FLOOR = 0.012; // absolute minimum threshold (~-38 dBFS)
const RMS_K = 2.5; // multiplier applied to baseline p90 to set dynamic threshold
const RMS_BASELINE_FRAMES = 5; // 5 frames × 200ms = 1s baseline window
const RMS_SPEECH_FRAMES_REQUIRED = 3; // 3 consecutive frames = 600ms
const RMS_CHECK_INTERVAL_MS = 200;

// ----- Graceful close (user_stop only) -----
// Per https://developers.openai.com/api/reference/resources/realtime/translation-client-events
// `session.close` event flushes pending input audio and emits any remaining
// translated output before closing. We send it on user_stop and wait briefly
// for `session.closed` so the final transcript chunk lands. silence/error
// reasons skip this and close immediately to protect the budget.
const GRACEFUL_CLOSE_TIMEOUT_MS = 2000;

const LANG_LABELS = {
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
  zh: '中文',
};

// ===================== DOM refs =====================

const $ = (id) => document.getElementById(id);
const dom = {
  micBtn: $('mic-btn'),
  micWrap: document.querySelector('.mic-wrap'),
  micHint: $('mic-hint'),
  silenceRing: $('silence-ring-fg'),
  statePill: $('state-pill'),
  costMeter: $('cost-meter'),
  costLabel: document.querySelector('#cost-meter .cost-label'),
  costValue: $('cost-value'),
  costDuration: $('cost-duration'),
  targetLang: $('target-lang'),
  targetLangLabel: $('target-lang-label'),
  speakerTestBtn: $('speaker-test-btn'),
  srcText: $('src-text'),
  dstText: $('dst-text'),
  audio: $('translated-audio'),
  iosBanner: $('ios-standalone-banner'),
  iosBannerClose: document.querySelector('#ios-standalone-banner .banner-close'),
  // settings
  settingsToggle: $('settings-toggle'),
  settingsClose: $('settings-close'),
  settingsDrawer: $('settings-drawer'),
  drawerBackdrop: $('drawer-backdrop'),
  cfgWorkerUrl: $('cfg-worker-url'),
  cfgPin: $('cfg-pin'),
  cfgSilence: $('cfg-silence'),
  cfgSilenceOut: $('cfg-silence-out'),
  testConnectionBtn: $('test-connection'),
  testConnectionResult: $('test-connection-result'),
  // toast
  toast: $('toast'),
  // clear buttons
  clearBtns: document.querySelectorAll('.clear-btn'),
};

// ===================== Settings (localStorage) =====================

const SETTINGS_KEY = 'vt_settings_v1';
const defaultSettings = {
  workerUrl: '',
  pin: '',
  silenceTimeoutSec: 30,
  micMode: 'whisper', // or 'studio'
  iosBannerDismissed: false,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota */
  }
}

let settings = loadSettings();

// Module-level guard to prevent speaker test reentry and prevent startSession
// from racing with an in-flight speaker test (both write dom.audio.srcObject).
let speakerTestRunning = false;

// ===================== Session state =====================

const session = {
  pc: null, // RTCPeerConnection
  dc: null, // RTCDataChannel
  micStream: null, // MediaStream
  audioCtx: null, // AudioContext for RMS
  analyser: null, // AnalyserNode
  rmsTimer: null,
  silenceTimer: null,
  warningTimer: null, // schedules `.warning` class add at last 10s of silence window
  ringAnimStart: 0,
  costTimer: null,
  costMeterHideTimer: null, // hides cost meter 10s after session end
  startTime: 0,
  wakeLock: null,
  state: 'idle', // idle | connecting | live | closing | silenced | error
  lastSpeechAt: 0,
  gracefulCloseResolver: null, // set while waiting for session.closed
  // RMS calibration state
  rmsPhase: 'baseline', // 'baseline' | 'active'
  rmsBaselineSamples: [], // collected during first 1s
  rmsThreshold: RMS_NOISE_FLOOR, // computed after baseline
  rmsConsecutiveAbove: 0, // consecutive frames above threshold
  // Suppresses per-frame logging of high-volume `session.output_audio.delta`
  // events after the first occurrence in a session. Reset to false in cleanup
  // so subsequent sessions also get a one-shot log line.
  _loggedAudioDelta: false,
};

// ===================== UI helpers =====================

function setState(next) {
  session.state = next;
  const pill = dom.statePill;
  pill.className = 'state-pill state-' + next;
  pill.textContent = {
    idle: '待機中',
    connecting: '連線中…',
    live: '🔴 翻譯中',
    closing: '結束中…',
    silenced: '無聲斷線',
    error: '錯誤',
  }[next] || next;

  dom.micBtn.classList.toggle('live', next === 'live');
  // Treat 'closing' visually like 'connecting' (yellow) — both are transient
  // states where the button shouldn't be tappable to start/stop again.
  dom.micBtn.classList.toggle(
    'connecting',
    next === 'connecting' || next === 'closing',
  );
  dom.micBtn.setAttribute(
    'aria-label',
    next === 'live' ? '結束翻譯' : '開始翻譯',
  );
  dom.micHint.textContent = {
    idle: '輕觸開始，再輕觸結束',
    connecting: '連線中…',
    live: '小聲講話即可，喇叭會放出翻譯',
    closing: '結束中…（讓最後一句譯完）',
    silenced: '已自動斷線（無聲）。輕觸再開始',
    error: '發生錯誤，請查看詳情',
  }[next] || '';
}

function toast(msg, kind = 'info', ms = 3000) {
  dom.toast.textContent = msg;
  dom.toast.className = 'toast' + (kind === 'info' ? '' : ' ' + kind);
  dom.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    dom.toast.hidden = true;
  }, ms);
}

function appendTranscript(el, delta) {
  if (!delta) return;
  el.textContent += delta;
  el.scrollTop = el.scrollHeight;
}

function clearTranscripts() {
  dom.srcText.textContent = '';
  dom.dstText.textContent = '';
}

// ===================== Settings drawer =====================

function openDrawer() {
  dom.settingsDrawer.hidden = false;
  dom.drawerBackdrop.hidden = false;
  // populate
  dom.cfgWorkerUrl.value = settings.workerUrl;
  dom.cfgPin.value = settings.pin;
  dom.cfgSilence.value = settings.silenceTimeoutSec;
  dom.cfgSilenceOut.value = settings.silenceTimeoutSec;
  document.querySelector(
    `input[name="mic-mode"][value="${settings.micMode}"]`,
  ).checked = true;
}

function closeDrawer() {
  // persist current values
  settings.workerUrl = dom.cfgWorkerUrl.value.trim();
  settings.pin = dom.cfgPin.value;
  settings.silenceTimeoutSec = parseInt(dom.cfgSilence.value, 10) || 30;
  const checked = document.querySelector('input[name="mic-mode"]:checked');
  if (checked) settings.micMode = checked.value;
  saveSettings(settings);
  dom.settingsDrawer.hidden = true;
  dom.drawerBackdrop.hidden = true;
}

dom.settingsToggle.addEventListener('click', openDrawer);
dom.settingsClose.addEventListener('click', closeDrawer);
dom.drawerBackdrop.addEventListener('click', closeDrawer);
dom.cfgSilence.addEventListener('input', () => {
  dom.cfgSilenceOut.value = dom.cfgSilence.value;
});

// ===================== iOS standalone banner =====================

function maybeShowIosBanner() {
  if (settings.iosBannerDismissed) return;
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (isIos && isStandalone) {
    dom.iosBanner.hidden = false;
  }
}
dom.iosBannerClose?.addEventListener('click', () => {
  dom.iosBanner.hidden = true;
  settings.iosBannerDismissed = true;
  saveSettings(settings);
});

// ===================== Clear buttons =====================

dom.clearBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.getAttribute('data-target');
    if (targetId) $(targetId).textContent = '';
  });
});

// ===================== Target language change =====================

dom.targetLang.addEventListener('change', () => {
  dom.targetLangLabel.textContent =
    LANG_LABELS[dom.targetLang.value] || dom.targetLang.value;
  if (session.state === 'live' || session.state === 'connecting') {
    toast('語言切換需重新連線。請先停止再開始。', 'warn');
  }
});

// ===================== Speaker test =====================

/**
 * Build mic constraints matching the current settings (Whisper / Studio).
 * Used by both startSession() and the speaker test so the iOS audio session
 * is in the same state during the test as during a real session.
 */
function buildMicConstraints() {
  return settings.micMode === 'studio'
    ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 24000,
      }
    : {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 24000,
      };
}

dom.speakerTestBtn.addEventListener('click', async () => {
  // Reentry guard: no concurrent speaker tests, no overlap with an in-flight
  // test that hasn't torn down yet.
  if (speakerTestRunning) {
    toast('喇叭測試進行中，請稍候。', 'warn');
    return;
  }
  // Don't run the test mid-session — it would hijack dom.audio.srcObject and
  // steal the mic mid-flight. Speaker test is only valid from rest states.
  if (
    session.state !== 'idle' &&
    session.state !== 'silenced' &&
    session.state !== 'error'
  ) {
    toast('請先停止目前的翻譯再做喇叭測試。', 'warn');
    return;
  }

  // Why this routing matters:
  // The original speaker test used AudioContext.destination (default speakers)
  // with no mic active. iOS earpiece routing kicks in specifically when both
  // a mic stream is active AND audio is being played — WebRTC sessions hit
  // exactly that combination. So we (a) acquire mic with the same constraints
  // a real session would use, and (b) play the tone through the SAME <audio>
  // element via MediaStreamDestination. This is the closest we can get to
  // reproducing the real routing decision without burning an OpenAI session.
  speakerTestRunning = true;
  let testMicStream = null;
  let testAudioCtx = null;
  let testStreamRef = null; // identifies "our" stream for the cleanup race-check

  try {
    // 1. Acquire mic — puts the iOS audio session into the same state as a
    //    real translation session.
    testMicStream = await navigator.mediaDevices.getUserMedia({
      audio: buildMicConstraints(),
    });

    // 2. Generate tone routed through MediaStreamDestination → <audio>.
    testAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (testAudioCtx.state === 'suspended') {
      await testAudioCtx.resume();
    }

    const dest = testAudioCtx.createMediaStreamDestination();
    testStreamRef = dest.stream;
    const osc = testAudioCtx.createOscillator();
    const gain = testAudioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0, testAudioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.4, testAudioCtx.currentTime + 0.05);
    gain.gain.linearRampToValueAtTime(0, testAudioCtx.currentTime + 0.6);
    osc.connect(gain).connect(dest);

    dom.audio.srcObject = testStreamRef;
    dom.audio.volume = 1.0;
    // Await play() so an autoplay/activation rejection bubbles into catch and
    // is reported as a TEST FAILURE rather than a silent "you should hear a
    // tone" toast that misleads the user about routing.
    await dom.audio.play();

    osc.start();
    osc.stop(testAudioCtx.currentTime + 0.65);

    toast(
      '喇叭測試：應該聽到一聲清楚嗶聲（與真實翻譯走相同音訊路徑）。如果很小聲或從聽筒出來，請改用 Safari 分頁、藍牙喇叭或耳機，再開始計費 session。',
      'info',
      7000,
    );

    // 3. Wait for the tone to finish before teardown.
    await new Promise((resolve) => {
      osc.onended = resolve;
      // Defensive cap in case onended doesn't fire (rare).
      setTimeout(resolve, 1500);
    });
  } catch (e) {
    console.error('[speaker test] error:', e);
    toast('喇叭測試失敗：' + (e.message || e.name || e), 'error');
  } finally {
    // Teardown — release mic and audio element. CRITICAL: only clear
    // dom.audio.srcObject if it's STILL our test stream. If something else
    // (a real session via pc.ontrack, or a future test) replaced it during
    // our 1.5s wait, leave it alone.
    if (testMicStream) {
      testMicStream.getTracks().forEach((t) => t.stop());
    }
    if (testStreamRef && dom.audio.srcObject === testStreamRef) {
      dom.audio.srcObject = null;
    }
    if (testAudioCtx && testAudioCtx.state !== 'closed') {
      testAudioCtx.close().catch(() => {});
    }
    speakerTestRunning = false;
  }
});

// ===================== Worker test connection =====================

dom.testConnectionBtn.addEventListener('click', async () => {
  const url = dom.cfgWorkerUrl.value.trim();
  const pin = dom.cfgPin.value;
  const result = dom.testConnectionResult;
  result.hidden = false;
  result.className = 'test-result';
  result.textContent = '測試中…';

  if (!url) {
    result.className = 'test-result fail';
    result.textContent = '請先填入 Worker URL。';
    return;
  }

  try {
    // Health check first
    const ping = await fetch(url.replace(/\/$/, '') + '/');
    if (!ping.ok) {
      result.className = 'test-result fail';
      result.textContent = `Worker 健康檢查失敗：HTTP ${ping.status}`;
      return;
    }

    // Real session call (consumes 1 OpenAI ephemeral)
    const resp = await fetch(url.replace(/\/$/, '') + '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLanguage: 'en', pin }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      result.className = 'test-result fail';
      result.textContent = `失敗：HTTP ${resp.status} — ${data.error || '未知錯誤'}${
        data.detail ? '\n' + data.detail : ''
      }`;
      return;
    }
    if (!data.ephemeral) {
      result.className = 'test-result fail';
      result.textContent = '回應缺少 ephemeral 欄位：' + JSON.stringify(data).slice(0, 200);
      return;
    }
    result.className = 'test-result ok';
    result.textContent = `成功！已取得 ephemeral token（前 12 碼：${data.ephemeral.slice(0, 12)}…）。`;
  } catch (e) {
    result.className = 'test-result fail';
    result.textContent = '網路錯誤：' + e.message;
  }
});

// ===================== Mic button =====================

dom.micBtn.addEventListener('click', async () => {
  if (session.state === 'idle' || session.state === 'silenced' || session.state === 'error') {
    await startSession();
  } else if (session.state === 'live' || session.state === 'connecting') {
    stopSession('user_stop');
  }
  // 'closing' state: ignore tap. The graceful-close path runs to completion
  // (≤ GRACEFUL_CLOSE_TIMEOUT_MS) and then transitions to 'idle' on its own.
});

// ===================== Session lifecycle =====================

async function startSession() {
  // Reject if speaker test is in flight — both write dom.audio.srcObject and
  // both call getUserMedia. Wait the ~1.5s test out instead of racing.
  if (speakerTestRunning) {
    toast('喇叭測試進行中，請稍候再開始翻譯。', 'warn');
    return;
  }
  if (!settings.workerUrl || !settings.pin) {
    toast('請先到設定填入 Worker URL 和 PIN。', 'warn', 4000);
    openDrawer();
    return;
  }

  setState('connecting');
  clearTranscripts();
  // Reset cost meter at tap (not at SDP success) so the previous session's
  // "本次費用（已結束）" label doesn't linger while connecting.
  resetCostMeter();
  dom.targetLangLabel.textContent =
    LANG_LABELS[dom.targetLang.value] || dom.targetLang.value;

  try {
    // 1. Mic — see buildMicConstraints() for Whisper/Studio details.
    // sampleRate: 24000 matches the Realtime API's expected PCM16 24 kHz rate.
    session.micStream = await navigator.mediaDevices.getUserMedia({
      audio: buildMicConstraints(),
    });

    // Log what the browser actually applied (constraints are advisory)
    const actual = session.micStream.getAudioTracks()[0].getSettings();
    console.log('[mic] applied constraints:', actual);

    // 2. Ephemeral token
    const tokenResp = await fetch(settings.workerUrl.replace(/\/$/, '') + '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLanguage: dom.targetLang.value,
        pin: settings.pin,
      }),
    });
    if (!tokenResp.ok) {
      const errBody = await tokenResp.json().catch(() => ({}));
      throw new Error(
        `Worker 取 token 失敗：HTTP ${tokenResp.status} — ${errBody.error || ''}`,
      );
    }
    const { ephemeral } = await tokenResp.json();
    if (!ephemeral) throw new Error('Worker 回應缺少 ephemeral');

    // 3. RTCPeerConnection
    const pc = new RTCPeerConnection();
    session.pc = pc;

    pc.ontrack = (ev) => {
      console.log('[pc] track received', ev.track.kind);
      // Stream the translated audio to the <audio> element.
      if (dom.audio.srcObject !== ev.streams[0]) {
        dom.audio.srcObject = ev.streams[0];
        dom.audio.volume = 1.0;
        dom.audio.play().catch((e) => console.warn('autoplay failed:', e));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[pc] state:', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (session.state === 'live' || session.state === 'connecting') {
          stopSession('connection_lost');
          toast('連線中斷', 'error');
          setState('error');
        }
      }
    };

    // Attach mic
    session.micStream
      .getAudioTracks()
      .forEach((t) => pc.addTrack(t, session.micStream));

    // Data channel
    const dc = pc.createDataChannel('oai-events');
    session.dc = dc;
    dc.addEventListener('open', () => console.log('[dc] open'));
    dc.addEventListener('message', handleServerEvent);

    // Set up RMS analyser in parallel (mandatory fallback)
    setupRmsAnalyser(session.micStream);

    // 4. SDP exchange
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch(OPENAI_REALTIME_TRANSLATE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ephemeral}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });
    if (!sdpResp.ok) {
      const text = await sdpResp.text();
      throw new Error(`SDP 交換失敗：HTTP ${sdpResp.status} — ${text.slice(0, 200)}`);
    }
    const answerSdp = await sdpResp.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    // 5. Live!
    setState('live');
    session.startTime = Date.now();
    session.lastSpeechAt = Date.now();
    startCostMeter();
    startSilenceTimer();
    requestWakeLock();
  } catch (err) {
    console.error('[startSession] failed', err);
    toast('啟動失敗：' + err.message, 'error', 6000);
    setState('error');
    cleanup();
  }
}

async function stopSession(reason) {
  console.log('[stopSession]', reason);

  // user_stop only: try graceful close so the server flushes pending audio /
  // emits the final transcript chunk. silence/error skip this — when the
  // budget is the concern, every extra second risks more billing.
  if (reason === 'user_stop' && session.dc?.readyState === 'open') {
    setState('closing');
    // Clear silence/RMS guards BEFORE awaiting graceful close. Otherwise the
    // silence timer can fire inside the 2s graceful window — that would
    // re-enter stopSession('silence'), close dc/pc, and kill the flush in
    // flight. Keep dc/pc/mic/costTimer alive so the server can flush and the
    // cost meter continues reflecting real billing during the wait.
    clearSilenceGuards();
    await gracefulClose();
  }

  cleanup();

  if (reason === 'silence') {
    setState('silenced');
    // Use the user's actual silence-timeout setting, not a hardcoded "30s".
    toast(
      `${settings.silenceTimeoutSec} 秒無聲，已自動斷線`,
      'info',
      4000,
    );
  } else if (reason === 'user_stop') {
    setState('idle');
  }
  // for 'connection_lost', state already set to 'error' by caller
}

/**
 * Send `session.close` and wait up to GRACEFUL_CLOSE_TIMEOUT_MS for the
 * server's `session.closed` ack. Resolves either way — never rejects, never
 * blocks indefinitely. Caller is responsible for cleanup() afterwards.
 */
function gracefulClose() {
  return new Promise((resolve) => {
    const dc = session.dc;
    if (!dc || dc.readyState !== 'open') return resolve();

    const timeout = setTimeout(() => {
      console.log(
        `[graceful close] timeout after ${GRACEFUL_CLOSE_TIMEOUT_MS}ms — forcing close`,
      );
      session.gracefulCloseResolver = null;
      resolve();
    }, GRACEFUL_CLOSE_TIMEOUT_MS);

    // The handleServerEvent dispatcher will call this when session.closed
    // arrives. Wrap resolve so we also clear the timeout.
    session.gracefulCloseResolver = () => {
      clearTimeout(timeout);
      resolve();
    };

    try {
      dc.send(JSON.stringify({ type: 'session.close' }));
      console.log(
        `[graceful close] sent session.close, waiting up to ${GRACEFUL_CLOSE_TIMEOUT_MS}ms`,
      );
    } catch (e) {
      console.warn('[graceful close] send failed:', e);
      clearTimeout(timeout);
      session.gracefulCloseResolver = null;
      resolve();
    }
  });
}

/**
 * Clear the silence-detection family of timers (RMS poll, silence timeout,
 * warning timeout). Used both at end-of-session via cleanup() and at the
 * start of a graceful close to prevent the silence timer from racing with
 * the 2s graceful-close window.
 */
function clearSilenceGuards() {
  if (session.rmsTimer) {
    clearInterval(session.rmsTimer);
    session.rmsTimer = null;
  }
  if (session.silenceTimer) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }
  if (session.warningTimer) {
    clearTimeout(session.warningTimer);
    session.warningTimer = null;
  }
}

function cleanup() {
  // Order matters: stop tracks before closing PC so we don't send stray frames.
  clearSilenceGuards();
  if (session.costTimer) {
    clearInterval(session.costTimer);
    session.costTimer = null;
  }
  if (session.micStream) {
    session.micStream.getTracks().forEach((t) => t.stop());
    session.micStream = null;
  }
  if (session.analyser) {
    try {
      session.analyser.disconnect();
    } catch {}
    session.analyser = null;
  }
  if (session.audioCtx) {
    session.audioCtx.close().catch(() => {});
    session.audioCtx = null;
  }
  if (session.dc) {
    try {
      session.dc.close();
    } catch {}
    session.dc = null;
  }
  if (session.pc) {
    try {
      session.pc.close();
    } catch {}
    session.pc = null;
  }
  if (dom.audio.srcObject) {
    dom.audio.srcObject = null;
  }
  releaseWakeLock();
  resetSilenceRing();
  dom.micWrap.classList.remove('warning');

  // Cost meter: keep visible for 10s with a "(已結束)" marker so the user
  // can see the final cost. A new session starting before 10s clears this
  // immediately (see startCostMeter).
  if (dom.costMeter && !dom.costMeter.hidden) {
    if (dom.costLabel) dom.costLabel.textContent = '本次費用（已結束）';
    if (session.costMeterHideTimer) clearTimeout(session.costMeterHideTimer);
    session.costMeterHideTimer = setTimeout(() => {
      dom.costMeter.hidden = true;
      if (dom.costLabel) dom.costLabel.textContent = '本次費用';
      session.costMeterHideTimer = null;
    }, 10_000);
  }

  // Reset per-session diagnostic flags so the next session logs again.
  session._loggedAudioDelta = false;
}

// ===================== Server event handler =====================

function handleServerEvent(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  const type = msg.type || '';

  // Canonical translation server events (only two transcript event names exist):
  //   session.input_transcript.delta  → source-language transcript
  //   session.output_transcript.delta → translated transcript
  // Per: https://developers.openai.com/api/reference/resources/realtime/translation-server-events
  //
  // Translation endpoint does NOT emit:
  //   - VAD events (input_audio_buffer.speech_started/stopped)
  //   - Standard Realtime transcript names (response.*, conversation.item.*)
  // Earlier versions of this code carried fallback handlers for those names.
  // Removed because they are dead code and the names mislead future readers.
  // RMS-based detection (setupRmsAnalyser) is the SOLE silence-detection path.

  if (type === 'session.input_transcript.delta') {
    appendTranscript(dom.srcText, msg.delta || msg.transcript || '');
    onSpeechActivity(); // strong evidence of speech — bypass RMS gate
    return;
  }
  if (type === 'session.output_transcript.delta') {
    appendTranscript(dom.dstText, msg.delta || msg.transcript || '');
    return;
  }

  // Errors from server
  if (type === 'error' || (msg.error && type !== '')) {
    console.warn('[server error]', msg);
    toast(
      '伺服器錯誤：' + (msg.error?.message || JSON.stringify(msg).slice(0, 100)),
      'error',
    );
    return;
  }

  // Graceful close ack: server confirms it's done flushing. Wake any waiter
  // in stopSession('user_stop') so we can proceed to pc.close().
  if (type === 'session.closed') {
    console.log('[server event] session.closed');
    if (session.gracefulCloseResolver) {
      const resolve = session.gracefulCloseResolver;
      session.gracefulCloseResolver = null;
      resolve();
    }
    return;
  }

  // session.created / session.updated / session.output_audio.delta
  // — known but no UI action needed. Keep below "unknown" handler so they show in console
  // for first-run sanity but don't toast.
  if (
    type === 'session.created' ||
    type === 'session.updated' ||
    type === 'session.output_audio.delta'
  ) {
    // session.output_audio.delta is high-volume; only log on first occurrence
    if (type !== 'session.output_audio.delta' || !session._loggedAudioDelta) {
      console.log('[server event]', type);
      if (type === 'session.output_audio.delta') session._loggedAudioDelta = true;
    }
    return;
  }

  // Unknown — log for debugging
  console.log('[server event] (unknown)', type, msg);
}

// ===================== Silence detection =====================

function setupRmsAnalyser(stream) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    session.audioCtx = ctx;
    // Mobile Safari often starts AudioContext in 'suspended' state until a user
    // gesture. We're inside a click handler chain (mic button) so resume()
    // should succeed; if it doesn't, RMS detection silently fails and silence
    // timer becomes the sole guard — that's still safe, just less responsive.
    if (ctx.state === 'suspended') {
      ctx.resume().catch((e) => console.warn('[rms] resume failed:', e));
    }
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    session.analyser = analyser;

    // Reset calibration state for this session.
    session.rmsPhase = 'baseline';
    session.rmsBaselineSamples = [];
    session.rmsThreshold = RMS_NOISE_FLOOR;
    session.rmsConsecutiveAbove = 0;

    const buf = new Uint8Array(analyser.fftSize);
    session.rmsTimer = setInterval(() => {
      if (!session.analyser) return;
      analyser.getByteTimeDomainData(buf);
      // RMS over time-domain buffer (0..255 centered at 128 → [-1, 1])
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length);

      if (session.rmsPhase === 'baseline') {
        // Phase 1: collect ambient samples. Do NOT trigger speech activity
        // here — even if user speaks during baseline, we'd rather have a
        // slightly elevated threshold than poison the silence timer with
        // stale "speech" before we've calibrated.
        session.rmsBaselineSamples.push(rms);
        if (session.rmsBaselineSamples.length >= RMS_BASELINE_FRAMES) {
          // Compute p90 and switch to active detection.
          const sorted = [...session.rmsBaselineSamples].sort((a, b) => a - b);
          // p90 index: ceil(n*0.9)-1. Behaves correctly across sample counts:
          //   n=5  → ceil(4.5)-1 = 4 (max — conservative for tiny samples)
          //   n=10 → ceil(9)-1   = 8 (true p90)
          //   n=20 → ceil(18)-1  = 17 (true p90)
          // Earlier `Math.floor(n*0.9)` always returned max for n ≤ 9.
          const p90Idx = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil(sorted.length * 0.9) - 1),
          );
          const p90 = sorted[p90Idx];
          session.rmsThreshold = Math.max(p90 * RMS_K, RMS_NOISE_FLOOR);
          session.rmsPhase = 'active';
          console.log(
            `[rms] baseline calibrated — p90=${p90.toFixed(4)}, ` +
              `threshold=${session.rmsThreshold.toFixed(4)} ` +
              `(floor=${RMS_NOISE_FLOOR}, k=${RMS_K}, samples=${sorted.length})`,
          );
        }
        return;
      }

      // Phase 2: active detection. Require N consecutive frames above threshold
      // to count as speech. This rejects single-frame transients (door slam,
      // microphone tap, etc.) that would otherwise reset the silence timer.
      if (rms > session.rmsThreshold) {
        session.rmsConsecutiveAbove = Math.min(
          session.rmsConsecutiveAbove + 1,
          RMS_SPEECH_FRAMES_REQUIRED,
        );
        if (session.rmsConsecutiveAbove >= RMS_SPEECH_FRAMES_REQUIRED) {
          // Once latched, keep triggering on every above-threshold frame so
          // continuous speech keeps the silence timer fresh.
          onSpeechActivity();
        }
      } else {
        session.rmsConsecutiveAbove = 0;
      }
    }, RMS_CHECK_INTERVAL_MS);
  } catch (e) {
    console.warn('[rms] setup failed:', e);
  }
}

function onSpeechActivity() {
  session.lastSpeechAt = Date.now();
  // Restart silence timer
  startSilenceTimer();
}

function startSilenceTimer() {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  const ms = settings.silenceTimeoutSec * 1000;
  // Restart ring animation
  startSilenceRing(ms);
  session.silenceTimer = setTimeout(() => {
    stopSession('silence');
  }, ms);
}

function startSilenceRing(durationMs) {
  // Reset ring instantly to empty (no transition), then animate to full over duration.
  const ring = dom.silenceRing;
  ring.style.transition = 'none';
  ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  // Force reflow so the next transition takes effect.
  // eslint-disable-next-line no-unused-expressions
  ring.getBoundingClientRect();
  ring.style.transition = `stroke-dashoffset ${durationMs}ms linear`;
  ring.style.strokeDashoffset = '0';

  // Clear any previously scheduled warning before re-arming. Without this,
  // every onSpeechActivity() restart leaks a setTimeout; old timers fire
  // later and toggle .warning at incorrect times.
  if (session.warningTimer) {
    clearTimeout(session.warningTimer);
    session.warningTimer = null;
  }
  dom.micWrap.classList.remove('warning');

  // Re-arm warning state for the last 10 seconds of THIS countdown.
  session.warningTimer = setTimeout(
    () => {
      if (session.state === 'live') dom.micWrap.classList.add('warning');
      session.warningTimer = null;
    },
    Math.max(0, durationMs - 10_000),
  );
}

function resetSilenceRing() {
  const ring = dom.silenceRing;
  ring.style.transition = 'none';
  ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
}

// ===================== Cost meter =====================

/**
 * Cancel any pending "hide previous session's final cost" timer, reset the
 * label and displayed values, and hide the meter. Used at tap (so the previous
 * session's "(已結束)" doesn't linger while connecting) and as a defensive
 * reset point. Idempotent.
 */
function resetCostMeter() {
  if (session.costMeterHideTimer) {
    clearTimeout(session.costMeterHideTimer);
    session.costMeterHideTimer = null;
  }
  if (dom.costLabel) dom.costLabel.textContent = '本次費用';
  if (dom.costValue) dom.costValue.textContent = '$0.0000';
  if (dom.costDuration) dom.costDuration.textContent = '0:00';
  dom.costMeter.hidden = true;
}

function startCostMeter() {
  // Defensive: in case caller skipped resetCostMeter(), make sure no stale
  // hide timer or "(已結束)" label is around when we go live.
  resetCostMeter();
  dom.costMeter.hidden = false;
  updateCost();
  session.costTimer = setInterval(updateCost, 1000);
}

function updateCost() {
  const elapsed = Math.max(0, (Date.now() - session.startTime) / 1000);
  const cost = elapsed * PRICE_PER_SEC_TOTAL;
  dom.costValue.textContent = '$' + cost.toFixed(4);
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60);
  dom.costDuration.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

// ===================== Wake lock =====================

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      session.wakeLock = await navigator.wakeLock.request('screen');
      session.wakeLock.addEventListener('release', () => {
        console.log('[wakeLock] released');
      });
    }
  } catch (e) {
    console.warn('[wakeLock] request failed:', e);
  }
}

function releaseWakeLock() {
  if (session.wakeLock) {
    session.wakeLock.release().catch(() => {});
    session.wakeLock = null;
  }
}

// Re-acquire wake lock on visibility change while live (it gets released when tab hides)
document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible' &&
    session.state === 'live' &&
    !session.wakeLock
  ) {
    requestWakeLock();
  }
});

// ===================== Service worker registration =====================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => console.log('[sw] registered:', reg.scope))
      .catch((err) => console.warn('[sw] register failed:', err));
  });
}

// ===================== Init =====================

setState('idle');
resetSilenceRing();
maybeShowIosBanner();
dom.targetLangLabel.textContent =
  LANG_LABELS[dom.targetLang.value] || dom.targetLang.value;

// First-run: open settings if Worker URL not configured.
if (!settings.workerUrl || !settings.pin) {
  setTimeout(openDrawer, 600);
}

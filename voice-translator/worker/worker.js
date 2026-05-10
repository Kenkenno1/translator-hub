/**
 * Voice Translator PWA — Cloudflare Worker (token minter)
 *
 * Endpoint: POST /session
 *   Body: { targetLanguage: "en", pin: "<shared-secret>" }
 *   Response: { ephemeral: "ek_...", expires_at: 1234567890 }
 *
 * Holds the real OPENAI_API_KEY. Mints ephemeral tokens via
 * https://api.openai.com/v1/realtime/translations/client_secrets
 * for use in the browser PWA's WebRTC SDP exchange.
 *
 * Auth: shared PIN (constant-time compare).
 * CORS: locked to https://kenkenno1.github.io (defense in depth).
 * Rate limit: in-memory ≤ 6 req/min per IP, per isolate (best-effort only;
 * concurrent isolates dilute hit counts and cold starts reset state).
 */

// 13 supported output languages for gpt-realtime-translate
const ALLOWED_LANGS = new Set([
  'en', 'es', 'pt', 'fr', 'ja', 'ru', 'zh',
  'de', 'ko', 'hi', 'id', 'vi', 'it',
]);

const ALLOWED_ORIGIN = 'https://kenkenno1.github.io';

// In-memory rate limit (per Worker isolate; concurrent isolates dilute hits,
// and cold starts reset state). This is best-effort, not a hard global cap.
const rateLimitWindow = 60_000; // 1 minute
const rateLimitMax = 6;
const ipHits = new Map(); // ip -> [timestamps]

// Body size cap. Real /session bodies only carry { targetLanguage, pin } —
// well under 200 bytes. 2 KB leaves slack for unicode PINs and future fields
// while flatly rejecting payload-bomb attempts.
const MAX_BODY_BYTES = 2048;

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    // Health check (GET /) — useful for sanity from a browser
    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({ ok: true, service: 'voice-translator-token-minter' }, 200, request);
    }

    // Only one real endpoint
    if (request.method !== 'POST' || url.pathname !== '/session') {
      return jsonResponse({ error: 'not_found' }, 404, request);
    }

    // Env sanity
    if (!env.OPENAI_API_KEY || !env.APP_PIN) {
      return jsonResponse({ error: 'server_misconfigured' }, 500, request);
    }

    // ----- Pre-auth checks -----
    // Rate limit BEFORE PIN check — wrong-PIN attempts must also be throttled,
    // otherwise an attacker can hammer the endpoint with bogus PINs at zero
    // cost to themselves but billable CPU on our side.
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (!checkRateLimit(ip)) {
      return jsonResponse({ error: 'rate_limited' }, 429, request);
    }

    // Body size cap. Reject obviously oversized payloads BEFORE consuming the
    // body. content-length is advisory but every legitimate client sends it;
    // missing CL cannot be rejected pre-consumption — for that case the
    // pre-auth rate limit (above) and the Worker runtime's per-request
    // CPU/memory limits are the fallbacks. Not a hard 2KB cap.
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse(
        { error: 'payload_too_large', max_bytes: MAX_BODY_BYTES },
        413,
        request,
      );
    }

    // Body parse
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400, request);
    }

    // Auth: PIN constant-time compare. (Rate limit already passed above.)
    if (typeof body.pin !== 'string' || !timingSafeEqual(body.pin, env.APP_PIN)) {
      return jsonResponse({ error: 'invalid_pin' }, 401, request);
    }

    // Validate target language
    if (!ALLOWED_LANGS.has(body.targetLanguage)) {
      return jsonResponse({ error: 'invalid_target_language' }, 400, request);
    }

    // Mint ephemeral token via OpenAI
    let apiResp;
    try {
      apiResp = await fetch('https://api.openai.com/v1/realtime/translations/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            model: 'gpt-realtime-translate',
            audio: {
              input: {
                transcription: { model: 'gpt-realtime-whisper' },
                noise_reduction: { type: 'near_field' },
              },
              output: { language: body.targetLanguage },
            },
          },
        }),
      });
    } catch (e) {
      return jsonResponse({ error: 'upstream_unreachable', detail: String(e) }, 502, request);
    }

    if (!apiResp.ok) {
      const text = await apiResp.text();
      return jsonResponse(
        { error: 'upstream_error', status: apiResp.status, detail: text.slice(0, 500) },
        502,
        request,
      );
    }

    let data;
    try {
      data = await apiResp.json();
    } catch (e) {
      return jsonResponse(
        { error: 'upstream_invalid_json', detail: String(e) },
        502,
        request,
      );
    }

    // Response shape may be either { value, expires_at } at top level
    // or { client_secret: { value, expires_at } }. Handle both.
    const ephemeral = data.value || data.client_secret?.value;
    const expires_at = data.expires_at || data.client_secret?.expires_at;

    if (!ephemeral) {
      return jsonResponse(
        { error: 'no_ephemeral_in_response', detail: JSON.stringify(data).slice(0, 500) },
        502,
        request,
      );
    }

    return jsonResponse({ ephemeral, expires_at }, 200, request);
  },
};

// ---------- helpers ----------

function corsHeaders(request) {
  const origin = request.headers.get('origin');
  // Allow the deployed PWA origin AND localhost for dev.
  // CORS is defense-in-depth here, NOT primary auth (PIN is).
  const allow =
    origin === ALLOWED_ORIGIN ||
    (origin && /^http:\/\/localhost(:\d+)?$/.test(origin)) ||
    (origin && /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin))
      ? origin
      : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(obj, status, request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

/**
 * Constant-time string compare. Workers don't expose crypto.timingSafeEqual,
 * so do it manually. Mismatched lengths still consume the loop time of the
 * longer of the two to avoid timing leaks via early return.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function checkRateLimit(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < rateLimitWindow);
  if (hits.length >= rateLimitMax) {
    ipHits.set(ip, hits); // keep pruned list
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  // Periodically prune oldest entries to bound map size
  if (ipHits.size > 1000) {
    const cutoff = now - rateLimitWindow;
    for (const [k, v] of ipHits) {
      const filtered = v.filter((t) => t > cutoff);
      if (filtered.length === 0) ipHits.delete(k);
      else ipHits.set(k, filtered);
    }
  }
  return true;
}

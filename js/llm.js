// LLM provider abstraction. Settings live in localStorage only (never Firestore).
// Providers: "none" | "gemini" | "ooba"
// Ooba uses the OpenAI-compatible endpoint (/v1/chat/completions) that
// text-generation-webui exposes.

const SETTINGS_KEY = "storybible.llm.settings.v1";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

const DEFAULTS = {
  provider: "none",
  geminiApiKey: "",
  geminiModel: GEMINI_DEFAULT_MODEL,
  oobaBaseUrl: "http://127.0.0.1:5000",
  oobaModel: "local-model",
  temperature: 0.3 // Gemma + local models only — Gemini no longer takes one
};

// ---------------------------------------------------------------------------
// Gemini model registry — checked against ai.google.dev on 2026-10-24
// (models, deprecations, pricing, thinking and rate-limit pages).
//
// `thinking` is the cheapest thinkingLevel the model accepts, used for JSON
// extraction where visible reasoning only burns output budget. Levels differ
// per model and a wrong one is a 400: 3.8 Flash, 4 Argon and 3.1 Pro reject
// "minimal"; 2.5 predates thinkingLevel entirely (uses thinkingBudget).
// `free` is whether the free tier serves it at all (pricing page). Google no
// longer publishes per-model free-tier request limits — they're per project
// and shown only in AI Studio — so the app learns them from 429s instead.
// ---------------------------------------------------------------------------
export const GEMINI_MODEL_INFO = {
  "gemini-3.8-flash":       { label: "Gemini 3.8 Flash",      free: true,  thinking: "low",     note: "newest Flash · recommended" },
  "gemini-3.6-flash":       { label: "Gemini 3.6 Flash",      free: true,  thinking: "minimal", note: "previous Flash" },
  "gemini-3.5-flash-lite":  { label: "Gemini 3.5 Flash-Lite", free: true,  thinking: "minimal", note: "fastest / cheapest" },
  "gemini-3.1-flash-lite":  { label: "Gemini 3.1 Flash-Lite", free: true,  thinking: "minimal", note: "shuts down May 7 2027" },
  "gemini-3-flash-preview": { label: "Gemini 3 Flash Preview", free: true, thinking: "minimal", note: "older preview" },
  "gemini-4-argon":         { label: "Gemini 4 Argon",        free: false, thinking: "low",     note: "flagship reasoning · paid tier only" },
  "gemini-3.1-pro-preview": { label: "Gemini 3.1 Pro Preview", free: false, thinking: "low",    note: "deep reasoning · paid tier only" },
  "gemini-2.5-flash":       { label: "Gemini 2.5 Flash",      free: true,  thinking: "budget0", note: "legacy · only keys that used it before" },
  "gemini-2.5-flash-lite":  { label: "Gemini 2.5 Flash-Lite", free: true,  thinking: "budget0", note: "legacy · only keys that used it before" },
  "gemini-2.5-pro":         { label: "Gemini 2.5 Pro",        free: true,  thinking: "default", note: "legacy · only keys that used it before" },
  "gemma-4-31b-it":         { label: "Gemma 4 31B",           free: true,  thinking: "default", note: "open model · free tier only" },
  "gemma-4-26b-a4b-it":     { label: "Gemma 4 26B-A4B (MoE)", free: true,  thinking: "default", note: "open model · free tier only" }
};

// Free-tier fall-through order. The app starts at the writer's chosen model
// and, when Google says that model's DAILY quota is spent, moves down the
// list for the rest of the (Pacific) day. Gemma is last: it has no JSON mode
// and needs the extra output-format nudging in callGemini.
export const GEMINI_FALLBACK_CHAIN = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it"
].map(id => ({ id, label: GEMINI_MODEL_INFO[id].label }));

// Options for the Settings model picker, chain first.
export const GEMINI_MODELS = [
  ...GEMINI_FALLBACK_CHAIN.map(m => m.id),
  ...Object.keys(GEMINI_MODEL_INFO).filter(id => !GEMINI_FALLBACK_CHAIN.some(c => c.id === id))
].map(id => {
  const info = GEMINI_MODEL_INFO[id];
  return { id, label: `${info.label} — ${info.note}${id === GEMINI_DEFAULT_MODEL ? " (default)" : ""}` };
});

// Ids that must not stay selected. Saved settings pointing here are moved to
// the default on read.
//   - shut down (hard 404): 1.x, 2.0, 3-pro-preview, 3.1-flash-lite-preview,
//     and the Gemma ids Google dropped from the API.
//   - deprecated 2026-10-08 and silently re-routed by Google (3.7 Flash →
//     3.8 Flash, 3.5 Flash → 3.6 Flash): they still answer, but as a
//     different model than the one named, with different thinking rules.
// Note: the 2.5 family is NOT here — Google restricts it to keys that used
// it before but hasn't deprecated it, so existing users keep the option.
const RETIRED_MODELS = [
  "gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro",
  "gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite", "gemini-2.0-flash-lite-001",
  "gemini-3-pro-preview", "gemini-3.1-flash-lite-preview",
  "gemini-3.7-flash", "gemini-3.5-flash",
  "gemma-3-27b-it", "gemma-3-12b-it", "gemma-4-e4b-it", "gemma-4-e2b-it"
];

// Floating aliases (gemini-flash-latest, gemini-pro-latest) silently repoint
// at whatever Google ships next — and each model takes different thinking
// levels, so an alias can start returning 400s overnight. Pin instead.
function isAlias(id) { return /-latest$/i.test(String(id || "")); }

// Ids that getSettings() would swap for the default — the Settings picker
// uses this to warn instead of letting a choice silently not stick.
export function isRetiredOrAliasModel(id) {
  const m = normalizeModelId(id);
  return RETIRED_MODELS.includes(m) || isAlias(m);
}

// "models/gemini-3.8-flash" (as ListModels and AI Studio print it) → bare id.
export function normalizeModelId(id) {
  return String(id || "").trim().replace(/^models\//i, "");
}

export function isGemmaModel(id) { return /^gemma/i.test(String(id || "")); }

// --- Per-model daily usage tracking ---
// Google resets requests-per-day at midnight PACIFIC time, so "today" is the
// Pacific date, not the local one. Stored as
//   { date: "YYYY-MM-DD", counts: { id: n }, exhausted: { id: true } }
// counts are informational (what this browser sent); `exhausted` is set only
// when Google itself returns a daily-quota 429, and drives the fall-through.

const USAGE_KEY = "storybible.llm.usage.v2";

// Quota belongs to the key's project, so a usage record only applies to the
// key it was recorded with — pasting a new key starts fresh. We store a short
// hash, never the key itself.
function keyFingerprint(key) {
  let h = 0x811c9dc5;
  for (const ch of String(key || "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
function currentKeyFingerprint() {
  try { return keyFingerprint(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}").geminiApiKey); }
  catch { return keyFingerprint(""); }
}

function quotaDayKey() {
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function getDailyUsage(apiKey) {
  const fresh = { date: quotaDayKey(), key: apiKey === undefined ? currentKeyFingerprint() : keyFingerprint(apiKey), counts: {}, exhausted: {} };
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw);
    if (parsed.date !== fresh.date || parsed.key !== fresh.key) return fresh;
    return { ...fresh, ...parsed, counts: parsed.counts || {}, exhausted: parsed.exhausted || {} };
  } catch {
    return fresh;
  }
}

function setDailyUsage(usage) {
  if (usage.key !== currentKeyFingerprint()) return; // testing an unsaved key
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(usage)); } catch {}
}

function bumpModelUsage(modelId, apiKey) {
  const usage = getDailyUsage(apiKey);
  usage.counts[modelId] = (usage.counts[modelId] || 0) + 1;
  setDailyUsage(usage);
}

function markModelExhausted(modelId, apiKey) {
  const usage = getDailyUsage(apiKey);
  usage.exhausted[modelId] = true;
  setDailyUsage(usage);
}

export function isModelExhausted(modelId) {
  return !!getDailyUsage().exhausted[modelId];
}

// Picks the actual model to call, given the user's chosen starting model.
// If the chosen model is in the fallback chain AND Google has told us its
// daily quota is gone, returns the next model that isn't. A manual pick
// outside the chain is returned as-is — we don't second-guess explicit choices.
export function pickActiveGeminiModel(chosen, apiKey) {
  const chainIndex = GEMINI_FALLBACK_CHAIN.findIndex(c => c.id === chosen);
  if (chainIndex < 0) return chosen;
  const usage = getDailyUsage(apiKey);
  for (let i = chainIndex; i < GEMINI_FALLBACK_CHAIN.length; i++) {
    if (!usage.exhausted[GEMINI_FALLBACK_CHAIN[i].id]) return GEMINI_FALLBACK_CHAIN[i].id;
  }
  // Everything is spent — call the last one anyway so the writer sees
  // Google's real quota error rather than nothing.
  return GEMINI_FALLBACK_CHAIN[GEMINI_FALLBACK_CHAIN.length - 1].id;
}

export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const merged = { ...DEFAULTS, ...JSON.parse(raw) };
    const model = normalizeModelId(merged.geminiModel);
    merged.geminiModel = (!model || isRetiredOrAliasModel(model)) ? DEFAULTS.geminiModel : model;
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function isConfigured() {
  const s = getSettings();
  if (s.provider === "gemini") return !!s.geminiApiKey;
  if (s.provider === "ooba") return !!s.oobaBaseUrl;
  return false;
}

// --- Core call ---

const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes — long enough for slow models, short enough to not freeze the UI forever

// Retry transient errors (5xx server errors, transient rate-limit hints).
// Returns true if we should retry, false to surface the error to the user.
function isTransientError(err) {
  const msg = err?.message || String(err);
  // 5xx server errors from either Gemini or Ooba paths
  if (/\b5\d\d\b/.test(msg) && /(temporarily unavailable|UNAVAILABLE|INTERNAL|server|overloaded)/i.test(msg)) return true;
  if (/Gemini (5\d\d|408)\b/.test(msg)) return true;
  if (/Ooba error 5\d\d/.test(msg)) return true;
  return false;
}

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1500, 4000]; // backoff between retries

// Plain-text convenience wrapper.
export async function callLLM(opts) {
  return (await callLLMDetailed(opts)).text;
}

// Sleep that a cancel/stop interrupts immediately.
function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason || new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Returns { text, model, truncated }. `settings` overrides the saved settings
// for this one call (Settings → Test connection uses it so testing never
// writes to storage).
export async function callLLMDetailed({ system, user, expectJson = false, temperature, signal, timeoutMs, settings }) {
  const s = settings ? { ...getSettings(), ...settings, geminiModel: normalizeModelId(settings.geminiModel) || getSettings().geminiModel } : getSettings();
  if (s.provider === "none") {
    throw new Error("No LLM provider configured. Open Settings.");
  }
  const temp = temperature ?? s.temperature ?? 0.3;

  // Repeat the JSON output contract as the LAST thing the model sees (see
  // JSON_OUTPUT_REMINDER). Only for JSON calls — prose tasks (scene drafting)
  // must not be told to emit JSON. Appended to the user turn so it lands after
  // the idea-dump for every provider, including the Gemma system-folded path.
  const effectiveUser = expectJson ? `${user}\n\n${JSON_OUTPUT_REMINDER}` : user;

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = (RETRY_DELAYS_MS[attempt - 1] || 4000) + Math.round(Math.random() * 500);
      console.log(`[llm] transient error, retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
      await abortableSleep(delay, signal);
    }
    // Each attempt gets its own timeout so a slow first attempt doesn't eat the budget for retries
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(new DOMException(`LLM call exceeded ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout`, "TimeoutError")), timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combinedSignal = anySignal([signal, timeoutCtl.signal]);
    try {
      if (s.provider === "gemini") return await callGemini(s, { system, user: effectiveUser, expectJson, temperature: temp, signal: combinedSignal });
      // (callOoba / callGemini both resolve to { text, model, truncated })
      if (s.provider === "ooba")   return await callOoba(s,   { system, user: effectiveUser, expectJson, temperature: temp, signal: combinedSignal });
      throw new Error(`Unknown provider: ${s.provider}`);
    } catch (err) {
      lastErr = err;
      // Don't retry if the caller aborted or our timeout fired
      if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
      // Don't retry permanent errors
      if (!isTransientError(err)) throw err;
      // else: loop continues, will retry after backoff
    } finally {
      clearTimeout(timer);
    }
  }
  // Exhausted retries — surface the last error with a hint
  throw new Error(`${lastErr?.message || String(lastErr)}\n\n(Already retried ${MAX_RETRIES} times. The provider's API is having sustained problems — try again in a minute or two.)`);
}

function anySignal(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  const ctl = new AbortController();
  for (const sig of valid) {
    if (sig.aborted) { ctl.abort(sig.reason); break; }
    sig.addEventListener("abort", () => ctl.abort(sig.reason), { once: true });
  }
  return ctl.signal;
}

function buildGeminiErrorMessage(status, errText, model) {
  let parsed = null;
  try { parsed = JSON.parse(errText); } catch {}
  const msg = parsed?.error?.message || "";
  const statusName = parsed?.error?.status || parsed?.error?.code || "";

  // Free tier 429 with explicit limit:0 → the project isn't eligible for the
  // free tier at all (typically a billed project, or a key made outside AI
  // Studio). Upgrading to paid does not unlock free-tier quota.
  if (status === 429 && /limit:\s*0/i.test(msg) && /free_tier/i.test(msg)) {
    return [
      `Gemini ${status} — this key's project has zero free-tier quota for ${model} (not a temporary rate limit).`,
      "",
      GEMINI_MODEL_INFO[model] && !GEMINI_MODEL_INFO[model].free
        ? `${GEMINI_MODEL_INFO[model].label} isn't offered on the free tier at all — pick a Flash model in Settings, or use a key on a paid project.`
        : "Most common cause: the key belongs to a Google Cloud project with billing enabled, or wasn't created through AI Studio. Free-tier eligibility is per project.",
      "Fix: open https://aistudio.google.com/apikey, create a new key and let AI Studio create a new project for it, then paste it into Settings.",
      `Model: ${model}`
    ].join("\n");
  }

  if (status === 429) {
    const retryMatch = msg.match(/retry in (\d+(?:\.\d+)?)/i);
    const retry = retryMatch ? ` Retry in ~${Math.ceil(parseFloat(retryMatch[1]))}s.` : "";
    return `Gemini ${status} — rate limited on ${model}.${retry}\n\nLimits are per Google Cloud project (not per key) and daily quotas reset at midnight Pacific time. Your project's exact limits are listed in AI Studio.`;
  }

  if (status === 402) {
    return `Gemini ${status} — your prepaid Gemini credits are used up. Top up in AI Studio, or switch to a free-tier model in Settings.`;
  }

  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) {
    return `Gemini ${status} — API key not valid. Re-copy it from https://aistudio.google.com/apikey.`;
  }
  if (status === 400 && /thinking/i.test(msg)) {
    return `Gemini ${status} — ${model} rejected the thinking setting this app sent. Google may have changed which levels it accepts; pick a different model in Settings and let us know.\n\nGoogle's message: ${msg.slice(0, 300)}`;
  }
  if (status === 403) {
    return [
      `Gemini ${status} — permission denied for ${model}.`,
      "Google blocks keys it detects as leaked, and rejects older unrestricted keys. Create a fresh key at https://aistudio.google.com/apikey (new keys are restricted to the Gemini API automatically) and paste it into Settings.",
      msg ? `\nGoogle's message: ${msg.slice(0, 300)}` : ""
    ].join("\n");
  }

  const alt = model === GEMINI_DEFAULT_MODEL ? "another model" : GEMINI_DEFAULT_MODEL;
  if (status === 404 && /no longer available to new users/i.test(msg)) {
    return `Gemini ${status} — ${model} is only available to keys that used it before. Switch to ${alt} in Settings.`;
  }
  if (status === 404) {
    return `Gemini ${status} — model "${model}" not found (Google may have retired it). Use "List models my key can use" in Settings and pick ${alt} — this app's model list may need an update.`;
  }

  // Transient server errors (Google's end). These usually clear within
  // seconds — surface as "try again" rather than implying user fault.
  if (status >= 500 && status < 600) {
    return `Gemini ${status} — Google's API is temporarily unavailable. This is on their end, not yours. Wait a few seconds and try again.${msg ? "\n\nGoogle's message: " + msg.slice(0, 200) : ""}`;
  }

  if (msg) return `Gemini ${status} ${statusName ? "(" + statusName + ")" : ""}: ${msg}`;
  return `Gemini ${status}: ${errText.slice(0, 400)}`;
}

// Safety: Google's default threshold is OFF for Gemini 2.5 and later, which
// is what a fiction-writing tool needs (novels, games and films routinely
// trip "harmful" filters with ordinary drama). Every model this app offers is
// 2.5+, so we send no safetySettings at all — the explicit BLOCK_NONE list we
// used to send included HARM_CATEGORY_CIVIC_INTEGRITY, now deprecated.

// Lesson adapted from the AI GM app: weak models (Gemma on the Gemini API, and
// local Ooba models) reliably forget a "return ONLY JSON" rule that sits at the
// TOP of the prompt by the time they finish reading a long idea-dump — they
// answer in prose or echo the schema template with "..." placeholders. The fix
// is to repeat the output contract as the LAST thing the model sees, right
// before it starts generating. Appended to the user turn for JSON calls only.
const JSON_OUTPUT_REMINDER = [
  "REMINDER — output format (this overrides any urge to explain or chat):",
  "Reply with ONLY the JSON described above. Start your reply with { and end with }.",
  "No prose before or after it, no markdown code fences, no comments.",
  'Do NOT copy the schema literally: replace every placeholder and every "..." with real',
  "values drawn from the text above. If you genuinely found nothing for a field, use an",
  'empty array [] or empty string "" — never a placeholder, never "...".'
].join("\n");

function labelForModel(modelId) {
  return GEMINI_MODEL_INFO[modelId]?.label || modelId;
}

// A 200-OK Gemini response can still carry no usable text. Gemini signals the
// reason two different ways and they need different advice:
//   - promptFeedback.blockReason → the INPUT was blocked before any generation
//   - candidates[0].finishReason → generation started, then stopped/was cut
// Adapted from the AI GM app so an empty reply tells the writer what to actually
// do (rephrase, shrink the dump, switch models) instead of a bare finishReason.
function buildEmptyResponseMessage(json, modelId) {
  const isGemma = isGemmaModel(modelId);
  const pf = json?.promptFeedback;
  if (pf?.blockReason) {
    if (/SAFETY/i.test(pf.blockReason)) {
      return isGemma
        ? `Gemini blocked your prompt as unsafe before generating anything (model ${labelForModel(modelId)}). Try rephrasing the idea dump or note.`
        : `Gemini blocked your prompt as unsafe before generating anything. Safety filters are already off for ${labelForModel(modelId)}, so this is a hard block — try rephrasing, or switch to a Gemma model in Settings (filtered differently).`;
    }
    return `Gemini blocked your prompt (${pf.blockReason}) before generating anything. Try rephrasing it, or switch models in Settings.`;
  }
  const reason = json?.candidates?.[0]?.finishReason;
  switch (reason) {
    case "MAX_TOKENS":
    case "CONTINUATION":
      return `${labelForModel(modelId)} ran out of output budget before writing an answer — its hidden "thinking" counts against the same budget. Shrink the idea-dump or note, or switch to ${labelForModel("gemini-3.5-flash-lite")} in Settings.`;
    case "SAFETY":
      return `Gemini stopped on its safety filter and returned nothing. Filters are already off for ${labelForModel(modelId)}, so try rephrasing, or switch to a Gemma model in Settings (filtered differently).`;
    case "RECITATION":
      return `Gemini stopped because its reply matched recited/copyrighted material. Rephrase to ask for original content, or just retry — this is often non-deterministic.`;
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "BLOCKLIST":
      return `Gemini refused to answer (${reason}) and returned nothing. Try rephrasing, or switch models in Settings.`;
    case "OTHER":
      return `Gemini stopped for an unspecified reason (finishReason: OTHER) and returned no text. Usually transient — try again, or switch models in Settings.`;
    default:
      return `Gemini returned an empty reply${reason ? ` (finishReason: ${reason})` : ""}. Retry, shrink the idea-dump, or pick a different model in Settings.`;
  }
}

// thinkingConfig for a JSON (extraction-style) call: the cheapest level the
// model accepts. Thinking tokens come out of maxOutputTokens, and extraction
// gains nothing from long hidden reasoning. Prose calls keep the default.
function jsonThinkingConfig(modelId) {
  const known = GEMINI_MODEL_INFO[modelId]?.thinking;
  const mode = known || (isGemmaModel(modelId) ? "default"
    : /^gemini-2\./i.test(modelId) ? "default"
    : "low"); // unknown newer Gemini: "low" is accepted by every 3.x/4 model
  if (mode === "low" || mode === "minimal") return { thinkingLevel: mode };
  if (mode === "budget0") return { thinkingBudget: 0 };
  return null;
}

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

function geminiHeaders(apiKey) {
  // The key goes in a header (Google's documented auth) rather than ?key=,
  // so it stays out of proxy logs, copied request URLs and history.
  return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
}

async function callGemini(s, { system, user, expectJson, temperature, signal }) {
  // Pick the actual model: start from user-chosen, fall through the chain
  // if Google has already told us the chosen one is spent for today.
  const key = s.geminiApiKey;
  const activeModel = pickActiveGeminiModel(normalizeModelId(s.geminiModel), key);
  if (activeModel !== s.geminiModel) {
    console.log(`[llm] ${s.geminiModel} is out of daily quota, falling through to ${activeModel}`);
  }

  const attemptCall = async (modelId) => {
    const url = `${GEMINI_ENDPOINT}/models/${encodeURIComponent(modelId)}:generateContent`;
    // Gemma models on the Gemini API are NOT in the structured-output model set
    // and are NOT part of the tunable-safety system (per Google's docs). So for
    // gemma-* ids we: fold the system prompt into the user turn instead of
    // sending systemInstruction, and do NOT request
    // responseMimeType: application/json. Correction (verified live
    // 2026-08-21): that field is not rejected, it is accepted and silently
    // IGNORED — so no error ever surfaces, Gemma just answers in prose. Worse,
    // it often answers with a bulleted preamble containing no braces at all,
    // which parseJsonLoose cannot recover. The fix is the output-format hint below.
    const isGemma = isGemmaModel(modelId);
    const generationConfig = {
      // Thinking tokens count against this. 32k leaves room for low-level
      // thinking plus the largest extraction JSON; the models allow 65,536.
      // Gemma's output cap on the API isn't published, so it keeps 8k.
      maxOutputTokens: isGemma ? 8192 : 32768
    };
    // Google deprecated temperature/topP/topK for Gemini (July 2026): ignored
    // on 3.6+ and slated to become a 400, and values under 1.0 can make
    // Gemini 3 loop. Only Gemma — a separate open model — still takes one.
    if (isGemma && typeof temperature === "number") generationConfig.temperature = temperature;
    const body = {
      contents: [{ role: "user", parts: [{ text: isGemma && system ? `${system}\n\n${user}` : user }] }],
      generationConfig
    };
    if (system && !isGemma) body.systemInstruction = { parts: [{ text: system }] };
    if (expectJson && !isGemma) generationConfig.responseMimeType = "application/json";
    // Gemma has no JSON mode and responseMimeType is accepted-then-IGNORED, so
    // nothing errors -- it just answers in bulleted prose that can contain no
    // braces at all. Over 10 runs on a reproducing prompt this wording parsed
    // 10/10 where a weaker hint parsed 5/10. A '{' model-turn prefill was tried
    // and REJECTED (and Gemini 3.6+ now 400s any request ending on a model
    // turn). Verified 2026-08-21.
    if (expectJson && isGemma) {
      body.contents[0].parts.push({ text: "\n\nOutput format: a single JSON object and nothing else. No preamble, no plan, no bullet points, no commentary. A ```json fenced block is acceptable. Your entire reply must be the JSON." });
    }
    if (expectJson) {
      const thinking = jsonThinkingConfig(modelId);
      if (thinking) generationConfig.thinkingConfig = thinking;
    }

    console.log("[llm] Gemini POST", { model: modelId, usedToday: getDailyUsage(key).counts[modelId] || 0, expectJson, isGemma, thinking: generationConfig.thinkingConfig || "default" });
    const resp = await fetch(url, {
      method: "POST",
      headers: geminiHeaders(key),
      body: JSON.stringify(body),
      signal
    });
    if (!resp.ok) {
      const errText = await resp.text();
      const err = new Error(buildGeminiErrorMessage(resp.status, errText, modelId));
      err.status = resp.status;
      err.modelId = modelId;
      err.body = errText;
      throw err;
    }
    // A 200 means Google accepted and ran the call — it spends quota NOW,
    // before we know if usable text came back. Count it here so an
    // empty/filtered reply is still tallied. 429/5xx/timeouts never reach a
    // 200, so they're correctly not counted.
    bumpModelUsage(modelId, key);
    const json = await resp.json();
    // A thinking model can return its reasoning as a leading thought part and
    // split the answer over several parts — join every non-thought text part.
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const text = parts.filter(p => !p.thought && typeof p.text === "string").map(p => p.text).join("");
    const finishReason = json?.candidates?.[0]?.finishReason;
    console.log("[llm] Gemini reply", { model: modelId, length: text.length, finishReason, preview: text.slice(0, 200) });
    if (!text) {
      throw new Error(buildEmptyResponseMessage(json, modelId));
    }
    return { text, model: modelId, truncated: finishReason === "MAX_TOKENS" || finishReason === "CONTINUATION" };
  };

  // On a 429, fall through the chain. Only a DAILY quota hit marks the model
  // exhausted for the day — a per-minute limit (common during Global
  // Refresh bursts) just skips it for this one call.
  //   - "limit: 0" = the project isn't free-tier eligible at all. That's not
  //     a spent quota, and every free model will say the same — stop now.
  //   - per-minute: wait out a short retry hint and try the same model once;
  //     otherwise move down the chain for this call only.
  let model = activeModel;
  let waitedOn = null;
  for (let hops = 0; ; hops++) {
    try {
      return await attemptCall(model);
    } catch (err) {
      if (err?.status !== 429) throw err;
      if (isZeroQuota(err.body)) throw err;
      const kind = quotaKind(err.body);
      const hint = retryAfterSeconds(err.body);
      if (kind === "daily") markModelExhausted(model, key);
      if (kind !== "daily" && hint !== null && hint <= 15 && waitedOn !== model) {
        waitedOn = model;
        console.log(`[llm] ${model} per-minute 429; waiting ${hint}s then retrying`);
        await abortableSleep(Math.ceil(hint * 1000) + 250, signal);
        continue;
      }
      const next = nextChainModel(model, key);
      if (next && hops < GEMINI_FALLBACK_CHAIN.length) {
        console.log(`[llm] ${model} hit a ${kind} 429; auto-switching to ${next}`);
        model = next;
        continue;
      }
      // Nowhere left to go. A manual pick (Argon, 3.1 Pro) with a modest
      // per-minute hint gets one patient retry.
      if (kind !== "daily" && hint !== null && hint <= 60 && waitedOn !== model) {
        waitedOn = model;
        await abortableSleep(Math.ceil(hint * 1000) + 250, signal);
        continue;
      }
      const inChain = GEMINI_FALLBACK_CHAIN.some(c => c.id === model);
      if (inChain && GEMINI_FALLBACK_CHAIN.every(c => getDailyUsage(key).exhausted[c.id])) {
        err.message = `Every free Gemini model is out of daily quota for this key (${GEMINI_FALLBACK_CHAIN.map(c => c.label).join(", ")}). Quota resets at midnight Pacific time — about ${hoursToPacificMidnight()} from now.\n\n${err.message}`;
      }
      throw err;
    }
  }
}

function isZeroQuota(body) {
  return /limit:\s*0\b/i.test(String(body || "")) && /free_tier/i.test(String(body || ""));
}

// "daily" | "minute" | "unknown". Unknown 429s skip the model for this call
// only — wrongly locking the preferred model until midnight is the worse error.
function quotaKind(body) {
  const text = String(body || "");
  if (/PerDay|quota_exceeded/i.test(text)) return "daily";
  if (/PerMinute|per minute|rate_limit_exceeded|retry in \d/i.test(text)) return "minute";
  return "unknown";
}

function retryAfterSeconds(body) {
  const text = String(body || "");
  const m = text.match(/retry in (\d+(?:\.\d+)?)\s*s/i) || text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  return m ? parseFloat(m[1]) : null;
}

function hoursToPacificMidnight() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === "hour").value) % 24;
    const m = Number(parts.find(p => p.type === "minute").value);
    const mins = 24 * 60 - (h * 60 + m);
    return mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
  } catch { return "a few hours"; }
}

// Next model after `model` in the fallback chain that isn't spent for today.
function nextChainModel(model, apiKey) {
  const usage = getDailyUsage(apiKey);
  const i = GEMINI_FALLBACK_CHAIN.findIndex(c => c.id === model);
  if (i < 0) return null; // manual pick outside the chain — don't second-guess it
  for (let j = i + 1; j < GEMINI_FALLBACK_CHAIN.length; j++) {
    if (!usage.exhausted[GEMINI_FALLBACK_CHAIN[j].id]) return GEMINI_FALLBACK_CHAIN[j].id;
  }
  return null;
}

async function callOoba(s, { system, user, expectJson, temperature, signal }) {
  const base = s.oobaBaseUrl.replace(/\/+$/, "");
  const url = `${base}/v1/chat/completions`;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const body = {
    model: s.oobaModel || "local-model",
    messages,
    temperature,
    // Bumped from 2048 — rich JSON extractions with multiple characters,
    // scenes, beats, and connections were getting truncated mid-array,
    // leading to parse errors and few cards reaching the approval modal.
    max_tokens: 4096
  };
  // Note: we used to send response_format:{type:"json_object"} when expectJson
  // was true, but ooba's OpenAI extension doesn't reliably honor it — some
  // builds error, others hang. The prompts already instruct "Return ONLY this
  // JSON" and parseJsonLoose handles fenced/wrapped output, so we leave it off.

  console.log("[llm] Ooba POST", { url, model: body.model, expectJson, promptChars: (system||"").length + user.length });
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    // fetch throws TypeError("Failed to fetch") for: CORS block, mixed content,
    // DNS failure, connection refused, network down. The browser doesn't
    // distinguish these on purpose — so we build a diagnostic message.
    if (err?.name === "AbortError" || err?.name === "TimeoutError") throw err;
    const pageProto = (typeof location !== "undefined" && location.protocol) || "";
    const urlProto = url.startsWith("https:") ? "https:" : "http:";
    const mixedContent = pageProto === "https:" && urlProto === "http:";
    const hints = [];
    if (mixedContent) {
      hints.push(`MIXED CONTENT: this page is loaded over HTTPS (${location.origin}) but Ooba is at ${urlProto} — browsers block this. Run the app over http://localhost:PORT instead of GitHub Pages, OR put Ooba behind an HTTPS tunnel (cloudflared / ngrok), OR switch to a remote provider like Gemini.`);
    } else {
      hints.push("Ooba isn't reachable from the browser. Most likely causes:");
      hints.push("  • Ooba isn't running, or not listening on " + base);
      hints.push("  • The OpenAI extension isn't loaded — start with: python server.py --api --extensions openai (or check the OpenAI extension is enabled in the UI)");
      hints.push("  • CORS — ooba's openai extension needs to allow your page's origin. Check ooba console for the actual port (default is 5000 for ooba <=1.6, 5005 for newer builds, and the OpenAI endpoint can be on a different port).");
    }
    const wrapped = new Error("Ooba fetch failed: " + (err.message || err) + "\n\n" + hints.join("\n"));
    wrapped.cause = err;
    throw wrapped;
  }
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Ooba error ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content ?? "";
  const finish = json?.choices?.[0]?.finish_reason;
  console.log("[llm] Ooba reply", { length: text.length, preview: text.slice(0, 200) });
  if (!text) {
    throw new Error("Ooba returned an empty message. Check the ooba console for an error, or try a different model.");
  }
  if (finish === "length") console.warn("[llm] Ooba reply hit max_tokens — output is truncated");
  return { text, model: s.oobaModel || "local-model", truncated: finish === "length" };
}

// --- JSON extraction ---
// LLMs sometimes wrap JSON in prose or code fences even when asked not to.
// Pull out the first balanced JSON object/array.

// Calls Gemini's models.list endpoint to show what's actually available
// for the configured API key. Used by Settings to take the guesswork
// out of "is this model supported for me?".
export async function listGeminiModels(apiKey) {
  if (!apiKey) throw new Error("API key required.");
  const resp = await fetch(`${GEMINI_ENDPOINT}/models?pageSize=200`, { headers: geminiHeaders(apiKey) });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(buildGeminiErrorMessage(resp.status, errText, "(models.list)"));
  }
  const json = await resp.json();
  const models = (json?.models || []).map(m => ({
    // Returned as "models/gemini-2.5-flash" — strip the prefix for our use
    id: (m.name || "").replace(/^models\//, ""),
    displayName: m.displayName || "",
    description: m.description || "",
    supports: m.supportedGenerationMethods || m.supportedActions || []
  }));
  // Only text models this app can use: generateContent, and not an image /
  // speech / embedding / live model (those share the method but can't write
  // story JSON back).
  return models.filter(m =>
    m.supports.includes("generateContent") &&
    !/embedding|aqa|tts|image|banana|live|veo|imagen|robotics|transcribe|computer-use|customtools/i.test(m.id));
}

// Shared "call → parse JSON, retry once with a repair pass if parsing fails".
// Used by refresh.js and review.js so the JSON-string brittleness behaves the
// same everywhere. Replaces ad-hoc callJson helpers that duplicated this
// logic with subtle differences.
// Results cut off by the output limit are still returned (the complete items
// are worth keeping) but carry a non-enumerable `_truncated` flag so the UI
// can tell the writer something is missing.
function markTruncated(obj) {
  if (obj && typeof obj === "object" && !obj._truncated) {
    Object.defineProperty(obj, "_truncated", { value: true, enumerable: false });
  }
  return obj;
}
export function wasTruncated(obj) { return !!obj?._truncated; }

export async function callLLMJson({ system, user, temperature, signal }) {
  const first = await callLLMDetailed({ system, user, expectJson: true, temperature, signal });
  const raw = first.text;
  try {
    const parsed = parseJsonLoose(raw);
    return first.truncated ? markTruncated(parsed) : parsed;
  } catch (firstErr) {
    if (firstErr.noRepair) throw firstErr; // nothing there to repair
    console.warn("[llm] JSON parse failed once, retrying with cleanup prompt:", firstErr.message);
    const cleanupSystem = "You are a JSON repair assistant. The user will paste broken or wrapped JSON. Return ONLY the corrected JSON, no prose, no fences. Preserve all data; only fix syntax.";
    const repaired = await callLLM({
      system: cleanupSystem,
      user: `Broken output:\n${raw}`,
      expectJson: true,
      temperature: 0,
      signal
    });
    const fixed = parseJsonLoose(repaired);
    return first.truncated ? markTruncated(fixed) : fixed;
  }
}

export function parseJsonLoose(text) {
  if (!text) throw new Error("Empty LLM response.");
  // Reasoning models wrap their scratchpad in <think> tags — and often quote
  // the schema in there, which used to be picked up as "the JSON".
  const cleaned = String(text)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/^[\s\S]*<\/think(?:ing)?>/i, "")
    // An opening tag with no close = the model ran out mid-thought; nothing
    // after it is an answer (often it's the schema being quoted).
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .trim();
  if (!cleaned) {
    const err = new Error("The model spent its whole reply thinking and never wrote an answer. Retry, or shorten the note / idea dump.");
    err.noRepair = true;
    throw err;
  }

  const attempt = (candidate) => {
    for (const variant of [candidate, relaxJson(candidate)]) {
      try {
        const v = JSON.parse(variant);
        // A schema echoed back with "..." placeholders parses fine but is
        // not an answer — refuse it so the repair pass / error message runs.
        if (v && typeof v === "object" && !hasPlaceholder(v)) return { ok: true, value: v };
      } catch (e) {}
    }
    return { ok: false };
  };

  let r = attempt(cleaned);
  if (r.ok) return r.value;

  // Fenced blocks, in order.
  for (const m of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    r = attempt(m[1].trim());
    if (r.ok) return r.value;
  }

  // Every balanced {...} / [...] candidate, left to right — a preamble like
  // "Here it is [as requested]:" must not stop us from finding the object.
  let firstSlice = null, firstErr = null, unterminatedAt = -1;
  let tries = 0, skipUntil = -1;
  for (let start = 0; start < cleaned.length && tries < 40; start++) {
    const ch = cleaned[start];
    if (ch !== "{" && ch !== "[") continue;
    // Never fall back to a fragment nested inside a candidate that failed.
    if (start <= skipUntil) continue;
    tries++;
    const end = findBalancedEnd(cleaned, start);
    if (end < 0) {
      // Everything after this point is inside the unterminated structure.
      unterminatedAt = start;
      break;
    }
    skipUntil = end;
    const slice = cleaned.slice(start, end + 1);
    r = attempt(slice);
    if (r.ok) return r.value;
    if (firstSlice === null) {
      firstSlice = slice;
      try { JSON.parse(slice); } catch (e) { firstErr = e; }
    }
  }

  // Truncated output (hit max_tokens): close the open structure and keep
  // whatever complete items made it through.
  if (unterminatedAt >= 0) {
    const repaired = repairTruncated(cleaned.slice(unterminatedAt));
    if (repaired !== undefined && !hasPlaceholder(repaired)) {
      console.warn("[parseJsonLoose] LLM output was truncated; recovered the complete part");
      return markTruncated(repaired);
    }
  }

  console.error("[parseJsonLoose] could not parse LLM output:", cleaned);
  throw new Error(buildParseError(firstErr, firstSlice, cleaned, unterminatedAt >= 0));
}

function hasPlaceholder(v) {
  if (typeof v === "string") return /^\s*(\.{3}|…)\s*$/.test(v);
  if (Array.isArray(v)) return v.some(hasPlaceholder);
  if (v && typeof v === "object") return Object.values(v).some(hasPlaceholder);
  return false;
}

// Index of the bracket closing the one at `start`, or -1 if never closed.
function findBalancedEnd(text, start) {
  const stack = [];
  let inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

// Fix the JSON mistakes models make most: // and /* */ comments, trailing
// commas before } or ]. String contents are left untouched.
function relaxJson(text) {
  let out = "";
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (c === ",") {
      // Trailing comma (only ever outside a string here): drop it.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}

// Close a truncated JSON document. Tries cutting back to each of the last
// few commas (dropping the half-written item) and closing every open bracket.
function repairTruncated(text) {
  const stack = [];
  const cuts = []; // { pos, closers } at each top-level-of-item comma
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") cuts.push({ pos: i, closers: stack.slice().reverse().join("") });
  }
  for (let k = cuts.length - 1; k >= 0 && k >= cuts.length - 25; k--) {
    const candidate = relaxJson(text.slice(0, cuts[k].pos)) + cuts[k].closers;
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object") return v;
    } catch (e) {}
  }
  return undefined;
}

function buildParseError(jsonErr, slice, fullText, truncated) {
  const ellipsisLikely = /\[\s*\.{2,3}/.test(fullText) || /:\s*"\.{3}"/.test(fullText) || /"\.\.\."/.test(fullText);
  const lines = [];
  if (jsonErr) lines.push(`Could not parse JSON from LLM output: ${jsonErr.message}`);
  else if (truncated) lines.push("The LLM's JSON was cut off before it finished (it likely hit its output-length limit).");
  else        lines.push("No JSON object found in LLM output.");
  if (truncated) {
    lines.push("");
    lines.push("Try a shorter note / idea dump, or a model with a larger output budget.");
  }
  if (ellipsisLikely) {
    lines.push("");
    lines.push("It looks like the model returned the schema template literally — with \"...\" placeholders instead of real content. This is common with smaller local models.");
    lines.push("Try a stronger model, lower the temperature in Settings, or shrink the idea-dump to reduce prompt size.");
  }
  lines.push("");
  lines.push("Model returned (first 600 chars):");
  lines.push((fullText || "").slice(0, 600));
  return lines.join("\n");
}

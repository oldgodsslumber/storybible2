// LLM provider abstraction. Settings live in localStorage only (never Firestore).
// Providers: "none" | "gemini" | "ooba"
// Ooba uses the OpenAI-compatible endpoint (/v1/chat/completions) that
// text-generation-webui exposes.

const SETTINGS_KEY = "storybible.llm.settings.v1";

const DEFAULTS = {
  provider: "none",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash-lite",
  oobaBaseUrl: "http://127.0.0.1:5000",
  oobaModel: "local-model",
  temperature: 0.3
};

// Fallback chain for free-tier Gemini API usage. The app starts at the top
// of this list, and when a model hits its daily limit (tracked in
// localStorage) or returns a quota-exhausted 429, it automatically falls
// through to the next entry. End users don't need to know any of this.
//
// Numbers are the user-stated daily limits as of mid-2026. Google adjusts
// these often; if real-world numbers differ, edit `dailyLimit` here.
//
// Gemma 4 model IDs verified against Google's Hugging Face listing
// (huggingface.co/google):
//   - gemma-4-31b-it       — 31B dense, instruction-tuned
//   - gemma-4-26b-a4b-it   — 26B MoE (4B active params), instruction-tuned
//   - gemma-4-e4b-it       — effective 4B, smaller variant
//   - gemma-4-e2b-it       — effective 2B, smallest variant
// IDs are lowercased here to match the Gemini API URL convention
// (Gemma 3 uses gemma-3-27b-it lowercase). If Google's API expects
// mixed case (e.g. gemma-4-31B-it), one edit here updates everything.
export const GEMINI_FALLBACK_CHAIN = [
  { id: "gemini-2.5-flash",       dailyLimit: 20,   label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite",  dailyLimit: 20,   label: "Gemini 2.5 Flash Lite" },
  { id: "gemma-4-31b-it",         dailyLimit: 1500, label: "Gemma 4 31B (dense)" },
  { id: "gemma-4-26b-a4b-it",     dailyLimit: 1500, label: "Gemma 4 26B-A4B (MoE)" }
];

// Suggested models for the autocomplete picker. The first four are the
// fallback chain; the rest are useful options for users with paid tier or
// older keys that have access to them.
export const GEMINI_MODELS = [
  ...GEMINI_FALLBACK_CHAIN.map((m, i) => ({
    id: m.id,
    label: `${m.id} — ${m.label} · ${m.dailyLimit}/day free${i === 0 ? " (default — chain auto-falls through)" : ""}`
  })),
  // Smaller Gemma 4 variants — useful for very high throughput needs
  { id: "gemma-4-e4b-it",         label: "gemma-4-e4b-it — Gemma 4 4B (effective), tiny / fast" },
  { id: "gemma-4-e2b-it",         label: "gemma-4-e2b-it — Gemma 4 2B (effective), tinier / faster" },

  // Pro and legacy / Gemma 3 family — manual selection only
  { id: "gemini-2.5-pro",         label: "gemini-2.5-pro — smartest, lowest free quota" },
  { id: "gemini-2.0-flash",       label: "gemini-2.0-flash — older (usually paid tier only)" },
  { id: "gemma-3-27b-it",         label: "gemma-3-27b-it — Gemma 3 27B (availability varies)" },
  { id: "gemma-3-12b-it",         label: "gemma-3-12b-it — Gemma 3 12B (availability varies)" }
];

// --- Per-model daily usage tracking ---
// Stored in localStorage as { date: "YYYY-MM-DD", counts: { modelId: n } }.
// Date is local; resets at local midnight.

const USAGE_KEY = "storybible.llm.usage.v1";

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function getDailyUsage() {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    if (!raw) return { date: todayKey(), counts: {} };
    const parsed = JSON.parse(raw);
    if (parsed.date !== todayKey()) return { date: todayKey(), counts: {} };
    return parsed;
  } catch {
    return { date: todayKey(), counts: {} };
  }
}

function setDailyUsage(usage) {
  localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
}

function bumpModelUsage(modelId) {
  const usage = getDailyUsage();
  usage.counts[modelId] = (usage.counts[modelId] || 0) + 1;
  setDailyUsage(usage);
}

function markModelExhausted(modelId) {
  const usage = getDailyUsage();
  const chainEntry = GEMINI_FALLBACK_CHAIN.find(c => c.id === modelId);
  // Bump to limit (or +1 if not in chain) so pickActiveModel skips it.
  usage.counts[modelId] = chainEntry ? chainEntry.dailyLimit : (usage.counts[modelId] || 0) + 1;
  setDailyUsage(usage);
}

// Picks the actual model to call, given the user's chosen starting model.
// If the chosen model is in the fallback chain AND is exhausted for today,
// returns the next non-exhausted model. If the chosen model is NOT in the
// chain (user manually picked something like 2.5-pro), returns it as-is —
// we don't second-guess explicit choices outside the chain.
export function pickActiveGeminiModel(chosen) {
  const usage = getDailyUsage();
  const chainIndex = GEMINI_FALLBACK_CHAIN.findIndex(c => c.id === chosen);
  if (chainIndex < 0) return chosen; // manual override outside the chain
  for (let i = chainIndex; i < GEMINI_FALLBACK_CHAIN.length; i++) {
    const entry = GEMINI_FALLBACK_CHAIN[i];
    const used = usage.counts[entry.id] || 0;
    if (used < entry.dailyLimit) return entry.id;
  }
  // Everything in the chain is exhausted — return the last one anyway so the
  // user sees a real Google rate-limit error rather than nothing.
  return GEMINI_FALLBACK_CHAIN[GEMINI_FALLBACK_CHAIN.length - 1].id;
}

export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
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
  if (/Gemini 5\d\d/.test(msg)) return true;
  if (/Ooba error 5\d\d/.test(msg)) return true;
  return false;
}

const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [1500, 4000]; // backoff between retries

export async function callLLM({ system, user, expectJson = false, temperature, signal, timeoutMs }) {
  const s = getSettings();
  if (s.provider === "none") {
    throw new Error("No LLM provider configured. Open Settings.");
  }
  const temp = temperature ?? s.temperature ?? 0.3;

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] || 4000;
      console.log(`[llm] transient error, retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
    // Each attempt gets its own timeout so a slow first attempt doesn't eat the budget for retries
    const timeoutCtl = new AbortController();
    const timer = setTimeout(() => timeoutCtl.abort(new DOMException(`LLM call exceeded ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout`, "TimeoutError")), timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combinedSignal = anySignal([signal, timeoutCtl.signal]);
    try {
      if (s.provider === "gemini") return await callGemini(s, { system, user, expectJson, temperature: temp, signal: combinedSignal });
      if (s.provider === "ooba")   return await callOoba(s,   { system, user, expectJson, temperature: temp, signal: combinedSignal });
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
  const statusName = parsed?.error?.status || "";

  // Free tier 429 with explicit limit:0 → key is not eligible for free tier
  // (typically because the underlying Google Cloud project has billing
  // enabled, or the key wasn't created through AI Studio).
  if (status === 429 && /limit:\s*0/i.test(msg) && /free_tier/i.test(msg)) {
    return [
      `Gemini ${status} — your API key has zero free-tier quota (not a temporary rate limit).`,
      "",
      "Most common cause: the key was created from a Google Cloud project that has billing enabled, or wasn't created through AI Studio.",
      "Fix:",
      "  1. Open https://aistudio.google.com/app/api-keys",
      "  2. DELETE the key you're currently using",
      "  3. Click 'Create API key' and let AI Studio pick the project (it'll use one without billing — required for free tier)",
      "  4. Paste the new key into Settings here",
      "",
      "If you specifically want to use a billed project: enable billing on the project in Google Cloud Console and quota will increase to paid limits.",
      `Model: ${model}`
    ].join("\n");
  }

  // Normal rate limit (transient)
  if (status === 429) {
    const retryMatch = msg.match(/retry in (\d+)/i);
    const retry = retryMatch ? ` Retry in ~${retryMatch[1]}s.` : "";
    return `Gemini ${status} — rate limited.${retry}\n\nIf this keeps happening on the very first request, the project may have a 0 quota — see the Gemini help text in Settings.`;
  }

  // Auth / key errors
  if (status === 400 && /API key not valid/i.test(msg)) {
    return `Gemini ${status} — API key not valid. Re-paste from https://aistudio.google.com/app/api-keys (the key starts with AIza...).`;
  }
  if (status === 403) {
    return `Gemini ${status} — forbidden. The API key may not have permission for this model (${model}). Try a different key or model.`;
  }

  // Model not found
  if (status === 404 && /not found/i.test(msg)) {
    return `Gemini ${status} — model "${model}" not found. Try changing the Model field in Settings to "gemini-2.5-flash-lite" or "gemini-2.5-flash".`;
  }

  // Transient server errors (Google's end). These usually clear within
  // seconds — surface as "try again" rather than implying user fault.
  if (status >= 500 && status < 600) {
    return `Gemini ${status} — Google's API is temporarily unavailable. This is on their end, not yours. Wait a few seconds and try again.${msg ? "\n\nGoogle's message: " + msg.slice(0, 200) : ""}`;
  }

  // Fallback: surface the parsed message if we got one, else raw text
  if (msg) return `Gemini ${status} ${statusName ? "(" + statusName + ")" : ""}: ${msg}`;
  return `Gemini ${status}: ${errText.slice(0, 400)}`;
}

// Safety filter settings. The app is used to write novels, video games,
// and feature films — content that the default Gemini filters routinely
// block as "harmful" even when it's just normal dramatic writing. We
// explicitly set every category to BLOCK_NONE.
//
// BLOCK_NONE may be rejected by some projects (typically those without
// billing); if Google returns an error mentioning safetySettings, the
// user can either enable billing or fall back to a Gemma model where
// safety is not enforced the same way.
const SAFETY_OFF = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY",   threshold: "BLOCK_NONE" }
];

async function callGemini(s, { system, user, expectJson, temperature, signal }) {
  // Pick the actual model: start from user-chosen, fall through the chain
  // if the chosen one is exhausted for today.
  let activeModel = pickActiveGeminiModel(s.geminiModel);
  const usage = getDailyUsage();
  if (activeModel !== s.geminiModel) {
    console.log(`[llm] ${s.geminiModel} is exhausted (${usage.counts[s.geminiModel] || 0}/day used), falling through to ${activeModel}`);
  }

  const attemptCall = async (modelId) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature, maxOutputTokens: 8192 },
      safetySettings: SAFETY_OFF
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (expectJson) body.generationConfig.responseMimeType = "application/json";

    const u = getDailyUsage();
    console.log("[llm] Gemini POST", { model: modelId, used: u.counts[modelId] || 0, expectJson });
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    if (!resp.ok) {
      const errText = await resp.text();
      const err = new Error(buildGeminiErrorMessage(resp.status, errText, modelId));
      err.status = resp.status;
      err.modelId = modelId;
      throw err;
    }
    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
    console.log("[llm] Gemini reply", { model: modelId, length: text.length, preview: text.slice(0, 200) });
    if (!text) {
      const finishReason = json?.candidates?.[0]?.finishReason;
      const safety = json?.candidates?.[0]?.safetyRatings;
      throw new Error(`Gemini returned no text. finishReason=${finishReason || "unknown"}${safety ? "; safetyRatings=" + JSON.stringify(safety) : ""}`);
    }
    bumpModelUsage(modelId);
    return text;
  };

  try {
    return await attemptCall(activeModel);
  } catch (err) {
    // If we hit a rate limit on this model, mark it exhausted and try the
    // next one in the chain (if any). This handles the case where our
    // local counter is behind Google's (e.g. user used the same key on
    // another device or pre-existing quota usage today).
    const isRateLimit = err?.status === 429;
    if (!isRateLimit) throw err;
    markModelExhausted(activeModel);
    const fallback = pickActiveGeminiModel(activeModel);
    if (fallback === activeModel) throw err; // no more chain to fall through
    console.log(`[llm] ${activeModel} hit 429; auto-switching to ${fallback}`);
    return await attemptCall(fallback);
  }
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
  console.log("[llm] Ooba reply", { length: text.length, preview: text.slice(0, 200) });
  if (!text) {
    throw new Error("Ooba returned an empty message. Check the ooba console for an error, or try a different model.");
  }
  return text;
}

// --- JSON extraction ---
// LLMs sometimes wrap JSON in prose or code fences even when asked not to.
// Pull out the first balanced JSON object/array.

// Calls Gemini's models.list endpoint to show what's actually available
// for the configured API key. Used by Settings to take the guesswork
// out of "is this model supported for me?".
export async function listGeminiModels(apiKey) {
  if (!apiKey) throw new Error("API key required.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
  const resp = await fetch(url);
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
    supports: m.supportedGenerationMethods || []
  }));
  // Only show models that actually support generateContent (what we use)
  return models.filter(m => m.supports.includes("generateContent"));
}

// Shared "call → parse JSON, retry once with a repair pass if parsing fails".
// Used by refresh.js and review.js so the JSON-string brittleness behaves the
// same everywhere. Replaces ad-hoc callJson helpers that duplicated this
// logic with subtle differences.
export async function callLLMJson({ system, user, temperature, signal }) {
  const raw = await callLLM({ system, user, expectJson: true, temperature, signal });
  try {
    return parseJsonLoose(raw);
  } catch (firstErr) {
    console.warn("[llm] JSON parse failed once, retrying with cleanup prompt:", firstErr.message);
    const cleanupSystem = "You are a JSON repair assistant. The user will paste broken or wrapped JSON. Return ONLY the corrected JSON, no prose, no fences. Preserve all data; only fix syntax.";
    const repaired = await callLLM({
      system: cleanupSystem,
      user: `Broken output:\n${raw}`,
      expectJson: true,
      temperature: 0,
      signal
    });
    return parseJsonLoose(repaired);
  }
}

export function parseJsonLoose(text) {
  if (!text) throw new Error("Empty LLM response.");
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  // Strip code fences
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  // Find first { or [ and balance
  const start = trimmed.search(/[{[]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const slice = trimmed.slice(start, i + 1);
          try { return JSON.parse(slice); } catch (e) {
            console.error("[parseJsonLoose] JSON.parse failed on slice:", slice);
            throw new Error(buildParseError(e, slice, trimmed));
          }
        }
      }
    }
  }
  console.error("[parseJsonLoose] no JSON object/array found in LLM output:", trimmed);
  throw new Error(buildParseError(null, null, trimmed));
}

function buildParseError(jsonErr, slice, fullText) {
  const ellipsisLikely = /\[\s*\.{2,3}/.test(fullText) || /:\s*"\.{3}"/.test(fullText) || /"\.\.\."/.test(fullText);
  const lines = [];
  if (jsonErr) lines.push(`Could not parse JSON from LLM output: ${jsonErr.message}`);
  else        lines.push("No JSON object found in LLM output.");
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

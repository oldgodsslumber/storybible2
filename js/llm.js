// LLM provider abstraction. Settings live in localStorage only (never Firestore).
// Providers: "none" | "gemini" | "ooba"
// Ooba uses the OpenAI-compatible endpoint (/v1/chat/completions) that
// text-generation-webui exposes.

const SETTINGS_KEY = "storybible.llm.settings.v1";

const DEFAULTS = {
  provider: "none",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  oobaBaseUrl: "http://127.0.0.1:5000",
  oobaModel: "local-model",
  temperature: 0.3
};

// Suggested models for the autocomplete picker. The Model field is a
// free-text input with a datalist, so users can also paste any model ID
// Google offers that's not in this list. IDs are sent verbatim to the
// :generateContent endpoint.
//
// As of mid-2026 Google's free tier is largely restricted to the 2.5
// family. Older Gemini models and most Gemma variants require paid tier
// or special enablement and will return 404 / "not enabled in this tier"
// for most new keys. Use the "List models my key can use" button in
// Settings to see what's actually available.
export const GEMINI_MODELS = [
  // Gemini 2.5 (typically free tier for new keys)
  { id: "gemini-2.5-flash",       label: "gemini-2.5-flash — recommended, free tier, fast" },
  { id: "gemini-2.5-pro",         label: "gemini-2.5-pro — free tier, smarter / lower quota" },
  { id: "gemini-2.5-flash-lite",  label: "gemini-2.5-flash-lite — free tier, cheaper" },

  // Older / paid-tier only (kept for users who specifically have access)
  { id: "gemini-2.0-flash",       label: "gemini-2.0-flash — older (usually paid tier only)" },
  { id: "gemini-1.5-flash",       label: "gemini-1.5-flash — legacy (usually paid tier only)" },
  { id: "gemini-1.5-pro",         label: "gemini-1.5-pro — legacy (usually paid tier only)" },

  // Gemma (availability varies by region/project — usually paid tier)
  { id: "gemma-3-27b-it",         label: "gemma-3-27b-it — Gemma 3 27B (availability varies)" },
  { id: "gemma-3-12b-it",         label: "gemma-3-12b-it — Gemma 3 12B (availability varies)" },
  { id: "gemma-3-4b-it",          label: "gemma-3-4b-it — Gemma 3 4B (availability varies)" },
  { id: "gemma-2-27b-it",         label: "gemma-2-27b-it — Gemma 2 27B (availability varies)" }
];

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

export async function callLLM({ system, user, expectJson = false, temperature, signal, timeoutMs }) {
  const s = getSettings();
  if (s.provider === "none") {
    throw new Error("No LLM provider configured. Open Settings.");
  }
  const temp = temperature ?? s.temperature ?? 0.3;
  // Combine caller signal with timeout signal
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(new DOMException(`LLM call exceeded ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms timeout`, "TimeoutError")), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combinedSignal = anySignal([signal, timeoutCtl.signal]);
  try {
    if (s.provider === "gemini") return await callGemini(s, { system, user, expectJson, temperature: temp, signal: combinedSignal });
    if (s.provider === "ooba")   return await callOoba(s,   { system, user, expectJson, temperature: temp, signal: combinedSignal });
    throw new Error(`Unknown provider: ${s.provider}`);
  } finally {
    clearTimeout(timer);
  }
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
    return `Gemini ${status} — model "${model}" not found. Try changing the Model field in Settings to "gemini-2.0-flash" or "gemini-2.5-flash".`;
  }

  // Fallback: surface the parsed message if we got one, else raw text
  if (msg) return `Gemini ${status} ${statusName ? "(" + statusName + ")" : ""}: ${msg}`;
  return `Gemini ${status}: ${errText.slice(0, 400)}`;
}

async function callGemini(s, { system, user, expectJson, temperature, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature, maxOutputTokens: 8192 }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (expectJson) body.generationConfig.responseMimeType = "application/json";

  console.log("[llm] Gemini POST", { model: s.geminiModel, url, expectJson });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(buildGeminiErrorMessage(resp.status, errText, s.geminiModel));
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
  console.log("[llm] Gemini reply", { length: text.length, preview: text.slice(0, 200) });
  if (!text) {
    const finishReason = json?.candidates?.[0]?.finishReason;
    const safety = json?.candidates?.[0]?.safetyRatings;
    throw new Error(`Gemini returned no text. finishReason=${finishReason || "unknown"}${safety ? "; safetyRatings=" + JSON.stringify(safety) : ""}`);
  }
  return text;
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

// LLM provider abstraction. Settings live in localStorage only (never Firestore).
// Providers: "none" | "gemini" | "ooba"
// Ooba uses the OpenAI-compatible endpoint (/v1/chat/completions) that
// text-generation-webui exposes.

const SETTINGS_KEY = "storybible.llm.settings.v1";

const DEFAULTS = {
  provider: "none",
  geminiApiKey: "",
  geminiModel: "gemini-2.0-flash",
  oobaBaseUrl: "http://127.0.0.1:5000",
  oobaModel: "local-model",
  temperature: 0.3
};

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

async function callGemini(s, { system, user, expectJson, temperature, signal }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (expectJson) body.generationConfig.responseMimeType = "application/json";

  console.debug("[llm] Gemini POST", { model: s.geminiModel, expectJson });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini error ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
  console.debug("[llm] Gemini reply", { length: text.length, preview: text.slice(0, 120) });
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
    max_tokens: 2048
  };
  if (expectJson) body.response_format = { type: "json_object" };

  console.debug("[llm] Ooba POST", { url, model: body.model, expectJson });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Ooba error ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content ?? "";
  console.debug("[llm] Ooba reply", { length: text.length, preview: text.slice(0, 120) });
  return text;
}

// --- JSON extraction ---
// LLMs sometimes wrap JSON in prose or code fences even when asked not to.
// Pull out the first balanced JSON object/array.

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
            throw new Error("Could not parse JSON from LLM output: " + e.message);
          }
        }
      }
    }
  }
  throw new Error("No JSON found in LLM output.");
}

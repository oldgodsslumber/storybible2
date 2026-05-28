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

export async function callLLM({ system, user, expectJson = false, temperature }) {
  const s = getSettings();
  if (s.provider === "none") {
    throw new Error("No LLM provider configured. Open Settings.");
  }
  const temp = temperature ?? s.temperature ?? 0.3;
  if (s.provider === "gemini") return callGemini(s, { system, user, expectJson, temperature: temp });
  if (s.provider === "ooba") return callOoba(s, { system, user, expectJson, temperature: temp });
  throw new Error(`Unknown provider: ${s.provider}`);
}

async function callGemini(s, { system, user, expectJson, temperature }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (expectJson) body.generationConfig.responseMimeType = "application/json";

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini error ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
  return text;
}

async function callOoba(s, { system, user, expectJson, temperature }) {
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

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Ooba error ${resp.status}: ${errText}`);
  }
  const json = await resp.json();
  const text = json?.choices?.[0]?.message?.content ?? "";
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

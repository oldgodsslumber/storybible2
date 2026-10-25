// Settings modal — open from any page. Persists LLM config to localStorage.
import { getSettings, saveSettings, callLLM, isConfigured, GEMINI_MODELS, listGeminiModels, GEMINI_FALLBACK_CHAIN, getDailyUsage, GEMINI_DEFAULT_MODEL, GEMINI_MODEL_INFO, isGemmaModel, callLLMDetailed, isRetiredOrAliasModel, normalizeModelId } from "./llm.js?v=20261025";

const NOTICE_KEY = "storybible.llm.notice.acknowledged";
const FIRST_VISIT_PROMPT_KEY = "storybible.llm.config-prompt.shown";
const SETTINGS_SAVED_EVENT = "storybible:llm-settings-saved";

// HTML escape helpers — defined here at module top so they're unambiguously
// in scope for every function below regardless of declaration order.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function attr(s) { return esc(s); }

function isKnownModel(id) { return !!GEMINI_MODEL_INFO[id]; }

// Grouped <option>s for the model picker. The writer's saved model is always
// selectable, even if it isn't in our list (it lands under Custom).
function modelOptionsHtml(current) {
  const groups = [
    { label: "Free tier", ids: GEMINI_MODELS.filter(m => GEMINI_MODEL_INFO[m.id].free && !/legacy/.test(GEMINI_MODEL_INFO[m.id].note)) },
    { label: "Paid tier only", ids: GEMINI_MODELS.filter(m => !GEMINI_MODEL_INFO[m.id].free) },
    { label: "Legacy (only keys that used them before)", ids: GEMINI_MODELS.filter(m => /legacy/.test(GEMINI_MODEL_INFO[m.id].note)) }
  ];
  const opt = (m) => `<option value="${attr(m.id)}"${m.id === current ? " selected" : ""}>${esc(m.label)}</option>`;
  return groups.map(g => `<optgroup label="${attr(g.label)}">${g.ids.map(opt).join("")}</optgroup>`).join("")
    + `<option value="__custom"${isKnownModel(current) ? "" : " selected"}>Custom model id…</option>`;
}

export function openSettingsModal() {
  const s = getSettings();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal settings-modal">
      <div class="modal-header">
        <h2>LLM Settings</h2>
        <button class="ghost small close-modal" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted small">
          API keys and endpoints are stored only in this browser's localStorage and sent only to the provider you configure.
          They are never written to Firestore.
        </p>

        <label>Provider
          <select id="provider">
            <option value="none"${s.provider==="none"?" selected":""}>None (LLM features disabled)</option>
            <option value="gemini"${s.provider==="gemini"?" selected":""}>Gemini API</option>
            <option value="ooba"${s.provider==="ooba"?" selected":""}>Local — Oobabooga (OpenAI-compatible)</option>
          </select>
        </label>

        <fieldset id="geminiFields" class="provider-fields">
          <legend>Gemini</legend>
          <label>API Key <input id="geminiApiKey" type="password" value="${attr(s.geminiApiKey)}" placeholder="Paste your Gemini API key" autocomplete="off" /></label>
          <label>Model
            <select id="geminiModelSelect">${modelOptionsHtml(s.geminiModel)}</select>
            <input id="geminiModel" type="text" class="${isKnownModel(s.geminiModel) ? "hidden" : ""}" value="${attr(s.geminiModel)}" placeholder="model id, e.g. ${attr(GEMINI_DEFAULT_MODEL)}" />
            <span class="muted small" id="customModelWarn" style="color: var(--warn);"></span>
            <div class="model-list-row">
              <button type="button" id="listGeminiModelsBtn" class="ghost small">List models my key can use</button>
              <span id="modelListStatus" class="muted small"></span>
            </div>
            <div id="modelListResults" class="model-list-results"></div>
            <p class="muted small" style="margin-top:4px;">Models current as of October 2026. Google retires and renames models often — "List models my key can use" asks Google directly. Gemini 4 Argon and 3.1 Pro need a key on a paid project.</p>
          </label>
          <div class="provider-help" id="geminiChainStatus">
            <strong>Today's requests from this browser</strong>
            <ul class="chain-status-list">
              ${(() => {
                const u = getDailyUsage();
                return GEMINI_FALLBACK_CHAIN.map(m => {
                  const used = u.counts[m.id] || 0;
                  const spent = !!u.exhausted[m.id];
                  return `<li class="${spent ? "exhausted" : ""}">
                    <code>${esc(m.id)}</code> — <strong>${used}</strong> request${used === 1 ? "" : "s"} today
                    ${spent ? `<span class="muted small">(daily quota used up — falling through)</span>` : ""}
                  </li>`;
                }).join("");
              })()}
            </ul>
            <p class="muted small">If your model runs out of free daily quota, the app moves down this list on its own until quota resets at midnight Pacific time. Google doesn't publish exact free-tier limits any more — they're per project, and AI Studio shows yours. Models you pick that aren't on this list (like Gemini 4 Argon) don't fall through.</p>
          </div>

          <div class="provider-help">
            <strong>How to get a free Gemini API key</strong>
            <ol>
              <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio → API keys</a> in a new tab. <em>(Not the Google Cloud Console — that's a different surface and the keys aren't free-tier-eligible.)</em></li>
              <li>Sign in with your Google account if prompted.</li>
              <li>Click <strong>Create API key</strong> and let AI Studio create a new project for it. Free-tier eligibility is per project, and a project with billing enabled doesn't get free-tier quota.</li>
              <li>Copy the key and paste it into the <strong>API Key</strong> field above. New keys are automatically restricted to the Gemini API, which is what Google now requires.</li>
              <li>Leave the model on <strong>Gemini 3.8 Flash</strong> unless you have a reason to change it — it's Google's newest free model. <strong>Gemini 3.5 Flash-Lite</strong> is faster and cheaper.</li>
            </ol>
            <p class="muted small"><strong>If Test connection returns 429 with "limit: 0":</strong> the key's project isn't eligible for the free tier (usually because billing is enabled — upgrading doesn't unlock free quota). Create a new key in a new project.</p>
            <p class="muted small"><strong>If it returns 403:</strong> Google blocks keys it thinks have leaked and rejects old unrestricted keys. Make a fresh one.</p>
            <p class="muted small">The key stays in this browser's localStorage and is sent only to Google's API, in a request header — never to any server we control.</p>
          </div>
        </fieldset>

        <fieldset id="oobaFields" class="provider-fields">
          <legend>Oobabooga (local)</legend>
          <label>Base URL <input id="oobaBaseUrl" type="text" value="${attr(s.oobaBaseUrl)}" placeholder="http://127.0.0.1:5000" /></label>
          <label>Model name <input id="oobaModel" type="text" value="${attr(s.oobaModel)}" placeholder="(any string ooba accepts)" /></label>
          <p class="muted small">Uses the OpenAI-compatible endpoint at <code>{base}/v1/chat/completions</code>. Start ooba with <code>--api --extensions openai</code>.</p>
          <p class="muted small" id="oobaMixedWarning" style="color: var(--warn); display: none;">
            ⚠ This page is loaded over HTTPS but Ooba is at <code>http://</code>. The browser will block these requests (mixed content). Run the app locally via <code>python -m http.server 8000</code> and visit <code>http://localhost:8000</code>, or expose Ooba via an HTTPS tunnel.
          </p>
        </fieldset>

        <label id="temperatureRow">Temperature <span class="muted small">(Gemma and local models only)</span>
          <input id="temperature" type="number" step="0.05" min="0" max="2" value="${attr(s.temperature)}" />
          <span class="muted small" id="temperatureNote">Gemini models no longer accept a temperature — Google deprecated it in July 2026 — so this only applies to Gemma and Oobabooga.</span>
        </label>

        <div class="connection-row">
          <button id="testConnBtn" class="ghost">Test connection</button>
          <span id="connStatus" class="conn-status conn-idle">
            <span class="conn-dot"></span>
            <span class="conn-label">Not tested</span>
          </span>
        </div>
      </div>
      <div class="modal-actions">
        <button class="ghost cancel">Cancel</button>
        <button class="primary save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const providerSel = overlay.querySelector("#provider");
  const refresh = () => {
    overlay.querySelector("#geminiFields").style.display = providerSel.value === "gemini" ? "" : "none";
    overlay.querySelector("#oobaFields").style.display = providerSel.value === "ooba" ? "" : "none";
    setStatus("idle", "Not tested");
    // Mixed-content warning for ooba over HTTPS pages
    const warn = overlay.querySelector("#oobaMixedWarning");
    if (warn) {
      const url = overlay.querySelector("#oobaBaseUrl").value || "http://";
      const showWarn = providerSel.value === "ooba"
        && location.protocol === "https:"
        && url.startsWith("http://");
      warn.style.display = showWarn ? "" : "none";
    }
  };
  overlay.querySelector("#oobaBaseUrl")?.addEventListener("input", refresh);
  providerSel.addEventListener("change", refresh);

  const modelSel = overlay.querySelector("#geminiModelSelect");
  const modelInput = overlay.querySelector("#geminiModel");
  const currentModel = () => (modelSel.value === "__custom" ? modelInput.value.trim() : modelSel.value);
  const syncTemperature = () => {
    const usesTemp = providerSel.value === "ooba" || (providerSel.value === "gemini" && isGemmaModel(currentModel()));
    overlay.querySelector("#temperatureRow").style.display = usesTemp ? "" : "none";
  };
  modelSel.addEventListener("change", () => {
    const custom = modelSel.value === "__custom";
    modelInput.classList.toggle("hidden", !custom);
    if (!custom) modelInput.value = modelSel.value;
    else modelInput.focus();
    syncTemperature();
  });
  modelInput.addEventListener("input", () => {
    syncTemperature();
    const id = modelInput.value.trim();
    const warn = overlay.querySelector("#customModelWarn");
    warn.textContent = id && isRetiredOrAliasModel(id)
      ? `${id} is retired or a floating alias — the app will use ${GEMINI_DEFAULT_MODEL} instead.`
      : "";
  });
  providerSel.addEventListener("change", syncTemperature);
  syncTemperature();
  refresh();

  function setStatus(kind, label) {
    const wrap = overlay.querySelector("#connStatus");
    wrap.className = "conn-status conn-" + kind;
    wrap.querySelector(".conn-label").textContent = label;
  }

  const close = () => overlay.remove();
  overlay.querySelector(".close-modal").addEventListener("click", close);
  overlay.querySelector(".cancel").addEventListener("click", close);

  // Backdrop click should only close if BOTH mousedown AND mouseup happened
  // on the overlay itself. Otherwise dragging to select text inside an input
  // and releasing outside the modal closes it (the click event's target
  // becomes the overlay — common ancestor of mousedown and mouseup).
  let mouseDownOnOverlay = false;
  overlay.addEventListener("mousedown", e => {
    mouseDownOnOverlay = (e.target === overlay);
  });
  overlay.addEventListener("click", e => {
    if (e.target === overlay && mouseDownOnOverlay) close();
    mouseDownOnOverlay = false;
  });

  function readForm() {
    return {
      provider: providerSel.value,
      geminiApiKey: overlay.querySelector("#geminiApiKey").value.trim(),
      geminiModel: (() => {
        const sel = overlay.querySelector("#geminiModelSelect").value;
        const typed = overlay.querySelector("#geminiModel").value.trim();
        return (sel === "__custom" ? typed : sel) || GEMINI_DEFAULT_MODEL;
      })(),
      oobaBaseUrl: overlay.querySelector("#oobaBaseUrl").value.trim() || "http://127.0.0.1:5000",
      oobaModel: overlay.querySelector("#oobaModel").value.trim() || "local-model",
      temperature: (() => {
        const t = parseFloat(overlay.querySelector("#temperature").value);
        return Number.isFinite(t) ? t : 0.3; // 0 is a valid (deterministic) setting
      })()
    };
  }

  overlay.querySelector("#listGeminiModelsBtn")?.addEventListener("click", async () => {
    const keyInput = overlay.querySelector("#geminiApiKey");
    const key = keyInput.value.trim();
    const statusEl = overlay.querySelector("#modelListStatus");
    const resultsEl = overlay.querySelector("#modelListResults");
    if (!key) {
      statusEl.textContent = "Paste an API key first.";
      return;
    }
    statusEl.textContent = "Querying Google…";
    resultsEl.innerHTML = "";
    try {
      const models = (await listGeminiModels(key)).filter(m => !isRetiredOrAliasModel(m.id));
      statusEl.textContent = `${models.length} model${models.length === 1 ? "" : "s"} available.`;
      if (models.length === 0) {
        resultsEl.innerHTML = `<p class="muted small">Google returned no models supporting generateContent for this key.</p>`;
        return;
      }
      // Sort: models this app knows first, then other Gemini, then Gemma
      models.sort((a, b) => {
        const rank = (m) => GEMINI_MODEL_INFO[m.id] ? 0 : m.id.startsWith("gemini-") ? 1 : m.id.startsWith("gemma-") ? 2 : 3;
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id);
      });
      resultsEl.innerHTML = `
        <p class="muted small">Click a model to use it:</p>
        <ul class="model-list">
          ${models.map(m => `<li><button type="button" class="model-pick" data-id="${attr(m.id)}"><code>${esc(m.id)}</code>${m.displayName ? ` <span class="muted small">— ${esc(m.displayName)}</span>` : ""}</button></li>`).join("")}
        </ul>
      `;
      resultsEl.querySelectorAll(".model-pick").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.id;
          const sel = overlay.querySelector("#geminiModelSelect");
          const input = overlay.querySelector("#geminiModel");
          if ([...sel.options].some(o => o.value === id)) {
            sel.value = id;
            input.classList.add("hidden");
          } else {
            sel.value = "__custom";
            input.classList.remove("hidden");
          }
          input.value = id;
          sel.dispatchEvent(new Event("change"));
          if (sel.value === "__custom") input.value = id;
          statusEl.textContent = `Set model to ${id}.`;
        });
      });
    } catch (err) {
      statusEl.textContent = "Failed.";
      resultsEl.innerHTML = `<p class="muted small">${esc(err.message || String(err))}</p>`;
    }
  });

  overlay.querySelector("#testConnBtn").addEventListener("click", async () => {
    const form = readForm();
    if (form.provider === "none") {
      setStatus("err", "Pick a provider first");
      return;
    }
    if (form.provider === "gemini" && !form.geminiApiKey) {
      setStatus("err", "Paste an API key first");
      return;
    }
    // Test with the form's values for this one call only. Nothing is written
    // to storage, so a Save made while the test runs always sticks.
    setStatus("pending", "Testing…");
    overlay.querySelector("#testConnBtn").disabled = true;
    try {
      const { text: reply, model } = await callLLMDetailed({
        system: "You are a connection test. Reply with the literal word OK and nothing else.",
        user: "ping",
        expectJson: false,
        temperature: 0,
        settings: form
      });
      const asked = form.provider === "gemini" ? normalizeModelId(form.geminiModel) : null;
      const who = form.provider === "gemini"
        ? (model === asked ? ` — ${model}` : ` — but ${asked} hit its quota limit, so ${model} answered`)
        : "";
      setStatus("ok", ((reply || "").toLowerCase().includes("ok") ? "Connected" : "Connected (unexpected reply)") + who);
    } catch (err) {
      console.error(err);
      setStatus("err", "Failed: " + (err.message || "unknown"));
    } finally {
      overlay.querySelector("#testConnBtn").disabled = false;
    }
  });

  overlay.querySelector(".save").addEventListener("click", () => {
    const form = readForm();
    saveSettings(form);
    if (!localStorage.getItem(NOTICE_KEY) && form.provider !== "none") {
      alert("Heads up: your API key and prompts are sent directly from this browser to the provider you chose. Nothing routes through a server we control.");
      localStorage.setItem(NOTICE_KEY, "1");
    }
    document.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail: form }));
    close();
  });
}

// Banner shown at the top of the page whenever no LLM provider is
// configured. Caller is responsible for mounting it after auth succeeds
// (we don't want this showing on the signed-out splash). On the first
// sign-in where the user has never been prompted, also auto-opens the
// Settings modal so the configure-your-LLM step isn't easy to miss.
export function mountLlmConfigBanner() {
  let banner = document.getElementById("llmConfigBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "llmConfigBanner";
    banner.className = "llm-config-banner hidden";
    const main = document.getElementById("main");
    if (main && main.parentNode) main.parentNode.insertBefore(banner, main);
    else document.body.insertBefore(banner, document.body.firstChild);
  }

  function update() {
    if (isConfigured()) {
      banner.classList.add("hidden");
      banner.innerHTML = "";
      return;
    }
    banner.classList.remove("hidden");
    banner.innerHTML = `
      <span class="llm-config-banner-msg">⚠ Connect an LLM to enable note processing, scene generation, and reviews. Without one, the story bible still works as a manual card editor — but the assistant features are disabled.</span>
      <button class="primary small llm-config-banner-btn">Configure now</button>
    `;
    banner.querySelector(".llm-config-banner-btn").addEventListener("click", openSettingsModal);
  }

  update();
  document.addEventListener(SETTINGS_SAVED_EVENT, update);

  // First-visit auto-open: if the user has never seen this prompt before
  // AND no LLM is configured, pop the Settings modal so they're walked
  // straight to it. After this once, the banner alone handles it.
  if (!isConfigured() && !localStorage.getItem(FIRST_VISIT_PROMPT_KEY)) {
    localStorage.setItem(FIRST_VISIT_PROMPT_KEY, "1");
    setTimeout(() => openSettingsModal(), 250);
  }
}

export function mountSettingsButton(container) {
  if (!container) return;
  const btn = document.createElement("button");
  btn.className = "ghost small";
  btn.textContent = "⚙ Settings";
  btn.addEventListener("click", openSettingsModal);
  container.prepend(btn);
}

// Settings modal — open from any page. Persists LLM config to localStorage.
import { getSettings, saveSettings } from "./llm.js";

const NOTICE_KEY = "storybible.llm.notice.acknowledged";

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
          <label>API Key <input id="geminiApiKey" type="password" value="${attr(s.geminiApiKey)}" placeholder="AIza..." /></label>
          <label>Model <input id="geminiModel" type="text" value="${attr(s.geminiModel)}" /></label>
        </fieldset>

        <fieldset id="oobaFields" class="provider-fields">
          <legend>Oobabooga (local)</legend>
          <label>Base URL <input id="oobaBaseUrl" type="text" value="${attr(s.oobaBaseUrl)}" placeholder="http://127.0.0.1:5000" /></label>
          <label>Model name <input id="oobaModel" type="text" value="${attr(s.oobaModel)}" placeholder="(any string ooba accepts)" /></label>
          <p class="muted small">Uses the OpenAI-compatible endpoint at <code>{base}/v1/chat/completions</code>. Start ooba with <code>--api</code>.</p>
        </fieldset>

        <label>Temperature
          <input id="temperature" type="number" step="0.05" min="0" max="2" value="${attr(s.temperature)}" />
        </label>
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
  };
  providerSel.addEventListener("change", refresh);
  refresh();

  const close = () => overlay.remove();
  overlay.querySelector(".close-modal").addEventListener("click", close);
  overlay.querySelector(".cancel").addEventListener("click", close);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

  overlay.querySelector(".save").addEventListener("click", () => {
    saveSettings({
      provider: providerSel.value,
      geminiApiKey: overlay.querySelector("#geminiApiKey").value.trim(),
      geminiModel: overlay.querySelector("#geminiModel").value.trim() || "gemini-2.0-flash",
      oobaBaseUrl: overlay.querySelector("#oobaBaseUrl").value.trim() || "http://127.0.0.1:5000",
      oobaModel: overlay.querySelector("#oobaModel").value.trim() || "local-model",
      temperature: parseFloat(overlay.querySelector("#temperature").value) || 0.3
    });
    if (!localStorage.getItem(NOTICE_KEY) && providerSel.value !== "none") {
      alert("Heads up: your API key and prompts are sent directly from this browser to the provider you chose. Nothing routes through a server we control.");
      localStorage.setItem(NOTICE_KEY, "1");
    }
    close();
  });
}

export function mountSettingsButton(container) {
  if (!container) return;
  const btn = document.createElement("button");
  btn.className = "ghost small";
  btn.textContent = "⚙ Settings";
  btn.addEventListener("click", openSettingsModal);
  container.prepend(btn);
}

function attr(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

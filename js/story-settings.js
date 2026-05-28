// Per-project story settings. These live on the project document and get
// folded into every LLM system prompt so the model knows the project's
// genre, premise, narrative structure, and the writer's established terms
// (e.g. "Curtain Fall" is the giant stormcloud, not a curtain falling).

import { db } from "./shared.js";
import {
  doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

export const DEFAULT_STORY_SETTINGS = {
  genre: "",
  premise: "",
  structure: "5-act",
  voiceNotes: "",
  anchorConcepts: []  // [{ term, definition }]
};

export const STRUCTURE_OPTIONS = [
  { id: "free",          label: "No specific structure" },
  { id: "3-act",         label: "3-act (Setup / Confrontation / Resolution)" },
  { id: "5-act",         label: "5-act (Exposition / Rising / Climax / Falling / Denouement)" },
  { id: "save-the-cat",  label: "Save the Cat (15 beats)" },
  { id: "heros-journey", label: "Hero's Journey" },
  { id: "kishotenketsu", label: "Kishōtenketsu (Intro / Development / Twist / Conclusion)" }
];

export function getStorySettings(project) {
  return {
    ...DEFAULT_STORY_SETTINGS,
    ...(project?.storySettings || {})
  };
}

// Build the PROJECT CONTEXT block that gets prepended to every LLM system
// prompt. Returns "" if nothing useful has been set, so prompts don't get
// polluted with empty stanzas.
export function buildProjectContext(project) {
  const s = getStorySettings(project);
  const lines = [];
  if (s.genre || s.premise || s.structure || s.voiceNotes || s.anchorConcepts.length) {
    lines.push("=== PROJECT CONTEXT ===");
    if (project?.title) lines.push(`Project: ${project.title}`);
    if (s.genre)        lines.push(`Genre / setting: ${s.genre}`);
    if (s.premise)      lines.push(`Premise: ${s.premise}`);
    if (s.structure && s.structure !== "free") {
      const opt = STRUCTURE_OPTIONS.find(o => o.id === s.structure);
      lines.push(`Structure: ${opt ? opt.label : s.structure} — keep this in mind when shaping suggestions.`);
    }
    if (s.voiceNotes) lines.push(`Voice / style notes: ${s.voiceNotes}`);
    if (s.anchorConcepts.length) {
      lines.push("Established terms (use these names exactly; don't paraphrase):");
      for (const a of s.anchorConcepts) {
        if (!a.term) continue;
        lines.push(`  • "${a.term}" — ${a.definition || "(no definition yet)"}`);
      }
    }
    lines.push("Be succinct yet accurate. Don't invent details. Stay consistent with the established terms above.");
    lines.push("=== END PROJECT CONTEXT ===");
    lines.push("");
  }
  return lines.join("\n");
}

export function openStorySettingsModal(state, projectId, { onSaved } = {}) {
  const project = state.project;
  const s = getStorySettings(project);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal story-settings-modal">
      <div class="modal-header">
        <h2>Story Settings</h2>
        <button class="ghost small close-modal" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <p class="muted small">These are sent with every LLM call for this project so the model treats your established premise and terms as canonical.</p>

        <label>Genre / setting
          <input id="ss-genre" type="text" value="${attr(s.genre)}" placeholder="e.g. Modern science fiction; urban fantasy; near-future thriller" />
        </label>

        <label>One-line premise
          <input id="ss-premise" type="text" value="${attr(s.premise)}" placeholder="e.g. A giant stormcloud covers the US for one year and the country adapts." />
        </label>

        <label>Story structure
          <select id="ss-structure">
            ${STRUCTURE_OPTIONS.map(o => `<option value="${attr(o.id)}"${s.structure === o.id ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
          </select>
        </label>

        <label>Voice / style notes
          <textarea id="ss-voice" rows="2" placeholder="e.g. Spare, character-driven. No purple prose. Scenes lean visual.">${esc(s.voiceNotes)}</textarea>
        </label>

        <div class="ss-anchors">
          <div class="ss-anchors-head">
            <strong>Established terms</strong>
            <span class="muted small">— things the model should treat as fixed names, e.g. "Curtain Fall" = the stormcloud</span>
          </div>
          <ul id="ss-anchor-list" class="ss-anchor-list"></ul>
          <button id="ss-add-anchor" class="ghost small">+ Add term</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="ghost cancel">Cancel</button>
        <button class="primary save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector("#ss-anchor-list");
  function addAnchorRow(term = "", definition = "") {
    const li = document.createElement("li");
    li.className = "ss-anchor-row";
    li.innerHTML = `
      <input type="text" class="ss-anchor-term" value="${attr(term)}" placeholder="Term (e.g. Curtain Fall)" />
      <input type="text" class="ss-anchor-def"  value="${attr(definition)}" placeholder="Definition" />
      <button class="ghost small ss-anchor-remove" aria-label="Remove">✕</button>
    `;
    li.querySelector(".ss-anchor-remove").addEventListener("click", () => li.remove());
    listEl.appendChild(li);
  }
  for (const a of s.anchorConcepts) addAnchorRow(a.term, a.definition);
  if (s.anchorConcepts.length === 0) addAnchorRow();
  overlay.querySelector("#ss-add-anchor").addEventListener("click", () => addAnchorRow());

  const close = () => overlay.remove();
  overlay.querySelector(".close-modal").addEventListener("click", close);
  overlay.querySelector(".cancel").addEventListener("click", close);

  // Same modal-doesn't-close-on-text-drag pattern as settings
  let mouseDownOnOverlay = false;
  overlay.addEventListener("mousedown", e => { mouseDownOnOverlay = (e.target === overlay); });
  overlay.addEventListener("click", e => {
    if (e.target === overlay && mouseDownOnOverlay) close();
    mouseDownOnOverlay = false;
  });

  overlay.querySelector(".save").addEventListener("click", async () => {
    const anchorConcepts = [...listEl.querySelectorAll(".ss-anchor-row")]
      .map(row => ({
        term: row.querySelector(".ss-anchor-term").value.trim(),
        definition: row.querySelector(".ss-anchor-def").value.trim()
      }))
      .filter(a => a.term);
    const next = {
      genre:      overlay.querySelector("#ss-genre").value.trim(),
      premise:    overlay.querySelector("#ss-premise").value.trim(),
      structure:  overlay.querySelector("#ss-structure").value,
      voiceNotes: overlay.querySelector("#ss-voice").value.trim(),
      anchorConcepts
    };
    try {
      await updateDoc(
        doc(db, "users", state.user.uid, "projects", projectId),
        { storySettings: next, updatedAt: serverTimestamp() }
      );
      state.project.storySettings = next;
      close();
      onSaved?.(next);
    } catch (err) {
      alert("Could not save story settings: " + (err.message || err));
    }
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function attr(s) { return esc(s); }

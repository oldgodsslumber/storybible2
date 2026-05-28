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
  anchorConcepts: [], // [{ term, definition }]
  prologue: "",       // diegetic but outside the main story arc; backstory framing
  epilogue: ""        // diegetic but outside the main story arc; aftermath framing
};

export const STRUCTURE_OPTIONS = [
  { id: "free",          label: "No specific structure" },
  { id: "3-act",         label: "3-act (Setup / Confrontation / Resolution)" },
  { id: "5-act",         label: "5-act (Exposition / Rising / Climax / Falling / Denouement)" },
  { id: "save-the-cat",  label: "Save the Cat (15 beats)" },
  { id: "heros-journey", label: "Hero's Journey" },
  { id: "kishotenketsu", label: "Kishōtenketsu (Intro / Development / Twist / Conclusion)" }
];

// Map each structure preset to its main-story column labels.
// Outline columns always have a Prologue first and an Epilogue last,
// with these acts in between.
export const STRUCTURE_COLUMNS = {
  "free":          ["Story"],
  "3-act":         ["Act 1: Setup", "Act 2: Confrontation", "Act 3: Resolution"],
  "5-act":         ["Act 1: Exposition", "Act 2: Rising Action", "Act 3: Climax", "Act 4: Falling Action", "Act 5: Denouement"],
  "save-the-cat":  ["Setup", "Catalyst → Break Into Two", "Break Into Two → Midpoint", "Midpoint → All Is Lost", "All Is Lost → Finale", "Finale"],
  "heros-journey": ["Departure", "Initiation", "Return"],
  "kishotenketsu": ["Ki (Intro)", "Shō (Development)", "Ten (Twist)", "Ketsu (Conclusion)"]
};

// Returns the ordered list of outline columns for a project:
// [ {id, label, isPrologue, isEpilogue, isMain} ]
// IDs are stable (prologue, act-1..act-N, epilogue) so cards don't lose
// their column on a structure change unless the column count shrinks
// past their index — in which case they end up "Unassigned".
export function getColumnsForProject(project) {
  const s = getStorySettings(project);
  const mainLabels = STRUCTURE_COLUMNS[s.structure] || STRUCTURE_COLUMNS["5-act"];
  const cols = [];
  cols.push({ id: "prologue", label: "Prologue", isPrologue: true, isMain: false, isEpilogue: false });
  mainLabels.forEach((label, idx) => {
    cols.push({ id: `act-${idx + 1}`, label, isPrologue: false, isMain: true, isEpilogue: false });
  });
  cols.push({ id: "epilogue", label: "Epilogue", isPrologue: false, isMain: false, isEpilogue: true });
  return cols;
}

// Default column for new scenes/beats: the first main-story column.
export function defaultColumnId(project) {
  const cols = getColumnsForProject(project);
  return cols.find(c => c.isMain)?.id || "act-1";
}

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
    if (s.prologue) {
      lines.push("Prologue / backstory (diegetic to the world but OUTSIDE the main story arc — use for context and reference, do not fold into structural analysis or arc reviews):");
      lines.push(s.prologue);
    }
    if (s.epilogue) {
      lines.push("Epilogue / aftermath (diegetic to the world but OUTSIDE the main story arc — use for context only; do not treat as part of the main act structure):");
      lines.push(s.epilogue);
    }
    // Outline columns — so the LLM knows where scenes/beats can be placed
    // and can return a columnHint that the app can honor when creating cards.
    const cols = getColumnsForProject(project);
    if (cols.length) {
      lines.push("Outline columns — when proposing a scene or beat, set its `columnHint` to one of these column IDs:");
      for (const c of cols) {
        const tag = c.isPrologue ? " (framing — outside main arc)"
                  : c.isEpilogue ? " (framing — outside main arc)"
                  : "";
        lines.push(`  • ${c.id} — ${c.label}${tag}`);
      }
      lines.push("If you can't tell which column fits, use \"" + (cols.find(x => x.isMain)?.id || "act-1") + "\".");
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

        <label>Prologue / backstory
          <textarea id="ss-prologue" rows="4" placeholder="Diegetic to the world but outside the main story arc. e.g. 'Three years before the events of this story, the Curtain Fall settled over the United States...'">${esc(s.prologue)}</textarea>
        </label>

        <label>Epilogue / aftermath
          <textarea id="ss-epilogue" rows="4" placeholder="What happens after the main story ends. The LLM will treat this as world context, not part of the arc structure.">${esc(s.epilogue)}</textarea>
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
      anchorConcepts,
      prologue:   overlay.querySelector("#ss-prologue").value.trim(),
      epilogue:   overlay.querySelector("#ss-epilogue").value.trim()
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

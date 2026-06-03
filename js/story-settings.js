// Per-project story settings. These live on the project document and get
// folded into every LLM system prompt so the model knows the project's
// genre, premise, narrative structure, and the writer's established terms
// (e.g. "Curtain Fall" is the giant stormcloud, not a curtain falling).

import { db } from "./shared.js";
import {
  doc, updateDoc, serverTimestamp, collection, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

export const DEFAULT_STORY_SETTINGS = {
  genre: "",
  premise: "",
  structure: "story-bible-default",
  voiceNotes: "",
  anchorConcepts: [], // [{ term, definition }]
  prologue: "",       // diegetic but outside the main story arc; backstory framing
  epilogue: ""        // diegetic but outside the main story arc; aftermath framing
};

export const STRUCTURE_OPTIONS = [
  { id: "story-bible-default", label: "Story Bible default (Prologue / Act I / Act II / Mid-Point / Crisis / Climax / Act III / Epilogue)" },
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
  "story-bible-default": ["Act I", "Act II", "Mid-Point", "Crisis", "Climax", "Act III"],
  "save-the-cat":  ["Setup", "Catalyst → Break Into Two", "Break Into Two → Midpoint", "Midpoint → All Is Lost", "All Is Lost → Finale", "Finale"],
  "heros-journey": ["Departure", "Initiation", "Return"],
  "kishotenketsu": ["Ki (Intro)", "Shō (Development)", "Ten (Twist)", "Ketsu (Conclusion)"]
};

// Per-column writing guidance for structures that have it. Keyed by
// structure id, then by column id (prologue / act-1 / act-2 / ... / epilogue).
// Each entry has a short one-line description plus a list of bullet
// guidance questions the writer can use as prompts while filling the column.
export const STRUCTURE_COLUMN_GUIDANCE = {
  "story-bible-default": {
    "prologue": {
      description: "Introduces your film's tone through a scene not connected to the main plot.",
      guidance: [
        "Should exist outside the plot of the film.",
        "Doesn't need to necessarily involve the main characters.",
        "Good in Action/Horror films — sets the tone quickly."
      ]
    },
    "act-1": {
      description: "Introduce the characters in their \"normal world\".",
      guidance: [
        "What does their world look like?",
        "Who are their relationships with?",
        "What is comfortable and uncomfortable in their \"normal\" world?",
        "How is your theme expressed in the \"normal world\"?"
      ]
    },
    "act-2": {
      description: "Characters attempt to overcome obstacles that directly relate to their goal.",
      guidance: [
        "How are these obstacles expressions of theme?",
        "How do the characters respond to these obstacles? How does that also express theme?"
      ]
    },
    "act-3": {
      description: "Your characters are now at a moment of calm, after some successes and failures.",
      guidance: [
        "In this moment of calm, how do we see the character reacting to the events in Act II?",
        "How has Act II affected the characters?",
        "What else has changed in the world?"
      ]
    },
    "act-4": {
      description: "Circumstances plunge yet again, and things become much worse. As bad as they can be.",
      guidance: [
        "How do things get even worse?",
        "How does this penultimate challenge relate to the theme?",
        "What lesson does your character learn related to theme?"
      ]
    },
    "act-5": {
      description: "Your character now heads into their final challenge, lessons learned.",
      guidance: [
        "How do they use their new knowledge or skill to confront the challenge?",
        "Do they win? Or do they lose?",
        "How do you continue to ratchet tension?"
      ]
    },
    "act-6": {
      description: "The central conflict is either won or lost. Characters return to their \"normal world\", now changed.",
      guidance: [
        "What is the appropriate ending for this theme?",
        "What does this new world look like?",
        "How do the lessons learned via Climax impact them in the \"normal world\"?"
      ]
    },
    "epilogue": {
      description: "A post-storyline scene that resolves a hanging thread, or introduces a new conflict for the next film/installment.",
      guidance: [
        "What threads are not concluded?",
        "What needs to be appropriately teased for the next installment?"
      ]
    }
  }
};

// Returns the ordered list of outline columns for a project:
// [ {id, label, isPrologue, isEpilogue, isMain, description, guidance} ]
// IDs are stable (prologue, act-1..act-N, epilogue) so cards don't lose
// their column on a structure change unless the column count shrinks
// past their index — in which case they end up "Unassigned".
// description and guidance are attached when the chosen structure has
// per-column writing guidance defined (currently only "story-bible-default").
export function getColumnsForProject(project) {
  const s = getStorySettings(project);
  const mainLabels = STRUCTURE_COLUMNS[s.structure] || STRUCTURE_COLUMNS["5-act"];
  const guidance = STRUCTURE_COLUMN_GUIDANCE[s.structure] || {};
  const cols = [];
  const proInfo = guidance["prologue"] || {};
  cols.push({
    id: "prologue", label: "Prologue",
    isPrologue: true, isMain: false, isEpilogue: false,
    description: proInfo.description || "",
    guidance: proInfo.guidance || []
  });
  mainLabels.forEach((label, idx) => {
    const colId = `act-${idx + 1}`;
    const info = guidance[colId] || {};
    cols.push({
      id: colId, label,
      isPrologue: false, isMain: true, isEpilogue: false,
      description: info.description || "",
      guidance: info.guidance || []
    });
  });
  const epiInfo = guidance["epilogue"] || {};
  cols.push({
    id: "epilogue", label: "Epilogue",
    isPrologue: false, isMain: false, isEpilogue: true,
    description: epiInfo.description || "",
    guidance: epiInfo.guidance || []
  });
  return cols;
}

// Default column for new scenes/beats: the first main-story column.
export function defaultColumnId(project) {
  const cols = getColumnsForProject(project);
  return cols.find(c => c.isMain)?.id || "act-1";
}

// Column ID remapping when switching FROM the given structure TO
// "story-bible-default". For source structures whose acts have a
// direct narrative analogue in the new layout, we move cards
// intentionally instead of leaving them stranded under unrelated
// labels. Returns null when no remap is needed.
export function remapColumnIdsForNewDefault(fromStructure) {
  switch (fromStructure) {
    case "5-act":
      // Exposition/Rising/Climax/Falling/Denouement → Act I/II/Climax/Act III/Act III
      return {
        "act-1": "act-1",  // Exposition → Act I
        "act-2": "act-2",  // Rising Action → Act II
        "act-3": "act-5",  // Climax → Climax
        "act-4": "act-6",  // Falling Action → Act III
        "act-5": "act-6"   // Denouement → Act III
      };
    case "3-act":
      return {
        "act-1": "act-1",  // Setup → Act I
        "act-2": "act-2",  // Confrontation → Act II
        "act-3": "act-6"   // Resolution → Act III
      };
    case "heros-journey":
      return {
        "act-1": "act-1",  // Departure → Act I
        "act-2": "act-2",  // Initiation → Act II
        "act-3": "act-6"   // Return → Act III
      };
    case "save-the-cat":
      // Already 6 columns and the order maps cleanly to the new structure
      return {
        "act-1": "act-1",
        "act-2": "act-2",
        "act-3": "act-3",
        "act-4": "act-4",
        "act-5": "act-5",
        "act-6": "act-6"
      };
    case "kishotenketsu":
      return {
        "act-1": "act-1",  // Ki → Act I
        "act-2": "act-2",  // Shō → Act II
        "act-3": "act-4",  // Ten (twist) → Crisis
        "act-4": "act-6"   // Ketsu → Act III
      };
    case "free":
      return { "act-1": "act-2" }; // single "Story" → Act II as a starting point
  }
  return null;
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

// One-click migration: switch a project to the story-bible-default structure
// and remap card columnIds according to remapColumnIdsForNewDefault.
// Updates Firestore in a single batch and refreshes state.
export async function migrateProjectToNewDefault(state, projectId) {
  const current = getStorySettings(state.project);
  if (current.structure === "story-bible-default") {
    return { ok: false, reason: "already-on-default" };
  }
  const remap = remapColumnIdsForNewDefault(current.structure) || {};
  const cardsRef = collection(db, "users", state.user.uid, "projects", projectId, "cards");
  const snap = await getDocs(cardsRef);

  // Build the batch of card updates
  const batch = writeBatch(db);
  let movedCount = 0;
  snap.forEach(d => {
    const data = d.data();
    if (data.type !== "scene" && data.type !== "beat") return;
    const cur = data.fields?.columnId;
    if (!cur) return;
    const next = remap[cur];
    if (!next || next === cur) return;
    batch.update(d.ref, {
      "fields.columnId": next,
      updatedAt: serverTimestamp()
    });
    // Update local state too
    const local = state.cards.get(d.id);
    if (local) {
      local.fields = local.fields || {};
      local.fields.columnId = next;
    }
    movedCount++;
  });

  // Also update the project's structure setting
  state.project.storySettings = state.project.storySettings || {};
  state.project.storySettings.structure = "story-bible-default";
  batch.update(doc(db, "users", state.user.uid, "projects", projectId), {
    "storySettings.structure": "story-bible-default",
    updatedAt: serverTimestamp()
  });

  await batch.commit();
  return { ok: true, movedCount, fromStructure: current.structure };
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

        ${s.structure !== "story-bible-default" ? `
          <div class="ss-migration">
            <p class="muted small"><strong>You're on the older "${esc(STRUCTURE_OPTIONS.find(o => o.id === s.structure)?.label || s.structure)}" structure.</strong></p>
            <p class="muted small">Click below to switch to the new "Story Bible default" structure and automatically move your scene and beat cards to the matching new columns (Mid-Point and Crisis will start empty — those are new concepts).</p>
            <button type="button" id="ss-migrate-btn" class="primary small">Switch to Story Bible default and remap my cards</button>
            <p class="muted small" id="ss-migrate-status"></p>
          </div>
        ` : ""}

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

  overlay.querySelector("#ss-migrate-btn")?.addEventListener("click", async () => {
    const btn = overlay.querySelector("#ss-migrate-btn");
    const status = overlay.querySelector("#ss-migrate-status");
    const ok = confirm("Switch this project to the new Story Bible default structure?\n\nYour scenes and beats will be remapped:\n  - Act I and Act II stay where they are\n  - Climax content moves to the new Climax column\n  - Falling Action and Denouement move to Act III\n  - Mid-Point and Crisis start empty (new concepts)\n\nThis writes to Firestore. Continue?");
    if (!ok) return;
    btn.disabled = true;
    status.textContent = "Migrating…";
    try {
      const res = await migrateProjectToNewDefault(state, projectId);
      if (!res.ok && res.reason === "already-on-default") {
        status.textContent = "Already on the new structure.";
        return;
      }
      status.textContent = `Done — moved ${res.movedCount} card${res.movedCount === 1 ? "" : "s"} to the new structure.`;
      // Refresh story-settings modal UI to reflect the new state without forcing a page reload
      setTimeout(() => {
        close();
        onSaved?.(getStorySettings(state.project));
      }, 1500);
    } catch (err) {
      console.error("[story-settings] migrate failed", err);
      status.textContent = "Migration failed: " + (err.message || err);
      btn.disabled = false;
    }
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

// Narrative medium profiles — novel, film, TV series, video game.
//
// A project's medium lives at storySettings.medium. Each profile is DATA the
// rest of the app reads (structures offered, framing-column labels, length
// unit, extra scene fields, AI guidance, synopsis style) so adding a medium
// never means hunting for if/else branches. "Scene" stays the atomic unit in
// every medium; media add containers above it instead of renaming it.
//
// An unset medium behaves exactly as the app did before media existed; the
// project page asks once which medium it is (see askForMediumIfUnset).
// Plan: docs/narrative-types-plan.md

export const MEDIA = {
  novel: {
    id: "novel",
    label: "Novel",
    noun: "novel",
    icon: "📖",
    available: true,
    blurb: "Prose fiction, told in chapters.",
    structures: ["story-bible-default", "3-act", "save-the-cat", "heros-journey", "seven-point", "kishotenketsu", "5-act", "free"],
    framing: { prologue: "Prologue", epilogue: "Epilogue" },
    length: {
      unit: "words",
      targetLabel: "Target length (words)",
      defaultTarget: 90000,
      sceneLabel: "Estimated words",
      step: 100,
      format: (n) => n >= 1000 ? `${(Math.round(n / 100) / 10).toLocaleString()}k words` : `${Math.round(n)} words`,
      at: (n) => `~${n >= 1000 ? (Math.round(n / 1000)).toLocaleString() + "k" : Math.round(n)} words in`
    },
    guidance: [
      "This project is a NOVEL — prose fiction.",
      "Think in chapters and scenes. Point of view and interiority matter: what a character thinks and notices is as important as what they do.",
      "A chapter usually holds to one POV character; flag head-hopping. Pacing is measured in words.",
      "Typical adult novels run 70,000–110,000 words; scenes commonly 1,000–4,000 words."
    ].join(" "),
    synopsisNote: `Write it as a ONE-PAGE SUBMISSION SYNOPSIS of the kind sent to literary agents: present tense, third person, the protagonist's name in CAPS on first mention, covering the full arc INCLUDING THE ENDING (never tease or withhold the ending). Lead with the protagonist and what they want, then the central conflict, the major turns, and how it resolves, emotionally and plot-wise.`
  },

  film: {
    id: "film",
    label: "Film",
    noun: "film",
    icon: "🎬",
    available: true,
    blurb: "A feature screenplay, told in scenes and sequences.",
    structures: ["story-bible-default", "3-act", "save-the-cat", "eight-sequence", "heros-journey", "5-act", "kishotenketsu", "free"],
    framing: { prologue: "Prologue / Cold Open", epilogue: "Epilogue / Post-credits" },
    length: {
      unit: "pages",
      targetLabel: "Target length (script pages — about a minute each)",
      defaultTarget: 110,
      sceneLabel: "Estimated pages",
      step: 0.125,
      format: (n) => `${fmtPages(n)} pages`,
      at: (n) => `~p. ${Math.max(1, Math.round(n))}`
    },
    guidance: [
      "This project is a FILM — a feature screenplay.",
      "Everything must be shown, not told: favour what can be seen and heard on screen over interior thought.",
      "Think in scenes (one location, one continuous time) grouped into sequences. One script page is about one minute of screen time; features usually run 90–120 pages, and scenes are often 1–3 pages.",
      "Key turns land on rough page marks (inciting incident ~p.10–15, act break ~p.25–30, midpoint ~p.55, all-is-lost ~p.75–85)."
    ].join(" "),
    synopsisNote: `Write it as a FILM TREATMENT: start with a one-sentence LOGLINE on its own line (prefixed "Logline: "), then the treatment in present tense, describing what we SEE happen on screen, act by act, through to the ending (never withhold the ending).`
  },

  // Phase 2 and 3 — listed so pickers can show them as coming soon.
  tv: {
    id: "tv",
    label: "TV series",
    noun: "TV series",
    icon: "📺",
    available: false,
    blurb: "Seasons and episodes, with A/B/C plotlines.",
    structures: null,
    framing: null,
    length: null,
    guidance: "",
    synopsisNote: ""
  },
  game: {
    id: "game",
    label: "Video game",
    noun: "video game",
    icon: "🎮",
    available: false,
    blurb: "Quests, choices and features — linear or branching.",
    structures: null,
    framing: null,
    length: null,
    guidance: "",
    synopsisNote: ""
  }
};

export const MEDIA_LIST = Object.values(MEDIA);

function fmtPages(n) {
  const whole = Math.floor(n);
  const eighths = Math.round((n - whole) * 8);
  if (eighths === 0) return String(whole);
  if (eighths === 8) return String(whole + 1);
  return whole ? `${whole} ${eighths}/8` : `${eighths}/8`;
}

// The project's medium profile, or null when unset (or not built yet).
export function getMediumProfile(project) {
  const id = project?.storySettings?.medium;
  const m = id && MEDIA[id];
  return m && m.available ? m : null;
}

export function mediumLabel(id) {
  return MEDIA[id]?.label || "";
}

// Writer's target length, falling back to the medium's typical length.
export function targetLength(project) {
  const m = getMediumProfile(project);
  if (!m?.length) return 0;
  const t = Number(project?.storySettings?.targetLength);
  return t > 0 ? t : m.length.defaultTarget;
}

// Scene's estimated length as a number (0 = not estimated).
export function sceneLength(card) {
  const n = Number(card?.fields?.estLength);
  return n > 0 ? n : 0;
}

// Lines for the PROJECT CONTEXT block.
export function mediumContextLines(project) {
  const m = getMediumProfile(project);
  if (!m) return [];
  const lines = [`Medium: ${m.label}. ${m.guidance}`];
  const t = Number(project?.storySettings?.targetLength);
  if (m.length && t > 0) lines.push(`Target length: ${m.length.format(t)}.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Medium-specific scene fields (the editor block + outline chips)
// ---------------------------------------------------------------------------

export const INT_EXT = ["INT.", "EXT.", "INT./EXT."];
const TIMES_OF_DAY = ["DAY", "NIGHT", "MORNING", "AFTERNOON", "EVENING", "DAWN", "DUSK", "CONTINUOUS", "LATER", "MOMENTS LATER"];

// Fields this medium adds to scenes, and that merge/copy should carry.
export const MEDIUM_SCENE_FIELDS = ["chapter", "estLength", "intExt", "timeOfDay"];

export function mediumSceneEditorHtml(card, project, esc) {
  const m = getMediumProfile(project);
  if (!m) return "";
  const f = card.fields || {};
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const len = m.length ? `
      <label>${esc(m.length.sceneLabel)}
        <input type="number" min="0" step="${m.length.step}" data-field="estLength" value="${f.estLength ? esc(f.estLength) : ""}" placeholder="optional — drives pacing" />
      </label>` : "";
  if (m.id === "novel") {
    return `
      <div class="medium-fields">
        <label>Chapter <span class="muted small">— scenes with the same chapter group together on the Outline</span>
          <input data-field="chapter" value="${esc(f.chapter || "")}" placeholder="e.g. 3, or 3: The Fall" />
        </label>
        ${len}
      </div>`;
  }
  if (m.id === "film") {
    const ie = f.intExt || "";
    return `
      <div class="medium-fields medium-fields-film">
        <label>Interior / exterior
          <select data-field="intExt">
            ${opt("", "—", ie)}
            ${INT_EXT.map(v => opt(v, v, ie)).join("")}
          </select>
        </label>
        <label>Time of day
          <input data-field="timeOfDay" list="timeOfDayList" value="${esc(f.timeOfDay || "")}" placeholder="DAY, NIGHT…" />
          <datalist id="timeOfDayList">${TIMES_OF_DAY.map(t => `<option value="${t}">`).join("")}</datalist>
        </label>
        ${len}
      </div>`;
  }
  return len ? `<div class="medium-fields">${len}</div>` : "";
}

// Screenplay-style heading from the scene's tags: "INT. DINER — NIGHT".
export function sluglineFor(card, state) {
  const f = card.fields || {};
  if (!f.intExt && !f.timeOfDay) return "";
  const loc = (f.locationIds || []).map(id => state.cards.get(id)).find(c => c && !c.archived);
  const where = (loc?.title || "").toUpperCase();
  return [f.intExt || "", where, f.timeOfDay ? `— ${String(f.timeOfDay).toUpperCase()}` : ""].filter(Boolean).join(" ");
}

export function mediumSceneChipsHtml(card, state, esc) {
  const m = getMediumProfile(state.project);
  if (!m) return "";
  const f = card.fields || {};
  const bits = [];
  if (m.id === "film") {
    const slug = sluglineFor(card, state);
    if (slug) bits.push(`<span class="sf-chip sf-slug" title="Scene heading">${esc(slug)}</span>`);
  }
  const len = sceneLength(card);
  if (m.length && len) bits.push(`<span class="sf-chip" title="${esc(m.length.sceneLabel)}">≈ ${esc(m.length.format(len))}</span>`);
  return bits.length ? `<div class="sf-chips">${bits.join("")}</div>` : "";
}

// Extra scene facts for AI payloads (only what's set).
export function mediumScenePayload(card, state) {
  const m = getMediumProfile(state?.project);
  if (!m) return {};
  const f = card.fields || {};
  const out = {};
  if (m.id === "novel" && f.chapter) out.chapter = String(f.chapter);
  if (m.id === "film") {
    const slug = sluglineFor(card, state);
    if (slug) out.sceneHeading = slug;
  }
  const len = sceneLength(card);
  if (m.length && len) out.estimatedLength = m.length.format(len);
  return out;
}

// ---------------------------------------------------------------------------
// Novel chapters
// ---------------------------------------------------------------------------

// Normalised chapter key: "Chapter 3: The Fall" and "3" both group as "3".
export function chapterKey(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const m = s.match(/^(?:ch(?:apter)?\.?\s*)?([0-9]+|[ivxlc]+)\b/i);
  return (m ? m[1] : s).toLowerCase();
}

// Chapters whose scenes have more than one POV character:
// Map(chapterKey -> [povCharacterId, …]).
export function chapterPovConflicts(scenes) {
  const byChapter = new Map();
  for (const s of scenes) {
    const k = chapterKey(s.fields?.chapter);
    const pov = s.fields?.povCharacterId;
    if (!k || !pov) continue;
    if (!byChapter.has(k)) byChapter.set(k, new Set());
    byChapter.get(k).add(pov);
  }
  const out = new Map();
  for (const [k, povs] of byChapter) if (povs.size > 1) out.set(k, [...povs]);
  return out;
}

// ---------------------------------------------------------------------------
// "What kind of project is this?" — asked once per unmarked project
// ---------------------------------------------------------------------------

// Renders the medium choice as buttons. onPick(id) | onLater().
export function openMediumPicker({ title, intro, allowLater = true, onPick, onLater, esc }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal medium-picker-modal" role="dialog" aria-label="${esc(title)}">
      <div class="modal-header"><h2>${esc(title)}</h2></div>
      <div class="modal-body">
        <p class="muted small">${esc(intro)}</p>
        <div class="medium-choices">
          ${MEDIA_LIST.map(m => `
            <button type="button" class="medium-choice" data-medium="${m.id}"${m.available ? "" : " disabled"}>
              <span class="medium-icon">${m.icon}</span>
              <strong>${esc(m.label)}</strong>
              <span class="muted small">${esc(m.available ? m.blurb : "Coming soon")}</span>
            </button>`).join("")}
        </div>
      </div>
      ${allowLater ? `<div class="modal-actions"><button type="button" class="ghost cancel">Ask me later</button></div>` : ""}
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll(".medium-choice:not([disabled])").forEach(b => b.addEventListener("click", async () => {
    overlay.querySelectorAll("button").forEach(x => { x.disabled = true; });
    try { await onPick?.(b.dataset.medium); } finally { close(); }
  }));
  overlay.querySelector(".cancel")?.addEventListener("click", () => { close(); onLater?.(); });
  return { close };
}

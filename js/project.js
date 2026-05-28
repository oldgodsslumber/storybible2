import {
  auth, db, onAuthChange, renderUserArea, show, hide, blankFieldsForType, CARD_TYPES, KANBAN_STAGES, openBusyOverlay
} from "./shared.js";
import {
  doc, getDoc, getDocs, collection, addDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { isConfigured, getSettings } from "./llm.js";
import { openSettingsModal } from "./settings.js";
import {
  extractFromIdeaDump, parseSidePanelNote, runGapAnalysis,
  openApprovalModal, openWizardModal
} from "./extraction.js";
import { logAudit, staleImpact, changesSinceLastRefresh } from "./audit.js";
import { runGlobalRefresh, provideStateRef } from "./refresh.js";
import {
  renderReviewPanel, generateScene, insertGeneratedScene,
  suggestTraits, applyTraitSuggestions, openTraitSuggestModal,
  openSceneProposalModal
} from "./review.js";

const REFRESH_NUDGE_THRESHOLD = 60;

const params = new URLSearchParams(location.search);
const projectId = params.get("id");
const isNewProject = params.get("isNew") === "1";

const els = {
  loading: document.getElementById("loading"),
  userArea: document.getElementById("userArea"),
  projectTitle: document.getElementById("projectTitle"),
  graphView: document.getElementById("graphView"),
  outlineView: document.getElementById("outlineView"),
  reviewView: document.getElementById("reviewView"),
  archiveView: document.getElementById("archiveView"),
  notePanel: document.getElementById("notePanel"),
  parseNoteBtn: document.getElementById("parseNoteBtn"),
  clearNoteBtn: document.getElementById("clearNoteBtn"),
  rerunExtractBtn: document.getElementById("rerunExtractBtn"),
  llmStatus: document.getElementById("llmStatus"),
  outlineList: document.getElementById("outlineList"),
  outlineEmpty: document.getElementById("outlineEmpty"),
  archiveList: document.getElementById("archiveList"),
  archiveEmpty: document.getElementById("archiveEmpty"),
  kanbanView: document.getElementById("kanbanView"),
  kanbanBoard: document.getElementById("kanbanBoard"),
  cardEditor: document.getElementById("cardEditor"),
  refreshBtn: document.getElementById("refreshBtn"),
  refreshBadge: document.getElementById("refreshBadge"),
  tabs: document.querySelectorAll(".tab"),
  cardTypeButtons: document.querySelectorAll(".card-type-buttons button"),
};

const state = {
  user: null,
  project: null,
  cards: new Map(),
  connections: new Map(),
  cy: null,
  selectedCardId: null,
  connectMode: false,
  connectFrom: null,
};

if (!projectId) {
  location.href = "./index.html";
}

onAuthChange(async user => {
  if (!user) {
    location.href = "./index.html";
    return;
  }
  state.user = user;
  renderUserArea(els.userArea, user);
  await loadProject();
});

els.tabs.forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));
els.cardTypeButtons.forEach(b => b.addEventListener("click", () => createCard(b.dataset.type)));
els.parseNoteBtn?.addEventListener("click", parseNoteHandler);
els.clearNoteBtn?.addEventListener("click", () => { els.notePanel.value = ""; });
els.refreshBtn?.addEventListener("click", handleRefresh);
els.rerunExtractBtn?.addEventListener("click", () => runIdeaDumpExtractionNow());

provideStateRef(state);

async function handleRefresh() {
  if (document.body.classList.contains("refresh-locked")) return;
  await runGlobalRefresh({
    state,
    projectId,
    onChanged: () => {
      rebuildGraphElements();
      if (state.selectedCardId) openCardEditor(state.selectedCardId);
      updateRefreshNudge();
    }
  });
}

function maybeShowRefreshNudge() {
  const n = changesSinceLastRefresh(state.project).length;
  if (n < REFRESH_NUDGE_THRESHOLD) return;
  if (sessionStorage.getItem("nudge.dismissed." + projectId)) return;
  const ok = confirm(`You have ${n} unsynced changes since your last Global Refresh.\n\nWe recommend a Global Refresh before reviewing — your summaries may be out of date.\n\nRun it now?`);
  if (ok) {
    handleRefresh();
  } else {
    sessionStorage.setItem("nudge.dismissed." + projectId, "1");
  }
}

function updateRefreshNudge() {
  const changes = changesSinceLastRefresh(state.project);
  const n = changes.length;
  if (els.refreshBadge) {
    if (n > 0) {
      els.refreshBadge.textContent = String(n);
      els.refreshBadge.classList.remove("hidden");
    } else {
      els.refreshBadge.classList.add("hidden");
    }
    els.refreshBadge.classList.toggle("warn", n >= REFRESH_NUDGE_THRESHOLD);
  }
}

async function loadProject() {
  const projectRef = doc(db, "users", state.user.uid, "projects", projectId);
  const projectSnap = await getDoc(projectRef);
  if (!projectSnap.exists()) {
    alert("Project not found.");
    location.href = "./index.html";
    return;
  }
  state.project = { id: projectSnap.id, ...projectSnap.data() };
  els.projectTitle.textContent = state.project.title || "(untitled)";
  document.title = `${state.project.title} — The Writer's Assistant`;

  const cardsSnap = await getDocs(collection(db, "users", state.user.uid, "projects", projectId, "cards"));
  cardsSnap.forEach(d => state.cards.set(d.id, { id: d.id, ...d.data() }));

  const connSnap = await getDocs(collection(db, "users", state.user.uid, "projects", projectId, "connections"));
  connSnap.forEach(d => state.connections.set(d.id, { id: d.id, ...d.data() }));

  hide(els.loading);
  switchView("graph");
  updateRefreshNudge();
  if (els.rerunExtractBtn) {
    els.rerunExtractBtn.classList.remove("hidden");
    const hasText = !!(state.project.themeText || "").trim();
    if (!hasText) {
      els.rerunExtractBtn.title = "This project has no idea-dump text.";
    }
  }
  console.log("[project] loaded", {
    cards: state.cards.size,
    connections: state.connections.size,
    themeTextChars: (state.project.themeText || "").length,
    auditEntries: (state.project.auditTrail || []).length
  });
  if (isNewProject) {
    history.replaceState({}, "", `./project.html?id=${encodeURIComponent(projectId)}`);
    await maybeRunIdeaDumpExtraction();
  }
}

async function maybeRunIdeaDumpExtraction() {
  console.log("[idea-dump] auto-trigger on new project");
  const themeText = (state.project.themeText || "").trim();
  if (!themeText) {
    console.log("[idea-dump] aborted: project has no themeText");
    return;
  }
  if (!isConfigured()) {
    console.log("[idea-dump] aborted: no LLM provider configured");
    const wantConfigure = confirm("You have an idea dump but no LLM provider is configured.\n\nConfigure one now to extract characters, locations, and themes?\n\nCancel = work manually for now (you can run extraction later from the side panel.)");
    if (wantConfigure) openSettingsModal();
    return;
  }
  await runIdeaDumpExtractionNow(themeText);
}

async function runIdeaDumpExtractionNow(themeText) {
  console.log("[idea-dump] runIdeaDumpExtractionNow called", { providedText: !!themeText });
  if (!themeText) themeText = (state.project.themeText || "").trim();
  if (!themeText) {
    console.log("[idea-dump] aborted: no themeText on project");
    alert("This project has no idea-dump text to extract from. Create a new project from the dashboard and type your idea dump in the big text field.");
    return;
  }
  if (!isConfigured()) {
    console.log("[idea-dump] aborted: no LLM provider configured");
    alert("No LLM provider configured. Open ⚙ Settings to set one up.");
    return;
  }
  const busy = openBusyOverlay("Extracting entities from your idea dump…");
  let parsed;
  try {
    console.log("[idea-dump] starting extraction");
    parsed = await extractFromIdeaDump(themeText);
    console.log("[idea-dump] extraction returned", parsed);
  } catch (err) {
    busy.close();
    console.error("[idea-dump] extraction failed", err);
    alert("Extraction failed: " + (err.message || err));
    return;
  }
  busy.close();

  if (!parsed || typeof parsed !== "object") {
    alert("Extraction returned an unexpected shape. Check the browser console for details.");
    console.error("[idea-dump] parsed is not an object", parsed);
    return;
  }

  openApprovalModal(parsed, {
    title: "Review what the LLM found in your idea dump",
    onApprove: async (approved) => {
      try {
        await applyApprovedItems(approved);
      } catch (err) {
        console.error("[idea-dump] applyApprovedItems failed", err);
        alert("Saving approved items failed: " + (err.message || err));
        return;
      }
      const gapBusy = openBusyOverlay("Looking for narrative gaps to fill…");
      let gap;
      try {
        gap = await runGapAnalysis(themeText, parsed);
        console.log("[idea-dump] gap analysis returned", gap);
      } catch (err) {
        gapBusy.close();
        console.error("[idea-dump] gap analysis failed", err);
        alert("Gap analysis failed: " + (err.message || err));
        return;
      }
      gapBusy.close();
      const questions = gap?.questions || [];
      if (questions.length === 0) {
        console.log("[idea-dump] no gap questions returned");
        return;
      }
      openWizardModal(questions, {
        onComplete: async ({ answers }) => {
          try {
            await applyWizardAnswers(answers);
          } catch (err) {
            console.error("[idea-dump] applyWizardAnswers failed", err);
            alert("Saving wizard answers failed: " + (err.message || err));
          }
        }
      });
    }
  });
}

async function parseNoteHandler() {
  console.log("[parse-note] button clicked");
  const text = els.notePanel.value.trim();
  if (!text) {
    console.log("[parse-note] aborted: notepad is empty");
    alert("Type something into the note panel first, then click Parse with LLM.");
    return;
  }
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) openSettingsModal();
    return;
  }
  const busy = openBusyOverlay("Parsing note…");
  let parsed;
  try {
    parsed = await parseSidePanelNote(text, existingEntitySummaries());
  } catch (err) {
    busy.close();
    console.error("[parse-note] failed", err);
    alert("Parsing failed: " + (err.message || err));
    return;
  }
  busy.close();
  if (!parsed || typeof parsed !== "object") {
    alert("Parsing returned an unexpected shape. Check the browser console for details.");
    console.error("[parse-note] parsed is not an object", parsed);
    return;
  }
  openApprovalModal(parsed, {
    title: "Review what the LLM found in your note",
    onApprove: async (approved) => {
      try {
        await applyApprovedItems(approved);
        els.notePanel.value = "";
      } catch (err) {
        console.error("[parse-note] applyApprovedItems failed", err);
        alert("Saving approved items failed: " + (err.message || err));
      }
    }
  });
}

function existingEntitySummaries() {
  const out = [];
  for (const c of state.cards.values()) {
    if (c.archived) continue;
    out.push({ type: c.type, title: c.title, role: c.fields?.role || "" });
  }
  return out;
}

function setLlmStatus(msg) {
  if (els.llmStatus) els.llmStatus.textContent = msg || "";
}

// --- Apply approved items to Firestore + state ---

async function applyApprovedItems(approved) {
  const nameToCardId = new Map();
  for (const c of state.cards.values()) {
    if (!c.archived) nameToCardId.set(c.title.toLowerCase(), c.id);
  }

  const cardsCol = collection(db, "users", state.user.uid, "projects", projectId, "cards");
  const connCol  = collection(db, "users", state.user.uid, "projects", projectId, "connections");
  const auditBatch = [];

  for (const ch of approved.characters || []) {
    const data = {
      type: "character",
      title: ch.name,
      archived: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      order: 0,
      fields: {
        ...blankFieldsForType("character"),
        role: ch.role || "",
        traits: ch.traits || [],
        history: ch.history || []
      }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(ch.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "character", title: ch.name, source: ch.source } });
  }
  for (const l of approved.locations || []) {
    const data = {
      type: "location", title: l.name, archived: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), order: 0,
      fields: { ...blankFieldsForType("location"), description: l.description || "" }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(l.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "location", title: l.name, source: l.source } });
  }
  for (const t of approved.themes || []) {
    const data = {
      type: "theme", title: t.name, archived: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), order: 0,
      fields: { ...blankFieldsForType("theme"), description: t.description || "" }
    };
    const ref = await addDoc(cardsCol, data);
    state.cards.set(ref.id, { id: ref.id, ...data });
    nameToCardId.set(t.name.toLowerCase(), ref.id);
    auditBatch.push({ entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type: "theme", title: t.name, source: t.source } });
  }

  for (const u of approved.updates || []) {
    const targetId = nameToCardId.get((u.entityName || "").toLowerCase());
    if (!targetId) continue;
    const card = state.cards.get(targetId);
    if (!card) continue;
    card.fields = card.fields || {};
    const f = u.field;
    if (f === "traits" || f === "history") {
      const arr = Array.isArray(card.fields[f]) ? card.fields[f].slice() : [];
      arr.push(u.addValue);
      card.fields[f] = arr;
    } else if (f === "role" || f === "description") {
      card.fields[f] = card.fields[f] ? (card.fields[f] + "\n" + u.addValue) : u.addValue;
    } else {
      card.fields[f] = u.addValue;
    }
    // Stale impact for updates from LLM parsing
    const impact = staleImpact("card-" + card.type, f);
    const extra = {};
    if (impact?.self) {
      card.fields[impact.self.field] = impact.self.value;
      extra[`fields.${impact.self.field}`] = impact.self.value;
    }
    await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", targetId), {
      [`fields.${f}`]: card.fields[f],
      ...extra,
      updatedAt: serverTimestamp()
    });
    auditBatch.push({ entityType: "card", entityId: targetId, field: f, oldValue: null, newValue: u.addValue });
  }

  for (const c of approved.connections || []) {
    const fromId = nameToCardId.get((c.from || "").toLowerCase());
    const toId   = nameToCardId.get((c.to   || "").toLowerCase());
    if (!fromId || !toId) continue;
    const data = {
      fromCardId: fromId, toCardId: toId,
      label: c.label || "", createdAt: serverTimestamp()
    };
    const ref = await addDoc(connCol, data);
    state.connections.set(ref.id, { id: ref.id, ...data });
    auditBatch.push({ entityType: "connection", entityId: ref.id, field: "created", oldValue: null, newValue: { fromCardId: fromId, toCardId: toId, label: data.label } });
  }

  if (auditBatch.length) {
    await logAudit(state.user.uid, projectId, auditBatch, state.project);
  }
  await touchProject();
  rebuildGraphElements();
  updateRefreshNudge();
}

async function applyWizardAnswers(answers) {
  if (!answers || answers.length === 0) return;
  const nameToCardId = new Map();
  for (const c of state.cards.values()) {
    if (!c.archived) nameToCardId.set(c.title.toLowerCase(), c.id);
  }

  for (const a of answers) {
    if (!a.answer) continue;
    // Project-level fields
    if (a.targetEntityType === "project") {
      const patch = {};
      if (a.targetField === "pillars") {
        const arr = Array.isArray(state.project.pillars) ? state.project.pillars.slice() : [];
        arr.push(a.answer);
        state.project.pillars = arr;
        patch.pillars = arr;
      } else if (a.targetField === "logline") {
        state.project.logline = a.answer;
        patch.logline = a.answer;
      }
      if (Object.keys(patch).length) {
        patch.updatedAt = serverTimestamp();
        await updateDoc(doc(db, "users", state.user.uid, "projects", projectId), patch);
      }
      continue;
    }
    // Card-level
    const targetId = a.targetEntityName ? nameToCardId.get(a.targetEntityName.toLowerCase()) : null;
    if (!targetId) continue;
    const card = state.cards.get(targetId);
    if (!card) continue;
    card.fields = card.fields || {};
    const f = a.targetField;
    if (!f) continue;
    if (f === "traits" || f === "history") {
      const arr = Array.isArray(card.fields[f]) ? card.fields[f].slice() : [];
      arr.push(a.answer);
      card.fields[f] = arr;
    } else {
      card.fields[f] = card.fields[f] ? (card.fields[f] + "\n" + a.answer) : a.answer;
    }
    const impact = staleImpact("card-" + card.type, f);
    const extra = {};
    if (impact?.self) {
      card.fields[impact.self.field] = impact.self.value;
      extra[`fields.${impact.self.field}`] = impact.self.value;
    }
    await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", targetId), {
      [`fields.${f}`]: card.fields[f],
      ...extra,
      updatedAt: serverTimestamp()
    });
    await logAudit(state.user.uid, projectId, [{
      entityType: "card", entityId: targetId, field: f, oldValue: null, newValue: a.answer
    }], state.project);
  }

  await touchProject();
  rebuildGraphElements();
  updateRefreshNudge();
}

function switchView(name) {
  els.tabs.forEach(t => t.classList.toggle("active", t.dataset.view === name));
  hide(els.graphView);
  hide(els.outlineView);
  hide(els.reviewView);
  hide(els.archiveView);
  hide(els.kanbanView);
  hideCardEditor();

  if (name === "graph") {
    show(els.graphView);
    initOrRefreshGraph();
  } else if (name === "outline") {
    show(els.outlineView);
    renderOutline();
  } else if (name === "review") {
    show(els.reviewView);
    maybeShowRefreshNudge();
    renderReviewPanel(els.reviewView, state, projectId, {
      onChanged: () => { rebuildGraphElements(); updateRefreshNudge(); }
    });
  } else if (name === "kanban") {
    show(els.kanbanView);
    renderKanban();
  } else if (name === "archive") {
    show(els.archiveView);
    renderArchive();
  }
}

// --- Kanban ---

function renderKanban() {
  els.kanbanBoard.innerHTML = "";
  const scenes = [...state.cards.values()]
    .filter(c => c.type === "scene" && !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const stage of KANBAN_STAGES) {
    const col = document.createElement("div");
    col.className = "kanban-col";
    col.dataset.stage = stage.id;
    const inThisStage = scenes.filter(s => (s.fields?.kanbanStage || "idea") === stage.id);
    col.innerHTML = `
      <header class="kanban-col-head">
        <h3>${esc(stage.label)}</h3>
        <span class="muted small">${inThisStage.length}</span>
      </header>
      <div class="kanban-col-body"></div>
    `;
    const bodyEl = col.querySelector(".kanban-col-body");
    for (const s of inThisStage) {
      bodyEl.appendChild(makeKanbanCard(s));
    }
    col.addEventListener("dragover", e => {
      e.preventDefault();
      col.classList.add("drop-target");
    });
    col.addEventListener("dragleave", () => col.classList.remove("drop-target"));
    col.addEventListener("drop", async e => {
      e.preventDefault();
      col.classList.remove("drop-target");
      const cardId = e.dataTransfer.getData("text/plain");
      if (!cardId) return;
      await setKanbanStage(cardId, stage.id);
      renderKanban();
    });
    els.kanbanBoard.appendChild(col);
  }
}

function makeKanbanCard(scene) {
  const div = document.createElement("article");
  div.className = "kanban-card";
  div.draggable = true;
  div.dataset.cardId = scene.id;
  const stale = scene.fields?.ragSummaryStale ? '<span class="stale-icon">⚠</span>' : "";
  div.innerHTML = `
    <h4>${esc(scene.title)} ${stale}</h4>
    <p class="muted small">${esc(scene.fields?.shortDescription || scene.fields?.ragSummary || "")}</p>
  `;
  div.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/plain", scene.id);
    e.dataTransfer.effectAllowed = "move";
    div.classList.add("dragging");
  });
  div.addEventListener("dragend", () => div.classList.remove("dragging"));
  div.addEventListener("click", () => {
    switchView("graph");
    openCardEditor(scene.id);
  });
  return div;
}

async function setKanbanStage(cardId, newStage) {
  const card = state.cards.get(cardId);
  if (!card || card.type !== "scene") return;
  const oldStage = card.fields?.kanbanStage || "idea";
  if (oldStage === newStage) return;
  card.fields = card.fields || {};
  card.fields.kanbanStage = newStage;
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId), {
    "fields.kanbanStage": newStage,
    updatedAt: serverTimestamp()
  });
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: "kanbanStage", oldValue: oldStage, newValue: newStage
  }], state.project);
  await touchProject();
  updateRefreshNudge();
}

// --- Graph ---

function initOrRefreshGraph() {
  if (!state.cy) {
    state.cy = cytoscape({
      container: document.getElementById("cy"),
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#3a3a4a",
            "label": "data(label)",
            "color": "#e8e8e8",
            "text-valign": "center",
            "text-halign": "center",
            "text-wrap": "wrap",
            "text-max-width": "120px",
            "font-size": 12,
            "width": 140,
            "height": 60,
            "shape": "round-rectangle",
            "border-width": 2,
            "border-color": "#555",
            "padding": 8
          }
        },
        { selector: "node[type='character']", style: { "background-color": "#3b5278", "border-color": "#5a7fb8" } },
        { selector: "node[type='scene']",     style: { "background-color": "#5a3b78", "border-color": "#8a5fb8" } },
        { selector: "node[type='theme']",     style: { "background-color": "#785a3b", "border-color": "#b88a5f" } },
        { selector: "node[type='location']",  style: { "background-color": "#3b7860", "border-color": "#5fb890" } },
        { selector: "node[type='arc']",       style: { "background-color": "#78443b", "border-color": "#b8685f" } },
        {
          selector: "edge",
          style: {
            "width": 2,
            "line-color": "#666",
            "target-arrow-color": "#666",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "label": "data(label)",
            "font-size": 10,
            "color": "#bbb",
            "text-background-color": "#1c1c22",
            "text-background-opacity": 1,
            "text-background-padding": 2
          }
        },
        { selector: ".connect-source", style: { "border-color": "#ffd45a", "border-width": 4 } },
        { selector: "node[stale='1']", style: { "border-style": "dashed", "border-color": "#e0b95a" } }
      ],
      layout: { name: "cose", animate: false }
    });

    state.cy.on("tap", "node", evt => {
      const id = evt.target.id();
      if (state.connectMode) {
        handleConnectTap(id);
      } else {
        openCardEditor(id);
      }
    });
    state.cy.on("tap", evt => {
      if (evt.target === state.cy) {
        if (state.connectMode) cancelConnectMode();
        hideCardEditor();
      }
    });
  }
  rebuildGraphElements();
}

function rebuildGraphElements() {
  if (!state.cy) return;
  state.cy.elements().remove();
  const nodes = [];
  for (const card of state.cards.values()) {
    if (card.archived) continue;
    const f = card.fields || {};
    const stale = !!(f.storyRoleSummaryStale || f.ragSummaryStale || f.summaryStale);
    nodes.push({
      data: {
        id: card.id,
        label: (stale ? "⚠ " : "") + (card.title || `(untitled ${card.type})`),
        type: card.type,
        stale: stale ? "1" : "0"
      }
    });
  }
  const edges = [];
  const activeIds = new Set(nodes.map(n => n.data.id));
  for (const c of state.connections.values()) {
    if (!activeIds.has(c.fromCardId) || !activeIds.has(c.toCardId)) continue;
    edges.push({
      data: {
        id: c.id,
        source: c.fromCardId,
        target: c.toCardId,
        label: c.label || ""
      }
    });
  }
  state.cy.add([...nodes, ...edges]);
  state.cy.layout({ name: "cose", animate: false }).run();
}

// --- Card CRUD ---

async function createCard(type) {
  if (!CARD_TYPES.includes(type)) return;
  const title = prompt(`New ${type} card — title:`);
  if (title === null) return;
  const trimmed = title.trim();
  if (!trimmed) return;

  const data = {
    type,
    title: trimmed,
    archived: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    order: type === "scene" ? nextSceneOrder() : 0,
    fields: blankFieldsForType(type)
  };
  const ref = await addDoc(collection(db, "users", state.user.uid, "projects", projectId, "cards"), data);
  state.cards.set(ref.id, { id: ref.id, ...data });
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: ref.id, field: "created", oldValue: null, newValue: { type, title: trimmed }
  }], state.project);
  await touchProject();
  rebuildGraphElements();
  updateRefreshNudge();
  openCardEditor(ref.id);
}

function nextSceneOrder() {
  let max = -1;
  for (const c of state.cards.values()) {
    if (c.type === "scene" && !c.archived && typeof c.order === "number" && c.order > max) {
      max = c.order;
    }
  }
  return max + 1;
}

function openCardEditor(cardId) {
  const card = state.cards.get(cardId);
  if (!card) return;
  state.selectedCardId = cardId;
  els.cardEditor.innerHTML = renderEditor(card);
  show(els.cardEditor);
  wireEditor(card);
}

function hideCardEditor() {
  hide(els.cardEditor);
  els.cardEditor.innerHTML = "";
  state.selectedCardId = null;
}

function renderEditor(card) {
  const f = card.fields || {};
  let typeSpecific = "";
  let summarySection = "";
  if (card.type === "character") {
    summarySection = renderSummaryBlock(card, "storyRoleSummary", "Story Role Summary", f.storyRoleSummaryStale);
  } else if (card.type === "scene") {
    summarySection = renderSummaryBlock(card, "ragSummary", "RAG Summary", f.ragSummaryStale);
  }
  if (card.type === "character") {
    typeSpecific = `
      <label>Role <input data-field="role" value="${attr(f.role)}" /></label>
      <label>Age <input data-field="age" value="${attr(f.age)}" /></label>
      <label>Physical Description <textarea data-field="physicalDescription" rows="2">${esc(f.physicalDescription)}</textarea></label>
      <label>History (one bullet per line) <textarea data-field="history" data-list="1" rows="3">${esc((f.history||[]).join("\n"))}</textarea></label>
      <label>Traits (one bullet per line) <textarea data-field="traits" data-list="1" rows="3">${esc((f.traits||[]).join("\n"))}</textarea></label>
    `;
  } else if (card.type === "scene") {
    typeSpecific = `
      <label>Short Description <textarea data-field="shortDescription" rows="2">${esc(f.shortDescription)}</textarea></label>
      <label>Long Description <textarea data-field="longDescription" rows="5">${esc(f.longDescription)}</textarea></label>
      ${renderMultiTagPicker(card, "characterIds", "Characters", "character")}
      ${renderMultiTagPicker(card, "locationIds",  "Locations",  "location")}
      ${renderMultiTagPicker(card, "arcIds",       "Arcs",       "arc")}
    `;
  } else if (card.type === "theme" || card.type === "location") {
    typeSpecific = `<label>Description <textarea data-field="description" rows="3">${esc(f.description)}</textarea></label>`;
  } else if (card.type === "arc") {
    const staleTag = f.summaryStale ? ' <span class="stale-icon" title="Stale — re-run Refresh">⚠ stale</span>' : "";
    typeSpecific = `<label>Summary${staleTag} <textarea data-field="summary" rows="4">${esc(f.summary)}</textarea></label>`;
  }
  return `
    <div class="editor-header">
      <span class="badge ${card.type}">${card.type}</span>
      <button class="ghost small close-editor">Close</button>
    </div>
    <label>Title <input data-field="title" data-top="1" value="${attr(card.title)}" /></label>
    ${typeSpecific}
    ${summarySection}
    <div class="editor-actions">
      <button class="ghost small toggle-connect">Connect to…</button>
      ${card.type === "character" ? `<button class="ghost small suggest-traits">Suggest traits…</button>` : ""}
      <button class="danger small archive-card">Archive</button>
    </div>
    <p class="muted small">Changes save on blur.</p>
  `;
}

function renderMultiTagPicker(card, fieldName, label, targetType) {
  const f = card.fields || {};
  const selected = new Set(f[fieldName] || []);
  const opts = [...state.cards.values()]
    .filter(c => c.type === targetType && !c.archived)
    .map(c => c.id);
  if (opts.length === 0) {
    return `<div class="muted small">No ${esc(targetType)} cards to tag yet.</div>`;
  }
  return `
    <label>${esc(label)}
      <div class="tag-picker" data-field="${fieldName}">
        ${opts.map(id => {
          const c = state.cards.get(id);
          const checked = selected.has(id) ? "checked" : "";
          return `<label class="tag-chip"><input type="checkbox" data-tag-id="${id}" ${checked} /> ${esc(c.title)}</label>`;
        }).join("")}
      </div>
    </label>
  `;
}

function renderSummaryBlock(card, field, label, isStale) {
  const f = card.fields || {};
  const val = f[field] || "";
  if (!val && !isStale) {
    return `<div class="summary-block"><div class="summary-label">${esc(label)} <span class="muted small">— not generated yet</span></div></div>`;
  }
  const staleIcon = isStale ? `<span class="stale-icon" title="Stale — re-run Refresh">⚠ stale</span>` : "";
  return `
    <div class="summary-block ${isStale ? "is-stale" : ""}">
      <div class="summary-label">${esc(label)} ${staleIcon}</div>
      <label><textarea data-field="${field}" rows="3">${esc(val)}</textarea></label>
    </div>
  `;
}

function wireEditor(card) {
  els.cardEditor.querySelectorAll("input[data-field], textarea[data-field]").forEach(input => {
    input.addEventListener("blur", () => saveField(card.id, input));
  });
  els.cardEditor.querySelectorAll(".tag-picker").forEach(picker => {
    picker.addEventListener("change", () => saveTagPicker(card.id, picker));
  });
  els.cardEditor.querySelector(".close-editor").addEventListener("click", hideCardEditor);
  els.cardEditor.querySelector(".archive-card").addEventListener("click", () => archiveCard(card.id));
  els.cardEditor.querySelector(".toggle-connect").addEventListener("click", () => startConnectMode(card.id));
  els.cardEditor.querySelector(".suggest-traits")?.addEventListener("click", () => handleSuggestTraits(card.id));
}

async function saveTagPicker(cardId, picker) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const fieldName = picker.dataset.field;
  const ids = [...picker.querySelectorAll("input[type=checkbox]")]
    .filter(x => x.checked)
    .map(x => x.dataset.tagId);
  const old = (card.fields?.[fieldName] || []).slice();
  card.fields = card.fields || {};
  card.fields[fieldName] = ids;
  const updates = {
    [`fields.${fieldName}`]: ids,
    updatedAt: serverTimestamp()
  };
  // Scene-arc linkage: if arcIds changed, mark those arcs' summaries stale.
  if (card.type === "scene" && fieldName === "arcIds") {
    const affected = new Set([...old, ...ids]);
    for (const arcId of affected) {
      const arc = state.cards.get(arcId);
      if (arc && arc.type === "arc") {
        arc.fields = arc.fields || {};
        arc.fields.summaryStale = true;
        await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", arcId), {
          "fields.summaryStale": true,
          updatedAt: serverTimestamp()
        });
      }
    }
  }
  await updateDoc(doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId), updates);
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: fieldName, oldValue: old, newValue: ids
  }], state.project);
  updateRefreshNudge();
  rebuildGraphElements();
}

async function handleSuggestTraits(cardId) {
  try {
    setLlmStatus("Generating trait suggestions…");
    const r = await suggestTraits(state, cardId);
    setLlmStatus("");
    if (!r || !r.suggestions) return;
    openTraitSuggestModal(r.suggestions, {
      onApply: async (picked) => {
        if (!picked || picked.length === 0) return;
        await applyTraitSuggestions(state, projectId, cardId, picked);
        if (state.selectedCardId === cardId) openCardEditor(cardId);
        rebuildGraphElements();
        updateRefreshNudge();
      }
    });
  } catch (e) {
    setLlmStatus("");
    alert("Trait suggestion failed: " + e.message);
  }
}

async function saveField(cardId, input) {
  const card = state.cards.get(cardId);
  if (!card) return;
  const fieldName = input.dataset.field;
  const isList = input.dataset.list === "1";
  const isTop = input.dataset.top === "1";
  let value = input.value;
  if (isList) {
    value = value.split("\n").map(s => s.trim()).filter(Boolean);
  }
  const updates = { updatedAt: serverTimestamp() };
  const oldValue = isTop ? card[fieldName] : card.fields?.[fieldName];
  if (isTop) {
    card[fieldName] = value;
    updates[fieldName] = value;
    if (fieldName === "title") {
      const node = state.cy?.getElementById(cardId);
      if (node) node.data("label", value);
    }
  } else {
    card.fields = card.fields || {};
    card.fields[fieldName] = value;
    updates[`fields.${fieldName}`] = value;
  }

  // Stale impact
  const impact = staleImpact("card-" + card.type, fieldName);
  if (impact?.self) {
    card.fields = card.fields || {};
    card.fields[impact.self.field] = impact.self.value;
    updates[`fields.${impact.self.field}`] = impact.self.value;
  }

  // If the user is directly editing a summary field, track that
  if (["storyRoleSummary", "ragSummary", "summary"].includes(fieldName)) {
    const flag = fieldName + "_userEdited";
    card.fields = card.fields || {};
    card.fields[flag] = true;
    updates[`fields.${flag}`] = true;
  }

  const ref = doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId);
  await updateDoc(ref, updates);
  await logAudit(state.user.uid, projectId, [{
    entityType: "card",
    entityId: cardId,
    field: fieldName,
    oldValue,
    newValue: value
  }], state.project);
  updateRefreshNudge();
}

async function archiveCard(cardId) {
  if (!confirm("Archive this card? You can restore it from the Archive tab.")) return;
  const ref = doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId);
  await updateDoc(ref, { archived: true, updatedAt: serverTimestamp() });
  const card = state.cards.get(cardId);
  if (card) card.archived = true;
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: "archived", oldValue: false, newValue: true
  }], state.project);
  await touchProject();
  hideCardEditor();
  rebuildGraphElements();
  updateRefreshNudge();
}

async function restoreCard(cardId) {
  const ref = doc(db, "users", state.user.uid, "projects", projectId, "cards", cardId);
  await updateDoc(ref, { archived: false, updatedAt: serverTimestamp() });
  const card = state.cards.get(cardId);
  if (card) card.archived = false;
  await logAudit(state.user.uid, projectId, [{
    entityType: "card", entityId: cardId, field: "archived", oldValue: true, newValue: false
  }], state.project);
  await touchProject();
  renderArchive();
  updateRefreshNudge();
}

// --- Connections ---

function startConnectMode(cardId) {
  state.connectMode = true;
  state.connectFrom = cardId;
  hideCardEditor();
  state.cy.nodes().removeClass("connect-source");
  state.cy.getElementById(cardId).addClass("connect-source");
  flashStatus(`Pick another card to connect to "${state.cards.get(cardId)?.title}". Click background to cancel.`);
}

function cancelConnectMode() {
  state.connectMode = false;
  state.connectFrom = null;
  state.cy?.nodes().removeClass("connect-source");
  clearStatus();
}

async function handleConnectTap(toId) {
  if (toId === state.connectFrom) {
    cancelConnectMode();
    return;
  }
  const label = prompt("Connection label (e.g. 'appears in', 'conflicts with'):", "");
  const fromId = state.connectFrom;
  cancelConnectMode();
  if (label === null) return;
  const data = {
    fromCardId: fromId,
    toCardId: toId,
    label: label.trim(),
    createdAt: serverTimestamp()
  };
  const ref = await addDoc(collection(db, "users", state.user.uid, "projects", projectId, "connections"), data);
  state.connections.set(ref.id, { id: ref.id, ...data });
  await logAudit(state.user.uid, projectId, [{
    entityType: "connection", entityId: ref.id, field: "created", oldValue: null,
    newValue: { fromCardId: fromId, toCardId: toId, label: data.label }
  }], state.project);
  await touchProject();
  rebuildGraphElements();
  updateRefreshNudge();
}

// --- Outline ---

function renderOutline() {
  els.outlineList.innerHTML = "";
  const scenes = [...state.cards.values()]
    .filter(c => c.type === "scene" && !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (scenes.length === 0) {
    show(els.outlineEmpty);
    els.outlineList.appendChild(makePlusButton(null, null));
    return;
  }
  hide(els.outlineEmpty);
  els.outlineList.appendChild(makePlusButton(null, scenes[0].id));
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const li = document.createElement("li");
    li.className = "outline-item";
    li.draggable = true;
    li.dataset.cardId = s.id;
    const stale = s.fields?.ragSummaryStale ? '<span class="stale-icon" title="Summary needs refresh">⚠</span>' : "";
    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true">⋮⋮</span>
      <div class="outline-body">
        <h4>${esc(s.title)} ${stale}</h4>
        <p class="muted">${esc(s.fields?.shortDescription || s.fields?.ragSummary || "")}</p>
      </div>
    `;
    li.addEventListener("dragstart", outlineDragStart);
    li.addEventListener("dragover", outlineDragOver);
    li.addEventListener("drop", outlineDrop);
    li.addEventListener("dragend", outlineDragEnd);
    li.addEventListener("click", e => {
      if (e.target.closest(".drag-handle")) return;
      switchView("graph");
      openCardEditor(s.id);
    });
    els.outlineList.appendChild(li);
    const nextId = scenes[i + 1]?.id || null;
    els.outlineList.appendChild(makePlusButton(s.id, nextId));
  }
}

function makePlusButton(beforeSceneId, afterSceneId) {
  const wrap = document.createElement("li");
  wrap.className = "outline-plus";
  const btn = document.createElement("button");
  btn.className = "ghost small";
  btn.textContent = "+ Suggest scene here";
  btn.addEventListener("click", () => handleScenePlus(beforeSceneId, afterSceneId));
  wrap.appendChild(btn);
  return wrap;
}

async function handleScenePlus(beforeSceneId, afterSceneId) {
  if (!isConfigured()) {
    if (confirm("No LLM provider configured. Open Settings?")) openSettingsModal();
    return;
  }
  setLlmStatus("Generating scene proposal…");
  let gen;
  try {
    gen = await generateScene(state, { beforeSceneId, afterSceneId });
  } catch (e) {
    setLlmStatus("");
    alert("Scene generation failed: " + e.message);
    return;
  }
  setLlmStatus("");
  if (!gen) return;
  openSceneProposalModal(gen, {
    onAccept: async (edited) => {
      const position = beforeSceneId ? { afterId: beforeSceneId } : (afterSceneId ? { beforeId: afterSceneId } : null);
      const newId = await insertGeneratedScene(state, projectId, edited, position);
      await touchProject();
      renderOutline();
      rebuildGraphElements();
      updateRefreshNudge();
      switchView("graph");
      openCardEditor(newId);
    }
  });
}

let dragSourceId = null;
function outlineDragStart(e) {
  dragSourceId = e.currentTarget.dataset.cardId;
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
}
function outlineDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const target = e.currentTarget;
  if (target.dataset.cardId === dragSourceId) return;
  const rect = target.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  target.classList.toggle("drop-before", before);
  target.classList.toggle("drop-after", !before);
}
function outlineDragEnd() {
  document.querySelectorAll(".outline-item").forEach(li => {
    li.classList.remove("dragging", "drop-before", "drop-after");
  });
  dragSourceId = null;
}
async function outlineDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  const targetId = target.dataset.cardId;
  if (!dragSourceId || targetId === dragSourceId) { outlineDragEnd(); return; }
  const rect = target.getBoundingClientRect();
  const before = (e.clientY - rect.top) < rect.height / 2;
  await reorderScenes(dragSourceId, targetId, before);
  outlineDragEnd();
  renderOutline();
}
async function reorderScenes(movingId, targetId, before) {
  const ordered = [...state.cards.values()]
    .filter(c => c.type === "scene" && !c.archived)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const moving = ordered.find(c => c.id === movingId);
  if (!moving) return;
  const without = ordered.filter(c => c.id !== movingId);
  const targetIdx = without.findIndex(c => c.id === targetId);
  if (targetIdx < 0) return;
  const insertAt = before ? targetIdx : targetIdx + 1;
  without.splice(insertAt, 0, moving);
  // Reassign sequential order
  const audit = [];
  for (let i = 0; i < without.length; i++) {
    const card = without[i];
    if (card.order !== i) {
      const old = card.order;
      card.order = i;
      await updateDoc(
        doc(db, "users", state.user.uid, "projects", projectId, "cards", card.id),
        { order: i, updatedAt: serverTimestamp() }
      );
      audit.push({ entityType: "card", entityId: card.id, field: "order", oldValue: old, newValue: i });
    }
  }
  if (audit.length) await logAudit(state.user.uid, projectId, audit, state.project);
  await touchProject();
  updateRefreshNudge();
}

// --- Archive ---

function renderArchive() {
  els.archiveList.innerHTML = "";
  const archived = [...state.cards.values()].filter(c => c.archived);
  if (archived.length === 0) {
    show(els.archiveEmpty);
    return;
  }
  hide(els.archiveEmpty);
  for (const c of archived) {
    const li = document.createElement("li");
    li.className = "archive-item";
    li.innerHTML = `
      <span class="badge ${c.type}">${c.type}</span>
      <span class="title">${esc(c.title)}</span>
      <button class="ghost small restore">Restore</button>
    `;
    li.querySelector(".restore").addEventListener("click", () => restoreCard(c.id));
    els.archiveList.appendChild(li);
  }
}

// --- Helpers ---

async function touchProject() {
  const ref = doc(db, "users", state.user.uid, "projects", projectId);
  await updateDoc(ref, { updatedAt: serverTimestamp() });
}

function flashStatus(msg) {
  let bar = document.getElementById("statusBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "statusBar";
    bar.className = "status-bar";
    document.body.appendChild(bar);
  }
  bar.textContent = msg;
  show(bar);
}
function clearStatus() {
  const bar = document.getElementById("statusBar");
  if (bar) hide(bar);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function attr(s) { return esc(s); }

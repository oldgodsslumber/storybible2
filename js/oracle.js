// Oracle tab — roll on tables extracted from the Modern Random Roll Tables doc.
// Data lives in oracle-data.js (auto-generated).

import { ORACLE } from "./oracle-data.js";

const HISTORY_LIMIT = 30;
let history = [];          // [{tableName, result, ts}]
let activeTableId = null;  // sectionId|name

function tableId(t) { return `${t.sectionId}|${t.name}`; }

function sectionsGrouped() {
  const groups = new Map();
  for (const t of ORACLE.tables) {
    if (!groups.has(t.sectionId)) {
      groups.set(t.sectionId, { id: t.sectionId, title: t.section, tables: [] });
    }
    groups.get(t.sectionId).tables.push(t);
  }
  // Sort sections by numeric id where possible
  return [...groups.values()].sort((a, b) => {
    const an = parseInt(a.id, 10);
    const bn = parseInt(b.id, 10);
    if (an !== bn) return an - bn;
    return a.id.localeCompare(b.id);
  });
}

export function renderOracle(container) {
  const sectionListEl = container.querySelector("#oracleSectionList");
  const searchEl = container.querySelector("#oracleSearch");
  const panelEl = container.querySelector("#oracleTablePanel");
  const emptyEl = container.querySelector("#oracleEmpty");
  const historyEl = container.querySelector("#oracleHistory");

  function renderSidebar(filter) {
    sectionListEl.innerHTML = "";
    const q = (filter || "").trim().toLowerCase();
    const groups = sectionsGrouped();
    let anyVisible = false;
    for (const g of groups) {
      const filteredTables = g.tables.filter(t =>
        !q || t.name.toLowerCase().includes(q) || g.title.toLowerCase().includes(q)
      );
      if (filteredTables.length === 0) continue;
      anyVisible = true;
      const sec = document.createElement("section");
      sec.className = "oracle-section";
      sec.innerHTML = `
        <h3>${esc(g.id)}. ${esc(g.title)}</h3>
        <ul></ul>
      `;
      const ul = sec.querySelector("ul");
      for (const t of filteredTables) {
        const li = document.createElement("li");
        const id = tableId(t);
        li.className = "oracle-table-link" + (id === activeTableId ? " active" : "");
        li.innerHTML = `
          <span class="oracle-table-name">${esc(t.name)}</span>
          <span class="oracle-table-dice muted small">${esc(t.dice)}</span>
        `;
        li.addEventListener("click", () => {
          activeTableId = id;
          renderSidebar(searchEl.value);
          renderTablePanel(t);
        });
        ul.appendChild(li);
      }
      sectionListEl.appendChild(sec);
    }
    if (!anyVisible) {
      sectionListEl.innerHTML = `<p class="muted small">No tables match "${esc(q)}".</p>`;
    }
  }

  function renderTablePanel(t) {
    emptyEl.classList.add("hidden");
    panelEl.classList.remove("hidden");
    panelEl.innerHTML = `
      <header class="oracle-table-header">
        <div>
          <h3>${esc(t.name)}</h3>
          <p class="muted small">${esc(t.section)} · ${esc(t.dice)}${t.parentRoll ? ` · sub-table ${esc(t.parentRoll)}` : ""}</p>
        </div>
        <button class="primary roll-btn">🎲 Roll</button>
      </header>
      <div class="oracle-result hidden" id="oracleResult"></div>
      <details class="oracle-entries">
        <summary>Show all ${t.entries.length} entries</summary>
        <ol class="oracle-entry-list"></ol>
      </details>
    `;
    const list = panelEl.querySelector(".oracle-entry-list");
    t.entries.forEach((row, idx) => {
      const li = document.createElement("li");
      li.value = idx + 1;
      li.textContent = renderEntryText(row);
      list.appendChild(li);
    });
    panelEl.querySelector(".roll-btn").addEventListener("click", () => rollOn(t));
  }

  function rollOn(t) {
    const sides = parseInt((t.dice.match(/d(\d+)/) || ["", "20"])[1], 10);
    const cols = t.columns || 1;
    const rolledValues = [];
    const rolledIndices = [];
    for (let c = 0; c < cols; c++) {
      const r = 1 + Math.floor(Math.random() * Math.min(sides, t.entries.length));
      rolledIndices.push(r);
      const row = t.entries[r - 1];
      if (row && row[c] !== undefined) rolledValues.push(row[c]);
      else if (row) rolledValues.push(row[0] ?? "");
    }
    const combined = cols > 1 ? rolledValues.join(" ") : rolledValues[0];
    const detail = cols > 1
      ? rolledIndices.map((r, c) => `${r}: ${rolledValues[c]}`).join("  +  ")
      : `${rolledIndices[0]}: ${rolledValues[0]}`;

    const resultEl = panelEl.querySelector("#oracleResult");
    resultEl.classList.remove("hidden");
    resultEl.innerHTML = `
      <div class="oracle-result-main">${esc(combined)}</div>
      <div class="oracle-result-detail muted small">${esc(detail)}</div>
      <button class="ghost small copy-result">Copy</button>
    `;
    resultEl.querySelector(".copy-result").addEventListener("click", () => {
      navigator.clipboard?.writeText(combined).catch(() => {});
    });

    history.unshift({ tableName: t.name, section: t.section, result: combined, detail, ts: Date.now() });
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    renderHistory();
  }

  function renderHistory() {
    if (history.length === 0) {
      historyEl.innerHTML = "";
      return;
    }
    historyEl.innerHTML = `<h4>Recent rolls</h4>`;
    const ul = document.createElement("ul");
    ul.className = "oracle-history-list";
    for (const h of history) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="oracle-history-main">${esc(h.result)}</div>
        <div class="muted small">${esc(h.tableName)} · ${esc(h.detail)}</div>
      `;
      ul.appendChild(li);
    }
    historyEl.appendChild(ul);
  }

  searchEl.addEventListener("input", () => renderSidebar(searchEl.value));
  renderSidebar("");
  renderHistory();
}

function renderEntryText(row) {
  if (!Array.isArray(row)) return String(row || "");
  return row.filter(Boolean).join(" — ");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

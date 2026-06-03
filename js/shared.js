import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "../firebase-config.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export function signIn() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function signOutUser() {
  return signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function renderUserArea(container, user) {
  if (!container) return;
  if (user) {
    container.innerHTML = `
      <span class="user-email">${user.email}</span>
      <button id="signOutBtn" class="ghost small">Sign out</button>
    `;
    container.querySelector("#signOutBtn").addEventListener("click", () => signOutUser());
  } else {
    container.innerHTML = "";
  }
}

export function show(el) { el?.classList.remove("hidden"); }
export function hide(el) { el?.classList.add("hidden"); }

export function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString();
}

export const CARD_TYPES = ["character", "scene", "beat", "theme", "concept", "location", "arc"];

export const KANBAN_STAGES = [
  { id: "idea",     label: "Idea" },
  { id: "outlined", label: "Outlined" },
  { id: "drafted",  label: "Drafted" },
  { id: "revised",  label: "Revised" },
  { id: "done",     label: "Done" }
];

// Busy overlay used during LLM work. Returns { update, close, controller }.
// The controller is an AbortController whose signal can be passed to fetch().
export function openBusyOverlay(label) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay busy-overlay";
  overlay.innerHTML = `
    <div class="modal busy-modal">
      <div class="busy-spinner"></div>
      <p class="busy-label">${label || "Working…"}</p>
      <button class="ghost small busy-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);
  const controller = new AbortController();
  const labelEl = overlay.querySelector(".busy-label");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
  };
  overlay.querySelector(".busy-cancel").addEventListener("click", () => {
    controller.abort(new DOMException("User cancelled", "AbortError"));
    close();
  });
  return {
    update: (text) => { if (labelEl) labelEl.textContent = text; },
    close,
    controller,
    signal: controller.signal
  };
}

export function blankFieldsForType(type) {
  switch (type) {
    case "character":
      return { role: "", physicalDescription: "", age: "", history: [], traits: [], storyRoleSummary: null, storyRoleSummaryStale: false };
    case "scene":
      return { shortDescription: "", longDescription: "", ragSummary: null, ragSummaryStale: false, characterIds: [], locationIds: [], arcIds: [], kanbanStage: "idea", columnId: "", columnOrder: 0 };
    case "theme":
      return { description: "" };
    case "concept":
      // Named in-world thing: an event, organization, system, technology,
      // phenomenon, faction, etc. Distinct from a theme (an abstract idea
      // the story explores).
      return { description: "", summary: "", summaryStale: false };
    case "location":
      return { description: "" };
    case "arc":
      return { summary: "", summaryStale: false };
    case "beat":
      return {
        description: "",
        structurePosition: "",  // e.g. "Act 1 — Inciting Incident", "Midpoint", "Climax", "Save the Cat: Catalyst"
        order: 0,
        columnId: "",           // which outline column this beat belongs to
        columnOrder: 0,         // position within that column
        relatedSceneIds: [],
        relatedArcIds: [],
        summary: "",
        summaryStale: false
      };
    default:
      return {};
  }
}

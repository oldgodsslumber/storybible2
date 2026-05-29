import {
  auth, db, signIn, onAuthChange, renderUserArea, show, hide, formatDate
} from "./shared.js";
import { mountLlmConfigBanner } from "./settings.js?v=20260530";
import {
  collection, doc, getDocs, addDoc, query, where, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const els = {
  loading: document.getElementById("loading"),
  signedOut: document.getElementById("signedOut"),
  dashboard: document.getElementById("dashboard"),
  newProjectView: document.getElementById("newProjectView"),
  userArea: document.getElementById("userArea"),
  signInBtn: document.getElementById("signInBtn"),
  newProjectBtn: document.getElementById("newProjectBtn"),
  cancelNewProjectBtn: document.getElementById("cancelNewProjectBtn"),
  createProjectBtn: document.getElementById("createProjectBtn"),
  ideaDump: document.getElementById("ideaDump"),
  projectTitle: document.getElementById("projectTitle"),
  projectList: document.getElementById("projectList"),
  emptyState: document.getElementById("emptyState"),
};

let currentUser = null;

els.signInBtn.addEventListener("click", () => signIn().catch(err => alert(err.message)));
els.newProjectBtn.addEventListener("click", () => goNewProject());
els.cancelNewProjectBtn.addEventListener("click", () => goDashboard());
els.createProjectBtn.addEventListener("click", createProject);

console.log("[init] dashboard.js wiring", {
  hasSignInBtn: !!els.signInBtn,
  hasNewProjectBtn: !!els.newProjectBtn,
  hasCreateProjectBtn: !!els.createProjectBtn,
  hasIdeaDump: !!els.ideaDump,
  hasProjectTitle: !!els.projectTitle
});

onAuthChange(async user => {
  currentUser = user;
  renderUserArea(els.userArea, user);
  hide(els.loading);
  if (!user) {
    hide(els.dashboard);
    hide(els.newProjectView);
    show(els.signedOut);
    return;
  }
  hide(els.signedOut);
  mountLlmConfigBanner();
  await goDashboard();
});

function goNewProject() {
  hide(els.dashboard);
  hide(els.signedOut);
  els.ideaDump.value = "";
  els.projectTitle.value = "";
  show(els.newProjectView);
  els.projectTitle.focus();
}

async function goDashboard() {
  hide(els.newProjectView);
  show(els.dashboard);
  await loadProjects();
}

async function loadProjects() {
  els.projectList.innerHTML = "";
  const projectsRef = collection(db, "users", currentUser.uid, "projects");
  const q = query(projectsRef, where("archived", "==", false), orderBy("updatedAt", "desc"));
  let snap;
  try {
    snap = await getDocs(q);
  } catch (err) {
    // Likely missing composite index on first run — fall back to unordered read.
    console.warn("Falling back to unordered project read:", err.message);
    snap = await getDocs(projectsRef);
  }
  const items = [];
  snap.forEach(d => {
    const data = d.data();
    if (data.archived) return;
    items.push({ id: d.id, ...data });
  });
  items.sort((a, b) => {
    const at = a.updatedAt?.toMillis?.() ?? 0;
    const bt = b.updatedAt?.toMillis?.() ?? 0;
    return bt - at;
  });
  if (items.length === 0) {
    show(els.emptyState);
    return;
  }
  hide(els.emptyState);
  for (const p of items) {
    const li = document.createElement("li");
    li.className = "project-card";
    li.innerHTML = `
      <a class="project-link" href="./project.html?id=${encodeURIComponent(p.id)}">
        <h3>${escapeHtml(p.title || "(untitled)")}</h3>
        <p class="logline muted">${escapeHtml(p.logline || "")}</p>
        <p class="meta muted small">Updated ${formatDate(p.updatedAt)}</p>
      </a>
    `;
    els.projectList.appendChild(li);
  }
}

async function createProject() {
  console.log("[dashboard] Create Project clicked");
  const title = els.projectTitle.value.trim();
  if (!title) {
    alert("Give the project a title.");
    return;
  }
  const themeText = els.ideaDump.value.trim();
  console.log("[dashboard] createProject", { titleChars: title.length, themeChars: themeText.length });
  if (!themeText) {
    const ok = confirm(`Heads up: you haven't typed anything in the "What's your story about?" textarea.\n\nWithout idea-dump text, the LLM has nothing to extract — you'll land on an empty project. You can paste an idea dump into the side panel later and click "Parse with LLM" instead.\n\nCreate empty project anyway?`);
    if (!ok) return;
  }
  console.log("[dashboard] currentUser:", currentUser?.uid || "(null)");
  if (!currentUser) {
    alert("You're not signed in. Refresh the page and sign in again.");
    return;
  }
  els.createProjectBtn.disabled = true;
  try {
    console.log("[dashboard] building Firestore ref...");
    const projectsRef = collection(db, "users", currentUser.uid, "projects");
    const payload = {
      title,
      logline: "",
      themeText,
      pillars: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      auditTrail: [],
      lastRefreshAt: null,
      archived: false
    };
    console.log("[dashboard] calling addDoc (15s timeout if rules block)...");
    const docRef = await Promise.race([
      addDoc(projectsRef, payload),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("addDoc timed out after 15s. Most likely cause: Firestore rules aren't published. Open the Firebase Console → Firestore Database → Rules and paste in the contents of firestore.rules, then click Publish.")),
        15000
      ))
    ]);
    console.log("[dashboard] addDoc resolved with id:", docRef.id);
    console.log("[dashboard] redirecting to project.html...");
    window.location.href = `./project.html?id=${encodeURIComponent(docRef.id)}&isNew=1`;
  } catch (err) {
    console.error("[dashboard] createProject failed:", err);
    alert("Could not create project:\n\n" + (err?.message || err));
    els.createProjectBtn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

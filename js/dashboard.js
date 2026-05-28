import {
  auth, db, signIn, onAuthChange, renderUserArea, show, hide, formatDate
} from "./shared.js";
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
  const title = els.projectTitle.value.trim();
  if (!title) {
    alert("Give the project a title.");
    return;
  }
  const themeText = els.ideaDump.value.trim();
  els.createProjectBtn.disabled = true;
  try {
    const projectsRef = collection(db, "users", currentUser.uid, "projects");
    const docRef = await addDoc(projectsRef, {
      title,
      logline: "",
      themeText,
      pillars: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      auditTrail: [],
      lastRefreshAt: null,
      archived: false
    });
    window.location.href = `./project.html?id=${encodeURIComponent(docRef.id)}&isNew=1`;
  } catch (err) {
    alert("Could not create project: " + err.message);
    els.createProjectBtn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

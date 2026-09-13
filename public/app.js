// ---------- helpers ----------

const $ = (id) => document.getElementById(id);
const inr = (n) => "₹" + Number(n).toLocaleString("en-IN");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `request failed (${res.status})`);
  return json;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function truncate(s, n = 40) {
  return s && s.length > n ? s.slice(0, n) + "…" : s;
}

// UTF-8 safe base64 helpers, used only for the client-side "share link"
// feature below — this never touches the SDK's own encoding.
function b64encode(str) {
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}
function b64decode(str) {
  return decodeURIComponent(atob(str).split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
}

function copyToClipboard(text, label = "Copied") {
  navigator.clipboard?.writeText(text).then(
    () => toast(`${label} to clipboard.`),
    () => toast("Could not copy — clipboard access blocked.", true)
  );
}

// ---------- theme toggle (visual only — no cryptography here) ----------

const THEME_KEY = "cool-demo-theme";
const themeToggle = $("theme-toggle");
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "light" ? "☀️" : "🌙";
  themeToggle.setAttribute("aria-pressed", String(theme === "light"));
}
applyTheme(localStorage.getItem(THEME_KEY) || "dark");
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---------- sound toggle (tiny WebAudio blips, no external files) ----------

const SOUND_KEY = "cool-demo-sound";
const soundToggle = $("sound-toggle");
let soundOn = localStorage.getItem(SOUND_KEY) === "on";
function renderSoundBtn() {
  soundToggle.textContent = soundOn ? "🔊" : "🔈";
  soundToggle.setAttribute("aria-pressed", String(soundOn));
}
renderSoundBtn();
soundToggle.addEventListener("click", () => {
  soundOn = !soundOn;
  localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
  renderSoundBtn();
  if (soundOn) beep(660, 0.08);
});

let audioCtx = null;
function beep(freq = 440, dur = 0.1, type = "sine") {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch {
    /* audio is a nice-to-have, never block on it */
  }
}

// ---------- health pill ----------

async function loadHealth() {
  const pill = $("health-pill");
  const text = $("health-text");
  try {
    const { ok, mode } = await api("/api/health");
    pill.dataset.state = ok ? "ok" : "down";
    text.textContent = ok ? `SDK ready · ${mode}` : `attestation issue · ${mode}`;
  } catch {
    pill.dataset.state = "down";
    text.textContent = "server unreachable";
  }
}

// ---------- state ----------

let originalEvidence = null; // clean copy tied to the last sealed/loaded receipt (for "reset tampering")
let workingEvidence = null; // whatever is currently in the textarea / being verified
let activeRecordId = null;
let activeDigest = null; // the entry.digest returned alongside the evidence, for the "Binding" row
const scoreHistory = []; // session-local score trail for the sparkline (this run's live estimates)
const compareSelection = []; // up to 2 recordIds picked via Alt+click

// ---------- 1 · sliders + live gauge ----------

const nameInput = $("in-name");
const incomeInput = $("in-income");
const loanInput = $("in-loan");
const purposeInput = $("in-purpose");

function syncSliderLabels() {
  $("income-out").textContent = inr(incomeInput.value);
  $("loan-out").textContent = inr(loanInput.value);
}

function currentApplicant() {
  return {
    name: nameInput.value || "Applicant",
    income: Number(incomeInput.value) || 0,
    loanAmount: Number(loanInput.value) || 1,
    purpose: purposeInput.value,
  };
}

const GAUGE_R = 27;
const GAUGE_CIRC = 2 * Math.PI * GAUGE_R;
const gaugeArc = $("gauge-arc");
gaugeArc.style.strokeDasharray = `${GAUGE_CIRC}`;
gaugeArc.style.strokeDashoffset = `${GAUGE_CIRC}`;

function scoreColor(score) {
  if (score >= 0.55) return getComputedStyle(document.documentElement).getPropertyValue("--green").trim();
  if (score >= 0.4) return getComputedStyle(document.documentElement).getPropertyValue("--amber").trim();
  return getComputedStyle(document.documentElement).getPropertyValue("--red").trim();
}

function updateGauge(score) {
  const offset = GAUGE_CIRC * (1 - score);
  gaugeArc.style.strokeDashoffset = String(offset);
  gaugeArc.style.stroke = scoreColor(score);
  $("gauge-num").textContent = score.toFixed(2);
}

function drawSparkline() {
  const canvas = $("sparkline-canvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (scoreHistory.length < 2) {
    ctx.strokeStyle = "rgba(166,163,196,0.3)";
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    return;
  }
  const recent = scoreHistory.slice(-40);
  const step = w / Math.max(recent.length - 1, 1);
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "#5d7cf7");
  grad.addColorStop(1, "#c65fe0");
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  recent.forEach((s, i) => {
    const x = i * step;
    const y = h - s * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  // dot on last point
  const lastX = (recent.length - 1) * step;
  const lastY = h - recent[recent.length - 1] * h;
  ctx.fillStyle = "#c65fe0";
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 120);
}

async function runPreview() {
  try {
    const result = await api("/api/preview", currentApplicant());
    updateGauge(result.score);
    scoreHistory.push(result.score);
    drawSparkline();
    const decisionEl = $("live-decision");
    decisionEl.textContent = `${result.decision} · score ${result.score}`;
    decisionEl.className = "live-estimate__decision " + result.decision;
  } catch {
    /* preview is best-effort; ignore transient errors */
  }
}

[nameInput, incomeInput, loanInput].forEach((el) => el.addEventListener("input", () => {
  syncSliderLabels();
  schedulePreview();
}));
purposeInput.addEventListener("change", schedulePreview);

// ---------- 2 · decision summary ----------

function renderSummary(entry) {
  $("empty-state").classList.add("hidden");
  $("receipt-view").classList.remove("hidden");

  $("rv-decision").textContent = entry.decision;
  $("rv-decision").className = "summary-row__value " + entry.decision;
  $("rv-score").textContent = entry.score;
  $("rv-model").textContent = `${entry.model.id}@${entry.model.version}`;
  $("rv-recordid").textContent = entry.recordId;
  $("rv-binding").textContent = truncate(entry.digest, 44);
  activeDigest = entry.digest;
}

$("rv-recordid").addEventListener("click", () => activeRecordId && copyToClipboard(activeRecordId, "Record ID"));
$("rv-binding").addEventListener("click", () => activeDigest && copyToClipboard(activeDigest, "Binding digest"));

$("copy-json-btn").addEventListener("click", () => {
  if (!workingEvidence) return toast("Seal a decision first.", true);
  copyToClipboard(JSON.stringify(workingEvidence, null, 2), "Receipt JSON");
});

$("download-json-btn").addEventListener("click", () => {
  if (!workingEvidence) return toast("Seal a decision first.", true);
  const blob = new Blob([JSON.stringify(workingEvidence, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cool-receipt-${activeRecordId || "evidence"}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// The whole receipt travels in the URL fragment itself (never sent to any
// server), so a shared link still verifies correctly even if it lands on a
// different serverless instance than the one that sealed it.
$("share-btn").addEventListener("click", () => {
  if (!workingEvidence) return toast("Seal a decision first.", true);
  const encoded = b64encode(JSON.stringify(workingEvidence));
  const url = `${location.origin}${location.pathname}#r=${encoded}`;
  copyToClipboard(url, "Share link");
  const note = $("share-note");
  note.style.display = "block";
  clearTimeout(note._hideTimer);
  note._hideTimer = setTimeout(() => (note.style.display = "none"), 6000);
});

async function loadSharedReceiptFromHash() {
  const match = location.hash.match(/r=([^&]+)/);
  if (!match) return false;
  try {
    const evidence = JSON.parse(b64decode(match[1]));
    setWorkingEvidence(evidence, { refreshTree: true });
    originalEvidence = JSON.parse(JSON.stringify(evidence));
    $("empty-state").classList.add("hidden");
    $("receipt-view").classList.remove("hidden");
    $("rv-decision").textContent = "(from shared link)";
    $("rv-score").textContent = "—";
    $("rv-model").textContent = "—";
    $("rv-recordid").textContent = "—";
    $("rv-binding").textContent = "—";
    advancedPanel.classList.add("open");
    $("advanced-body").classList.remove("hidden");
    renderReceiptTree();
    await runVerify();
    toast("Loaded a shared receipt from the link — verified below.");
    return true;
  } catch {
    toast("That share link's receipt data looks corrupted.", true);
    return false;
  }
}

// ---------- JSON tree with click-to-tamper leaves (advanced panel) ----------

function pathKey(path) {
  return JSON.stringify(path);
}

function buildTree(node, path, container) {
  if (Array.isArray(node)) {
    const ul = document.createElement("ul");
    node.forEach((child, i) => {
      const li = document.createElement("li");
      renderEntry(li, `[${i}]`, child, [...path, i]);
      ul.appendChild(li);
    });
    container.appendChild(ul);
  } else if (node && typeof node === "object") {
    const ul = document.createElement("ul");
    for (const [k, v] of Object.entries(node)) {
      const li = document.createElement("li");
      renderEntry(li, k, v, [...path, k]);
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }
}

function renderEntry(li, label, value, path) {
  const keySpan = document.createElement("span");
  keySpan.className = "key";
  keySpan.textContent = `${label}: `;
  li.appendChild(keySpan);
  li.dataset.searchText = (label + " " + (typeof value === "object" ? "" : String(value))).toLowerCase();

  if (value === null || value === undefined) {
    const span = document.createElement("span");
    span.className = "val const";
    span.textContent = "null";
    li.appendChild(span);
  } else if (typeof value === "string") {
    const span = document.createElement("span");
    span.className = "val leaf";
    span.textContent = `"${truncate(value, 60)}"`;
    span.title = "Click to flip one character and see which checks fail";
    span.dataset.path = pathKey(path);
    li.appendChild(span);
  } else if (typeof value === "number" || typeof value === "boolean") {
    const span = document.createElement("span");
    span.className = "val const";
    span.textContent = String(value);
    li.appendChild(span);
  } else {
    buildTree(value, path, li);
  }
}

function renderReceiptTree() {
  const root = $("tree-root");
  root.innerHTML = "";
  if (!workingEvidence) return;
  buildTree(workingEvidence, [], root);
  root.querySelectorAll(".val.leaf").forEach((el) => {
    el.addEventListener("click", () => onLeafClick(el));
  });
  markTamperedLeaves();
  applyTreeSearch();
}

function markTamperedLeaves() {
  if (!originalEvidence) return;
  const root = $("tree-root");
  root.querySelectorAll(".val.leaf").forEach((el) => {
    const path = JSON.parse(el.dataset.path);
    let a = originalEvidence, b = workingEvidence;
    for (const key of path) { a = a?.[key]; b = b?.[key]; }
    el.classList.toggle("tampered", a !== b);
  });
}

async function onLeafClick(el) {
  const path = JSON.parse(el.dataset.path);
  el.style.opacity = "0.5";
  try {
    const { evidence } = await api("/api/tamper", { evidence: workingEvidence, path });
    setWorkingEvidence(evidence, { refreshTree: true });
    await runVerify();
    beep(220, 0.12, "sawtooth");
  } catch (err) {
    toast(err.message, true);
  } finally {
    el.style.opacity = "";
  }
}

// ---------- tree search filter ----------

$("tree-search").addEventListener("input", () => applyTreeSearch());

function applyTreeSearch() {
  const q = $("tree-search").value.trim().toLowerCase();
  const root = $("tree-root");
  root.querySelectorAll("li").forEach((li) => {
    if (!q) return li.classList.remove("match-hidden");
    const matchesSelf = (li.dataset.searchText || "").includes(q);
    const matchesChild = !!li.querySelector(`[data-search-hit]`);
    li.classList.toggle("match-hidden", !matchesSelf && !li.textContent.toLowerCase().includes(q));
  });
}

// ---------- advanced toggle ----------

const advancedPanel = $("advanced-panel");
$("advanced-toggle").addEventListener("click", () => {
  const open = advancedPanel.classList.toggle("open");
  $("advanced-body").classList.toggle("hidden", !open);
  if (open) renderReceiptTree();
});

$("reset-btn").addEventListener("click", () => {
  if (!originalEvidence) return;
  setWorkingEvidence(JSON.parse(JSON.stringify(originalEvidence)), { refreshTree: true });
  $("verdict").classList.add("hidden");
  toast("Tampering reset to the originally sealed receipt.");
});

// ---------- raw paste toggle ----------

$("raw-advanced-toggle").addEventListener("click", () => {
  const panel = $("raw-advanced");
  const open = panel.classList.toggle("open");
  $("raw-advanced-body").classList.toggle("hidden", !open);
});

// ---------- shared working-evidence <-> textarea sync ----------

const rawInput = $("raw-input");

function setWorkingEvidence(evidence, { refreshTree = false } = {}) {
  workingEvidence = evidence;
  rawInput.value = JSON.stringify(evidence, null, 2);
  if (refreshTree) renderReceiptTree(); // keep tree data attached even if hidden, cheap enough
}

function readEvidenceFromTextarea() {
  const raw = rawInput.value.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // signals invalid JSON, as distinct from empty
  }
}

// ---------- 3 · verify / tamper & re-verify ----------

function collectLeafPaths(node, path = [], out = []) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => collectLeafPaths(child, [...path, i], out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collectLeafPaths(v, [...path, k], out);
  } else if (typeof node === "string" && node.length > 0) {
    out.push(path);
  }
  return out;
}

// Plain-language labels for each of the seven check domains, so a
// non-technical person can see at a glance what each one actually means.
const CHECK_META = {
  binding: {
    label: "Data integrity",
    icon: { pass: "✓", fail: "✕" },
    text: {
      pass: "The applicant data and outcome still match what was originally sealed.",
      fail: "The applicant data or outcome no longer matches what was sealed — something was edited.",
    },
  },
  signature: {
    label: "Signature",
    icon: { pass: "✓", fail: "✕" },
    text: {
      pass: "Signed by a recognized key, with both a post-quantum and a classical signature.",
      fail: "The signature no longer checks out — this receipt wasn't (or is no longer) validly signed.",
    },
  },
  inclusion: {
    label: "Ledger record",
    icon: { pass: "✓", fail: "✕" },
    text: {
      pass: "Found in its expected place in the tamper-evident log.",
      fail: "No longer matches its recorded place in the tamper-evident log.",
    },
  },
  witnesses: {
    label: "Independent witnesses",
    icon: { pass: "✓", fail: "✕", absent: "–" },
    text: {
      pass: "Confirmed by outside observers, not just the issuer.",
      fail: "An independent witness's confirmation failed.",
      absent: "Not used in this local demo.",
    },
  },
  attestation: {
    label: "Hardware attestation",
    icon: { pass: "✓", fail: "✕", simulated: "ⓘ" },
    text: {
      pass: "Confirmed to have run inside genuine secure hardware.",
      fail: "The hardware attestation failed to check out.",
      simulated: "Simulated for this demo — no real secure hardware was involved.",
    },
  },
  enclave: {
    label: "Enclave measurement",
    icon: { pass: "✓", fail: "✕", simulated: "ⓘ" },
    text: {
      pass: "The signing key is confirmed to live inside that secure hardware.",
      fail: "The enclave measurement check failed.",
      simulated: "Simulated for this demo — no real secure hardware was involved.",
    },
  },
  anchor: {
    label: "Public anchor",
    icon: { pass: "✓", fail: "✕", absent: "–" },
    text: {
      pass: "Published to a public, third-party ledger.",
      fail: "The public anchor check failed.",
      absent: "Not used in this local demo.",
    },
  },
};

function renderVerdict(body) {
  $("verdict").classList.remove("hidden");

  const banner = $("result-banner");
  banner.dataset.ok = String(body.ok);
  $("result-icon").textContent = body.ok ? "✓" : "✕";
  $("result-headline").textContent = body.ok ? "This receipt is valid" : "This receipt has been tampered with";
  $("result-sub").textContent = body.ok
    ? "Every check below confirms nothing has changed since it was sealed."
    : "At least one check below no longer matches — see which ones flagged it.";

  const list = $("check-list");
  list.innerHTML = "";
  for (const [domain, check] of Object.entries(body.checks || {})) {
    const meta = CHECK_META[domain] || { label: domain, icon: {}, text: {} };
    const status = check.status;
    const li = document.createElement("li");
    li.dataset.status = status;
    li.innerHTML = `
      <span class="check-icon">${meta.icon[status] ?? "?"}</span>
      <span class="check-body">
        <span class="check-label">${meta.label}</span>
        <span class="check-desc">${meta.text[status] || check.detail || ""}</span>
      </span>`;
    list.appendChild(li);
  }

  const reasons = $("verdict-reasons");
  reasons.innerHTML = "";
  for (const reason of body.reasons || []) {
    const li = document.createElement("li");
    li.textContent = reason;
    reasons.appendChild(li);
  }

  if (body.ok) {
    beep(880, 0.12);
    fireConfetti();
  } else {
    beep(180, 0.2, "square");
  }
}

async function runVerify() {
  const evidence = readEvidenceFromTextarea();
  if (evidence === null) return toast("Run an AI decision on the left, or paste a receipt JSON here first.", true);
  if (evidence === undefined) return toast("That doesn't look like valid JSON.", true);
  workingEvidence = evidence;

  const btn = $("verify-btn");
  btn.disabled = true;
  try {
    const body = await api("/api/verify", { evidence });
    renderVerdict(body);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function runTamperAndVerify() {
  const evidence = readEvidenceFromTextarea();
  if (evidence === null) return toast("Run an AI decision on the left, or paste a receipt JSON here first.", true);
  if (evidence === undefined) return toast("That doesn't look like valid JSON.", true);

  const leaves = collectLeafPaths(evidence);
  if (leaves.length === 0) return toast("No text/hash fields found to tamper with in this JSON.", true);
  const path = leaves[Math.floor(Math.random() * leaves.length)];

  const btn = $("tamper-btn");
  btn.disabled = true;
  try {
    const { evidence: tampered } = await api("/api/tamper", { evidence, path });
    setWorkingEvidence(tampered, { refreshTree: true });
    const body = await api("/api/verify", { evidence: tampered });
    renderVerdict(body);
    toast(`Flipped a character in "${path[path.length - 1]}" — re-verified.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$("verify-btn").addEventListener("click", runVerify);
$("tamper-btn").addEventListener("click", runTamperAndVerify);

// re-render the (hidden or visible) tree whenever the textarea is hand-edited
let textareaTimer = null;
rawInput.addEventListener("input", () => {
  clearTimeout(textareaTimer);
  textareaTimer = setTimeout(() => {
    const evidence = readEvidenceFromTextarea();
    if (evidence && typeof evidence === "object") {
      workingEvidence = evidence;
      if (!advancedPanel.classList.contains("hidden")) renderReceiptTree();
    }
  }, 250);
});

// ---------- sealing a new decision (animated Seal → Log → Verify pipeline) ----------

const explainerSteps = {
  seal: document.querySelector('.explainer__step[data-step="seal"]'),
  log: document.querySelector('.explainer__step[data-step="log"]'),
  verify: document.querySelector('.explainer__step[data-step="verify"]'),
};

function setStepState(name, state) {
  const el = explainerSteps[name];
  if (!el) return;
  el.classList.remove("active", "done");
  const indicator = el.querySelector(".step-indicator");
  indicator.innerHTML = "";
  if (state === "active") {
    el.classList.add("active");
    const spinner = document.createElement("span");
    spinner.className = "step-spinner";
    indicator.appendChild(spinner);
  } else if (state === "done") {
    el.classList.add("done");
    indicator.textContent = "✓";
  }
}

function resetPipeline() {
  ["seal", "log", "verify"].forEach((s) => setStepState(s, "idle"));
}

// This mirrors the three named phases described in the README/deck — the
// actual work all happens inside the single real cool.record() call on the
// server; we only stage the *visual* handoff between phases here, honestly
// (each step still waits for the real request before turning green).
async function animatePipeline(requestPromise) {
  resetPipeline();
  setStepState("seal", "active");
  await wait(260);
  setStepState("seal", "done");
  setStepState("log", "active");
  await wait(220);
  const result = await requestPromise; // the real cool.record() round trip
  setStepState("log", "done");
  setStepState("verify", "active");
  await wait(200);
  setStepState("verify", "done");
  return result;
}

function showReceipt(entry) {
  originalEvidence = entry.evidence;
  activeRecordId = entry.recordId;
  setWorkingEvidence(JSON.parse(JSON.stringify(entry.evidence)), { refreshTree: true });
  renderSummary(entry);
  $("verdict").classList.add("hidden");
  highlightActiveHistory();
}

$("apply-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const applyBtn = $("apply-btn");
  applyBtn.disabled = true;
  applyBtn.textContent = "Sealing…";
  try {
    const entry = await animatePipeline(api("/api/apply", currentApplicant()));
    showReceipt(entry);
    await loadHistory();
    toast("Decision sealed as CooL evidence.");
    beep(520, 0.1);
  } catch (err) {
    resetPipeline();
    toast("Could not seal this decision: " + err.message, true);
    beep(180, 0.2, "square");
  } finally {
    applyBtn.disabled = false;
    applyBtn.textContent = "Run AI decision";
  }
});

// ---------- history ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadHistory() {
  try {
    const { receipts } = await api("/api/history");
    const list = $("history-list");
    $("history-count").textContent = receipts.length ? `(${receipts.length})` : "";
    if (receipts.length === 0) {
      list.innerHTML = `<li class="history__empty">Sealed receipts will show up here — click one to reload it.</li>`;
      return;
    }
    list.innerHTML = "";
    for (const r of receipts) {
      const li = document.createElement("li");
      li.className = "history__item"
        + (r.recordId === activeRecordId ? " active" : "")
        + (compareSelection.includes(r.recordId) ? " compare-selected" : "");
      li.dataset.id = r.recordId;
      li.innerHTML = `<span class="name">${escapeHtml(r.name)}</span><span class="badge ${r.decision}">${r.decision}</span>`;
      li.addEventListener("click", (ev) => {
        if (ev.altKey) return toggleCompareSelection(r.recordId);
        loadFromHistory(r.recordId);
      });
      list.appendChild(li);
    }
  } catch {
    /* non-fatal */
  }
}

async function loadFromHistory(recordId) {
  try {
    const entry = await api(`/api/receipt/${recordId}`);
    showReceipt(entry);
  } catch (err) {
    toast(err.message, true);
  }
}

function highlightActiveHistory() {
  document.querySelectorAll(".history__item").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === activeRecordId);
  });
}

$("history-clear").addEventListener("click", async () => {
  try {
    await api("/api/history/clear", {});
  } catch {
    /* endpoint may be a no-op if unsupported; still clear the view */
  }
  activeRecordId = null;
  originalEvidence = null;
  workingEvidence = null;
  $("receipt-view").classList.add("hidden");
  $("empty-state").classList.remove("hidden");
  $("verdict").classList.add("hidden");
  compareSelection.length = 0;
  await loadHistory();
  toast("Session history cleared.");
});

// ---------- compare (Alt+click two history rows) ----------

function toggleCompareSelection(recordId) {
  const idx = compareSelection.indexOf(recordId);
  if (idx >= 0) {
    compareSelection.splice(idx, 1);
  } else {
    compareSelection.push(recordId);
    if (compareSelection.length > 2) compareSelection.shift();
  }
  loadHistory();
  if (compareSelection.length === 2) openCompareModal(...compareSelection);
}

function diffEvidence(a, b, path = [], out = []) {
  if (typeof a !== typeof b || (a && b && typeof a === "object" && Array.isArray(a) !== Array.isArray(b))) {
    out.push({ path, a, b });
    return out;
  }
  if (a && typeof a === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b || {})]);
    for (const k of keys) diffEvidence(a[k], b?.[k], [...path, k], out);
  } else if (a !== b) {
    out.push({ path, a, b });
  }
  return out;
}

async function openCompareModal(idA, idB) {
  try {
    const [entryA, entryB] = await Promise.all([api(`/api/receipt/${idA}`), api(`/api/receipt/${idB}`)]);
    const diffs = diffEvidence(entryA.evidence, entryB.evidence);
    const diffPaths = new Set(diffs.map((d) => d.path.join(".")));

    function column(entry) {
      const rows = [];
      (function walk(node, path) {
        if (node && typeof node === "object" && !Array.isArray(node)) {
          for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
        } else if (Array.isArray(node)) {
          node.forEach((v, i) => walk(v, [...path, i]));
        } else {
          const p = path.join(".");
          rows.push({ p, v: node, isDiff: diffPaths.has(p) });
        }
      })(entry.evidence, []);
      return `<h4>${escapeHtml(entry.name)} · ${entry.decision}</h4>` + rows.map((r) => `
        <div class="diff-row ${r.isDiff ? "diff" : ""}">
          <span class="diff-key">${escapeHtml(r.p)}</span>
          <span class="diff-val">${escapeHtml(truncate(String(r.v), 50))}</span>
        </div>`).join("");
    }

    $("compare-body").innerHTML = `
      <div class="compare-col">${column(entryA)}</div>
      <div class="compare-col">${column(entryB)}</div>`;
    $("compare-backdrop").classList.remove("hidden");
    toast(diffs.length ? `${diffs.length} field(s) differ.` : "These two receipts are identical.");
  } catch (err) {
    toast(err.message, true);
  }
}

$("compare-close").addEventListener("click", closeCompareModal);
$("compare-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "compare-backdrop") closeCompareModal();
});
function closeCompareModal() {
  $("compare-backdrop").classList.add("hidden");
  compareSelection.length = 0;
  loadHistory();
}

// ---------- confetti (canvas, no external assets) ----------

const confettiCanvas = $("confetti-canvas");
const cctx = confettiCanvas.getContext("2d");
function resizeConfetti() {
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
}
resizeConfetti();
window.addEventListener("resize", resizeConfetti);

function fireConfetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#5d7cf7", "#8b5cf6", "#c65fe0", "#34e0a1"];
  const pieces = Array.from({ length: 70 }, () => ({
    x: confettiCanvas.width / 2 + (Math.random() - 0.5) * 200,
    y: confettiCanvas.height * 0.25,
    vx: (Math.random() - 0.5) * 8,
    vy: Math.random() * -6 - 2,
    size: Math.random() * 5 + 3,
    color: colors[Math.floor(Math.random() * colors.length)],
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    life: 0,
  }));
  const gravity = 0.22;
  let frame = 0;
  function tick() {
    frame++;
    cctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    let alive = false;
    for (const p of pieces) {
      p.vy += gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life++;
      if (p.y < confettiCanvas.height + 20) alive = true;
      cctx.save();
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot);
      cctx.fillStyle = p.color;
      cctx.globalAlpha = Math.max(0, 1 - p.life / 90);
      cctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      cctx.restore();
    }
    if (alive && frame < 100) requestAnimationFrame(tick);
    else cctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  }
  requestAnimationFrame(tick);
}

// ---------- keyboard shortcuts ----------

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select";
  if (typing && e.key !== "Enter") return;
  if (e.key === "v" || e.key === "V") runVerify();
  else if (e.key === "t" || e.key === "T") runTamperAndVerify();
  else if (e.key === "r" || e.key === "R") $("reset-btn").click();
});

// ---------- onboarding tip (first visit only) ----------

const VISITED_KEY = "cool-demo-visited";
function initOnboarding() {
  if (localStorage.getItem(VISITED_KEY)) return;
  $("onboarding-tip").classList.remove("hidden");
}
function dismissOnboarding() {
  localStorage.setItem(VISITED_KEY, "1");
  $("onboarding-tip").classList.add("hidden");
}
$("onboarding-dismiss").addEventListener("click", dismissOnboarding);
$("apply-form").addEventListener("submit", dismissOnboarding);

// ---------- boot ----------

syncSliderLabels();
runPreview();
loadHistory();
loadHealth();
resetPipeline();
initOnboarding();
loadSharedReceiptFromHash();

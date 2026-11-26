const SUPABASE_URL = "https://ihcsodtizmkwhzkzmbxk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_jXML1u1eUjEtCTqjLwukgQ_YspJOh1S";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let currentUser = null;
let myDecks = [];
let selectedDeckId = null;
let myGroups = [];
let selectedGroupId = null;
let groupMembers = [];
let groupDecks = [];
const artworkCache = new Map();

// Configurazione Server Scanner
const SCANNER_HTTP_BASE = "https://manastat-scanner-server.onrender.com";
const DEFAULT_SCANNER_WS_URL = "wss://manastat-scanner-server.onrender.com/ws/scan";
const STORAGE_SETS_KEY = "manastat_scanner_selected_sets";

// Badge versione sempre visibile sopra la barra di navigazione
const APP_UI_VERSION = "v2.5";
let connectedServerVersion = "";

function renderVersionBadge() {
  if (!document.body) return;
  let badge = document.getElementById("manastat-version-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "manastat-version-badge";
    badge.style.cssText =
      "position:fixed;bottom:62px;right:8px;z-index:40;pointer-events:none;" +
      "background:rgba(15,23,42,0.75);color:#94a3b8;border:1px solid rgba(148,163,184,0.22);" +
      "border-radius:6px;padding:2px 6px;font-size:10px;font-family:monospace;";
    document.body.appendChild(badge);
  }
  badge.textContent = connectedServerVersion
    ? `UI ${APP_UI_VERSION} · SRV ${connectedServerVersion}`
    : `UI ${APP_UI_VERSION}`;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderVersionBadge);
} else {
  renderVersionBadge();
}

let cameraStream = null;
let wsConn = null;
let wsRetryTimer = null;
let sendFrameTimer = null;
let awaitingServerReply = false;
let lastFrameSentAt = 0;
let scannerActive = false;
let pendingProposalCard = null;
let proposalMatches = [];
let lockedAfterConfirmCard = null;
let unlockFramesCounter = 0;
let scanPauseUntil = 0;
const rejectedCardKeys = new Set();

// Stato filtro espansioni scanner
let availableScannerSets = [];
let setsLoaded = false;
let setSelectorBound = false;
const selectedScannerSets = new Set(
  (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_SETS_KEY) || "[]");
      return Array.isArray(saved) ? saved.map((s) => String(s).toUpperCase()) : [];
    } catch {
      return [];
    }
  })()
);

const PREFERRED_FORMATS = [
  "Commander",
  "Standard",
  "Modern",
  "Pioneer",
  "Pauper",
  "Legacy",
  "Vintage",
  "Brawl",
  "Draft / Sealed",
  "Casual",
];

function setStatus(el, msg, type = "") {
  if (!el) return;
  el.textContent = msg;
  const baseClass = el.id === "collection-status" ? "scanner-toast" : "status";
  el.className = `${baseClass} ${type}`.trim();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

if ($("deck-date")) {
  $("deck-date").value = new Date().toISOString().slice(0, 10);
}

function getScannerWsUrl() {
  return DEFAULT_SCANNER_WS_URL;
}

function setScannerConnectionUi(label, stateClass, isRunning) {
  scannerActive = isRunning;
  const badge = $("scannerStatusBadge");
  if (badge) {
    badge.textContent = label;
    badge.className = `status-badge ${stateClass}`;
  }
  const btn = $("btnToggleScanner");
  if (btn) {
    btn.textContent = isRunning ? "Ferma" : "Avvia";
  }
}

function updateRejectedBadge() {
  if ($("rejected-count-badge")) {
    $("rejected-count-badge").textContent = `Scartate: ${rejectedCardKeys.size}`;
  }
}

function setScanStateBadge(text) {
  if ($("scan-state-badge")) {
    $("scan-state-badge").textContent = text;
  }
}

// ---- SELETTORE ESPANSIONI SCANNER ----
function saveSelectedSetsToStorage() {
  try {
    localStorage.setItem(STORAGE_SETS_KEY, JSON.stringify(Array.from(selectedScannerSets)));
  } catch {
    // ignora
  }
}

function sendSetFilterToWs() {
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN) return;
  try {
    wsConn.send(
      JSON.stringify({
        type: "set_filter",
        sets: Array.from(selectedScannerSets),
      })
    );
  } catch {
    // ignora
  }
}

function updateSetFilterSummary() {
  const lbl = $("scanner-sets-summary");
  if (!lbl) return;
  if (selectedScannerSets.size === 0) {
    lbl.textContent = "Tutte";
  } else if (selectedScannerSets.size <= 3) {
    lbl.textContent = Array.from(selectedScannerSets).join(", ");
  } else {
    lbl.textContent = `${selectedScannerSets.size} selezionate`;
  }
}

function renderScannerSetsList() {
  const listEl = $("scanner-sets-list");
  if (!listEl) return;
  const q = ($("scanner-sets-search")?.value || "").trim().toLowerCase();

  if (!setsLoaded) {
    listEl.innerHTML = `<div class="scanner-sets-empty">Caricamento espansioni...</div>`;
    return;
  }

  const filtered = availableScannerSets.filter((s) => {
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q);
  });

  if (!filtered.length) {
    listEl.innerHTML = `<div class="scanner-sets-empty">Nessuna espansione trovata.</div>`;
    return;
  }

  const ordered = filtered.slice().sort((a, b) => {
    const aSel = selectedScannerSets.has(a.code) ? 0 : 1;
    const bSel = selectedScannerSets.has(b.code) ? 0 : 1;
    if (aSel !== bSel) return aSel - bSel;
    return a.name.localeCompare(b.name);
  });

  listEl.innerHTML = ordered
    .slice(0, 120)
    .map((s) => {
      const checked = selectedScannerSets.has(s.code) ? "checked" : "";
      return `
        <label class="scanner-set-row">
          <input type="checkbox" class="scanner-set-chk" value="${escapeHtml(s.code)}" ${checked} />
          <span class="scanner-set-code">${escapeHtml(s.code)}</span>
          <span class="scanner-set-name">${escapeHtml(s.name)}</span>
          <span class="scanner-set-count">${s.count}</span>
        </label>
      `;
    })
    .join("");

  listEl.querySelectorAll(".scanner-set-chk").forEach((chk) => {
    chk.addEventListener("change", () => {
      const code = String(chk.value || "").toUpperCase();
      if (chk.checked) {
        selectedScannerSets.add(code);
      } else {
        selectedScannerSets.delete(code);
      }
      saveSelectedSetsToStorage();
      updateSetFilterSummary();
      sendSetFilterToWs();
    });
  });
}

function bindSetSelectorUi() {
  updateSetFilterSummary();
  if (setSelectorBound) return;
  setSelectorBound = true;

  $("btn-toggle-sets-panel")?.addEventListener("click", () => {
    const panel = $("scanner-sets-panel");
    if (!panel) return;
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      loadAvailableScannerSets();
    }
  });

  $("btn-clear-scanner-sets")?.addEventListener("click", () => {
    selectedScannerSets.clear();
    saveSelectedSetsToStorage();
    updateSetFilterSummary();
    renderScannerSetsList();
    sendSetFilterToWs();
  });

  $("scanner-sets-search")?.addEventListener("input", renderScannerSetsList);
}

async function loadAvailableScannerSets() {
  if (setsLoaded && availableScannerSets.length > 0) {
    renderScannerSetsList();
    return;
  }
  renderScannerSetsList();
  try {
    const resp = await fetch(`${SCANNER_HTTP_BASE}/sets`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (Array.isArray(data)) {
      availableScannerSets = data;
      setsLoaded = true;
      renderScannerSetsList();
    }
  } catch {
    // ritenterà alla prossima apertura
  }
}

// Navigazione tab in basso
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const targetTab = btn.dataset.tab;
    $(targetTab)?.classList.add("active");

    if (targetTab === "tab-collection") {
      document.body.classList.add("scanner-mode");
      bindSetSelectorUi();
      loadAvailableScannerSets();
      await ensureCameraAndWs();
    } else {
      document.body.classList.remove("scanner-mode");
      stopScannerSession();
      if (targetTab === "tab-profile" && typeof loadProfile === "function") {
        await loadProfile();
      }
    }
  });
});

// Login
$("btn-login")?.addEventListener("click", async () => {
  const email = ($("email")?.value || "").trim();
  const password = $("password")?.value || "";
  setStatus($("login-status"), "Accesso in corso...");

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    setStatus($("login-status"), error.message, "err");
    return;
  }
  currentUser = data.user;
  await onAuthenticated();
});

$("btn-logout")?.addEventListener("click", async () => {
  document.body.classList.remove("scanner-mode");
  stopScannerSession();
  await sb.auth.signOut();
  currentUser = null;
  selectedDeckId = null;
  selectedGroupId = null;
  $("main-view")?.classList.add("hidden");
  $("login-view")?.classList.remove("hidden");
});

async function onAuthenticated() {
  $("login-view")?.classList.add("hidden");
  $("main-view")?.classList.remove("hidden");
  if ($("user-badge") && currentUser?.email) {
    $("user-badge").textContent = currentUser.email;
  }
  const tasks = [loadDecks(), loadGroups()];
  if (typeof loadProfile === "function") tasks.push(loadProfile());
  await Promise.all(tasks);
}

function formatSortKey(deck) {
  const fmt = String(deck.format || deck.type || "").trim();
  if (!fmt) return [2, 999, String(deck.name || "").toLowerCase()];
  const idx = PREFERRED_FORMATS.findIndex((p) => p.toLowerCase() === fmt.toLowerCase());
  if (idx !== -1) return [0, idx, String(deck.name || "").toLowerCase()];
  return [1, 0, `${fmt.toLowerCase()}__${String(deck.name || "").toLowerCase()}`];
}

function toArtCropIfPossible(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  for (const variant of ["/normal/", "/large/", "/png/", "/border_crop/", "/small/"]) {
    if (u.includes(variant)) {
      return u.replace(variant, "/art_crop/");
    }
  }
  return u;
}

function extractDeckImageUrl(deck) {
  if (!deck || typeof deck !== "object") return "";
  const candidates = [
    deck.bg_image_url,
    deck.background_url,
    deck.bg_url,
    deck.image_url,
    deck.card_image_url,
    deck.art_crop_url,
    deck.banner_url,
    deck.commander_image_url,
  ];
  for (const val of candidates) {
    if (typeof val === "string" && val.startsWith("http")) {
      return toArtCropIfPossible(val);
    }
  }
  return "";
}

async function resolveDeckArtwork(deck) {
  const direct = extractDeckImageUrl(deck);
  if (direct) return direct;

  const candidates = [];
  if (deck.commander) candidates.push(String(deck.commander).trim());
  if (deck.name) candidates.push(String(deck.name).trim());
  if (Array.isArray(deck.cards_json)) {
    const firstCard = deck.cards_json.find((c) => c && typeof c.name === "string" && c.name.trim());
    if (firstCard) candidates.push(firstCard.name.trim());
  }

  for (const queryName of candidates) {
    if (!queryName) continue;
    if (artworkCache.has(queryName)) {
      const cached = artworkCache.get(queryName);
      if (cached) return cached;
      continue;
    }

    try {
      const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(queryName)}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        artworkCache.set(queryName, "");
        continue;
      }
      const card = await resp.json();
      const art =
        card?.image_uris?.art_crop ||
        card?.card_faces?.[0]?.image_uris?.art_crop ||
        card?.image_uris?.normal ||
        "";
      artworkCache.set(queryName, art);
      if (art) return art;
    } catch {
      artworkCache.set(queryName, "");
    }
  }
  return "";
}

// ---- PAGINA MAZZI ----
async function loadDecks() {
  setStatus($("deck-list-status"), "Caricamento mazzi...");
  const { data, error } = await sb
    .from("decks")
    .select("*")
    .eq("owner_id", currentUser.id);

  if (error) {
    setStatus($("deck-list-status"), error.message, "err");
    return;
  }

  myDecks = (data || []).slice().sort((a, b) => {
    const ka = formatSortKey(a);
    const kb = formatSortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2].localeCompare(kb[2], "it");
  });

  setStatus($("deck-list-status"), "");
  renderDecksList();

  for (const d of myDecks) {
    if (!extractDeckImageUrl(d)) {
      resolveDeckArtwork(d).then((artUrl) => {
        if (artUrl) {
          d._resolvedArtUrl = artUrl;
          const el = document.querySelector(`[data-deck-card-id="${d.id}"]`);
          if (el) {
            el.style.backgroundImage = `url("${artUrl}")`;
          }
          if (selectedDeckId === d.id) {
            applyDeckHeroBg(artUrl);
          }
        }
      });
    }
  }
}

function renderDecksList() {
  const container = $("decks-list-container");
  if (!myDecks.length) {
    container.innerHTML = `<p class="muted">Nessun mazzo trovato sul tuo account.</p>`;
    return;
  }

  container.innerHTML = myDecks
    .map((d) => {
      const bg = extractDeckImageUrl(d) || d._resolvedArtUrl || "";
      const bgStyle = bg ? `style="background-image: url('${escapeHtml(bg)}');"` : "";
      const fmtText = d.format || d.type || "Mazzo";
      return `
        <button type="button" class="deck-banner-card" data-deck-card-id="${escapeHtml(d.id)}" ${bgStyle} onclick="openDeckDetail('${escapeHtml(d.id)}')">
          <div class="deck-banner-content">
            <div>
              <div class="deck-banner-title">${escapeHtml(d.name || "Senza nome")}</div>
              <div class="deck-banner-sub">${escapeHtml(fmtText)}</div>
            </div>
            <div class="deck-banner-arrow">›</div>
          </div>
        </button>
      `;
    })
    .join("");
}

function applyDeckHeroBg(bgUrl) {
  const hero = $("deck-detail-hero");
  if (bgUrl) {
    hero.style.backgroundImage = `url("${bgUrl}")`;
  } else {
    hero.style.backgroundImage = "none";
  }
}

let currentDeckHistory = [];
let currentDeckCards = [];

// Switch sotto-tab della scheda mazzo
document.querySelectorAll(".deck-subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.subtab;
    document.querySelectorAll(".deck-subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".deck-subpanel").forEach((p) => {
      p.classList.toggle("hidden", p.id !== targetId);
      p.classList.toggle("active", p.id === targetId);
    });
  });
});

function switchDeckSubtab(targetId) {
  const btn = document.querySelector(`.deck-subtab-btn[data-subtab="${targetId}"]`);
  if (btn) btn.click();
}

window.openDeckDetail = async function (deckId) {
  const deck = myDecks.find((d) => String(d.id) === String(deckId));
  if (!deck) return;

  selectedDeckId = deck.id;
  $("deck-detail-title").textContent = deck.name || "Senza nome";
  $("deck-detail-format").textContent = deck.format || deck.type || "Mazzo";
  $("deck-detail-count").textContent = "";
  applyDeckHeroBg(extractDeckImageUrl(deck) || deck._resolvedArtUrl || "");
  setStatus($("deck-status"), "");

  $("decks-list-view").classList.add("hidden");
  $("deck-detail-view").classList.remove("hidden");
  switchDeckSubtab("deck-sub-stats");

  await Promise.all([
    loadDeckHistory(deck.id),
    loadDeckCards(deck),
  ]);
};

$("btn-back-to-decks").addEventListener("click", () => {
  selectedDeckId = null;
  currentDeckHistory = [];
  currentDeckCards = [];
  $("deck-detail-view").classList.add("hidden");
  $("decks-list-view").classList.remove("hidden");
});

// ---- STATISTICHE & STORICO (deck_history) ----
async function loadDeckHistory(deckId) {
  const { data, error } = await sb
    .from("deck_history")
    .select("id, played_on, match, win, created_at")
    .eq("deck_id", deckId)
    .order("played_on", { ascending: true });

  if (error) {
    setStatus($("deck-status"), error.message, "err");
    return;
  }

  currentDeckHistory = data || [];
  renderDeckStats();
  renderDeckHistoryList();
}

function renderDeckStats() {
  let totalMatches = 0;
  let totalWins = 0;

  for (const r of currentDeckHistory) {
    const m = Math.max(0, Number(r.match || 0));
    const w = Math.max(0, Math.min(Number(r.win || 0), m));
    totalMatches += m;
    totalWins += w;
  }

  const totalLosses = Math.max(0, totalMatches - totalWins);
  const winrate = totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : null;

  $("deck-kpi-matches").textContent = String(totalMatches);
  $("deck-kpi-wins").textContent = String(totalWins);
  $("deck-kpi-losses").textContent = String(totalLosses);
  $("deck-kpi-winrate").textContent = winrate !== null ? `${winrate}%` : "—";

  renderWinLossPie(totalWins, totalLosses);
  renderWinrateTrend();
}

function renderWinLossPie(wins, losses) {
  const box = $("deck-pie-container");
  const total = wins + losses;
  if (!total) {
    box.innerHTML = `<p class="muted">Nessuna partita registrata.</p>`;
    return;
  }

  const winPct = (wins / total) * 100;
  const r = 42;
  const circ = 2 * Math.PI * r;
  const winDash = (winPct / 100) * circ;

  box.innerHTML = `
    <div class="pie-row">
      <svg width="110" height="110" viewBox="0 0 110 110">
        <circle cx="55" cy="55" r="${r}" fill="none" stroke="#ef4444" stroke-width="14"></circle>
        <circle cx="55" cy="55" r="${r}" fill="none" stroke="#22c55e" stroke-width="14"
          stroke-dasharray="${winDash.toFixed(1)} ${circ.toFixed(1)}"
          transform="rotate(-90 55 55)"></circle>
        <text x="55" y="60" text-anchor="middle" fill="#f8fafc" font-size="16" font-weight="700">
          ${Math.round(winPct)}%
        </text>
      </svg>
      <div class="pie-legend">
        <div><span class="legend-dot" style="background:#22c55e"></span>Vittorie: <strong>${wins}</strong></div>
        <div><span class="legend-dot" style="background:#ef4444"></span>Sconfitte: <strong>${losses}</strong></div>
      </div>
    </div>
  `;
}

function renderWinrateTrend() {
  const box = $("deck-trend-container");
  if (!currentDeckHistory.length) {
    box.innerHTML = `<p class="muted">Registra almeno una sessione per vedere l'andamento.</p>`;
    return;
  }

  // Raggruppa per giorno e calcola winrate cumulativo
  const byDay = new Map();
  for (const r of currentDeckHistory) {
    const day = String(r.played_on || "").slice(0, 10);
    if (!day) continue;
    const prev = byDay.get(day) || { m: 0, w: 0 };
    const m = Math.max(0, Number(r.match || 0));
    const w = Math.max(0, Math.min(Number(r.win || 0), m));
    byDay.set(day, { m: prev.m + m, w: prev.w + w });
  }

  const days = Array.from(byDay.keys()).sort();
  let cumM = 0;
  let cumW = 0;
  const points = days.map((day) => {
    const d = byDay.get(day);
    cumM += d.m;
    cumW += d.w;
    return { day, wr: cumM > 0 ? (cumW / cumM) * 100 : 0 };
  });

  const W = 300;
  const H = 120;
  const padL = 28;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const coords = points.map((p, i) => {
    const x = points.length === 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW;
    const y = padT + plotH - (p.wr / 100) * plotH;
    return { x, y, ...p };
  });

  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const dots = coords
    .map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="#38bdf8"></circle>`)
    .join("");

  const firstDay = points[0].day.slice(5);
  const lastDay = points[points.length - 1].day.slice(5);

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;">
      <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="rgba(255,255,255,0.08)" />
      <line x1="${padL}" y1="${padT + plotH / 2}" x2="${W - padR}" y2="${padT + plotH / 2}" stroke="rgba(255,255,255,0.12)" stroke-dasharray="3,3" />
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="rgba(255,255,255,0.08)" />
      <text x="4" y="${padT + 4}" fill="#64748b" font-size="9">100%</text>
      <text x="8" y="${padT + plotH / 2 + 3}" fill="#64748b" font-size="9">50%</text>
      <text x="12" y="${padT + plotH + 3}" fill="#64748b" font-size="9">0%</text>
      ${points.length > 1 ? `<polyline fill="none" stroke="#38bdf8" stroke-width="2.5" points="${polyline}" />` : ""}
      ${dots}
      <text x="${padL}" y="${H - 4}" fill="#94a3b8" font-size="9">${escapeHtml(firstDay)}</text>
      <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="#94a3b8" font-size="9">${escapeHtml(lastDay)}</text>
    </svg>
  `;
}

function renderDeckHistoryList() {
  const container = $("deck-history-list");
  if (!currentDeckHistory.length) {
    container.innerHTML = `<p class="muted">Nessuna sessione registrata per questo mazzo.</p>`;
    return;
  }

  const reversed = currentDeckHistory.slice().reverse();
  container.innerHTML = reversed
    .map((r) => {
      const m = Math.max(0, Number(r.match || 0));
      const w = Math.max(0, Math.min(Number(r.win || 0), m));
      const wr = m > 0 ? Math.round((w / m) * 100) : 0;
      const dateStr = String(r.played_on || "").slice(0, 10);
      return `
        <div class="history-row">
          <div>
            <div class="history-score">${w}V / ${m}P (${wr}%)</div>
            <div class="history-date">${escapeHtml(dateStr)}</div>
          </div>
          <button type="button" class="history-del-btn" onclick="deleteDeckHistoryEntry('${escapeHtml(r.id)}')">Elimina</button>
        </div>
      `;
    })
    .join("");
}

window.deleteDeckHistoryEntry = async function (entryId) {
  if (!entryId || !confirm("Eliminare questa sessione?")) return;
  const { error } = await sb.from("deck_history").delete().eq("id", entryId);
  if (error) {
    setStatus($("deck-status"), error.message, "err");
    return;
  }
  await loadDeckHistory(selectedDeckId);
};

$("btn-save-deck-match").addEventListener("click", async () => {
  const matches = Math.max(1, parseInt($("deck-matches").value || "1", 10));
  const wins = Math.max(0, Math.min(parseInt($("deck-wins").value || "0", 10), matches));
  const playedOn = $("deck-date").value || new Date().toISOString().slice(0, 10);

  if (!selectedDeckId) {
    setStatus($("deck-status"), "Seleziona prima un mazzo.", "err");
    return;
  }

  setStatus($("deck-status"), "Salvataggio...");
  const { error } = await sb.from("deck_history").insert({
    deck_id: selectedDeckId,
    user_id: currentUser.id,
    played_on: playedOn,
    match: matches,
    win: wins,
  });

  if (error) {
    setStatus($("deck-status"), error.message, "err");
    return;
  }

  $("deck-wins").value = "0";
  setStatus($("deck-status"), "Partita salvata!", "ok");
  await loadDeckHistory(selectedDeckId);
});

// ---- LISTA CARTE & CURVA DI MANA ----
async function loadDeckCards(deck) {
  setStatus($("deck-cards-status"), "Caricamento lista...");
  $("deck-cards-list").innerHTML = "";

  let cards = [];
  const { data, error } = await sb
    .from("deck_cards")
    .select("id, name, type_line, mana_cost, image_url, quantity, is_commander, scryfall_id")
    .eq("deck_id", deck.id);

  if (!error && Array.isArray(data) && data.length > 0) {
    cards = data;
  } else if (Array.isArray(deck.cards_json) && deck.cards_json.length > 0) {
    cards = deck.cards_json;
  }

  currentDeckCards = cards;
  const totalCount = cards.reduce((acc, c) => acc + Math.max(1, Number(c.quantity || 1)), 0);
  $("deck-detail-count").textContent = totalCount > 0 ? `${totalCount} carte` : "";

  setStatus($("deck-cards-status"), "");
  renderManaCurve(cards);
  renderDeckCardsList(cards);
}

function parseCmcFromManaCost(manaCost) {
  const raw = String(manaCost || "");
  if (!raw) return 0;
  const tokens = raw.match(/\{([^}]+)\}/g) || [];
  let cmc = 0;
  for (const t of tokens) {
    const sym = t.slice(1, -1).toUpperCase();
    if (/^\d+$/.test(sym)) cmc += parseInt(sym, 10);
    else if (sym === "X" || sym === "Y" || sym === "Z") cmc += 0;
    else cmc += 1;
  }
  return cmc;
}

function renderManaPipsHtml(manaCost) {
  const raw = String(manaCost || "");
  const tokens = raw.match(/\{([^}]+)\}/g) || [];
  return tokens
    .map((t) => {
      const sym = t.slice(1, -1).toUpperCase();
      let cls = "mana-num";
      if (sym === "W") cls = "mana-w";
      else if (sym === "U") cls = "mana-u";
      else if (sym === "B") cls = "mana-b";
      else if (sym === "R") cls = "mana-r";
      else if (sym === "G") cls = "mana-g";
      else if (sym === "C") cls = "mana-c";
      return `<span class="mana-pip ${cls}">${escapeHtml(sym)}</span>`;
    })
    .join("");
}

function getCardCategory(card) {
  if (card.is_commander) return "Comandante";
  const tl = String(card.type_line || "").toLowerCase();
  if (tl.includes("creature")) return "Creature";
  if (tl.includes("planeswalker")) return "Planeswalker";
  if (tl.includes("instant")) return "Istantanee";
  if (tl.includes("sorcery")) return "Stregonerie";
  if (tl.includes("artifact")) return "Artefatti";
  if (tl.includes("enchantment")) return "Incantesimi";
  if (tl.includes("battle")) return "Battaglie";
  if (tl.includes("land")) return "Terre";
  return "Altro";
}

function renderManaCurve(cards) {
  const buckets = [0, 0, 0, 0, 0, 0, 0]; // 0,1,2,3,4,5,6+
  let nonLandCount = 0;
  let cmcSum = 0;

  for (const c of cards) {
    const tl = String(c.type_line || "").toLowerCase();
    if (tl.includes("land") && !tl.includes("creature")) continue;
    const qty = Math.max(1, Number(c.quantity || 1));
    const cmc = parseCmcFromManaCost(c.mana_cost);
    const idx = Math.min(6, Math.max(0, Math.floor(cmc)));
    buckets[idx] += qty;
    nonLandCount += qty;
    cmcSum += cmc * qty;
  }

  const avg = nonLandCount > 0 ? (cmcSum / nonLandCount).toFixed(2) : "—";
  $("deck-avg-cmc").textContent = `CMC ${avg}`;

  const maxVal = Math.max(1, ...buckets);
  const labels = ["0", "1", "2", "3", "4", "5", "6+"];
  $("deck-mana-curve").innerHTML = buckets
    .map((val, i) => {
      const hPct = Math.round((val / maxVal) * 100);
      return `
        <div class="curve-col">
          <span class="curve-count">${val || ""}</span>
          <div class="curve-bar-wrap">
            <div class="curve-bar" style="height:${val ? Math.max(8, hPct) : 2}%;"></div>
          </div>
          <span class="curve-label">${labels[i]}</span>
        </div>
      `;
    })
    .join("");
}

function renderDeckCardsList(cards) {
  const container = $("deck-cards-list");
  if (!cards.length) {
    container.innerHTML = `<p class="muted">Nessuna carta salvata sul cloud per questo mazzo.</p>`;
    return;
  }

  const order = [
    "Comandante", "Creature", "Planeswalker", "Istantanee",
    "Stregonerie", "Artefatti", "Incantesimi", "Battaglie", "Terre", "Altro",
  ];
  const groups = new Map();

  cards.forEach((c, idx) => {
    const cat = getCardCategory(c);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ ...c, _idx: idx });
  });

  container.innerHTML = order
    .filter((cat) => groups.has(cat))
    .map((cat) => {
      const list = groups.get(cat).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "it"));
      const catCount = list.reduce((s, c) => s + Math.max(1, Number(c.quantity || 1)), 0);
      const rows = list
        .map((c) => {
          const qty = Math.max(1, Number(c.quantity || 1));
          const qtyHtml = qty > 1 ? `<span class="deck-card-qty">${qty}x</span>` : "";
          const crown = c.is_commander ? "👑 " : "";
          return `
            <div class="deck-card-row" onclick="openCardPreview(${c._idx})">
              <div class="deck-card-left">
                ${qtyHtml}
                <span class="deck-card-name">${crown}${escapeHtml(c.name || "")}</span>
              </div>
              <div class="deck-card-mana">${renderManaPipsHtml(c.mana_cost)}</div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="deck-cat-block">
          <div class="deck-cat-title"><span>${cat}</span><span>${catCount}</span></div>
          ${rows}
        </div>
      `;
    })
    .join("");
}

window.openCardPreview = async function (cardIdx) {
  const card = currentDeckCards[cardIdx];
  if (!card) return;

  $("card-preview-name").textContent = card.name || "";
  $("card-preview-meta").textContent = card.type_line || "";
  const imgEl = $("card-preview-img");
  imgEl.src = "";
  $("card-preview-modal").classList.remove("hidden");

  let url = card.card_image_url || card.image_url || "";
  if (url.includes("/art_crop/")) url = url.replace("/art_crop/", "/normal/");

  if (!url && card.name) {
    try {
      const resp = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(card.name)}`);
      if (resp.ok) {
        const sc = await resp.json();
        url = sc?.image_uris?.normal || sc?.card_faces?.[0]?.image_uris?.normal || "";
      }
    } catch {
      // ignora
    }
  }
  if (url) imgEl.src = url;
};

$("btn-close-card-preview").addEventListener("click", () => {
  $("card-preview-modal").classList.add("hidden");
});

  
// ---- PAGINA GRUPPI ----
async function loadGroups() {
  setStatus($("group-list-status"), "Caricamento gruppi...");
  const { data: memberships, error } = await sb
    .from("group_members")
    .select("group_id")
    .eq("user_id", currentUser.id);

  if (error) {
    setStatus($("group-list-status"), error.message, "err");
    return;
  }

  const groupIds = (memberships || []).map((m) => m.group_id);
  if (!groupIds.length) {
    myGroups = [];
    setStatus($("group-list-status"), "");
    $("groups-list-container").innerHTML = `<p class="muted">Non fai ancora parte di nessun gruppo.</p>`;
    return;
  }

  const { data: groupsData, error: gErr } = await sb
    .from("groups")
    .select("id, name")
    .in("id", groupIds)
    .order("name", { ascending: true });

  if (gErr) {
    setStatus($("group-list-status"), gErr.message, "err");
    return;
  }

  myGroups = groupsData || [];
  setStatus($("group-list-status"), "");
  renderGroupsList();
}

function renderGroupsList() {
  const container = $("groups-list-container");
  if (!myGroups.length) {
    container.innerHTML = `<p class="muted">Nessun gruppo trovato.</p>`;
    return;
  }

  container.innerHTML = myGroups
    .map(
      (g) => `
        <div class="group-card" onclick="openGroupDetail('${escapeHtml(g.id)}')">
          <div>
            <div class="group-card-title">${escapeHtml(g.name || "Gruppo")}</div>
            <div class="muted">Tocca per registrare una partita</div>
          </div>
          <div class="deck-banner-arrow">›</div>
        </div>
      `
    )
    .join("");
}

window.openGroupDetail = async function (groupId) {
  const grp = myGroups.find((g) => String(g.id) === String(groupId));
  if (!grp) return;

  selectedGroupId = grp.id;
  $("group-detail-title").textContent = grp.name || "Gruppo";
  $("group-players-container").innerHTML = `<p class="muted">Caricamento partecipanti e mazzi...</p>`;
  setStatus($("group-status"), "");

  $("groups-list-view").classList.add("hidden");
  $("group-detail-view").classList.remove("hidden");

  await loadGroupDetails(grp.id);
};

$("btn-back-to-groups")?.addEventListener("click", () => {
  selectedGroupId = null;
  $("group-detail-view").classList.add("hidden");
  $("groups-list-view").classList.remove("hidden");
});

async function loadGroupDetails(groupId) {
  if (!groupId) return;

  const [{ data: members }, { data: decks }] = await Promise.all([
    sb.from("group_members").select("user_id").eq("group_id", groupId),
    sb.from("group_decks").select("*").eq("group_id", groupId),
  ]);

  const memberIds = (members || []).map((m) => m.user_id);
  groupDecks = decks || [];

  let profiles = [];
  if (memberIds.length) {
    const { data: profData } = await sb
      .from("profiles")
      .select("id, nickname")
      .in("id", memberIds);
    profiles = profData || [];
  }

  const nickMap = Object.fromEntries(profiles.map((p) => [p.id, p.nickname || p.id.slice(0, 6)]));
  groupMembers = memberIds.map((uid) => ({ user_id: uid, name: nickMap[uid] || uid.slice(0, 6) }));

  renderGroupPlayers();
}

function getDecksForMember(userId, allGroupDecks) {
  const owned = allGroupDecks.filter((d) => {
    const owner = d.owner_id ?? d.user_id ?? null;
    return owner && String(owner) === String(userId);
  });
  if (owned.length) return owned;

  return allGroupDecks.filter((d) => !(d.owner_id ?? d.user_id));
}

function renderGroupPlayers() {
  if (!groupMembers.length) {
    $("group-players-container").innerHTML = `<p class="muted">Nessun membro trovato.</p>`;
    return;
  }

  $("group-players-container").innerHTML = groupMembers
    .map((m, idx) => {
      const memberDecks = getDecksForMember(m.user_id, groupDecks);
      const deckOpts = memberDecks.length
        ? memberDecks.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("")
        : `<option value="" disabled>Nessun mazzo assegnato a ${escapeHtml(m.name)}</option>`;

      return `
        <div class="player-box">
          <strong>${escapeHtml(m.name)}</strong>
          <label>Mazzo usato</label>
          <select class="gp-deck" data-user-id="${escapeHtml(m.user_id)}">
            <option value="">— Seleziona mazzo —</option>
            ${deckOpts}
          </select>
          <label class="winner-row">
            <input type="radio" name="winner" value="${escapeHtml(m.user_id)}" ${idx === 0 ? "checked" : ""} />
            <span>Vincitore</span>
          </label>
        </div>
      `;
    })
    .join("");
}

$("btn-save-group-match")?.addEventListener("click", async () => {
  const notes = $("group-notes").value.trim() || null;
  const winnerEl = document.querySelector('input[name="winner"]:checked');
  const winnerId = winnerEl ? winnerEl.value : null;

  if (!selectedGroupId || !winnerId) {
    setStatus($("group-status"), "Seleziona gruppo e vincitore.", "err");
    return;
  }

  const rows = [];
  document.querySelectorAll(".gp-deck").forEach((sel, i) => {
    const deckVal = sel.value || null;
    if (deckVal) {
      rows.push({
        user_id: sel.dataset.userId,
        group_deck_id: deckVal,
        is_winner: sel.dataset.userId === winnerId,
        seat: i + 1,
      });
    }
  });

  if (rows.length < 2) {
    setStatus($("group-status"), "Seleziona un mazzo del gruppo per almeno 2 giocatori.", "err");
    return;
  }

  setStatus($("group-status"), "Salvataggio partita...");
  const { data: matchRow, error: matchErr } = await sb
    .from("matches")
    .insert({
      group_id: selectedGroupId,
      played_on: new Date().toISOString(),
      created_by: currentUser.id,
      notes,
    })
    .select("id")
    .single();

  if (matchErr) {
    setStatus($("group-status"), matchErr.message, "err");
    return;
  }

  const playersPayload = rows.map((r) => ({ ...r, match_id: matchRow.id }));
  const { error: mpErr } = await sb.from("match_players").insert(playersPayload);

  if (mpErr) {
    setStatus($("group-status"), mpErr.message, "err");
    return;
  }

  $("group-notes").value = "";
  setStatus($("group-status"), "Partita di gruppo salvata! La ritroverai nell'app desktop.", "ok");
});

// ---- PAGINA PROFILO ----
async function loadProfile() {
  if (!currentUser) return;
  const uid = currentUser.id;
  setStatus($("profile-status"), "");

  // 1. Dati profilo (con fallback se alcune colonne social non esistono)
  let profile = null;
  const profRes = await sb
    .from("profiles")
    .select("id, nickname, bio, avatar_url, favorite_cards, created_at")
    .eq("id", uid)
    .maybeSingle();

  if (profRes.error) {
    const fallbackRes = await sb
      .from("profiles")
      .select("id, nickname, created_at")
      .eq("id", uid)
      .maybeSingle();
    profile = fallbackRes.data || {};
  } else {
    profile = profRes.data || {};
  }

  // 2. Mazzi, storico partite, partite gruppi e amici in parallelo
  const [decksRes, mpRes, friendsRes] = await Promise.all([
    sb.from("decks").select("id, name, type, format").eq("owner_id", uid),
    sb.from("match_players").select("is_winner").eq("user_id", uid),
    sb
      .from("friendships")
      .select("id, requester_id, addressee_id, status")
      .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`),
  ]);

  const decks = decksRes.data || [];
  const deckIds = decks.map((d) => d.id).filter(Boolean);

  let histRows = [];
  if (deckIds.length) {
    const hRes = await sb
      .from("deck_history")
      .select("deck_id, match, win")
      .in("deck_id", deckIds);
    histRows = hRes.data || [];
  }

  // Calcolo statistiche come nell'app desktop
  const byDeck = {};
  let personalMatches = 0;
  let personalWins = 0;
  for (const r of histRows) {
    const m = Math.max(0, parseInt(r.match || 0, 10));
    const w = Math.max(0, Math.min(parseInt(r.win || 0, 10), m));
    personalMatches += m;
    personalWins += w;
    if (r.deck_id) {
      if (!byDeck[r.deck_id]) byDeck[r.deck_id] = [0, 0];
      byDeck[r.deck_id][0] += m;
      byDeck[r.deck_id][1] += w;
    }
  }

  let groupMatches = 0;
  let groupWins = 0;
  for (const r of mpRes.data || []) {
    groupMatches += 1;
    if (r.is_winner) groupWins += 1;
  }

  const totalMatches = personalMatches + groupMatches;
  const totalWins = personalWins + groupWins;
  const globalWr = totalMatches > 0 ? (totalWins / totalMatches) * 100 : 0;

  let favDeckName = "Nessuno";
  let favDeckSub = "0 partite";
  if (decks.length) {
    const bestDeck = decks.reduce((best, d) => {
      const [bm, bw] = byDeck[best.id] || [0, 0];
      const [dm, dw] = byDeck[d.id] || [0, 0];
      if (dm !== bm) return dm > bm ? d : best;
      return dw > bw ? d : best;
    }, decks[0]);
    const [bm, bw] = byDeck[bestDeck.id] || [0, 0];
    favDeckName = bestDeck.name || "Mazzo";
    if (bm > 0) {
      favDeckSub = `${bm} partite · ${((bw / bm) * 100).toFixed(1)}% WR`;
    } else {
      favDeckSub = (bestDeck.format || bestDeck.type || "Mazzo principale").trim();
    }
  }

  const friendRows = friendsRes.error ? [] : (friendsRes.data || []);
  const friendsCount = friendRows.filter((f) => f.status === "accepted").length;
  const pendingIncoming = friendRows.filter(
    (f) => f.status === "pending" && f.addressee_id === uid
  ).length;

  // Rendering intestazione
  const nickname = (profile.nickname || "").trim() || (currentUser.email || "Giocatore").split("@")[0];
  $("profile-nickname").textContent = nickname;
  $("profile-email").textContent = currentUser.email || "";

  if (profile.created_at) {
    const dt = new Date(profile.created_at);
    if (!Number.isNaN(dt.getTime())) {
      $("profile-since").textContent = `Membro dal ${dt.toLocaleDateString("it-IT")}`;
    }
  } else {
    $("profile-since").textContent = "";
  }

  const avatarEl = $("profile-avatar");
  const avatarUrl = (profile.avatar_url || "").trim();
  if (avatarUrl) {
    avatarEl.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="Foto profilo" />`;
  } else {
    avatarEl.textContent = nickname.slice(0, 1).toUpperCase();
  }

  const bio = (profile.bio || "").trim();
  $("profile-bio").textContent = bio || "Nessuna bio impostata.";

  // Rendering KPI
  $("kpi-winrate").textContent = totalMatches > 0 ? `${globalWr.toFixed(1)}%` : "—";
  $("kpi-winrate-sub").textContent = `${totalWins}V / ${totalMatches}P`;

  $("kpi-matches").textContent = String(totalMatches);
  $("kpi-matches-sub").textContent = `${personalMatches} pers. · ${groupMatches} gruppi`;

  $("kpi-decks").textContent = String(decks.length);
  $("kpi-decks-sub").textContent = decks.length === 1 ? "Mazzo personale" : "Mazzi personali";

  $("kpi-friends").textContent = String(friendsCount);
  $("kpi-friends-sub").textContent =
    pendingIncoming > 0 ? `${pendingIncoming} richieste in attesa` : "Connessi";

  $("profile-fav-deck-name").textContent = favDeckName;
  $("profile-fav-deck-sub").textContent = favDeckSub;

  // Rendering Vetrina Carte Preferite
  const flexGrid = $("profile-flex-grid");
  const favCards = Array.isArray(profile.favorite_cards)
    ? profile.favorite_cards.filter((c) => c && (c.name || c.image_url))
    : [];

  if (!favCards.length) {
    flexGrid.innerHTML = `<p class="muted" style="grid-column:1 / -1;margin:4px 0;">Nessuna carta in vetrina (puoi aggiungerle dall'app desktop).</p>`;
  } else {
    flexGrid.innerHTML = favCards
      .slice(0, 4)
      .map((c) => {
        const img = c.image_url || c.card_image_url || "";
        const isFoil = Boolean(c.foil);
        const setInfo = [
          (c.set_code || c.set || "").toUpperCase(),
          c.collector_number ? `#${c.collector_number}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `
          <div class="flex-card-slot ${isFoil ? "is-foil" : ""}">
            <div class="flex-card-img-wrap">
              ${isFoil ? `<span class="flex-foil-badge">✨ Foil</span>` : ""}
              ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(c.name || "Carta")}" loading="lazy" />` : ""}
            </div>
            <div class="flex-card-name">${escapeHtml(c.name || "Carta")}</div>
            ${setInfo ? `<div class="flex-card-set">${escapeHtml(setInfo)}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }
}

// ---- SALVATAGGIO CARTA IN COLLEZIONE ----
async function saveCardPayloadToCollection(cardPayload, isFoil) {
  const rowToInsert = {
    user_id: currentUser.id,
    scryfall_id: cardPayload.scryfall_id,
    name: cardPayload.name || "",
    set_code: (cardPayload.set_code || "").toUpperCase(),
    set_name: cardPayload.set_name || "",
    collector_number: cardPayload.collector_number || "",
    released_at: cardPayload.released_at || "",
    rarity: cardPayload.rarity || "",
    type_line: cardPayload.type_line || "",
    mana_cost: cardPayload.mana_cost || "",
    cmc: cardPayload.cmc ?? 0,
    colors: Array.isArray(cardPayload.colors) ? cardPayload.colors : [],
    image_url: cardPayload.image_url || "",
    card_image_url: cardPayload.card_image_url || cardPayload.image_url || "",
    price_eur: cardPayload.price_eur ?? null,
    price_eur_foil: cardPayload.price_eur_foil ?? null,
    foil: isFoil,
    quantity: 1,
  };

  const { error: checkErr } = await sb
    .from("user_collection")
    .select("id, quantity")
    .eq("user_id", currentUser.id)
    .eq("scryfall_id", cardPayload.scryfall_id)
    .eq("foil", isFoil)
    .maybeSingle()
    .then(async ({ data: existing, error }) => {
      if (error) return { error };
      if (existing) {
        return sb
          .from("user_collection")
          .update({ quantity: (existing.quantity || 1) + 1 })
          .eq("id", existing.id);
      }
      return sb.from("user_collection").insert(rowToInsert);
    });

  if (checkErr) {
    throw new Error(checkErr.message);
  }
}

// ---- DISEGNO DEI 4 BORDI RILEVATI ----
function clearQuadOverlay() {
  const canvas = $("quad-overlay");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawQuadOverlay(normQuad, matched = false) {
  const canvas = $("quad-overlay");
  const video = $("scan-video");
  if (!canvas || !video || !video.videoWidth || !video.videoHeight) return;

  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.floor(rect.width * dpr);
  const targetH = Math.floor(rect.height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!Array.isArray(normQuad) || normQuad.length !== 4) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(canvas.width / vw, canvas.height / vh);
  const renderedW = vw * scale;
  const renderedH = vh * scale;
  const offsetX = (canvas.width - renderedW) / 2;
  const offsetY = (canvas.height - renderedH) / 2;

  const pts = normQuad.map(([nx, ny]) => ({
    x: offsetX + nx * renderedW,
    y: offsetY + ny * renderedH,
  }));

  ctx.save();
  ctx.lineWidth = 3.5 * dpr;
  ctx.strokeStyle = matched ? "#22c55e" : "#38bdf8";
  ctx.fillStyle = matched ? "rgba(34, 197, 94, 0.14)" : "rgba(56, 189, 248, 0.10)";

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = matched ? "#4ade80" : "#7dd3fc";
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---- WEBSOCKET + STREAMING FRAME ----
function stopFrameLoop() {
  if (sendFrameTimer) {
    clearInterval(sendFrameTimer);
    sendFrameTimer = null;
  }
  awaitingServerReply = false;
  lastFrameSentAt = 0;
}

function stopScannerSession() {
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }
  stopFrameLoop();
  clearQuadOverlay();
  lockedAfterConfirmCard = null;
  unlockFramesCounter = 0;
  scanPauseUntil = 0;
  if (wsConn) {
    try {
      wsConn.onclose = null;
      wsConn.onerror = null;
      wsConn.close();
    } catch {
      // ignora
    }
    wsConn = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  $("camera-placeholder")?.classList.remove("hidden");
  setScannerConnectionUi("Offline", "disconnected", false);
}

function captureJpegBlobFromVideo(callback) {
  const video = $("scan-video");
  if (!video || !video.videoWidth || !video.videoHeight) {
    callback(null);
    return;
  }

  const maxW = 480;
  const ratio = Math.min(1, maxW / video.videoWidth);
  const w = Math.max(1, Math.floor(video.videoWidth * ratio));
  const h = Math.max(1, Math.floor(video.videoHeight * ratio));

  const canvas = $("frame-send-canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);
  canvas.toBlob((blob) => callback(blob), "image/jpeg", 0.72);
}

function startFrameLoop() {
  stopFrameLoop();
  sendFrameTimer = setInterval(() => {
    if (pendingProposalCard) return;
    if (awaitingServerReply && Date.now() - lastFrameSentAt < 5000) return;
    if (!wsConn || wsConn.readyState !== WebSocket.OPEN) return;
    const video = $("scan-video");
    if (!video || video.readyState < 2) return;

    awaitingServerReply = true;
    lastFrameSentAt = Date.now();
    captureJpegBlobFromVideo((blob) => {
      if (!blob || !wsConn || wsConn.readyState !== WebSocket.OPEN) {
        awaitingServerReply = false;
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => {
          try {
            wsConn.send(buf);
          } catch {
            awaitingServerReply = false;
          }
        })
        .catch(() => {
          awaitingServerReply = false;
        });
    });
  }, 240);
}

function connectScannerWs() {
  if (wsRetryTimer) {
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  }

  const url = getScannerWsUrl();

  if (wsConn) {
    try {
      wsConn.onclose = null;
      wsConn.onerror = null;
      wsConn.close();
    } catch {
      // ignora
    }
    wsConn = null;
  }

  setScanStateBadge("Connessione...");
  setScannerConnectionUi("Avvio...", "connecting", true);

  const socket = new WebSocket(url);
  wsConn = socket;

  socket.onopen = () => {
    if (wsRetryTimer) {
      clearTimeout(wsRetryTimer);
      wsRetryTimer = null;
    }
    setScanStateBadge("Inquadra una carta");
    setScannerConnectionUi("Pronto", "connected", true);
    setStatus($("collection-status"), "");
    sendSetFilterToWs();
    startFrameLoop();
  };

  socket.onmessage = (ev) => {
    let payload = null;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      awaitingServerReply = false;
      return;
    }

    if (payload && payload.type === "filter_ack") {
      return;
    }

    if (payload && payload.type === "hello") {
      connectedServerVersion = payload.server_version || "";
      renderVersionBadge();
      return;
    }

    awaitingServerReply = false;
    if (pendingProposalCard) return;

    if (Date.now() < scanPauseUntil) {
      if (payload && payload.detected) {
        drawQuadOverlay(payload.quad, true);
      } else {
        drawQuadOverlay(null, false);
      }
      setScanStateBadge("Salvata! Cambia carta...");
      return;
    }

    if (!payload || !payload.detected) {
      drawQuadOverlay(null, false);
      if (lockedAfterConfirmCard) {
        unlockFramesCounter += 1;
        if (unlockFramesCounter >= 3) {
          lockedAfterConfirmCard = null;
          unlockFramesCounter = 0;
          setScanStateBadge("Inquadra la prossima carta");
        } else {
          setScanStateBadge("Cambia carta per proseguire");
        }
      } else {
        setScanStateBadge("Inquadra una carta");
      }
      return;
    }

    const matches = Array.isArray(payload.matches) ? payload.matches : [];

    if (lockedAfterConfirmCard) {
      const stillSameCard = matches.some((m) => {
        const idKey = String(m.scryfall_id || "").toLowerCase();
        const nameKey = String(m.name || "").toLowerCase();
        return (
          (lockedAfterConfirmCard.idKey && idKey === lockedAfterConfirmCard.idKey) ||
          (lockedAfterConfirmCard.nameKey && nameKey === lockedAfterConfirmCard.nameKey)
        );
      });

      if (stillSameCard) {
        unlockFramesCounter = 0;
        drawQuadOverlay(payload.quad, true);
        setScanStateBadge("Cambia carta per proseguire");
        return;
      }

      unlockFramesCounter += 1;
      if (unlockFramesCounter < 3) {
        drawQuadOverlay(payload.quad, false);
        setScanStateBadge("Cambia carta per proseguire");
        return;
      }

      lockedAfterConfirmCard = null;
      unlockFramesCounter = 0;
    }

    const filtered = matches.filter((m) => {
      const idKey = String(m.scryfall_id || "").toLowerCase();
      const nameKey = String(m.name || "").toLowerCase();
      return !rejectedCardKeys.has(idKey) && !rejectedCardKeys.has(nameKey);
    });

    drawQuadOverlay(payload.quad, filtered.length > 0);

    if (filtered.length > 0) {
      showCardProposal(filtered);
    } else {
      setScanStateBadge("Carta rilevata...");
    }
  };

  socket.onerror = () => {
    awaitingServerReply = false;
  };

  socket.onclose = () => {
    awaitingServerReply = false;
    stopFrameLoop();
    clearQuadOverlay();

    const isCollectionActive = $("tab-collection")?.classList.contains("active");
    if (isCollectionActive && cameraStream) {
      setScanStateBadge("Avvio in corso (~25s)...");
      setScannerConnectionUi("Avvio...", "connecting", true);
      wsRetryTimer = setTimeout(() => {
        if ($("tab-collection")?.classList.contains("active") && cameraStream) {
          connectScannerWs();
        }
      }, 4000);
    } else {
      setScannerConnectionUi("Offline", "disconnected", false);
      if (isCollectionActive && !pendingProposalCard) {
        setScanStateBadge("In pausa");
      }
    }
  };
}

// ---- PROPOSTA SÌ / NO ----
function applyMatchToProposal(matchItem) {
  if (!pendingProposalCard || !matchItem) return;
  pendingProposalCard.payload = matchItem;

  $("proposal-name").textContent = matchItem.name || "Carta";
  const confPct = matchItem.confidence ? ` · ${Math.round(matchItem.confidence * 100)}%` : "";
  $("proposal-meta").textContent =
    `${matchItem.set_code || ""}${matchItem.collector_number ? ` #${matchItem.collector_number}` : ""} · ${matchItem.set_name || ""}${confPct}`;

  const imgEl = $("proposal-img");
  if (matchItem.image_url) {
    imgEl.src = matchItem.image_url;
    imgEl.classList.remove("hidden");
  } else {
    imgEl.classList.add("hidden");
  }
}

function showCardProposal(matches) {
  const best = matches[0];
  if (!best) return;

  const idKey = String(best.scryfall_id || "").toLowerCase();
  const nameKey = String(best.name || "").toLowerCase();
  if (rejectedCardKeys.has(idKey) || rejectedCardKeys.has(nameKey)) return;

  pendingProposalCard = {
    payload: best,
    idKey,
    nameKey,
  };
  proposalMatches = matches;
  setScanStateBadge("Carta trovata");

  applyMatchToProposal(best);

  const sel = $("proposal-edition-select");
  sel.innerHTML = matches
    .map((m, idx) => {
      const code = (m.set_code || "").toUpperCase();
      const cn = m.collector_number ? `#${m.collector_number}` : "";
      const sname = m.set_name || code;
      const pct = m.confidence ? ` (${Math.round(m.confidence * 100)}%)` : "";
      return `<option value="${idx}">${escapeHtml(`${sname} [${code}] ${cn}${pct}`.trim())}</option>`;
    })
    .join("");
  sel.value = "0";

  $("proposal-modal")?.classList.remove("hidden");
}

$("proposal-edition-select")?.addEventListener("change", (e) => {
  const idx = parseInt(e.target.value, 10);
  if (!Number.isNaN(idx) && proposalMatches[idx]) {
    applyMatchToProposal(proposalMatches[idx]);
  }
});

function hideCardProposalAndResume() {
  pendingProposalCard = null;
  proposalMatches = [];
  clearQuadOverlay();
  $("proposal-modal")?.classList.add("hidden");
  setScanStateBadge(lockedAfterConfirmCard ? "Salvata! Cambia carta..." : "Inquadra una carta");
}

$("btn-proposal-no")?.addEventListener("click", () => {
  if (pendingProposalCard) {
    if (pendingProposalCard.idKey) rejectedCardKeys.add(pendingProposalCard.idKey);
    if (pendingProposalCard.nameKey) rejectedCardKeys.add(pendingProposalCard.nameKey);
    updateRejectedBadge();
  }
  setStatus($("collection-status"), "Scartata.", "");
  hideCardProposalAndResume();
});

$("btn-proposal-yes")?.addEventListener("click", async () => {
  if (!pendingProposalCard) return;
  const c = pendingProposalCard.payload;
  const confirmedLock = {
    idKey: String(c.scryfall_id || "").toLowerCase(),
    nameKey: String(c.name || "").toLowerCase(),
  };
  const isFoil = $("scan-finish-select")?.value === "foil";

  rejectedCardKeys.clear();
  updateRejectedBadge();

  try {
    setStatus($("collection-status"), `Salvataggio ${c.name}...`);
    await saveCardPayloadToCollection(c, isFoil);

    lockedAfterConfirmCard = confirmedLock;
    unlockFramesCounter = 0;
    scanPauseUntil = Date.now() + 1200;
    setStatus($("collection-status"), `${c.name} [${c.set_code}] aggiunta!`, "ok");
  } catch (err) {
    setStatus($("collection-status"), `Errore salvataggio: ${err.message}`, "err");
  } finally {
    hideCardProposalAndResume();
  }
});

$("btn-reset-rejected")?.addEventListener("click", () => {
  rejectedCardKeys.clear();
  updateRejectedBadge();
  setStatus($("collection-status"), "Carte scartate azzerate.", "ok");
});

async function ensureCameraAndWs() {
  bindSetSelectorUi();
  updateRejectedBadge();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus($("collection-status"), "Fotocamera non disponibile su questo browser.", "err");
    return;
  }

  if (!cameraStream) {
    try {
      setScanStateBadge("Avvio fotocamera...");
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      const video = $("scan-video");
      video.srcObject = cameraStream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play().catch(() => {});
      $("camera-placeholder")?.classList.add("hidden");
    } catch (err) {
      setScanStateBadge("Fotocamera bloccata");
      $("camera-placeholder")?.classList.remove("hidden");
      setScannerConnectionUi("Offline", "disconnected", false);
      setStatus($("collection-status"), `Errore fotocamera: ${err.message}`, "err");
      return;
    }
  }

  if (!wsConn || wsConn.readyState === WebSocket.CLOSED || wsConn.readyState === WebSocket.CLOSING) {
    connectScannerWs();
  } else if (wsConn.readyState === WebSocket.OPEN) {
    setScannerConnectionUi("Pronto", "connected", true);
    sendSetFilterToWs();
    startFrameLoop();
  }
}

$("btn-start-camera")?.addEventListener("click", ensureCameraAndWs);

$("btnToggleScanner")?.addEventListener("click", async () => {
  if (scannerActive) {
    stopScannerSession();
    setScanStateBadge("In pausa");
    setStatus($("collection-status"), "");
  } else {
    await ensureCameraAndWs();
  }
});

// Ripristina eventuale sessione già attiva
(async () => {
  const { data } = await sb.auth.getSession();
  if (data?.session?.user) {
    currentUser = data.session.user;
    onAuthenticated();
  }
})();

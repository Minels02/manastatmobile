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
const cardPriceCache = new Map();

// Configurazione Server Scanner
const SCANNER_HTTP_BASE = "https://manastat-scanner-server.onrender.com";
const DEFAULT_SCANNER_WS_URL = "wss://manastat-scanner-server.onrender.com/ws/scan";
const STORAGE_SETS_KEY = "manastat_scanner_selected_sets";

// Badge versione sempre visibile sopra la barra di navigazione
const APP_UI_VERSION = "v3.5";
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

const DEFAULT_TAG_PRESETS = [
  "#ramp",
  "#draw",
  "#removal",
  "#board-wipe",
  "#tutor",
  "#protection",
  "#finisher",
  "#synergy",
];

function normalizeTag(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, "-").replace(/^#+/, "").trim();
  return s ? `#${s.toLowerCase()}` : "";
}
function extractManaCostFromScryfall(sc) {
  const direct = String(sc?.mana_cost || "").trim();
  if (direct) return direct;
  if (Array.isArray(sc?.card_faces)) {
    return sc.card_faces
      .map((f) => String(f?.mana_cost || "").trim())
      .filter(Boolean)
      .join(" // ");
  }
  return "";
}

function extractOracleTextFromScryfall(sc) {
  const direct = String(sc?.oracle_text || "").trim();
  if (direct) return direct;
  if (Array.isArray(sc?.card_faces)) {
    return sc.card_faces
      .map((f) => String(f?.oracle_text || "").trim())
      .filter(Boolean)
      .join("\n//\n");
  }
  return "";
}

function resolveCardColorIdentity(card) {
  const order = ["W", "U", "B", "R", "G"];
  if (!card || typeof card !== "object") return [];

  if (Array.isArray(card.color_identity) && card.color_identity.length > 0) {
    const found = new Set(
      card.color_identity.map((c) => String(c || "").toUpperCase()).filter((c) => order.includes(c))
    );
    return order.filter((c) => found.has(c));
  }

  const found = new Set();
  if (Array.isArray(card.colors)) {
    card.colors.forEach((c) => {
      const u = String(c || "").toUpperCase();
      if (order.includes(u)) found.add(u);
    });
  }
  const txt = `${card.mana_cost || ""} ${card.oracle_text || ""}`;
  const tokens = txt.match(/\{([^}]+)\}/g) || [];
  for (const t of tokens) {
    for (const ch of t.slice(1, -1).toUpperCase()) {
      if (order.includes(ch)) found.add(ch);
    }
  }
  return order.filter((c) => found.has(c));
}

// ---- CHANGELOG COMPATIBILE CON APP DESKTOP (decks.changelog_json) ----
function parseChangeToken(token) {
  const s = String(token || "").trim();
  const m = s.match(/^(\d+)\s*x?\s+(.+)$/i);
  if (m) return { name: m[2].trim(), qty: Math.max(1, parseInt(m[1], 10)) };
  return { name: s, qty: 1 };
}

function formatCardQtyToken(cardName, qty) {
  return qty > 1 ? `${qty}x ${cardName}` : cardName;
}

function formatLocalNowTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function applyCardDeltaToChangelog(changelog, hist, cardName, oldQty, newQty) {
  const cleanName = String(cardName || "").trim();
  if (oldQty === newQty || !cleanName) {
    return (Array.isArray(changelog) ? changelog : []).map((e) => ({ ...e }));
  }

  const logs = (Array.isArray(changelog) ? changelog : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      ...e,
      added: Array.isArray(e.added) ? [...e.added] : [],
      removed: Array.isArray(e.removed) ? [...e.removed] : [],
      changed: Array.isArray(e.changed) ? [...e.changed] : [],
    }));

  let maxMatchDay = "";
  for (const r of hist || []) {
    const dStr = String(r?.played_on || "").slice(0, 10);
    if (dStr.length === 10 && dStr > maxMatchDay) maxMatchDay = dStr;
  }

  const nowTs = formatLocalNowTimestamp();
  const todayYmd = nowTs.slice(0, 10);

  let canMergeTop = false;
  if (logs.length > 0) {
    const top = logs[0];
    const topDay = String(top.timestamp || "").trim().slice(0, 10);
    const locked = Boolean(top.locked_by_match);
    if (!locked && topDay === todayYmd && (!maxMatchDay || topDay >= maxMatchDay)) {
      canMergeTop = true;
    }
  }

  let entry;
  if (canMergeTop) {
    entry = logs[0];
  } else {
    entry = { timestamp: nowTs, added: [], removed: [], changed: [] };
    logs.unshift(entry);
  }

  const key = cleanName.toLowerCase();
  const added = entry.added;
  const removed = entry.removed;
  const changed = entry.changed;

  const addIdx = added.findIndex((tok) => parseChangeToken(tok).name.toLowerCase() === key);
  if (addIdx >= 0) {
    if (newQty <= 0) added.splice(addIdx, 1);
    else added[addIdx] = formatCardQtyToken(cleanName, newQty);
  } else {
    const remIdx = removed.findIndex((tok) => parseChangeToken(tok).name.toLowerCase() === key);
    if (remIdx >= 0) {
      const origQty = parseChangeToken(removed[remIdx]).qty;
      removed.splice(remIdx, 1);
      if (newQty === origQty) {
        // Annullata (netto zero)
      } else if (newQty <= 0) {
        removed.push(formatCardQtyToken(cleanName, origQty));
      } else {
        changed.push(`${cleanName}: ${origQty} -> ${newQty}`);
      }
    } else {
      let chgIdx = -1;
      let origQty = oldQty;
      for (let i = 0; i < changed.length; i++) {
        const m = String(changed[i] || "").trim().match(/^(.+?):\s*(\d+)\s*(?:->|→)\s*(\d+)$/);
        if (m && m[1].trim().toLowerCase() === key) {
          chgIdx = i;
          origQty = Math.max(0, parseInt(m[2], 10));
          break;
        }
      }
      if (chgIdx >= 0) {
        changed.splice(chgIdx, 1);
        if (newQty === origQty) {
          // Annullata (netto zero)
        } else if (newQty <= 0) {
          removed.push(formatCardQtyToken(cleanName, origQty));
        } else if (origQty <= 0) {
          added.push(formatCardQtyToken(cleanName, newQty));
        } else {
          changed.push(`${cleanName}: ${origQty} -> ${newQty}`);
        }
      } else {
        if (oldQty <= 0 && newQty > 0) added.push(formatCardQtyToken(cleanName, newQty));
        else if (oldQty > 0 && newQty <= 0) removed.push(formatCardQtyToken(cleanName, oldQty));
        else changed.push(`${cleanName}: ${oldQty} -> ${newQty}`);
      }
    }
  }

  entry.timestamp = nowTs;
  if (!entry.added.length && !entry.removed.length && !entry.changed.length) {
    logs.shift();
  }
  return logs;
}
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

function isCommanderFormat(fmt) {
  const f = String(fmt || "").toLowerCase();
  return f.includes("commander") || f.includes("edh") || f.includes("brawl");
}

function extractScryfallEurPrice(sc, isFoil = false) {
  const prices = sc?.prices || {};
  const raw = isFoil ? (prices.eur_foil || prices.eur) : (prices.eur || prices.eur_foil);
  if (raw !== undefined && raw !== null && raw !== "") {
    const num = parseFloat(raw);
    if (!Number.isNaN(num)) return num;
  }
  const usd = isFoil ? (prices.usd_foil || prices.usd) : (prices.usd || prices.usd_foil);
  if (usd !== undefined && usd !== null && usd !== "") {
    const num = parseFloat(usd);
    if (!Number.isNaN(num)) return Math.round(num * 0.92 * 100) / 100;
  }
  return null;
}

function formatEur(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "—";
  return `€ ${Number(val).toFixed(2)}`;
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
      if (targetTab === "tab-my-collection" && typeof loadUserCollection === "function") {
        await loadUserCollection();
      } else if (targetTab === "tab-profile" && typeof loadProfile === "function") {
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
  if (typeof loadUserCollection === "function") tasks.push(loadUserCollection());
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

function toNormalCardUrl(url) {
  const u = String(url || "").trim();
  if (!u) return "";
  if (u.includes("/art_crop/")) return u.replace("/art_crop/", "/normal/");
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
    const cmd = deck.cards_json.find((c) => c && c.is_commander && c.name);
    if (cmd) candidates.unshift(cmd.name.trim());
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

// ---- CREATE NEW DECK (COMMANDER + PARTNER) ----
let newDeckSelectedCmd = null;
let newDeckSelectedPartner = null;
let newDeckActiveCmdSlot = 1; // 1 = Commander, 2 = Partner
let newDeckCmdResults = [];
let newDeckCmdTimer = null;

function toggleNewDeckCmdVisibility() {
  const fmt = $("new-deck-format")?.value || "";
  $("new-deck-cmd-section")?.classList.toggle("hidden", !isCommanderFormat(fmt));
}

function renderNewDeckCmdSlots() {
  const wrap = $("new-deck-cmd-slots");
  if (!wrap) return;

  const slot1Name = newDeckSelectedCmd?.name || "";
  const slot2Name = newDeckSelectedPartner?.name || "";

  wrap.innerHTML = `
    <div class="cmd-slot-card ${newDeckActiveCmdSlot === 1 ? "active" : ""}" onclick="selectNewDeckCmdSlot(1)">
      <div class="cmd-slot-top">
        <span class="cmd-slot-label">Commander</span>
        ${slot1Name ? `<button type="button" class="cmd-slot-clear" onclick="event.stopPropagation(); clearNewDeckCmdSlot(1)">×</button>` : ""}
      </div>
      <div class="cmd-slot-value ${slot1Name ? "" : "empty"}">${slot1Name ? `👑 ${escapeHtml(slot1Name)}` : "Tap to pick..."}</div>
    </div>
    <div class="cmd-slot-card ${newDeckActiveCmdSlot === 2 ? "active" : ""}" onclick="selectNewDeckCmdSlot(2)">
      <div class="cmd-slot-top">
        <span class="cmd-slot-label">Partner (opt.)</span>
        ${slot2Name ? `<button type="button" class="cmd-slot-clear" onclick="event.stopPropagation(); clearNewDeckCmdSlot(2)">×</button>` : ""}
      </div>
      <div class="cmd-slot-value ${slot2Name ? "" : "empty"}">${slot2Name ? `👑 ${escapeHtml(slot2Name)}` : "+ Add Partner"}</div>
    </div>
  `;

  const inp = $("new-deck-cmd-input");
  if (inp) {
    inp.placeholder = newDeckActiveCmdSlot === 1 ? "Search Commander..." : "Search Partner / Background...";
  }
}

window.selectNewDeckCmdSlot = function (slot) {
  newDeckActiveCmdSlot = slot === 2 ? 2 : 1;
  renderNewDeckCmdSlots();
  $("new-deck-cmd-input")?.focus();
};

window.clearNewDeckCmdSlot = function (slot) {
  if (slot === 1) {
    newDeckSelectedCmd = newDeckSelectedPartner;
    newDeckSelectedPartner = null;
    newDeckActiveCmdSlot = 1;
  } else {
    newDeckSelectedPartner = null;
    newDeckActiveCmdSlot = 2;
  }
  renderNewDeckCmdSlots();
};

window.pickNewDeckCmd = function (idx) {
  const sc = newDeckCmdResults[idx];
  if (!sc) return;

  const pickedName = String(sc.name || "").toLowerCase();
  if (newDeckActiveCmdSlot === 1) {
    if (newDeckSelectedPartner && String(newDeckSelectedPartner.name || "").toLowerCase() === pickedName) {
      newDeckSelectedPartner = null;
    }
    newDeckSelectedCmd = sc;
    if (!($("new-deck-name")?.value || "").trim()) {
      $("new-deck-name").value = sc.name || "";
    }
  } else {
    if (newDeckSelectedCmd && String(newDeckSelectedCmd.name || "").toLowerCase() === pickedName) {
      setStatus($("new-deck-cmd-status"), "Partner must be a different card.", "err");
      return;
    }
    if (!newDeckSelectedCmd) {
      newDeckSelectedCmd = sc;
    } else {
      newDeckSelectedPartner = sc;
    }
  }

  $("new-deck-cmd-results").innerHTML = "";
  setStatus($("new-deck-cmd-status"), "");
  if ($("new-deck-cmd-input")) $("new-deck-cmd-input").value = "";
  renderNewDeckCmdSlots();
};

async function searchNewDeckCommander() {
  const q = ($("new-deck-cmd-input")?.value || "").trim();
  const box = $("new-deck-cmd-results");
  if (q.length < 2) {
    newDeckCmdResults = [];
    box.innerHTML = "";
    setStatus($("new-deck-cmd-status"), "");
    return;
  }
  setStatus($("new-deck-cmd-status"), "Searching Scryfall...");
  try {
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`${q} is:commander`)}&unique=cards`
    );
    let json = resp.ok ? await resp.json() : null;
    if (!json || !json.data?.length) {
      const fb = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards`);
      json = fb.ok ? await fb.json() : { data: [] };
    }
    newDeckCmdResults = (json.data || []).slice(0, 12);
    if (!newDeckCmdResults.length) {
      box.innerHTML = "";
      setStatus($("new-deck-cmd-status"), "No cards found.");
      return;
    }
    setStatus($("new-deck-cmd-status"), "");
    const btnLabel = newDeckActiveCmdSlot === 2 ? "Set Partner" : "Select";
    box.innerHTML = newDeckCmdResults
      .map((c, i) => {
        const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || "";
        const price = extractScryfallEurPrice(c, false);
        return `
          <div class="deck-search-tile">
            ${img ? `<img class="deck-search-tile-img" src="${escapeHtml(img)}" alt="${escapeHtml(c.name || "")}" loading="lazy" />` : `<div class="deck-search-tile-img"></div>`}
            <div class="deck-search-tile-name">${escapeHtml(c.name || "")}</div>
            <div class="deck-search-tile-price">${formatEur(price)}</div>
            <button type="button" class="deck-add-btn" onclick="pickNewDeckCmd(${i})">${btnLabel}</button>
          </div>
        `;
      })
      .join("");
  } catch {
    setStatus($("new-deck-cmd-status"), "Scryfall connection error.", "err");
  }
}

$("btn-open-new-deck")?.addEventListener("click", () => {
  newDeckSelectedCmd = null;
  newDeckSelectedPartner = null;
  newDeckActiveCmdSlot = 1;
  newDeckCmdResults = [];
  if ($("new-deck-name")) $("new-deck-name").value = "";
  if ($("new-deck-format")) $("new-deck-format").value = "Commander";
  if ($("new-deck-cmd-input")) $("new-deck-cmd-input").value = "";
  if ($("new-deck-cmd-results")) $("new-deck-cmd-results").innerHTML = "";
  setStatus($("new-deck-cmd-status"), "");
  setStatus($("new-deck-status"), "");
  renderNewDeckCmdSlots();
  toggleNewDeckCmdVisibility();
  $("new-deck-modal")?.classList.remove("hidden");
});

$("new-deck-format")?.addEventListener("change", toggleNewDeckCmdVisibility);
$("btn-new-deck-cmd-search")?.addEventListener("click", searchNewDeckCommander);
$("new-deck-cmd-input")?.addEventListener("input", () => {
  clearTimeout(newDeckCmdTimer);
  newDeckCmdTimer = setTimeout(searchNewDeckCommander, 350);
});
$("btn-cancel-new-deck")?.addEventListener("click", () => {
  $("new-deck-modal")?.classList.add("hidden");
});

$("btn-create-new-deck")?.addEventListener("click", async () => {
  const name = ($("new-deck-name")?.value || "").trim();
  const fmt = $("new-deck-format")?.value || "Commander";
  if (!name) {
    setStatus($("new-deck-status"), "Please enter a deck name.", "err");
    return;
  }

  setStatus($("new-deck-status"), "Creating deck...");
  const insertPayload = {
    owner_id: currentUser.id,
    name,
    type: fmt,
    format: fmt,
  };

  let { data, error } = await sb.from("decks").insert(insertPayload).select("*").single();
  if (error) {
    const fb = await sb
      .from("decks")
      .insert({ owner_id: currentUser.id, name, type: fmt })
      .select("*")
      .single();
    data = fb.data;
    error = fb.error;
  }

  if (error || !data) {
    setStatus($("new-deck-status"), error?.message || "Failed to create deck.", "err");
    return;
  }

  const createdDeck = data;
  const chosenCommanders = [newDeckSelectedCmd, newDeckSelectedPartner].filter(Boolean);

  if (chosenCommanders.length > 0 && isCommanderFormat(fmt)) {
    const dbRows = [];
    const cardsJson = [];
    let heroArtUrl = "";

    for (const sc of chosenCommanders) {
      const normalUrl = sc.image_uris?.normal || sc.card_faces?.[0]?.image_uris?.normal || "";
      const artUrl = sc.image_uris?.art_crop || sc.card_faces?.[0]?.image_uris?.art_crop || normalUrl;
      if (!heroArtUrl && artUrl) heroArtUrl = artUrl;
      const manaCost = extractManaCostFromScryfall(sc);
      const oracleText = extractOracleTextFromScryfall(sc);
      const colorIdentity = resolveCardColorIdentity({
        color_identity: sc.color_identity,
        colors: sc.colors,
        mana_cost: manaCost,
        oracle_text: oracleText,
      });
      const priceEur = extractScryfallEurPrice(sc, false);
      const setLower = String(sc.set || "").trim().toLowerCase();

      dbRows.push({
        deck_id: createdDeck.id,
        scryfall_id: sc.id || "",
        name: sc.name || "",
        type_line: sc.type_line || "",
        oracle_text: oracleText,
        mana_cost: manaCost,
        image_url: normalUrl,
        quantity: 1,
        is_commander: true,
      });

      cardsJson.push({
        scryfall_id: sc.id || "",
        name: sc.name || "",
        type_line: sc.type_line || "",
        oracle_text: oracleText,
        mana_cost: manaCost,
        image_url: artUrl,
        card_image_url: normalUrl,
        color_identity: colorIdentity,
        set: setLower,
        set_code: setLower.toUpperCase(),
        set_name: sc.set_name || "",
        collector_number: sc.collector_number || "",
        foil: false,
        price_eur: priceEur,
        quantity: 1,
        is_commander: true,
        is_proxy: false,
        tags: [],
      });
    }

    await sb.from("deck_cards").insert(dbRows);

    const { error: updErr } = await sb
      .from("decks")
      .update({ cards_json: cardsJson, bg_image_url: heroArtUrl })
      .eq("id", createdDeck.id);
    if (updErr) {
      await sb.from("decks").update({ cards_json: cardsJson }).eq("id", createdDeck.id);
    }
  }

  $("new-deck-modal")?.classList.add("hidden");
  await loadDecks();
  openDeckDetail(createdDeck.id);
});

// ---- DECKS PAGE ----
async function loadDecks() {
  setStatus($("deck-list-status"), "Loading decks...");
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
    return ka[2].localeCompare(kb[2], "en");
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

let decksFormatFilter = "ALL";

function getDeckFormatLabel(deck) {
  return String(deck.format || deck.type || "Other").trim() || "Other";
}

function renderDecksFormatFilter() {
  const bar = $("decks-format-filter");
  if (!bar) return;

  const formatsPresent = [];
  const seen = new Set();
  for (const d of myDecks) {
    const f = getDeckFormatLabel(d);
    if (!seen.has(f)) {
      seen.add(f);
      formatsPresent.push(f);
    }
  }

  if (formatsPresent.length <= 1) {
    decksFormatFilter = "ALL";
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }

  if (decksFormatFilter !== "ALL" && !seen.has(decksFormatFilter)) {
    decksFormatFilter = "ALL";
  }

  bar.classList.remove("hidden");
  const pills = ["ALL", ...formatsPresent];
  bar.innerHTML = pills
    .map((fmt) => {
      const label = fmt === "ALL" ? "All" : fmt;
      const active = decksFormatFilter === fmt ? "active" : "";
      return `<button type="button" class="format-pill ${active}" onclick="setDecksFormatFilter('${escapeHtml(fmt)}')">${escapeHtml(label)}</button>`;
    })
    .join("");
}

window.setDecksFormatFilter = function (fmt) {
  decksFormatFilter = fmt;
  renderDecksList();
};

function renderDecksList() {
  renderDecksFormatFilter();
  const container = $("decks-list-container");
  if (!myDecks.length) {
    container.innerHTML = `<p class="muted">No decks found on your account. Tap + at the top right to create one.</p>`;
    return;
  }

  const visible =
    decksFormatFilter === "ALL"
      ? myDecks
      : myDecks.filter((d) => getDeckFormatLabel(d) === decksFormatFilter);

  if (!visible.length) {
    container.innerHTML = `<p class="muted">No decks in this format.</p>`;
    return;
  }

  const groups = [];
  const byFmt = new Map();
  for (const d of visible) {
    const f = getDeckFormatLabel(d);
    if (!byFmt.has(f)) {
      const arr = [];
      byFmt.set(f, arr);
      groups.push({ fmt: f, decks: arr });
    }
    byFmt.get(f).push(d);
  }

  const showDividers = groups.length > 1 || decksFormatFilter === "ALL";

  container.innerHTML = groups
    .map((g) => {
      const dividerHtml = showDividers
        ? `
            <div class="decks-format-divider">
              <span class="decks-format-divider-label">${escapeHtml(g.fmt)}</span>
              <span class="decks-format-divider-line"></span>
              <span class="decks-format-divider-count">${g.decks.length}</span>
            </div>
          `
        : "";

      const cardsHtml = g.decks
        .map((d) => {
          const bg = extractDeckImageUrl(d) || d._resolvedArtUrl || "";
          const bgStyle = bg ? `style="background-image: url('${escapeHtml(bg)}');"` : "";
          const fmtText = getDeckFormatLabel(d);
          return `
            <button type="button" class="deck-banner-card" data-deck-card-id="${escapeHtml(d.id)}" ${bgStyle} onclick="openDeckDetail('${escapeHtml(d.id)}')">
              <div class="deck-banner-content">
                <div>
                  <div class="deck-banner-title">${escapeHtml(d.name || "Untitled")}</div>
                  <div class="deck-banner-sub">${escapeHtml(fmtText)}</div>
                </div>
                <div class="deck-banner-arrow">›</div>
              </div>
            </button>
          `;
        })
        .join("");

      return `${dividerHtml}${cardsHtml}`;
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
let currentDeckChangelog = [];
let deckGroupMode = "type"; // "type" | "tag"
let deckViewMode = "list";  // "list" | "grid"
let deckSortMode = "alpha"; // "alpha" | "cmc" | "price"

document.querySelectorAll(".deck-subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.subtab;
    document.querySelectorAll(".deck-subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".deck-subpanel").forEach((p) => {
      p.classList.toggle("hidden", p.id !== targetId);
      p.classList.toggle("active", p.id === targetId);
    });
    if (targetId === "deck-sub-stats") {
      const scroller = $("deck-trend-scroll");
      if (scroller) scroller.scrollLeft = scroller.scrollWidth;
    }
  });
});

function switchDeckSubtab(targetId) {
  const btn = document.querySelector(`.deck-subtab-btn[data-subtab="${targetId}"]`);
  if (btn) btn.click();
}

$("btn-group-type")?.addEventListener("click", () => {
  deckGroupMode = "type";
  $("btn-group-type").classList.add("active");
  $("btn-group-tag").classList.remove("active");
  renderDeckCardsList(currentDeckCards);
});

$("btn-group-tag")?.addEventListener("click", () => {
  deckGroupMode = "tag";
  $("btn-group-tag").classList.add("active");
  $("btn-group-type").classList.remove("active");
  renderDeckCardsList(currentDeckCards);
});

$("deck-sort-select")?.addEventListener("change", (e) => {
  deckSortMode = e.target.value || "alpha";
  renderDeckCardsList(currentDeckCards);
});

$("btn-view-list")?.addEventListener("click", () => {
  deckViewMode = "list";
  $("btn-view-list").classList.add("active");
  $("btn-view-grid").classList.remove("active");
  renderDeckCardsList(currentDeckCards);
});

$("btn-view-grid")?.addEventListener("click", () => {
  deckViewMode = "grid";
  $("btn-view-grid").classList.add("active");
  $("btn-view-list").classList.remove("active");
  renderDeckCardsList(currentDeckCards);
});

window.openDeckDetail = async function (deckId) {
  const deck = myDecks.find((d) => String(d.id) === String(deckId));
  if (!deck) return;

  selectedDeckId = deck.id;
  currentDeckChangelog = Array.isArray(deck.changelog_json)
    ? deck.changelog_json.map((e) => ({ ...e }))
    : [];
  const fmt = deck.format || deck.type || "Deck";
  $("deck-detail-title").textContent = deck.name || "Untitled";
  $("deck-detail-format").textContent = fmt;
  $("deck-detail-count").textContent = "";
  $("deck-detail-price")?.classList.add("hidden");
  applyDeckHeroBg(extractDeckImageUrl(deck) || deck._resolvedArtUrl || "");
  setStatus($("deck-status"), "");
  $("deck-search-dropdown")?.classList.add("hidden");

  $("decks-list-view").classList.add("hidden");
  $("deck-detail-view").classList.remove("hidden");
  switchDeckSubtab("deck-sub-stats");

  await Promise.all([
    loadDeckHistory(deck.id),
    loadDeckCards(deck),
  ]);
};

$("btn-back-to-decks")?.addEventListener("click", () => {
  selectedDeckId = null;
  currentDeckChangelog = [];
  currentDeckHistory = [];
  currentDeckCards = [];
  $("deck-search-dropdown")?.classList.add("hidden");
  $("deck-detail-view").classList.add("hidden");
  $("decks-list-view").classList.remove("hidden");
});

$("btn-delete-deck")?.addEventListener("click", async () => {
  if (!selectedDeckId) return;
  const deck = myDecks.find((d) => String(d.id) === String(selectedDeckId));
  const dName = deck?.name || "this deck";
  if (!confirm(`Permanently delete "${dName}"? All cards and match history will be removed.`)) {
    return;
  }

  const targetId = selectedDeckId;
  await sb.from("deck_history").delete().eq("deck_id", targetId);
  await sb.from("deck_cards").delete().eq("deck_id", targetId);
  const { error } = await sb.from("decks").delete().eq("id", targetId);

  if (error) {
    alert(`Failed to delete deck: ${error.message}`);
    return;
  }

  selectedDeckId = null;
  currentDeckChangelog = [];
  currentDeckHistory = [];
  currentDeckCards = [];
  $("deck-detail-view").classList.add("hidden");
  $("decks-list-view").classList.remove("hidden");
  await loadDecks();
});

// ---- STATS & MATCH HISTORY (deck_history) ----
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
  renderWinLossPie(totalWins, totalLosses);
  renderWinrateTrend();
}

function renderWinLossPie(wins, losses) {
  const box = $("deck-pie-container");
  const total = wins + losses;
  if (!total) {
    box.innerHTML = `<p class="muted">No matches logged yet.</p>`;
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
        <div><span class="legend-dot" style="background:#22c55e"></span>Wins: <strong>${wins}</strong></div>
        <div><span class="legend-dot" style="background:#ef4444"></span>Losses: <strong>${losses}</strong></div>
        <div class="muted" style="font-size:12px;">Total matches: <strong>${total}</strong></div>
      </div>
    </div>
  `;
}

let trendChartPoints = [];
let selectedTrendIdx = -1;

function formatShortDateIt(ymd) {
  const parts = String(ymd || "").slice(0, 10).split("-");
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}`;
}

function formatFullDateIt(ymd) {
  const parts = String(ymd || "").slice(0, 10).split("-");
  if (parts.length !== 3) return ymd;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function updateTrendDetailBar(idx) {
  const bar = $("deck-trend-detail");
  if (!bar) return;
  const p = trendChartPoints[idx];
  if (!p) {
    bar.innerHTML = `<span class="muted">No data available</span>`;
    return;
  }
  bar.innerHTML = `
    <span><strong>${escapeHtml(formatFullDateIt(p.day))}</strong> · ${p.dayW}W/${p.dayM}M</span>
    <span class="trend-detail-wr">Total: ${p.cumW}W/${p.cumM}M (${Math.round(p.wr)}%)</span>
  `;
}

window.selectTrendPoint = function (idx) {
  if (idx < 0 || idx >= trendChartPoints.length) return;
  selectedTrendIdx = idx;
  renderWinrateTrendSvg(false);
  updateTrendDetailBar(idx);
};

function renderWinrateTrend() {
  const box = $("deck-trend-container");
  const bar = $("deck-trend-detail");
  const shell = $("deck-trend-shell");

  if (!currentDeckHistory.length) {
    trendChartPoints = [];
    selectedTrendIdx = -1;
    if (bar) bar.innerHTML = `<span class="muted">Log at least one session</span>`;
    if (shell) shell.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  if (shell) shell.classList.remove("hidden");

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
  trendChartPoints = days.map((day) => {
    const d = byDay.get(day);
    cumM += d.m;
    cumW += d.w;
    return {
      day,
      dayM: d.m,
      dayW: d.w,
      cumM,
      cumW,
      wr: cumM > 0 ? (cumW / cumM) * 100 : 0,
    };
  });

  selectedTrendIdx = trendChartPoints.length - 1;
  renderWinrateTrendSvg(true);
  updateTrendDetailBar(selectedTrendIdx);
}

function renderWinrateTrendSvg(autoScrollToEnd = false) {
  const box = $("deck-trend-container");
  const scroller = $("deck-trend-scroll");
  const points = trendChartPoints;
  if (!points.length || !box) return;

  const prevScrollLeft = scroller ? scroller.scrollLeft : 0;

  const visibleW = Math.max(240, scroller ? scroller.clientWidth : 280);
  const padL = 18;
  const padR = 18;
  const padT = 12;
  const padB = 22;
  const H = 132;
  const plotH = H - padT - padB;

  const stepX = points.length <= 10
    ? (points.length === 1 ? 0 : (visibleW - padL - padR) / (points.length - 1))
    : Math.max(30, (visibleW - padL - padR) / 9);

  const W = points.length <= 10
    ? visibleW
    : Math.round(padL + padR + (points.length - 1) * stepX);

  const coords = points.map((p, i) => {
    const x = points.length === 1 ? W / 2 : padL + i * stepX;
    const y = padT + plotH - (p.wr / 100) * plotH;
    return { x, y, ...p };
  });

  const gridHtml = [0, 50, 100]
    .map((pct) => {
      const y = padT + plotH - (pct / 100) * plotH;
      const dash = pct === 50
        ? `stroke-dasharray="4,3" stroke="rgba(148,163,184,0.35)"`
        : `stroke="rgba(255,255,255,0.08)"`;
      return `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" ${dash} />`;
    })
    .join("");

  let lastLabelX = -999;
  const xLabelsHtml = coords
    .map((c, i) => {
      const isEdge = i === 0 || i === coords.length - 1;
      if (!isEdge && c.x - lastLabelX < 44) return "";
      if (isEdge && i === coords.length - 1 && c.x - lastLabelX < 32) return "";
      lastLabelX = c.x;
      return `<text x="${c.x.toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="#94a3b8" font-size="9">${escapeHtml(formatShortDateIt(c.day))}</text>`;
    })
    .join("");

  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const areaPath =
    points.length > 1
      ? `M ${coords[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} L ${coords
          .map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`)
          .join(" L ")} L ${coords[coords.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`
      : "";

  const selectedC = coords[selectedTrendIdx];
  const guideLine = selectedC
    ? `<line x1="${selectedC.x.toFixed(1)}" y1="${padT}" x2="${selectedC.x.toFixed(1)}" y2="${padT + plotH}" stroke="rgba(56,189,248,0.45)" stroke-dasharray="3,3" />`
    : "";

  const dotsHtml = coords
    .map((c, i) => {
      const isSel = i === selectedTrendIdx;
      const r = isSel ? 5 : 3.2;
      const fill = isSel ? "#ffffff" : "#22c55e";
      const stroke = isSel ? "#38bdf8" : "#0f172a";
      return `
        <g onclick="selectTrendPoint(${i})" style="cursor:pointer;">
          <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="14" fill="transparent"></circle>
          <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="2"></circle>
        </g>
      `;
    })
    .join("");

  box.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;">
      <defs>
        <linearGradient id="wrAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#22c55e" stop-opacity="0.30" />
          <stop offset="100%" stop-color="#22c55e" stop-opacity="0.02" />
        </linearGradient>
      </defs>
      ${gridHtml}
      ${areaPath ? `<path d="${areaPath}" fill="url(#wrAreaGrad)" />` : ""}
      ${points.length > 1 ? `<polyline fill="none" stroke="#22c55e" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${polyline}" />` : ""}
      ${guideLine}
      ${dotsHtml}
      ${xLabelsHtml}
    </svg>
  `;

  if (scroller) {
    if (autoScrollToEnd) {
      scroller.scrollLeft = scroller.scrollWidth;
    } else {
      scroller.scrollLeft = prevScrollLeft;
    }
  }
}

function renderDeckHistoryList() {
  const container = $("deck-history-list");
  if (!currentDeckHistory.length) {
    container.innerHTML = `<p class="muted">No sessions logged for this deck yet.</p>`;
    return;
  }

  const reversed = currentDeckHistory.slice().reverse();
  container.innerHTML = reversed
    .map((r) => {
      const m = Math.max(0, Number(r.match || 0));
      const w = Math.max(0, Math.min(Number(r.win || 0), m));
      const wr = m > 0 ? Math.round((w / m) * 100) : 0;
      const dateStr = formatFullDateIt(String(r.played_on || "").slice(0, 10));
      return `
        <div class="history-row">
          <div>
            <div class="history-score">${w}W / ${m}M (${wr}%)</div>
            <div class="history-date">${escapeHtml(dateStr)}</div>
          </div>
          <button type="button" class="history-del-btn" onclick="deleteDeckHistoryEntry('${escapeHtml(r.id)}')">Delete</button>
        </div>
      `;
    })
    .join("");
}

window.deleteDeckHistoryEntry = async function (entryId) {
  if (!entryId || !confirm("Delete this session?")) return;
  const { error } = await sb.from("deck_history").delete().eq("id", entryId);
  if (error) {
    setStatus($("deck-status"), error.message, "err");
    return;
  }
  await loadDeckHistory(selectedDeckId);
};

$("btn-save-deck-match")?.addEventListener("click", async () => {
  const matches = Math.max(1, parseInt($("deck-matches").value || "1", 10));
  const wins = Math.max(0, Math.min(parseInt($("deck-wins").value || "0", 10), matches));
  const playedOn = $("deck-date").value || new Date().toISOString().slice(0, 10);

  if (!selectedDeckId) {
    setStatus($("deck-status"), "Select a deck first.", "err");
    return;
  }

  setStatus($("deck-status"), "Saving...");

  const sameDayRows = currentDeckHistory.filter(
    (r) => String(r.played_on || "").slice(0, 10) === playedOn
  );

  let saveError = null;
  if (sameDayRows.length > 0) {
    const primary = sameDayRows[0];
    const existingM = sameDayRows.reduce((s, r) => s + Math.max(0, Number(r.match || 0)), 0);
    const existingW = sameDayRows.reduce(
      (s, r) => s + Math.max(0, Math.min(Number(r.win || 0), Number(r.match || 0))),
      0
    );

    const { error } = await sb
      .from("deck_history")
      .update({
        match: existingM + matches,
        win: existingW + wins,
      })
      .eq("id", primary.id);
    saveError = error;

    if (!saveError && sameDayRows.length > 1) {
      const extraIds = sameDayRows.slice(1).map((r) => r.id).filter(Boolean);
      if (extraIds.length) {
        await sb.from("deck_history").delete().in("id", extraIds);
      }
    }
  } else {
    const { error } = await sb.from("deck_history").insert({
      deck_id: selectedDeckId,
      user_id: currentUser.id,
      played_on: playedOn,
      match: matches,
      win: wins,
    });
    saveError = error;
  }

  if (saveError) {
    setStatus($("deck-status"), saveError.message, "err");
    return;
  }

  if (currentDeckChangelog.length > 0 && !currentDeckChangelog[0].locked_by_match) {
    currentDeckChangelog[0] = { ...currentDeckChangelog[0], locked_by_match: true };
    const deck = myDecks.find((d) => String(d.id) === String(selectedDeckId));
    if (deck) deck.changelog_json = currentDeckChangelog;
    await sb.from("decks").update({ changelog_json: currentDeckChangelog }).eq("id", selectedDeckId);
  }

  $("deck-wins").value = "0";
  setStatus(
    $("deck-status"),
    sameDayRows.length > 0 ? "Daily session updated!" : "Match saved!",
    "ok"
  );
  await loadDeckHistory(selectedDeckId);
});

// ---- MANA SVG, CARD LIST, PRICES, TAGS, PROXY & GRID ----
let deckSearchResults = [];
let deckSearchTimer = null;
let changeCmdResults = [];
let activeDetailCardIdx = -1;
let activeCardPrints = [];

function manaSymbolToSvgUrl(sym) {
  const clean = String(sym || "").toUpperCase().replaceAll("/", "");
  return `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(clean)}.svg`;
}

function renderManaPipsHtml(manaCost) {
  const raw = String(manaCost || "");
  const tokens = raw.match(/\{([^}]+)\}/g) || [];
  return tokens
    .map((t) => {
      const sym = t.slice(1, -1).toUpperCase();
      const url = manaSymbolToSvgUrl(sym);
      return `<img class="mana-svg" src="${url}" alt="{${escapeHtml(sym)}}" loading="lazy" />`;
    })
    .join("");
}

function extractCommanderColorIdentity(cards) {
  const order = ["W", "U", "B", "R", "G"];
  const commanders = (cards || []).filter((c) => c && c.is_commander);
  if (!commanders.length) return [];

  const found = new Set();
  for (const cmd of commanders) {
    if (Array.isArray(cmd.color_identity) && cmd.color_identity.length > 0) {
      cmd.color_identity.forEach((col) => {
        const u = String(col || "").toUpperCase();
        if (order.includes(u)) found.add(u);
      });
    } else {
      const txt = `${cmd.mana_cost || ""} ${cmd.oracle_text || ""}`;
      const tokens = txt.match(/\{([^}]+)\}/g) || [];
      for (const t of tokens) {
        for (const ch of t.slice(1, -1).toUpperCase()) {
          if (order.includes(ch)) found.add(ch);
        }
      }
    }
  }
  const ordered = order.filter((c) => found.has(c));
  return ordered.length ? ordered : ["C"];
}

function updateDeckCommanderCiUi() {
  const ci = extractCommanderColorIdentity(currentDeckCards);
  const ciEl = $("deck-detail-ci");
  if (ciEl) {
    ciEl.innerHTML = ci
      .map((sym) => `<img class="mana-svg" src="${manaSymbolToSvgUrl(sym)}" alt="${sym}" />`)
      .join("");
  }
}

function mergeDeckCardsWithJson(dbRows, jsonRows) {
  const jsonById = new Map();
  const jsonByName = new Map();
  if (Array.isArray(jsonRows)) {
    for (const jc of jsonRows) {
      if (!jc || typeof jc !== "object") continue;
      if (jc.scryfall_id) jsonById.set(String(jc.scryfall_id), jc);
      if (jc.name) jsonByName.set(String(jc.name).toLowerCase(), jc);
    }
  }

  const normalizeTagsList = (rawTags) => {
    const arr = Array.isArray(rawTags) ? rawTags : [];
    return Array.from(new Set(arr.map(normalizeTag).filter(Boolean)));
  };

  if (Array.isArray(dbRows) && dbRows.length > 0) {
    return dbRows.map((r) => {
      const meta =
        (r.scryfall_id && jsonById.get(String(r.scryfall_id))) ||
        (r.name && jsonByName.get(String(r.name).toLowerCase())) ||
        {};
      const setCode = String(meta.set || meta.set_code || "").trim().toLowerCase();
      const merged = {
        ...meta,
        ...r,
        mana_cost: r.mana_cost || meta.mana_cost || "",
        oracle_text: r.oracle_text || meta.oracle_text || "",
        card_image_url: meta.card_image_url || toNormalCardUrl(r.image_url || ""),
        set: setCode,
        set_code: setCode.toUpperCase(),
        set_name: meta.set_name || "",
        collector_number: meta.collector_number || "",
        foil: Boolean(meta.foil),
        price_eur: meta.price_eur ?? null,
        is_proxy: Boolean(meta.is_proxy ?? meta.proxy),
        tags: normalizeTagsList(meta.tags),
      };
      merged.color_identity = resolveCardColorIdentity(merged);
      return merged;
    });
  }

  if (Array.isArray(jsonRows) && jsonRows.length > 0) {
    return jsonRows.map((jc) => {
      const setCode = String(jc.set || jc.set_code || "").trim().toLowerCase();
      const merged = {
        ...jc,
        card_image_url: jc.card_image_url || toNormalCardUrl(jc.image_url || ""),
        set: setCode,
        set_code: setCode.toUpperCase(),
        set_name: jc.set_name || "",
        collector_number: jc.collector_number || "",
        foil: Boolean(jc.foil),
        price_eur: jc.price_eur ?? null,
        is_proxy: Boolean(jc.is_proxy ?? jc.proxy),
        tags: normalizeTagsList(jc.tags),
      };
      merged.color_identity = resolveCardColorIdentity(merged);
      return merged;
    });
  }

  return [];
}

async function syncDeckCardsJson(deckId, extraFields = {}) {
  const deck = myDecks.find((d) => String(d.id) === String(deckId));
  const payload = currentDeckCards.map((c) => {
    const setLower = String(c.set || c.set_code || "").trim().toLowerCase();
    return {
      scryfall_id: c.scryfall_id || "",
      name: c.name || "",
      type_line: c.type_line || "",
      oracle_text: c.oracle_text || "",
      mana_cost: c.mana_cost || "",
      image_url: c.image_url || "",
      card_image_url: c.card_image_url || toNormalCardUrl(c.image_url || ""),
      color_identity: resolveCardColorIdentity(c),
      set: setLower,
      set_code: setLower.toUpperCase(),
      set_name: c.set_name || "",
      collector_number: c.collector_number || "",
      foil: Boolean(c.foil),
      price_eur: c.price_eur ?? null,
      quantity: Math.max(1, Number(c.quantity || 1)),
      is_commander: Boolean(c.is_commander),
      is_proxy: Boolean(c.is_proxy),
      tags: Array.from(new Set((Array.isArray(c.tags) ? c.tags : []).map(normalizeTag).filter(Boolean))),
    };
  });

  if (deck) {
    deck.cards_json = payload;
    deck.changelog_json = currentDeckChangelog;
    if (extraFields.bg_image_url) deck.bg_image_url = extraFields.bg_image_url;
  }

  const updateBody = {
    cards_json: payload,
    changelog_json: currentDeckChangelog,
    ...extraFields,
  };

  const { error } = await sb.from("decks").update(updateBody).eq("id", deckId);
  if (error) {
    await sb
      .from("decks")
      .update({ cards_json: payload, changelog_json: currentDeckChangelog })
      .eq("id", deckId);
  }
}

async function loadDeckCards(deck) {
  setStatus($("deck-cards-status"), "Loading card list...");
  $("deck-cards-list").innerHTML = "";
  $("deck-search-results").innerHTML = "";
  $("deck-search-dropdown")?.classList.add("hidden");
  setStatus($("deck-search-status"), "");
  if ($("deck-card-search-input")) $("deck-card-search-input").value = "";

  const { data, error } = await sb
    .from("deck_cards")
    .select("id, name, type_line, oracle_text, mana_cost, image_url, quantity, is_commander, scryfall_id")
    .eq("deck_id", deck.id);

  currentDeckCards = mergeDeckCardsWithJson(error ? [] : data, deck.cards_json);
  updateDeckCardCountAndCi();
  setStatus($("deck-cards-status"), "");
  renderDeckCardsList(currentDeckCards);

  fetchMissingDeckPrices(deck.id);
}

async function fetchMissingDeckPrices(deckId) {
  const missing = [];
  for (const c of currentDeckCards) {
    const key = String(c.scryfall_id || c.name || "").toLowerCase();
    if (c.price_eur !== null && c.price_eur !== undefined) continue;
    if (cardPriceCache.has(key)) {
      c.price_eur = cardPriceCache.get(key);
      continue;
    }
    missing.push(c);
  }

  updateDeckTotalPriceBadge();
  if (!missing.length) {
    renderDeckCardsList(currentDeckCards);
    return;
  }

  for (let i = 0; i < missing.length; i += 75) {
    if (selectedDeckId !== deckId) return;
    const chunk = missing.slice(i, i + 75);
    const identifiers = chunk
      .map((c) => {
        if (c.scryfall_id && /^[0-9a-f-]{36}$/i.test(c.scryfall_id)) {
          return { id: c.scryfall_id };
        }
        const cleanName = String(c.name || "").split("//")[0].trim();
        return cleanName ? { name: cleanName } : null;
      })
      .filter(Boolean);

    if (!identifiers.length) continue;

    try {
      const resp = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers }),
      });
      if (!resp.ok) continue;
      const body = await resp.json();
      const byId = new Map();
      const byName = new Map();
      for (const sc of body.data || []) {
        const p = extractScryfallEurPrice(sc, false);
        if (sc.id) byId.set(String(sc.id), { p, sc });
        if (sc.name) {
          byName.set(String(sc.name).toLowerCase(), { p, sc });
          byName.set(String(sc.name).split("//")[0].trim().toLowerCase(), { p, sc });
        }
      }

      for (const c of chunk) {
        const hit =
          (c.scryfall_id && byId.get(String(c.scryfall_id))) ||
          byName.get(String(c.name || "").toLowerCase()) ||
          byName.get(String(c.name || "").split("//")[0].trim().toLowerCase());
        if (hit) {
          c.price_eur = hit.p;
          if (!c.card_image_url) {
            c.card_image_url =
              hit.sc.image_uris?.normal || hit.sc.card_faces?.[0]?.image_uris?.normal || "";
          }
          if (!c.set_code && hit.sc.set) {
            c.set = hit.sc.set.toLowerCase();
            c.set_code = hit.sc.set.toUpperCase();
          }
          if (!c.set_name && hit.sc.set_name) c.set_name = hit.sc.set_name;
          if (!c.collector_number && hit.sc.collector_number) c.collector_number = hit.sc.collector_number;
          if ((!c.color_identity || !c.color_identity.length) && Array.isArray(hit.sc.color_identity)) {
            c.color_identity = hit.sc.color_identity;
          }
          const key = String(c.scryfall_id || c.name || "").toLowerCase();
          cardPriceCache.set(key, hit.p);
        }
      }
    } catch {
      // ignore
    }
  }

  if (selectedDeckId === deckId) {
    updateDeckCardCountAndCi();
    renderDeckCardsList(currentDeckCards);
  }
}

function updateDeckTotalPriceBadge() {
  const badge = $("deck-detail-price");
  if (!badge) return;
  let total = 0;
  let hasAny = false;
  for (const c of currentDeckCards) {
    if (c.is_proxy) continue;
    if (c.price_eur !== null && c.price_eur !== undefined && !Number.isNaN(Number(c.price_eur))) {
      total += Number(c.price_eur) * Math.max(1, Number(c.quantity || 1));
      hasAny = true;
    }
  }
  if (hasAny) {
    badge.textContent = `€ ${total.toFixed(2)}`;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function updateDeckCardCountAndCi() {
  const totalCount = currentDeckCards.reduce((acc, c) => acc + Math.max(1, Number(c.quantity || 1)), 0);
  $("deck-detail-count").textContent = totalCount > 0 ? `${totalCount} cards` : "";
  updateDeckTotalPriceBadge();
  updateDeckCommanderCiUi();
}

function getCardCategory(card) {
  if (card.is_commander) return "Commander";
  const tl = String(card.type_line || "").toLowerCase();
  if (tl.includes("creature")) return "Creatures";
  if (tl.includes("planeswalker")) return "Planeswalkers";
  if (tl.includes("instant")) return "Instants";
  if (tl.includes("sorcery")) return "Sorceries";
  if (tl.includes("artifact")) return "Artifacts";
  if (tl.includes("enchantment")) return "Enchantments";
  if (tl.includes("battle")) return "Battles";
  if (tl.includes("land")) return "Lands";
  return "Other";
}

function buildGroupedDeckSections(cards) {
  const groups = new Map();

  if (deckGroupMode === "tag") {
    cards.forEach((c, idx) => {
      const item = { ...c, _idx: idx };
      if (c.is_commander) {
        if (!groups.has("Commander")) groups.set("Commander", []);
        groups.get("Commander").push(item);
        return;
      }
      const tags = Array.isArray(c.tags) && c.tags.length > 0 ? c.tags : ["Untagged"];
      tags.forEach((tg) => {
        if (!groups.has(tg)) groups.set(tg, []);
        groups.get(tg).push(item);
      });
    });

    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (a === "Commander") return -1;
      if (b === "Commander") return 1;
      if (a === "Untagged") return 1;
      if (b === "Untagged") return -1;
      return a.localeCompare(b, "en");
    });

    return keys.map((k) => ({ title: k, list: groups.get(k) }));
  }

  const order = [
    "Commander", "Creatures", "Planeswalkers", "Instants",
    "Sorceries", "Artifacts", "Enchantments", "Battles", "Lands", "Other",
  ];
  cards.forEach((c, idx) => {
    const cat = getCardCategory(c);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ ...c, _idx: idx });
  });

  return order
    .filter((cat) => groups.has(cat))
    .map((cat) => ({ title: cat, list: groups.get(cat) }));
}

function parseCmcFromManaCost(manaCost) {
  const front = String(manaCost || "").split("//")[0].trim();
  if (!front) return 0;
  const tokens = front.match(/\{([^}]+)\}/g) || [];
  let cmc = 0;
  for (const t of tokens) {
    const sym = t.slice(1, -1).toUpperCase();
    if (/^\d+$/.test(sym)) cmc += parseInt(sym, 10);
    else if (sym === "X" || sym === "Y" || sym === "Z") cmc += 0;
    else if (sym.includes("/") && sym.split("/").includes("2")) cmc += 2;
    else cmc += 1;
  }
  return cmc;
}

function sortDeckCardsSlice(list) {
  const arr = list.slice();
  if (deckSortMode === "cmc") {
    return arr.sort((a, b) => {
      const ca = parseCmcFromManaCost(a.mana_cost);
      const cb = parseCmcFromManaCost(b.mana_cost);
      if (ca !== cb) return ca - cb;
      return String(a.name || "").localeCompare(String(b.name || ""), "en");
    });
  }
  if (deckSortMode === "price") {
    return arr.sort((a, b) => {
      const pa = Number(a.price_eur || 0) * Math.max(1, Number(a.quantity || 1));
      const pb = Number(b.price_eur || 0) * Math.max(1, Number(b.quantity || 1));
      if (pb !== pa) return pb - pa;
      return String(a.name || "").localeCompare(String(b.name || ""), "en");
    });
  }
  return arr.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "en"));
}

function renderDeckCardsList(cards) {
  const container = $("deck-cards-list");
  const curDeck = myDecks.find((d) => String(d.id) === String(selectedDeckId));
  const isCmdDeck = isCommanderFormat(curDeck?.format || curDeck?.type || "");
  const commandersList = cards.filter((c) => c && c.is_commander);
  const hasCommander = commandersList.length > 0;

  if (!cards.length && !isCmdDeck) {
    container.innerHTML = `<p class="muted">No cards in this deck yet. Use the search bar above to add some.</p>`;
    return;
  }

  const sections = buildGroupedDeckSections(cards);

  if (isCmdDeck && !hasCommander) {
    sections.unshift({ title: "Commander", list: [] });
  }

  if (deckViewMode === "grid") {
    container.innerHTML = `<div class="deck-visual-columns">${sections
      .map((sec) => {
        const list = sortDeckCardsSlice(sec.list);
        const catCount = list.reduce((s, c) => s + Math.max(1, Number(c.quantity || 1)), 0);
        const isCmdCol = sec.title === "Commander";
        const cmdActionBtn =
          isCmdCol && isCmdDeck
            ? `<button type="button" class="deck-cat-mini-btn" onclick="openChangeCommanderModal(1)">${hasCommander ? "Edit" : "Choose"}</button>`
            : "";
        const stackItems = list.length
          ? list
              .map((c) => {
                const qty = Math.max(1, Number(c.quantity || 1));
                const imgUrl = c.card_image_url || toNormalCardUrl(c.image_url || "");
                return `
                  <div class="deck-stack-item" onclick="openCardPreview(${c._idx})">
                    ${imgUrl
                      ? `<img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(c.name || "")}" loading="lazy" />`
                      : `<div class="deck-stack-fallback">${escapeHtml(c.name || "")}</div>`}
                    ${qty > 1 ? `<span class="deck-stack-qty">${qty}x</span>` : ""}
                    ${c.is_proxy ? `<span class="deck-stack-proxy">PROXY</span>` : ""}
                  </div>
                `;
              })
              .join("")
          : `<p class="muted" style="font-size:12px;margin:4px 0;">No commander set.</p>`;

        return `
          <div class="deck-stack-col ${isCmdCol ? "is-commander-col" : ""}">
            <div class="deck-cat-title">
              <span>${escapeHtml(sec.title)}</span>
              <span class="deck-cat-right">${cmdActionBtn}<span>${catCount}</span></span>
            </div>
            <div class="deck-stack-cards">${stackItems}</div>
          </div>
        `;
      })
      .join("")}</div>`;
    return;
  }

  container.innerHTML = sections
    .map((sec) => {
      const list = sortDeckCardsSlice(sec.list);
      const catCount = list.reduce((s, c) => s + Math.max(1, Number(c.quantity || 1)), 0);
      const isCmdSec = sec.title === "Commander";
      const addPartnerBtn =
        isCmdSec && isCmdDeck && commandersList.length === 1
          ? `<button type="button" class="deck-cat-mini-btn" onclick="openChangeCommanderModal(2)">+ Partner</button>`
          : "";

      let rows = "";
      if (isCmdSec && !list.length) {
        rows = `
          <div class="deck-card-row">
            <div class="deck-card-main">
              <span class="muted">No commander set</span>
            </div>
            <button type="button" class="deck-cmd-inline-btn" onclick="openChangeCommanderModal(1)">Choose</button>
          </div>
        `;
      } else {
        rows = list
          .map((c, rowIdx) => {
            const qty = Math.max(1, Number(c.quantity || 1));
            const crown = c.is_commander ? "👑 " : "";
            const manaHtml = renderManaPipsHtml(c.mana_cost);
            const linePrice =
              c.is_proxy
                ? ""
                : c.price_eur !== null && c.price_eur !== undefined
                  ? `<span class="card-price-inline">${formatEur(Number(c.price_eur) * qty)}</span>`
                  : "";
            const proxyBadge = c.is_proxy ? `<span class="card-proxy-tag">PROXY</span>` : "";
            const targetSlot = rowIdx === 0 ? 1 : 2;
            const rightControlsHtml = c.is_commander
              ? `<button type="button" class="deck-cmd-inline-btn" onclick="openChangeCommanderModal(${targetSlot})">Change</button>`
              : `
                  <div class="deck-qty-controls">
                    <button type="button" class="deck-qty-btn" onclick="changeDeckCardQty(${c._idx}, -1)">−</button>
                    <span class="deck-qty-num" data-card-qty-idx="${c._idx}">${qty}</span>
                    <button type="button" class="deck-qty-btn" onclick="changeDeckCardQty(${c._idx}, 1)">+</button>
                  </div>
                `;
            return `
              <div class="deck-card-row">
                <div class="deck-card-main" onclick="openCardPreview(${c._idx})">
                  <div class="deck-card-name-line">
                    <span class="deck-card-name">${crown}${escapeHtml(c.name || "")}</span>
                    ${proxyBadge}
                  </div>
                  <div class="deck-card-subline">
                    ${manaHtml ? `<div class="deck-card-mana">${manaHtml}</div>` : ""}
                    ${linePrice}
                  </div>
                </div>
                ${rightControlsHtml}
              </div>
            `;
          })
          .join("");
      }

      return `
        <div class="deck-cat-block">
          <div class="deck-cat-title">
            <span>${escapeHtml(sec.title)}</span>
            <span class="deck-cat-right">${addPartnerBtn}<span data-cat-count="${escapeHtml(sec.title)}">${catCount}</span></span>
          </div>
          ${rows}
        </div>
      `;
    })
    .join("");
}

window.changeDeckCardQty = async function (cardIdx, delta) {
  const card = currentDeckCards[cardIdx];
  if (!card || !selectedDeckId || card.is_commander) return;

  const curQty = Math.max(1, Number(card.quantity || 1));
  const newQty = curQty + delta;

  if (newQty <= 0) {
    if (!confirm(`Remove "${card.name}" from deck?`)) return;
    if (card.id) {
      const { error } = await sb.from("deck_cards").delete().eq("id", card.id);
      if (error) {
        setStatus($("deck-cards-status"), error.message, "err");
        return;
      }
    }
    currentDeckCards.splice(cardIdx, 1);
    currentDeckChangelog = applyCardDeltaToChangelog(
      currentDeckChangelog,
      currentDeckHistory,
      card.name,
      curQty,
      0
    );
    if (activeDetailCardIdx === cardIdx) {
      $("card-preview-modal")?.classList.add("hidden");
      activeDetailCardIdx = -1;
    }
    updateDeckCardCountAndCi();
    renderDeckCardsList(currentDeckCards);
    await syncDeckCardsJson(selectedDeckId);
    return;
  }

  // In-place update (no page flash)
  card.quantity = newQty;
  document.querySelectorAll(`[data-card-qty-idx="${cardIdx}"]`).forEach((el) => {
    el.textContent = String(newQty);
  });
  if (activeDetailCardIdx === cardIdx && $("detail-qty-num")) {
    $("detail-qty-num").textContent = String(newQty);
  }

  const cat = getCardCategory(card);
  const catCount = currentDeckCards
    .filter((c) => getCardCategory(c) === cat)
    .reduce((s, c) => s + Math.max(1, Number(c.quantity || 1)), 0);
  const catEl = document.querySelector(`[data-cat-count="${cat}"]`);
  if (catEl) catEl.textContent = String(catCount);

  updateDeckCardCountAndCi();

  if (card.id) {
    const { error } = await sb.from("deck_cards").update({ quantity: newQty }).eq("id", card.id);
    if (error) {
      card.quantity = curQty;
      document.querySelectorAll(`[data-card-qty-idx="${cardIdx}"]`).forEach((el) => {
        el.textContent = String(curQty);
      });
      if (activeDetailCardIdx === cardIdx && $("detail-qty-num")) {
        $("detail-qty-num").textContent = String(curQty);
      }
      updateDeckCardCountAndCi();
      setStatus($("deck-cards-status"), error.message, "err");
      return;
    }
  }

  currentDeckChangelog = applyCardDeltaToChangelog(
    currentDeckChangelog,
    currentDeckHistory,
    card.name,
    curQty,
    newQty
  );
  await syncDeckCardsJson(selectedDeckId);
};

// ---- EDIT COMMANDERS (COMMANDER + PARTNER) ----
let changeCmdTimer = null;
let editCmdSlot1 = null;
let editCmdSlot2 = null;
let editActiveCmdSlot = 1;

function renderEditCommanderSlots() {
  const wrap = $("edit-cmd-slots");
  if (!wrap) return;

  const s1Name = editCmdSlot1?.name || "";
  const s2Name = editCmdSlot2?.name || "";

  wrap.innerHTML = `
    <div class="cmd-slot-card ${editActiveCmdSlot === 1 ? "active" : ""}" onclick="selectEditCmdSlot(1)">
      <div class="cmd-slot-top">
        <span class="cmd-slot-label">Commander</span>
        ${s1Name ? `<button type="button" class="cmd-slot-clear" onclick="event.stopPropagation(); clearEditCmdSlot(1)">×</button>` : ""}
      </div>
      <div class="cmd-slot-value ${s1Name ? "" : "empty"}">${s1Name ? `👑 ${escapeHtml(s1Name)}` : "Tap to pick..."}</div>
    </div>
    <div class="cmd-slot-card ${editActiveCmdSlot === 2 ? "active" : ""}" onclick="selectEditCmdSlot(2)">
      <div class="cmd-slot-top">
        <span class="cmd-slot-label">Partner (opt.)</span>
        ${s2Name ? `<button type="button" class="cmd-slot-clear" onclick="event.stopPropagation(); clearEditCmdSlot(2)">×</button>` : ""}
      </div>
      <div class="cmd-slot-value ${s2Name ? "" : "empty"}">${s2Name ? `👑 ${escapeHtml(s2Name)}` : "+ Add Partner"}</div>
    </div>
  `;

  const inp = $("change-cmd-input");
  if (inp) {
    inp.placeholder = editActiveCmdSlot === 1 ? "Search Commander..." : "Search Partner / Background...";
  }
}

window.selectEditCmdSlot = function (slot) {
  editActiveCmdSlot = slot === 2 ? 2 : 1;
  renderEditCommanderSlots();
  $("change-cmd-input")?.focus();
};

window.clearEditCmdSlot = function (slot) {
  if (slot === 1) {
    editCmdSlot1 = editCmdSlot2;
    editCmdSlot2 = null;
    editActiveCmdSlot = 1;
  } else {
    editCmdSlot2 = null;
    editActiveCmdSlot = 2;
  }
  renderEditCommanderSlots();
};

window.openChangeCommanderModal = function (initialSlot = 1) {
  const existingCmds = currentDeckCards.filter((c) => c && c.is_commander);
  editCmdSlot1 = existingCmds[0] || null;
  editCmdSlot2 = existingCmds[1] || null;
  editActiveCmdSlot = initialSlot === 2 ? 2 : 1;

  changeCmdResults = [];
  if ($("change-cmd-input")) $("change-cmd-input").value = "";
  if ($("change-cmd-results")) $("change-cmd-results").innerHTML = "";
  setStatus($("change-cmd-status"), "");
  renderEditCommanderSlots();
  $("commander-modal")?.classList.remove("hidden");
  setTimeout(() => $("change-cmd-input")?.focus(), 50);
};

$("btn-close-cmd-modal")?.addEventListener("click", () => {
  $("commander-modal")?.classList.add("hidden");
});

async function searchChangeCommander() {
  const q = ($("change-cmd-input")?.value || "").trim();
  const box = $("change-cmd-results");
  if (q.length < 2) {
    changeCmdResults = [];
    box.innerHTML = "";
    setStatus($("change-cmd-status"), "");
    return;
  }
  setStatus($("change-cmd-status"), "Searching Scryfall...");
  try {
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`${q} is:commander`)}&unique=cards`
    );
    let json = resp.ok ? await resp.json() : null;
    if (!json || !json.data?.length) {
      const fb = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards`);
      json = fb.ok ? await fb.json() : { data: [] };
    }
    changeCmdResults = (json.data || []).slice(0, 12);
    if (!changeCmdResults.length) {
      box.innerHTML = "";
      setStatus($("change-cmd-status"), "No commanders found.");
      return;
    }
    setStatus($("change-cmd-status"), "");
    const btnLabel = editActiveCmdSlot === 2 ? "Set Partner" : "Set Commander";
    box.innerHTML = changeCmdResults
      .map((c, i) => {
        const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || "";
        const price = extractScryfallEurPrice(c, false);
        return `
          <div class="deck-search-tile">
            ${img ? `<img class="deck-search-tile-img" src="${escapeHtml(img)}" alt="${escapeHtml(c.name || "")}" loading="lazy" />` : `<div class="deck-search-tile-img"></div>`}
            <div class="deck-search-tile-name">${escapeHtml(c.name || "")}</div>
            <div class="deck-search-tile-price">${formatEur(price)}</div>
            <button type="button" class="deck-add-btn" onclick="pickEditCommander(${i})">${btnLabel}</button>
          </div>
        `;
      })
      .join("");
  } catch {
    setStatus($("change-cmd-status"), "Scryfall connection error.", "err");
  }
}

$("btn-change-cmd-search")?.addEventListener("click", searchChangeCommander);
$("change-cmd-input")?.addEventListener("input", () => {
  clearTimeout(changeCmdTimer);
  changeCmdTimer = setTimeout(searchChangeCommander, 350);
});

window.pickEditCommander = function (idx) {
  const sc = changeCmdResults[idx];
  if (!sc) return;

  const pickedName = String(sc.name || "").toLowerCase();
  if (editActiveCmdSlot === 1) {
    if (editCmdSlot2 && String(editCmdSlot2.name || "").toLowerCase() === pickedName) {
      editCmdSlot2 = null;
    }
    editCmdSlot1 = { _fromScryfall: true, sc, name: sc.name };
  } else {
    if (editCmdSlot1 && String(editCmdSlot1.name || "").toLowerCase() === pickedName) {
      setStatus($("change-cmd-status"), "Partner must be a different card.", "err");
      return;
    }
    if (!editCmdSlot1) {
      editCmdSlot1 = { _fromScryfall: true, sc, name: sc.name };
    } else {
      editCmdSlot2 = { _fromScryfall: true, sc, name: sc.name };
    }
  }

  $("change-cmd-results").innerHTML = "";
  if ($("change-cmd-input")) $("change-cmd-input").value = "";
  setStatus($("change-cmd-status"), "");
  renderEditCommanderSlots();
};

$("btn-save-commanders")?.addEventListener("click", async () => {
  if (!selectedDeckId) return;
  const chosenSlots = [editCmdSlot1, editCmdSlot2].filter(Boolean);
  const chosenNames = new Set(chosenSlots.map((s) => String(s.name || "").toLowerCase()));

  setStatus($("change-cmd-status"), "Saving commanders...");

  for (const c of currentDeckCards) {
    if (c.is_commander && !chosenNames.has(String(c.name || "").toLowerCase())) {
      c.is_commander = false;
      if (c.id) {
        await sb.from("deck_cards").update({ is_commander: false }).eq("id", c.id);
      }
    }
  }

  let newHeroArtUrl = "";

  for (let i = 0; i < chosenSlots.length; i++) {
    const slotObj = chosenSlots[i];
    if (!slotObj._fromScryfall) {
      slotObj.is_commander = true;
      slotObj.quantity = 1;
      if (i === 0 && !newHeroArtUrl) {
        newHeroArtUrl = toArtCropIfPossible(slotObj.image_url || slotObj.card_image_url || "");
      }
      continue;
    }

    const sc = slotObj.sc;
    const normalUrl = sc.image_uris?.normal || sc.card_faces?.[0]?.image_uris?.normal || "";
    const artUrl = sc.image_uris?.art_crop || sc.card_faces?.[0]?.image_uris?.art_crop || normalUrl;
    if (i === 0 && artUrl) newHeroArtUrl = artUrl;

    const manaCost = extractManaCostFromScryfall(sc);
    const oracleText = extractOracleTextFromScryfall(sc);
    const colorIdentity = resolveCardColorIdentity({
      color_identity: sc.color_identity,
      colors: sc.colors,
      mana_cost: manaCost,
      oracle_text: oracleText,
    });
    const priceEur = extractScryfallEurPrice(sc, false);
    const setLower = String(sc.set || "").trim().toLowerCase();

    const existing = currentDeckCards.find(
      (c) => String(c.name || "").toLowerCase() === String(sc.name || "").toLowerCase()
    );

    if (existing) {
      existing.is_commander = true;
      existing.quantity = 1;
      existing.mana_cost = manaCost || existing.mana_cost || "";
      existing.oracle_text = oracleText || existing.oracle_text || "";
      existing.color_identity = colorIdentity;
      if (existing.id) {
        await sb
          .from("deck_cards")
          .update({
            is_commander: true,
            quantity: 1,
            mana_cost: existing.mana_cost,
            oracle_text: existing.oracle_text,
          })
          .eq("id", existing.id);
      }
    } else {
      const newRow = {
        deck_id: selectedDeckId,
        scryfall_id: sc.id || "",
        name: sc.name || "",
        type_line: sc.type_line || "",
        oracle_text: oracleText,
        mana_cost: manaCost,
        image_url: normalUrl,
        quantity: 1,
        is_commander: true,
      };
      const { data: inserted } = await sb
        .from("deck_cards")
        .insert(newRow)
        .select("id, name, type_line, oracle_text, mana_cost, image_url, quantity, is_commander, scryfall_id")
        .single();

      currentDeckCards.unshift({
        ...(inserted || newRow),
        card_image_url: normalUrl,
        color_identity: colorIdentity,
        set: setLower,
        set_code: setLower.toUpperCase(),
        set_name: sc.set_name || "",
        collector_number: sc.collector_number || "",
        foil: false,
        price_eur: priceEur,
        is_proxy: false,
        tags: [],
      });

      currentDeckChangelog = applyCardDeltaToChangelog(
        currentDeckChangelog,
        currentDeckHistory,
        sc.name,
        0,
        1
      );
    }
  }

  if (newHeroArtUrl) applyDeckHeroBg(newHeroArtUrl);
  updateDeckCardCountAndCi();
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId, newHeroArtUrl ? { bg_image_url: newHeroArtUrl } : {});
  $("commander-modal")?.classList.add("hidden");
});

// ---- CARD SEARCH GRID & ADD CARD FROM SCRYFALL ----
async function performDeckCardSearch() {
  const input = $("deck-card-search-input");
  const rawQuery = (input?.value || "").trim();
  const dropdown = $("deck-search-dropdown");
  const resBox = $("deck-search-results");

  if (rawQuery.length < 2) {
    deckSearchResults = [];
    resBox.innerHTML = "";
    setStatus($("deck-search-status"), "");
    dropdown?.classList.add("hidden");
    return;
  }

  dropdown?.classList.remove("hidden");

  let q = rawQuery;
  const ci = extractCommanderColorIdentity(currentDeckCards);
  if (ci.length > 0) {
    const ciToken = ci.join("").toLowerCase();
    q = `${rawQuery} id<=${ciToken}`;
  }

  setStatus($("deck-search-status"), "Searching Scryfall...");
  try {
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards`
    );
    if (!resp.ok) {
      deckSearchResults = [];
      resBox.innerHTML = "";
      setStatus($("deck-search-status"), "No cards found.");
      return;
    }
    const json = await resp.json();
    deckSearchResults = (json.data || []).slice(0, 12);
    setStatus($("deck-search-status"), "");

    resBox.innerHTML = deckSearchResults
      .map((c, i) => {
        const img =
          c.image_uris?.normal ||
          c.image_uris?.small ||
          c.card_faces?.[0]?.image_uris?.normal ||
          c.card_faces?.[0]?.image_uris?.small ||
          "";
        const price = extractScryfallEurPrice(c, false);
        return `
          <div class="deck-search-tile">
            ${img ? `<img class="deck-search-tile-img" src="${escapeHtml(img)}" alt="${escapeHtml(c.name || "")}" loading="lazy" />` : `<div class="deck-search-tile-img"></div>`}
            <div class="deck-search-tile-name">${escapeHtml(c.name || "")}</div>
            <div class="deck-search-tile-price">${formatEur(price)}</div>
            <button type="button" class="deck-add-btn" onclick="addCardToCurrentDeck(${i})">Add</button>
          </div>
        `;
      })
      .join("");
  } catch {
    setStatus($("deck-search-status"), "Scryfall connection error.", "err");
  }
}

$("btn-deck-card-search")?.addEventListener("click", performDeckCardSearch);
$("deck-card-search-input")?.addEventListener("input", () => {
  clearTimeout(deckSearchTimer);
  deckSearchTimer = setTimeout(performDeckCardSearch, 350);
});

$("deck-card-search-input")?.addEventListener("focus", () => {
  const val = ($("deck-card-search-input")?.value || "").trim();
  const dropdown = $("deck-search-dropdown");
  if (val.length >= 2 && dropdown) {
    dropdown.classList.remove("hidden");
    if (!deckSearchResults.length) {
      performDeckCardSearch();
    }
  }
});

document.addEventListener("click", (e) => {
  const searchCard = $("deck-search-card");
  const dropdown = $("deck-search-dropdown");
  if (!searchCard || !dropdown) return;
  if (!searchCard.contains(e.target)) {
    dropdown.classList.add("hidden");
  }
});

window.addCardToCurrentDeck = async function (resultIdx) {
  const sc = deckSearchResults[resultIdx];
  if (!sc || !selectedDeckId) return;

  const existingIdx = currentDeckCards.findIndex(
    (c) =>
      (sc.id && c.scryfall_id === sc.id) ||
      String(c.name || "").toLowerCase() === String(sc.name || "").toLowerCase()
  );

  if (existingIdx !== -1) {
    await changeDeckCardQty(existingIdx, 1);
    setStatus($("deck-search-status"), `Increased quantity of ${sc.name}.`, "ok");
    return;
  }

  const imageUrl =
    sc.image_uris?.normal ||
    sc.card_faces?.[0]?.image_uris?.normal ||
    sc.image_uris?.art_crop ||
    "";
  const manaCost = extractManaCostFromScryfall(sc);
  const oracleText = extractOracleTextFromScryfall(sc);
  const colorIdentity = resolveCardColorIdentity({
    color_identity: sc.color_identity,
    colors: sc.colors,
    mana_cost: manaCost,
    oracle_text: oracleText,
  });
  const priceEur = extractScryfallEurPrice(sc, false);
  const setLower = String(sc.set || "").trim().toLowerCase();

  const newRow = {
    deck_id: selectedDeckId,
    scryfall_id: sc.id || "",
    name: sc.name || "",
    type_line: sc.type_line || "",
    oracle_text: oracleText,
    mana_cost: manaCost,
    image_url: imageUrl,
    quantity: 1,
    is_commander: false,
  };

  setStatus($("deck-search-status"), `Adding ${sc.name}...`);
  const { data: inserted, error } = await sb
    .from("deck_cards")
    .insert(newRow)
    .select("id, name, type_line, oracle_text, mana_cost, image_url, quantity, is_commander, scryfall_id")
    .single();

  if (error) {
    setStatus($("deck-search-status"), error.message, "err");
    return;
  }

  currentDeckCards.push({
    ...(inserted || newRow),
    card_image_url: imageUrl,
    color_identity: colorIdentity,
    set: setLower,
    set_code: setLower.toUpperCase(),
    set_name: sc.set_name || "",
    collector_number: sc.collector_number || "",
    foil: false,
    price_eur: priceEur,
    is_proxy: false,
    tags: [],
  });

  currentDeckChangelog = applyCardDeltaToChangelog(
    currentDeckChangelog,
    currentDeckHistory,
    sc.name,
    0,
    1
  );

  updateDeckCardCountAndCi();
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
  setStatus($("deck-search-status"), `${sc.name} added to deck!`, "ok");
};

// ---- CARD DETAIL MODAL: INFO, EDITION, PROXY & TAGS ----
function renderCardTagsModalUi(card) {
  const chipsEl = $("card-tags-chips");
  const suggEl = $("card-tag-suggestions");
  const curTags = Array.isArray(card.tags) ? card.tags : [];

  if (!curTags.length) {
    chipsEl.innerHTML = `<span class="muted" style="font-size:11px;">No tags assigned</span>`;
  } else {
    chipsEl.innerHTML = curTags
      .map((tg, i) => `
        <span class="tag-chip">
          ${escapeHtml(tg)}
          <button type="button" onclick="removeTagFromActiveCard(${i})">×</button>
        </span>
      `)
      .join("");
  }

  const allKnown = new Set(DEFAULT_TAG_PRESETS);
  currentDeckCards.forEach((c) => {
    (c.tags || []).forEach((t) => allKnown.add(t));
  });
  const suggestions = Array.from(allKnown).filter(
    (t) => !curTags.some((ct) => ct.toLowerCase() === t.toLowerCase())
  );

  suggEl.innerHTML = suggestions
    .slice(0, 10)
    .map((tg) => `<button type="button" class="tag-suggest-btn" onclick="addTagToActiveCard('${escapeHtml(tg)}')">+ ${escapeHtml(tg)}</button>`)
    .join("");
}

window.addTagToActiveCard = async function (rawTag) {
  const card = currentDeckCards[activeDetailCardIdx];
  const tag = normalizeTag(rawTag);
  if (!card || !tag) return;
  if (!Array.isArray(card.tags)) card.tags = [];
  if (card.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;

  card.tags.push(tag);
  renderCardTagsModalUi(card);
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
};

window.removeTagFromActiveCard = async function (tagIdx) {
  const card = currentDeckCards[activeDetailCardIdx];
  if (!card || !Array.isArray(card.tags)) return;
  card.tags.splice(tagIdx, 1);
  renderCardTagsModalUi(card);
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
};

$("btn-add-card-tag")?.addEventListener("click", async () => {
  const inp = $("card-tag-input");
  const val = (inp?.value || "").trim();
  if (!val) return;
  inp.value = "";
  await window.addTagToActiveCard(val);
});

$("card-proxy-chk")?.addEventListener("change", async (e) => {
  const card = currentDeckCards[activeDetailCardIdx];
  if (!card) return;
  card.is_proxy = Boolean(e.target.checked);
  $("card-preview-proxy-badge")?.classList.toggle("hidden", !card.is_proxy);
  $("card-preview-price").textContent = card.is_proxy ? "PROXY" : formatEur(card.price_eur);
  updateDeckTotalPriceBadge();
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
});

$("btn-detail-qty-minus")?.addEventListener("click", () => {
  if (activeDetailCardIdx >= 0) changeDeckCardQty(activeDetailCardIdx, -1);
});

$("btn-detail-qty-plus")?.addEventListener("click", () => {
  if (activeDetailCardIdx >= 0) changeDeckCardQty(activeDetailCardIdx, 1);
});

$("card-edition-select")?.addEventListener("change", async (e) => {
  const idx = parseInt(e.target.value, 10);
  const card = currentDeckCards[activeDetailCardIdx];
  const pr = activeCardPrints[idx];
  if (!card || !pr) return;

  const newImg = pr.image_uris?.normal || pr.card_faces?.[0]?.image_uris?.normal || "";
  const newPrice = extractScryfallEurPrice(pr, false);

  card.scryfall_id = pr.id || card.scryfall_id;
  card.set = (pr.set || "").toLowerCase();
  card.set_code = (pr.set || "").toUpperCase();
  card.set_name = pr.set_name || "";
  card.collector_number = pr.collector_number || "";
  if (newImg) {
    card.image_url = newImg;
    card.card_image_url = newImg;
    $("card-preview-img").src = newImg;
  }
  card.price_eur = newPrice;
  $("card-preview-price").textContent = card.is_proxy ? "PROXY" : formatEur(newPrice);

  setStatus($("card-detail-status"), "Updating edition...");
  if (card.id) {
    await sb
      .from("deck_cards")
      .update({ scryfall_id: card.scryfall_id, image_url: card.image_url })
      .eq("id", card.id);
  }
  updateDeckTotalPriceBadge();
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
  setStatus($("card-detail-status"), `Edition updated: [${card.set_code}]`, "ok");
});

window.openCardPreview = async function (cardIdx) {
  const card = currentDeckCards[cardIdx];
  if (!card) return;
  activeDetailCardIdx = cardIdx;
  activeCardPrints = [];

  $("card-preview-name").textContent = card.name || "";
  $("card-preview-mana").innerHTML = renderManaPipsHtml(card.mana_cost);
  $("card-preview-meta").textContent = card.type_line || "";
  $("card-preview-price").textContent = card.is_proxy ? "PROXY" : formatEur(card.price_eur);
  $("card-preview-proxy-badge")?.classList.toggle("hidden", !card.is_proxy);
  $("card-proxy-chk").checked = Boolean(card.is_proxy);
  $("card-preview-qty-wrap")?.classList.toggle("hidden", Boolean(card.is_commander));
  $("detail-qty-num").textContent = String(Math.max(1, Number(card.quantity || 1)));
  $("card-preview-oracle").textContent = card.oracle_text || "Loading card text...";
  $("card-tag-input").value = "";
  setStatus($("card-detail-status"), "");
  renderCardTagsModalUi(card);

  const imgEl = $("card-preview-img");
  const initialImg = card.card_image_url || toNormalCardUrl(card.image_url || "");
  imgEl.src = initialImg || "";

  const edSel = $("card-edition-select");
  edSel.innerHTML = `<option value="">Loading editions...</option>`;

  $("card-preview-modal").classList.remove("hidden");

  if (card.name) {
    try {
      const cleanName = String(card.name).split("//")[0].trim();
      const resp = await fetch(
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`!"${cleanName}"`)}&unique=prints&order=released&dir=desc`
      );
      if (resp.ok) {
        const json = await resp.json();
        activeCardPrints = json.data || [];
        if (activeCardPrints.length > 0 && activeDetailCardIdx === cardIdx) {
          let selectedIdx = activeCardPrints.findIndex((p) => p.id === card.scryfall_id);
          if (selectedIdx === -1 && card.set_code) {
            selectedIdx = activeCardPrints.findIndex(
              (p) => (p.set || "").toUpperCase() === card.set_code.toUpperCase()
            );
          }
          if (selectedIdx === -1) selectedIdx = 0;

          const curPrint = activeCardPrints[selectedIdx];
          if (!imgEl.src) {
            const u = curPrint.image_uris?.normal || curPrint.card_faces?.[0]?.image_uris?.normal || "";
            if (u) imgEl.src = u;
          }
          if (!card.oracle_text) {
            const ot =
              curPrint.oracle_text ||
              (curPrint.card_faces || []).map((f) => f.oracle_text).filter(Boolean).join("\n---\n") ||
              "";
            card.oracle_text = ot;
            $("card-preview-oracle").textContent = ot || "No rules text.";
          }

          edSel.innerHTML = activeCardPrints
            .map((p, i) => {
              const scode = (p.set || "").toUpperCase();
              const cn = p.collector_number ? `#${p.collector_number}` : "";
              const prEur = extractScryfallEurPrice(p, false);
              const prTxt = prEur !== null ? ` · €${prEur.toFixed(2)}` : "";
              return `<option value="${i}">[${escapeHtml(scode)}] ${escapeHtml(p.set_name || scode)} ${escapeHtml(cn)}${prTxt}</option>`;
            })
            .join("");
          edSel.value = String(selectedIdx);
        }
      } else {
        edSel.innerHTML = `<option value="">No alternative editions</option>`;
      }
    } catch {
      edSel.innerHTML = `<option value="">Error loading editions</option>`;
    }
  }
};

$("btn-close-card-preview")?.addEventListener("click", () => {
  activeDetailCardIdx = -1;
  $("card-preview-modal").classList.add("hidden");
});

// ---- IMPORT DECKLIST (TEXT / MOXFIELD / ARCHIDEKT / MANABOX) ----
function parseDecklistText(rawText) {
  const lines = String(rawText || "").split(/\r?\n/);
  const parsed = [];
  let inCommander = false;
  let skipSection = false;

  const sectionRx =
    /^(commander|deck|mainboard|main|sideboard|maybeboard|considering|companion|creatures?|planeswalkers?|instants?|sorceries|sorcery|artifacts?|enchantments?|battles?|lands?|other|about)\b/i;

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) {
      if (inCommander && parsed.some((p) => p.is_commander)) inCommander = false;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#")) continue;

    if (!/^\d/.test(line) && sectionRx.test(line)) {
      const lower = line.toLowerCase();
      inCommander = lower.startsWith("commander");
      skipSection =
        lower.startsWith("sideboard") ||
        lower.startsWith("maybeboard") ||
        lower.startsWith("considering");
      continue;
    }
    if (skipSection) continue;

    let isFoil = false;
    let isCommander = inCommander;

    if (/\*f\*|\(foil\)|\[foil\]/i.test(line)) {
      isFoil = true;
      line = line.replace(/\*f\*|\(foil\)|\[foil\]/gi, "").trim();
    }
    if (/\*cmdr\*|\(commander\)|#commander\b/i.test(line)) {
      isCommander = true;
      line = line.replace(/\*cmdr\*|\(commander\)|#commander\b/gi, "").trim();
    }

    line = line.replace(/\s+#\S+/g, "").replace(/\^[^^]+\^/g, "").trim();

    let qty = 1;
    const qtyMatch = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (qtyMatch) {
      qty = Math.max(1, parseInt(qtyMatch[1], 10));
      line = qtyMatch[2].trim();
    }

    let setCode = "";
    let collectorNumber = "";
    const setNumMatch = line.match(/^(.+?)\s*\(([a-z0-9]{2,6})\)\s*#?([a-z0-9\-★]+)?\s*$/i);
    if (setNumMatch) {
      line = setNumMatch[1].trim();
      setCode = setNumMatch[2].toLowerCase();
      collectorNumber = (setNumMatch[3] || "").trim();
    }

    const name = line.trim();
    if (!name) continue;

    parsed.push({ qty, name, setCode, collectorNumber, isFoil, isCommander });
  }

  const merged = new Map();
  for (const item of parsed) {
    const key = `${item.name.toLowerCase()}|${item.setCode}|${item.collectorNumber}|${item.isFoil ? 1 : 0}|${item.isCommander ? 1 : 0}`;
    if (merged.has(key)) {
      merged.get(key).qty += item.qty;
    } else {
      merged.set(key, { ...item });
    }
  }
  return Array.from(merged.values());
}

async function fetchScryfallBatchForImport(items, useSetAndNum) {
  const bySetNum = new Map();
  const byName = new Map();

  for (let i = 0; i < items.length; i += 75) {
    const chunk = items.slice(i, i + 75);
    const identifiers = chunk
      .map((it) => {
        if (useSetAndNum && it.setCode && it.collectorNumber) {
          return { set: it.setCode, collector_number: it.collectorNumber };
        }
        const front = it.name.split("//")[0].trim();
        return front ? { name: front } : null;
      })
      .filter(Boolean);

    if (!identifiers.length) continue;

    const resp = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifiers }),
    });
    if (!resp.ok) continue;
    const json = await resp.json();

    for (const sc of json.data || []) {
      const scSet = String(sc.set || "").toLowerCase();
      const scNum = String(sc.collector_number || "").toLowerCase();
      if (scSet && scNum) bySetNum.set(`${scSet}|${scNum}`, sc);
      if (sc.name) {
        byName.set(sc.name.toLowerCase(), sc);
        byName.set(sc.name.split("//")[0].trim().toLowerCase(), sc);
      }
    }
  }

  return { bySetNum, byName };
}

$("btn-open-import-deck")?.addEventListener("click", () => {
  if (!selectedDeckId) return;
  if ($("import-deck-textarea")) $("import-deck-textarea").value = "";
  setStatus($("import-deck-status"), "");
  $("import-deck-modal")?.classList.remove("hidden");
  setTimeout(() => $("import-deck-textarea")?.focus(), 50);
});

$("btn-cancel-import-deck")?.addEventListener("click", () => {
  $("import-deck-modal")?.classList.add("hidden");
});

$("btn-run-import-deck")?.addEventListener("click", async () => {
  if (!selectedDeckId) return;
  const raw = ($("import-deck-textarea")?.value || "").trim();
  const items = parseDecklistText(raw);

  if (!items.length) {
    setStatus($("import-deck-status"), "Paste at least one valid card.", "err");
    return;
  }

  const mode = document.querySelector('input[name="import-deck-mode"]:checked')?.value || "merge";
  if (mode === "replace" && currentDeckCards.length > 0) {
    if (!confirm(`Replace all ${currentDeckCards.length} current cards with the imported list?`)) {
      return;
    }
  }

  const btnRun = $("btn-run-import-deck");
  if (btnRun) btnRun.disabled = true;

  try {
    setStatus($("import-deck-status"), `Looking up ${items.length} cards on Scryfall...`);

    const pass1 = await fetchScryfallBatchForImport(items, true);
    const resolved = [];
    const retryByName = [];

    for (const it of items) {
      const frontLower = it.name.split("//")[0].trim().toLowerCase();
      const sc =
        (it.setCode && it.collectorNumber && pass1.bySetNum.get(`${it.setCode}|${it.collectorNumber.toLowerCase()}`)) ||
        pass1.byName.get(it.name.toLowerCase()) ||
        pass1.byName.get(frontLower);

      if (sc) {
        resolved.push({ it, sc });
      } else {
        retryByName.push(it);
      }
    }

    const notFound = [];
    if (retryByName.length > 0) {
      const pass2 = await fetchScryfallBatchForImport(retryByName, false);
      for (const it of retryByName) {
        const frontLower = it.name.split("//")[0].trim().toLowerCase();
        const sc = pass2.byName.get(it.name.toLowerCase()) || pass2.byName.get(frontLower);
        if (sc) resolved.push({ it, sc });
        else notFound.push(it.name);
      }
    }

    if (!resolved.length) {
      setStatus($("import-deck-status"), "No cards matched on Scryfall.", "err");
      return;
    }

    setStatus($("import-deck-status"), `Saving ${resolved.length} cards to Supabase...`);

    const prevQtyMap = new Map();
    for (const c of currentDeckCards) {
      const k = String(c.name || "").trim().toLowerCase();
      if (!k) continue;
      const cur = prevQtyMap.get(k) || { name: c.name, qty: 0 };
      cur.qty += Math.max(1, Number(c.quantity || 1));
      prevQtyMap.set(k, cur);
    }

    const curDeck = myDecks.find((d) => String(d.id) === String(selectedDeckId));
    const isCmdFmt = isCommanderFormat(curDeck?.format || curDeck?.type || "");

    const buildCardObj = (it, sc) => {
      const normalUrl = sc.image_uris?.normal || sc.card_faces?.[0]?.image_uris?.normal || "";
      const manaCost = extractManaCostFromScryfall(sc);
      const oracleText = extractOracleTextFromScryfall(sc);
      const colorIdentity = resolveCardColorIdentity({
        color_identity: sc.color_identity,
        colors: sc.colors,
        mana_cost: manaCost,
        oracle_text: oracleText,
      });
      const setLower = String(sc.set || it.setCode || "").trim().toLowerCase();
      return {
        deck_id: selectedDeckId,
        scryfall_id: sc.id || "",
        name: sc.name || it.name,
        type_line: sc.type_line || "",
        oracle_text: oracleText,
        mana_cost: manaCost,
        image_url: normalUrl,
        card_image_url: normalUrl,
        color_identity: colorIdentity,
        set: setLower,
        set_code: setLower.toUpperCase(),
        set_name: sc.set_name || "",
        collector_number: sc.collector_number || it.collectorNumber || "",
        foil: Boolean(it.isFoil),
        price_eur: extractScryfallEurPrice(sc, Boolean(it.isFoil)),
        quantity: it.isCommander ? 1 : it.qty,
        is_commander: Boolean(isCmdFmt && it.isCommander),
        is_proxy: false,
        tags: [],
      };
    };

    let cmdArtUrl = "";
    const importedObjs = resolved.map(({ it, sc }) => {
      const obj = buildCardObj(it, sc);
      if (obj.is_commander && !cmdArtUrl) {
        cmdArtUrl = sc.image_uris?.art_crop || sc.card_faces?.[0]?.image_uris?.art_crop || obj.image_url;
      }
      return obj;
    });

    if (mode === "replace") {
      await sb.from("deck_cards").delete().eq("deck_id", selectedDeckId);
      const insertedAll = [];
      for (let i = 0; i < importedObjs.length; i += 100) {
        const chunk = importedObjs.slice(i, i + 100);
        const dbRows = chunk.map((c) => ({
          deck_id: c.deck_id,
          scryfall_id: c.scryfall_id,
          name: c.name,
          type_line: c.type_line,
          oracle_text: c.oracle_text,
          mana_cost: c.mana_cost,
          image_url: c.image_url,
          quantity: c.quantity,
          is_commander: c.is_commander,
        }));
        const { data: ins, error: insErr } = await sb
          .from("deck_cards")
          .insert(dbRows)
          .select("id, name, scryfall_id");
        if (insErr) throw insErr;

        chunk.forEach((c, idx) => {
          insertedAll.push({ ...c, id: ins?.[idx]?.id || undefined });
        });
      }
      currentDeckCards = insertedAll;
    } else {
      const toInsert = [];
      for (const imp of importedObjs) {
        const existing = currentDeckCards.find(
          (c) =>
            (imp.scryfall_id && c.scryfall_id === imp.scryfall_id) ||
            String(c.name || "").toLowerCase() === String(imp.name || "").toLowerCase()
        );
        if (existing) {
          if (!existing.is_commander) {
            existing.quantity = Math.max(1, Number(existing.quantity || 1)) + imp.quantity;
            if (existing.id) {
              await sb.from("deck_cards").update({ quantity: existing.quantity }).eq("id", existing.id);
            }
          }
        } else {
          toInsert.push(imp);
        }
      }

      if (toInsert.length > 0) {
        for (let i = 0; i < toInsert.length; i += 100) {
          const chunk = toInsert.slice(i, i + 100);
          const dbRows = chunk.map((c) => ({
            deck_id: c.deck_id,
            scryfall_id: c.scryfall_id,
            name: c.name,
            type_line: c.type_line,
            oracle_text: c.oracle_text,
            mana_cost: c.mana_cost,
            image_url: c.image_url,
            quantity: c.quantity,
            is_commander: c.is_commander,
          }));
          const { data: ins, error: insErr } = await sb
            .from("deck_cards")
            .insert(dbRows)
            .select("id");
          if (insErr) throw insErr;

          chunk.forEach((c, idx) => {
            currentDeckCards.push({ ...c, id: ins?.[idx]?.id || undefined });
          });
        }
      }
    }

    const nextQtyMap = new Map();
    for (const c of currentDeckCards) {
      const k = String(c.name || "").trim().toLowerCase();
      if (!k) continue;
      const cur = nextQtyMap.get(k) || { name: c.name, qty: 0 };
      cur.qty += Math.max(1, Number(c.quantity || 1));
      nextQtyMap.set(k, cur);
    }

    const allKeys = new Set([...prevQtyMap.keys(), ...nextQtyMap.keys()]);
    for (const k of allKeys) {
      const oldQty = prevQtyMap.get(k)?.qty || 0;
      const newQty = nextQtyMap.get(k)?.qty || 0;
      const cardName = nextQtyMap.get(k)?.name || prevQtyMap.get(k)?.name || "";
      if (oldQty !== newQty && cardName) {
        currentDeckChangelog = applyCardDeltaToChangelog(
          currentDeckChangelog,
          currentDeckHistory,
          cardName,
          oldQty,
          newQty
        );
      }
    }

    const extra = cmdArtUrl && (!extractDeckImageUrl(curDeck) || mode === "replace")
      ? { bg_image_url: cmdArtUrl }
      : {};
    if (extra.bg_image_url) applyDeckHeroBg(extra.bg_image_url);

    updateDeckCardCountAndCi();
    renderDeckCardsList(currentDeckCards);
    await syncDeckCardsJson(selectedDeckId, extra);

    if (notFound.length > 0) {
      setStatus(
        $("import-deck-status"),
        `Imported ${resolved.length} cards. Not found (${notFound.length}): ${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? "…" : ""}`,
        "err"
      );
    } else {
      $("import-deck-modal")?.classList.add("hidden");
      setStatus($("deck-cards-status"), `Imported ${resolved.length} cards!`, "ok");
    }
  } catch (err) {
    setStatus($("import-deck-status"), `Import error: ${err.message || err}`, "err");
  } finally {
    if (btnRun) btnRun.disabled = false;
  }
});
// ---- GROUPS PAGE (DESKTOP PARITY) ----
let groupInvitations = [];
let groupMatchesData = { matches: [], players: [] };
let groupPlayerLb = [];
let groupDeckLb = [];
let groupProfilesMap = {};

// Sub-tab switch inside Group Detail
document.querySelectorAll(".group-subtab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.gsubtab;
    document.querySelectorAll(".group-subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".group-subpanel").forEach((p) => {
      p.classList.toggle("hidden", p.id !== targetId);
      p.classList.toggle("active", p.id === targetId);
    });
  });
});

function switchGroupSubtab(targetId) {
  const btn = document.querySelector(`.group-subtab-btn[data-gsubtab="${targetId}"]`);
  if (btn) btn.click();
}

function renderMiniAvatarHtml(name, avatarUrl) {
  const cleanUrl = String(avatarUrl || "").trim();
  if (cleanUrl) {
    return `<span class="mini-avatar"><img src="${escapeHtml(cleanUrl)}" alt="" loading="lazy" /></span>`;
  }
  const initial = (String(name || "?").trim().slice(0, 1) || "?").toUpperCase();
  return `<span class="mini-avatar">${escapeHtml(initial)}</span>`;
}

async function loadGroupInvitations() {
  const box = $("group-invites-section");
  const listEl = $("group-invites-list");
  if (!box || !listEl || !currentUser) return;

  try {
    const { data, error } = await sb
      .from("group_invitations")
      .select("id, group_id, inviter_id, status, created_at")
      .eq("invitee_id", currentUser.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error || !data || !data.length) {
      groupInvitations = [];
      box.classList.add("hidden");
      listEl.innerHTML = "";
      return;
    }

    const gIds = Array.from(new Set(data.map((r) => r.group_id).filter(Boolean)));
    const inviterIds = Array.from(new Set(data.map((r) => r.inviter_id).filter(Boolean)));

    const [{ data: gRows }, { data: pRows }] = await Promise.all([
      gIds.length ? sb.from("groups").select("id, name").in("id", gIds) : { data: [] },
      inviterIds.length ? sb.from("profiles").select("id, nickname").in("id", inviterIds) : { data: [] },
    ]);

    const gMap = Object.fromEntries((gRows || []).map((g) => [g.id, g.name || "Group"]));
    const pMap = Object.fromEntries((pRows || []).map((p) => [p.id, p.nickname || "Player"]));

    groupInvitations = data.map((inv) => ({
      ...inv,
      group_name: gMap[inv.group_id] || "Group",
      inviter_name: pMap[inv.inviter_id] || "Player",
    }));

    box.classList.remove("hidden");
    listEl.innerHTML = groupInvitations
      .map(
        (inv) => `
          <div class="group-invite-row">
            <div style="min-width:0;">
              <div class="lb-name">${escapeHtml(inv.group_name)}</div>
              <div class="lb-sub">Invited by ${escapeHtml(inv.inviter_name)}</div>
            </div>
            <div class="group-invite-actions">
              <button type="button" class="group-invite-btn accept" onclick="respondGroupInvite('${escapeHtml(inv.id)}', true)">Accept</button>
              <button type="button" class="group-invite-btn decline" onclick="respondGroupInvite('${escapeHtml(inv.id)}', false)">Decline</button>
            </div>
          </div>
        `
      )
      .join("");
  } catch {
    box.classList.add("hidden");
  }
}

window.respondGroupInvite = async function (inviteId, accept) {
  const inv = groupInvitations.find((i) => String(i.id) === String(inviteId));
  if (!inv) return;

  setStatus($("group-list-status"), accept ? "Joining group..." : "Declining invitation...");
  if (accept) {
    const { error: memErr } = await sb
      .from("group_members")
      .insert({ group_id: inv.group_id, user_id: currentUser.id });
    if (memErr && !String(memErr.message || "").toLowerCase().includes("duplicate")) {
      setStatus($("group-list-status"), memErr.message, "err");
      return;
    }
  }

  await sb
    .from("group_invitations")
    .update({ status: accept ? "accepted" : "declined" })
    .eq("id", inviteId);

  setStatus($("group-list-status"), accept ? `Joined ${inv.group_name}!` : "Invitation declined.", "ok");
  await loadGroups();
};

async function loadGroups() {
  setStatus($("group-list-status"), "Loading groups...");
  await loadGroupInvitations();

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
    $("groups-list-container").innerHTML = `<p class="muted">You are not part of any group yet. Tap + at the top right to create one.</p>`;
    return;
  }

  const [{ data: groupsData, error: gErr }, { data: allMembers }, { data: allMatches }] = await Promise.all([
    sb.from("groups").select("id, name, owner_id, created_at").in("id", groupIds).order("name", { ascending: true }),
    sb.from("group_members").select("group_id, user_id").in("group_id", groupIds),
    sb.from("matches").select("group_id, created_at").in("group_id", groupIds),
  ]);

  if (gErr) {
    setStatus($("group-list-status"), gErr.message, "err");
    return;
  }

  const memberCountByGroup = {};
  for (const m of allMembers || []) {
    memberCountByGroup[m.group_id] = (memberCountByGroup[m.group_id] || 0) + 1;
  }

  const matchStatsByGroup = {};
  for (const mt of allMatches || []) {
    const gid = mt.group_id;
    if (!matchStatsByGroup[gid]) matchStatsByGroup[gid] = { count: 0, last: "" };
    matchStatsByGroup[gid].count += 1;
    const dt = String(mt.created_at || "").slice(0, 10);
    if (dt > matchStatsByGroup[gid].last) matchStatsByGroup[gid].last = dt;
  }

  myGroups = (groupsData || []).map((g) => ({
    ...g,
    members_count: memberCountByGroup[g.id] || 1,
    matches_count: matchStatsByGroup[g.id]?.count || 0,
    last_match: matchStatsByGroup[g.id]?.last || "",
  }));

  setStatus($("group-list-status"), "");
  renderGroupsList();
}

function renderGroupsList() {
  const container = $("groups-list-container");
  const q = ($("groups-search-input")?.value || "").trim().toLowerCase();

  if (!myGroups.length) {
    container.innerHTML = `<p class="muted">No groups found.</p>`;
    return;
  }

  const filtered = q
    ? myGroups.filter((g) => String(g.name || "").toLowerCase().includes(q))
    : myGroups;

  if (!filtered.length) {
    container.innerHTML = `<p class="muted">No groups match your search.</p>`;
    return;
  }

  container.innerHTML = filtered
    .map((g) => {
      const isOwner = String(g.owner_id || "") === String(currentUser?.id || "");
      const roleHtml = `<span class="group-role-pill ${isOwner ? "owner" : ""}">${isOwner ? "Owner" : "Member"}</span>`;
      const memTxt = g.members_count === 1 ? "1 member" : `${g.members_count} members`;
      const matTxt = g.matches_count === 1 ? "1 match" : `${g.matches_count} matches`;
      const lastTxt = g.last_match ? ` · Last: ${formatFullDateIt(g.last_match)}` : "";
      return `
        <div class="group-card" onclick="openGroupDetail('${escapeHtml(g.id)}')">
          <div style="min-width:0;">
            <div class="group-card-title">${escapeHtml(g.name || "Group")}${roleHtml}</div>
            <div class="group-card-meta">${memTxt} · ${matTxt}${escapeHtml(lastTxt)}</div>
          </div>
          <div class="deck-banner-arrow">›</div>
        </div>
      `;
    })
    .join("");
}

$("groups-search-input")?.addEventListener("input", renderGroupsList);

// ---- CREATE NEW GROUP ----
$("btn-open-new-group")?.addEventListener("click", () => {
  if ($("new-group-name")) $("new-group-name").value = "";
  setStatus($("new-group-status"), "");
  $("new-group-modal")?.classList.remove("hidden");
  setTimeout(() => $("new-group-name")?.focus(), 50);
});

$("btn-cancel-new-group")?.addEventListener("click", () => {
  $("new-group-modal")?.classList.add("hidden");
});

$("btn-create-new-group")?.addEventListener("click", async () => {
  const name = ($("new-group-name")?.value || "").trim();
  if (!name) {
    setStatus($("new-group-status"), "Group name cannot be empty.", "err");
    return;
  }

  setStatus($("new-group-status"), "Creating group...");
  const { data: grp, error } = await sb
    .from("groups")
    .insert({ name, owner_id: currentUser.id })
    .select("*")
    .single();

  if (error || !grp) {
    setStatus($("new-group-status"), error?.message || "Error creating group.", "err");
    return;
  }

  await sb.from("group_members").insert({ group_id: grp.id, user_id: currentUser.id });

  $("new-group-modal")?.classList.add("hidden");
  await loadGroups();
  openGroupDetail(grp.id);
});

// ---- GROUP DETAIL ----
window.openGroupDetail = async function (groupId) {
  const grp = myGroups.find((g) => String(g.id) === String(groupId));
  if (!grp) return;

  selectedGroupId = grp.id;
  const isOwner = String(grp.owner_id || "") === String(currentUser?.id || "");
  $("group-detail-title").textContent = grp.name || "Group";
  $("group-detail-role").textContent = isOwner ? "Owner" : "Member";
  $("btn-rename-group")?.classList.toggle("hidden", !isOwner);
  if ($("btn-leave-group")) {
    $("btn-leave-group").textContent = grp.members_count <= 1 ? "Delete" : "Leave";
  }

  setStatus($("group-status"), "");
  setStatus($("group-decks-status"), "");
  setStatus($("group-members-status"), "");

  $("groups-list-view").classList.add("hidden");
  $("group-detail-view").classList.remove("hidden");
  switchGroupSubtab("group-sub-stats");

  await loadGroupDetails(grp.id);
};

$("btn-back-to-groups")?.addEventListener("click", () => {
  selectedGroupId = null;
  $("group-detail-view").classList.add("hidden");
  $("groups-list-view").classList.remove("hidden");
});

$("btn-rename-group")?.addEventListener("click", async () => {
  if (!selectedGroupId) return;
  const grp = myGroups.find((g) => String(g.id) === String(selectedGroupId));
  const newName = prompt("New group name:", grp?.name || "");
  if (newName === null) return;
  const clean = newName.trim();
  if (!clean) return;

  const { error } = await sb.from("groups").update({ name: clean }).eq("id", selectedGroupId);
  if (error) {
    alert(`Error renaming group: ${error.message}`);
    return;
  }
  if (grp) grp.name = clean;
  $("group-detail-title").textContent = clean;
  renderGroupsList();
});

$("btn-leave-group")?.addEventListener("click", async () => {
  if (!selectedGroupId) return;
  const grp = myGroups.find((g) => String(g.id) === String(selectedGroupId));
  const isLastMember = (grp?.members_count || 1) <= 1;
  const msg = isLastMember
    ? `Permanently delete "${grp?.name || "this group"}"?`
    : `Leave "${grp?.name || "this group"}"? The group will remain active for other members.`;
  if (!confirm(msg)) return;

  const targetId = selectedGroupId;
  const { error: rpcErr } = await sb.rpc("leave_group_safe", { p_group_id: targetId });
  if (rpcErr) {
    // Fallback if RPC is unavailable
    await sb.from("group_members").delete().eq("group_id", targetId).eq("user_id", currentUser.id);
    if (isLastMember) {
      await sb.from("groups").delete().eq("id", targetId);
    }
  }

  selectedGroupId = null;
  $("group-detail-view").classList.add("hidden");
  $("groups-list-view").classList.remove("hidden");
  await loadGroups();
});

async function loadGroupDetails(groupId) {
  if (!groupId) return;

  const [
    { data: members },
    { data: decks },
    { data: matches },
    playerLbRes,
    deckLbRes,
  ] = await Promise.all([
    sb.from("group_members").select("user_id, role").eq("group_id", groupId),
    sb.from("group_decks").select("*").eq("group_id", groupId).order("name", { ascending: true }),
    sb.from("matches").select("id, created_at, played_on, notes").eq("group_id", groupId).order("created_at", { ascending: false }).limit(200),
    sb.rpc("group_player_leaderboard", { group_id_in: groupId }),
    sb.rpc("group_deck_leaderboard", { group_id_in: groupId }),
  ]);

  const matchRows = matches || [];
  const matchIds = matchRows.map((m) => m.id).filter(Boolean);
  let matchPlayers = [];
  if (matchIds.length) {
    const { data: mpData } = await sb
      .from("match_players")
      .select("match_id, user_id, group_deck_id, is_winner, seat")
      .in("match_id", matchIds);
    matchPlayers = mpData || [];
  }

  groupDecks = decks || [];
  groupMatchesData = { matches: matchRows, players: matchPlayers };

  // Collect all user IDs (current members + past players in history)
  const allUserIds = Array.from(
    new Set([
      ...(members || []).map((m) => m.user_id),
      ...matchPlayers.map((p) => p.user_id),
      ...groupDecks.map((d) => d.owner_id || d.user_id),
    ].filter(Boolean))
  );

  let profiles = [];
  if (allUserIds.length) {
    const { data: profData } = await sb
      .from("profiles")
      .select("id, nickname, avatar_url")
      .in("id", allUserIds);
    profiles = profData || [];
  }

  groupProfilesMap = Object.fromEntries(
    profiles.map((p) => [
      p.id,
      {
        name: (p.nickname || "").trim() || p.id.slice(0, 6),
        avatar_url: (p.avatar_url || "").trim(),
      },
    ])
  );

  const memberIds = (members || []).map((m) => m.user_id);
  groupMembers = memberIds.map((uid) => ({
    user_id: uid,
    name: groupProfilesMap[uid]?.name || uid.slice(0, 6),
    avatar_url: groupProfilesMap[uid]?.avatar_url || "",
  }));

  // Player Leaderboard (RPC or fallback from match_players)
  if (!playerLbRes.error && Array.isArray(playerLbRes.data)) {
    groupPlayerLb = playerLbRes.data.map((r) => {
      const games = Number(r.games || 0);
      const wins = Number(r.wins || 0);
      return {
        user_id: r.user_id,
        matches: games,
        wins,
        winrate: games > 0 ? (wins / games) * 100 : 0,
      };
    });
  } else {
    const byUser = new Map();
    for (const p of matchPlayers) {
      const cur = byUser.get(p.user_id) || { user_id: p.user_id, matches: 0, wins: 0 };
      cur.matches += 1;
      if (p.is_winner) cur.wins += 1;
      byUser.set(p.user_id, cur);
    }
    groupPlayerLb = Array.from(byUser.values())
      .map((r) => ({ ...r, winrate: r.matches > 0 ? (r.wins / r.matches) * 100 : 0 }))
      .sort((a, b) => b.winrate - a.winrate || b.wins - a.wins);
  }

  // Deck Leaderboard (RPC or fallback from match_players)
  if (!deckLbRes.error && Array.isArray(deckLbRes.data)) {
    groupDeckLb = deckLbRes.data.map((r) => {
      const games = Number(r.games || 0);
      const wins = Number(r.wins || 0);
      return {
        deck_id: r.deck_id,
        matches: games,
        wins,
        winrate: games > 0 ? (wins / games) * 100 : 0,
      };
    });
  } else {
    const byDeck = new Map();
    for (const p of matchPlayers) {
      if (!p.group_deck_id) continue;
      const cur = byDeck.get(p.group_deck_id) || { deck_id: p.group_deck_id, matches: 0, wins: 0 };
      cur.matches += 1;
      if (p.is_winner) cur.wins += 1;
      byDeck.set(p.group_deck_id, cur);
    }
    groupDeckLb = Array.from(byDeck.values())
      .map((r) => ({ ...r, winrate: r.matches > 0 ? (r.wins / r.matches) * 100 : 0 }))
      .sort((a, b) => b.winrate - a.winrate || b.wins - a.wins);
  }

  const grp = myGroups.find((g) => String(g.id) === String(groupId));
  if (grp) {
    grp.members_count = groupMembers.length;
    grp.matches_count = matchRows.length;
  }
  const activeDecksCount = groupDecks.filter((d) => !d.archived_at).length;
  if ($("group-detail-meta")) {
    $("group-detail-meta").textContent =
      `${groupMembers.length} members · ${activeDecksCount} decks · ${matchRows.length} matches`;
  }
  if ($("btn-leave-group")) {
    $("btn-leave-group").textContent = groupMembers.length <= 1 ? "Delete" : "Leave";
  }

  renderGroupLeaderboards();
  renderGroupMatchesHistory();
  renderGroupPlayers();
  renderGroupDecksSection();
  renderGroupMembersSection();
}

function renderGroupLeaderboards() {
  // Players
  const pBox = $("group-player-lb");
  if (!groupPlayerLb.length) {
    pBox.innerHTML = `<p class="muted">No matches logged yet.</p>`;
  } else {
    pBox.innerHTML = groupPlayerLb
      .map((r, i) => {
        const prof = groupProfilesMap[r.user_id] || { name: r.user_id?.slice(0, 6) || "Player", avatar_url: "" };
        const rankCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
        return `
          <div class="lb-row">
            <span class="lb-rank ${rankCls}">#${i + 1}</span>
            ${renderMiniAvatarHtml(prof.name, prof.avatar_url)}
            <div class="lb-main">
              <div class="lb-name">${escapeHtml(prof.name)}</div>
              <div class="lb-sub">${r.wins}W / ${r.matches}M</div>
              <div class="lb-bar-wrap"><div class="lb-bar-fill" style="width:${Math.round(r.winrate)}%;"></div></div>
            </div>
            <span class="lb-wr">${r.winrate.toFixed(1)}%</span>
          </div>
        `;
      })
      .join("");
  }

  // Decks
  const dBox = $("group-deck-lb");
  if (!groupDeckLb.length) {
    dBox.innerHTML = `<p class="muted">No deck stats yet.</p>`;
  } else {
    const deckMap = Object.fromEntries(groupDecks.map((d) => [d.id, d]));
    dBox.innerHTML = groupDeckLb
      .map((r, i) => {
        const dObj = deckMap[r.deck_id];
        const dName = dObj?.name || "Archived Deck";
        const ownerId = dObj?.owner_id || dObj?.user_id || "";
        const ownerName = ownerId ? (groupProfilesMap[ownerId]?.name || "") : "";
        const rankCls = i === 0 ? "top1" : i === 1 ? "top2" : i === 2 ? "top3" : "";
        return `
          <div class="lb-row">
            <span class="lb-rank ${rankCls}">#${i + 1}</span>
            <div class="lb-main">
              <div class="lb-name">${escapeHtml(dName)}</div>
              <div class="lb-sub">${ownerName ? `${escapeHtml(ownerName)} · ` : ""}${r.wins}W / ${r.matches}M</div>
              <div class="lb-bar-wrap"><div class="lb-bar-fill" style="width:${Math.round(r.winrate)}%;"></div></div>
            </div>
            <span class="lb-wr">${r.winrate.toFixed(1)}%</span>
          </div>
        `;
      })
      .join("");
  }
}

function renderGroupMatchesHistory() {
  const box = $("group-matches-list");
  const { matches, players } = groupMatchesData;
  if (!matches.length) {
    box.innerHTML = `<p class="muted">No matches recorded in this group yet.</p>`;
    return;
  }

  const deckMap = Object.fromEntries(groupDecks.map((d) => [d.id, d.name || "Deck"]));
  const playersByMatch = new Map();
  for (const p of players) {
    if (!playersByMatch.has(p.match_id)) playersByMatch.set(p.match_id, []);
    playersByMatch.get(p.match_id).push(p);
  }

  // Group matches by day
  const byDay = new Map();
  for (const m of matches) {
    const day = String(m.played_on || m.created_at || "").slice(0, 10) || "Unknown";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(m);
  }

  box.innerHTML = Array.from(byDay.entries())
    .map(([day, list]) => {
      const dayLabel = day === "Unknown" ? day : formatFullDateIt(day);
      const countLbl = list.length === 1 ? "1 match" : `${list.length} matches`;
      const cardsHtml = list
        .map((m) => {
          const plist = playersByMatch.get(m.id) || [];
          const winner = plist.find((p) => p.is_winner);
          const winnerName = winner ? (groupProfilesMap[winner.user_id]?.name || "Player") : "—";
          const winnerDeck = winner?.group_deck_id ? deckMap[winner.group_deck_id] || "" : "";

          const playersLines = plist
            .map((p) => {
              const pName = groupProfilesMap[p.user_id]?.name || "Player";
              const dName = p.group_deck_id ? deckMap[p.group_deck_id] || "Deck" : "—";
              const crown = p.is_winner ? "🏆 " : "• ";
              return `<div>${crown}<strong>${escapeHtml(pName)}</strong> — ${escapeHtml(dName)}</div>`;
            })
            .join("");

          return `
            <div class="group-match-card">
              <div class="group-match-top">
                <span class="group-match-winner">🏆 ${escapeHtml(winnerName)}${winnerDeck ? ` (${escapeHtml(winnerDeck)})` : ""}</span>
                <button type="button" class="history-del-btn" onclick="deleteGroupMatch('${escapeHtml(m.id)}')">Delete</button>
              </div>
              <div class="group-match-players">${playersLines}</div>
              ${m.notes ? `<div class="group-match-notes">"${escapeHtml(m.notes)}"</div>` : ""}
            </div>
          `;
        })
        .join("");

      return `
        <div class="match-day-header"><span>${escapeHtml(dayLabel)}</span><span>${countLbl}</span></div>
        ${cardsHtml}
      `;
    })
    .join("");
}

window.deleteGroupMatch = async function (matchId) {
  if (!matchId || !confirm("Delete this match from group history?")) return;
  await sb.from("match_players").delete().eq("match_id", matchId);
  const { error } = await sb.from("matches").delete().eq("id", matchId);
  if (error) {
    alert(`Failed to delete match: ${error.message}`);
    return;
  }
  await loadGroupDetails(selectedGroupId);
};

// ---- LOG NEW MATCH ----
function getActiveDecksForMember(userId) {
  const active = groupDecks.filter((d) => !d.archived_at);
  const owned = active.filter((d) => {
    const owner = d.owner_id ?? d.user_id ?? null;
    return owner && String(owner) === String(userId);
  });
  if (owned.length) return owned;
  return active.filter((d) => !(d.owner_id ?? d.user_id));
}

function renderGroupPlayers() {
  if (!groupMembers.length) {
    $("group-players-container").innerHTML = `<p class="muted">No members found.</p>`;
    return;
  }

  $("group-players-container").innerHTML = groupMembers
    .map((m, idx) => {
      const memberDecks = getActiveDecksForMember(m.user_id);
      const deckOpts = memberDecks.length
        ? memberDecks.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("")
        : `<option value="" disabled>No decks assigned to ${escapeHtml(m.name)}</option>`;

      return `
        <div class="player-box">
          <div class="group-member-left" style="margin-bottom:6px;">
            ${renderMiniAvatarHtml(m.name, m.avatar_url)}
            <strong>${escapeHtml(m.name)}</strong>
          </div>
          <label style="margin-top:4px;">Deck played</label>
          <select class="gp-deck" data-user-id="${escapeHtml(m.user_id)}">
            <option value="">— Not playing / Select deck —</option>
            ${deckOpts}
          </select>
          <label class="winner-row">
            <input type="radio" name="winner" value="${escapeHtml(m.user_id)}" ${idx === 0 ? "checked" : ""} />
            <span>Winner</span>
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
    setStatus($("group-status"), "Select a group and a winner.", "err");
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
    setStatus($("group-status"), "Select a deck for at least 2 participating players.", "err");
    return;
  }
  if (!rows.some((r) => r.is_winner)) {
    setStatus($("group-status"), "The selected winner must have a deck chosen.", "err");
    return;
  }

  setStatus($("group-status"), "Saving match...");
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
  setStatus($("group-status"), "Match saved! Leaderboards updated.", "ok");
  await loadGroupDetails(selectedGroupId);
  switchGroupSubtab("group-sub-stats");
});

// ---- GROUP DECKS MANAGEMENT ----
function renderGroupDecksSection() {
  // Populate personal decks selector
  const sel = $("group-import-personal-deck");
  if (sel) {
    sel.innerHTML =
      `<option value="">— Select personal deck —</option>` +
      myDecks
        .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name || "Untitled")} (${escapeHtml(getDeckFormatLabel(d))})</option>`)
        .join("");
  }

  const listEl = $("group-decks-list");
  const activeDecks = groupDecks.filter((d) => !d.archived_at);
  if (!activeDecks.length) {
    listEl.innerHTML = `<p class="muted">No active decks in this group yet.</p>`;
    return;
  }

  // Group by owner (current user first)
  const byOwner = new Map();
  for (const d of activeDecks) {
    const oid = String(d.owner_id || d.user_id || "shared");
    if (!byOwner.has(oid)) byOwner.set(oid, []);
    byOwner.get(oid).push(d);
  }

  const ownerKeys = Array.from(byOwner.keys()).sort((a, b) => {
    if (a === String(currentUser.id)) return -1;
    if (b === String(currentUser.id)) return 1;
    const na = groupProfilesMap[a]?.name || "Shared";
    const nb = groupProfilesMap[b]?.name || "Shared";
    return na.localeCompare(nb, "en");
  });

  listEl.innerHTML = ownerKeys
    .map((oid) => {
      const ownerName = oid === String(currentUser.id)
        ? `${groupProfilesMap[oid]?.name || "You"} (You)`
        : groupProfilesMap[oid]?.name || "Shared";
      const decks = byOwner.get(oid);
      const isMine = oid === String(currentUser.id);
      const rows = decks
        .map(
          (d) => `
            <div class="group-deck-row">
              <div class="lb-main">
                <div class="lb-name">${escapeHtml(d.name || "Deck")}</div>
                ${d.deck_id ? `<div class="lb-sub">Linked to personal deck</div>` : ""}
              </div>
              ${isMine ? `<button type="button" class="history-del-btn" onclick="removeGroupDeck('${escapeHtml(d.id)}')">Remove</button>` : ""}
            </div>
          `
        )
        .join("");
      return `
        <div class="match-day-header"><span>${escapeHtml(ownerName)}</span><span>${decks.length}</span></div>
        ${rows}
      `;
    })
    .join("");
}

async function addDeckToGroup(deckName, personalDeckId = null) {
  const cleanName = String(deckName || "").trim();
  if (!selectedGroupId || !cleanName) return;

  setStatus($("group-decks-status"), "Adding deck...");

  // Check if user already has an archived deck with the same name -> restore it
  const archived = groupDecks.find(
    (d) =>
      d.archived_at &&
      String(d.owner_id || d.user_id || "") === String(currentUser.id) &&
      String(d.name || "").trim().toLowerCase() === cleanName.toLowerCase()
  );

  if (archived) {
    const upd = { archived_at: null, name: cleanName };
    if (personalDeckId) upd.deck_id = personalDeckId;
    const { error } = await sb.from("group_decks").update(upd).eq("id", archived.id);
    if (error) {
      setStatus($("group-decks-status"), error.message, "err");
      return;
    }
    setStatus($("group-decks-status"), `Restored "${cleanName}" with its history!`, "ok");
    await loadGroupDetails(selectedGroupId);
    return;
  }

  const payload = {
    group_id: selectedGroupId,
    owner_id: currentUser.id,
    name: cleanName,
  };
  if (personalDeckId) payload.deck_id = personalDeckId;

  const { error } = await sb.from("group_decks").insert(payload);
  if (error) {
    setStatus($("group-decks-status"), error.message, "err");
    return;
  }

  setStatus($("group-decks-status"), `"${cleanName}" added to group!`, "ok");
  await loadGroupDetails(selectedGroupId);
}

$("btn-add-personal-group-deck")?.addEventListener("click", async () => {
  const deckId = $("group-import-personal-deck")?.value || "";
  if (!deckId) {
    setStatus($("group-decks-status"), "Select a personal deck first.", "err");
    return;
  }
  const d = myDecks.find((x) => String(x.id) === String(deckId));
  if (!d) return;
  await addDeckToGroup(d.name, d.id);
});

$("btn-add-custom-group-deck")?.addEventListener("click", async () => {
  const inp = $("group-custom-deck-name");
  const name = (inp?.value || "").trim();
  if (!name) {
    setStatus($("group-decks-status"), "Enter a deck name.", "err");
    return;
  }
  inp.value = "";
  await addDeckToGroup(name, null);
});

window.removeGroupDeck = async function (groupDeckId) {
  const d = groupDecks.find((x) => String(x.id) === String(groupDeckId));
  if (!d || !confirm(`Remove "${d.name}" from this group?`)) return;

  const { data: used } = await sb
    .from("match_players")
    .select("match_id")
    .eq("group_deck_id", groupDeckId)
    .limit(1);

  if (used && used.length > 0) {
    const { error } = await sb
      .from("group_decks")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", groupDeckId);
    if (error) {
      setStatus($("group-decks-status"), error.message, "err");
      return;
    }
    setStatus($("group-decks-status"), `"${d.name}" archived (match stats preserved).`, "ok");
  } else {
    const { error } = await sb.from("group_decks").delete().eq("id", groupDeckId);
    if (error) {
      setStatus($("group-decks-status"), error.message, "err");
      return;
    }
    setStatus($("group-decks-status"), `"${d.name}" removed.`, "ok");
  }

  await loadGroupDetails(selectedGroupId);
};

// ---- GROUP MEMBERS & INVITATIONS ----
function renderGroupMembersSection() {
  const listEl = $("group-members-list");
  const grp = myGroups.find((g) => String(g.id) === String(selectedGroupId));
  const ownerId = String(grp?.owner_id || "");
  const amIOwner = ownerId === String(currentUser?.id || "");

  if (!groupMembers.length) {
    listEl.innerHTML = `<p class="muted">No members found.</p>`;
    return;
  }

  listEl.innerHTML = groupMembers
    .map((m) => {
      const isMemberOwner = String(m.user_id) === ownerId;
      const isMe = String(m.user_id) === String(currentUser?.id || "");
      const badge = isMemberOwner ? `<span class="group-role-pill owner">Owner</span>` : "";
      const removeBtn =
        amIOwner && !isMe
          ? `<button type="button" class="history-del-btn" onclick="removeGroupMember('${escapeHtml(m.user_id)}')">Remove</button>`
          : "";
      return `
        <div class="group-member-row">
          <div class="group-member-left">
            ${renderMiniAvatarHtml(m.name, m.avatar_url)}
            <div class="lb-name">${escapeHtml(m.name)}${isMe ? " (You)" : ""}${badge}</div>
          </div>
          ${removeBtn}
        </div>
      `;
    })
    .join("");
}

window.removeGroupMember = async function (targetUserId) {
  if (!selectedGroupId || !targetUserId) return;
  const member = groupMembers.find((m) => String(m.user_id) === String(targetUserId));
  if (!confirm(`Remove "${member?.name || "this member"}" from the group?`)) return;

  const { error } = await sb
    .from("group_members")
    .delete()
    .eq("group_id", selectedGroupId)
    .eq("user_id", targetUserId);

  if (error) {
    setStatus($("group-members-status"), error.message, "err");
    return;
  }
  setStatus($("group-members-status"), "Member removed.", "ok");
  await loadGroupDetails(selectedGroupId);
};

$("btn-send-group-invite")?.addEventListener("click", async () => {
  if (!selectedGroupId) return;
  const inp = $("group-invite-input");
  const query = (inp?.value || "").trim();
  if (!query) {
    setStatus($("group-members-status"), "Enter a username or email.", "err");
    return;
  }

  setStatus($("group-members-status"), "Looking up player...");
  let targetId = null;

  if (query.includes("@")) {
    const { data: emailRes } = await sb.rpc("get_user_id_by_email", { email_in: query.toLowerCase() });
    if (Array.isArray(emailRes) && emailRes.length > 0) {
      targetId = emailRes[0].id;
    }
  }

  if (!targetId) {
    const { data: prof } = await sb
      .from("profiles")
      .select("id, nickname")
      .ilike("nickname", query)
      .limit(1);
    if (Array.isArray(prof) && prof.length > 0) {
      targetId = prof[0].id;
    }
  }

  if (!targetId) {
    setStatus($("group-members-status"), `No player found matching "${query}".`, "err");
    return;
  }

  if (groupMembers.some((m) => String(m.user_id) === String(targetId))) {
    setStatus($("group-members-status"), "This player is already in the group.", "err");
    return;
  }

  // Send invitation via group_invitations
  const { error: invErr } = await sb.from("group_invitations").upsert(
    {
      group_id: selectedGroupId,
      inviter_id: currentUser.id,
      invitee_id: targetId,
      status: "pending",
    },
    { onConflict: "group_id,invitee_id" }
  );

  if (invErr) {
    setStatus($("group-members-status"), invErr.message, "err");
    return;
  }

  inp.value = "";
  setStatus($("group-members-status"), "Invitation sent!", "ok");
});

// ---- MY COLLECTION PAGE (DESKTOP PARITY) ----
let myCollectionItems = [];
let colSelectedColors = new Set();
let colViewMode = "list"; // "list" | "grid"
let colActiveDetailId = null;

// Add Card Modal state
let colAddSearchResults = [];
let colAddSearchTimer = null;
let colAddPrints = [];
let colAddSelectedPrint = null;

function getCollectionUnitPrice(item) {
  if (!item) return null;
  const raw = item.foil
    ? (item.price_eur_foil ?? item.price_eur)
    : (item.price_eur ?? item.price_eur_foil);
  if (raw === null || raw === undefined || raw === "") return null;
  const num = Number(raw);
  return Number.isNaN(num) ? null : num;
}

function parseCollectorNumSort(cn) {
  const s = String(cn || "").trim();
  const m = s.match(/^(\d+)/);
  return [m ? parseInt(m[1], 10) : 999999, s.toLowerCase()];
}

function getRarityRank(rarity) {
  const r = String(rarity || "").toLowerCase();
  if (r === "mythic") return 0;
  if (r === "rare") return 1;
  if (r === "uncommon") return 2;
  if (r === "common") return 3;
  return 4;
}

async function loadUserCollection() {
  if (!currentUser) return;
  setStatus($("col-page-status"), "Loading collection...");

  const { data, error } = await sb
    .from("user_collection")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("set_name", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    setStatus($("col-page-status"), error.message, "err");
    return;
  }

  myCollectionItems = data || [];
  setStatus($("col-page-status"), "");
  populateCollectionSetFilter();
  updateCollectionKpis();
  renderCollectionList();
}

function populateCollectionSetFilter() {
  const sel = $("col-filter-set");
  if (!sel) return;
  const prev = sel.value || "ALL";
  const setMap = new Map();
  for (const it of myCollectionItems) {
    const code = String(it.set_code || "").toUpperCase();
    if (!code) continue;
    if (!setMap.has(code)) setMap.set(code, it.set_name || code);
  }
  const entries = Array.from(setMap.entries()).sort((a, b) => a[1].localeCompare(b[1], "en"));
  sel.innerHTML =
    `<option value="ALL">All Sets (${entries.length})</option>` +
    entries.map(([code, name]) => `<option value="${escapeHtml(code)}">[${escapeHtml(code)}] ${escapeHtml(name)}</option>`).join("");
  sel.value = setMap.has(prev) ? prev : "ALL";
}

function updateCollectionKpis() {
  let totalCopies = 0;
  let foilCopies = 0;
  let totalVal = 0;
  const sets = new Set();

  for (const it of myCollectionItems) {
    const qty = Math.max(1, Number(it.quantity || 1));
    totalCopies += qty;
    if (it.foil) foilCopies += qty;
    if (it.set_code) sets.add(String(it.set_code).toUpperCase());
    const p = getCollectionUnitPrice(it);
    if (p !== null) totalVal += p * qty;
  }

  if ($("col-kpi-total")) $("col-kpi-total").textContent = String(totalCopies);
  if ($("col-kpi-unique")) $("col-kpi-unique").textContent = `${myCollectionItems.length} unique`;
  if ($("col-kpi-value")) $("col-kpi-value").textContent = `€ ${totalVal.toFixed(2)}`;
  if ($("col-kpi-foil")) $("col-kpi-foil").textContent = `${foilCopies} foil`;
  if ($("col-kpi-sets")) $("col-kpi-sets").textContent = String(sets.size);
}

function getFilteredCollectionItems() {
  const q = ($("col-search-input")?.value || "").trim().toLowerCase();
  const setFilter = $("col-filter-set")?.value || "ALL";
  const rarityFilter = $("col-filter-rarity")?.value || "ALL";
  const finishFilter = $("col-filter-finish")?.value || "ALL";

  return myCollectionItems.filter((it) => {
    if (q) {
      const hay = `${it.name || ""} ${it.set_name || ""} ${it.set_code || ""} ${it.collector_number || ""} ${it.type_line || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (setFilter !== "ALL" && String(it.set_code || "").toUpperCase() !== setFilter) return false;
    if (rarityFilter !== "ALL" && String(it.rarity || "").toLowerCase() !== rarityFilter) return false;
    if (finishFilter === "foil" && !it.foil) return false;
    if (finishFilter === "nonfoil" && it.foil) return false;

    if (colSelectedColors.size > 0) {
      const cols = Array.isArray(it.colors) ? it.colors.map((c) => String(c).toUpperCase()) : [];
      const isColorless = cols.length === 0;
      let match = false;
      for (const wanted of colSelectedColors) {
        if (wanted === "C" && isColorless) match = true;
        else if (cols.includes(wanted)) match = true;
      }
      if (!match) return false;
    }
    return true;
  });
}

function sortCollectionSlice(list, sortMode) {
  const arr = list.slice();
  if (sortMode === "alpha") {
    return arr.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "en"));
  }
  if (sortMode === "price") {
    return arr.sort((a, b) => {
      const pa = (getCollectionUnitPrice(a) || 0) * Math.max(1, Number(a.quantity || 1));
      const pb = (getCollectionUnitPrice(b) || 0) * Math.max(1, Number(b.quantity || 1));
      if (pb !== pa) return pb - pa;
      return String(a.name || "").localeCompare(String(b.name || ""), "en");
    });
  }
  if (sortMode === "rarity") {
    return arr.sort((a, b) => {
      const ra = getRarityRank(a.rarity);
      const rb = getRarityRank(b.rarity);
      if (ra !== rb) return ra - rb;
      return String(a.name || "").localeCompare(String(b.name || ""), "en");
    });
  }
  if (sortMode === "qty") {
    return arr.sort((a, b) => {
      const qa = Number(a.quantity || 1);
      const qb = Number(b.quantity || 1);
      if (qb !== qa) return qb - qa;
      return String(a.name || "").localeCompare(String(b.name || ""), "en");
    });
  }
  // Default: collector number
  return arr.sort((a, b) => {
    const [na, sa] = parseCollectorNumSort(a.collector_number);
    const [nb, sbStr] = parseCollectorNumSort(b.collector_number);
    if (na !== nb) return na - nb;
    if (sa !== sbStr) return sa.localeCompare(sbStr);
    return String(a.name || "").localeCompare(String(b.name || ""), "en");
  });
}

function renderCollectionList() {
  const container = $("col-cards-container");
  if (!container) return;

  const filtered = getFilteredCollectionItems();
  const shownCopies = filtered.reduce((s, it) => s + Math.max(1, Number(it.quantity || 1)), 0);
  if ($("col-shown-count")) {
    $("col-shown-count").textContent = `${shownCopies} cards (${filtered.length} entries)`;
  }

  if (!myCollectionItems.length) {
    container.innerHTML = `<p class="muted">Your collection is empty. Tap + to add cards, Import a CSV, or use the Scanner tab.</p>`;
    return;
  }

  if (!filtered.length) {
    container.innerHTML = `<p class="muted">No cards match the current filters.</p>`;
    return;
  }

  const sortMode = $("col-sort-select")?.value || "set";

  // Group by Set when sorting by set, otherwise flat sorted list
  const sections = [];
  if (sortMode === "set") {
    const bySet = new Map();
    for (const it of filtered) {
      const code = String(it.set_code || "OTHER").toUpperCase();
      if (!bySet.has(code)) {
        const sec = { code, name: it.set_name || code, items: [] };
        bySet.set(code, sec);
        sections.push(sec);
      }
      bySet.get(code).items.push(it);
    }
    sections.sort((a, b) => a.name.localeCompare(b.name, "en"));
  } else {
    sections.push({ code: "", name: "", items: filtered });
  }

  container.innerHTML = sections
    .map((sec) => {
      const sorted = sortCollectionSlice(sec.items, sortMode);
      const secCopies = sorted.reduce((s, it) => s + Math.max(1, Number(it.quantity || 1)), 0);
      const secVal = sorted.reduce((s, it) => {
        const p = getCollectionUnitPrice(it);
        return s + (p !== null ? p * Math.max(1, Number(it.quantity || 1)) : 0);
      }, 0);

      const headerHtml = sec.code
        ? `
            <div class="col-set-header">
              <div class="col-set-left">
                <span class="col-set-code">${escapeHtml(sec.code)}</span>
                <span class="col-set-name">${escapeHtml(sec.name)}</span>
              </div>
              <span class="col-set-right">${secCopies} · € ${secVal.toFixed(2)}</span>
            </div>
          `
        : "";

      if (colViewMode === "grid") {
        const tiles = sorted
          .map((it) => {
            const qty = Math.max(1, Number(it.quantity || 1));
            const img = it.card_image_url || toNormalCardUrl(it.image_url || "");
            const p = getCollectionUnitPrice(it);
            const priceTxt = p !== null ? formatEur(p * qty) : "—";
            return `
              <div class="col-grid-tile ${it.foil ? "is-foil" : ""}">
                <div class="col-grid-img-wrap" onclick="openCollectionCardDetail('${escapeHtml(it.id)}')">
                  ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(it.name || "")}" loading="lazy" />` : `<div class="deck-stack-fallback">${escapeHtml(it.name || "")}</div>`}
                  ${it.foil ? `<span class="col-foil-overlay-badge">FOIL</span>` : ""}
                </div>
                <div class="deck-search-tile-name">${escapeHtml(it.name || "")}</div>
                <div class="col-grid-footer">
                  <span class="card-price-inline" data-col-price-id="${escapeHtml(it.id)}">${priceTxt}</span>
                  <div class="deck-qty-controls">
                    <button type="button" class="deck-qty-btn" onclick="changeCollectionQty('${escapeHtml(it.id)}', -1)">−</button>
                    <span class="deck-qty-num" data-col-qty-id="${escapeHtml(it.id)}">${qty}</span>
                    <button type="button" class="deck-qty-btn" onclick="changeCollectionQty('${escapeHtml(it.id)}', 1)">+</button>
                  </div>
                </div>
              </div>
            `;
          })
          .join("");
        return `${headerHtml}<div class="col-grid">${tiles}</div>`;
      }

      const rows = sorted
        .map((it) => {
          const qty = Math.max(1, Number(it.quantity || 1));
          const p = getCollectionUnitPrice(it);
          const priceTxt = p !== null ? formatEur(p * qty) : "";
          const rarCls = String(it.rarity || "common").toLowerCase();
          const setMeta = `${String(it.set_code || "").toUpperCase()}${it.collector_number ? ` #${it.collector_number}` : ""}`;
          return `
            <div class="deck-card-row">
              <div class="deck-card-main" onclick="openCollectionCardDetail('${escapeHtml(it.id)}')">
                <div class="deck-card-name-line">
                  <span class="col-rarity-dot ${escapeHtml(rarCls)}"></span>
                  <span class="deck-card-name">${escapeHtml(it.name || "")}</span>
                  ${it.foil ? `<span class="col-foil-pill">FOIL</span>` : ""}
                </div>
                <div class="deck-card-subline">
                  <span class="muted" style="font-size:11px;">${escapeHtml(setMeta)}</span>
                  ${renderManaPipsHtml(it.mana_cost) ? `<div class="deck-card-mana">${renderManaPipsHtml(it.mana_cost)}</div>` : ""}
                  ${priceTxt ? `<span class="card-price-inline" data-col-price-id="${escapeHtml(it.id)}">${priceTxt}</span>` : ""}
                </div>
              </div>
              <div class="deck-qty-controls">
                <button type="button" class="deck-qty-btn" onclick="changeCollectionQty('${escapeHtml(it.id)}', -1)">−</button>
                <span class="deck-qty-num" data-col-qty-id="${escapeHtml(it.id)}">${qty}</span>
                <button type="button" class="deck-qty-btn" onclick="changeCollectionQty('${escapeHtml(it.id)}', 1)">+</button>
              </div>
            </div>
          `;
        })
        .join("");

      return `${headerHtml}${rows}`;
    })
    .join("");
}

window.changeCollectionQty = async function (itemId, delta) {
  const idx = myCollectionItems.findIndex((x) => String(x.id) === String(itemId));
  if (idx === -1) return;
  const item = myCollectionItems[idx];
  const curQty = Math.max(1, Number(item.quantity || 1));
  const newQty = curQty + delta;

  if (newQty <= 0) {
    if (!confirm(`Remove "${item.name}" from your collection?`)) return;
    const { error } = await sb
      .from("user_collection")
      .delete()
      .eq("id", item.id)
      .eq("user_id", currentUser.id);
    if (error) {
      setStatus($("col-page-status"), error.message, "err");
      return;
    }
    myCollectionItems.splice(idx, 1);
    if (String(colActiveDetailId) === String(item.id)) {
      $("col-detail-modal")?.classList.add("hidden");
      colActiveDetailId = null;
    }
    populateCollectionSetFilter();
    updateCollectionKpis();
    renderCollectionList();
    return;
  }

  // In-place update (zero flash)
  item.quantity = newQty;
  document.querySelectorAll(`[data-col-qty-id="${item.id}"]`).forEach((el) => {
    el.textContent = String(newQty);
  });
  const unitP = getCollectionUnitPrice(item);
  if (unitP !== null) {
    document.querySelectorAll(`[data-col-price-id="${item.id}"]`).forEach((el) => {
      el.textContent = formatEur(unitP * newQty);
    });
  }
  if (String(colActiveDetailId) === String(item.id)) {
    if ($("col-detail-qty")) $("col-detail-qty").textContent = String(newQty);
    if ($("col-detail-price")) {
      $("col-detail-price").textContent = unitP !== null ? `${formatEur(unitP)} · Tot ${formatEur(unitP * newQty)}` : "—";
    }
  }
  updateCollectionKpis();

  const { error } = await sb
    .from("user_collection")
    .update({ quantity: newQty, updated_at: new Date().toISOString() })
    .eq("id", item.id)
    .eq("user_id", currentUser.id);

  if (error) {
    item.quantity = curQty;
    updateCollectionKpis();
    renderCollectionList();
    setStatus($("col-page-status"), error.message, "err");
  }
};

// Filter & View event listeners
$("col-search-input")?.addEventListener("input", renderCollectionList);
$("col-filter-set")?.addEventListener("change", renderCollectionList);
$("col-filter-rarity")?.addEventListener("change", renderCollectionList);
$("col-filter-finish")?.addEventListener("change", renderCollectionList);
$("col-sort-select")?.addEventListener("change", renderCollectionList);

$("btn-col-toggle-filters")?.addEventListener("click", () => {
  $("col-filters-panel")?.classList.toggle("hidden");
});

$("btn-col-reset-filters")?.addEventListener("click", () => {
  if ($("col-search-input")) $("col-search-input").value = "";
  if ($("col-filter-set")) $("col-filter-set").value = "ALL";
  if ($("col-filter-rarity")) $("col-filter-rarity").value = "ALL";
  if ($("col-filter-finish")) $("col-filter-finish").value = "ALL";
  if ($("col-sort-select")) $("col-sort-select").value = "set";
  colSelectedColors.clear();
  document.querySelectorAll(".col-color-btn").forEach((b) => b.classList.remove("active"));
  renderCollectionList();
});

document.querySelectorAll(".col-color-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const col = btn.dataset.colColor;
    if (colSelectedColors.has(col)) {
      colSelectedColors.delete(col);
      btn.classList.remove("active");
    } else {
      colSelectedColors.add(col);
      btn.classList.add("active");
    }
    renderCollectionList();
  });
});

$("btn-col-view-list")?.addEventListener("click", () => {
  colViewMode = "list";
  $("btn-col-view-list").classList.add("active");
  $("btn-col-view-grid").classList.remove("active");
  renderCollectionList();
});

$("btn-col-view-grid")?.addEventListener("click", () => {
  colViewMode = "grid";
  $("btn-col-view-grid").classList.add("active");
  $("btn-col-view-list").classList.remove("active");
  renderCollectionList();
});

// ---- COLLECTION CARD DETAIL MODAL ----
window.openCollectionCardDetail = function (itemId) {
  const item = myCollectionItems.find((x) => String(x.id) === String(itemId));
  if (!item) return;
  colActiveDetailId = item.id;

  const qty = Math.max(1, Number(item.quantity || 1));
  const unitP = getCollectionUnitPrice(item);
  const img = item.card_image_url || toNormalCardUrl(item.image_url || "");

  $("col-detail-img").src = img || "";
  $("col-detail-img-wrap")?.classList.toggle("is-foil", Boolean(item.foil));
  $("col-detail-foil-badge")?.classList.toggle("hidden", !item.foil);
  $("col-detail-name").textContent = item.name || "";
  const rar = item.rarity ? item.rarity.charAt(0).toUpperCase() + item.rarity.slice(1) : "";
  $("col-detail-meta").textContent = [
    `[${String(item.set_code || "").toUpperCase()}] ${item.set_name || ""}`.trim(),
    item.collector_number ? `#${item.collector_number}` : "",
    rar,
  ].filter(Boolean).join(" · ");

  $("col-detail-qty").textContent = String(qty);
  $("col-detail-price").textContent =
    unitP !== null ? `${formatEur(unitP)} · Tot ${formatEur(unitP * qty)}` : "—";

  $("col-detail-modal")?.classList.remove("hidden");
};

$("btn-col-detail-minus")?.addEventListener("click", () => {
  if (colActiveDetailId) changeCollectionQty(colActiveDetailId, -1);
});

$("btn-col-detail-plus")?.addEventListener("click", () => {
  if (colActiveDetailId) changeCollectionQty(colActiveDetailId, 1);
});

$("btn-col-detail-delete")?.addEventListener("click", async () => {
  if (!colActiveDetailId) return;
  const item = myCollectionItems.find((x) => String(x.id) === String(colActiveDetailId));
  if (!item) return;
  await changeCollectionQty(item.id, -Math.max(1, Number(item.quantity || 1)));
});

$("btn-col-detail-close")?.addEventListener("click", () => {
  colActiveDetailId = null;
  $("col-detail-modal")?.classList.add("hidden");
});

// ---- ADD CARD TO COLLECTION MODAL (SEARCH -> EDITION + FOIL + QTY) ----
$("btn-open-col-add")?.addEventListener("click", () => {
  colAddSearchResults = [];
  colAddPrints = [];
  colAddSelectedPrint = null;
  if ($("col-add-search-input")) $("col-add-search-input").value = "";
  if ($("col-add-results")) $("col-add-results").innerHTML = "";
  $("col-add-results")?.classList.remove("hidden");
  $("col-add-picker")?.classList.add("hidden");
  setStatus($("col-add-status"), "");
  $("col-add-modal")?.classList.remove("hidden");
  setTimeout(() => $("col-add-search-input")?.focus(), 50);
});

$("btn-close-col-add")?.addEventListener("click", () => {
  $("col-add-modal")?.classList.add("hidden");
});

$("btn-col-add-back")?.addEventListener("click", () => {
  $("col-add-picker")?.classList.add("hidden");
  $("col-add-results")?.classList.remove("hidden");
  setStatus($("col-add-status"), "");
});

async function searchCollectionAddCards() {
  const q = ($("col-add-search-input")?.value || "").trim();
  const box = $("col-add-results");
  if (q.length < 2) {
    colAddSearchResults = [];
    box.innerHTML = "";
    setStatus($("col-add-status"), "");
    return;
  }
  $("col-add-picker")?.classList.add("hidden");
  box.classList.remove("hidden");
  setStatus($("col-add-status"), "Searching Scryfall...");
  try {
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards`
    );
    if (!resp.ok) {
      colAddSearchResults = [];
      box.innerHTML = "";
      setStatus($("col-add-status"), "No cards found.");
      return;
    }
    const json = await resp.json();
    colAddSearchResults = (json.data || []).slice(0, 12);
    setStatus($("col-add-status"), "");
    box.innerHTML = colAddSearchResults
      .map((c, i) => {
        const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || "";
        const price = extractScryfallEurPrice(c, false);
        return `
          <div class="deck-search-tile">
            ${img ? `<img class="deck-search-tile-img" src="${escapeHtml(img)}" alt="${escapeHtml(c.name || "")}" loading="lazy" />` : `<div class="deck-search-tile-img"></div>`}
            <div class="deck-search-tile-name">${escapeHtml(c.name || "")}</div>
            <div class="deck-search-tile-price">${formatEur(price)}</div>
            <button type="button" class="deck-add-btn" onclick="openColAddEditionPicker(${i})">Select</button>
          </div>
        `;
      })
      .join("");
  } catch {
    setStatus($("col-add-status"), "Scryfall connection error.", "err");
  }
}

$("btn-col-add-search")?.addEventListener("click", searchCollectionAddCards);
$("col-add-search-input")?.addEventListener("input", () => {
  clearTimeout(colAddSearchTimer);
  colAddSearchTimer = setTimeout(searchCollectionAddCards, 350);
});

function updateColAddPickerPreview() {
  const pr = colAddSelectedPrint;
  if (!pr) return;
  const isFoil = $("col-add-finish-select")?.value === "foil";
  const img = pr.image_uris?.normal || pr.card_faces?.[0]?.image_uris?.normal || "";
  const p = extractScryfallEurPrice(pr, isFoil);

  $("col-add-preview-img").src = img;
  $("col-add-card-name").textContent = pr.name || "";
  $("col-add-card-price").textContent = formatEur(p);
  $("col-add-foil-badge")?.classList.toggle("hidden", !isFoil);
}

window.openColAddEditionPicker = async function (idx) {
  const sc = colAddSearchResults[idx];
  if (!sc) return;

  colAddPrints = [sc];
  colAddSelectedPrint = sc;
  $("col-add-results")?.classList.add("hidden");
  $("col-add-picker")?.classList.remove("hidden");
  if ($("col-add-finish-select")) $("col-add-finish-select").value = "nonfoil";
  if ($("col-add-qty-input")) $("col-add-qty-input").value = "1";
  updateColAddPickerPreview();

  const edSel = $("col-add-edition-select");
  edSel.innerHTML = `<option value="0">Loading all printings...</option>`;

  try {
    const cleanName = String(sc.name || "").split("//")[0].trim();
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`!"${cleanName}"`)}&unique=prints&order=released&dir=desc`
    );
    if (resp.ok) {
      const json = await resp.json();
      if (Array.isArray(json.data) && json.data.length > 0) {
        colAddPrints = json.data;
        colAddSelectedPrint = colAddPrints[0];
        edSel.innerHTML = colAddPrints
          .map((p, i) => {
            const scode = String(p.set || "").toUpperCase();
            const cn = p.collector_number ? `#${p.collector_number}` : "";
            const prEur = extractScryfallEurPrice(p, false);
            const prTxt = prEur !== null ? ` · €${prEur.toFixed(2)}` : "";
            return `<option value="${i}">[${escapeHtml(scode)}] ${escapeHtml(p.set_name || scode)} ${escapeHtml(cn)}${prTxt}</option>`;
          })
          .join("");
        edSel.value = "0";
        updateColAddPickerPreview();
      }
    }
  } catch {
    // keep default print
  }
};

$("col-add-edition-select")?.addEventListener("change", (e) => {
  const i = parseInt(e.target.value, 10);
  if (!Number.isNaN(i) && colAddPrints[i]) {
    colAddSelectedPrint = colAddPrints[i];
    updateColAddPickerPreview();
  }
});

$("col-add-finish-select")?.addEventListener("change", updateColAddPickerPreview);

function buildCollectionRowFromScryfall(sc, isFoil, qty) {
  const normalUrl = sc.image_uris?.normal || sc.card_faces?.[0]?.image_uris?.normal || "";
  const artUrl = sc.image_uris?.art_crop || sc.card_faces?.[0]?.image_uris?.art_crop || normalUrl;
  return {
    user_id: currentUser.id,
    scryfall_id: sc.id || "",
    name: sc.name || "",
    set_code: String(sc.set || "").toUpperCase(),
    set_name: sc.set_name || "",
    collector_number: String(sc.collector_number || ""),
    released_at: sc.released_at || "",
    rarity: String(sc.rarity || "").toLowerCase(),
    type_line: sc.type_line || "",
    mana_cost: extractManaCostFromScryfall(sc),
    cmc: Number(sc.cmc || 0),
    colors: Array.isArray(sc.colors) ? sc.colors : (Array.isArray(sc.color_identity) ? sc.color_identity : []),
    image_url: artUrl,
    card_image_url: normalUrl,
    price_eur: extractScryfallEurPrice(sc, false),
    price_eur_foil: extractScryfallEurPrice(sc, true),
    foil: Boolean(isFoil),
    quantity: Math.max(1, Number(qty || 1)),
  };
}

$("btn-col-add-confirm")?.addEventListener("click", async () => {
  if (!colAddSelectedPrint || !currentUser) return;
  const isFoil = $("col-add-finish-select")?.value === "foil";
  const qty = Math.max(1, parseInt($("col-add-qty-input")?.value || "1", 10));
  const row = buildCollectionRowFromScryfall(colAddSelectedPrint, isFoil, qty);

  setStatus($("col-add-status"), `Adding ${row.name}...`);

  const { data: existing, error: selErr } = await sb
    .from("user_collection")
    .select("id, quantity")
    .eq("user_id", currentUser.id)
    .eq("scryfall_id", row.scryfall_id)
    .eq("foil", row.foil)
    .maybeSingle();

  if (selErr) {
    setStatus($("col-add-status"), selErr.message, "err");
    return;
  }

  let saveErr = null;
  if (existing) {
    const { error } = await sb
      .from("user_collection")
      .update({
        quantity: (existing.quantity || 0) + qty,
        price_eur: row.price_eur,
        price_eur_foil: row.price_eur_foil,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    saveErr = error;
  } else {
    const { error } = await sb.from("user_collection").insert(row);
    saveErr = error;
  }

  if (saveErr) {
    setStatus($("col-add-status"), saveErr.message, "err");
    return;
  }

  $("col-add-modal")?.classList.add("hidden");
  await loadUserCollection();
  setStatus($("col-page-status"), `Added ${qty}x ${row.name} [${row.set_code}]!`, "ok");
});

// ---- IMPORT COLLECTION (CSV FROM MANABOX/MOXFIELD OR TEXT) ----
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseCollectionCsvOrText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  // Detect CSV header (ManaBox / Moxfield)
  const firstCols = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/^"|"$/g, ""));
  const hasNameCol = firstCols.includes("name") || firstCols.includes("card name");
  if (firstCols.length >= 3 && hasNameCol) {
    const idxName = firstCols.findIndex((h) => h === "name" || h === "card name");
    const idxQty = firstCols.findIndex((h) => h === "quantity" || h === "count" || h === "tradelist count");
    const idxSet = firstCols.findIndex((h) => h === "set code" || h === "edition" || h === "set");
    const idxNum = firstCols.findIndex((h) => h === "collector number" || h === "card number" || h === "number");
    const idxFoil = firstCols.findIndex((h) => h === "foil" || h === "finish");
    const idxScryfall = firstCols.findIndex((h) => h === "scryfall id");

    const parsed = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const name = (cols[idxName] || "").trim();
      if (!name) continue;
      const qty = Math.max(1, parseInt(cols[idxQty] || "1", 10) || 1);
      const setCode = idxSet >= 0 ? String(cols[idxSet] || "").trim().toLowerCase() : "";
      const collectorNumber = idxNum >= 0 ? String(cols[idxNum] || "").trim() : "";
      const foilRaw = idxFoil >= 0 ? String(cols[idxFoil] || "").trim().toLowerCase() : "";
      const isFoil = foilRaw === "foil" || foilRaw === "etched" || foilRaw === "true" || foilRaw === "1" || foilRaw === "yes";
      const scryfallId = idxScryfall >= 0 ? String(cols[idxScryfall] || "").trim() : "";
      parsed.push({ qty, name, setCode, collectorNumber, isFoil, scryfallId });
    }
    return parsed;
  }

  // Fallback to decklist text parser
  return parseDecklistText(text).map((it) => ({
    qty: it.qty,
    name: it.name,
    setCode: it.setCode,
    collectorNumber: it.collectorNumber,
    isFoil: it.isFoil,
    scryfallId: "",
  }));
}

$("btn-open-col-import")?.addEventListener("click", () => {
  if ($("col-import-file")) $("col-import-file").value = "";
  if ($("col-import-textarea")) $("col-import-textarea").value = "";
  setStatus($("col-import-status"), "");
  $("col-import-modal")?.classList.remove("hidden");
});

$("btn-cancel-col-import")?.addEventListener("click", () => {
  $("col-import-modal")?.classList.add("hidden");
});

$("col-import-file")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    if ($("col-import-textarea")) $("col-import-textarea").value = String(reader.result || "");
    setStatus($("col-import-status"), `Loaded "${file.name}". Tap Import to continue.`, "ok");
  };
  reader.readAsText(file);
});

$("btn-run-col-import")?.addEventListener("click", async () => {
  const raw = ($("col-import-textarea")?.value || "").trim();
  const items = parseCollectionCsvOrText(raw);
  if (!items.length) {
    setStatus($("col-import-status"), "Upload a CSV or paste at least one card.", "err");
    return;
  }

  const btn = $("btn-run-col-import");
  if (btn) btn.disabled = true;

  try {
    setStatus($("col-import-status"), `Looking up ${items.length} cards on Scryfall...`);

    const byId = new Map();
    const bySetNum = new Map();
    const byName = new Map();

    for (let i = 0; i < items.length; i += 75) {
      const chunk = items.slice(i, i + 75);
      const identifiers = chunk
        .map((it) => {
          if (it.scryfallId && /^[0-9a-f-]{36}$/i.test(it.scryfallId)) return { id: it.scryfallId };
          if (it.setCode && it.collectorNumber) return { set: it.setCode, collector_number: it.collectorNumber };
          const front = it.name.split("//")[0].trim();
          return front ? { name: front } : null;
        })
        .filter(Boolean);

      if (!identifiers.length) continue;
      const resp = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers }),
      });
      if (!resp.ok) continue;
      const json = await resp.json();
      for (const sc of json.data || []) {
        if (sc.id) byId.set(String(sc.id), sc);
        if (sc.set && sc.collector_number) {
          bySetNum.set(`${String(sc.set).toLowerCase()}|${String(sc.collector_number).toLowerCase()}`, sc);
        }
        if (sc.name) {
          byName.set(sc.name.toLowerCase(), sc);
          byName.set(sc.name.split("//")[0].trim().toLowerCase(), sc);
        }
      }
    }

    // Merge imported rows by (scryfall_id, foil)
    const merged = new Map();
    const notFound = [];

    for (const it of items) {
      const frontLower = it.name.split("//")[0].trim().toLowerCase();
      const sc =
        (it.scryfallId && byId.get(it.scryfallId)) ||
        (it.setCode && it.collectorNumber && bySetNum.get(`${it.setCode}|${it.collectorNumber.toLowerCase()}`)) ||
        byName.get(it.name.toLowerCase()) ||
        byName.get(frontLower);

      if (!sc) {
        notFound.push(it.name);
        continue;
      }

      const key = `${sc.id}|${it.isFoil ? 1 : 0}`;
      if (merged.has(key)) {
        merged.get(key).quantity += it.qty;
      } else {
        merged.set(key, buildCollectionRowFromScryfall(sc, it.isFoil, it.qty));
      }
    }

    if (!merged.size) {
      setStatus($("col-import-status"), "No cards matched on Scryfall.", "err");
      return;
    }

    setStatus($("col-import-status"), `Saving ${merged.size} entries to Supabase...`);

    // Sum with existing collection quantities
    const existingMap = new Map(
      myCollectionItems.map((r) => [`${r.scryfall_id}|${r.foil ? 1 : 0}`, Number(r.quantity || 0)])
    );

    const payload = Array.from(merged.entries()).map(([key, row]) => ({
      ...row,
      quantity: row.quantity + (existingMap.get(key) || 0),
      updated_at: new Date().toISOString(),
    }));

    for (let i = 0; i < payload.length; i += 200) {
      const chunk = payload.slice(i, i + 200);
      const { error } = await sb
        .from("user_collection")
        .upsert(chunk, { onConflict: "user_id,scryfall_id,foil" });
      if (error) throw error;
    }

    await loadUserCollection();

    if (notFound.length > 0) {
      setStatus(
        $("col-import-status"),
        `Imported ${merged.size} entries. Not found (${notFound.length}): ${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? "…" : ""}`,
        "err"
      );
    } else {
      $("col-import-modal")?.classList.add("hidden");
      setStatus($("col-page-status"), `Imported ${merged.size} entries into your collection!`, "ok");
    }
  } catch (err) {
    setStatus($("col-import-status"), `Import error: ${err.message || err}`, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
});
// ---- PAGINA PROFILO ----
async function loadProfile() {
  if (!currentUser) return;
  const uid = currentUser.id;
  setStatus($("profile-status"), "");

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

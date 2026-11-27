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
const APP_UI_VERSION = "v2.8";
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
  "Ramp",
  "Draw",
  "Removal",
  "Board Wipe",
  "Tutor",
  "Protection",
  "Finisher",
  "Synergy",
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

// ---- CREAZIONE NUOVO MAZZO DA MOBILE ----
let newDeckSelectedCmd = null;
let newDeckCmdResults = [];

function toggleNewDeckCmdVisibility() {
  const fmt = $("new-deck-format")?.value || "";
  $("new-deck-cmd-section")?.classList.toggle("hidden", !isCommanderFormat(fmt));
}

function renderNewDeckSelectedCmd() {
  const pill = $("new-deck-cmd-selected");
  if (!pill) return;
  if (!newDeckSelectedCmd) {
    pill.classList.add("hidden");
    pill.innerHTML = "";
    return;
  }
  pill.classList.remove("hidden");
  pill.innerHTML = `
    <span>👑 ${escapeHtml(newDeckSelectedCmd.name)}</span>
    <button type="button" class="btn small" onclick="clearNewDeckCmd()" style="width:auto;margin:0;padding:3px 7px;">×</button>
  `;
}

window.clearNewDeckCmd = function () {
  newDeckSelectedCmd = null;
  renderNewDeckSelectedCmd();
};

window.pickNewDeckCmd = function (idx) {
  const sc = newDeckCmdResults[idx];
  if (!sc) return;
  newDeckSelectedCmd = sc;
  $("new-deck-cmd-results").innerHTML = "";
  $("new-deck-cmd-input").value = sc.name || "";
  if (!($("new-deck-name")?.value || "").trim()) {
    $("new-deck-name").value = sc.name || "";
  }
  renderNewDeckSelectedCmd();
};

async function searchNewDeckCommander() {
  const q = ($("new-deck-cmd-input")?.value || "").trim();
  const box = $("new-deck-cmd-results");
  if (q.length < 2) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="muted" style="font-size:12px;padding:4px;">Ricerca...</div>`;
  try {
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`${q} is:commander`)}&unique=cards`
    );
    let json = resp.ok ? await resp.json() : null;
    if (!json || !json.data?.length) {
      const fb = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards`);
      json = fb.ok ? await fb.json() : { data: [] };
    }
    newDeckCmdResults = (json.data || []).slice(0, 8);
    if (!newDeckCmdResults.length) {
      box.innerHTML = `<div class="muted" style="font-size:12px;padding:4px;">Nessuna carta trovata.</div>`;
      return;
    }
    box.innerHTML = newDeckCmdResults
      .map((c, i) => `
        <div class="cmd-mini-row" onclick="pickNewDeckCmd(${i})">
          <span>${escapeHtml(c.name || "")}</span>
          <span>${renderManaPipsHtml(c.mana_cost || c.card_faces?.[0]?.mana_cost || "")}</span>
        </div>
      `)
      .join("");
  } catch {
    box.innerHTML = `<div class="muted" style="font-size:12px;padding:4px;">Errore Scryfall.</div>`;
  }
}

$("btn-open-new-deck")?.addEventListener("click", () => {
  newDeckSelectedCmd = null;
  newDeckCmdResults = [];
  if ($("new-deck-name")) $("new-deck-name").value = "";
  if ($("new-deck-format")) $("new-deck-format").value = "Commander";
  if ($("new-deck-cmd-input")) $("new-deck-cmd-input").value = "";
  if ($("new-deck-cmd-results")) $("new-deck-cmd-results").innerHTML = "";
  setStatus($("new-deck-status"), "");
  renderNewDeckSelectedCmd();
  toggleNewDeckCmdVisibility();
  $("new-deck-modal")?.classList.remove("hidden");
});

$("new-deck-format")?.addEventListener("change", toggleNewDeckCmdVisibility);
$("btn-new-deck-cmd-search")?.addEventListener("click", searchNewDeckCommander);
$("btn-cancel-new-deck")?.addEventListener("click", () => {
  $("new-deck-modal")?.classList.add("hidden");
});

$("btn-create-new-deck")?.addEventListener("click", async () => {
  const name = ($("new-deck-name")?.value || "").trim();
  const fmt = $("new-deck-format")?.value || "Commander";
  if (!name) {
    setStatus($("new-deck-status"), "Inserisci un nome per il mazzo.", "err");
    return;
  }

  setStatus($("new-deck-status"), "Creazione mazzo...");
  const insertPayload = {
    owner_id: currentUser.id,
    name,
    type: fmt,
    format: fmt,
  };

  let createdDeck = null;
  let { data, error } = await sb.from("decks").insert(insertPayload).select("*").single();
  if (error) {
    // Fallback se la colonna format non esiste o ha vincoli
    const fb = await sb
      .from("decks")
      .insert({ owner_id: currentUser.id, name, type: fmt })
      .select("*")
      .single();
    data = fb.data;
    error = fb.error;
  }

  if (error || !data) {
    setStatus($("new-deck-status"), error?.message || "Errore nella creazione.", "err");
    return;
  }

  createdDeck = data;

  // Se è stato selezionato un comandante, salvalo subito in deck_cards e cards_json
  if (newDeckSelectedCmd && isCommanderFormat(fmt)) {
    const sc = newDeckSelectedCmd;
    const normalUrl = sc.image_uris?.normal || sc.card_faces?.[0]?.image_uris?.normal || "";
    const artUrl = sc.image_uris?.art_crop || sc.card_faces?.[0]?.image_uris?.art_crop || normalUrl;
    const manaCost = sc.mana_cost || sc.card_faces?.[0]?.mana_cost || "";
    const oracleText = sc.oracle_text || sc.card_faces?.[0]?.oracle_text || "";
    const priceEur = extractScryfallEurPrice(sc, false);

    const cmdRow = {
      deck_id: createdDeck.id,
      scryfall_id: sc.id || "",
      name: sc.name || "",
      type_line: sc.type_line || "",
      oracle_text: oracleText,
      mana_cost: manaCost,
      image_url: normalUrl,
      quantity: 1,
      is_commander: true,
    };
    await sb.from("deck_cards").insert(cmdRow);

    const cardsJson = [
      {
        scryfall_id: sc.id || "",
        name: sc.name || "",
        type_line: sc.type_line || "",
        oracle_text: oracleText,
        mana_cost: manaCost,
        image_url: artUrl,
        card_image_url: normalUrl,
        color_identity: sc.color_identity || [],
        set: (sc.set || "").toUpperCase(),
        set_code: (sc.set || "").toUpperCase(),
        set_name: sc.set_name || "",
        collector_number: sc.collector_number || "",
        price_eur: priceEur,
        quantity: 1,
        is_commander: true,
        is_proxy: false,
        tags: [],
      },
    ];
    try {
      await sb.from("decks").update({ cards_json: cardsJson, bg_image_url: artUrl }).eq("id", createdDeck.id);
    } catch {
      try {
        await sb.from("decks").update({ cards_json: cardsJson }).eq("id", createdDeck.id);
      } catch {
        // ignora
      }
    }
  }

  $("new-deck-modal")?.classList.add("hidden");
  await loadDecks();
  openDeckDetail(createdDeck.id);
});

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
    container.innerHTML = `<p class="muted">Nessun mazzo trovato sul tuo account. Tocca + in alto per crearne uno.</p>`;
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
let deckGroupMode = "type"; // "type" | "tag"
let deckViewMode = "list";  // "list" | "grid"

// Switch sotto-tab della scheda mazzo
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
  const fmt = deck.format || deck.type || "Mazzo";
  $("deck-detail-title").textContent = deck.name || "Senza nome";
  $("deck-detail-format").textContent = fmt;
  $("deck-detail-count").textContent = "";
  $("deck-detail-price")?.classList.add("hidden");
  $("deck-commander-bar")?.classList.toggle("hidden", !isCommanderFormat(fmt));
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
  currentDeckHistory = [];
  currentDeckCards = [];
  $("deck-search-dropdown")?.classList.add("hidden");
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
        <div class="muted" style="font-size:12px;">Partite totali: <strong>${total}</strong></div>
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
    bar.innerHTML = `<span class="muted">Nessun dato nel periodo</span>`;
    return;
  }
  bar.innerHTML = `
    <span><strong>${escapeHtml(formatFullDateIt(p.day))}</strong> · ${p.dayW}V/${p.dayM}P</span>
    <span class="trend-detail-wr">Tot: ${p.cumW}V/${p.cumM}P (${Math.round(p.wr)}%)</span>
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
    if (bar) bar.innerHTML = `<span class="muted">Registra almeno una sessione</span>`;
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
    container.innerHTML = `<p class="muted">Nessuna sessione registrata per questo mazzo.</p>`;
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

$("btn-save-deck-match")?.addEventListener("click", async () => {
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

// ---- ICONE SVG MAGIC, LISTA CARTE, PREZZI, TAG, PROXY & GRIGLIA ----
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

  if (Array.isArray(dbRows) && dbRows.length > 0) {
    return dbRows.map((r) => {
      const meta =
        (r.scryfall_id && jsonById.get(String(r.scryfall_id))) ||
        (r.name && jsonByName.get(String(r.name).toLowerCase())) ||
        {};
      return {
        ...meta,
        ...r,
        card_image_url: meta.card_image_url || toNormalCardUrl(r.image_url || ""),
        color_identity: Array.isArray(meta.color_identity) ? meta.color_identity : [],
        set_code: (meta.set_code || meta.set || "").toUpperCase(),
        set_name: meta.set_name || "",
        collector_number: meta.collector_number || "",
        price_eur: meta.price_eur ?? null,
        is_proxy: Boolean(meta.is_proxy ?? meta.proxy),
        tags: Array.isArray(meta.tags) ? meta.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      };
    });
  }

  if (Array.isArray(jsonRows) && jsonRows.length > 0) {
    return jsonRows.map((jc) => ({
      ...jc,
      card_image_url: jc.card_image_url || toNormalCardUrl(jc.image_url || ""),
      color_identity: Array.isArray(jc.color_identity) ? jc.color_identity : [],
      set_code: (jc.set_code || jc.set || "").toUpperCase(),
      set_name: jc.set_name || "",
      collector_number: jc.collector_number || "",
      price_eur: jc.price_eur ?? null,
      is_proxy: Boolean(jc.is_proxy ?? jc.proxy),
      tags: Array.isArray(jc.tags) ? jc.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    }));
  }

  return [];
}

async function loadDeckCards(deck) {
  setStatus($("deck-cards-status"), "Caricamento lista...");
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

  // Recupera in background i prezzi EUR mancanti da Scryfall
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
          if (!c.set_code && hit.sc.set) c.set_code = hit.sc.set.toUpperCase();
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
      // ignora
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
  $("deck-detail-count").textContent = totalCount > 0 ? `${totalCount} carte` : "";
  updateDeckTotalPriceBadge();
  updateDeckCommanderCiUi();
}

async function syncDeckCardsJson(deckId) {
  const deck = myDecks.find((d) => String(d.id) === String(deckId));
  const payload = currentDeckCards.map((c) => ({
    scryfall_id: c.scryfall_id || "",
    name: c.name || "",
    type_line: c.type_line || "",
    oracle_text: c.oracle_text || "",
    mana_cost: c.mana_cost || "",
    image_url: c.image_url || "",
    card_image_url: c.card_image_url || toNormalCardUrl(c.image_url || ""),
    color_identity: Array.isArray(c.color_identity) ? c.color_identity : [],
    set: (c.set_code || c.set || "").toUpperCase(),
    set_code: (c.set_code || c.set || "").toUpperCase(),
    set_name: c.set_name || "",
    collector_number: c.collector_number || "",
    price_eur: c.price_eur ?? null,
    quantity: Math.max(1, Number(c.quantity || 1)),
    is_commander: Boolean(c.is_commander),
    is_proxy: Boolean(c.is_proxy),
    tags: Array.isArray(c.tags) ? c.tags : [],
  }));

  if (deck) deck.cards_json = payload;
  try {
    await sb.from("decks").update({ cards_json: payload }).eq("id", deckId);
  } catch {
    // ignora se la colonna non esiste
  }
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

function buildGroupedDeckSections(cards) {
  const groups = new Map();

  if (deckGroupMode === "tag") {
    cards.forEach((c, idx) => {
      const item = { ...c, _idx: idx };
      if (c.is_commander) {
        if (!groups.has("Comandante")) groups.set("Comandante", []);
        groups.get("Comandante").push(item);
        return;
      }
      const tags = Array.isArray(c.tags) && c.tags.length > 0 ? c.tags : ["Senza tag"];
      tags.forEach((tg) => {
        if (!groups.has(tg)) groups.set(tg, []);
        groups.get(tg).push(item);
      });
    });

    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (a === "Comandante") return -1;
      if (b === "Comandante") return 1;
      if (a === "Senza tag") return 1;
      if (b === "Senza tag") return -1;
      return a.localeCompare(b, "it");
    });

    return keys.map((k) => ({ title: k, list: groups.get(k) }));
  }

  const order = [
    "Comandante", "Creature", "Planeswalker", "Istantanee",
    "Stregonerie", "Artefatti", "Incantesimi", "Battaglie", "Terre", "Altro",
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

function renderDeckCardsList(cards) {
  const container = $("deck-cards-list");
  if (!cards.length) {
    container.innerHTML = `<p class="muted">Nessuna carta nel mazzo. Usa la ricerca qui sopra per aggiungerle.</p>`;
    return;
  }

  const sections = buildGroupedDeckSections(cards);

  if (deckViewMode === "grid") {
    container.innerHTML = `<div class="deck-visual-columns">${sections
      .map((sec) => {
        const list = sec.list.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "it"));
        const catCount = list.reduce((s, c) => s + Math.max(1, Number(c.quantity || 1)), 0);
        const isCmdCol = sec.title === "Comandante";
        const stackItems = list
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
          .join("");

        return `
          <div class="deck-stack-col ${isCmdCol ? "is-commander-col" : ""}">
            <div class="deck-cat-title"><span>${escapeHtml(sec.title)}</span><span>${catCount}</span></div>
            <div class="deck-stack-cards">${stackItems}</div>
          </div>
        `;
      })
      .join("")}</div>`;
    return;
  }

  container.innerHTML = sections
    .map((sec) => {
      const list = sec.list.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "it"));
      const catCount = list.reduce((s, c) => s + Math.max(1, Number(c.quantity || 1)), 0);
      const rows = list
        .map((c) => {
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
          const qtyControlsHtml = c.is_commander
            ? ""
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
              ${qtyControlsHtml}
            </div>
          `;
        })
        .join("");

      return `
        <div class="deck-cat-block">
          <div class="deck-cat-title"><span>${escapeHtml(sec.title)}</span><span data-cat-count="${escapeHtml(sec.title)}">${catCount}</span></div>
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
    if (!confirm(`Rimuovere "${card.name}" dal mazzo?`)) return;
    if (card.id) {
      const { error } = await sb.from("deck_cards").delete().eq("id", card.id);
      if (error) {
        setStatus($("deck-cards-status"), error.message, "err");
        return;
      }
    }
    currentDeckCards.splice(cardIdx, 1);
    if (activeDetailCardIdx === cardIdx) {
      $("card-preview-modal")?.classList.add("hidden");
      activeDetailCardIdx = -1;
    }
    updateDeckCardCountAndCi();
    renderDeckCardsList(currentDeckCards);
    await syncDeckCardsJson(selectedDeckId);
    return;
  }

  // Aggiornamento immediato sul posto (zero flash della pagina)
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
      updateDeckCardCountAndCi();
      setStatus($("deck-cards-status"), error.message, "err");
      return;
    }
  }
  await syncDeckCardsJson(selectedDeckId);
};

// ---- CAMBIA COMANDANTE ----
$("btn-open-change-commander")?.addEventListener("click", () => {
  changeCmdResults = [];
  if ($("change-cmd-input")) $("change-cmd-input").value = "";
  if ($("change-cmd-results")) $("change-cmd-results").innerHTML = "";
  setStatus($("change-cmd-status"), "");
  $("commander-modal")?.classList.remove("hidden");
});

$("btn-close-cmd-modal")?.addEventListener("click", () => {
  $("commander-modal")?.classList.add("hidden");
});

async function searchChangeCommander() {
  const q = ($("change-cmd-input")?.value || "").trim();
  const box = $("change-cmd-results");
  if (q.length < 2) {
    box.innerHTML = "";
    setStatus($("change-cmd-status"), "");
    return;
  }
  setStatus($("change-cmd-status"), "Ricerca su Scryfall...");
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
      setStatus($("change-cmd-status"), "Nessun comandante trovato.");
      return;
    }
    setStatus($("change-cmd-status"), "");
    box.innerHTML = changeCmdResults
      .map((c, i) => {
        const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || "";
        const price = extractScryfallEurPrice(c, false);
        return `
          <div class="deck-search-tile">
            ${img ? `<img class="deck-search-tile-img" src="${escapeHtml(img)}" alt="${escapeHtml(c.name || "")}" loading="lazy" />` : `<div class="deck-search-tile-img"></div>`}
            <div class="deck-search-tile-name">${escapeHtml(c.name || "")}</div>
            <div class="deck-search-tile-price">${formatEur(price)}</div>
            <button type="button" class="deck-add-btn" onclick="applyNewCommander(${i})">Imposta</button>
          </div>
        `;
      })
      .join("");
  } catch {
    setStatus($("change-cmd-status"), "Errore di connessione a Scryfall.", "err");
  }
}

$("btn-change-cmd-search")?.addEventListener("click", searchChangeCommander);

window.applyNewCommander = async function (idx) {
  const sc = changeCmdResults[idx];
  if (!sc || !selectedDeckId) return;

  setStatus($("change-cmd-status"), "Aggiornamento comandante...");

  // Rimuove il flag comandante dalle carte precedenti
  for (const c of currentDeckCards) {
    if (c.is_commander) {
      c.is_commander = false;
      if (c.id) {
        await sb.from("deck_cards").update({ is_commander: false }).eq("id", c.id);
      }
    }
  }

  const existing = currentDeckCards.find(
    (c) => String(c.name || "").toLowerCase() === String(sc.name || "").toLowerCase()
  );

  const normalUrl = sc.image_uris?.normal || sc.card_faces?.[0]?.image_uris?.normal || "";
  const artUrl = sc.image_uris?.art_crop || sc.card_faces?.[0]?.image_uris?.art_crop || normalUrl;
  const manaCost = sc.mana_cost || sc.card_faces?.[0]?.mana_cost || "";
  const oracleText = sc.oracle_text || sc.card_faces?.[0]?.oracle_text || "";
  const priceEur = extractScryfallEurPrice(sc, false);

  if (existing) {
    existing.is_commander = true;
    existing.quantity = 1;
    existing.color_identity = sc.color_identity || existing.color_identity || [];
    if (existing.id) {
      await sb.from("deck_cards").update({ is_commander: true, quantity: 1 }).eq("id", existing.id);
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
      color_identity: sc.color_identity || [],
      set_code: (sc.set || "").toUpperCase(),
      set_name: sc.set_name || "",
      collector_number: sc.collector_number || "",
      price_eur: priceEur,
      is_proxy: false,
      tags: [],
    });
  }

  if (artUrl) applyDeckHeroBg(artUrl);
  updateDeckCardCountAndCi();
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
  $("commander-modal")?.classList.add("hidden");
};

// ---- RICERCA A GRIGLIA & AGGIUNTA CARTE DA SCRYFALL ----
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

  setStatus($("deck-search-status"), "Ricerca su Scryfall...");
  try {
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards`
    );
    if (!resp.ok) {
      deckSearchResults = [];
      resBox.innerHTML = "";
      setStatus($("deck-search-status"), "Nessuna carta trovata.");
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
            <button type="button" class="deck-add-btn" onclick="addCardToCurrentDeck(${i})">Aggiungi</button>
          </div>
        `;
      })
      .join("");
  } catch {
    setStatus($("deck-search-status"), "Errore di connessione a Scryfall.", "err");
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
    setStatus($("deck-search-status"), `Aumentata quantità di ${sc.name}.`, "ok");
    return;
  }

  const imageUrl =
    sc.image_uris?.normal ||
    sc.card_faces?.[0]?.image_uris?.normal ||
    sc.image_uris?.art_crop ||
    "";
  const manaCost = sc.mana_cost || sc.card_faces?.[0]?.mana_cost || "";
  const oracleText = sc.oracle_text || sc.card_faces?.[0]?.oracle_text || "";
  const priceEur = extractScryfallEurPrice(sc, false);

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

  setStatus($("deck-search-status"), `Aggiunta di ${sc.name}...`);
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
    color_identity: sc.color_identity || [],
    set_code: (sc.set || "").toUpperCase(),
    set_name: sc.set_name || "",
    collector_number: sc.collector_number || "",
    price_eur: priceEur,
    is_proxy: false,
    tags: [],
  });
  updateDeckCardCountAndCi();
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
  setStatus($("deck-search-status"), `${sc.name} aggiunta al mazzo!`, "ok");
};

// ---- DETTAGLIO CARTA: INFO, CAMBIO ESPANSIONE, PROXY & TAG ----
function renderCardTagsModalUi(card) {
  const chipsEl = $("card-tags-chips");
  const suggEl = $("card-tag-suggestions");
  const curTags = Array.isArray(card.tags) ? card.tags : [];

  if (!curTags.length) {
    chipsEl.innerHTML = `<span class="muted" style="font-size:11px;">Nessun tag assegnato</span>`;
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

  // Suggerimenti: tag già usati nel mazzo + preset
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
  const tag = String(rawTag || "").trim();
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

  setStatus($("card-detail-status"), "Aggiornamento edizione...");
  if (card.id) {
    await sb
      .from("deck_cards")
      .update({ scryfall_id: card.scryfall_id, image_url: card.image_url })
      .eq("id", card.id);
  }
  updateDeckTotalPriceBadge();
  renderDeckCardsList(currentDeckCards);
  await syncDeckCardsJson(selectedDeckId);
  setStatus($("card-detail-status"), `Edizione aggiornata: [${card.set_code}]`, "ok");
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
  $("card-preview-oracle").textContent = card.oracle_text || "Caricamento testo carta...";
  $("card-tag-input").value = "";
  setStatus($("card-detail-status"), "");
  renderCardTagsModalUi(card);

  const imgEl = $("card-preview-img");
  const initialImg = card.card_image_url || toNormalCardUrl(card.image_url || "");
  imgEl.src = initialImg || "";

  const edSel = $("card-edition-select");
  edSel.innerHTML = `<option value="">Caricamento edizioni...</option>`;

  $("card-preview-modal").classList.remove("hidden");

  // Carica tutte le stampe della carta da Scryfall
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
            $("card-preview-oracle").textContent = ot || "Nessun testo.";
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
        edSel.innerHTML = `<option value="">Nessuna edizione alternativa</option>`;
      }
    } catch {
      edSel.innerHTML = `<option value="">Errore caricamento edizioni</option>`;
    }
  }
};

$("btn-close-card-preview")?.addEventListener("click", () => {
  activeDetailCardIdx = -1;
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

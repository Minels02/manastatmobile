// Sostituisci con i tuoi valori reali di Supabase (gli stessi dell'app desktop)
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
const printsCache = new Map();
const dHashCache = new Map();
const setIndexCache = new Map(); // setCode -> Array<{ card, dhash }>

// Stato scanner pro (mirino MTG + stabilità/nitidezza + worker OCR + dHash)
let cameraStream = null;
let monitorLoopId = null;
let ocrWorker = null;
let ocrWorkerReady = false;
let isProcessingCapture = false;
let pendingProposalCard = null;
let proposalPrintOptions = [];
let prevLumaGrid = null;
let stableFramesCount = 0;
let cooldownUntil = 0;
const rejectedCardKeys = new Set();

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
  el.className = `status ${type}`.trim();
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("deck-date").value = new Date().toISOString().slice(0, 10);

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

function setReticleState(state) {
  const el = $("card-reticle");
  if (!el) return;
  el.classList.remove("locked", "scanning");
  if (state === "locked") el.classList.add("locked");
  if (state === "scanning") el.classList.add("scanning");
}

// Navigazione tab in basso
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const targetTab = btn.dataset.tab;
    $(targetTab).classList.add("active");

    if (targetTab === "tab-collection") {
      await ensureCameraRunning();
    } else {
      stopCameraStream();
    }
  });
});

// Login
$("btn-login").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  setStatus($("login-status"), "Accesso in corso...");

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    setStatus($("login-status"), error.message, "err");
    return;
  }
  currentUser = data.user;
  onAuthenticated();
});

$("btn-logout").addEventListener("click", async () => {
  stopCameraStream();
  await sb.auth.signOut();
  currentUser = null;
  selectedDeckId = null;
  selectedGroupId = null;
  $("main-view").classList.add("hidden");
  $("login-view").classList.remove("hidden");
});

async function onAuthenticated() {
  $("login-view").classList.add("hidden");
  $("main-view").classList.remove("hidden");
  $("user-badge").textContent = currentUser.email || "";
  await Promise.all([loadDecks(), loadGroups()]);
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

window.openDeckDetail = function (deckId) {
  const deck = myDecks.find((d) => String(d.id) === String(deckId));
  if (!deck) return;

  selectedDeckId = deck.id;
  $("deck-detail-title").textContent = deck.name || "Senza nome";
  $("deck-detail-format").textContent = deck.format || deck.type || "Mazzo";
  applyDeckHeroBg(extractDeckImageUrl(deck) || deck._resolvedArtUrl || "");
  setStatus($("deck-status"), "");

  $("decks-list-view").classList.add("hidden");
  $("deck-detail-view").classList.remove("hidden");
};

$("btn-back-to-decks").addEventListener("click", () => {
  selectedDeckId = null;
  $("deck-detail-view").classList.add("hidden");
  $("decks-list-view").classList.remove("hidden");
});

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
  setStatus($("deck-status"), "Partita salvata! La ritroverai nell'app desktop.", "ok");
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

$("btn-back-to-groups").addEventListener("click", () => {
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

$("btn-save-group-match").addEventListener("click", async () => {
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

// ---- SALVATAGGIO CARTA IN COLLEZIONE ----
async function saveCardPayloadToCollection(cardPayload, isFoil) {
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
      return sb.from("user_collection").insert({
        user_id: currentUser.id,
        ...cardPayload,
        foil: isFoil,
        quantity: 1,
      });
    });

  if (checkErr) {
    throw new Error(checkErr.message);
  }
}

function buildCollectionPayloadFromScryfall(c) {
  const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal || "";
  return {
    scryfall_id: c.id,
    name: c.name,
    set_code: (c.set || "").toUpperCase(),
    set_name: c.set_name || "",
    collector_number: c.collector_number || "",
    released_at: c.released_at || "",
    rarity: c.rarity || "",
    type_line: c.type_line || "",
    mana_cost: c.mana_cost || "",
    cmc: c.cmc || 0,
    colors: c.colors || [],
    image_url: img,
    card_image_url: img,
    price_eur: c.prices?.eur ? parseFloat(c.prices.eur) : null,
    price_eur_foil: c.prices?.eur_foil ? parseFloat(c.prices.eur_foil) : null,
  };
}

// ---- PERCEPTUAL DHASH (64-BIT) IN SCALA DI GRIGI NORMALIZZATA ----
function computeDHash64(source, sx, sy, sw, sh) {
  const c = document.createElement("canvas");
  c.width = 9;
  c.height = 8;
  const ctx = c.getContext("2d");
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 9, 8);
  const data = ctx.getImageData(0, 0, 9, 8).data;

  const gray = new Float32Array(72);
  let minV = 255;
  let maxV = 0;
  for (let i = 0; i < 72; i++) {
    const p = i * 4;
    const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    gray[i] = lum;
    if (lum < minV) minV = lum;
    if (lum > maxV) maxV = lum;
  }

  const range = Math.max(1, maxV - minV);
  const bits = new Uint8Array(64);
  let idx = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = (gray[y * 9 + x] - minV) / range;
      const right = (gray[y * 9 + x + 1] - minV) / range;
      bits[idx++] = left > right ? 1 : 0;
    }
  }
  return bits;
}

function hammingDistance64(a, b) {
  if (!a || !b || a.length !== 64 || b.length !== 64) return 64;
  let dist = 0;
  for (let i = 0; i < 64; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

async function getDHashForScryfallArt(scryfallCard) {
  const artUrl =
    scryfallCard?.image_uris?.art_crop ||
    scryfallCard?.card_faces?.[0]?.image_uris?.art_crop ||
    "";
  if (!artUrl) return null;

  if (dHashCache.has(artUrl)) {
    return dHashCache.get(artUrl);
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const hash = computeDHash64(img, 0, 0, img.width, img.height);
        dHashCache.set(artUrl, hash);
        resolve(hash);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = artUrl;
  });
}

// Calcola coordinate esatte del mirino MTG nel video reale (tenendo conto di object-fit: cover)
function getReticleVideoRect() {
  const video = $("scan-video");
  const reticle = $("card-reticle");
  if (!video || !reticle || !video.videoWidth || !video.videoHeight) return null;

  const vRect = video.getBoundingClientRect();
  const rRect = reticle.getBoundingClientRect();
  if (!vRect.width || !vRect.height) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(vRect.width / vw, vRect.height / vh);
  const renderedW = vw * scale;
  const renderedH = vh * scale;
  const offsetX = (renderedW - vRect.width) / 2;
  const offsetY = (renderedH - vRect.height) / 2;

  const rx = Math.max(0, ((rRect.left - vRect.left) + offsetX) / scale);
  const ry = Math.max(0, ((rRect.top - vRect.top) + offsetY) / scale);
  const rw = Math.min(vw - rx, rRect.width / scale);
  const rh = Math.min(vh - ry, rRect.height / scale);

  if (rw < 40 || rh < 40) return null;
  return { video, rx, ry, rw, rh };
}

// Controllo stabilità + nitidezza (< 2 ms) dentro il mirino MTG
function evaluateReticleStabilityAndSharpness() {
  const geom = getReticleVideoRect();
  if (!geom) return { ready: false };

  const { video, rx, ry, rw, rh } = geom;
  const gw = 32;
  const gh = 44;
  const c = document.createElement("canvas");
  c.width = gw;
  c.height = gh;
  const ctx = c.getContext("2d");
  ctx.drawImage(video, rx, ry, rw, rh, 0, 0, gw, gh);
  const data = ctx.getImageData(0, 0, gw, gh).data;

  const luma = new Float32Array(gw * gh);
  for (let i = 0; i < luma.length; i++) {
    const p = i * 4;
    luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // Varianza del Laplaciano per stimare la nitidezza
  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;
  for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const idx = y * gw + x;
      const lap =
        4 * luma[idx] -
        luma[idx - 1] -
        luma[idx + 1] -
        luma[idx - gw] -
        luma[idx + gw];
      lapSum += lap;
      lapSqSum += lap * lap;
      count++;
    }
  }
  const mean = lapSum / Math.max(1, count);
  const sharpness = lapSqSum / Math.max(1, count) - mean * mean;

  // Differenza rispetto al frame precedente per verificare che sia ferma
  let motion = 999;
  if (prevLumaGrid && prevLumaGrid.length === luma.length) {
    let diffSum = 0;
    for (let i = 0; i < luma.length; i++) {
      diffSum += Math.abs(luma[i] - prevLumaGrid[i]);
    }
    motion = diffSum / luma.length;
  }
  prevLumaGrid = luma;

  const isSharp = sharpness > 140;
  const isStill = motion < 4.5;
  return { ready: isSharp && isStill, isSharp, isStill, geom };
}

// ---- WORKER OCR PERSISTENTE (NON BLOCCA LA UI) ----
async function ensureOcrWorker() {
  if (ocrWorkerReady && ocrWorker) return ocrWorker;
  if (typeof Tesseract === "undefined") return null;

  try {
    ocrWorker = await Tesseract.createWorker("eng");
    await ocrWorker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM?.SINGLE_LINE || "7",
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'- ,./",
    });
    ocrWorkerReady = true;
    return ocrWorker;
  } catch {
    ocrWorker = null;
    ocrWorkerReady = false;
    return null;
  }
}

function captureTitleAndArtFromReticle(geom) {
  const { video, rx, ry, rw, rh } = geom;

  // 1) Fascia titolo esatta dentro il mirino (top 4.5%..14%, left 6%..82%)
  const tx = rx + rw * 0.06;
  const ty = ry + rh * 0.045;
  const tw = rw * 0.76;
  const th = rh * 0.095;

  const canvas = $("scan-crop-canvas");
  const targetW = 460;
  const scale = targetW / Math.max(1, tw);
  canvas.width = Math.max(1, Math.floor(tw * scale));
  canvas.height = Math.max(1, Math.floor(th * scale));

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(video, tx, ty, tw, th, 0, 0, canvas.width, canvas.height);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const boosted = Math.max(0, Math.min(255, (lum - 125) * 1.65 + 128));
    d[i] = d[i + 1] = d[i + 2] = boosted;
  }
  ctx.putImageData(imgData, 0, 0);

  // 2) Riquadro artwork esatto dentro il mirino (top 14.5%..56%, left 7%..93%)
  const ax = rx + rw * 0.07;
  const ay = ry + rh * 0.145;
  const aw = rw * 0.86;
  const ah = rh * 0.415;
  const artDHash = computeDHash64(video, ax, ay, aw, ah);

  return { titleCanvas: canvas, artDHash };
}

function cleanOcrTitle(rawText) {
  return String(rawText || "")
    .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ,'\- /]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 55);
}

// ---- INDICE LOCALE SET QUANDO "BLOCCA SET" È ATTIVO ----
async function ensureSetIndex(setCode) {
  const code = String(setCode || "").trim().toLowerCase();
  if (!code) return null;
  if (setIndexCache.has(code)) {
    return setIndexCache.get(code);
  }

  setScanStateBadge(`Indicizzazione set ${code.toUpperCase()}...`);
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`e:${code}`)}&unique=prints`;
  const allCards = [];

  while (url && allCards.length < 450) {
    const resp = await fetch(url);
    if (!resp.ok) break;
    const json = await resp.json();
    if (Array.isArray(json.data)) {
      allCards.push(...json.data);
    }
    url = json.has_more ? json.next_page : null;
  }

  if (!allCards.length) {
    return null;
  }

  const entries = [];
  for (let i = 0; i < allCards.length; i += 12) {
    const batch = allCards.slice(i, i + 12);
    const batchRes = await Promise.all(
      batch.map(async (card) => {
        const dhash = await getDHashForScryfallArt(card);
        return dhash ? { card, dhash } : null;
      })
    );
    for (const item of batchRes) {
      if (item) entries.push(item);
    }
  }

  setIndexCache.set(code, entries);
  return entries;
}

async function findCardViaLockedSet(setCode, artDHash) {
  const entries = await ensureSetIndex(setCode);
  if (!entries || !entries.length) return null;

  let best = null;
  let bestDist = 64;
  for (const entry of entries) {
    const rejectKey = String(entry.card.id || entry.card.name).toLowerCase();
    if (rejectedCardKeys.has(rejectKey)) continue;

    const dist = hammingDistance64(artDHash, entry.dhash);
    if (dist < bestDist) {
      bestDist = dist;
      best = entry.card;
    }
  }

  // Soglia dHash su 64 bit: <= 17 indica forte somiglianza visiva dell'illustrazione
  if (best && bestDist <= 17) {
    return { card: best, dist: bestDist };
  }
  return null;
}

// ---- RICERCA SCRYFALL + ORDINAMENTO STAMPE TRAMITE DHASH ----
async function lookupCardAndPrintsByTitle(title, artDHash) {
  if (!title || title.length < 3) return null;

  let baseCard = null;
  try {
    const resp = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(title)}`);
    if (resp.ok) {
      baseCard = await resp.json();
    }
  } catch {
    // fallback autocomplete
  }

  if (!baseCard) {
    try {
      const acResp = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(title)}`);
      if (acResp.ok) {
        const acJson = await acResp.json();
        const firstMatch = acJson?.data?.[0];
        if (firstMatch) {
          const exactResp = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(firstMatch)}`);
          if (exactResp.ok) {
            baseCard = await exactResp.json();
          }
        }
      }
    } catch {
      // nessuna corrispondenza
    }
  }

  if (!baseCard || !baseCard.name) return null;

  const cacheKey = baseCard.name.toLowerCase();
  let prints = printsCache.get(cacheKey);
  if (!prints) {
    try {
      const printsUrl =
        baseCard.prints_search_uri ||
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(`!"${baseCard.name}"`)}&unique=prints&order=released`;
      const pResp = await fetch(printsUrl);
      if (pResp.ok) {
        const pJson = await pResp.json();
        prints = Array.isArray(pJson.data) && pJson.data.length ? pJson.data : [baseCard];
        printsCache.set(cacheKey, prints);
      } else {
        prints = [baseCard];
      }
    } catch {
      prints = [baseCard];
    }
  }

  const scored = await Promise.all(
    prints.map(async (p) => {
      const h = await getDHashForScryfallArt(p);
      const dist = h ? hammingDistance64(artDHash, h) : 64;
      return { print: p, dist };
    })
  );
  scored.sort((a, b) => a.dist - b.dist);

  return {
    orderedPrints: scored.map((s) => s.print),
    bestDist: scored[0]?.dist ?? 64,
  };
}

// ---- PROPOSTA SÌ / NO ----
function applyEditionToProposal(scryfallCard) {
  if (!pendingProposalCard) return;
  const payload = buildCollectionPayloadFromScryfall(scryfallCard);
  pendingProposalCard.payload = payload;

  $("proposal-name").textContent = payload.name;
  $("proposal-meta").textContent =
    `${payload.set_code || ""}${payload.collector_number ? ` #${payload.collector_number}` : ""} · ${payload.set_name || ""}`;

  const imgEl = $("proposal-img");
  if (payload.image_url) {
    imgEl.src = payload.image_url;
    imgEl.classList.remove("hidden");
  } else {
    imgEl.classList.add("hidden");
  }
}

function showCardProposal(orderedPrints, sourceLabel = "Carta rilevata") {
  const bestCard = orderedPrints[0];
  if (!bestCard) return;

  const payload = buildCollectionPayloadFromScryfall(bestCard);
  const rejectKey = String(payload.scryfall_id || payload.name).toLowerCase();

  if (rejectedCardKeys.has(rejectKey) || rejectedCardKeys.has(payload.name.toLowerCase())) {
    setScanStateBadge("Carta già scartata");
    return;
  }

  pendingProposalCard = { payload, rejectKey, nameKey: payload.name.toLowerCase() };
  proposalPrintOptions = orderedPrints;
  setReticleState("locked");
  setScanStateBadge("Carta trovata");

  $("proposal-match-source").textContent = sourceLabel;
  applyEditionToProposal(bestCard);

  const selectEl = $("proposal-edition-select");
  selectEl.innerHTML = orderedPrints
    .map((p, idx) => {
      const code = (p.set || "").toUpperCase();
      const cn = p.collector_number ? `#${p.collector_number}` : "";
      const sname = p.set_name || code;
      const tag = idx === 0 ? " ★" : "";
      return `<option value="${idx}">${escapeHtml(`${sname} [${code}] ${cn}${tag}`.trim())}</option>`;
    })
    .join("");
  selectEl.value = "0";

  $("proposal-modal")?.classList.remove("hidden");
}

$("proposal-edition-select")?.addEventListener("change", (e) => {
  const idx = parseInt(e.target.value, 10);
  if (!Number.isNaN(idx) && proposalPrintOptions[idx]) {
    applyEditionToProposal(proposalPrintOptions[idx]);
  }
});

function hideCardProposalAndResume() {
  pendingProposalCard = null;
  proposalPrintOptions = [];
  stableFramesCount = 0;
  prevLumaGrid = null;
  cooldownUntil = Date.now() + 700;
  $("proposal-modal")?.classList.add("hidden");
  setReticleState("idle");
  setScanStateBadge("Allinea la carta nel riquadro");
}

$("btn-proposal-no")?.addEventListener("click", () => {
  if (pendingProposalCard) {
    rejectedCardKeys.add(pendingProposalCard.rejectKey);
    rejectedCardKeys.add(pendingProposalCard.nameKey);
    updateRejectedBadge();
  }
  setStatus($("collection-status"), "Carta scartata: non verrà riproposta.", "");
  hideCardProposalAndResume();
});

$("btn-proposal-yes")?.addEventListener("click", async () => {
  if (!pendingProposalCard) return;
  const { payload } = pendingProposalCard;
  const isFoil = $("scan-finish-select")?.value === "foil";

  try {
    setStatus($("collection-status"), `Salvataggio ${payload.name} [${payload.set_code}]...`);
    await saveCardPayloadToCollection(payload, isFoil);

    rejectedCardKeys.clear();
    updateRejectedBadge();
    setStatus($("collection-status"), `${payload.name} [${payload.set_code}] aggiunta! Scartate azzerate.`, "ok");
  } catch (err) {
    setStatus($("collection-status"), `Errore salvataggio: ${err.message}`, "err");
  } finally {
    hideCardProposalAndResume();
  }
});

// ---- PIPELINE DI SCANSIONE (STABILITÀ -> DHASH SET / WORKER OCR) ----
async function executeScanPipeline(geom, manualTrigger = false) {
  if (isProcessingCapture || pendingProposalCard) return;
  isProcessingCapture = true;
  setReticleState("scanning");
  setScanStateBadge("Analisi carta...");

  try {
    const { titleCanvas, artDHash } = captureTitleAndArtFromReticle(geom);
    const lockedSet = ($("lock-set-input")?.value || "").trim().toLowerCase();

    // 1) Se "Blocca Set" è impostato, riconoscimento visivo istantaneo (zero OCR)
    if (lockedSet.length >= 3) {
      const setMatch = await findCardViaLockedSet(lockedSet, artDHash);
      if (setMatch && !pendingProposalCard) {
        showCardProposal(
          [setMatch.card],
          `Match visivo set ${lockedSet.toUpperCase()} (distanza ${setMatch.dist}/64)`
        );
        return;
      }
    }

    // 2) Altrimenti OCR veloce sul solo titolo + ordinamento edizioni tramite dHash
    const worker = await ensureOcrWorker();
    if (!worker) {
      setStatus($("collection-status"), "Motore OCR non disponibile.", "err");
      return;
    }

    const { data } = await worker.recognize(titleCanvas);
    const title = cleanOcrTitle(data?.text || "");
    if (!title || title.length < 3) {
      if (manualTrigger) {
        setStatus($("collection-status"), "Titolo non leggibile: avvicina o illumina meglio la carta.", "err");
      }
      return;
    }

    if (rejectedCardKeys.has(title.toLowerCase())) {
      return;
    }

    const res = await lookupCardAndPrintsByTitle(title, artDHash);
    if (res && res.orderedPrints.length && !pendingProposalCard) {
      showCardProposal(
        res.orderedPrints,
        `Riconosciuta "${title}" (match art ${64 - res.bestDist}/64)`
      );
    } else if (manualTrigger) {
      setStatus($("collection-status"), `Nessuna carta trovata per "${title}".`, "err");
    }
  } catch (err) {
    if (manualTrigger) {
      setStatus($("collection-status"), `Errore scansione: ${err.message}`, "err");
    }
  } finally {
    isProcessingCapture = false;
    stableFramesCount = 0;
    cooldownUntil = Date.now() + 900;
    if (!pendingProposalCard) {
      setReticleState("idle");
      setScanStateBadge("Allinea la carta nel riquadro");
    }
  }
}

function startMonitorLoop() {
  stopMonitorLoop();
  monitorLoopId = setInterval(() => {
    if (pendingProposalCard || isProcessingCapture) return;
    if (Date.now() < cooldownUntil) return;

    const check = evaluateReticleStabilityAndSharpness();
    if (!check.ready) {
      stableFramesCount = 0;
      return;
    }

    stableFramesCount += 1;
    if (stableFramesCount >= 2) {
      executeScanPipeline(check.geom, false);
    }
  }, 220);
}

function stopMonitorLoop() {
  if (monitorLoopId) {
    clearInterval(monitorLoopId);
    monitorLoopId = null;
  }
}

function stopCameraStream() {
  stopMonitorLoop();
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  prevLumaGrid = null;
  stableFramesCount = 0;
}

async function ensureCameraRunning() {
  updateRejectedBadge();
  ensureOcrWorker(); // pre-inizializza in background

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus($("collection-status"), "Fotocamera non disponibile su questo browser.", "err");
    return;
  }

  if (cameraStream) {
    startMonitorLoop();
    return;
  }

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
    $("camera-placeholder")?.classList.add("hidden");
    setScanStateBadge("Allinea la carta nel riquadro");
    setStatus($("collection-status"), "Inquadra la carta nel mirino: scatta appena è ferma.", "");
    startMonitorLoop();
  } catch (err) {
    setScanStateBadge("Fotocamera bloccata");
    $("camera-placeholder")?.classList.remove("hidden");
    setStatus($("collection-status"), `Errore fotocamera: ${err.message}`, "err");
  }
}

$("btn-start-camera")?.addEventListener("click", ensureCameraRunning);

$("btn-manual-snap")?.addEventListener("click", () => {
  const geom = getReticleVideoRect();
  if (!geom) {
    setStatus($("collection-status"), "Attiva prima la fotocamera.", "err");
    return;
  }
  executeScanPipeline(geom, true);
});

$("btn-reset-rejected")?.addEventListener("click", () => {
  rejectedCardKeys.clear();
  updateRejectedBadge();
  setStatus($("collection-status"), "Lista carte scartate azzerata.", "ok");
});

// Ripristina eventuale sessione già attiva
(async () => {
  const { data } = await sb.auth.getSession();
  if (data?.session?.user) {
    currentUser = data.session.user;
    onAuthenticated();
  }
})();
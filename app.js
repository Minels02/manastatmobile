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

// Stato dello scanner continuo + proposta Sì/No + lista scartate
let cameraStream = null;
let scanLoopTimer = null;
let isScanningFrame = false;
let pendingProposalCard = null;
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

// ---- SCANNER TELECAMERA + PROPOSTA SÌ / NO ----
function stopScanLoop() {
  if (scanLoopTimer) {
    clearInterval(scanLoopTimer);
    scanLoopTimer = null;
  }
}

function stopCameraStream() {
  stopScanLoop();
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
}

function startScanLoop() {
  stopScanLoop();
  scanLoopTimer = setInterval(() => {
    if (pendingProposalCard) return;
    if (isScanningFrame) return;
    const video = $("scan-video");
    if (!video || video.readyState < 2) return;
    scanCurrentVideoFrame();
  }, 1700);
}

async function ensureCameraRunning() {
  updateRejectedBadge();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus($("collection-status"), "Fotocamera non disponibile su questo browser.", "err");
    return;
  }

  if (cameraStream) {
    startScanLoop();
    return;
  }

  try {
    setScanStateBadge("Avvio fotocamera...");
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });

    const video = $("scan-video");
    video.srcObject = cameraStream;
    $("camera-placeholder")?.classList.add("hidden");
    setScanStateBadge("Inquadra una carta...");
    setStatus($("collection-status"), "Scansione automatica attiva.", "");
    startScanLoop();
  } catch (err) {
    setScanStateBadge("Fotocamera bloccata");
    $("camera-placeholder")?.classList.remove("hidden");
    setStatus($("collection-status"), `Errore fotocamera: ${err.message}`, "err");
  }
}

$("btn-start-camera")?.addEventListener("click", ensureCameraRunning);

$("btn-reset-rejected")?.addEventListener("click", () => {
  rejectedCardKeys.clear();
  updateRejectedBadge();
  setStatus($("collection-status"), "Lista carte scartate azzerata.", "ok");
});

function captureFrameCanvas() {
  const video = $("scan-video");
  if (!video || !video.videoWidth || !video.videoHeight) return null;

  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  // Ritaglia l'area centrale/superiore dove compare il nome della carta
  const sx = Math.floor(srcW * 0.06);
  const sy = Math.floor(srcH * 0.05);
  const sw = Math.floor(srcW * 0.88);
  const sh = Math.floor(srcH * 0.28);

  const canvas = $("scan-crop-canvas");
  const scale = Math.max(2, 1000 / Math.max(1, sw));
  canvas.width = Math.floor(sw * scale);
  canvas.height = Math.floor(sh * scale);

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const boosted = Math.max(0, Math.min(255, (lum - 128) * 1.5 + 128));
    d[i] = d[i + 1] = d[i + 2] = boosted;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

function extractCandidateTitle(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ,'\- /]/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 3);

  if (!lines.length) return "";
  return (lines.find((l) => l.split(" ").length <= 6) || lines[0]).slice(0, 60).trim();
}

async function lookupScryfallCard(title) {
  if (!title || title.length < 3) return null;
  try {
    const resp = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(title)}`);
    if (!resp.ok) return null;
    const card = await resp.json();
    if (!card || !card.name) return null;
    return card;
  } catch {
    return null;
  }
}

function showCardProposal(scryfallCard) {
  const payload = buildCollectionPayloadFromScryfall(scryfallCard);
  const rejectKey = String(payload.scryfall_id || payload.name).toLowerCase();

  if (rejectedCardKeys.has(rejectKey)) {
    setScanStateBadge("Carta già scartata, continuo...");
    return;
  }

  pendingProposalCard = { payload, rejectKey };
  stopScanLoop();
  setScanStateBadge("Carta trovata");

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

  $("proposal-modal")?.classList.remove("hidden");
}

function hideCardProposalAndResume() {
  pendingProposalCard = null;
  $("proposal-modal")?.classList.add("hidden");
  setScanStateBadge("Inquadra una carta...");
  if (cameraStream) {
    startScanLoop();
  }
}

$("btn-proposal-no")?.addEventListener("click", () => {
  if (pendingProposalCard) {
    rejectedCardKeys.add(pendingProposalCard.rejectKey);
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
    setStatus($("collection-status"), `Aggiunta ${payload.name} alla collezione...`);
    await saveCardPayloadToCollection(payload, isFoil);

    // Confermando "Sì" si azzera la lista delle carte scartate
    rejectedCardKeys.clear();
    updateRejectedBadge();
    setStatus($("collection-status"), `${payload.name} aggiunta alla collezione! Scartate azzerate.`, "ok");
  } catch (err) {
    setStatus($("collection-status"), `Errore salvataggio: ${err.message}`, "err");
  } finally {
    hideCardProposalAndResume();
  }
});

async function scanCurrentVideoFrame() {
  if (typeof Tesseract === "undefined" || isScanningFrame || pendingProposalCard) return;
  const canvas = captureFrameCanvas();
  if (!canvas) return;

  isScanningFrame = true;
  try {
    const { data } = await Tesseract.recognize(canvas, "eng");
    const title = extractCandidateTitle(data?.text || "");
    if (!title || pendingProposalCard) return;

    const card = await lookupScryfallCard(title);
    if (card && !pendingProposalCard) {
      showCardProposal(card);
    }
  } catch {
    // ignora frame non leggibili durante lo scan continuo
  } finally {
    isScanningFrame = false;
  }
}

// Ripristina eventuale sessione già attiva
(async () => {
  const { data } = await sb.auth.getSession();
  if (data?.session?.user) {
    currentUser = data.session.user;
    onAuthenticated();
  }
})();
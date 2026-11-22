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

// Configurazione WebSocket dello scanner Python (Render)
const DEFAULT_SCANNER_WS_URL = "wss://manastat-scanner-server.onrender.com/ws/scan";

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
    btn.textContent = isRunning ? "Ferma Scanner" : "Avvia Scanner";
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

// Navigazione tab in basso
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const targetTab = btn.dataset.tab;
    $(targetTab).classList.add("active");

    if (targetTab === "tab-collection") {
      await ensureCameraAndWs();
    } else {
      stopScannerSession();
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
  stopScannerSession();
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

// ---- DISEGNO DEI 4 BORDI RILEVATI DAL SERVER ----
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

// ---- WEBSOCKET + STREAMING FRAME VERSO SERVER PYTHON ----
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
  setScannerConnectionUi("Disconnesso", "disconnected", false);
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

  setScanStateBadge("Connessione server...");
  setScannerConnectionUi("Connessione...", "connecting", true);

  const socket = new WebSocket(url);
  wsConn = socket;

  socket.onopen = () => {
    if (wsRetryTimer) {
      clearTimeout(wsRetryTimer);
      wsRetryTimer = null;
    }
    setScanStateBadge("Inquadra una carta");
    setScannerConnectionUi("Connesso", "connected", true);
    setStatus($("collection-status"), "Connesso al server scanner!", "ok");
    startFrameLoop();
  };

  socket.onmessage = (ev) => {
    awaitingServerReply = false;
    if (pendingProposalCard) return;

    let payload = null;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (!payload || !payload.detected) {
      drawQuadOverlay(null, false);
      // Appena la carta viene tolta dall'inquadratura, sblocca per la prossima
      if (lockedAfterConfirmCard) {
        lockedAfterConfirmCard = null;
      }
      setScanStateBadge("Cerca bordo carta...");
      return;
    }

    const matches = Array.isArray(payload.matches) ? payload.matches : [];

    // Se è bloccato sull'ultima carta confermata, controlla se l'utente ha cambiato carta
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
        drawQuadOverlay(payload.quad, true);
        setScanStateBadge("Cambia carta per proseguire");
        return;
      }

      // Ha inquadrato una carta diversa: sblocca automaticamente
      lockedAfterConfirmCard = null;
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
      setScanStateBadge("Carta rilevata (in attesa match)");
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
      setScanStateBadge("Risveglio server (~25s)...");
      setScannerConnectionUi("Risveglio server...", "connecting", true);
      setStatus($("collection-status"), "Il server si sta avviando, nuovo tentativo tra 4s...", "");
      wsRetryTimer = setTimeout(() => {
        if ($("tab-collection")?.classList.contains("active") && cameraStream) {
          connectScannerWs();
        }
      }, 4000);
    } else {
      setScannerConnectionUi("Disconnesso", "disconnected", false);
      if (isCollectionActive && !pendingProposalCard) {
        setScanStateBadge("Server disconnesso");
      }
    }
  };
}

// ---- PROPOSTA SÌ / NO ----
function applyMatchToProposal(matchItem) {
  if (!pendingProposalCard || !matchItem) return;
  pendingProposalCard.payload = matchItem;

  $("proposal-name").textContent = matchItem.name || "Carta";
  const confPct = matchItem.confidence ? ` · Confidenza ${Math.round(matchItem.confidence * 100)}%` : "";
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

  $("proposal-match-source").textContent = "Riconosciuta dal server CV";
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
  setScanStateBadge("Inquadra una carta");
}

$("btn-proposal-no")?.addEventListener("click", () => {
  if (pendingProposalCard) {
    if (pendingProposalCard.idKey) rejectedCardKeys.add(pendingProposalCard.idKey);
    if (pendingProposalCard.nameKey) rejectedCardKeys.add(pendingProposalCard.nameKey);
    updateRejectedBadge();
  }
  setStatus($("collection-status"), "Carta scartata: non verrà riproposta.", "");
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

  try {
    setStatus($("collection-status"), `Salvataggio ${c.name} [${c.set_code}]...`);
    await saveCardPayloadToCollection(c, isFoil);

    lockedAfterConfirmCard = confirmedLock;
    rejectedCardKeys.clear();
    updateRejectedBadge();
    setStatus($("collection-status"), `${c.name} [${c.set_code}] aggiunta! Cambia carta per scansionare la prossima.`, "ok");
  } catch (err) {
    setStatus($("collection-status"), `Errore salvataggio: ${err.message}`, "err");
  } finally {
    hideCardProposalAndResume();
    if (lockedAfterConfirmCard) {
      setScanStateBadge("Cambia carta per proseguire");
    }
  }
});

$("btn-reset-rejected")?.addEventListener("click", () => {
  rejectedCardKeys.clear();
  updateRejectedBadge();
  setStatus($("collection-status"), "Lista carte scartate azzerata.", "ok");
});

async function ensureCameraAndWs() {
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
      setScannerConnectionUi("Disconnesso", "disconnected", false);
      setStatus($("collection-status"), `Errore fotocamera: ${err.message}`, "err");
      return;
    }
  }

  if (!wsConn || wsConn.readyState === WebSocket.CLOSED || wsConn.readyState === WebSocket.CLOSING) {
    connectScannerWs();
  } else if (wsConn.readyState === WebSocket.OPEN) {
    setScannerConnectionUi("Connesso", "connected", true);
    startFrameLoop();
  }
}

$("btn-start-camera")?.addEventListener("click", ensureCameraAndWs);

$("btnToggleScanner")?.addEventListener("click", async () => {
  if (scannerActive) {
    stopScannerSession();
    setScanStateBadge("Scanner fermato");
    setStatus($("collection-status"), "Scanner fermato.", "");
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
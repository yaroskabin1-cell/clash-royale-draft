const socket = io();

const STORAGE_ID = "cr_draft_client_id";
const STORAGE_NAME = "cr_draft_player_name";
const params = new URLSearchParams(window.location.search);
const inviteCode = cleanCode(params.get("lobby"));
const spectatorCode = cleanCode(params.get("spectate"));

const state = {
  connected: false,
  clientId: getClientId(),
  role: null,
  code: null,
  playerId: null,
  lobby: null,
  error: "",
  toast: "",
  pending: false,
  now: Date.now(),
  selectedBid: null,
  selectedCardKey: null,
  selectedTactic: null,
  bootLobbyCode: inviteCode,
  bootSpectatorCode: spectatorCode
};

const app = document.querySelector("#app");

socket.on("connect", () => {
  state.connected = true;
  render();
  if (state.bootSpectatorCode && !state.role) {
    spectateLobby(state.bootSpectatorCode);
    state.bootSpectatorCode = "";
  } else if (state.bootLobbyCode && !state.role && localStorage.getItem(STORAGE_NAME)) {
    joinLobby(state.bootLobbyCode, localStorage.getItem(STORAGE_NAME));
    state.bootLobbyCode = "";
  }
});

socket.on("disconnect", () => {
  state.connected = false;
  render();
});

socket.on("lobbyState", (lobby) => {
  const previous = state.lobby;
  state.now = Date.now();
  state.lobby = lobby;
  state.code = lobby.code;

  if (
    !previous ||
    previous.round !== lobby.round ||
    previous.status !== lobby.status ||
    lobby.status !== "bidding"
  ) {
    state.selectedBid = null;
    state.selectedCardKey = null;
    state.selectedTactic = null;
  }

  if (
    lobby.status === "bidding" &&
    state.selectedCardKey &&
    !getRoundCards(lobby).some((card) => card.key === state.selectedCardKey)
  ) {
    state.selectedCardKey = null;
  }

  if (lobby.status === "bidding" && Number.isInteger(state.selectedBid)) {
    const me = getMe();
    if (me && !me.bidLocked && !(me.availableBids || []).includes(state.selectedBid)) {
      state.selectedBid = null;
    }
  }

  if (lobby.status === "bidding") {
    const me = getMe();
    if (me?.forcedBid && !me.bidLocked) {
      state.selectedBid = me.forcedBid;
    }
    if (me && state.selectedTactic && !(me.availableTactics || []).includes(state.selectedTactic)) {
      state.selectedTactic = null;
    }
  }

  render();
});

window.setInterval(() => {
  if (state.lobby?.status === "bidding") {
    state.now = Date.now();
    updateTimerDom();
  }
}, 500);

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-action]");
  if (!form) return;

  event.preventDefault();
  const data = new FormData(form);
  const action = form.dataset.action;

  if (action === "create") {
    await createLobby(data.get("name"));
  }

  if (action === "join") {
    await joinLobby(data.get("code"), data.get("name"));
  }

  if (action === "spectate") {
    await spectateLobby(data.get("code"));
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.tagName === "FORM") return;

  const action = button.dataset.action;

  if (action === "copy-invite") {
    copyText(inviteUrl(), "Invite-Link kopiert");
  }

  if (action === "copy-code") {
    copyText(state.code, "Lobby-Code kopiert");
  }

  if (action === "copy-spectator") {
    copyText(spectatorUrl(), "Zuschauer-Link kopiert");
  }

  if (action === "start") {
    await emitCommand("startGame", { code: state.code, clientId: state.clientId });
  }

  if (action === "next") {
    await emitCommand("nextRound", { code: state.code, clientId: state.clientId });
  }

  if (action === "reset") {
    await emitCommand("resetGame", { code: state.code, clientId: state.clientId });
  }

  if (action === "bid") {
    const bid = Number(button.dataset.bid);
    const me = getMe();
    if (!me || me.bidLocked || !(me.availableBids || []).includes(bid) || state.pending) {
      return;
    }
    state.selectedBid = bid;
    state.error = "";
    updateSelectionDom();
  }

  if (action === "select-card") {
    const me = getMe();
    if (!me || me.bidLocked || state.pending) {
      return;
    }
    state.selectedCardKey = button.dataset.cardKey;
    state.error = "";
    updateSelectionDom();
  }

  if (action === "select-tactic") {
    const me = getMe();
    const tactic = button.dataset.tactic || null;
    const stealUnlockRound = state.lobby?.stealUnlockRound || 5;
    const stealLockedByRound = tactic === "steal" && state.lobby?.round < stealUnlockRound;
    if (
      !me ||
      me.bidLocked ||
      state.pending ||
      stealLockedByRound ||
      (tactic && !(me.availableTactics || []).includes(tactic))
    ) {
      return;
    }
    state.selectedTactic = state.selectedTactic === tactic ? null : tactic;
    state.error = "";
    updateSelectionDom();
  }

  if (action === "submit-picks") {
    if (!state.selectedCardKey || !state.selectedBid) {
      state.error = "Waehle Karte und Wertkarte.";
      render();
      return;
    }

    await emitCommand("placeBid", {
      code: state.code,
      clientId: state.clientId,
      bid: getMe()?.forcedBid || state.selectedBid,
      cardKey: state.selectedCardKey,
      tactic: state.selectedTactic || null
    });
  }
});

document.addEventListener(
  "error",
  (event) => {
    if (event.target instanceof HTMLImageElement && event.target.classList.contains("card-img")) {
      event.target.classList.add("is-missing");
    }
  },
  true
);

render();

async function createLobby(name) {
  const playerName = normalizeName(name);
  localStorage.setItem(STORAGE_NAME, playerName);
  await emitCommand("createLobby", { name: playerName, clientId: state.clientId }, (response) => {
    state.role = response.role;
    state.playerId = response.playerId;
    state.code = response.code;
    setUrl(`?lobby=${response.code}`);
  });
}

async function joinLobby(code, name) {
  const playerName = normalizeName(name);
  localStorage.setItem(STORAGE_NAME, playerName);
  await emitCommand(
    "joinLobby",
    { code: cleanCode(code), name: playerName, clientId: state.clientId },
    (response) => {
      state.role = response.role;
      state.playerId = response.playerId;
      state.code = response.code;
      setUrl(`?lobby=${response.code}`);
    }
  );
}

async function spectateLobby(code) {
  await emitCommand("spectateLobby", { code: cleanCode(code), clientId: state.clientId }, (response) => {
    state.role = response.role;
    state.code = response.code;
    state.playerId = null;
    setUrl(`?spectate=${response.code}`);
  });
}

async function emitCommand(event, payload, onOk) {
  state.pending = true;
  state.error = "";
  render();

  try {
    const response = await emitWithAck(event, payload);
    if (!response.ok) {
      throw new Error(response.error || "Aktion fehlgeschlagen");
    }
    if (onOk) onOk(response);
  } catch (error) {
    state.error = error.message;
    state.selectedBid = null;
  } finally {
    state.pending = false;
    render();
  }
}

function emitWithAck(event, payload) {
  return new Promise((resolve) => {
    socket.timeout(6000).emit(event, payload, (error, response) => {
      if (error) {
        resolve({ ok: false, error: "Server antwortet nicht." });
      } else {
        resolve(response || { ok: false, error: "Leere Serverantwort." });
      }
    });
  });
}

function render() {
  if (!state.role || !state.lobby) {
    app.innerHTML = renderHome();
    return;
  }

  app.innerHTML = renderGame();
}

function renderHome() {
  const storedName = escapeHtml(localStorage.getItem(STORAGE_NAME) || "");
  const codeValue = escapeHtml(inviteCode || "");
  const spectateValue = escapeHtml(spectatorCode || "");

  return `
    <div class="home-shell">
      <section class="entry-panel">
        <div class="brand-lockup">
          <div class="brand-shield">CR</div>
          <div>
            <p class="eyebrow">Draft Bidding</p>
            <h1>Clash Royale</h1>
          </div>
        </div>

        ${renderAlert()}

        <div class="entry-grid">
          <form class="entry-card" data-action="create">
            <h2>Neue Lobby</h2>
            <label>
              <span>Name</span>
              <input name="name" maxlength="18" value="${storedName}" autocomplete="nickname" required />
            </label>
            <button class="royale-button primary" type="submit" ${state.pending ? "disabled" : ""}>
              ${icon("crown")} Lobby erstellen
            </button>
          </form>

          <form class="entry-card" data-action="join">
            <h2>Lobby beitreten</h2>
            <label>
              <span>Code</span>
              <input name="code" maxlength="6" value="${codeValue}" autocomplete="off" required />
            </label>
            <label>
              <span>Name</span>
              <input name="name" maxlength="18" value="${storedName}" autocomplete="nickname" required />
            </label>
            <button class="royale-button blue" type="submit" ${state.pending ? "disabled" : ""}>
              ${icon("users")} Beitreten
            </button>
          </form>

          <form class="entry-card compact" data-action="spectate">
            <h2>Zuschauer</h2>
            <label>
              <span>Code</span>
              <input name="code" maxlength="6" value="${spectateValue || codeValue}" autocomplete="off" required />
            </label>
            <button class="royale-button ghost" type="submit" ${state.pending ? "disabled" : ""}>
              ${icon("eye")} Zuschauen
            </button>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderGame() {
  const lobby = state.lobby;
  const me = getMe();

  return `
    <div class="game-shell">
      <aside class="sidebar">
        ${renderLobbyPanel(lobby)}
        ${renderDeckPanel(me)}
        ${renderPlayersPanel(lobby)}
      </aside>
      <main class="stage">
        ${renderStageTop(lobby, me)}
        ${renderStageBody(lobby, me)}
      </main>
      ${renderToast()}
    </div>
  `;
}

function renderLobbyPanel(lobby) {
  return `
    <section class="side-panel lobby-panel">
      <div class="panel-heading">
        <h2>Lobby</h2>
        <span class="connection ${state.connected ? "online" : "offline"}"></span>
      </div>
      <div class="code-plate">${escapeHtml(lobby.code)}</div>
      <div class="copy-grid">
        <button class="mini-button" data-action="copy-invite">${icon("link")} Invite</button>
        <button class="mini-button" data-action="copy-code">${icon("copy")} Code</button>
        <button class="mini-button" data-action="copy-spectator">${icon("eye")} Zuschauer</button>
      </div>
      <div class="lobby-meta">
        <span>${lobby.players.length}/${4} Spieler</span>
        <span>${lobby.spectators} Zuschauer</span>
      </div>
    </section>
  `;
}

function renderDeckPanel(me) {
  const deck = me?.deck || [];
  const slots = Array.from({ length: 8 }, (_, index) => {
    const card = deck[index];
    if (!card) return `<div class="deck-slot empty"></div>`;
    return `<div class="deck-slot">${cardThumb(card, "Deck")}</div>`;
  }).join("");

  return `
    <section class="side-panel">
      <div class="panel-heading">
        <h2>Mein Deck</h2>
        <span class="counter">${deck.length}/8</span>
      </div>
      <div class="deck-grid">${slots}</div>
    </section>
  `;
}

function renderPlayersPanel(lobby) {
  const players = lobby.players
    .map((player) => {
      const deckThumbs = player.deck
        .slice(0, 8)
        .map((card) => `<span class="tiny-card">${cardThumb(card, "Karte")}</span>`)
        .join("");
      const empty = Array.from({ length: Math.max(0, 8 - player.deck.length) }, () => `<span class="tiny-card empty"></span>`).join("");

      return `
        <div class="player-row ${player.id === state.playerId ? "self" : ""}">
          <div class="player-main">
            <span class="status-dot ${player.connected ? "online" : "offline"}"></span>
            <strong>${escapeHtml(player.name)}</strong>
            ${player.isHost ? `<span class="host-mark">${icon("crown")}</span>` : ""}
          </div>
          <div class="player-deck-count">${player.deck.length}/8</div>
          <div class="player-deck-strip">${deckThumbs}${empty}</div>
        </div>
      `;
    })
    .join("");

  return `
    <section class="side-panel players-panel">
      <div class="panel-heading">
        <h2>Spieler</h2>
        <span class="counter">${lobby.players.filter((player) => player.connected).length}</span>
      </div>
      <div class="players-list">${players}</div>
    </section>
  `;
}

function renderStageTop(lobby, me) {
  const statusLabel = {
    waiting: "Lobby",
    bidding: "Bieten",
    reveal: "Rundenauswertung",
    finished: "Finale"
  }[lobby.status];

  if (lobby.status === "bidding") {
    const timeLeft = getRoundTimeLeft(lobby);
    const progress = getRoundProgress(lobby);
    return `
      <header class="stage-top selection-stage-top">
        <div class="selection-round-title">
          <h1>Runde ${lobby.round} / ${lobby.maxRounds}</h1>
          <span class="phase-pill">WÄHLEN</span>
        </div>
        <div class="top-badges">
          <span class="badge timer-badge ${timeLeft <= 5 ? "danger" : ""}">
            <span class="timer-dot" style="--progress:${progress}"></span>${timeLeft}s
          </span>
          <span class="badge purple">${lobby.players.filter((player) => player.bidLocked).length}/${lobby.players.length} bereit</span>
        </div>
      </header>
      ${renderAlert()}
    `;
  }

  return `
    <header class="stage-top">
      <div>
        <p class="eyebrow">${statusLabel}</p>
        <h1>Runde ${lobby.round || 0}/${lobby.maxRounds}</h1>
      </div>
      <div class="top-badges">
        <span class="badge purple">${lobby.discardedCount} Abwurf</span>
      </div>
    </header>
    ${renderAlert()}
  `;
}

function renderStageBody(lobby, me) {
  if (lobby.status === "waiting") {
    return renderWaiting(lobby);
  }

  if (lobby.status === "bidding") {
    return renderBidding(lobby, me);
  }

  if (lobby.status === "reveal") {
    return renderReveal(lobby);
  }

  return renderFinished(lobby);
}

function renderWaiting(lobby) {
  const isHost = getMe()?.isHost;
  const canStart = isHost && lobby.players.filter((player) => player.connected).length >= 2;
  const playerBadges = lobby.players
    .map(
      (player) => `
        <div class="waiting-player ${player.connected ? "online" : ""}">
          <span>${escapeHtml(player.name)}</span>
          <strong>${player.isHost ? "Host" : "Spieler"}</strong>
        </div>
      `
    )
    .join("");

  return `
    <section class="stage-panel waiting-panel">
      <div class="arena-medallion">VS</div>
      <h2>Warte auf Spieler</h2>
      <div class="waiting-grid">${playerBadges}</div>
      ${
        isHost
          ? `<button class="royale-button primary wide" data-action="start" ${!canStart || state.pending ? "disabled" : ""}>${icon(
              "swords"
            )} Start</button>`
          : `<div class="waiting-host">Host startet die Partie</div>`
      }
    </section>
  `;
}

function renderBidding(lobby, me) {
  const cards = getRoundCards(lobby);
  const locked = Boolean(me?.bidLocked);
  const legalBids = me?.availableBids || [];
  const usedBids = me?.usedBids || [];
  const blockedBids = me?.blockedBids || [];
  const usedTactics = me?.usedTactics || [];
  const availableTactics = me?.availableTactics || [];
  const forcedBid = me?.forcedBid || null;
  const stealUnlockRound = lobby.stealUnlockRound || 5;
  const hasCardSelected = Boolean(state.selectedCardKey);
  const activeBid = forcedBid || state.selectedBid;
  const hasBidSelected = Number.isInteger(activeBid);
  const hasTacticSelected = Boolean(state.selectedTactic);
  const timeLeft = getRoundTimeLeft(lobby);
  const timerExpired = timeLeft <= 0;
  const canChoose = state.role === "player" && me && !locked;
  const hasLegalBidSelected = hasBidSelected && legalBids.includes(activeBid);
  const canPickBid = canChoose && legalBids.length > 0 && !forcedBid;
  const canSubmit = canChoose && hasCardSelected && hasLegalBidSelected && !state.pending;
  const buttons = Array.from({ length: 10 }, (_, index) => {
    const bid = index + 1;
    const used = usedBids.includes(bid);
    const blocked = blockedBids.includes(bid);
    const selected = activeBid === bid;
    const disabled = forcedBid ? bid !== forcedBid : !canPickBid || !legalBids.includes(bid) || state.pending;
    return `
      <button class="value-card ${selected ? "selected" : ""} ${used ? "used" : ""} ${
        blocked ? "blocked" : ""
      }" data-action="bid" data-bid="${bid}" ${
        disabled ? "disabled" : ""
      } title="${blocked ? "Durch Steal gesperrt" : used ? "Bereits benutzt" : ""}">
        <span>${bid}</span>
        ${selected ? `<i class="value-check">${icon("check")}</i>` : ""}
      </button>
    `;
  }).join("");
  const poolCards = cards
    .map(
      (card) => `
        <button class="selection-card ${state.selectedCardKey === card.key ? "selected" : ""}" data-action="select-card" data-card-key="${escapeAttr(
          card.key
        )}" ${!canChoose || state.pending ? "disabled" : ""}>
          <span class="selection-card-frame">${cardThumb(card, "Runden-Pool")}</span>
        </button>
      `
    )
    .join("");
  const tactics = getTacticOptions()
    .map(
      (tactic) => {
        const used = usedTactics.includes(tactic.key);
        const lockedByRound = tactic.key === "steal" && lobby.round < stealUnlockRound;
        const available = availableTactics.includes(tactic.key) && !lockedByRound;
        const selected = (state.selectedTactic || "") === tactic.key;
        const disabled = !canChoose || state.pending || !available;
        const description = lockedByRound ? `Ab Runde ${stealUnlockRound} verfügbar` : tactic.description;
        return `
        <button class="tactic-card tactic-${tactic.key || "none"} ${selected ? "selected" : ""} ${
          used ? "used" : ""
        } ${lockedByRound ? "locked-round" : ""}" data-action="select-tactic" data-tactic="${escapeAttr(
          tactic.key
        )}" ${disabled ? "disabled" : ""}>
          <strong>${escapeHtml(tactic.label)}</strong>
          <span>${escapeHtml(description)}</span>
        </button>
      `;
      }
    )
    .join("");
  const selectedBidText = forcedBid
    ? `Auto-Gebot ${forcedBid} durch Gamble-Malus ✓`
    : hasBidSelected
      ? `Gebot ${activeBid} gewählt ✓`
      : "Wähle eine Wertkarte";
  const selectedTacticText = hasTacticSelected
    ? `${getTacticOptions().find((tactic) => tactic.key === state.selectedTactic)?.label} bereit ✓`
    : "Optional: Mod wählen";
  let submitHelp = "Bereit zum Abgeben";
  if (locked) {
    submitHelp = "Picks sind gesperrt";
  } else if (!hasCardSelected) {
    submitHelp = "Wähle zuerst eine Karte";
  } else if (!hasBidSelected) {
    submitHelp = "Wähle eine Wertkarte";
  } else if (!hasLegalBidSelected) {
    submitHelp = "Diese Wertkarte ist nicht mehr verfügbar";
  } else if (timerExpired) {
    submitHelp = "Countdown ist vorbei, Server wertet aus";
  }

  return `
    <section class="selection-board">
      <div class="selection-split">
        <div class="selection-box round-pool-box">
          <h2>RUNDEN-POOL</h2>
          <div class="selection-card-row">${poolCards}</div>
          <p>Wähle eine Karte aus dem Runden-Pool</p>
        </div>

        <div class="selection-box value-box">
          <h2>WERTKARTEN</h2>
          <div class="value-grid">${buttons}</div>
          <p class="${hasBidSelected ? "is-selected" : ""}">${selectedBidText}</p>
        </div>
      </div>

      <div class="selection-box tactic-box">
        <h2>MODS</h2>
        <div class="tactic-grid">${tactics}</div>
        <p class="${hasTacticSelected ? "is-selected" : ""}">${selectedTacticText}</p>
      </div>

      <div class="pick-submit-wrap">
        <button class="pick-submit-button" data-action="submit-picks" ${!canSubmit ? "disabled" : ""}>
          ${locked ? `${icon("check")} Picks abgegeben` : "Picks abgeben"}
        </button>
        <p>${submitHelp}</p>
      </div>

      ${renderLockTrack(lobby)}
    </section>
  `;
}

function renderLockTrack(lobby) {
  const chips = lobby.players
    .map(
      (player) => `
        <div class="lock-chip ${player.bidLocked ? "ready" : ""} ${player.connected ? "" : "offline"}">
          <span>${escapeHtml(player.name)}</span>
          ${player.bidLocked ? icon("check") : `<i></i>`}
        </div>
      `
    )
    .join("");

  return `<div class="lock-track">${chips}</div>`;
}

function renderReveal(lobby) {
  const reveal = lobby.reveal;
  const isHost = getMe()?.isHost;
  const winnerCount = reveal.winnerIds?.length || 0;
  const banner = `${winnerCount} Wunschkarte${winnerCount === 1 ? "" : "n"} gewonnen`;
  const results = reveal.entries
    .map((entry, index) => {
      const bid = Number.isInteger(entry.bid) ? entry.bid : "-";
      return `
        <article class="result-card evaluation-card ${entry.won ? "winner" : ""} ${entry.fallback ? "fallback" : ""}" style="--i:${index}">
          ${entry.won ? `<div class="winner-strip">${icon("check")} Gewünschte Karte erhalten</div>` : ""}
          <div class="result-head">
            <strong>${escapeHtml(entry.name)}</strong>
          </div>
          <div class="result-columns">
            <div class="result-column bid-column">
              <span>Gebot</span>
              <strong class="result-bid-tile">${bid}</strong>
            </div>
            <div class="result-column">
              <span>Taktik</span>
              <strong class="result-tactic-tile tactic-${escapeAttr(entry.tactic || "auto")}">${escapeHtml(
        entry.tacticLabel || "-"
      )}</strong>
            </div>
            <div class="result-column">
              <span>Gewählt</span>
              ${resultCardImage(entry.selectedCard)}
            </div>
            <div class="result-column">
              <span>Erhält</span>
              ${resultCardImage(entry.receivedCard)}
            </div>
          </div>
          ${entry.effect ? `<div class="result-effect">${escapeHtml(entry.effect)}</div>` : ""}
        </article>
      `;
    })
    .join("");
  const poolStrip = (reveal.cards || [])
    .map((card) => `<div class="reveal-pool-card">${cardThumb(card, "Kartenpool")}</div>`)
    .join("");

  return `
    <section class="reveal-layout horizontal-reveal">
      <div class="reveal-header">
        <div>
          <p class="eyebrow">Rundenauswertung</p>
          <h2>${banner}</h2>
        </div>
        <div class="reveal-pool-strip">${poolStrip}</div>
      </div>
      <div class="results-wrap">
        <div class="results-grid horizontal-results">${results}</div>
        ${
          isHost
            ? `<button class="royale-button primary wide" data-action="next" ${state.pending ? "disabled" : ""}>${icon(
                "arrow"
              )} ${lobby.round >= lobby.maxRounds ? "Finale" : "Weiter"}</button>`
            : `<div class="waiting-host">Host wechselt die Runde</div>`
        }
      </div>
    </section>
  `;
}

function renderFinished(lobby) {
  const isHost = getMe()?.isHost;
  const rows = lobby.players
    .map(
      (player) => `
        <article class="final-card">
          <div class="final-head">
            <strong>${escapeHtml(player.name)}</strong>
            <span>${player.deck.length}/8 Karten</span>
          </div>
          <div class="final-deck">
            ${Array.from({ length: 8 }, (_, index) =>
              player.deck[index] ? `<div class="final-slot">${cardThumb(player.deck[index], "Deck")}</div>` : `<div class="final-slot empty"></div>`
            ).join("")}
          </div>
        </article>
      `
    )
    .join("");

  return `
    <section class="stage-panel final-panel">
      <div class="arena-medallion">8</div>
      <h2>Finale Decks</h2>
      <div class="final-grid">${rows}</div>
      ${
        isHost
          ? `<button class="royale-button primary wide" data-action="reset" ${state.pending ? "disabled" : ""}>${icon(
              "refresh"
            )} Neue Partie</button>`
          : ""
      }
    </section>
  `;
}

function largeCard(card) {
  if (!card) return `<div class="large-card loading-card"></div>`;
  return `
    <article class="large-card rarity-${escapeHtml(card.rarity)}">
      <div class="elixir-bubble">${card.elixir ?? "?"}</div>
      <div class="card-art-wrap">
        <img class="card-img" src="${escapeAttr(card.image)}" alt="${escapeAttr(card.name)}" />
      </div>
      <div class="card-name">${escapeHtml(card.name)}</div>
      <div class="card-type">${escapeHtml(card.rarity)} · ${escapeHtml(card.type)}</div>
    </article>
  `;
}

function miniCard(card) {
  if (!card) return `<strong class="empty-result">-</strong>`;
  return `
    <div class="mini-card">
      ${cardThumb(card, "Karte")}
      <span>${escapeHtml(card.name)}</span>
    </div>
  `;
}

function resultCardImage(card) {
  if (!card) return `<strong class="empty-result">-</strong>`;
  return `
    <div class="result-card-image">
      ${cardThumb(card, "Karte")}
      <small>${escapeHtml(card.name)}</small>
    </div>
  `;
}

function cardThumb(card, label) {
  return `<img class="card-img" src="${escapeAttr(card.image)}" alt="${escapeAttr(`${label}: ${card.name}`)}" title="${escapeAttr(
    card.name
  )}" loading="lazy" />`;
}

function renderAlert() {
  if (!state.error) return "";
  return `<div class="alert">${escapeHtml(state.error)}</div>`;
}

function renderToast() {
  if (!state.toast) return "";
  return `<div class="toast">${escapeHtml(state.toast)}</div>`;
}

function updateTimerDom() {
  const lobby = state.lobby;
  if (!lobby || lobby.status !== "bidding") {
    return;
  }

  const timeLeft = getRoundTimeLeft(lobby);
  const progress = getRoundProgress(lobby);
  const badge = document.querySelector(".timer-badge");
  if (badge) {
    badge.classList.toggle("danger", timeLeft <= 5);
    badge.innerHTML = `<span class="timer-dot" style="--progress:${progress}"></span>${timeLeft}s`;
  }

  const me = getMe();
  const help = document.querySelector(".pick-submit-wrap p");
  if (help && timeLeft <= 0 && !me?.bidLocked) {
    help.textContent = "Countdown ist vorbei, Server wertet aus";
  }
}

function updateSelectionDom() {
  const ui = getBiddingUiState();
  if (!ui) {
    render();
    return;
  }

  document.querySelector(".alert")?.remove();

  document.querySelectorAll(".selection-card").forEach((cardButton) => {
    cardButton.classList.toggle("selected", cardButton.dataset.cardKey === state.selectedCardKey);
  });

  document.querySelectorAll(".value-card").forEach((bidButton) => {
    const selected = Number(bidButton.dataset.bid) === ui.activeBid;
    bidButton.classList.toggle("selected", selected);
    bidButton.querySelector(".value-check")?.remove();
    if (selected) {
      bidButton.insertAdjacentHTML("beforeend", `<i class="value-check">${icon("check")}</i>`);
    }
  });

  document.querySelectorAll(".tactic-card").forEach((tacticButton) => {
    tacticButton.classList.toggle("selected", tacticButton.dataset.tactic === (state.selectedTactic || ""));
  });

  const valueText = document.querySelector(".value-box p");
  if (valueText) {
    valueText.textContent = ui.selectedBidText;
    valueText.classList.toggle("is-selected", ui.hasBidSelected);
  }

  const tacticText = document.querySelector(".tactic-box p");
  if (tacticText) {
    tacticText.textContent = ui.selectedTacticText;
    tacticText.classList.toggle("is-selected", ui.hasTacticSelected);
  }

  const submit = document.querySelector(".pick-submit-button");
  if (submit) {
    submit.disabled = !ui.canSubmit;
    submit.textContent = "Picks abgeben";
  }

  const submitHelp = document.querySelector(".pick-submit-wrap p");
  if (submitHelp) {
    submitHelp.textContent = ui.submitHelp;
  }
}

function getBiddingUiState() {
  const lobby = state.lobby;
  const me = getMe();
  if (!lobby || lobby.status !== "bidding") {
    return null;
  }

  const legalBids = me?.availableBids || [];
  const forcedBid = me?.forcedBid || null;
  const activeBid = forcedBid || state.selectedBid;
  const locked = Boolean(me?.bidLocked);
  const hasCardSelected = Boolean(state.selectedCardKey);
  const hasBidSelected = Number.isInteger(activeBid);
  const hasLegalBidSelected = hasBidSelected && legalBids.includes(activeBid);
  const hasTacticSelected = Boolean(state.selectedTactic);
  const timerExpired = getRoundTimeLeft(lobby) <= 0;
  const canChoose = state.role === "player" && me && !locked;
  const canSubmit = canChoose && hasCardSelected && hasLegalBidSelected && !state.pending;
  const selectedBidText = forcedBid
    ? `Auto-Gebot ${forcedBid} durch Gamble-Malus ✓`
    : hasBidSelected
      ? `Gebot ${activeBid} gewählt ✓`
      : "Wähle eine Wertkarte";
  const selectedTacticText = hasTacticSelected
    ? `${getTacticOptions().find((tactic) => tactic.key === state.selectedTactic)?.label} bereit ✓`
    : "Optional: Mod wählen";
  let submitHelp = "Bereit zum Abgeben";
  if (locked) {
    submitHelp = "Picks sind gesperrt";
  } else if (!hasCardSelected) {
    submitHelp = "Wähle zuerst eine Karte";
  } else if (!hasBidSelected) {
    submitHelp = "Wähle eine Wertkarte";
  } else if (!hasLegalBidSelected) {
    submitHelp = "Diese Wertkarte ist nicht mehr verfügbar";
  } else if (timerExpired) {
    submitHelp = "Countdown ist vorbei, Server wertet aus";
  }

  return {
    activeBid,
    canSubmit,
    hasBidSelected,
    hasLegalBidSelected,
    hasTacticSelected,
    selectedBidText,
    selectedTacticText,
    submitHelp
  };
}

function getMe() {
  if (!state.lobby || state.role !== "player") return null;
  return state.lobby.players.find((player) => player.id === state.playerId || player.id === state.clientId) || null;
}

function getRoundCards(lobby) {
  if (Array.isArray(lobby.currentCards) && lobby.currentCards.length) {
    return lobby.currentCards;
  }
  return lobby.currentCard ? [lobby.currentCard] : [];
}

function getRoundTimeLeft(lobby) {
  if (!lobby?.roundEndsAt || lobby.status !== "bidding") {
    return 0;
  }
  return Math.max(0, Math.ceil((lobby.roundEndsAt - state.now) / 1000));
}

function getRoundProgress(lobby) {
  if (!lobby?.roundStartedAt || !lobby?.roundEndsAt || !lobby?.roundDurationMs) {
    return 0;
  }
  const elapsed = Math.max(0, state.now - lobby.roundStartedAt);
  return Math.min(1, elapsed / lobby.roundDurationMs);
}

function getTacticOptions() {
  return [
    {
      key: "steal",
      label: "Steal",
      description: "Sperrt deine gewählte Wertkarte für alle Gegner bis zum Spielende."
    },
    {
      key: "shield",
      label: "Shield",
      description: "Deine Wunschkarte ist geschützt. Kein normales Gebot kann dich überbieten."
    },
    {
      key: "gamble",
      label: "Gamble",
      description: "+2 auf dein Gebot. Verlierst du, ist nächste Runde die niedrigste Wertkarte erzwungen."
    }
  ];
}

function winnerName(winnerId, lobby) {
  return lobby.players.find((player) => player.id === winnerId)?.name || "Niemand";
}

function inviteUrl() {
  return `${window.location.origin}/?lobby=${state.code}`;
}

function spectatorUrl() {
  return `${window.location.origin}/?spectate=${state.code}`;
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_error) {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  state.toast = label;
  render();
  window.setTimeout(() => {
    state.toast = "";
    render();
  }, 1600);
}

function getClientId() {
  let id = localStorage.getItem(STORAGE_ID);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(STORAGE_ID, id);
  }
  return id;
}

function normalizeName(name) {
  return String(name || "Spieler")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18) || "Spieler";
}

function cleanCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function setUrl(search) {
  const next = `${window.location.pathname}${search}`;
  window.history.replaceState(null, "", next);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function icon(name) {
  const paths = {
    arrow: `<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>`,
    check: `<path d="M20 6 9 17l-5-5"/>`,
    copy: `<rect width="13" height="13" x="9" y="9" rx="2"/><rect width="13" height="13" x="2" y="2" rx="2"/>`,
    crown: `<path d="m2 8 4 9h12l4-9-6 4-4-7-4 7-6-4z"/><path d="M6 21h12"/>`,
    eye: `<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
    link: `<path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.9 5"/><path d="M14 11a5 5 0 0 0-7.07 0L4.8 13.12a5 5 0 0 0 7.07 7.07L13.1 19"/>`,
    refresh: `<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M3 19v-6h6"/><path d="M21 5v6h-6"/>`,
    swords: `<path d="m14.5 17.5 3 3 3-3-3-3"/><path d="M13 19 21 3"/><path d="m9.5 17.5-3 3-3-3 3-3"/><path d="M11 19 3 3"/>`,
    target: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/>`,
    users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`
  };

  return `
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      ${paths[name] || paths.check}
    </svg>
  `;
}

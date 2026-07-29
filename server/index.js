const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const REQUESTED_CARD_DATA_URL =
  "https://raw.githubusercontent.com/RoyaleAPI/cr-api-data/master/json/cards.json";
const CARD_DATA_URLS = [
  REQUESTED_CARD_DATA_URL,
  "https://royaleapi.github.io/cr-api-data/json/cards.json"
];
const CARD_IMAGE_BASE = "https://cdn.royaleapi.com/static/img/cards-150";
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const STARTING_POINTS = 28;
const MAX_ROUNDS = 8;
const MAX_BID = 10;
const ROUND_CARD_COUNT = 4;
const ROUND_DURATION_MS = 15 * 1000;
const MAX_CHAMPIONS_PER_DECK = 1;
const STEAL_UNLOCK_ROUND = Math.floor(MAX_ROUNDS / 2) + 1;
const LOBBY_TTL_MS = 4 * 60 * 60 * 1000;
const HEIST_TACTICS = new Map([
  ["steal", { key: "steal", label: "Steal" }],
  ["shield", { key: "shield", label: "Shield" }],
  ["gamble", { key: "gamble", label: "Gamble" }]
]);
const STANDARD_RARITIES = new Set(["common", "rare", "epic", "legendary", "champion"]);
const STANDARD_TYPES = new Set(["troop", "building", "spell"]);
const EVENT_CARD_KEYS = new Set([
  "party-hut",
  "party-rocket",
  "raging-prince",
  "santa-hog-rider",
  "super-archers",
  "super-ice-golem",
  "super-lava-hound",
  "super-magic-archer",
  "super-mini-pekka",
  "super-witch",
  "terry"
]);
const EVENT_CARD_PATTERN = /\b(super|santa|party|raging)\b/i;

const FALLBACK_CARDS = [
  { id: 26000000, key: "knight", name: "Knight", rarity: "common", elixir: 3, type: "Troop" },
  { id: 26000001, key: "archers", name: "Archers", rarity: "common", elixir: 3, type: "Troop" },
  { id: 28000000, key: "fireball", name: "Fireball", rarity: "rare", elixir: 4, type: "Spell" },
  { id: 26000005, key: "minions", name: "Minions", rarity: "common", elixir: 3, type: "Troop" },
  { id: 26000003, key: "giant", name: "Giant", rarity: "rare", elixir: 5, type: "Troop" },
  { id: 26000014, key: "musketeer", name: "Musketeer", rarity: "rare", elixir: 4, type: "Troop" },
  { id: 26000021, key: "hog-rider", name: "Hog Rider", rarity: "rare", elixir: 4, type: "Troop" },
  { id: 28000011, key: "the-log", name: "The Log", rarity: "legendary", elixir: 2, type: "Spell" }
].map(normalizeCard);

let cards = [];
let cardsLoadedAt = null;
let cardsSource = "none";
let loadingCards = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/cards/status", (_req, res) => {
  res.json({
    loaded: cards.length,
    loadedAt: cardsLoadedAt,
    source: cardsSource
  });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const lobbies = new Map();

io.on("connection", (socket) => {
  socket.on("createLobby", async (payload, reply) => {
    try {
      const name = normalizeName(payload?.name);
      const clientId = normalizeId(payload?.clientId);
      const code = createLobbyCode();
      const cardPool = shuffle(await getCards());
      const lobby = {
        code,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hostId: clientId,
        status: "waiting",
        round: 0,
        maxRounds: MAX_ROUNDS,
        currentCards: [],
        roundStartedAt: null,
        roundEndsAt: null,
        roundTimer: null,
        cardPool,
        discarded: [],
        reveal: null,
        bids: new Map(),
        players: new Map(),
        spectators: new Map()
      };

      lobby.players.set(clientId, createPlayer(clientId, name, socket.id, true));
      lobbies.set(code, lobby);
      socket.join(code);
      replyOk(reply, { code, role: "player", playerId: clientId });
      emitLobby(lobby);
    } catch (error) {
      replyError(reply, error.message);
    }
  });

  socket.on("joinLobby", (payload, reply) => {
    try {
      const code = normalizeCode(payload?.code);
      const name = normalizeName(payload?.name);
      const clientId = normalizeId(payload?.clientId);
      const lobby = getLobbyOrThrow(code);
      const existing = lobby.players.get(clientId);

      if (!existing && lobby.players.size >= MAX_PLAYERS) {
        throw new Error("Diese Lobby ist bereits voll.");
      }

      if (!existing && lobby.status !== "waiting") {
        throw new Error("Das Spiel laeuft bereits. Nutze den Zuschauer-Link.");
      }

      if (existing) {
        existing.name = name || existing.name;
        existing.connected = true;
        existing.socketId = socket.id;
      } else {
        lobby.players.set(clientId, createPlayer(clientId, name, socket.id, false));
      }

      lobby.spectators.delete(clientId);
      socket.join(code);
      touch(lobby);
      replyOk(reply, { code, role: "player", playerId: clientId });
      emitLobby(lobby);
    } catch (error) {
      replyError(reply, error.message);
    }
  });

  socket.on("spectateLobby", (payload, reply) => {
    try {
      const code = normalizeCode(payload?.code);
      const clientId = normalizeId(payload?.clientId);
      const lobby = getLobbyOrThrow(code);

      lobby.spectators.set(clientId, {
        id: clientId,
        socketId: socket.id,
        connected: true
      });

      socket.join(code);
      touch(lobby);
      replyOk(reply, { code, role: "spectator" });
      emitLobby(lobby);
    } catch (error) {
      replyError(reply, error.message);
    }
  });

  socket.on("startGame", async (payload, reply) => {
    try {
      const lobby = getLobbyOrThrow(payload?.code);
      assertHost(lobby, payload?.clientId);
      const connectedPlayers = getConnectedPlayers(lobby);

      if (connectedPlayers.length < MIN_PLAYERS) {
        throw new Error("Mindestens 2 Spieler muessen verbunden sein.");
      }

      lobby.cardPool = shuffle(await getCards());
      lobby.discarded = [];
      for (const player of lobby.players.values()) {
        player.points = STARTING_POINTS;
        player.deck = [];
        player.usedBids = [];
        player.blockedBids = [];
        player.usedTactics = [];
        player.gamblePenalty = false;
      }

      beginBiddingRound(lobby, 1);
      touch(lobby);
      replyOk(reply);
      emitLobby(lobby);
    } catch (error) {
      replyError(reply, error.message);
    }
  });

  socket.on("placeBid", (payload, reply) => {
    try {
      const lobby = getLobbyOrThrow(payload?.code);
      const player = getPlayerOrThrow(lobby, payload?.clientId);
      const bid = Number(payload?.bid);
      const cardKey = normalizeCardKey(payload?.cardKey);
      const tactic = normalizeTactic(payload?.tactic, { optional: true });

      if (lobby.status !== "bidding") {
        throw new Error("Aktuell kann kein Gebot abgegeben werden.");
      }

      if (lobby.roundEndsAt && Date.now() >= lobby.roundEndsAt) {
        lockTimedOutPlayers(lobby);
        resolveRound(lobby);
        touch(lobby);
        emitLobby(lobby);
        throw new Error("Zeit abgelaufen. Diese Runde wird ausgewertet.");
      }

      if (!Number.isInteger(bid) || bid < 1 || bid > MAX_BID) {
        throw new Error("Waehle ein Gebot zwischen 1 und 10.");
      }

      if (lobby.bids.has(player.id)) {
        throw new Error("Dein Gebot ist bereits gesperrt.");
      }

      const targetCard = getRoundCard(lobby, cardKey);
      if (!targetCard) {
        throw new Error("Waehle zuerst eine Karte aus dem Kartenpool.");
      }

      if (!canPlayerReceiveCard(player, targetCard)) {
        throw new Error("Du hast bereits einen Champion. Waehle eine andere Karte.");
      }

      if ((player.usedBids || []).includes(bid)) {
        throw new Error(`Die ${bid} hast du bereits benutzt.`);
      }

      if ((player.blockedBids || []).includes(bid)) {
        throw new Error(`Die ${bid} wurde durch Steal gesperrt.`);
      }

      if (tactic && (player.usedTactics || []).includes(tactic)) {
        throw new Error(`${HEIST_TACTICS.get(tactic).label} hast du bereits benutzt.`);
      }

      if (tactic === "steal" && lobby.round < STEAL_UNLOCK_ROUND) {
        throw new Error(`Steal ist erst ab Runde ${STEAL_UNLOCK_ROUND} verfuegbar.`);
      }

      const forcedBid = getForcedBid(player);
      if (forcedBid && bid !== forcedBid) {
        throw new Error(`Gamble-Malus aktiv: Du musst die ${forcedBid} einsetzen.`);
      }

      player.gamblePenalty = false;
      lobby.bids.set(player.id, { bid, cardKey: targetCard.key, tactic, auto: false, forced: Boolean(forcedBid) });
      touch(lobby);
      replyOk(reply);
      maybeResolveRound(lobby);
      emitLobby(lobby);
    } catch (error) {
      replyError(reply, error.message);
    }
  });

  socket.on("nextRound", (payload, reply) => {
    try {
      const lobby = getLobbyOrThrow(payload?.code);
      assertHost(lobby, payload?.clientId);

      if (lobby.status !== "reveal") {
        throw new Error("Die aktuelle Runde ist noch nicht ausgewertet.");
      }

      if (lobby.round >= lobby.maxRounds) {
        finishLobby(lobby);
      } else {
        beginBiddingRound(lobby, lobby.round + 1);
      }

      touch(lobby);
      replyOk(reply);
      emitLobby(lobby);
    } catch (error) {
      replyError(reply, error.message);
    }
  });

  socket.on("resetGame", async (payload, reply) => {
    try {
      const lobby = getLobbyOrThrow(payload?.code);
      assertHost(lobby, payload?.clientId);
      lobby.status = "waiting";
      lobby.round = 0;
      lobby.currentCards = [];
      clearRoundTimer(lobby);
      lobby.roundStartedAt = null;
      lobby.roundEndsAt = null;
      lobby.cardPool = shuffle(await getCards());
      lobby.discarded = [];
      lobby.reveal = null;
      lobby.bids = new Map();
      for (const player of lobby.players.values()) {
        player.points = STARTING_POINTS;
        player.deck = [];
        player.usedBids = [];
        player.blockedBids = [];
        player.usedTactics = [];
        player.gamblePenalty = false;
      }
      touch(lobby);
      replyOk(reply);
      emitLobby(lobby);
    } catch (error) {
      replyError(reply, error.message);
    }
  });

  socket.on("disconnect", () => {
    for (const lobby of lobbies.values()) {
      let changed = false;
      for (const player of lobby.players.values()) {
        if (player.socketId === socket.id) {
          player.connected = false;
          player.socketId = null;
          changed = true;
        }
      }
      for (const spectator of lobby.spectators.values()) {
        if (spectator.socketId === socket.id) {
          spectator.connected = false;
          spectator.socketId = null;
          changed = true;
        }
      }
      if (changed) {
        reassignHostIfNeeded(lobby);
        maybeResolveRound(lobby);
        touch(lobby);
        emitLobby(lobby);
      }
    }
  });
});

server.listen(PORT, () => {
  getCards().catch((error) => {
    console.warn("Card preload failed:", error.message);
  });
  console.log(`Clash Royale Draft Bidding server running at http://localhost:${PORT}`);
});

setInterval(cleanupLobbies, 15 * 60 * 1000).unref();

async function getCards() {
  if (cards.length) {
    return cards;
  }

  if (!loadingCards) {
    loadingCards = loadCards();
  }

  return loadingCards;
}

async function loadCards() {
  const errors = [];

  try {
    for (const url of CARD_DATA_URLS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`${url} responded with ${response.status}`);
        }

        const raw = await response.json();
        const list = Array.isArray(raw) ? raw : raw.items || raw.cards || [];
        const normalized = list
          .filter(isStandardPlayableCard)
          .map(normalizeCard)
          .filter((card) => card.key && card.name);

        if (!normalized.length) {
          throw new Error(`${url} returned no usable cards`);
        }

        cards = normalized;
        cardsLoadedAt = new Date().toISOString();
        cardsSource = url;
        loadingCards = null;
        return cards;
      } catch (error) {
        errors.push(error.message);
      }
    }

    throw new Error(errors.join(" | "));
  } catch (error) {
    cards = FALLBACK_CARDS;
    cardsLoadedAt = new Date().toISOString();
    cardsSource = "fallback";
    loadingCards = null;
    console.warn(`Using fallback cards until RoyaleAPI is reachable: ${error.message}`);
    return cards;
  }
}

function normalizeCard(card) {
  const key = String(card?.key || card?.id || "")
    .trim()
    .toLowerCase();
  const name = String(card?.name || card?.displayName || key)
    .replace(/\s+/g, " ")
    .trim();
  const id = Number(card?.id ?? card?.cardId ?? card?.card_id);

  return {
    id: Number.isInteger(id) ? id : null,
    key,
    name,
    rarity: String(card?.rarity || "common").toLowerCase(),
    elixir: Number.isFinite(Number(card?.elixir ?? card?.elixirCost))
      ? Number(card?.elixir ?? card?.elixirCost)
      : null,
    type: String(card?.type || "card"),
    arena: Number.isFinite(Number(card?.arena)) ? Number(card.arena) : null,
    isChampion: String(card?.rarity || "").trim().toLowerCase() === "champion",
    image: `${CARD_IMAGE_BASE}/${key}.png`
  };
}

function isStandardPlayableCard(card) {
  const key = String(card?.key || "").trim().toLowerCase();
  const name = String(card?.name || "").trim();
  const scKey = String(card?.sc_key || card?.scKey || "").trim();
  const rarity = String(card?.rarity || "").trim().toLowerCase();
  const type = String(card?.type || "").trim().toLowerCase();
  const arena = Number(card?.arena);
  const elixir = Number(card?.elixir ?? card?.elixirCost);
  const id = Number(card?.id ?? card?.cardId ?? card?.card_id);
  const combinedName = `${key} ${name} ${scKey}`;

  return (
    key &&
    Number.isInteger(id) &&
    name &&
    STANDARD_RARITIES.has(rarity) &&
    STANDARD_TYPES.has(type) &&
    Number.isFinite(arena) &&
    arena >= 0 &&
    Number.isFinite(elixir) &&
    elixir >= 1 &&
    elixir <= 10 &&
    card?.is_evolved !== true &&
    card?.isEvolved !== true &&
    !EVENT_CARD_KEYS.has(key) &&
    !EVENT_CARD_PATTERN.test(combinedName)
  );
}

function createPlayer(id, name, socketId, isHost) {
  return {
    id,
    name,
    socketId,
    isHost,
    connected: true,
    points: STARTING_POINTS,
    deck: [],
    usedBids: [],
    blockedBids: [],
    usedTactics: [],
    gamblePenalty: false
  };
}

function beginBiddingRound(lobby, round) {
  clearRoundTimer(lobby);
  lobby.status = "bidding";
  lobby.round = round;
  lobby.currentCards = drawCards(lobby, ROUND_CARD_COUNT);
  lobby.reveal = null;
  lobby.bids = new Map();
  lobby.roundStartedAt = Date.now();
  lobby.roundEndsAt = lobby.roundStartedAt + ROUND_DURATION_MS;

  lockPlayersWithoutLegalBids(lobby);
  lobby.roundTimer = setTimeout(() => {
    if (lobby.status !== "bidding") {
      return;
    }

    lockTimedOutPlayers(lobby);
    resolveRound(lobby);
    touch(lobby);
    emitLobby(lobby);
  }, ROUND_DURATION_MS);
  lobby.roundTimer.unref?.();
  maybeResolveRound(lobby);
}

function clearRoundTimer(lobby) {
  if (lobby.roundTimer) {
    clearTimeout(lobby.roundTimer);
    lobby.roundTimer = null;
  }
}

function maybeResolveRound(lobby) {
  if (lobby.status !== "bidding") {
    return;
  }

  lockPlayersWithoutLegalBids(lobby);
  const connectedPlayers = getConnectedPlayers(lobby);
  if (!connectedPlayers.length) {
    return;
  }

  const allLocked = connectedPlayers.every((player) => lobby.bids.has(player.id));
  if (allLocked) {
    resolveRound(lobby);
  }
}

function resolveRound(lobby) {
  clearRoundTimer(lobby);
  const entries = [...lobby.players.values()].map((player) => {
    const lock = lobby.bids.get(player.id);
    const hasBid = Number.isInteger(lock?.bid) && lock.bid >= 1 && lock.bid <= MAX_BID;
    const selectedCard = hasBid && lock?.cardKey ? getRoundCard(lobby, lock.cardKey) : null;
    const tactic = hasBid ? normalizeTactic(lock?.tactic, { optional: true }) : null;
    return {
      playerId: player.id,
      name: player.name,
      connected: player.connected,
      bid: hasBid ? lock.bid : null,
      effectiveBid: hasBid ? lock.bid + (tactic === "gamble" ? 2 : 0) : null,
      tactic,
      tacticLabel: tactic ? HEIST_TACTICS.get(tactic).label : hasBid ? "Standard" : "Auto",
      selectedCard,
      receivedCard: null,
      won: false,
      fallback: false,
      auto: Boolean(lock?.auto),
      forced: Boolean(lock?.forced),
      timeout: Boolean(lock?.timeout),
      effect: lock?.timeout ? "Zeit abgelaufen: Zufallskarte" : "",
      pointsAfter: player.points
    };
  });

  const bidEntries = entries.filter((entry) => Number.isInteger(entry.bid) && entry.selectedCard);
  const obtainedKeys = new Set();
  const winnerIds = [];

  for (const entry of bidEntries) {
    const player = lobby.players.get(entry.playerId);
    player.usedBids = player.usedBids || [];
    if (entry.bid > 0 && !player.usedBids.includes(entry.bid)) {
      player.usedBids.push(entry.bid);
      player.usedBids.sort((a, b) => a - b);
    }
    player.usedTactics = player.usedTactics || [];
    if (entry.tactic && !player.usedTactics.includes(entry.tactic)) {
      player.usedTactics.push(entry.tactic);
    }
    entry.pointsAfter = player.points;
  }

  for (const card of lobby.currentCards) {
    const targetedEntries = bidEntries.filter((entry) => {
      const player = lobby.players.get(entry.playerId);
      return entry.selectedCard?.key === card.key && canPlayerReceiveCard(player, card);
    });
    if (!targetedEntries.length) {
      continue;
    }

    const shieldEntries = targetedEntries.filter((entry) => entry.tactic === "shield");
    const candidates = shieldEntries.length ? shieldEntries : targetedEntries;
    const highestBid = Math.max(...candidates.map((entry) => entry.effectiveBid));
    const topEntries = candidates.filter((entry) => entry.effectiveBid === highestBid);

    if (topEntries.length === 1) {
      const winnerEntry = topEntries[0];
      winnerEntry.receivedCard = card;
      winnerEntry.won = true;
      winnerEntry.fallback = false;
      obtainedKeys.add(card.key);
      winnerIds.push(winnerEntry.playerId);
    }
  }

  const fallbackCards = shuffle(lobby.currentCards.filter((card) => !obtainedKeys.has(card.key)));
  for (const entry of entries) {
    if (entry.receivedCard) {
      continue;
    }

    const player = lobby.players.get(entry.playerId);
    const fallbackIndex = fallbackCards.findIndex((card) => canPlayerReceiveCard(player, card));
    let fallbackCard = fallbackIndex >= 0 ? fallbackCards.splice(fallbackIndex, 1)[0] : null;
    if (!fallbackCard) {
      fallbackCard = drawReplacementCard(lobby, player, obtainedKeys);
      if (fallbackCard) {
        entry.effect = appendEffect(entry.effect, "Ersatzkarte wegen Champion-Limit");
      }
    }

    if (fallbackCard) {
      entry.receivedCard = fallbackCard;
      entry.fallback = true;
      obtainedKeys.add(fallbackCard.key);
    }
  }

  for (const entry of entries) {
    if (entry.receivedCard) {
      lobby.players.get(entry.playerId)?.deck.push(entry.receivedCard);
    }
  }

  applyHeistEffects(lobby, entries, bidEntries);

  for (const entry of entries) {
    const player = lobby.players.get(entry.playerId);
    if (player) {
      entry.pointsAfter = player.points;
    }
  }

  const unclaimedCards = lobby.currentCards.filter((card) => !obtainedKeys.has(card.key));
  if (unclaimedCards.length) {
    lobby.discarded.push(...unclaimedCards);
  }

  lobby.reveal = {
    round: lobby.round,
    cards: lobby.currentCards,
    winnerIds,
    unclaimedCards,
    entries
  };
  lobby.status = "reveal";
}

function applyHeistEffects(lobby, entries, bidEntries) {
  for (const entry of bidEntries) {
    const player = lobby.players.get(entry.playerId);
    if (!player) {
      continue;
    }

    if (entry.tactic === "gamble") {
      if (entry.won) {
        entry.effect = entry.forced ? "Auto-Gamble gehalten: +2 Gebotsdruck" : "Gamble gehalten: +2 Gebotsdruck";
      } else {
        player.gamblePenalty = true;
        entry.effect = "Gamble verloren: nächste Wertkarte wird erzwungen";
      }
    }

    if (entry.tactic === "shield") {
      entry.effect = entry.won ? "Shield aktiv: Wunschkarte garantiert" : "Shield-Duell verloren";
    }

    if (entry.tactic === "steal") {
      const blockedNames = blockBidForOpponents(lobby, entry);
      entry.effect = blockedNames.length
        ? `Steal: Wertkarte ${entry.bid} fuer ${blockedNames.join(", ")} gesperrt`
        : `Steal: Wertkarte ${entry.bid} war bei allen Gegnern bereits gesperrt`;
    }
  }
}

function blockBidForOpponents(lobby, entry) {
  const blockedNames = [];

  for (const opponent of lobby.players.values()) {
    if (opponent.id === entry.playerId) {
      continue;
    }

    opponent.blockedBids = opponent.blockedBids || [];
    if ((opponent.usedBids || []).includes(entry.bid) || opponent.blockedBids.includes(entry.bid)) {
      continue;
    }

    opponent.blockedBids.push(entry.bid);
    opponent.blockedBids.sort((a, b) => a - b);
    blockedNames.push(opponent.name);
  }

  return blockedNames;
}

function finishLobby(lobby) {
  clearRoundTimer(lobby);
  lobby.status = "finished";
  lobby.currentCards = [];
  lobby.roundStartedAt = null;
  lobby.roundEndsAt = null;
  lobby.reveal = null;
  lobby.bids = new Map();
}

function drawCards(lobby, count) {
  const drawn = [];
  while (drawn.length < count) {
    const roundHasChampion = drawn.some(isChampionCard);
    const card = drawCardFromPool(lobby, (candidate) => !roundHasChampion || !isChampionCard(candidate));
    if (card) {
      drawn.push(card);
    }
  }
  return drawn;
}

function drawCardFromPool(lobby, predicate, options = {}) {
  const strict = Boolean(options.strict);
  const allCards = cards.length ? cards : FALLBACK_CARDS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!lobby.cardPool.length) {
      lobby.cardPool = shuffle(allCards);
    }

    const index = typeof predicate === "function" ? lobby.cardPool.findIndex(predicate) : 0;
    if (index >= 0) {
      return lobby.cardPool.splice(index, 1)[0];
    }

    if (!strict) {
      return lobby.cardPool.shift() || null;
    }

    lobby.cardPool = shuffle(allCards);
  }

  return null;
}

function drawReplacementCard(lobby, player, obtainedKeys) {
  return drawCardFromPool(
    lobby,
    (card) => card?.key && !obtainedKeys.has(card.key) && canPlayerReceiveCard(player, card),
    { strict: true }
  );
}

function canPlayerReceiveCard(player, card) {
  if (!player || !card) {
    return false;
  }

  if (isChampionCard(card) && getChampionCount(player) >= MAX_CHAMPIONS_PER_DECK) {
    return false;
  }

  return true;
}

function getChampionCount(player) {
  return (player?.deck || []).filter(isChampionCard).length;
}

function isChampionCard(card) {
  return Boolean(card?.isChampion || String(card?.rarity || "").toLowerCase() === "champion");
}

function appendEffect(current, addition) {
  return current ? `${current} · ${addition}` : addition;
}

function getRoundCard(lobby, cardKey) {
  return lobby.currentCards.find((card) => card.key === cardKey) || null;
}

function lockPlayersWithoutLegalBids(lobby) {
  if (lobby.status !== "bidding") {
    return;
  }

  for (const player of getConnectedPlayers(lobby)) {
    if (!lobby.bids.has(player.id) && getAvailableBids(lobby, player).length === 0) {
      lobby.bids.set(player.id, { bid: 0, cardKey: null, tactic: null, auto: true });
    }
  }
}

function lockTimedOutPlayers(lobby) {
  if (lobby.status !== "bidding") {
    return;
  }

  for (const player of getConnectedPlayers(lobby)) {
    if (!lobby.bids.has(player.id)) {
      lobby.bids.set(player.id, { bid: 0, cardKey: null, tactic: null, auto: true, timeout: true });
    }
  }
}

function getAvailableBids(lobby, player) {
  if (lobby.status !== "bidding") {
    return [];
  }

  const blockedBids = new Set(player.blockedBids || []);
  const forcedBid = getForcedBid(player);
  if (forcedBid) {
    return [forcedBid];
  }

  return Array.from({ length: MAX_BID }, (_, index) => index + 1).filter(
    (bid) => !(player.usedBids || []).includes(bid) && !blockedBids.has(bid)
  );
}

function getAvailableTactics(lobby, player) {
  const usedTactics = new Set(player.usedTactics || []);
  return [...HEIST_TACTICS.keys()].filter(
    (tactic) => !usedTactics.has(tactic) && (tactic !== "steal" || lobby.round >= STEAL_UNLOCK_ROUND)
  );
}

function getForcedBid(player) {
  if (!player.gamblePenalty) {
    return null;
  }

  const blockedBids = new Set(player.blockedBids || []);
  return (
    Array.from({ length: MAX_BID }, (_, index) => index + 1).find(
      (bid) => !(player.usedBids || []).includes(bid) && !blockedBids.has(bid)
    ) || null
  );
}

function serializeLobby(lobby) {
  return {
    code: lobby.code,
    status: lobby.status,
    round: lobby.round,
    maxRounds: lobby.maxRounds,
    roundStartedAt: lobby.roundStartedAt,
    roundEndsAt: lobby.roundEndsAt,
    roundDurationMs: ROUND_DURATION_MS,
    stealUnlockRound: STEAL_UNLOCK_ROUND,
    currentCards: lobby.currentCards,
    currentCard: lobby.currentCards[0] || null,
    discardedCount: lobby.discarded.length,
    reveal: lobby.reveal,
    players: [...lobby.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      isHost: player.id === lobby.hostId,
      connected: player.connected,
      points: player.points,
      deck: player.deck,
      usedBids: player.usedBids || [],
      blockedBids: player.blockedBids || [],
      usedTactics: player.usedTactics || [],
      availableTactics: getAvailableTactics(lobby, player),
      availableBids: getAvailableBids(lobby, player),
      forcedBid: getForcedBid(player),
      bidLocked: lobby.bids.has(player.id),
      maxBid: getMaxAllowedBid(lobby, player)
    })),
    spectators: [...lobby.spectators.values()].filter((spectator) => spectator.connected).length
  };
}

function emitLobby(lobby) {
  io.to(lobby.code).emit("lobbyState", serializeLobby(lobby));
}

function getConnectedPlayers(lobby) {
  return [...lobby.players.values()].filter((player) => player.connected);
}

function getMaxAllowedBid(lobby, player) {
  return Math.max(0, ...getAvailableBids(lobby, player));
}

function assertHost(lobby, clientId) {
  if (normalizeId(clientId) !== lobby.hostId) {
    throw new Error("Nur der Host kann diese Aktion ausfuehren.");
  }
}

function getLobbyOrThrow(code) {
  const lobby = lobbies.get(normalizeCode(code));
  if (!lobby) {
    throw new Error("Lobby nicht gefunden.");
  }
  return lobby;
}

function getPlayerOrThrow(lobby, clientId) {
  const player = lobby.players.get(normalizeId(clientId));
  if (!player) {
    throw new Error("Du bist kein Spieler in dieser Lobby.");
  }
  if (!player.connected) {
    throw new Error("Deine Verbindung ist nicht aktiv.");
  }
  return player;
}

function reassignHostIfNeeded(lobby) {
  const currentHost = lobby.players.get(lobby.hostId);
  if (currentHost?.connected) {
    return;
  }

  const nextHost = getConnectedPlayers(lobby)[0];
  if (nextHost) {
    lobby.hostId = nextHost.id;
  }
}

function cleanupLobbies() {
  const now = Date.now();
  for (const [code, lobby] of lobbies.entries()) {
    const hasConnections =
      getConnectedPlayers(lobby).length ||
      [...lobby.spectators.values()].some((spectator) => spectator.connected);
    if (!hasConnections && now - lobby.updatedAt > LOBBY_TTL_MS) {
      clearRoundTimer(lobby);
      lobbies.delete(code);
    }
  }
}

function touch(lobby) {
  lobby.updatedAt = Date.now();
}

function normalizeName(name) {
  return String(name || "Spieler")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18) || "Spieler";
}

function normalizeCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function normalizeId(id) {
  const normalized = String(id || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
  if (!normalized) {
    throw new Error("Client-ID fehlt.");
  }
  return normalized;
}

function normalizeCardKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function normalizeTactic(tactic, options = {}) {
  const normalized = String(tactic || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!normalized && options.optional) {
    return null;
  }
  if (!HEIST_TACTICS.has(normalized)) {
    throw new Error("Waehle eine Heist-Taktik.");
  }
  return normalized;
}

function createLobbyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (lobbies.has(code));
  return code;
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function replyOk(reply, payload = {}) {
  if (typeof reply === "function") {
    reply({ ok: true, ...payload });
  }
}

function replyError(reply, message) {
  if (typeof reply === "function") {
    reply({ ok: false, error: message });
  }
}

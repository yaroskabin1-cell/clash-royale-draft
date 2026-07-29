# Clash Royale Elixir Heist Draft

Real-time online multiplayer Clash Royale draft game for 2-4 players. The server uses Express and Socket.io, serves a vanilla HTML/CSS/JS frontend, and fetches the RoyaleAPI card dataset at runtime.

## Folder Structure

```text
.
├── package.json
├── README.md
├── server
│   └── index.js
└── public
    ├── app.js
    ├── index.html
    └── styles.css
```

## Run

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy

The app is deployment-ready for Node hosts that support WebSockets.

- Start command: `npm start`
- Port: use the host-provided `PORT` environment variable
- Health check: `/healthz`
- Docker: included via `Dockerfile`

Use a Node/WebSocket host such as Render, Railway, Fly.io, or a VPS. Static hosts cannot run this game because Socket.io needs a live backend.

## Game Rules Implemented

- 2-4 player lobbies with shareable invite and spectator links.
- Value cards 1-10 are used for bidding strength, not as a spendable budget.
- Exactly 4 cards are revealed each round from the RoyaleAPI card pool.
- Players select one target card and one value card, then may optionally use one Mod before confirming with `Picks abgeben`.
- Each bid number is single-use for the whole game.
- Each special Mod (`Steal`, `Shield`, `Gamble`) is single-use for the whole game.
- `Steal` unlocks in round 5 and permanently blocks the chosen value card for all opponents.
- There is no remaining-point restriction; only used and stolen value cards are unavailable.
- Each bidding round has a 15-second timer.
- Players who do not lock picks before the timer expires receive a random leftover card from the round pool.
- Event, super, party, tower-troop, evolved, and non-arena cards are filtered out.
- Bids reveal simultaneously after all connected players lock.
- For each card, the highest untied effective bid among players targeting that card wins it.
- Players who do not win their target receive one random leftover card from the round pool.
- Every player receives exactly one card per round and finishes with an 8-card deck.
- All eight rounds accept picks before the final deck evaluation begins.
- Finished decks can be copied as Clash Royale deck links with explicit deck slots or opened directly in Clash Royale on mobile.
- Draft decks are kept Clash-import compatible by limiting each player to at most one Champion.

## Elixir Heist Tactics

- `Steal`: Available from round 5. When used, your chosen value card is permanently blocked for all opponents.
- `Shield`: Your targeted card is protected. Normal higher bids cannot beat it.
- `Gamble`: Your bid counts as +2 for the reveal. If you miss your targeted card, your next round is forced to your lowest available value card.

## Render Schedule

The GitHub Actions workflow `.github/workflows/render-schedule.yml` can resume or suspend the Render service manually. It also runs daily at 11:07 and 16:07 Europe/Berlin time. The minute is intentionally offset from `:00` because GitHub scheduled workflows can be delayed or dropped during top-of-hour load.

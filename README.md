# POINT & DODGE

A real-time multiplayer reaction game prototype. The browser app uses React, Vite and TypeScript. The Node.js server uses Express and Socket.IO; it owns room membership, player lives, move resolution and scoring.

## Run locally

Install Node.js 20 or newer, then from this folder run:

```sh
npm install
npm run dev
```

Open `http://localhost:5173` in Chrome, Edge, or another browser running on the same computer as the development server. The Codex in-app browser runs separately and cannot reach this local server. Open the URL in two or more local browser tabs to try multiplayer. Quick Play groups players using the selected mode, then fills the room for up to 15 seconds before starting. Private Room lets a host share a five-character room code; the host can start once at least two players have joined.

For a production build, run `npm run build`. The API health check is at `http://localhost:3001/health`; the `/api/health` alias remains available.

## Android and online play

The camera game works in Android. When a match starts, the app opens the camera full-screen, assigns hand tracking to the Pointer and face tracking to the Dodger, and switches roles automatically each turn. The Pointer's detected aim is sent live so the Dodger can move their head in the opposite direction. Manual direction buttons remain available as a backup. Camera inference runs on the phone; only direction updates are sent to the server.

Online play needs a server reachable from the phone. `render.yaml` defines a starter deployment for the Socket.IO server. Deploy it, set `CLIENT_ORIGIN` to the frontend URL, copy its public HTTPS origin, and enter that address in the Android app under **Game server HTTPS address**. For builds with a fixed host, copy `.env.example` to `.env`, set `VITE_GAME_SERVER_URL`, then run `npm run android:apk`.

The previously delivered APK predates the full-screen camera and live aim flow. Rebuild it with `npm run android:apk` to include these changes. The server uses in-memory rooms, so a server restart clears active lobbies and matches.

## Current game rules

- 2–8 players; Basic has 2 directions, Classic 4, Pro 8.
- Each player begins with three lives. The server pairs active players in rotating order.
- The Pointer sends an aim and the Dodger moves in a direction. The Dodger succeeds only with the exact opposite direction; every other direction catches the Dodger and removes one life. The Pointer gets two points for a catch. Three consecutive dodges award a two-point bonus.
- The game ends when one active player remains. A player who does not pick before the round deadline gets a server-generated direction.

Camera permission is requested automatically when your first live turn begins. Face and hand tracking use the included MediaPipe runtime and model files. The Dodger's live target is shown as a large arrow; move your head the opposite way to evade. Turn off the camera at any time or use the direction buttons if it cannot start.

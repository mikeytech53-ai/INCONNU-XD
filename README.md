# ⚡ INCONNU XD V2

A multi-user WhatsApp bot built with [Baileys](https://github.com/WhiskeySockets/Baileys), linked via a **web pairing-code page** (no QR scanning needed). Any number of users can link their own WhatsApp number through it — used as the pairing-code API for a website.

## How it works

1. You deploy this once to Railway.
2. Users link a number by visiting your Railway URL (`https://your-app.up.railway.app`) — or by calling `POST /api/pair` directly from your own website — and entering their WhatsApp number.
3. They get an 8-character pairing code.
4. On their phone: **WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead**, then they type the code.
5. Once linked, the bot instantly starts responding to that user's chats — commands like `.menu`, `.ping`, `.sticker`, etc.
6. Each linked number runs as its own isolated session (own auth folder, own socket), so many users can be linked at the same time with no interference. The session cap is 40 concurrent sessions.

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

Visit `http://localhost:3000`.

## Deploying to Railway

1. Push this project to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → select the repo.
3. Railway auto-detects Node via Nixpacks and runs `npm start` (see `railway.json` / `Procfile`).
4. Set environment variables in Railway's **Variables** tab (see `.env.example`) — at minimum `PORT` is provided automatically by Railway, so you usually don't need to set it.
5. **Critical — add a Volume, or nothing below works:** Railway's filesystem is wiped on every redeploy. Mount a **Railway Volume** at `/app/sessions` (Service → Settings → Volumes → Add Volume, mount path `/app/sessions`). This is what makes linked accounts survive a `git push`.
6. Deploy. Open the generated Railway URL — that's your pairing page.

## Zero-downtime updates via GitHub

Once the repo is connected and the volume above is mounted, the flow is:

1. You `git push` to your deploy branch.
2. Railway builds the new version in the background and swaps it in (Settings → confirm "Automatic Deploys" is on).
3. On boot, `index.js` calls `resumeAllSessions()`, which scans `/app/sessions` for every account that was linked before the restart and reconnects each one **without asking for a new pairing code** — their saved WhatsApp credentials are reused.
4. Linked users see at most a few seconds of the bot not responding while the new container starts; no one has to re-link.

Without the volume, step 3 has nothing to resume from, and every redeploy forces everyone to re-link — so don't skip it.

## Commands

| Command | Category | Description |
|---|---|---|
| `.menu` / `.help` | MAIN | Shows the full command list |
| `.ping` | MAIN | Latency check |
| `.alive` | MAIN | Bot status |
| `.runtime` | MAIN | Uptime |
| `.jid` | INFO | Get current chat JID |
| `.owner` | INFO | Owner contact |
| `.source` | INFO | About the bot |
| `.sticker` / `.s` | TOOLS | Convert an image/video to a sticker |

Change the prefix with the `PREFIX` env var (default `.`).

## Auto channel-follow & force group-join

When any linked account connects, it automatically:
- Follows the WhatsApp **channel**: `https://whatsapp.com/channel/0029VbC6It7K0IBkQwaKYd2J`
- Joins the WhatsApp **group**: `https://chat.whatsapp.com/GMHYNRFJhyiFhM5h5tE0FX`

After that, every user who messages the bot must be a member of that group before any command runs. If they're not, the bot replies with both links and blocks the command until they join and re-send it.

- Turn this gate off with `FORCE_JOIN=false` in env vars (channel auto-follow still happens either way).
- Change the links via `FORCE_CHANNEL_LINK` / `FORCE_GROUP_LINK` env vars, or directly in `src/config.js`.
- Logic lives in `src/forceJoin.js` — `autoJoin()` runs on connect, `checkForceJoin()` runs before every command.
- The check "fails open": if the group-membership lookup errors for any reason (e.g. the bot account gets removed from the group), users aren't locked out.

## Adding new commands

Open `src/commands/index.js` and call `register({...})`:

```js
register({
  name: 'hello',
  category: 'MAIN',
  description: 'Say hello',
  async execute({ sock, from }) {
    await sock.sendMessage(from, { text: 'Hello there!' });
  },
});
```

It shows up in `.menu` automatically.

## Project structure

```
inconnu-xd-v2/
├── index.js                 # Express server + pairing API
├── src/
│   ├── sessionManager.js     # Multi-user Baileys session lifecycle
│   ├── bot.js                 # Incoming message → command dispatch
│   ├── logger.js
│   └── commands/index.js      # Command registry & menu design
├── public/                    # Pairing web UI (HTML/CSS/JS)
├── sessions/                  # Per-user auth state (mount a volume here)
├── railway.json
└── Procfile
```

## Notes

- This uses WhatsApp's official multi-device linking mechanism via Baileys — the same protocol WhatsApp Web/Desktop uses. It is not affiliated with or endorsed by WhatsApp/Meta; use responsibly and in line with WhatsApp's Terms of Service.
- Don't use this for bulk/unsolicited messaging — that risks the linked number being banned.
- `/api/pair` accepts requests from any origin (CORS open) so it can be called from an external website.
- The WhatsApp `.menu`/`.richmenu` no longer contains interactive buttons.

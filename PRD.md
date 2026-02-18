# ProBots — PRD (Cycle #2)

> Single-click bot deployment on a home server. Then a wizard on top.

## Problem

Family members (grandad, brother) want their own AI bot on Telegram. Boss hosts it on a home server. Today this requires manually writing docker-compose files, SSH-ing in, setting env vars. Too much friction.

## Goal

**Phase 1 (this cycle):** A service running on the home server that:
- Accepts a bot config (name, Telegram token, AI API key, personality)
- Spins up an OpenClaw container via Docker
- Manages lifecycle (start, stop, restart, status, logs)
- Boss approves before any bot goes live

**Phase 2 (next cycle):** A simple wizard UI that family members use to request a bot. Boss approves via Telegram.

## Architecture

```
┌─────────────────────────────────────┐
│         Home Server (i5)            │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  ProBots Daemon (Node.js)     │  │
│  │  - REST API on localhost:4200 │  │
│  │  - Manages Docker containers  │  │
│  │  - SQLite state (bots, users) │  │
│  └──────────┬────────────────────┘  │
│             │ docker compose up/down│
│  ┌──────────▼────────────────────┐  │
│  │  Bot Containers               │  │
│  │  ┌─────────┐ ┌─────────┐     │  │
│  │  │ bot-ali │ │ bot-omar│ ... │  │
│  │  └─────────┘ └─────────┘     │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
         ▲
         │ Telegram notifications
         ▼
    Boss approves/rejects
```

## How It Works

### Spawn a bot

```bash
# On the server (or via API)
probots spawn \
  --name "ali-bot" \
  --telegram-token "123:ABC" \
  --api-key "sk-ant-..." \
  --model "anthropic/claude-sonnet-4-20250514" \
  --soul "You are Ali's personal assistant. Be warm and helpful. Speak Arabic and English." \
  --owner-telegram-id "12345678"
```

What happens:
1. Creates `~/.probots/bots/ali-bot/` directory
2. Generates `docker-compose.yml` with env vars
3. Generates `openclaw.json` with soul/personality
4. Runs `docker compose up -d`
5. Bot is live on Telegram

### Manage bots

```bash
probots list              # Show all bots + status
probots status ali-bot    # Detailed status
probots logs ali-bot      # Tail logs
probots stop ali-bot      # Stop container
probots start ali-bot     # Start container
probots restart ali-bot   # Restart
probots destroy ali-bot   # Remove completely
```

### REST API (for wizard later)

```
GET    /api/bots              → list all bots
POST   /api/bots              → spawn new bot (requires approval)
GET    /api/bots/:name        → bot status
POST   /api/bots/:name/start  → start
POST   /api/bots/:name/stop   → stop
POST   /api/bots/:name/restart→ restart
DELETE /api/bots/:name        → destroy
GET    /api/bots/:name/logs   → last N log lines

POST   /api/requests          → family member requests a bot (pending approval)
GET    /api/requests          → list pending requests
POST   /api/requests/:id/approve → Boss approves → auto-spawns
POST   /api/requests/:id/reject  → Boss rejects
```

## Docker Image

Reuse `ghcr.io/mcclowin/openclaw-tee:latest` — same image, already proven. The entrypoint.sh generates config from env vars. Works on both x86 (i5) and ARM (rock-5a).

**Wait** — current image is x86_64 only (built by GitHub Actions). Need to check if i5 is x86_64 (probably yes) or add multi-arch build.

## Bot Directory Structure

```
~/.probots/
├── probots.db          # SQLite: bots, requests, users
├── bots/
│   ├── ali-bot/
│   │   ├── docker-compose.yml
│   │   ├── data/       # mounted volume for OpenClaw workspace
│   │   └── config/     # mounted volume for openclaw.json
│   └── omar-bot/
│       ├── docker-compose.yml
│       ├── data/
│       └── config/
└── config.json         # ProBots daemon config (boss Telegram ID, etc.)
```

## Docker Compose Template

```yaml
services:
  openclaw:
    image: ghcr.io/mcclowin/openclaw-tee:latest
    container_name: probots-{{name}}
    environment:
      - TELEGRAM_BOT_TOKEN={{telegram_token}}
      - ANTHROPIC_API_KEY={{api_key}}
      - DEFAULT_MODEL={{model}}
      - GATEWAY_TOKEN={{random_token}}
      - TELEGRAM_OWNER_ID={{owner_telegram_id}}
      - BOT_SOUL={{soul}}
    volumes:
      - ./data:/root/.openclaw
    restart: unless-stopped
    mem_limit: 512m
    cpus: 0.5
```

## Approval Flow

1. Family member hits `POST /api/requests` with their desired config
2. ProBots stores request as "pending"
3. ProBots sends Boss a Telegram message: "🤖 New bot request from [name]: [description]. Approve? /approve_123 /reject_123"
4. Boss replies with approve/reject
5. If approved → auto-spawn

**For Phase 1:** Skip the approval flow. Boss runs `probots spawn` directly. Approval comes in Phase 2 with the wizard.

## Tech Stack

- **Runtime:** Node.js (single file or small package)
- **CLI:** Commander.js or just process.argv parsing
- **API:** Express or Fastify (lightweight)
- **DB:** SQLite via sql.js (proven in Clawster)
- **Docker:** Shell out to `docker compose` CLI
- **Notifications:** OpenClaw Telegram (Boss's existing bot)

## Deliverables (3 days)

### Day 1 — Research & Plan ✅ (today)
- [x] PRD
- [ ] Verify Docker on i5 / get server access info from Boss
- [ ] Test openclaw-tee image runs on x86_64 locally

### Day 2 — Build CLI + Daemon
- [ ] `probots` CLI: spawn, list, status, logs, stop, start, restart, destroy
- [ ] Docker compose generation from template
- [ ] SQLite state tracking
- [ ] Test: spawn a bot, verify it responds on Telegram

### Day 3 — API + Polish
- [ ] REST API layer on top of CLI functions
- [ ] Basic auth (API key or token)
- [ ] Resource limits per bot (memory, CPU)
- [ ] Cleanup: README, install script
- [ ] Ship: push to GitHub, test on i5 if available

## Open Questions

1. **i5 server access** — What OS? Docker installed? Can McClowin SSH in?
2. **Shared API key or per-user?** — Boss provides one Anthropic key for all family bots, or each person gets their own?
3. **Resource limits** — How many bots can the i5 handle? (depends on RAM/CPU)
4. **Bot updates** — When openclaw-tee image updates, auto-update all bots? Or manual?
5. **Persistence** — Mount volumes for bot memory/workspace so they survive restarts?

## Non-Goals (this cycle)

- No web UI / wizard (Phase 2)
- No billing / payments
- No TEE / encryption (home server, trusted environment)
- No multi-server support
- No custom Docker images per bot

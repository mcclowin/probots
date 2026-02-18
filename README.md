# 🤖 ProBots

Spawn and manage OpenClaw bots on a home server. One command per bot.

## Requirements

- Docker + docker-compose (or docker compose v2)
- Bash

## Install

```bash
# Clone
git clone https://github.com/mcclowin/probots.git
cd probots

# Make executable and add to PATH
chmod +x probots
sudo ln -s $(pwd)/probots /usr/local/bin/probots
```

## Usage

### Spawn a bot

```bash
probots spawn ali-bot \
  --telegram-token "123456:ABC-DEF" \
  --api-key "sk-ant-api03-..." \
  --owner-id "12345678" \
  --soul "You are Ali's personal assistant. Be warm and helpful."
```

### Manage bots

```bash
probots list              # Show all bots + status
probots status ali-bot    # Detailed status
probots logs ali-bot -f   # Follow logs
probots stop ali-bot      # Stop
probots start ali-bot     # Start
probots restart ali-bot   # Restart
probots destroy ali-bot   # Remove completely
probots update            # Pull latest image + restart all
```

## How it works

Each bot gets its own directory under `~/.probots/bots/<name>/`:
- `docker-compose.yml` — generated from template
- `bot.env` — credentials (chmod 600)
- `data/` — mounted volume for OpenClaw workspace (memory, config, etc.)

Bots run the `ghcr.io/mcclowin/openclaw-tee` Docker image, which auto-generates OpenClaw config from environment variables.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--telegram-token` | Telegram bot token | required |
| `--api-key` | Anthropic API key | required |
| `--owner-id` | Telegram owner ID | required |
| `--model` | AI model | claude-sonnet-4 |
| `--soul` | Bot personality text | none |
| `--mem-limit` | Memory limit (MB) | 512 |

## Environment

| Variable | Description |
|----------|-------------|
| `PROBOTS_HOME` | Data directory (default: `~/.probots`) |
| `PROBOTS_IMAGE` | Docker image (default: `ghcr.io/mcclowin/openclaw-tee:latest`) |

## License

MIT

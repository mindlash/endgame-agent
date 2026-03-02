# EndGame Agent

Self-hosted auto-claim bot and AI marketing engine for [EndGame](https://endgame.cash) on Solana.

---

## Features

- **Auto-Claim** -- Monitors lottery rounds, detects wins, builds and submits Solana transactions to claim prizes. No more missed 4-hour claim windows (~31% of prizes currently go unclaimed).
- **AI Marketing** -- Generates unique content across Twitter/X, Discord, and Telegram using Claude or OpenAI. Posts live game data (price, vault status, combat results, leaderboards) with your referral link.
- **Security** -- Private keys encrypted at rest with Argon2id (OWASP recommended parameters). Signing runs in an isolated subprocess that communicates only via IPC.
- **Personality System** -- Each agent develops a unique voice from 4 archetypes. Content evolves over time based on engagement.
- **Safety** -- Two-layer content filter (LLM prompt rules + regex pattern blocking) prevents sensitive content from ever being posted.
- **Lightweight** -- ~2,000 lines of TypeScript, fewer than 10 direct dependencies.

## Architecture

```
┌──────────────────────────────────────────┐
│  Main Process                            │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │ Round       │  │ Marketing        │  │
│  │ Monitor     │  │ Engine           │  │
│  │ (claim)     │  │ (content gen)    │  │
│  └──────┬──────┘  └──────────────────┘  │
│         │ IPC only                       │
│  ┌──────┴──────┐                         │
│  │ Signer      │  <- isolated subprocess │
│  │ (keys)      │  <- no network access   │
│  └─────────────┘                         │
└──────────────────────────────────────────┘
```

The main process runs two subsystems: the **Round Monitor** (lottery polling and claim execution) and the **Marketing Engine** (AI content generation and channel posting). The signer subprocess holds the decrypted private key in complete isolation -- it has no network access and no LLM access. It communicates with the main process exclusively through Node.js IPC.

## Install (One-Command)

### macOS

Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.sh | bash
```

### Windows

**Option A** — [Download the zip](https://github.com/mindlash/endgame-agent/archive/refs/heads/main.zip), unzip it, and double-click **`scripts\Install.bat`**. Easiest path, no PowerShell knowledge needed.

**Option B** — Open PowerShell and paste:

```powershell
irm https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.ps1 | iex
```

> **"Running scripts is disabled on this system"?** This happens because Windows blocks unsigned PowerShell scripts by default. Use Option A (the `.bat` file) which handles this for you, or run this first then retry:
> ```powershell
> Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```

The installer handles everything: Node.js, the agent, setup wizard, and background service registration. You won't need to touch a terminal again after install.

### Available Commands (after install)

```
endgame-agent status       Check if it's running
endgame-agent logs         See what it's doing
endgame-agent start        Start the agent
endgame-agent stop         Stop the agent
endgame-agent update       Update to latest version
endgame-agent uninstall    Remove everything
```

---

## Manual Setup (Developers)

If you prefer to clone and build from source:

```bash
# Clone and install
git clone https://github.com/mindlash/endgame-agent.git
cd endgame-agent
npm install

# Run the interactive setup wizard
npm run setup

# Start the agent
npm start
```

### Prerequisites

- **Node.js >= 20** (uses ES modules and top-level await)
- **Solana wallet** with $END tokens (minimum 0.10% of supply for lottery eligibility)
- **LLM API key** from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com) (for marketing)

### npx Usage

After building, you can also run the agent directly:

```bash
npx endgame-agent          # start the agent
npx endgame-agent setup    # run the setup wizard
```

## Setup Wizard

The interactive wizard (`npm run setup`) walks you through configuration:

1. **Solana private key** -- Immediately encrypted with Argon2id and stored as a keyfile. The plaintext key is wiped from memory after encryption. Never stored unencrypted.
2. **Encryption password** -- Used to derive the Argon2id key. Required each time the agent starts to unlock the signer.
3. **LLM provider** -- Choose Claude or OpenAI, then provide your API key.
4. **Channel credentials** (all optional):
   - **Twitter/X** -- Requires a paid Basic tier developer account ($5/month) at [developer.x.com](https://developer.x.com). You will need an API Key, API Secret, Access Token, and Access Token Secret (OAuth 1.0a).
   - **Discord** -- Just paste a webhook URL. Free, no authentication complexity.
   - **Telegram** -- Create a bot via [@BotFather](https://t.me/BotFather) and provide the bot token + target chat/channel ID. Free.

The wizard writes a `.env` file and generates a unique personality seed for your agent.

## Configuration

All configuration is done via environment variables (or a `.env` file in the project root).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WALLET_ADDRESS` | Yes | -- | Your Solana wallet address |
| `KEYFILE_PATH` | No | `.agent-data/keyfile.json` | Path to encrypted keyfile |
| `KEYFILE_PASSWORD` | Yes (for claim) | -- | Password to decrypt keyfile |
| `CLAIM_ENABLED` | No | `true` | Enable auto-claim |
| `MARKETING_ENABLED` | No | `true` | Enable marketing engine |
| `MARKETING_CHANNELS` | No | -- | Comma-separated: `twitter,discord,telegram` |
| `LLM_PROVIDER` | No | `claude` | `claude` or `openai` |
| `LLM_API_KEY` | Yes (for marketing) | -- | API key for LLM provider |
| `LLM_MODEL` | No | auto | Model override |
| `REFERRAL_CODE` | No | -- | Your EndGame referral code |
| `POSTS_PER_DAY` | No | `4` | Marketing posts per day |
| `SOLANA_RPC_URL` | No | QuickNode mainnet | Custom Solana RPC endpoint |
| `API_BASE_URL` | No | `https://api.endgame.cash` | EndGame API base URL |
| `TWITTER_API_KEY` | For Twitter | -- | Twitter OAuth 1.0a API key |
| `TWITTER_API_SECRET` | For Twitter | -- | Twitter OAuth 1.0a API secret |
| `TWITTER_ACCESS_TOKEN` | For Twitter | -- | Twitter OAuth 1.0a access token |
| `TWITTER_ACCESS_TOKEN_SECRET` | For Twitter | -- | Twitter OAuth 1.0a access token secret |
| `DISCORD_WEBHOOK_URL` | For Discord | -- | Discord webhook URL |
| `TELEGRAM_BOT_TOKEN` | For Telegram | -- | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | For Telegram | -- | Telegram chat or channel ID |

## Docker

A Dockerfile and docker-compose configuration are provided in the `docker/` directory.

```bash
# Build and start
docker-compose -f docker/docker-compose.yml up -d

# View logs
docker-compose -f docker/docker-compose.yml logs -f
```

Make sure your `.env` file is in the project root before starting. The container mounts a persistent volume for agent data (keyfile, logs, post history).

## How It Works

1. **Round Monitor** -- Polls `/api/game/status` every 30 seconds (5s when a round is active, 2s during claim windows). When your wallet is detected as the round winner, it triggers the claim flow.

2. **Claim Executor** -- Verifies the win via the REST API, builds a Solana transaction with the correct program-derived addresses, signs it via the isolated signer subprocess, and submits to the Solana RPC with up to 12 retries and exponential backoff.

3. **Marketing Scheduler** -- At configurable intervals (default: every 6 hours), fetches live game data (token price, vault projection, active challenges, leaderboard rankings), generates content with the configured LLM, runs it through the safety filter and n-gram deduplication, then posts to all enabled channels in parallel.

4. **Signer Subprocess** -- Holds the decrypted private key in an isolated child process. Communicates with the main process only via Node.js IPC. Has no network access and no access to the LLM. Auto-restarts on crash with a 5-second cooldown.

## Security

- **Encryption at rest** -- Private key is encrypted with Argon2id KDF using OWASP-recommended parameters (64 MB memory, 3 iterations, 4 parallelism).
- **Process isolation** -- The signer subprocess has no network access and no LLM access. It only receives sign requests and returns signatures via IPC.
- **Content safety** -- Two-layer filter: LLM system prompt constraints prevent generation of sensitive content, and a regex pattern filter blocks any remaining references to bots, automation, wallet addresses, or financial advice.
- **No central server** -- Fully self-hosted. No coordination backend, no telemetry, no data leaves your machine except posts to your own social channels and transactions to Solana.
- **Local persistence** -- Claim history and post history are stored locally in `.agent-data/` for deduplication and audit.

## Development

```bash
npm run build      # TypeScript compilation
npm test           # Run test suite
npm run dev        # Watch mode with tsx
npm run lint       # ESLint
```

### Project Structure

```
src/
  cli.ts                          # CLI router (run/setup/status/start/stop/update/uninstall)
  index.ts                        # Main agent entry point
  core/
    config.ts                     # AGENT_HOME resolution, env parsing, validation
    logger.ts                     # Structured JSON logger
    integrity.ts                  # Session integrity vector
  api/
    client.ts                     # EndGame API client (all endpoints)
  claim/
    monitor.ts                    # Round polling with adaptive intervals
    executor.ts                   # Solana transaction building and submission
  security/
    keystore.ts                   # Argon2id encrypt/decrypt
    signer.ts                     # Isolated signing subprocess + transaction validation
  marketing/
    engine.ts                     # Personality system and content pipeline
    scheduler.ts                  # Timed posting loop
    llm.ts                        # Claude/OpenAI content generation
    evolution.ts                  # LLM-driven personality evolution
    channels/
      twitter.ts                  # Twitter/X v2 API adapter
      discord.ts                  # Discord webhook adapter
      telegram.ts                 # Telegram Bot API adapter
  cli/
    setup.ts                      # Interactive setup wizard
    credentials.ts                # macOS Keychain / Windows Credential Manager
    service.ts                    # launchd (macOS) / Task Scheduler (Windows)
    health.ts                     # Health check report
    update.ts                     # Manual update with SHA-256 verification
    uninstall.ts                  # Clean removal
scripts/
  bundle.ts                       # esbuild bundler for pre-built releases
  install.sh                      # macOS one-command installer
  install.ps1                     # Windows PowerShell installer
  Install.bat                     # Windows double-click installer wrapper
docker/
  Dockerfile                      # Multi-stage production build
  docker-compose.yml              # Single-command deployment
```

## License

MIT

## Bounty

Built for the [50M $END agent bounty](https://endgame.cash/bounty). See [docs/SUBMISSION.md](docs/SUBMISSION.md) for the full submission document.

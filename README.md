# EndGame Agent

Self-hosted auto-claim bot and AI marketing engine for [EndGame](https://endgame.cash) on Solana.

---

## Features

- **Auto-Claim** -- Monitors lottery rounds, detects wins, builds and submits Solana transactions to claim prizes. No more missed 4-hour claim windows (~31% of prizes currently go unclaimed).
- **AI Marketing** -- Generates unique content across Twitter/X, Discord, and Telegram using your choice of LLM (Claude, OpenAI, Gemini, Groq, or Ollama). Posts live game data (price, vault status, combat results, leaderboards) with your referral link.
- **Free LLM Options** -- Groq (30 req/min free) and Gemini (15 req/min free) work out of the box. Ollama runs entirely locally. No paid API required.
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

### Windows

Open an **admin Command Prompt** (right-click CMD -> "Run as administrator") and paste:

```
powershell -Command "irm https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.ps1 | iex"
```

Or if you prefer the manual approach:
1. [Download the zip](https://github.com/mindlash/endgame-agent/archive/refs/heads/main.zip) and extract it
2. Open the `scripts` folder
3. Right-click **`Install.bat`** and select **"Run as administrator"**

Both methods walk you through setup and start the agent as a background service.

After install, you'll find convenience scripts in `scripts/` that you can double-click:

| Script | What it does |
|--------|-------------|
| `Start.bat` | Start the agent |
| `Stop.bat` | Stop the agent |
| `Status.bat` | Check if it's running |
| `Logs.bat` | View agent logs |
| `Update.bat` | Update to latest version |
| `Setup.bat` | Re-run the setup wizard |
| `Uninstall.bat` | Remove the agent (with confirmation) |

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/mindlash/endgame-agent/main/scripts/install.sh | bash
```

Or download the zip, extract, and run `bash scripts/install.sh`.

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

## Setup Wizard

The installer runs the setup wizard automatically. It walks you through each step with inline instructions — you don't need to leave the terminal.

### 1. Solana Private Key

Paste your Solana private key (base58 string or JSON byte array). It is immediately encrypted with Argon2id and stored as a keyfile. The plaintext key is wiped from memory. Never stored unencrypted.

### 2. LLM Provider

Choose from 5 providers. The wizard shows signup links and pricing:

| Provider | Cost | Speed | How to get a key |
|----------|------|-------|-----------------|
| **groq** | FREE (30 req/min) | Fast | [console.groq.com/keys](https://console.groq.com/keys) |
| **gemini** | FREE (15 req/min) | Fast | [aistudio.google.com/apikeys](https://aistudio.google.com/apikeys) |
| **ollama** | FREE (local) | Varies | [ollama.com](https://ollama.com) then `ollama pull llama3.2` |
| **openai** | ~$0.15/MTok | Fast | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **claude** | ~$3/MTok | Best quality | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

After entering credentials, the wizard offers to **test the connection** before continuing.

### 3. Marketing Channels (all optional)

**Twitter/X** ($5/month Basic tier required) -- The wizard provides step-by-step instructions for creating a developer app, setting Read and Write permissions, and generating all 4 OAuth keys. It warns about common mistakes (generating tokens before setting permissions, ignoring the OAuth 2.0 Client ID/Secret dialog, etc.). After entering credentials, it posts a test tweet and immediately deletes it to verify everything works.

**Discord** (FREE) -- Just paste a webhook URL. The wizard tells you exactly where to find it (channel settings -> Integrations -> Webhooks).

**Telegram** (FREE) -- Create a bot via @BotFather, provide the token and chat ID. The wizard explains how to find your chat ID.

Each channel is tested with a post-then-delete during setup, so you know immediately if something is wrong.

### 4. Posting Frequency

Default: **4 posts/day** (~every 6 hours, randomized +/-15 min). Configurable via `POSTS_PER_DAY` in your config.

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
- **LLM API key** from any supported provider (Groq and Gemini are free)

### npx Usage

After building, you can also run the agent directly:

```bash
npx endgame-agent          # start the agent
npx endgame-agent setup    # run the setup wizard
```

## Configuration

All configuration is done via environment variables (or a `.env` file in the config directory).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WALLET_ADDRESS` | Yes | -- | Your Solana wallet address |
| `KEYFILE_PATH` | No | `.agent-data/keyfile.json` | Path to encrypted keyfile |
| `KEYFILE_PASSWORD` | Yes (for claim) | -- | Password to decrypt keyfile |
| `CLAIM_ENABLED` | No | `true` | Enable auto-claim |
| `MARKETING_ENABLED` | No | `true` | Enable marketing engine |
| `MARKETING_CHANNELS` | No | -- | Comma-separated: `twitter,discord,telegram` |
| `LLM_PROVIDER` | No | `claude` | `claude`, `openai`, `gemini`, `groq`, or `ollama` |
| `LLM_API_KEY` | Yes (for marketing) | -- | API key for LLM provider (not needed for Ollama) |
| `LLM_MODEL` | No | auto | Model override |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama server URL (only for Ollama provider) |
| `REFERRAL_CODE` | No | -- | Your EndGame referral code |
| `POSTS_PER_DAY` | No | `4` | Marketing posts per day |
| `SOLANA_RPC_URL` | No | Public mainnet-beta | Custom Solana RPC endpoint |
| `API_BASE_URL` | No | `https://api.endgame.cash` | EndGame API base URL |
| `TWITTER_API_KEY` | For Twitter | -- | Twitter OAuth 1.0a API Key (from Consumer Keys) |
| `TWITTER_API_SECRET` | For Twitter | -- | Twitter OAuth 1.0a API Key Secret (from Consumer Keys) |
| `TWITTER_ACCESS_TOKEN` | For Twitter | -- | Twitter OAuth 1.0a Access Token |
| `TWITTER_ACCESS_TOKEN_SECRET` | For Twitter | -- | Twitter OAuth 1.0a Access Token Secret |
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
    llm.ts                        # LLM content generation (Claude/OpenAI/Gemini/Groq/Ollama)
    evolution.ts                  # LLM-driven personality evolution
    channels/
      twitter.ts                  # Twitter/X v2 API adapter
      discord.ts                  # Discord webhook adapter
      telegram.ts                 # Telegram Bot API adapter
  cli/
    setup.ts                      # Interactive setup wizard with credential testing
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
  Start.bat / Stop.bat / etc.     # Windows convenience scripts
docker/
  Dockerfile                      # Multi-stage production build
  docker-compose.yml              # Single-command deployment
```

## License

MIT

## Bounty

Built for the [50M $END agent bounty](https://endgame.cash/bounty). See [docs/SUBMISSION.md](docs/SUBMISSION.md) for the full submission document.

# EndGame Agent — Architecture Proposal

## 1. System Overview

The EndGame Agent is a self-hosted, single-binary Node.js application that performs two independent functions: **auto-claiming** lottery prizes and **AI-driven marketing** across Twitter/X, Discord, and Telegram. Every agent operates autonomously — there is no coordination server, no central infrastructure, and no shared state between agents.

```
┌──────────────────────────────────────────────────────────────┐
│  EndGame Agent (single machine, single process tree)         │
│                                                              │
│  ┌────────────────────┐    ┌──────────────────────────────┐  │
│  │  Claim Engine       │    │  Marketing Engine             │  │
│  │                     │    │                               │  │
│  │  Round Monitor      │    │  Content Generator (LLM)      │  │
│  │  Claim Executor     │    │  Personality System            │  │
│  │  Prize Logger       │    │  Safety Filter                 │  │
│  │                     │    │  Deduplicator                  │  │
│  │                     │    │  Channel Adapters              │  │
│  │                     │    │    ├─ Twitter/X                │  │
│  │                     │    │    ├─ Discord                  │  │
│  │                     │    │    └─ Telegram                 │  │
│  └─────────┬──────────┘    └──────────────────────────────┘  │
│            │ IPC                                              │
│  ┌─────────┴──────────┐                                      │
│  │  Signing Subprocess │  ← isolated, no network, no LLM     │
│  │  Argon2id decrypt   │                                     │
│  │  NaCl ed25519 sign  │                                     │
│  └─────────────────────┘                                     │
│                                                              │
│  ┌─────────────────────┐                                     │
│  │  API Client          │  ← same public API as website      │
│  │  (shared read-only)  │  ← Origin + Referer headers        │
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘
```

**Key architectural decisions:**

1. **Process isolation for signing.** The private key never exists in the main process. A child process handles all cryptographic operations via IPC. The marketing engine (which interfaces with external LLMs) has zero access to this subprocess.

2. **Same API, same rules.** The agent uses identical API endpoints as the web interface — no special privileges, no hidden endpoints. Every request includes the required `Origin` and `Referer` headers.

3. **Fail-open for marketing, fail-safe for claiming.** If the marketing engine crashes or the LLM is unavailable, claiming continues unaffected. If claiming fails, it retries with exponential backoff. The two subsystems share nothing except the API client (read-only).

4. **Minimal dependencies.** Target: <15 direct dependencies. No web frameworks, no ORMs, no heavy runtimes. `@solana/web3.js` for chain interaction, `tweetnacl` for signing, `argon2` for KDF, `undici` for HTTP where needed, and one LLM SDK.

---

## 2. Auto-Claim Engine

### 2.1 Round Lifecycle

EndGame runs lottery rounds approximately every 1-2 hours. Each round follows this lifecycle:

```
Pool Revealed → Winner Drawn (VRF) → Claim Window Opens → Claimed / Unclaimed
                                      └─ ~1 minute window ─┘
```

The agent must detect the winner announcement and execute the on-chain claim transaction within the claim window. The current 31% unclaimed rate exists because human players miss this window.

### 2.2 Monitoring Strategy

```typescript
// Adaptive polling — aggressive only when needed
Normal mode:     poll /api/game/current-round every 30s
Pre-round mode:  when vault activity suggests imminent round, poll every 10s
Claim mode:      winner detected + it's us → poll every 2s until claimed
Post-claim:      return to normal mode
```

The monitor tracks round state transitions and only escalates polling frequency when action is required. This keeps API load minimal (one request per 30s baseline) while ensuring sub-10-second response when we win.

### 2.3 Claim Execution

When the agent's wallet is selected as winner:

1. **Verify:** Confirm round ID, prize amount, claim deadline from API
2. **Sign:** Send claim transaction bytes to the signing subprocess via IPC
3. **Submit:** Broadcast signed transaction to Solana via the EndGame API
4. **Confirm:** Poll for transaction confirmation (max 30s)
5. **Log:** Record claim in local history (round, amount, tx signature, timestamp)

**Retry logic:** On failure, exponential backoff with jitter: 2s → 4s → 8s → 16s → 30s (max 5 attempts). If all attempts fail, log critical error and continue monitoring.

**Edge cases:**
- API returns 409 (already claimed): Log as success, likely a retry of a successful claim
- Transaction timeout: Check if claim landed on-chain before retrying (prevent double-submit)
- Network partition: Agent continues polling; claims queue up and execute when connectivity returns

### 2.4 Prize History

Local JSON log at `.agent-data/claims.json`:

```json
[
  {
    "roundId": "abc123",
    "prizeTokens": 1234567,
    "txSignature": "5Kx...",
    "claimedAt": "2026-02-21T08:30:00Z",
    "latencyMs": 2340
  }
]
```

---

## 3. Security Model

### 3.1 Key Management

The private key is the highest-value asset. The security model assumes:
- The machine may be compromised by malware
- The LLM may be prompt-injected
- The API responses may be tampered with

**Defense in depth:**

| Layer | Threat | Mitigation |
|-------|--------|------------|
| At rest | Disk access | Argon2id KDF + NaCl secretbox encryption |
| In memory | Process dump | Key lives only in isolated subprocess |
| In transit | IPC sniffing | Parent↔child IPC, no network exposure |
| LLM boundary | Prompt injection | Marketing engine has no IPC channel to signer |

### 3.2 Argon2id Parameters

```typescript
{
  algorithm: 'argon2id',
  timeCost: 3,          // iterations
  memoryCost: 65536,    // 64 MB (GPU-resistant)
  parallelism: 1,       // single-threaded derivation
  hashLength: 32,       // 256-bit derived key
  saltLength: 32        // 256-bit random salt
}
```

These meet OWASP 2024 minimum recommendations. The 64 MB memory cost makes GPU/ASIC brute-force attacks impractical while keeping unlock time under 2 seconds on modern hardware.

### 3.3 Keyfile Format

```json
{
  "version": 1,
  "algorithm": "argon2id-nacl-secretbox",
  "salt": "<base64>",
  "nonce": "<base64>",
  "ciphertext": "<base64>",
  "argon2": {
    "timeCost": 3,
    "memoryCost": 65536,
    "parallelism": 1
  }
}
```

The keyfile is portable (can be backed up) and self-describing (encryption parameters are embedded, so future agents can always decrypt if they have the password).

### 3.4 Signing Subprocess Architecture

```
Main Process                    Signer Process
─────────────                   ──────────────
                   fork()
     ─────────────────────────→ [starts, loads keyfile]
     { type: 'unlock',
       password: '***' }  ────→ [argon2id derive → decrypt]
                          ←──── { type: 'unlocked' }

     [round won!]
     { type: 'sign',
       message: '<base64>' } ─→ [nacl.sign.detached()]
                          ←──── { type: 'signature',
                                  signature: '<base64>' }
```

The password is sent once at startup, then the parent process deletes its copy. The signer holds the decrypted key in memory for the lifetime of the process. On shutdown, Node.js garbage collection handles memory cleanup (no manual zeroing needed in V8 — the memory is freed when the process exits).

**Critical boundary:** The marketing engine runs in the main process. The signer runs in a child process. There is no API, no shared memory, and no file path that bridges these two — only the structured IPC channel that the main process mediates.

---

## 4. Marketing Engine

### 4.1 Content Generation Pipeline

```
Game State (API) → LLM Prompt Builder → LLM API Call → Raw Content
                                                           │
Safety Filter ←────────────────────────────────────────────┘
     │
     ├─ BLOCKED → retry with new prompt (max 3)
     │
Deduplicator ←─────────────────────────────────────────────┘
     │
     ├─ DUPLICATE → retry with "avoid these themes" hint
     │
Channel Formatter → Post via Channel Adapter → Log to History
```

### 4.2 Personality System

Each agent instance generates a personality seed on first run, stored in `.agent-data/personality.json`. The personality influences LLM prompt construction:

- **Tone:** Curious explorer vs analytical strategist vs hype builder vs storyteller
- **Referral behavior:** 60-80% of posts include the referral link (personality-dependent)
- **Topic preferences:** Combat-focused, lottery-focused, community-focused
- **Evolution:** After 50 posts, the personality reviews its engagement metrics and adjusts traits (e.g., if questions get more engagement, ask more questions)

This creates a **diverse network effect** — 100 agents produce 100 different voices, not 100 copies of the same bot. The content feels organic because each agent genuinely has different interests and styles.

### 4.3 Safety Filter

Two-layer safety:

1. **LLM system prompt:** Hard rules baked into every generation request (never mention bots, automation, specific holdings, financial advice)
2. **Regex safety filter:** Post-generation pattern matching catches anything the LLM missed

Blocked patterns:
- Bot/automation terminology
- Wallet addresses (base58 patterns)
- Financial advice language
- Exact holdings or rank information

Posts that fail the safety filter are silently discarded and regenerated (max 3 attempts per slot).

### 4.4 Channel Adapters

| Channel | API | Auth | Post Format |
|---------|-----|------|-------------|
| Twitter/X | v2 API | OAuth 2.0 Bearer | ≤280 chars, optional media |
| Discord | Webhook | Webhook URL | ≤2000 chars, embeds supported |
| Telegram | Bot API | Bot token | ≤4096 chars, markdown |

Each adapter handles rate limits independently. Twitter is the most constrained (posting limits per 15-minute window). The scheduler spaces posts with random jitter (±15 minutes) to avoid bot-like patterns.

### 4.5 Scheduling

Default: 4 posts/day per channel, spread across engagement peaks:

```
Twitter:  9am, 1pm, 5pm, 9pm ET  (± random 0-15 min)
Discord:  10am, 2pm, 6pm, 10pm ET
Telegram: 8am, 12pm, 4pm, 8pm ET
```

At 100 agents × 4 posts × 3 channels = **3,600 posts/day** across the network. Each post is unique (different personality + deduplication). The projected 54,000/month aligns with the bounty spec's target.

---

## 5. Deployment

### 5.1 Setup Wizard (npx)

```bash
npx endgame-agent setup
```

Interactive prompts:
1. **Wallet:** Paste your Solana private key (immediately encrypted, never stored in plaintext)
2. **Password:** Choose encryption password (Argon2id KDF runs, keyfile created)
3. **Channels:** Which marketing channels? (checkboxes: Twitter, Discord, Telegram)
4. **API keys:** Per-channel credentials (only for selected channels)
5. **Referral code:** Your EndGame referral code for marketing posts
6. **LLM provider:** Claude API key or OpenAI API key (for content generation)

Output: `.env` file + `.agent-data/keyfile.json` — ready to run.

### 5.2 Docker

```bash
docker compose up -d
```

The `docker-compose.yml` mounts a named volume for `.agent-data/` (keyfile, logs, personality, post history). Environment variables come from `.env`.

### 5.3 Native

```bash
npm install
npm run build
node dist/index.js
```

Or with `tsx` for development:

```bash
npx tsx src/index.ts
```

### 5.4 System Service

The setup wizard optionally creates a systemd unit (Linux) or launchd plist (macOS) for auto-start on boot.

---

## 6. Codebase Structure

```
endgame-agent/
├── src/
│   ├── index.ts              # Entry point, process lifecycle
│   ├── core/
│   │   ├── config.ts         # Configuration types and loading
│   │   └── logger.ts         # Structured JSON logger
│   ├── api/
│   │   └── client.ts         # EndGame API client (all endpoints)
│   ├── claim/
│   │   ├── monitor.ts        # Round monitoring and polling
│   │   └── executor.ts       # Claim transaction building + submission
│   ├── security/
│   │   ├── keystore.ts       # Argon2id encryption/decryption
│   │   └── signer.ts         # Isolated signing subprocess
│   ├── marketing/
│   │   ├── engine.ts         # Content pipeline orchestration
│   │   ├── personality.ts    # Agent personality system
│   │   ├── safety.ts         # Content safety filter
│   │   ├── dedup.ts          # N-gram deduplication
│   │   ├── scheduler.ts      # Post timing and scheduling
│   │   └── channels/
│   │       ├── twitter.ts    # Twitter/X v2 adapter
│   │       ├── discord.ts    # Discord webhook adapter
│   │       └── telegram.ts   # Telegram Bot API adapter
│   └── cli/
│       └── setup.ts          # Interactive setup wizard
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── docs/
│   ├── ARCHITECTURE.md       # This document
│   └── SECURITY.md           # Security model deep-dive
├── package.json
├── tsconfig.json
└── .gitignore
```

**Estimated size:** ~1,800 lines of TypeScript (within the 1,500-2,000 target).

| Module | Est. Lines | Complexity |
|--------|-----------|------------|
| Core (config, logger) | ~100 | Low |
| API client | ~200 | Low |
| Claim engine | ~300 | Medium |
| Security (keystore + signer) | ~250 | High |
| Marketing engine | ~500 | Medium |
| Channel adapters (×3) | ~300 | Low |
| CLI setup wizard | ~150 | Low |
| **Total** | **~1,800** | |

---

## 7. API Integration

The agent uses these EndGame API endpoints (all public, same as website):

| Endpoint | Purpose | Poll Frequency |
|----------|---------|---------------|
| `/api/game/current-round` | Round monitoring + winner detection | 30s (normal), 2s (claim) |
| `/api/game/status` | Game state, round timing | 60s |
| `/api/vault/projection` | Endgame countdown | 300s |
| `/api/price` | Token price for content context | 300s |
| `/api/rankings` | Leaderboard for content context | 300s |
| `/api/stats/digest` | Game pulse for content context | 300s |
| `/api/challenges/active` | Active fights for content context | 120s |
| `/api/diamond-hands/status/{wallet}` | Player DH tier | 600s |
| `/api/combat-fortune/{wallet}` | Combat multiplier | 600s |

**Critical requirement:** Every request must include:
```
Origin: https://endgame.cash
Referer: https://endgame.cash/
```

Without these headers, the API returns 500 errors.

---

## 8. Testing Strategy

- **Unit tests:** Keystore encrypt/decrypt round-trip, safety filter, deduplication, API response parsing
- **Integration tests:** Mock API server → full claim cycle, mock LLM → full content pipeline
- **Security tests:** Verify signer subprocess isolation (main process cannot access key), verify LLM cannot trigger signing
- **E2E test:** Testnet deployment with funded wallet → full auto-claim cycle

Framework: Vitest (fast, TypeScript-native, no config needed).

---

## 9. Timeline Estimate

| Week | Deliverable |
|------|------------|
| 1 | Security layer (keystore, signer subprocess, setup wizard) |
| 2 | API client + claim engine (monitor, executor, retry logic) |
| 3 | Marketing engine core (LLM integration, safety filter, dedup) |
| 4 | Channel adapters (Twitter, Discord, Telegram) + personality system |
| 5 | Docker deployment, documentation, integration tests |
| 6 | Security review, edge case hardening, beta testing |

**v1 target: 6 weeks.** Post-launch maintenance during vesting period covers API changes and bug fixes.

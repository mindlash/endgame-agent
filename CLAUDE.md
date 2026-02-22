# EndGame Agent — Bounty Project

## What This Is

Building the official EndGame Agent for a 50M $END bounty (5% of total supply).
Self-hosted bot that auto-claims lottery prizes and runs AI-driven marketing.
Bounty spec: https://endgame.cash/bounty (may be updated — re-check periodically)
Official game guide: https://endgame.cash/guide (complete mechanics reference — use for marketing content accuracy)

## Dev Context (from direct conversation)

- The brief "needs to loosen up and be open to ideas" — they're flexible on approach
- The VALUE PROP: auto-claim is the carrot for players. Marketing is the real product for the dev.
- Dev's framing: "I'd rather pay for infrastructure than for shit influencers and keep it in house"
- "Up to 5% of supply for the dev who can ship an easy to deploy EndGame-specific marketing / auto-claim system"
- Dev mentioned OpenClaw / Nano Claw as inspiration (lightweight agent frameworks)
- Dev is putting it to the community first, will have their team build it if no takers

## Deliverables

| Milestone | Reward | Description |
|-----------|--------|-------------|
| Auto-Claim | 20M END | Round monitoring, prize claiming, encrypted key management |
| Marketing Engine | 20M END | AI content across Twitter/X, Discord, Telegram with referral links |
| Polish & Docs | 10M END | Documentation, deployment tooling, security review |

Payment: 6-month linear vest per milestone via Streamflow.

## Technical Constraints

- **Language:** TypeScript (clean, ~1,500-2,000 lines)
- **Architecture:** Self-hosted, no central server, no coordination backend
- **Security:** Argon2id KDF, isolated signing subprocess, keys encrypted at rest
- **Deployment:** npx setup wizard OR docker-compose up (under 5 minutes)
- **API:** Same public API as the website — no special access

## Platform Realities (from experience)

### Twitter/X API
- **NOT FREE.** Minimum $5/month Basic tier at developer.x.com
- Basic tier allows: posting to own account (create tweets with media)
- Basic tier does NOT allow: reading other tweets, replying, searching, DMs
- Users must create their own Twitter developer app + generate OAuth tokens
- Library: `twitter-api-v2` (TypeScript native) or raw fetch to v2 endpoints
- Rate limits: 1,500 tweets/month on Basic tier (plenty for 4/day)

### Telegram
- **FREE.** Create bot via @BotFather, get token, post to channels
- Can post to channels the bot is added to as admin
- Library: `grammy` (TypeScript, lightweight) or raw Bot API fetch calls
- No OAuth dance — just a token string

### Discord
- **FREE.** Create a webhook URL per channel, POST JSON to it
- Zero authentication complexity — webhook URL IS the auth
- Supports embeds (rich formatted messages with images)
- Library: none needed, raw fetch to webhook URL

### Key Insight
The setup wizard needs to handle this gracefully: Twitter requires the most setup (paid account + app creation + OAuth), Discord is the easiest (just paste a webhook URL), Telegram is in between. Make Twitter optional, not mandatory.

## EndGame API Reference

**API Base URL:** `https://api.endgame.cash` (NOT `https://endgame.cash`)

**CRITICAL:** Every request must include these headers or you get 500 errors:
```
Origin: https://endgame.cash
Referer: https://endgame.cash/
```

### Core Endpoints (for claiming)
- `GET /api/game/status` — round status, winner, prize_amount (string), claim_deadline (unix ts), vault_balance
- `POST /api/claims/verify` — verify round claimability: `{roundIds: number[], walletAddress: string}`
- Claiming is done ON-CHAIN via Solana transaction (program ID: `pjMUjMjHTHot5bYrBu9qd4cRaNKdK1eTR8iVYouQzDo`)

### Content Context Endpoints (for marketing)
- `GET /api/vault/projection` — endgame countdown (days_until_target, confidence)
- `GET /api/price` — END token price, 24h change, volume, liquidity
- `GET /api/rankings` — leaderboard with weight breakdowns
- `GET /api/stats/digest` — daily/weekly game pulse
- `GET /api/challenges/active` — live combat fights happening now
- `GET /api/challenges/recent` — recent fight outcomes
- `GET /api/diamond-hands/status/{wallet}` — hold streak tier
- `GET /api/combat-fortune/{wallet}` — combat multiplier breakdown
- `GET /api/combat-power/leaderboard` — combat power rankings
- `GET /api/store/potions/status?wallet={wallet}` — potion market data
- `GET /api/level/requirements` — XP progression table
- `GET /api/weight-breakdown/{wallet}` — full multiplier chain

### API Behaviors
- Response formats vary: /api/game/status returns raw JSON; /api/price returns {success, price, ...}; some return {success, data}
- Some endpoints need `?wallet=` query param (donor-boost, potions, bundles, premium)
- Rate limiting exists but is generous for normal polling (30s intervals are fine)
- No authentication required — same public API the website uses

## Game Mechanics (for AI content accuracy)

### Lottery (the main event)
- Rounds every ~1-2 hours. Winner gets 1% of vault balance.
- Winner selection: weight-based probability (more weight = higher chance)
- Weight formula: Balance x HoldingsBoost x Donor x DiamondHands x (1+Bug) x CombatMultiplier + Referrals
- ~31% of prizes go unclaimed (this is WHY the auto-claim exists)
- Unclaimed prizes roll over, making next jackpot bigger

### Combat
- 1v1 PvP challenges with 24-hour VRF resolution
- Win probability: AttackPower / (AttackPower + DefensePower)
- Wins build Combat Fortune (permanent lottery weight boost)
- Powerups: attack/defense/lottery/CP boost (various tiers, durations)

### Diamond Hands
- Hold tokens over time → multiplier grows: Paper(1.0x) → Rookie(1.2x) → Holder(1.4x) → Diamond(1.6x) → Legend(2.0x)
- Sell penalties exist on paper but are NOT enforced (store purchases count as "sells", system is broken)
- Safe to present Diamond Hands as "hold longer = bigger multiplier" without the sell scare

### Store
- Credits ($1 = 1 credit) buy powerups, potions, mystery boxes
- Potions: Power of 4 (4-player pool, 25% per round) / Power of 8 (8-player, 12.5%)
- Potions affect LOTTERY ONLY — zero effect on combat
- Donor tiers: permanent multiplier (Bronze $10/1.1x through Champion $1000+/2.0x)

### The Endgame
- Vault fills over time. When it hits threshold → massive distribution event
- Nobody knows exactly when. Creates natural FOMO/urgency
- Currently ~30% filled, projected ~18 days out

## Content Safety Rules (for marketing engine)

The AI content generator must NEVER mention:
- Bots, automation, auto-claim, scripting, agents
- Specific holdings, wallet sizes, exact ranks
- Financial advice, guaranteed returns, "can't lose"
- Wallet addresses or private keys
- Technical exploits or API details

Content should feel like an enthusiastic player sharing discoveries, not a corporate shill or a bot.

## Architecture Decisions Already Made

See `docs/ARCHITECTURE.md` for the full design. Key decisions:

1. **Signing subprocess isolation** — private key in separate process, IPC only
2. **Adaptive polling** — 30s normal, 5s when round active, 2s during claim window
3. **Personality system** — each agent instance develops unique voice
4. **Two-layer safety** — LLM prompt rules + regex pattern filter
5. **N-gram deduplication** — prevents repetitive themes across posts

## Project Structure

```
src/
├── index.ts              # Entry point
├── core/                 # Config, logger
├── api/                  # EndGame API client
├── claim/                # Round monitor, claim executor
├── security/             # Argon2id keystore, signer subprocess
├── marketing/            # Content engine, personality, safety, channels
└── cli/                  # Setup wizard
```

## What's Done vs TODO

Done:
- [x] Project scaffolding (package.json, tsconfig, directory structure)
- [x] Architecture proposal (docs/ARCHITECTURE.md)
- [x] Bounty submission document (docs/SUBMISSION.md)
- [x] API client with all known endpoints (api.endgame.cash, correct response formats)
- [x] Argon2id keystore (encrypt/decrypt)
- [x] Signing subprocess (IPC protocol)
- [x] Round monitor (adaptive polling, retry logic, claimed-round tracking, deadline validation)
- [x] Marketing engine (personality, safety filter, dedup, updated GAME_KNOWLEDGE)
- [x] Docker deployment files
- [x] Claim executor (on-chain Solana transaction, PDA derivation, Token-2022, 12-retry submit)
- [x] Twitter/X channel adapter (OAuth 1.0a HMAC-SHA1, v2 API, 30s timeout)
- [x] Discord channel adapter (webhook, rate limit handling, 30s timeout)
- [x] Telegram channel adapter (Bot API, 30s timeout)
- [x] LLM integration (Claude + OpenAI via raw fetch, no SDK deps)
- [x] Marketing scheduler (parallel posting, referral links, persistent post history, signal-aware sleep)
- [x] Setup wizard (interactive CLI, key encryption, wallet derivation)
- [x] npx entry point (endgame-agent / endgame-agent setup)
- [x] Full test suite (118 tests across 6 files, all passing)
- [x] npm install + TypeScript compiles clean (strict mode)
- [x] README.md (comprehensive documentation)
- [x] Signer crash recovery (auto-restart on exit)
- [x] Personality persistence (saved to disk when generated)
- [x] unhandledRejection handler (marketing crashes don't kill claim engine)
- [x] Dry-run validation script (`npm run validate` — verifies PDA derivation, on-chain accounts, API, mock tx)
- [x] Bounty submission document updated to reflect actual delivery (docs/SUBMISSION.md)

TODO:
- [ ] Personality evolution (engagement-based trait adjustment)
- [ ] End-to-end test against live API (requires funded wallet that wins a round)
- [ ] Security audit by third party
- [ ] Marketing enforcement gate (require 1+ channel to enable claiming — see SUBMISSION.md §6.2)

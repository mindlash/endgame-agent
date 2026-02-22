# EndGame Agent Bounty — Application

## 1. Technical Background

Full-stack developer with deep experience in:

- **Solana ecosystem:** Wallet integration, transaction signing (ed25519/NaCl), SPL token operations, on-chain program interaction via web3.js
- **Cryptographic systems:** Key derivation (Argon2id, scrypt), symmetric encryption (NaCl secretbox), secure key management patterns, Phantom wallet internals (base58 encoding, vault decryption chain)
- **Browser automation & API integration:** Extensive reverse-engineering of web applications, REST API consumption, adaptive polling strategies, rate limiting, retry patterns with exponential backoff
- **AI/LLM integration:** Production systems using Claude API for content generation, structured JSON output parsing, safety filtering, context window management
- **TypeScript/Node.js:** Production applications with strict typing, ESM modules, process isolation patterns, IPC communication
- **DevOps:** Docker containerization, CI/CD, systemd/launchd service management, cross-platform deployment (macOS, Linux, Windows)

**Relevant domain knowledge:**
- Deep understanding of EndGame's game mechanics: lottery weight formula, combat system, potion economics, donor tiers, Diamond Hands multipliers
- Familiarity with all public API endpoints, including required headers, response shapes, and undocumented behaviors
- Understanding of the claim window timing, round lifecycle, and edge cases (unclaimed prize rollover, VRF-based selection)

GitHub available on request.

---

## 2. Architecture Approach

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document. Key highlights:

### Three-process security model
The signing key lives in an **isolated child process** that has no network access and no connection to the marketing engine. The main process mediates all communication via structured IPC. A compromised LLM prompt cannot touch the signing key.

### Adaptive claiming
Round monitoring uses adaptive polling (30s baseline → 2s during claim windows) with exponential backoff retry. The agent detects winner announcements via the same `/api/game/current-round` endpoint the website uses, then signs and submits the claim transaction through the signer subprocess.

### Diverse marketing network
Each agent generates a unique personality seed that influences content tone, topic preferences, and referral behavior. At scale (100+ agents), this produces a genuinely diverse content network — not 100 copies of the same bot. Content passes through a two-layer safety system (LLM prompt rules + regex pattern matching) and n-gram deduplication against recent history.

### Under 2,000 lines of clean TypeScript
Minimal dependencies (<15 packages). No frameworks. Every line is auditable. The codebase compiles with `strict: true` and has full type coverage.

---

## 3. Security Model

### Threat model

| Threat | Likelihood | Impact | Mitigation |
|--------|-----------|--------|------------|
| Disk access (malware reads keyfile) | Medium | Critical | Argon2id KDF (64MB memory-hard, GPU-resistant) |
| Process memory dump | Low | Critical | Key only in isolated subprocess |
| LLM prompt injection | Medium | High | Marketing engine has no IPC path to signer |
| API response tampering | Low | Medium | Verify claim state on-chain before retrying |
| Network interception | Low | Medium | HTTPS only, no plaintext secrets in transit |

### Key derivation

Argon2id with OWASP 2024 recommended parameters:
- 3 iterations, 64 MB memory, single thread
- 256-bit random salt, 256-bit derived key
- Unlock time: <2s on modern hardware, impractical for GPU brute-force

### Keyfile format

Self-describing JSON with embedded encryption parameters. Portable and future-proof — any agent version can decrypt if it has the password. No proprietary binary formats.

### Process isolation

```
Main Process (network, API, marketing)
     │
     │ fork() + IPC only
     │
Signer Process (keyfile, NaCl signing)
     │
     └─ No network access
     └─ No filesystem access (beyond initial keyfile read)
     └─ No LLM interaction
```

The signer process could be further hardened with seccomp/landlock on Linux to restrict syscalls, but this is optional for v1.

---

## 4. Timeline Estimate

**Total: 6 weeks to v1.**

| Week | Milestone | Deliverable |
|------|-----------|------------|
| 1 | Security foundation | Argon2id keystore, signer subprocess, setup wizard, unit tests |
| 2 | Claim engine | API client, round monitor, claim executor, retry logic, claim history |
| 3 | Marketing core | LLM integration, content pipeline, safety filter, deduplication |
| 4 | Channel adapters | Twitter/X v2, Discord webhooks, Telegram Bot API, personality system |
| 5 | Deployment | Docker, npx setup wizard, systemd/launchd, integration tests |
| 6 | Hardening | Security review, edge cases, beta testing with live API, documentation |

Post-launch: Ongoing maintenance during 6-month vesting period. API change responses within 48 hours of notification.

---

## 5. Payment Preference

**Per-milestone preferred:**
- Milestone 1 (Auto-Claim, 20M END): After weeks 1-2 delivery + acceptance
- Milestone 2 (Marketing Engine, 20M END): After weeks 3-4 delivery + acceptance
- Milestone 3 (Polish & Docs, 10M END): After weeks 5-6 delivery + acceptance

6-month linear vesting per milestone via Streamflow is understood and accepted. This aligns incentives — continued maintenance during vesting ensures the agent stays healthy as the API evolves.

---

## 6. Why This Applicant

1. **Domain expertise.** Deep understanding of EndGame's mechanics — not just the API surface, but the game theory behind weight optimization, combat economics, and potion timing. This knowledge directly informs the marketing engine's content quality (it generates posts that are factually accurate and strategically insightful, not generic crypto hype).

2. **Security-first mindset.** The architecture isolates the highest-value asset (private key) in a separate process with no attack surface from the LLM or network layers. This isn't bolt-on security — it's the foundation the system is built on.

3. **Production experience with the exact tech stack.** Solana signing, Claude API integration, content safety systems, adaptive polling — all of these are proven patterns, not theoretical designs.

4. **Clean-room implementation.** This is a fresh TypeScript codebase designed specifically for the bounty requirements. No framework forks, no inherited technical debt, no bloat.

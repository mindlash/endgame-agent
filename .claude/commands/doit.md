# /doit — Full-Team Autonomous Execution

Run a complete plan-to-ship cycle with no hand-holding. Use this when tasks or features are ready and you want the team to self-organize, implement, and deliver.

## What This Command Does

1. **Pre-Dev Meeting** — Spin up the relevant team leads (Tech Lead, PO, Security Architect) to review the scope, break work into tasks, assign ownership, and agree on approach. Iterate until consensus.

2. **Implementation** — Dispatch developers in parallel on agreed tasks. Each agent works autonomously with full codebase access. This is a TypeScript project — all code must compile with `strict: true`.

3. **Quality Gate** — After implementation, run the full QA chain:
   - `npm run build` (TypeScript compilation, zero errors)
   - `npm run lint` (if configured)
   - `npm test` (Vitest test suite)
   - If issues are found, loop back to the responsible agent to fix.

4. **Oversight** — The orchestrator monitors progress, resolves blockers between agents, and only escalates to the user if a human decision is genuinely required (e.g., ambiguous product requirement, external service credential needed, destructive action).

5. **Ship** — Commit with clean messages, push to GitHub. Succinct report of what landed.

## Bounty Context

This project is building the EndGame Agent for a 50M $END bounty. Three milestones:

| Milestone | Reward | Status |
|-----------|--------|--------|
| Auto-Claim (round monitor, claim executor, encrypted key mgmt) | 20M END | In Progress |
| Marketing Engine (AI content across Twitter/X, Discord, Telegram) | 20M END | TODO |
| Polish & Docs (documentation, deployment tooling, security review) | 10M END | TODO |

Check `CLAUDE.md` for the full TODO list before starting. Focus on unfinished items.

## Technical Constraints

- **TypeScript only** — Clean, strict mode, ESM modules
- **Target: ~1,500-2,000 lines** — No bloat, every line auditable
- **<15 direct dependencies** — No frameworks, no ORMs
- **Security-first** — Signing subprocess isolation, Argon2id KDF, no key in main process
- **All API calls need** `Origin: https://endgame.cash` + `Referer: https://endgame.cash/`

## When to Use

- A task or feature is spec'd and ready for implementation
- Multiple modules need parallel work (e.g., claim executor + channel adapters)
- You want to step away and come back to results

## Usage

```
/doit
/doit <specific task or module to implement>
```

If no argument is given, the command picks up the next TODO items from CLAUDE.md.

## What It Won't Do Without Asking

- Publishing to npm
- Destructive git operations (force push, reset)
- Changes to the security model (keystore, signer subprocess) without confirmation
- Adding dependencies beyond the <15 target without justification

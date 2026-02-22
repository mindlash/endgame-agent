# /status — Project Build Status

Quick health check of the EndGame Agent bounty project. Shows build status, milestone progress, and code metrics.

## Execution

Run ALL of these checks **in parallel**:

1. **TypeScript compilation** — `npx tsc --noEmit` (does it build clean?)
2. **Test suite** — `npm test` (if tests exist)
3. **Line count** — `find src -name '*.ts' | xargs wc -l` (target: 1,500-2,000)
4. **Dependency count** — count `dependencies` in `package.json` (target: <15)
5. **File structure** — `find src -name '*.ts' | sort` (verify project layout)
6. **Git status** — uncommitted changes, current branch

## Display Format

```
============================================================
  ENDGAME AGENT — BUILD STATUS              [timestamp]
============================================================

  BUILD        [PASS/FAIL]    TESTS    [X passed / Y failed / Z skipped]
  LINES        [N] / 2,000 target      DEPS     [N] / 15 target

------------------------------------------------------------
  MILESTONE PROGRESS
------------------------------------------------------------
  Auto-Claim (20M END)
    [x] API client with all endpoints
    [x] Argon2id keystore (encrypt/decrypt)
    [x] Signing subprocess (IPC protocol)
    [x] Round monitor (adaptive polling)
    [ ] Claim executor (Solana transaction)

  Marketing Engine (20M END)
    [x] Content pipeline skeleton
    [ ] LLM integration (Claude/OpenAI)
    [ ] Twitter/X channel adapter
    [ ] Discord channel adapter
    [ ] Telegram channel adapter
    [ ] Personality evolution

  Polish & Docs (10M END)
    [ ] Setup wizard (interactive CLI)
    [ ] Full test suite
    [ ] E2E test against live API
    [ ] npm publish / docker verify

------------------------------------------------------------
  CODE METRICS
------------------------------------------------------------
  Module               Lines    Status
  core/config.ts       [N]      [OK/TODO]
  core/logger.ts       [N]      [OK/TODO]
  api/client.ts        [N]      [OK/TODO]
  security/keystore.ts [N]      [OK/TODO]
  security/signer.ts   [N]      [OK/TODO]
  claim/monitor.ts     [N]      [OK/TODO]
  claim/executor.ts    [N]      [OK/TODO]
  marketing/engine.ts  [N]      [OK/TODO]
  marketing/channels/* [N]      [OK/TODO]
  cli/setup.ts         [N]      [OK/TODO]

------------------------------------------------------------
  GIT
------------------------------------------------------------
  Branch       [branch]
  Uncommitted  [N files changed]
  Last commit  [hash] [message] [time ago]

============================================================
```

## After Display

Note:
- Any compilation errors that need fixing
- Which TODO items are closest to completion
- If line count is approaching the 2,000 target, flag modules that could be trimmed
- If dependency count is approaching 15, flag which deps might be removable

## Formatting Rules

- Keep it compact — one screen
- Show real data from the checks, not placeholders
- Update the milestone checklist based on what actually exists and compiles in `src/`
- Do NOT use emojis unless user's previous messages use them

Now execute — run all checks in parallel and display the status.

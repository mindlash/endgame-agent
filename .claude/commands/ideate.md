# /ideate — Idea Triage & Brainstorm Session

Review, organize, and discuss design decisions and feature ideas for the EndGame Agent bounty project.

## What This Command Does

1. **Read the backlog** — Load `docs/IDEAS.md` and check for new items in the `## Inbox` section.

2. **Triage inbox items** — For each new idea in the Inbox:
   - Spin up the Product Owner (marcus-bergstrom-po) to assess value against the bounty requirements
   - Spin up the Tech Lead (alexander-lindgren-tech-lead) to assess feasibility, line count impact, and dependency cost
   - Spin up the Security Architect (lisa-nystrom-security-architect) if the idea touches key management, signing, or the LLM boundary
   - Discuss with the user: clarify intent, add detail, refine scope
   - Score and slot into High / Medium / Low priority

3. **Re-mesh the backlog** — After triage:
   - Move triaged ideas out of Inbox into their priority tier
   - Check if any items should be promoted (bounty requirements changed, dependency resolved)
   - Check if any High items have been implemented — move to `docs/IDEAS_COMPLETED.md`
   - Rewrite `docs/IDEAS.md` with the updated structure

4. **Report** — Summarize what changed: new ideas scored, priority shifts, items completed.

## Bounty Lens

Every idea is evaluated against:
- **Does it help win the bounty?** Which milestone does it serve (Auto-Claim, Marketing, Polish)?
- **Line budget:** Will it push us past the 2,000-line target?
- **Dependency cost:** Does it add a new dependency? We're targeting <15.
- **Security impact:** Does it cross the signing/marketing boundary?
- **Deployment simplicity:** Does it complicate the "under 5 minutes" setup target?

## When to Use

- You have a new feature idea or design question
- After a milestone ships and you want to reassess priorities
- During a planning session to decide what to build next
- When the bounty spec changes and you need to reprioritize

## Usage

```
/ideate
/ideate <new idea to add and discuss>
```

If an argument is given, it's added to the Inbox first, then the full triage runs.

## What It Produces

- Updated `docs/IDEAS.md` with clean structure and priority tiers
- Updated `docs/IDEAS_COMPLETED.md` if anything shipped
- A summary of decisions made and reasoning

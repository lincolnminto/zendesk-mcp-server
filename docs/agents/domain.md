# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/decisions/`**: read the ADR-style decision records that touch the area you're about to work in (this repo's existing convention — see references throughout `AGENTS.md`)

If either of these don't exist yet, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. `CONTEXT.md` is created lazily by the domain-modeling skill when terms actually get resolved. `docs/decisions/` already exists in this repo.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md
├── docs/decisions/
│   ├── client-retry.md
│   └── mutation-testing.md
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag decision conflicts

If your output contradicts an existing decision record, surface it explicitly rather than silently overriding:

> _Contradicts `docs/decisions/client-retry.md`, but worth reopening because…_

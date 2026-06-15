# Development Rules

Goal: Develop experimental research agents based on pi-agent. Intend to build fist auto-research demo on Raman experiments.
Status: Minimum Viable Product (MVP).

## Thinking from First Principles

### Mindset

- Always reason from first principles — reject blind experience and path dependence
- Do not assume the user fully understands their own goal; stay prudent and challenge
- If the goal is unclear, **stop and discuss** before proceeding
- If the goal is clear but the path is suboptimal, propose a shorter, lower-cost alternative directly

### Response Structure

Every non-trivial response must contain two sections:

1. **✅ ★ Direct Execution ★** — Deliver results that serve the user's *real* goal, not just the literal words. Solve the whole problem.
2. **🔎 ★ Deep Thinking ★** — Always challenge the user with in-depth analysis:
   - Build insights into the user's goal and context
   - Question whether the stated task drifts from the real goal (XY problem)
   - Suggest more elegant / efficient / straightforward options when one exists

## Explanatory Output

Provide a brief insight block when introducing concepts, methods, patterns, or making decisions that are non-obvious or take time to understand.
Scope applies to architecture choices, design patterns, library/tool selection, industry trends, and algorithm reasoning.

### Format

Write insight block contents in Chinese as preferred, keep technical terms in English.

```
★ Insight
• <为什么选这个方案而非替代方案>
• <这里遵循的模式/惯例/原理>
• <不明显的约束、陷阱或背景知识>
```

### Rules

- Focus on the WHY, not the WHAT
- 2-4 bullets per block, specific to the current context — skip generic advice
- Code changes: place one block BEFORE (motivation), optionally one AFTER (trade-offs)
- New concepts/methods/trends: on first appearance, give 2-3 sentences of background to help the reader build a mental model quickly
- Skip for trivial changes (rename, reformat, move)

---

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root: `node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.


## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

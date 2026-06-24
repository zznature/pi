# Experiment Research Issue Plan

This folder now uses a two-layer structure:

- `ISSUE-*.md`: the 3 top-level GitHub issues we actually want to open
- `ER-*.md`: the older 7-way breakdown kept as local reference material

The recorded lab session that motivated these issues is:

- `assets/agent_sessions/v2_test_session_with_encrypted_content_compressed.jsonl`

## Top-level issues to import

| Order | ID | Priority | Summary | Merges |
| --- | --- | --- | --- | --- |
| 1 | ISSUE-01 | P0 | Real Raman V2 launch path must be self-consistent and planner-visible | `ER-01`, `ER-02`, `ER-03`, `ER-05` |
| 2 | ISSUE-02 | P1 | Simplify planner hardware planning surface and lab-state reads | `ER-04`, `ER-07` |
| 3 | ISSUE-03 | P1.5 | Add a first-class Raman autofocus-only mode | `ER-06` |

## Suggested milestones

- `M1 real-v2-launch-trust`
  - Goal: make the real Raman V2 launch path trustworthy and planner-visible
  - Issues: `ISSUE-01`

- `M2 planner-surface-simplification`
  - Goal: reduce planner ambiguity, fake readiness, and redundant state traffic
  - Issues: `ISSUE-02`

- `M3 raman-autofocus-model`
  - Goal: represent Raman autofocus-only as a first-class bounded state
  - Issues: `ISSUE-03`

## Suggested working rules

1. Land a failing regression test before each fix.
2. Fix contract mismatches before prompt/planner tuning.
3. Treat `ISSUE-03` as a model/design change, not a prompt tweak. Write a
   short ADR first to define the minimum semantics of "autofocus-only".
4. Keep the planner simple by pushing complexity into contract clarity and data
   modeling rather than into more prompt exceptions.
5. Keep the old `ER-*.md` files as detailed implementation notes until the 3
   top-level issues are closed.

## Focused implementation checklists

- `CHECKLIST-safety-alignment-and-bridge-asserts.md`
  - Goal: resolve the current safety-contract drift and add bridge-side runtime
    autofocus motion assertions before further Raman MVP simplification.
  - Covers:
    - `ISSUE-01` launch-path self-consistency and planner visibility
    - `ISSUE-03` autofocus safety/runtime semantics

## Suggested labels

- Area:
  - `area:runtime`
  - `area:prompt`
  - `area:planner`
  - `area:schema`
  - `area:tooling`
- Risk:
  - `risk:safety`
  - `risk:operator-trust`
  - `risk:planner-misfire`
- Tracking:
  - `blocks:mvp-lab-demo`

## GitHub import

Use [import-github-issues.ps1](</D:/FileSync/Projects/Agents/pi/assets/issues/import-github-issues.ps1>)
to create the 3 top-level issues directly in GitHub through the REST API. By
default, the script imports `ISSUE-*.md`, not the older `ER-*.md` files.

The script:

- reads top-level issue templates from this folder;
- parses title, metadata, and issue body;
- creates missing labels;
- creates missing milestones;
- creates GitHub issues in the target repository;
- writes a local result map to `assets/issues/github-import-result.json`.

### Prerequisites

1. Create a GitHub token with issue write permission for the target repo.
2. Set `GITHUB_TOKEN` in the shell.
3. Run a dry-run first.

### Example

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
powershell -ExecutionPolicy Bypass -File .\assets\issues\import-github-issues.ps1 -Repo zznature/pi -DryRun
powershell -ExecutionPolicy Bypass -File .\assets\issues\import-github-issues.ps1 -Repo zznature/pi
```

### Import selected files

```powershell
powershell -ExecutionPolicy Bypass -File .\assets\issues\import-github-issues.ps1 `
  -Repo zznature/pi `
  -IssueFiles ISSUE-01-real-raman-v2-launch-path-must-be-self-consistent-and-planner-visible.md,ISSUE-02-simplify-planner-hardware-planning-surface-and-lab-state-reads.md `
  -DryRun
```

### Notes

- `-Repo` defaults to the current repo `origin` remote when possible.
- Use `-IssueFiles` to import the older `ER-*.md` files explicitly if needed.
- Dependency metadata such as `Depends on` / `Blocks` is preserved in the issue
  body and echoed in the local result map; GitHub native dependency linking is
  not created automatically.

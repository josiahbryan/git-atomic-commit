# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A CLI tool that wraps `git add` + `git commit` into a single locked operation, preventing race conditions when multiple AI agents (or developers) work in the same repo simultaneously. The lock is a `.git/atomic-commit.lock/` directory using POSIX `mkdir` atomicity.

Best used alongside [git-guardrails](https://github.com/josiahbryan/git-guardrails), which blocks dangerous git operations and — when it detects git-atomic-commit is installed — automatically enforces that agents use atomic commits instead of raw `git add` + `git commit`.

## Commands

```bash
bun test              # Run all tests (bun:test, 22 tests)
bun run build         # Compile native binary to dist/
bun run setup         # Build + install to /usr/local/bin/
bun run uninstall     # Remove from /usr/local/bin/
bun src/cli.ts <cmd>  # Run CLI locally without building
```

## Architecture

- **`src/cli.ts`** — The CLI and all logic (lock management, atomic commit, rollback). Uses `commander` for arg parsing. Lock state lives in `.git/atomic-commit.lock/lock.json`. All git subprocesses are called with `GIT_ATOMIC_COMMIT=1` env var so git-guardrails allows them through.
- **`src/cli.test.ts`** — Full test suite using `bun:test`.
- **`scripts/`** — Shell scripts for install, uninstall, remote install (curl one-liner), and cross-platform release.

### Build

`bun build --compile` produces a self-contained native binary (no runtime dependencies). Cross-compilation for 4 platforms is handled by `scripts/release.sh`.

### Lock lifecycle

`acquireLock()` tries `mkdirSync()` — exactly one process wins. If the dir exists, it checks staleness (TTL expired or owning PID dead + grace period). Stale locks are stolen with a retry race guard. `releaseLock()` does `rmSync(recursive)`.

### Commit rollback

On commit failure, only files that were NOT already staged before the operation are unstaged. Tracked vs untracked files use different unstage strategies (`git reset HEAD` vs `git rm --cached`). The lock is always released via `try/finally` if this invocation acquired it (externally-held locks are preserved).

### Two usage modes

1. **One-shot** (`commit`): acquires lock, stages, commits, releases lock. Auto-rollback on failure.
2. **Multi-turn** (`lock` → work → `commit -o <owner>` → `unlock`): lock persists across commands via owner matching. The `commit` command detects an existing lock with matching owner and skips acquisition/release.

## Testing

Tests (`src/cli.test.ts`) create throwaway git repos in temp directories via `beforeEach`/`afterEach`. Each test gets a fresh repo. The `gac()` helper shells out to `bun src/cli.ts` in the temp repo's cwd. Use `--no-verify` in test commits to skip hooks.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `scripts/install.sh` and `scripts/install-remote.sh` now ad-hoc codesign the binary on macOS after copy/move (`codesign --force --sign -`). Without this, macOS Gatekeeper SIGKILLs the binary on first launch with no output (exit code 137) because `cp` to `/usr/local/bin/` inherits the `com.apple.provenance` xattr (which can't be removed even with sudo), and `curl` adds `com.apple.quarantine`. Ad-hoc signing stamps a stable cdhash that bypasses the kill — the same trick Homebrew uses for unsigned bottles. Also tightened the verification warning to point macOS users at `codesign --force --sign -` instead of the misleading "Check that $INSTALL_DIR is in your PATH" message that fired regardless of the actual failure mode.

## [1.4.0] - 2026-05-02

### Fixed

- `commit` now actually commits **only** the files passed via `--files`. Previously the tool only inspected which files were already staged and used that for rollback — but the underlying `git commit` writes the entire index, so any unrelated files an agent had staged were silently bundled into the commit (e.g. eight unrelated paths from another agent ending up in a "refactor" commit). The fix captures each prior-staged path's index-vs-HEAD status, temporarily removes unrelated entries from the index for the duration of the commit (`git rm --cached` for `A`, `git reset HEAD --` for everything else), and restores them afterward (`git add` for `A`/`M`/`R`/`C`/`T`, `git rm --cached` for `D`). Restore runs from `finally` and from the Ctrl+C signal handler, so prior staged work is never silently lost on failure or interrupt. The lock is held until restoration completes, so no other agent can race the index during recovery.
- The Ctrl+C cleanup handler now restores temporarily-unstaged files in addition to releasing the lock, including in multi-turn mode (where the lock is held externally and is *not* released by the handler, but staging restore still runs).

### Changed

- The `commit` action refuses to operate when an unrelated staged file ALSO has unstaged working-tree changes (typical of `git add -p` partial-hunk staging). Re-staging via `git add <file>` would silently fold the unstaged hunks into the index — the opposite of "atomic" — so the command exits with a clear, actionable error before touching the index, telling the user to commit or stash the partial-hunk selection first.
- The "already staged" log line now distinguishes between **unrelated** (will be temp-unstaged and restored) and **also in --files** (overlap; will be committed) so it's obvious what the tool is about to do with each.

### Tests

- Cover isolation success path, restore-on-commit-failure, staged deletion preservation across atomic commit, overlap (file is both in priorStaged and in `--files`), partial-hunk refusal, and Ctrl+C-during-hook restoring unrelated staging.

## [1.3.3] - 2026-04-24

### Fixed

- Ctrl+C (and `SIGTERM` / `SIGHUP`) during a `commit` — typically while waiting on a slow pre-commit hook — now releases the lock before the process dies. Previously, Node's default `SIGINT` handler terminated the CLI with exit 130 *before* the `try/finally` around the commit could run, leaving a stale `.git/atomic-commit.lock/` directory until TTL expiry. The handler is only installed when this invocation acquired the lock, so multi-turn callers holding an external lock (`lock` → work → `commit -o <owner>` → `unlock`) are unaffected. Ownership is verified inside the handler so nothing gets cleared if another process already broke or stole the lock.

## [1.3.2] - 2026-04-16

### Changed

- `--wait` now sleeps a random 2–8 seconds between attempts instead of a fixed 3s. When multiple waiters are released by the same `unlock`, the jitter decorrelates them on subsequent polls so they stop colliding on identical ticks.

## [1.3.1] - 2026-04-16

### Fixed

- Multi-turn locks (`lock` → work → `commit -o <owner>` → `unlock`) no longer break after ~10 seconds. The `lock` command's PID was the short-lived CLI subprocess that exits immediately after acquiring, so the old PID-alive staleness heuristic incorrectly flagged the lock as stale past `STALE_PID_GRACE` (10s). Any owner — including the session itself — could then steal the lock, and `commit -o <owner>` would silently steal-and-release instead of reusing. Locks acquired by the `lock` command now store a detached-PID sentinel (`-1`) and rely on TTL alone for staleness. Crash recovery for one-shot `commit` still uses real process PIDs.
- `status` now shows `(detached — multi-turn lock)` for locks held by the `lock` command, and `LockHeldError` messages label detached locks clearly instead of printing `pid -1`.

## [1.3.0] - 2026-04-16

### Added

- `--wait <seconds>` / `-w` option on `commit` and `lock`. When set, the command polls every 3 seconds for the lock and only fails if it can't be acquired within the timeout. Default `0` preserves the existing fail-immediately behavior.
- `LockHeldError` class so the wait loop can retry only on "lock held by another owner" and let other errors propagate.
- `sleepSync` helper using `Atomics.wait` (no CPU spin while polling).
- Tests covering `--wait` timeout, `lock --wait` acquiring after release, and `commit --wait` acquiring after release.

## [1.2.0] - 2026-04-16

### Fixed

- `--version` reads from `package.json` (embedded in compiled binaries) instead of a hardcoded string that could drift from releases.
- `commit` no longer runs plain `git add` on paths that would revive a staged deletion (`git rm --cached` with the file still on disk); those paths are skipped and logged so the removal can be committed as intended. The same safeguard applies when the path is a **dangling symlink** (still present in the working tree but not followed by `existsSync`).
- `git commit` (and other passthrough git calls) now capture and replay stdout/stderr so hook failures and other git output are visible to the caller instead of disappearing behind inherited stdio.
- `git add` failures now surface their underlying git output too, so bad paths/pathspec errors are visible instead of being reduced to a generic rollback message.
- Shebang remains the first line so Bun executes the entry file correctly.

### Changed

- `--files` / `-f` arguments are treated as **exact literal paths**: staging, rollback, and `ls-files` queries use Git `:(literal)` pathspecs so glob characters in real filenames (e.g. a file literally named `*.txt`) work as intended and directory-style broad matching is avoided. On-disk **directories** are rejected; if a path is missing on disk but would match tracked or staged entries *under* that prefix (e.g. deleted `dir/` with only `dir/a.txt` in Git), the command fails fast with a clear error instead of staging multiple paths.
- **Symlinks** that point at directories are still allowed as a single index entry (directory check uses `lstat`, not `stat`).
- Commit failure handling logs a short summary when git produced no captured output but the error has a message (avoids duplicate noise when hook output was already replayed).
- Rollback messaging now says whether the atomic operation failed during staging or during commit, which makes path problems and hook rejections much easier to diagnose.

### Added

- `tsconfig.json` with strict checking; devDependencies `@types/node` and `@types/bun` for editor and `tsc` tooling.

### Tests

- Pass `GIT_ATOMIC_COMMIT=1` for raw `git` subprocesses so environments with git-guardrails match the CLI.
- Cover staged-deletion edge case, `git add` pathspec failures, commit-msg hook output surfacing on failure, rollback after commit failure when a staged deletion was skipped from `git add`, literal glob-like filenames, directory and deleted-prefix rejection, symlinks (including dangling), and symlink-to-directory paths.

## [1.0.0] - 2026-04-16

### Added

- `commit` command: atomic stage + commit with repo-wide lock and automatic rollback on failure
- `lock` / `unlock` commands: multi-turn commit transactions for long-running workflows
- `renew` command: extend lock TTL without releasing
- `status` command: inspect current lock state
- `break-lock` command: emergency lock removal
- Stale lock detection via TTL expiry and dead-PID heuristic
- Atomic lock acquisition using POSIX `mkdir`
- Correct rollback for both tracked and untracked files
- `--no-verify` flag to skip pre-commit hooks
- Idempotent installer (`bun run setup`)

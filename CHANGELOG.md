# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **End-of-stdout `[<branch> <sha>] <subject>` re-emission on successful commits.** Native `git commit` prints this line once near the start of its output, but downstream tools that buffer commit output (notably Claude Code's Bash tool, which truncates large outputs FROM THE MIDDLE) routinely drop it when the precommit pipeline emits a lot of text. The result is silent commit-attribution misses: parsers like `agent-hooks.ts#extractCommitShaFromOutput` (used by Rubber's BC task-attribution path) see no `[branch sha]` line and skip writing the (task, sha) linkage row. Re-emitting at the very end — after `[git-atomic-commit] Lock released.` — guarantees the SHA survives middle-truncation. Format mirrors git's native shape exactly (`[<branch> <short-sha>] <subject>`, using `git rev-parse --short=8 HEAD`) so existing regexes like `/^\[[^\]]+ ([0-9a-f]{7,40})\]/` match unchanged; consumers that scan for the LAST match (the documented agent-hooks behaviour) get the trailing SHA authoritatively. Best-effort: if HEAD-read fails after a successful commit (transient git error, repo damage), skip silently rather than turning a successful commit into a failed exit. Only emitted on the success path — failure rollback leaves stdout untouched. Two new tests in `cli.test.ts` cover both branches.

### Fixed

- **A pre-commit hook that stages a file of its own no longer leaves that file staged as a REVERSION in the real index (BDL-2670).** Follow-up to the private-index change below, and a prerequisite for installing it. The private index is seeded from HEAD, so a hook's own `git add` (rubber's `admin-app/src/index.js` auto-version-bump is the sanctioned case) lands in the throwaway index; the real `.git/index` never learns about it and is left holding that path's PRE-BUMP blob while HEAD holds the new one. `git status` renders that as `MM <path>` — a staged reversion of the bump. Measured on a throwaway repo with a bumping pre-commit hook: the pre-private-index binary left `git status --porcelain` EMPTY, the private-index build left `MM admin-app/src/index.js`. On a shared checkout that is the failure this change set exists to stop — a staged path blocks every merge on the checkout, and the next agent's commit sweeping it re-reverts the bump. The post-commit real-index sync now covers the paths the commit ACTUALLY contains (`git diff-tree --no-commit-id --name-only -r --root HEAD`), not just the declared `--files`. Paths temp-unstaged from another agent are excluded from the sync — that index entry is theirs, and the existing restore in `finally` is what puts it back. `--root` is load-bearing: without it `diff-tree` has no parent on a root commit and prints nothing, an empty result indistinguishable from "no extra paths". Best-effort throughout: a failure resolving the commit's paths degrades to the previous declared-files-only behaviour rather than failing an already-successful commit. Three new tests cover both directions (ride-along still lands; no staged reversion; a foreign agent's prior staging is not synced away).
- **The commit is now built in a PRIVATE index, so a concurrent writer can no longer have its staged files captured into someone else's commit (BDL-2671).** A bare `git commit` commits whatever `.git/index` contains AT COMMIT TIME, which made this tool's isolation *temporal*: snapshot the index, temp-unstage what isn't ours, and race to commit before anyone else writes it. The exposed window spans staging, the ENTIRE pre-commit hook run (measured at 5m24s on a real monorepo) and the commit itself — and `.git/index` is shared mutable state that any process may write: another agent, a husky hook that lints and re-adds, an editor's git integration. None of them participate in this tool's lock, so no amount of locking against ourselves could close it. Measured consequence in a Rubber checkout on 2026-08-16: commit `e6f1ba3423` carried the message `perf(bc): GetSubscriptionOverview aggregates in SQL (BDL-2643)` and contained exactly two files belonging to a THIRD agent and none of the subscription work; the mislabeled commit read as corruption and triggered a `git reset` that destroyed 1225 lines of unrelated verified work. Staging and the commit now run against a throwaway index file under `.git`, seeded from HEAD via `git read-tree`, so the committed tree is "HEAD plus exactly the declared `--files`" **by construction** rather than by winning a race. The shared index is never written during the window, so a concurrent agent's staging is left byte-intact — including partial-hunk (`git add -p`) selections. After a successful commit the real index entries for the declared paths only are brought up to the new HEAD (`git reset -q HEAD -- <files>`), which is exactly the state a plain `git commit` leaves behind. A staged deletion the caller asked us to carry (`git rm --cached` with the file still on disk) is re-applied into the private index via `git update-index --force-remove`, preserving the existing skip-`git add` behaviour. An explicit pre-commit assertion fails loudly if anything outside the declared `--files` set is ever present in the commit index.
- **`commit --files` now refuses to run while a merge is in progress.** The commit index is built from HEAD plus `--files`, so a subset commit mid-merge would drop the merge's auto-merged content while git still recorded a two-parent commit — a silent, permanent revert that looks healthy to `git merge-base --is-ancestor`. The refusal is narrow: it fires only when `MERGE_HEAD` exists, never merely because unrelated files are staged. Conclude the merge with `git commit` / `git merge --continue` instead.

- **Test infrastructure: `createTestRepo` no longer calls `git config user.email`/`user.name`**, which the latest `git-guardrails` blocks (repo-config writes pollute other users committing in the same repo). Author and committer identity now flow in via `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` env vars on `GIT_TEST_ENV` — the guardrail's own recommended alternative. `gac()` also now passes `GIT_TEST_ENV` to its `execSync` so the inner `cli.ts` git subprocesses inherit the identity vars. All 63 tests passed pre-existing locally only because the developer's git config was set globally; pristine CI environments would have failed every test at setup.

## [1.5.0] - 2026-05-09

### Added

- **Process-bound critical-section mutex around the snapshot → temp-unstage → commit → restore phase.** A new sentinel file at `<gitdir>/atomic-commit.cs-lock`, created via `O_EXCL | O_CREAT`, serializes the index-mutating phase of every `commit` invocation regardless of owner. Closes a race that the existing owner-bound file lock cannot — same-owner callers (multi-step `lock` + `commit` + `unlock` flows) intentionally bypass the outer lock acquisition, so two parallel multi-step callers using the same owner could previously interleave their `temporarilyUnstage` windows and corrupt each other's index snapshots. The CS sentinel has no notion of ownership: every commit acquires it for the duration of the critical section. Stale sentinels (mtime older than 2 minutes) are reclaimed automatically; contention waits up to 60s with jittered 50–250ms backoff before failing with a clear error. Released before the outer lock so the next waiter snapshots a fully-restored index. Honored by the SIGINT/SIGTERM/SIGHUP handler so Ctrl+C during the critical section still cleans up the sentinel. Timings are tunable via `GAC_CS_STALE_MS`, `GAC_CS_WAIT_MS`, `GAC_CS_POLL_MIN_MS`, `GAC_CS_POLL_MAX_MS` env vars (intended for tests; not part of the public API).
- **Phantom staged-deletion auto-correct in `restoreUnrelatedStaging`.** When the new CS lock observes contention during a commit (i.e. another atomic-commit invocation was inside its own critical section when we entered), the snapshot we took may have caught that other process mid-`temporarilyUnstage` and our restore would re-apply a `D` status that was actually transient. The audit runs only when contention was observed, then for each re-applied `D`: if the on-disk file is byte-identical to HEAD's blob (verified via `git rev-parse HEAD:<path>` vs `git hash-object <path>`), the staged-D is a phantom — auto-corrected via `git reset HEAD --` and reported in stderr with a one-line warning naming the corrected paths. Conservative on every error path (preserves the staged-D if anything fails). When no contention is observed, the audit is a strict no-op — preserves the contract that intentional `git rm --cached` survives an atomic commit verbatim, exactly as pinned by the existing "preserves an unrelated staged deletion" test.

### Why

Both fixes target the same multi-agent failure mode reproduced in a Rubber checkout on 2026-05-09: three concurrent Claude sessions running atomic-commit against the same git checkout (one in `rubber/`, one in `rubber/ci/`, one in `rubber/managed-apps/avatar-sharing-christ/`) produced a permanent staged-deletion state on four files (`backend/CHANGELOG.md`, two `ChatSubsys*.ts` files, `chatbot/utils/langfuse.js`) — each subsequent commit's `restoreUnrelatedStaging` re-applied the `D` because it kept appearing in `priorStagedEntries`. The CS mutex prevents new corruption; the phantom-D auto-correct cleans existing corruption when contention is observed.

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

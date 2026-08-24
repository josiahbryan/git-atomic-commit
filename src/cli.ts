#!/usr/bin/env bun
/* eslint-env node */

import { Command } from 'commander';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	lstatSync,
	openSync,
	closeSync,
	statSync,
	constants as fsConstants,
} from 'node:fs';
import { isAbsolute, join, relative as pathRelative, resolve } from 'node:path';

import packageJson from '../package.json';

// ── Types & Constants ────────────────────────────────────────

interface LockInfo {
	owner: string;
	pid: number;
	acquiredAt: number; // epoch ms
	ttlSeconds: number;
}

const LOCK_DIR_NAME = 'atomic-commit.lock';
const DEFAULT_TTL_ATOMIC = 60;
const DEFAULT_TTL_TRANSACTION = 600;
const STALE_PID_GRACE = 10;
// Jittered poll interval — prevents thundering herd when multiple waiters
// synchronize on the same tick after a release.
const LOCK_WAIT_POLL_MIN_MS = 2000;
const LOCK_WAIT_POLL_MAX_MS = 8000;
// Sentinel PID for multi-turn `lock` commands — the acquiring CLI exits
// immediately, so its pid would always look dead. Detached locks rely on
// TTL alone for staleness.
const DETACHED_PID = -1;

class LockHeldError extends Error {
	constructor(public info: LockInfo, message: string) {
		super(message);
		this.name = 'LockHeldError';
	}
}

// ── Helpers ──────────────────────────────────────────────────

const PREFIX = '[git-atomic-commit]';

function log(msg: string) {
	console.log(`${PREFIX} ${msg}`);
}
function logError(msg: string) {
	console.error(`${PREFIX} ERROR: ${msg}`);
}

/** Wrap action handlers so thrown errors print cleanly instead of a stack trace */
function safeAction(fn: (...args: any[]) => void) {
	return (...args: any[]) => {
		try {
			fn(...args);
		} catch (err: any) {
			logError(err.message ?? String(err));
			process.exit(1);
		}
	};
}

function parseTtl(value: string): number {
	const n = parseInt(value, 10);
	if (isNaN(n) || n <= 0) {
		throw new Error(`Invalid --ttl value "${value}". Must be a positive integer.`);
	}
	return n;
}

function parseWait(value: string): number {
	const n = parseInt(value, 10);
	if (isNaN(n) || n < 0) {
		throw new Error(`Invalid --wait value "${value}". Must be a non-negative integer.`);
	}
	return n;
}

/** Sync sleep via Atomics.wait so we don't spin the CPU while polling. */
function sleepSync(ms: number): void {
	if (ms <= 0) return;
	const buf = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(buf, 0, 0, ms);
}

function jitteredPollMs(): number {
	const span = LOCK_WAIT_POLL_MAX_MS - LOCK_WAIT_POLL_MIN_MS;
	return LOCK_WAIT_POLL_MIN_MS + Math.floor(Math.random() * (span + 1));
}

// Env passed to all git subprocesses. GIT_ATOMIC_COMMIT=1 tells
// git-guardrails (if installed) to allow these calls through.
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_ATOMIC_COMMIT: '1' };

function git(...args: string[]): string {
	try {
		return execFileSync('git', args, {
			encoding: 'utf-8',
			stdio: 'pipe',
			env: GIT_ENV,
		}).trim();
	} catch (err: any) {
		if (err.stdout) return err.stdout.toString().trim();
		throw err;
	}
}

function gitPassthrough(...args: string[]): void {
	const result = spawnSync('git', args, {
		encoding: 'utf-8',
		stdio: 'pipe',
		env: GIT_ENV,
	});

	// Replay captured git output through this process so outer wrappers
	// can see the exact hook/git failure details instead of only our summary.
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);

	if (result.error) throw result.error;
	if (result.status !== 0) {
		const exitDetails = result.signal
			? `signal ${result.signal}`
			: `exit code ${result.status ?? 'unknown'}`;
		const error = new Error(`git ${args[0] ?? 'command'} failed with ${exitDetails}`);
		Object.assign(error, {
			stdout: result.stdout,
			stderr: result.stderr,
			status: result.status,
			signal: result.signal,
		});
		throw error;
	}
}

function gitCaptureAndReplay(...args: string[]): void {
	gitPassthrough(...args);
}

// ── Git Utilities ────────────────────────────────────────────

let _gitDir: string | undefined;
function getGitDir(): string {
	return (_gitDir ??= git('rev-parse', '--git-dir'));
}

let _repoRoot: string | undefined;
function getRepoRoot(): string {
	return (_repoRoot ??= git('rev-parse', '--show-toplevel'));
}

function getLockDir(): string {
	return join(resolve(getGitDir()), LOCK_DIR_NAME);
}

// ── Private commit index (BDL-2671) ──────────────────────────
//
// A bare `git commit` commits WHATEVER `.git/index` CONTAINS AT COMMIT
// TIME. That made this tool's isolation TEMPORAL — snapshot the index,
// temp-unstage what isn't ours, and race to commit before anyone else
// writes it. The exposed window spans staging, the entire pre-commit hook
// run (measured at 5m24s on a real monorepo) and the commit itself, and
// `.git/index` is a shared mutable resource that any other process may
// write: another agent, a husky hook that lints and re-adds, an editor's
// git integration. None of them know this tool's lock exists, so no
// amount of locking against OURSELVES can close it.
//
// Measured consequence: a foreign agent's staged files were absorbed into
// somebody else's commit, under somebody else's message, exit 0, with the
// reassuring "Restoring N previously-staged file(s)" line printed after
// the capture (a no-op, because the file was already committed).
//
// The fix is structural rather than temporal: build the commit in a
// PRIVATE index seeded from HEAD, so the committed tree is "HEAD plus
// exactly the declared --files" BY CONSTRUCTION, no matter what any other
// process does to `.git/index` meanwhile.

function headExists(): boolean {
	try {
		execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
			stdio: 'pipe',
			env: GIT_ENV,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * True while a merge is in progress. A private index seeded from HEAD
 * would drop the merge's auto-merged content entirely while still
 * producing a two-parent commit — a silent, permanent revert that looks
 * like a healthy merge to `git merge-base --is-ancestor`. Refuse instead.
 */
function mergeInProgress(): boolean {
	return existsSync(join(resolve(getGitDir()), 'MERGE_HEAD'));
}

/**
 * Run `run` with every git subprocess pointed at a throwaway index file
 * seeded from HEAD. The scratch file lives inside `.git` so it shares a
 * filesystem with the real index (git writes indexes via rename) and can
 * never appear in `git status`.
 */
let activePrivateIndex: { path: string; previous: string | undefined } | null =
	null;

/**
 * Tear down the private index if one is active: restore the git env and
 * delete the scratch file. Idempotent, never throws.
 *
 * MUST be called before any cleanup path that writes the index — the
 * signal handler's `restoreUnrelatedStaging` above all. The override
 * lives on the module-global git env, so a restore that runs while it is
 * still installed re-stages the other agent's files into a throwaway
 * file which is then deleted — destroying the very staging the restore
 * exists to protect. (Measured: Ctrl+C during a slow pre-commit hook left
 * the real index empty and leaked the scratch file.)
 */
function exitPrivateIndex(): void {
	const active = activePrivateIndex;
	if (!active) return;
	activePrivateIndex = null;
	if (active.previous === undefined) delete GIT_ENV['GIT_INDEX_FILE'];
	else GIT_ENV['GIT_INDEX_FILE'] = active.previous;
	try {
		rmSync(active.path, { force: true });
		rmSync(`${active.path}.lock`, { force: true });
	} catch {
		// Best effort — a leaked scratch file is inert (it is only ever
		// read via GIT_INDEX_FILE, which is no longer set).
	}
}

function withPrivateIndex<T>({ run }: { run: () => T }): T {
	const indexPath = join(
		resolve(getGitDir()),
		`atomic-commit-index-${process.pid}-${Date.now().toString(36)}`,
	);
	activePrivateIndex = {
		path: indexPath,
		previous: GIT_ENV['GIT_INDEX_FILE'],
	};
	GIT_ENV['GIT_INDEX_FILE'] = indexPath;
	try {
		execFileSync(
			'git',
			headExists() ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'],
			{ stdio: 'pipe', env: GIT_ENV },
		);
		return run();
	} finally {
		exitPrivateIndex();
	}
}

/**
 * Record a deletion for `paths` in the CURRENT index. Needed because the
 * private index is seeded from HEAD, where a path whose deletion the user
 * staged (`git rm --cached`, file still on disk) is present again.
 * `update-index` takes literal file names, not pathspecs.
 */
function removeFromIndex({ paths }: { paths: string[] }): void {
	if (paths.length === 0) return;
	execFileSync('git', ['update-index', '--force-remove', '--', ...paths], {
		stdio: 'pipe',
		env: GIT_ENV,
	});
}

/**
 * AC3: a commit must never contain paths outside its own declared change
 * set. With a HEAD-seeded private index this holds by construction, so a
 * violation here means an assumption broke — fail loudly rather than
 * write the commit. Paths *under* a declared directory are in scope.
 */
function assertCommitScopedToDeclaredFiles({ files }: { files: string[] }): void {
	const staged = git('diff', '--cached', '--name-only', '--no-renames', '-z');
	const declared = new Set(files);
	const extra = staged
		.split('\0')
		.filter(Boolean)
		.filter(
			(p) => !declared.has(p) && !files.some((f) => p.startsWith(`${f}/`)),
		);
	if (extra.length > 0) {
		throw new Error(
			`Refusing to commit: ${extra.length} path(s) outside the declared ` +
				`--files set are present in the commit index: ${extra.join(', ')}. ` +
				`The commit index is built from HEAD plus --files only, so this ` +
				`should be impossible — please report it.`,
		);
	}
}

/**
 * Bring the REAL index entries for `paths` up to the new HEAD after a
 * successful private-index commit — exactly the state a plain
 * `git commit` leaves behind. Without this the real index still holds the
 * pre-commit entry for every committed path, which `git status` renders
 * as a staged reversion. Scoped to the declared paths, so a concurrent
 * agent's staging of anything else is untouched. Best-effort: the commit
 * has already succeeded and must not be turned into a failure here.
 */
function syncRealIndexToHead({ paths }: { paths: string[] }): void {
	if (paths.length === 0) return;
	try {
		execFileSync(
			'git',
			['reset', '-q', 'HEAD', '--', ...toLiteralPathspecs({ paths })],
			{ stdio: 'pipe', env: GIT_ENV },
		);
	} catch {
		/* best effort — see doc comment */
	}
}

// ── Own-diff gates (run even under --no-verify) ──────────────
//
// `--no-verify` is meant to skip the repo's pre-commit HOOK SUITE (husky,
// lint-staged, etc.) — NOT to let a committer skip validation of their OWN
// diff. The single biggest cause of broken code reaching a shared branch is
// "--no-verify laundering": an agent passes --no-verify to dodge an
// unrelated hook failure (e.g. a peer's untracked stray tripping a
// check-missing hook) and thereby ALSO skips lint/typecheck on the very
// files it is committing. This gate closes that hole: whenever a repo
// configures an own-diff gate, git-atomic-commit runs it against the exact
// `-f` file list on EVERY commit, regardless of --no-verify.
//
// The gate is intentionally repo-owned — the tool stays generic and knows
// nothing about any particular repo's lint/typecheck layout. A repo opts in
// by either:
//   • setting GIT_ATOMIC_GATE_CMD to a shell command, or
//   • providing an executable `.git-atomic-gate` at the repo root.
// The gate receives the repo-relative file paths both as argv and as the
// newline-delimited GIT_ATOMIC_FILES env var (the latter is authoritative —
// it survives paths with spaces), and runs with cwd = repo root. A non-zero
// exit BLOCKS the commit.
//
// Emergency escape: GIT_ATOMIC_SKIP_GATES=1 skips the gate but logs a loud
// multi-line warning so the bypass is never silent. Repos with no gate
// configured are entirely unaffected (backward compatible no-op).

const GATE_SCRIPT_FILENAME = '.git-atomic-gate';

/** Truthy for "1"/"true"/"yes" (any case); false for unset/""/"0"/"false"/"no". */
function isTruthyEnv(value: string | undefined): boolean {
	if (value == null) return false;
	const v = value.trim().toLowerCase();
	return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

type GateCommand =
	| { kind: 'shell'; command: string }
	| { kind: 'exec'; path: string };

/**
 * Resolve the configured own-diff gate for this repo, if any.
 * GIT_ATOMIC_GATE_CMD wins over the `.git-atomic-gate` file.
 * Returns null when no gate is configured (backward-compatible no-op).
 */
function resolveGateCommand(): GateCommand | null {
	const envCmd = process.env['GIT_ATOMIC_GATE_CMD'];
	if (envCmd && envCmd.trim()) {
		return { kind: 'shell', command: envCmd };
	}
	let repoRoot: string;
	try {
		repoRoot = getRepoRoot();
	} catch {
		return null;
	}
	const gatePath = join(repoRoot, GATE_SCRIPT_FILENAME);
	try {
		if (existsSync(gatePath) && statSync(gatePath).isFile()) {
			return { kind: 'exec', path: gatePath };
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Run the repo's own-diff gate against `files`. Throws (blocking the commit)
 * if the gate exits non-zero. No-op when no gate is configured.
 *
 * Runs regardless of `--no-verify`: this validates the committer's own diff,
 * which `--no-verify` was never meant to skip. Set GIT_ATOMIC_SKIP_GATES=1
 * to bypass in a genuine emergency (logged loudly).
 */
function runOwnDiffGates({ files }: { files: string[] }): void {
	if (isTruthyEnv(process.env['GIT_ATOMIC_SKIP_GATES'])) {
		logError(
			'================================================================',
		);
		logError('GIT_ATOMIC_SKIP_GATES=1 — SKIPPING own-diff lint/typecheck gate.');
		logError('Your committed diff is NOT being checked. Emergencies only.');
		logError(
			'================================================================',
		);
		return;
	}

	if (files.length === 0) return;

	const gate = resolveGateCommand();
	if (!gate) return; // repo hasn't opted in — stay out of the way

	log(
		`Running own-diff gate on ${files.length} file(s) (runs even under --no-verify)...`,
	);

	const repoRoot = getRepoRoot();
	const gateEnv = {
		...process.env,
		GIT_ATOMIC_COMMIT: '1',
		// Authoritative, space-safe channel for the file list. argv is also
		// provided for convenience but GIT_ATOMIC_FILES should be preferred.
		GIT_ATOMIC_FILES: files.join('\n'),
	};

	const result =
		gate.kind === 'shell'
			? // Shell command: run verbatim. Files are passed ONLY via
				// GIT_ATOMIC_FILES — appending them as shell argv would splice
				// raw paths into the command string (past any redirects/pipes)
				// and corrupt it. The env var is the authoritative channel.
				spawnSync(gate.command, [], {
					cwd: repoRoot,
					stdio: 'inherit',
					env: gateEnv,
					shell: true,
				})
			: // Executable file: argv is safe (no shell interpolation), so pass
				// the file list directly as arguments in addition to the env var.
				spawnSync(gate.path, files, {
					cwd: repoRoot,
					stdio: 'inherit',
					env: gateEnv,
				});

	if (result.error) {
		throw new Error(
			`Own-diff gate could not be executed: ${result.error.message}. ` +
				`(Set GIT_ATOMIC_SKIP_GATES=1 to bypass in an emergency.)`,
		);
	}
	if (result.status !== 0) {
		const how = result.signal
			? `signal ${result.signal}`
			: `exit code ${result.status}`;
		throw new Error(
			`Own-diff gate failed (${how}) — commit blocked. Fix the reported ` +
				`lint/type errors in the file(s) you are committing, or set ` +
				`GIT_ATOMIC_SKIP_GATES=1 to bypass in a genuine emergency ` +
				`(the bypass is logged loudly).`,
		);
	}
	log('Own-diff gate passed.');
}

// ── Critical-section mutex (process-bound, for index-mutating phase) ─

/**
 * Sentinel file used to serialize the index-mutating critical section
 * (snapshot → temp-unstage → commit → restore) across concurrent
 * atomic-commit invocations. Distinct from the outer file-based TTL/PID
 * lock used by `lock`/`commit` because that one is OWNER-bound — a multi-
 * step caller intentionally shares an owner across many `commit` calls,
 * and same-owner invocations BYPASS the outer lock acquisition. That
 * bypass plus a parallel multi-step caller using the same owner can let
 * two processes interleave their `temporarilyUnstage` windows, which is
 * exactly how the staged-D corruption reproduces.
 *
 * This second lock is process-bound and unconditional: every commit
 * critical section acquires it, regardless of owner. Implementation is
 * an O_EXCL atomic file create; staleness is bounded by a 2-minute
 * mtime threshold so a crashed predecessor can't block forever.
 */
const CS_LOCK_FILENAME = 'atomic-commit.cs-lock';
// Defaults are tuned for production. Tests override via the GAC_CS_*
// env vars below to exercise contention and staleness in milliseconds
// instead of minutes; they are not part of the public API.
const CS_LOCK_STALE_MS = parseInt(
	process.env['GAC_CS_STALE_MS'] ?? '',
	10,
) || 120_000; // 2 minutes
const CS_LOCK_WAIT_MS = parseInt(
	process.env['GAC_CS_WAIT_MS'] ?? '',
	10,
) || 60_000;
const CS_LOCK_POLL_MIN_MS = parseInt(
	process.env['GAC_CS_POLL_MIN_MS'] ?? '',
	10,
) || 50;
const CS_LOCK_POLL_MAX_MS = parseInt(
	process.env['GAC_CS_POLL_MAX_MS'] ?? '',
	10,
) || 250;

let csLockHeld = false;
// Tracks whether the most recent enterCriticalSection() call had to wait
// for another process (saw EEXIST at least once). When true, a concurrent
// invocation was observed in this commit's window, and the snapshot we
// took may be contaminated by the other process's transient unstage —
// only THEN does the phantom-D auto-correct in restoreUnrelatedStaging
// fire. When false (no contention), we trust the snapshot and preserve
// any staged-D entries verbatim, matching the documented contract that
// atomic-commit never touches another agent's intentional prior staging.
let csLockContended = false;

function getCsLockPath(): string {
	return join(resolve(getGitDir()), CS_LOCK_FILENAME);
}

/**
 * Synchronous sleep used for spin-waits. Uses Atomics.wait on a private
 * SharedArrayBuffer so we don't busy-loop the CPU while polling.
 */
function csSleepSync(ms: number): void {
	const sab = new SharedArrayBuffer(4);
	const view = new Int32Array(sab);
	Atomics.wait(view, 0, 0, ms);
}

function csJitter(): number {
	return (
		CS_LOCK_POLL_MIN_MS +
		Math.floor(Math.random() * (CS_LOCK_POLL_MAX_MS - CS_LOCK_POLL_MIN_MS))
	);
}

/**
 * Enter the index-mutating critical section. Spins on O_EXCL until it
 * either creates the sentinel file or times out (CS_LOCK_WAIT_MS). If
 * the existing sentinel is older than CS_LOCK_STALE_MS it's assumed
 * orphaned (predecessor crashed without releasing) and removed.
 */
function enterCriticalSection(): void {
	if (csLockHeld) return;
	csLockContended = false;
	const path = getCsLockPath();
	const start = Date.now();
	while (true) {
		try {
			const fd = openSync(
				path,
				fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
				0o644,
			);
			try {
				writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
			} finally {
				closeSync(fd);
			}
			csLockHeld = true;
			return;
		} catch (err: any) {
			if (err?.code !== 'EEXIST') throw err;
			// Contention observed — a concurrent atomic-commit invocation
			// was inside its critical section when we tried to enter. Mark
			// so restoreUnrelatedStaging knows the snapshot it took may
			// have caught a transient unstage from that other process.
			csLockContended = true;
			// Staleness check — sentinel from a crashed predecessor.
			try {
				const st = statSync(path);
				const age = Date.now() - st.mtimeMs;
				if (age > CS_LOCK_STALE_MS) {
					rmSync(path, { force: true });
					continue;
				}
			} catch {
				// Sentinel disappeared between EEXIST and stat — retry create.
				continue;
			}
			if (Date.now() - start > CS_LOCK_WAIT_MS) {
				throw new Error(
					`atomic-commit critical-section lock contention: another ` +
						`atomic-commit invocation has held ${path} for >${CS_LOCK_WAIT_MS / 1000}s. ` +
						`If you believe the lock is orphaned, remove the sentinel manually.`,
				);
			}
			csSleepSync(csJitter());
		}
	}
}

/** Release the critical-section sentinel. Idempotent; safe to call from finally. */
function exitCriticalSection(): void {
	if (!csLockHeld) return;
	try {
		rmSync(getCsLockPath(), { force: true });
	} catch {
		// best-effort
	}
	csLockHeld = false;
}

/**
 * One staged path with its index-vs-HEAD status code:
 *   A = added, M = modified, D = deleted, R = renamed,
 *   C = copied, T = type-change, U = unmerged.
 *
 * We capture the status (not just the path) because restoring an unrelated
 * file's staged state correctly depends on which kind of change it was —
 * a staged deletion needs `git rm --cached`, but a staged add/modify needs
 * `git add` to put it back into the index.
 */
interface PriorStagedEntry {
	path: string;
	status: string;
}

/**
 * Read the set of files currently staged (index vs HEAD) along with each
 * file's status code. Uses `-z` so paths with spaces, quotes, or other
 * special characters round-trip safely instead of being shell-quoted by git.
 *
 * `-z` output format:
 *   STATUS\0PATH\0
 * For renames/copies (R/C), git emits two paths, source then destination:
 *   R100\0SRC\0DST\0
 * We treat the destination as the canonical "currently staged" path because
 * that's what shows up in subsequent index queries.
 */
function getPriorStagedEntries(): PriorStagedEntry[] {
	const output = git('diff', '--cached', '--name-status', '-z');
	if (!output) return [];

	const tokens = output.split('\0').filter((t) => t.length > 0);
	const entries: PriorStagedEntry[] = [];
	let i = 0;
	while (i < tokens.length) {
		const rawStatus = tokens[i++];
		if (!rawStatus) continue;
		const status = rawStatus[0] ?? '';
		if (status === 'R' || status === 'C') {
			// Skip the source path; use the destination as the staged path.
			i++;
			const dst = tokens[i++];
			if (dst) entries.push({ path: dst, status });
		} else {
			const path = tokens[i++];
			if (path) entries.push({ path, status });
		}
	}
	return entries;
}

/**
 * Files that have unstaged working-tree changes vs the index. Used to detect
 * the partial-hunk staging case where a single file appears in BOTH
 * `--cached` and worktree diffs (e.g. `git add -p` selected some hunks but
 * not others). Our isolation strategy can't preserve that selection, so we
 * refuse to operate when this would silently destroy the user's choices.
 */
function getWorkingTreeModifiedFiles(): Set<string> {
	const output = git('diff', '--name-only', '-z');
	if (!output) return new Set();
	return new Set(output.split('\0').filter((t) => t.length > 0));
}

/**
 * Detects unrelated staged files that ALSO have unstaged working-tree
 * changes. If we proceeded, our restore step would `git add <file>` which
 * folds the unstaged hunks into the index, silently destroying the user's
 * partial-hunk selection from `git add -p`. Caller should bail with a clear
 * error in this case.
 */
function findPartiallyStagedUnrelated({
	unrelated,
}: {
	unrelated: PriorStagedEntry[];
}): string[] {
	if (unrelated.length === 0) return [];
	const workingTreeModified = getWorkingTreeModifiedFiles();
	return unrelated
		.filter((e) => workingTreeModified.has(e.path))
		.map((e) => e.path);
}

/**
 * Move unrelated staged entries out of the index so the upcoming
 * `git commit` only writes the files passed via `-f`. Working-tree contents
 * are untouched — only the index is changed. The reverse operation is
 * `restoreUnrelatedStaging` which we run from `finally` (and from the
 * signal handler) so the user's prior staging state is recovered no matter
 * how this command terminates.
 *
 * Two index operations are needed because git treats them differently:
 *   - Newly added files (status 'A') are not in HEAD, so `git reset HEAD`
 *     would fail or leave a phantom entry. Use `git rm --cached` instead.
 *   - Everything else (M/D/R/C/T) is in HEAD; `git reset HEAD` puts the
 *     index entry back to its HEAD state, leaving the working tree alone.
 */
function temporarilyUnstageUnrelated({
	unrelated,
}: {
	unrelated: PriorStagedEntry[];
}): void {
	if (unrelated.length === 0) return;

	const newlyAdded = unrelated
		.filter((e) => e.status === 'A')
		.map((e) => e.path);
	const tracked = unrelated
		.filter((e) => e.status !== 'A')
		.map((e) => e.path);

	if (tracked.length) {
		execFileSync(
			'git',
			['reset', 'HEAD', '--', ...toLiteralPathspecs({ paths: tracked })],
			{ stdio: 'pipe', env: GIT_ENV },
		);
	}
	if (newlyAdded.length) {
		execFileSync(
			'git',
			[
				'rm',
				'--cached',
				'--',
				...toLiteralPathspecs({ paths: newlyAdded }),
			],
			{ stdio: 'pipe', env: GIT_ENV },
		);
	}
}

/**
 * Re-apply the prior staging state captured by `getPriorStagedEntries`.
 * Best-effort per file — if one entry can't be restored (e.g. another
 * process raced us and removed the file from disk), we log and continue
 * so we still recover as much of the user's staging as possible.
 *
 * Status mapping:
 *   - D (staged deletion): `git rm --cached` re-stages the deletion. This
 *     handles both the "file deleted from disk + indexed" and the
 *     `git rm --cached` (file kept on disk, removed from index) cases —
 *     either way, the staged state we want is "absent from index".
 *   - A/M/R/C/T: `git add -f` re-stages the current working-tree contents.
 *     Force is intentional here: the file was already staged before we
 *     touched it, so restore must preserve that index state even if an
 *     ignore rule would reject a plain `git add` after temporary unstaging.
 *     We deliberately do NOT capture and restore the original blob, so
 *     this loses partial-hunk selections (which is why the commit action
 *     refuses to proceed when those are detected — see
 *     `findPartiallyStagedUnrelated`).
 */
function restoreUnrelatedStaging({
	unrelated,
}: {
	unrelated: PriorStagedEntry[];
}): void {
	if (unrelated.length === 0) return;

	const failures: string[] = [];
	const reAppliedDeletes: string[] = [];
	for (const entry of unrelated) {
		try {
			if (entry.status === 'D') {
				execFileSync(
					'git',
					[
						'rm',
						'--cached',
						'--',
						toLiteralPathspec({ relativePath: entry.path }),
					],
					{ stdio: 'pipe', env: GIT_ENV },
				);
				reAppliedDeletes.push(entry.path);
			} else {
				execFileSync(
					'git',
					[
						'add',
						'-f',
						'--',
						toLiteralPathspec({ relativePath: entry.path }),
					],
					{ stdio: 'pipe', env: GIT_ENV },
				);
			}
		} catch {
			failures.push(entry.path);
		}
	}

	if (failures.length > 0) {
		logError(
			`Failed to restore prior staging for ${failures.length} file(s): ${failures.join(', ')}. You may need to re-stage them manually.`,
		);
	}

	// Phantom-D self-correct. ONLY runs when the critical-section lock
	// observed contention during this commit (csLockContended === true) —
	// i.e., another atomic-commit was already inside its own critical
	// section when we entered, which means the snapshot we took may have
	// caught that other process mid-`temporarilyUnstage`. Without
	// contention, a `D` entry is presumed intentional (e.g. user ran
	// `git rm --cached` directly) and we preserve it verbatim, matching
	// the no-contention contract pinned by the existing
	// "preserves an unrelated staged deletion" test.
	if (csLockContended && reAppliedDeletes.length > 0) {
		const corrected: string[] = [];
		for (const path of reAppliedDeletes) {
			if (isPhantomStagedDelete(path)) {
				try {
					execFileSync(
						'git',
						[
							'reset',
							'HEAD',
							'--',
							toLiteralPathspec({ relativePath: path }),
						],
						{ stdio: 'pipe', env: GIT_ENV },
					);
					corrected.push(path);
				} catch {
					// Best-effort. If the correction fails, the original
					// staged-D persists and the user will see it in
					// `git status`. The warning below still fires.
				}
			}
		}
		if (corrected.length > 0) {
			logError(
				`Auto-corrected ${corrected.length} phantom staged-deletion(s) ` +
					`(disk content matches HEAD; the D status was a transient artifact ` +
					`from a concurrent atomic-commit invocation): ${corrected.join(', ')}. ` +
					`If you DID intend to delete those files, re-run \`git rm --cached <path>\`.`,
			);
		}
	}
}

/**
 * Detect a phantom staged-deletion: an index entry that says "deleted from
 * tracking" but whose on-disk content is byte-identical to HEAD's tracked
 * blob for the same path. Such entries are almost always artifacts of a
 * race between concurrent atomic-commit invocations — one process's
 * `temporarilyUnstageUnrelated` window was observed by another's snapshot,
 * which then re-applied the D in restore. Returns true when the staged-D
 * is suspicious enough to warrant auto-correction.
 *
 * Returns false (i.e. "this D is intentional, leave it alone") if any of:
 *   - The path doesn't exist on disk (genuine deletion in progress).
 *   - The path isn't in HEAD (can't compare; preserve user's intent).
 *   - HEAD's blob hash differs from the on-disk hash-object value
 *     (user modified the file and intended the staged delete).
 *   - Any git operation throws (conservative: don't auto-correct).
 */
function isPhantomStagedDelete(path: string): boolean {
	try {
		const absolutePath = resolve(getRepoRoot(), path);
		if (!existsSync(absolutePath)) return false;
		// `HEAD:<path>` accepts a plain path, not a pathspec magic prefix.
		// Use the raw relative path here. Quoting-safe because we never
		// shell-interpolate — execFileSync passes args as a list.
		const headBlob = git('rev-parse', `HEAD:${path}`).trim();
		if (!headBlob || headBlob.startsWith('fatal')) return false;
		const diskBlob = git('hash-object', '--', absolutePath).trim();
		return Boolean(headBlob) && headBlob === diskBlob;
	} catch {
		return false;
	}
}

/** Returns the set of files git considers tracked (exist in HEAD) */
function getTrackedFiles(files: string[]): Set<string> {
	if (files.length === 0) return new Set();
	// git ls-files silently omits untracked files from output
	const output = git('ls-files', '--', ...toLiteralPathspecs({ paths: files }));
	return new Set(output ? output.split('\n').filter(Boolean) : []);
}

function toLiteralPathspec({
	relativePath,
}: {
	relativePath: string;
}): string {
	return `:(top,literal)${relativePath}`;
}

function toLiteralPathspecs({ paths }: { paths: string[] }): string[] {
	return paths.map((relativePath) => toLiteralPathspec({ relativePath }));
}

function getLiteralTrackedMatches({
	relativePath,
}: {
	relativePath: string;
}): string[] {
	const output = git('ls-files', '--', toLiteralPathspec({ relativePath }));
	return output ? output.split('\n').filter(Boolean) : [];
}

function getLiteralStagedMatches({
	relativePath,
}: {
	relativePath: string;
}): string[] {
	const output = git(
		'diff',
		'--cached',
		'--name-only',
		'--',
		toLiteralPathspec({ relativePath }),
	);
	return output ? output.split('\n').filter(Boolean) : [];
}

function getNonExactLiteralMatches({
	relativePath,
}: {
	relativePath: string;
}): string[] {
	const matches = new Set([
		...getLiteralTrackedMatches({ relativePath }),
		...getLiteralStagedMatches({ relativePath }),
	]);
	return [...matches].filter((match) => match !== relativePath);
}

function pathExistsIncludingBrokenSymlink({
	relativePath,
}: {
	relativePath: string;
}): boolean {
	try {
		lstatSync(resolve(getRepoRoot(), relativePath));
		return true;
	} catch {
		return false;
	}
}

function isDirectoryInput({
	relativePath,
}: {
	relativePath: string;
}): boolean {
	const absolutePath = resolve(getRepoRoot(), relativePath);
	return pathExistsIncludingBrokenSymlink({ relativePath }) && lstatSync(absolutePath).isDirectory();
}

function toRepoRelativePath({ inputPath }: { inputPath: string }): string {
	const absolutePath = resolve(process.cwd(), inputPath);
	const relativePath = pathRelative(getRepoRoot(), absolutePath).replace(/\\/g, '/');
	if (
		relativePath.length === 0 ||
		relativePath === '..' ||
		relativePath.startsWith('../') ||
		isAbsolute(relativePath)
	) {
		throw new Error(`--files path must be inside the git worktree: ${inputPath}`);
	}
	return relativePath;
}

function toRepoRelativePaths({ paths }: { paths: string[] }): string[] {
	return paths.map((inputPath) => toRepoRelativePath({ inputPath }));
}

/**
 * This command deliberately stages exact file paths instead of supporting
 * arbitrary git pathspecs. That keeps the atomic contract predictable and
 * avoids broad inputs like `dir` accidentally staging or skipping unrelated
 * changes.
 */
function validateLiteralFileInputs({ paths }: { paths: string[] }): void {
	const directoryInputs = paths.filter((relativePath) => isDirectoryInput({ relativePath }));
	if (directoryInputs.length > 0) {
		throw new Error(
			`--files only accepts literal file paths. Directory inputs are not allowed: ${directoryInputs.join(', ')}`,
		);
	}

	for (const relativePath of paths) {
		if (pathExistsIncludingBrokenSymlink({ relativePath })) continue;

		const nonExactMatches = getNonExactLiteralMatches({ relativePath });
		if (nonExactMatches.length === 0) continue;

		throw new Error(
			`--files only accepts literal file paths. "${relativePath}" matches entries underneath it instead of one exact file: ${nonExactMatches.join(', ')}`,
		);
	}
}

/**
 * After `git rm --cached <path>`, the removal is staged but the working tree
 * copy often remains. Plain `git add <path>` would re-index that file and
 * undo the staged deletion. Skip `git add` for those paths so the deletion
 * stays staged (user can still commit the removal).
 */
/** True when this path's index-vs-HEAD status is a staged deletion (`D`). */
function isStagedDeletion({
	relativePath,
}: {
	relativePath: string;
}): boolean {
	const staged = git(
		'diff',
		'--cached',
		'--name-status',
		'--',
		toLiteralPathspec({ relativePath }),
	);
	const line = staged.split('\n')[0]?.trim() ?? '';
	return line.startsWith('D');
}

function fileWouldReviveStagedDeletion({
	relativePath,
}: {
	relativePath: string;
}): boolean {
	return (
		isStagedDeletion({ relativePath }) &&
		pathExistsIncludingBrokenSymlink({ relativePath })
	);
}

function pathsSafeForPlainGitAdd({ paths }: { paths: string[] }): string[] {
	return paths.filter((p) => !fileWouldReviveStagedDeletion({ relativePath: p }));
}

function stageFiles(files: string[]): void {
	if (files.length === 0) return;

	// Split present (add/modify) from absent (deleted from the working tree).
	// Plain `git add -- <path>` errors "pathspec did not match any files" on a
	// gone path, so deletions can never be committed via --files without this.
	const present: string[] = [];
	const absent: string[] = [];
	for (const f of files) {
		if (pathExistsIncludingBrokenSymlink({ relativePath: f })) present.push(f);
		else absent.push(f);
	}

	// Present files: plain `git add` (callers already filtered staged-deletion-
	// revival cases via pathsSafeForPlainGitAdd).
	if (present.length > 0) {
		gitCaptureAndReplay('add', '--', ...toLiteralPathspecs({ paths: present }));
	}

	// Deleted files: stage the REMOVAL. `git add -A` records deletions (plain
	// `git add` can't). Skip paths whose deletion is ALREADY staged — there's
	// nothing in the working tree or index for `-A` to match, so it would error
	// "pathspec did not match" even though the desired state is already achieved.
	const absentNeedingStage = absent.filter(
		(f) => !isStagedDeletion({ relativePath: f }),
	);
	if (absentNeedingStage.length > 0) {
		gitCaptureAndReplay(
			'add',
			'-A',
			'--',
			...toLiteralPathspecs({ paths: absentNeedingStage }),
		);
	}
}

/**
 * Unstage files, handling both tracked and new (untracked) files correctly.
 * - Tracked files: `git reset HEAD -- <files>` (removes staged diff)
 * - New files: `git rm --cached <files>` (removes from index, keeps working tree)
 */
function unstageFiles(files: string[], trackedFiles: Set<string>): void {
	const tracked = files.filter((f) => trackedFiles.has(f));
	const untracked = files.filter((f) => !trackedFiles.has(f));
	if (tracked.length) {
		try {
			execFileSync(
				'git',
				['reset', 'HEAD', '--', ...toLiteralPathspecs({ paths: tracked })],
				{ stdio: 'pipe', env: GIT_ENV },
			);
		} catch { /* best effort */ }
	}
	if (untracked.length) {
		try {
			execFileSync(
				'git',
				['rm', '--cached', '--', ...toLiteralPathspecs({ paths: untracked })],
				{ stdio: 'pipe', env: GIT_ENV },
			);
		} catch { /* best effort */ }
	}
}

function strictUnstageFiles(files: string[]): void {
	if (files.length === 0) return;
	const notStaged = files.filter((relativePath) => {
		const stagedMatches = getLiteralStagedMatches({ relativePath });
		return !stagedMatches.includes(relativePath);
	});
	if (notStaged.length > 0) {
		throw new Error(
			`Cannot unstage path(s) because they are not staged: ${notStaged.join(', ')}`,
		);
	}
	gitCaptureAndReplay('reset', 'HEAD', '--', ...toLiteralPathspecs({ paths: files }));
}

// ── Lock Management ──────────────────────────────────────────

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLock(): LockInfo | null {
	const lockDir = getLockDir();
	const lockFile = join(lockDir, 'lock.json');
	if (!existsSync(lockFile)) return null;
	try {
		return JSON.parse(readFileSync(lockFile, 'utf-8'));
	} catch {
		return null;
	}
}

function formatAge(info: LockInfo): string {
	return ((Date.now() - info.acquiredAt) / 1000).toFixed(0);
}

function isStale(info: LockInfo): boolean {
	const ageSeconds = (Date.now() - info.acquiredAt) / 1000;
	if (ageSeconds > info.ttlSeconds) return true;
	if (info.pid === DETACHED_PID) return false;
	if (!isPidAlive(info.pid) && ageSeconds > STALE_PID_GRACE) return true;
	return false;
}

function acquireLock(owner: string, ttlSeconds: number, detached = false): void {
	const lockDir = getLockDir();

	try {
		mkdirSync(lockDir);
	} catch (err: any) {
		if (err.code !== 'EEXIST') throw err;

		const info = readLock();
		if (info && !isStale(info)) {
			const pidLabel = info.pid === DETACHED_PID ? 'detached' : `pid ${info.pid}`;
			throw new LockHeldError(
				info,
				`Lock held by "${info.owner}" (${pidLabel}, age ${formatAge(info)}s, ttl ${info.ttlSeconds}s). ` +
					`Use 'status' to inspect, '--wait <seconds>' to poll, or 'break-lock' to force-remove.`,
			);
		}

		// Stale — steal it. Retry mkdir if another process races us.
		log(`Removing stale lock from "${info?.owner ?? 'unknown'}"`);
		rmSync(lockDir, { recursive: true });
		try {
			mkdirSync(lockDir);
		} catch (retryErr: any) {
			if (retryErr.code === 'EEXIST') {
				throw new Error(
					'Lost lock race to another process while stealing stale lock. Retry.',
				);
			}
			throw retryErr;
		}
	}

	const lockInfo: LockInfo = {
		owner,
		pid: detached ? DETACHED_PID : process.pid,
		acquiredAt: Date.now(),
		ttlSeconds,
	};
	writeFileSync(
		join(lockDir, 'lock.json'),
		JSON.stringify(lockInfo, null, 2),
	);
}

function acquireLockWithWait({
	owner,
	ttlSeconds,
	waitSeconds,
	detached = false,
}: {
	owner: string;
	ttlSeconds: number;
	waitSeconds: number;
	detached?: boolean;
}): void {
	const deadline = Date.now() + waitSeconds * 1000;
	let announced = false;
	while (true) {
		try {
			acquireLock(owner, ttlSeconds, detached);
			return;
		} catch (err) {
			if (!(err instanceof LockHeldError)) throw err;
			const now = Date.now();
			if (waitSeconds <= 0 || now >= deadline) throw err;
			if (!announced) {
				log(
					`Lock held by "${err.info.owner}" — polling every ${LOCK_WAIT_POLL_MIN_MS / 1000}-${LOCK_WAIT_POLL_MAX_MS / 1000}s (jittered) for up to ${waitSeconds}s...`,
				);
				announced = true;
			}
			sleepSync(Math.min(jitteredPollMs(), deadline - now));
		}
	}
}

function releaseLock(): void {
	const lockDir = getLockDir();
	if (existsSync(lockDir)) {
		rmSync(lockDir, { recursive: true });
	}
}

function verifyOwnership(owner: string): LockInfo {
	const info = readLock();
	if (!info) throw new Error('No lock held.');
	if (info.owner !== owner) {
		throw new Error(`Lock held by "${info.owner}", not "${owner}".`);
	}
	return info;
}

// Signals that should release the lock and terminate. SIGINT is Ctrl+C,
// SIGTERM is `kill`, SIGHUP is terminal close / parent exit.
const CLEANUP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Install signal handlers that clean up before the process dies. Without
 * this, Ctrl+C during a long pre-commit hook would kill the Bun process via
 * Node's default SIGINT handler (exit 130) *before* the try/finally around
 * the commit can run — leaving a stale lock directory and (with the
 * isolation logic) prior-staged files temporarily unstaged.
 *
 * Two cleanup tasks run on signal:
 *
 *   1. Restore unrelated prior-staged files (read live from
 *      `getUnrelatedToRestore` so the handler sees whatever's been captured
 *      so far — even if the signal arrives mid-isolation).
 *   2. Release the lock if `releaseLockOnSignal` is true. Multi-turn
 *      callers hold the lock externally and must not have it cleared by
 *      our interrupt, so the commit action passes false in that case.
 *
 * Restore happens BEFORE lock release so the lock still guarantees no race
 * with another agent while we're putting the index back. Ownership of the
 * lock is verified inside the handler so nothing gets cleared if something
 * else already broke or stole it during the hook run.
 *
 * Returns a disposer that removes the handlers when normal cleanup runs.
 */
function installLockCleanupHandlers({
	owner,
	releaseLockOnSignal,
	getUnrelatedToRestore,
}: {
	owner: string;
	releaseLockOnSignal: boolean;
	getUnrelatedToRestore?: () => PriorStagedEntry[];
}): () => void {
	const handler = (signal: NodeJS.Signals) => {
		const messages: string[] = [];
		try {
			// FIRST: drop the private-index override, so everything below
			// (restore, in particular) operates on the REAL index.
			exitPrivateIndex();
			const unrelated = getUnrelatedToRestore?.() ?? [];
			if (unrelated.length > 0) {
				try {
					restoreUnrelatedStaging({ unrelated });
					messages.push(
						`restored ${unrelated.length} prior-staged file(s)`,
					);
				} catch {
					// Best effort — we're terminating anyway.
				}
			}
			// Release the process-bound critical-section sentinel before
			// process exit so the next waiter isn't blocked for the full
			// CS_LOCK_STALE_MS window. Idempotent if not held.
			try {
				exitCriticalSection();
			} catch {
				// Best effort.
			}
			if (releaseLockOnSignal) {
				const info = readLock();
				if (info && info.owner === owner) {
					releaseLock();
					messages.push('lock released');
				}
			}
		} catch {
			// Swallow — we're already terminating; don't mask the signal exit.
		}
		const summary = messages.length > 0 ? ` — ${messages.join(', ')}.` : '.';
		logError(`Interrupted by ${signal}${summary}`);
		// Conventional exit code for signal-terminated processes.
		const signalNumbers: Record<string, number> = {
			SIGINT: 2,
			SIGTERM: 15,
			SIGHUP: 1,
		};
		process.exit(128 + (signalNumbers[signal] ?? 0));
	};

	for (const signal of CLEANUP_SIGNALS) {
		process.on(signal, handler);
	}

	return () => {
		for (const signal of CLEANUP_SIGNALS) {
			process.off(signal, handler);
		}
	};
}

// ── CLI ──────────────────────────────────────────────────────

const program = new Command();
program
	.name('git-atomic-commit')
	.description(
		'Atomic git stage+commit with repo-wide locking for multi-agent safety',
	)
	.version(packageJson.version);

// ── commit ───────────────────────────────────────────────────

program
	.command('commit')
	.description(
		'Atomically stage files and commit (acquires lock if not already held)',
	)
	.requiredOption('-f, --files <files...>', 'Files to stage and commit')
	.requiredOption('-m, --message <message>', 'Commit message')
	.option(
		'-o, --owner <owner>',
		'Lock owner identifier',
		`pid-${process.pid}`,
	)
	.option(
		'-t, --ttl <seconds>',
		'Lock TTL in seconds',
		String(DEFAULT_TTL_ATOMIC),
	)
	.option('--no-verify', 'Skip pre-commit hooks')
	.option(
		'-w, --wait <seconds>',
		'Poll for the lock up to this many seconds before failing (default: 0, fail immediately)',
		'0',
	)
	.action(safeAction((opts) => {
		const { message, owner, verify } = opts;
		const files = toRepoRelativePaths({ paths: opts.files });
		const ttl = parseTtl(opts.ttl);
		const waitSeconds = parseWait(opts.wait);
		validateLiteralFileInputs({ paths: files });

		// Own-diff gate: validate the committer's OWN files (scoped
		// lint/typecheck, defined by the repo) BEFORE touching the lock or
		// the index. Runs regardless of --no-verify — see runOwnDiffGates.
		// Placed here so a gate failure fast-fails with zero lock churn and
		// nothing left staged. No-op for repos that don't configure a gate.
		runOwnDiffGates({ files });

		// A subset commit mid-merge is never safe: the commit index is
		// built from HEAD plus --files, so the merge's auto-merged content
		// would be dropped while git still records a two-parent commit —
		// a silent revert that reads as a healthy merge to every ancestry
		// check. Let the merge auto-commit, or resolve and
		// `git merge --continue`. Narrow refusal: only during an actual
		// merge, never merely because unrelated files are staged.
		if (mergeInProgress()) {
			throw new Error(
				'Refusing to commit a --files subset while a merge is in progress ' +
					'(MERGE_HEAD exists). The merge has already staged its resolved ' +
					'files; committing a subset would silently drop the rest. Use ' +
					'`git commit` / `git merge --continue` to conclude the merge.',
			);
		}

		// Check if we already hold the lock (from a prior `lock` command)
		const existing = readLock();
		const weAcquired = !(existing && existing.owner === owner && !isStale(existing));

		if (!weAcquired) {
			log(`Using existing lock (owner: "${owner}")`);
		} else {
			log(`Acquiring lock as "${owner}"...`);
			acquireLockWithWait({ owner, ttlSeconds: ttl, waitSeconds });
			log('Lock acquired.');
		}

		// Tracks unrelated files we temporarily unstaged so we can restore
		// their staging in `finally` (and from the signal handler if the
		// user hits Ctrl+C). Declared here so the signal handler closure
		// reads the live value at signal time, not at registration time.
		let unrelatedToRestore: PriorStagedEntry[] = [];

		// Register signal handlers so Ctrl+C (e.g. during a slow pre-commit
		// hook) cleans up before the process dies. Lock release on signal
		// is gated on whether we acquired the lock — a multi-turn caller
		// holding an external lock must not have it cleared by our interrupt
		// — but staging restore runs in either case so the user's prior
		// staged work is never silently lost.
		const uninstallSignalHandlers = installLockCleanupHandlers({
			owner,
			releaseLockOnSignal: weAcquired,
			getUnrelatedToRestore: () => unrelatedToRestore,
		});

		// Everything after lock acquisition is wrapped in try/finally
		// so the lock is always released (if we acquired it) and
		// any temporarily-unstaged files are restored on any failure.
		let commitFailed = false;
		let failingPhase: 'staging' | 'commit' = 'staging';
		try {
			// Acquire the process-bound critical-section mutex BEFORE
			// snapshotting the index. The outer file-based lock above is
			// owner-bound and explicitly bypassed for same-owner callers
			// (multi-step `lock`+`commit`+...+`unlock` flows), so it does
			// NOT serialize two concurrent commits that share an owner.
			// This second lock does — it's an O_EXCL sentinel file with
			// no notion of ownership, just "one process at a time inside
			// the critical section." Released in the same finally below.
			enterCriticalSection();

			// Capture the full prior staging state (path + status code), then
			// split into "overlap" (also passed via -f, will be committed) and
			// "unrelated" (must be isolated out so they don't get bundled
			// into our commit). The overlap set is what the old rollback
			// logic used to call `priorStaged`.
			const priorStagedEntries = getPriorStagedEntries();
			const requestedSet = new Set<string>(files);
			const overlap = priorStagedEntries.filter((e) =>
				requestedSet.has(e.path),
			);
			const unrelated = priorStagedEntries.filter(
				(e) => !requestedSet.has(e.path),
			);
			const overlapPaths = new Set(overlap.map((e) => e.path));

			if (priorStagedEntries.length > 0) {
				const parts: string[] = [];
				if (unrelated.length > 0) {
					parts.push(
						`${unrelated.length} unrelated (will be temp-unstaged and restored after commit)`,
					);
				}
				if (overlap.length > 0) {
					parts.push(`${overlap.length} also in --files`);
				}
				log(
					`Note: ${priorStagedEntries.length} file(s) already staged: ${parts.join(', ')}`,
				);
			}

			// Refuse to operate when an unrelated staged file ALSO has
			// unstaged working-tree changes (typical of `git add -p` partial
			// hunks). Our restore re-stages with `git add <file>`, which
			// would silently fold the unstaged hunks into the index — the
			// opposite of "atomic". Bail out with a clear, actionable error
			// so the user can commit/stash the partial-hunk selection first.
			if (unrelated.length > 0) {
				const partial = findPartiallyStagedUnrelated({ unrelated });
				if (partial.length > 0) {
					throw new Error(
						`Cannot atomically commit: ${partial.length} unrelated staged file(s) ` +
							`also have unstaged working-tree changes (likely partial-hunk staging via ` +
							`\`git add -p\`): ${partial.join(', ')}. ` +
							`Atomic-commit isolates unrelated staging by temp-unstaging and re-staging, ` +
							`which would lose your partial-hunk selection. ` +
							`Please \`git commit\` or \`git stash\` those changes first, then retry.`,
					);
				}
			}

			if (unrelated.length > 0) {
				log(
					`Temporarily unstaging ${unrelated.length} unrelated file(s) to isolate the atomic commit: ${unrelated.map((e) => e.path).join(', ')}`,
				);
				// Mark for restore BEFORE attempting so even partial failures
				// (e.g. tracked reset succeeded but `rm --cached` of newly-
				// added files threw) get a best-effort restore from finally.
				unrelatedToRestore = unrelated;
				temporarilyUnstageUnrelated({ unrelated });
			}

			const trackedFiles = getTrackedFiles(files);

			try {
				const toStage = pathsSafeForPlainGitAdd({ paths: files });
				const skipped = files.filter((f: string) => !toStage.includes(f));
				if (skipped.length > 0) {
					log(
						`Skipping git add for ${skipped.length} path(s) (staged deletion; on-disk file would re-add to index): ${skipped.join(', ')}`,
					);
				}
				// Everything from here to the commit runs against a
				// PRIVATE index seeded from HEAD (see withPrivateIndex).
				// The shared `.git/index` is not written, so no concurrent
				// writer can put its staged files into this commit.
				withPrivateIndex({
					run: () => {
						log(`Staging ${toStage.length} file(s): ${toStage.join(', ') || '(none — using existing index)'}`);
						failingPhase = 'staging';
						stageFiles(toStage);
						// Seeded from HEAD, so a staged deletion the caller
						// asked us to carry has to be re-applied here.
						removeFromIndex({ paths: skipped });

						assertCommitScopedToDeclaredFiles({ files });

						const commitArgs = ['commit', '-m', message];
						if (verify === false) commitArgs.push('--no-verify');

						failingPhase = 'commit';
						log('Committing...');
						gitPassthrough(...commitArgs);
					},
				});
				log('Commit successful.');
				syncRealIndexToHead({ paths: files });
			} catch (err: any) {
				const hasGitOutput = Boolean(
					(err?.stdout && String(err.stdout).trim()) ||
					(err?.stderr && String(err.stderr).trim()),
				);
				if (!hasGitOutput && err?.message) {
					const failedCommand = failingPhase === 'staging' ? 'git add' : 'git commit';
					logError(`${failedCommand} failed: ${err.message}`);
				}
				logError(`Atomic operation failed during ${failingPhase} — rolling back staging...`);

				// Don't unstage overlap files — those were already staged by
				// someone else before this command ran, so leaving them
				// staged matches the contract that "this command never
				// touches another agent's prior staging".
				const toUnstage = files.filter(
					(f: string) => !overlapPaths.has(f),
				);
				unstageFiles(toUnstage, trackedFiles);
				log(`Rolled back ${toUnstage.length} file(s).`);
				commitFailed = true;
			}
		} finally {
			// Restore unrelated staging BEFORE releasing the lock so the
			// lock still guarantees no race with another agent while we're
			// putting the index back. Clear the tracker afterward so the
			// signal handler (still registered until uninstall below)
			// doesn't double-restore if a signal arrives during cleanup.
			if (unrelatedToRestore.length > 0) {
				log(
					`Restoring ${unrelatedToRestore.length} previously-staged file(s): ${unrelatedToRestore.map((e) => e.path).join(', ')}`,
				);
				try {
					restoreUnrelatedStaging({ unrelated: unrelatedToRestore });
				} catch (err: any) {
					logError(
						`Failed to restore prior staged files: ${err?.message ?? String(err)}`,
					);
				}
				unrelatedToRestore = [];
			}
			// Release the process-bound critical-section sentinel AFTER
			// restoreUnrelatedStaging completes, so the next waiter
			// snapshots a fully-restored index (not our transient state).
			exitCriticalSection();
			if (weAcquired) {
				releaseLock();
				log('Lock released.');
			}
			uninstallSignalHandlers();
		}
		// Re-emit git's "[<branch> <sha>] <subject>" line at the end of
		// stdout on success. Native `git commit` prints this line once near
		// the start of its output, but downstream tools that buffer commit
		// output (e.g. Claude Code's Bash tool, which truncates large
		// outputs FROM THE MIDDLE) routinely drop it when the precommit
		// pipeline emits a lot of text. The result is silent commit-
		// attribution misses: parsers see no `[branch sha]` line and skip
		// writing the (task, sha) linkage row. Re-emitting at the very end
		// — after the lock-release log — guarantees the SHA survives
		// middle-truncation. Format mirrors git's native shape exactly so
		// existing regexes like `/^\[[^\]]+ ([0-9a-f]{7,40})\]/` match
		// unchanged; consumers that scan for the LAST match (the documented
		// agent-hooks behaviour: `chained git commit && git commit lands
		// HEAD on the second, so use the last`) get the authoritative SHA
		// here regardless of any earlier truncated match.
		//
		// Best-effort: if HEAD-read fails after a successful commit (e.g.
		// transient git error, repo damage), skip silently rather than
		// turning a successful commit into a failed exit. The original
		// `[branch sha]` line earlier in the output is still authoritative
		// when present.
		if (!commitFailed) {
			try {
				const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
				const shortSha = git('rev-parse', '--short=8', 'HEAD');
				const subject = (message.split('\n')[0] ?? '').trim();
				console.log(`[${branch} ${shortSha}] ${subject}`);
			} catch {
				// noop — see comment above
			}
		}
		if (commitFailed) process.exit(1);
	}));

// ── stage ────────────────────────────────────────────────────

program
	.command('stage')
	.description('Stage files while holding a multi-turn transaction lock')
	.requiredOption('-f, --files <files...>', 'Files to stage')
	.option(
		'-o, --owner <owner>',
		'Lock owner identifier',
		`pid-${process.pid}`,
	)
	.option(
		'-t, --ttl <seconds>',
		'Lock TTL in seconds',
		String(DEFAULT_TTL_TRANSACTION),
	)
	.option(
		'-w, --wait <seconds>',
		'Poll for the lock up to this many seconds before failing (default: 0, fail immediately)',
		'0',
	)
	.action(safeAction((opts) => {
		const { owner } = opts;
		const files = toRepoRelativePaths({ paths: opts.files });
		const ttl = parseTtl(opts.ttl);
		const waitSeconds = parseWait(opts.wait);
		validateLiteralFileInputs({ paths: files });

		const existing = readLock();
		const usingExisting = Boolean(existing && existing.owner === owner && !isStale(existing));

		if (usingExisting) {
			log(`Using existing lock (owner: "${owner}")`);
		} else {
			log(`Acquiring lock as "${owner}" (ttl: ${ttl}s)...`);
			acquireLockWithWait({ owner, ttlSeconds: ttl, waitSeconds, detached: true });
			log('Lock acquired.');
		}

		try {
			const toStage = pathsSafeForPlainGitAdd({ paths: files });
			const skipped = files.filter((f: string) => !toStage.includes(f));
			if (skipped.length > 0) {
				log(
					`Skipping git add for ${skipped.length} path(s) (staged deletion; on-disk file would re-add to index): ${skipped.join(', ')}`,
				);
			}
			log(`Staging ${toStage.length} file(s): ${toStage.join(', ') || '(none — using existing index)'}`);
			stageFiles(toStage);
			log(`Staged ${files.length} file(s). Lock remains held.`);
		} catch (err) {
			if (!usingExisting) {
				releaseLock();
				log('Lock released.');
			}
			throw err;
		}
	}));

// ── unstage ──────────────────────────────────────────────────

program
	.command('unstage')
	.description('Unstage files while holding a multi-turn transaction lock')
	.requiredOption('-f, --files <files...>', 'Files to unstage')
	.option(
		'-o, --owner <owner>',
		'Lock owner to verify',
		`pid-${process.pid}`,
	)
	.action(safeAction((opts) => {
		const { owner } = opts;
		const files = toRepoRelativePaths({ paths: opts.files });
		validateLiteralFileInputs({ paths: files });
		verifyOwnership(owner);

		strictUnstageFiles(files);
		log(`Unstaged ${files.length} file(s). Lock remains held.`);
	}));

// ── lock ─────────────────────────────────────────────────────

program
	.command('lock')
	.description('Acquire a lock for a multi-turn commit transaction')
	.option(
		'-o, --owner <owner>',
		'Lock owner (use a stable session ID)',
		`pid-${process.pid}`,
	)
	.option(
		'-t, --ttl <seconds>',
		'Lock TTL in seconds',
		String(DEFAULT_TTL_TRANSACTION),
	)
	.option(
		'-w, --wait <seconds>',
		'Poll for the lock up to this many seconds before failing (default: 0, fail immediately)',
		'0',
	)
	.action(safeAction((opts) => {
		const { owner } = opts;
		const ttl = parseTtl(opts.ttl);
		const waitSeconds = parseWait(opts.wait);
		log(`Acquiring lock as "${owner}" (ttl: ${ttl}s)...`);
		acquireLockWithWait({ owner, ttlSeconds: ttl, waitSeconds, detached: true });
		log('Lock acquired.');
	}));

// ── unlock ───────────────────────────────────────────────────

program
	.command('unlock')
	.description('Release a lock you hold')
	.option(
		'-o, --owner <owner>',
		'Lock owner to verify',
		`pid-${process.pid}`,
	)
	.option('--force', 'Release without owner verification')
	.action(safeAction((opts) => {
		const { owner, force } = opts;
		if (!force) {
			verifyOwnership(owner);
		}
		releaseLock();
		log('Lock released.');
	}));

// ── renew ────────────────────────────────────────────────────

program
	.command('renew')
	.description('Extend the TTL of a lock you hold')
	.option(
		'-o, --owner <owner>',
		'Lock owner to verify',
		`pid-${process.pid}`,
	)
	.option(
		'-t, --ttl <seconds>',
		'New TTL in seconds',
		String(DEFAULT_TTL_TRANSACTION),
	)
	.action(safeAction((opts) => {
		const { owner } = opts;
		const ttl = parseTtl(opts.ttl);
		const info = verifyOwnership(owner);
		const lockDir = getLockDir();
		const renewed: LockInfo = {
			...info,
			acquiredAt: Date.now(),
			ttlSeconds: ttl,
		};
		writeFileSync(
			join(lockDir, 'lock.json'),
			JSON.stringify(renewed, null, 2),
		);
		log(`Lock renewed (new TTL: ${ttl}s).`);
	}));

// ── status ───────────────────────────────────────────────────

program
	.command('status')
	.description('Show current lock status')
	.action(safeAction(() => {
		const info = readLock();
		if (!info) {
			log('No lock held.');
			process.exit(0);
			return;
		}
		const stale = isStale(info);
		log(`Owner:  ${info.owner}`);
		if (info.pid === DETACHED_PID) {
			log('PID:    (detached — multi-turn lock)');
		} else {
			log(`PID:    ${info.pid} (${isPidAlive(info.pid) ? 'alive' : 'dead'})`);
		}
		log(`Age:    ${formatAge(info)}s / ${info.ttlSeconds}s TTL`);
		log(`Status: ${stale ? 'STALE (safe to steal or break)' : 'ACTIVE'}`);
	}));

// ── break-lock ───────────────────────────────────────────────

program
	.command('break-lock')
	.description('Force-remove a lock (emergency use)')
	.action(safeAction(() => {
		const info = readLock();
		if (!info) {
			log('No lock to break.');
			return;
		}
		releaseLock();
		log(`Lock broken (was held by "${info.owner}", pid ${info.pid}).`);
	}));

program.parse();

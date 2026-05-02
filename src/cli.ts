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
} from 'node:fs';
import { join, resolve } from 'node:path';

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
const GIT_ENV = { ...process.env, GIT_ATOMIC_COMMIT: '1' };

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

function getLockDir(): string {
	return join(resolve(getGitDir()), LOCK_DIR_NAME);
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
 *   - A/M/R/C/T: `git add` re-stages the current working-tree contents.
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
			} else {
				execFileSync(
					'git',
					[
						'add',
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
	return `:(literal)${relativePath}`;
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
		lstatSync(resolve(process.cwd(), relativePath));
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
	const absolutePath = resolve(process.cwd(), relativePath);
	return pathExistsIncludingBrokenSymlink({ relativePath }) && lstatSync(absolutePath).isDirectory();
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
function fileWouldReviveStagedDeletion({
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
	if (!line.startsWith('D')) return false;
	return pathExistsIncludingBrokenSymlink({ relativePath });
}

function pathsSafeForPlainGitAdd({ paths }: { paths: string[] }): string[] {
	return paths.filter((p) => !fileWouldReviveStagedDeletion({ relativePath: p }));
}

function stageFiles(files: string[]): void {
	if (files.length === 0) return;
	gitCaptureAndReplay('add', '--', ...toLiteralPathspecs({ paths: files }));
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
		const { files, message, owner, verify } = opts;
		const ttl = parseTtl(opts.ttl);
		const waitSeconds = parseWait(opts.wait);
		validateLiteralFileInputs({ paths: files });

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
				log(`Staging ${toStage.length} file(s): ${toStage.join(', ') || '(none — using existing index)'}`);
				failingPhase = 'staging';
				stageFiles(toStage);

				const commitArgs = ['commit', '-m', message];
				if (verify === false) commitArgs.push('--no-verify');

				failingPhase = 'commit';
				log('Committing...');
				gitPassthrough(...commitArgs);
				log('Commit successful.');
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
			if (weAcquired) {
				releaseLock();
				log('Lock released.');
			}
			uninstallSignalHandlers();
		}
		if (commitFailed) process.exit(1);
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

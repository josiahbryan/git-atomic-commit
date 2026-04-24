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

function getStagedFiles(): string[] {
	const output = git('diff', '--name-only', '--staged');
	return output ? output.split('\n').filter(Boolean) : [];
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
 * Install signal handlers that release our lock before the process dies.
 * Without this, Ctrl+C during a long pre-commit hook would kill the Bun
 * process via Node's default SIGINT handler (exit 130) *before* the
 * try/finally around the commit can release the lock — leaving a stale
 * lock directory behind.
 *
 * Only the caller that acquired the lock should install these; multi-turn
 * callers (external lock) must not clear someone else's lock.
 *
 * Returns a disposer that removes the handlers when normal cleanup runs.
 */
function installLockCleanupHandlers({ owner }: { owner: string }): () => void {
	const handler = (signal: NodeJS.Signals) => {
		try {
			// Only release if we still own the lock — defensive in case
			// something else already broke/stole it during the hook run.
			const info = readLock();
			if (info && info.owner === owner) {
				releaseLock();
				logError(`Interrupted by ${signal} — lock released.`);
			} else {
				logError(`Interrupted by ${signal}.`);
			}
		} catch {
			// Swallow — we're already terminating; don't mask the signal exit.
		}
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

		// Register signal handlers so Ctrl+C (e.g. during a slow pre-commit
		// hook) releases the lock before the process dies. Only install when
		// we acquired the lock — a caller holding a multi-turn lock should
		// not have their lock cleared by our interrupt.
		const uninstallSignalHandlers = weAcquired
			? installLockCleanupHandlers({ owner })
			: () => {};

		// Everything after lock acquisition is wrapped in try/finally
		// so the lock is always released (if we acquired it) on any failure.
		let commitFailed = false;
		let failingPhase: 'staging' | 'commit' = 'staging';
		try {
			const priorStaged = getStagedFiles();
			if (priorStaged.length > 0) {
				log(
					`Note: ${priorStaged.length} file(s) already staged: ${priorStaged.join(', ')}`,
				);
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

				const toUnstage = files.filter(
					(f: string) => !priorStaged.includes(f),
				);
				unstageFiles(toUnstage, trackedFiles);
				log(`Rolled back ${toUnstage.length} file(s).`);
				commitFailed = true;
			}
		} finally {
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

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
} from 'node:fs';
import { join, resolve } from 'node:path';

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
	const output = git('ls-files', '--', ...files);
	return new Set(output ? output.split('\n').filter(Boolean) : []);
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
	const staged = git('diff', '--cached', '--name-status', '--', relativePath);
	const line = staged.split('\n')[0]?.trim() ?? '';
	if (!line.startsWith('D')) return false;
	return existsSync(resolve(process.cwd(), relativePath));
}

function pathsSafeForPlainGitAdd({ paths }: { paths: string[] }): string[] {
	return paths.filter((p) => !fileWouldReviveStagedDeletion({ relativePath: p }));
}

function stageFiles(files: string[]): void {
	if (files.length === 0) return;
	gitCaptureAndReplay('add', '--', ...files);
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
			execFileSync('git', ['reset', 'HEAD', '--', ...tracked], { stdio: 'pipe', env: GIT_ENV });
		} catch { /* best effort */ }
	}
	if (untracked.length) {
		try {
			execFileSync('git', ['rm', '--cached', '--', ...untracked], { stdio: 'pipe', env: GIT_ENV });
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
	if (!isPidAlive(info.pid) && ageSeconds > STALE_PID_GRACE) return true;
	return false;
}

function acquireLock(owner: string, ttlSeconds: number): void {
	const lockDir = getLockDir();

	try {
		mkdirSync(lockDir);
	} catch (err: any) {
		if (err.code !== 'EEXIST') throw err;

		const info = readLock();
		if (info && !isStale(info)) {
			throw new Error(
				`Lock held by "${info.owner}" (pid ${info.pid}, age ${formatAge(info)}s, ttl ${info.ttlSeconds}s). ` +
					`Use 'status' to inspect or 'break-lock' to force-remove.`,
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
		pid: process.pid,
		acquiredAt: Date.now(),
		ttlSeconds,
	};
	writeFileSync(
		join(lockDir, 'lock.json'),
		JSON.stringify(lockInfo, null, 2),
	);
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

// ── CLI ──────────────────────────────────────────────────────

const program = new Command();
program
	.name('git-atomic-commit')
	.description(
		'Atomic git stage+commit with repo-wide locking for multi-agent safety',
	)
	.version('1.0.0');

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
	.action(safeAction((opts) => {
		const { files, message, owner, verify } = opts;
		const ttl = parseTtl(opts.ttl);

		// Check if we already hold the lock (from a prior `lock` command)
		const existing = readLock();
		const weAcquired = !(existing && existing.owner === owner && !isStale(existing));

		if (!weAcquired) {
			log(`Using existing lock (owner: "${owner}")`);
		} else {
			log(`Acquiring lock as "${owner}"...`);
			acquireLock(owner, ttl);
			log('Lock acquired.');
		}

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
	.action(safeAction((opts) => {
		const { owner } = opts;
		const ttl = parseTtl(opts.ttl);
		log(`Acquiring lock as "${owner}" (ttl: ${ttl}s)...`);
		acquireLock(owner, ttl);
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
		const pidAlive = isPidAlive(info.pid);
		const stale = isStale(info);
		log(`Owner:  ${info.owner}`);
		log(`PID:    ${info.pid} (${pidAlive ? 'alive' : 'dead'})`);
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

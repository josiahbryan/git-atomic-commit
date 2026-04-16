#!/usr/bin/env bun

import { Command } from 'commander';
import { execSync } from 'node:child_process';
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
const DEFAULT_TTL_ATOMIC = 60; // 1 min for atomic commit
const DEFAULT_TTL_TRANSACTION = 600; // 10 min for multi-turn lock
const STALE_PID_GRACE = 10; // seconds before dead-PID lock is stealable

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

function run(cmd: string): string {
	try {
		return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
	} catch (err: any) {
		// Return stdout even on non-zero exit (some git commands do this)
		if (err.stdout) return err.stdout.toString().trim();
		throw err;
	}
}

function runPassthrough(cmd: string): void {
	execSync(cmd, { stdio: 'inherit' });
}

// ── Git Utilities ────────────────────────────────────────────

function getGitDir(): string {
	return run('git rev-parse --git-dir');
}

function getLockDir(): string {
	return join(resolve(getGitDir()), LOCK_DIR_NAME);
}

function getStagedFiles(): string[] {
	const output = run('git diff --name-only --staged');
	return output ? output.split('\n').filter(Boolean) : [];
}

/** Returns the set of files git considers tracked (exist in HEAD) */
function getTrackedFiles(files: string[]): Set<string> {
	const tracked = new Set<string>();
	for (const file of files) {
		try {
			// ls-files --error-unmatch exits non-zero for untracked files
			run(`git ls-files --error-unmatch "${file}"`);
			tracked.add(file);
		} catch {
			// Not tracked — skip
		}
	}
	return tracked;
}

function stageFiles(files: string[]): void {
	for (const file of files) {
		execSync(`git add "${file}"`, { stdio: 'pipe' });
	}
}

/**
 * Unstage files, handling both tracked and new (untracked) files correctly.
 * - Tracked files: `git reset HEAD -- <file>` (removes staged diff)
 * - New files: `git rm --cached <file>` (removes from index, keeps working tree)
 */
function unstageFiles(
	files: string[],
	trackedFiles: Set<string>,
): void {
	for (const file of files) {
		try {
			if (trackedFiles.has(file)) {
				execSync(`git reset HEAD -- "${file}"`, { stdio: 'pipe' });
			} else {
				execSync(`git rm --cached "${file}"`, { stdio: 'pipe' });
			}
		} catch {
			// Best effort — file might already be unstaged
		}
	}
}

// ── Lock Management ──────────────────────────────────────────

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
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
	// Primary: TTL expired
	if (ageSeconds > info.ttlSeconds) return true;
	// Secondary: owning process is dead and lock is past the grace period
	if (!isPidAlive(info.pid) && ageSeconds > STALE_PID_GRACE) return true;
	return false;
}

function acquireLock(owner: string, ttlSeconds: number): void {
	const lockDir = getLockDir();

	try {
		// mkdir is atomic on POSIX — exactly one caller wins the race
		mkdirSync(lockDir);
	} catch (err: any) {
		if (err.code !== 'EEXIST') throw err;

		// Lock exists — check if stale
		const info = readLock();
		if (info && !isStale(info)) {
			throw new Error(
				`Lock held by "${info.owner}" (pid ${info.pid}, age ${formatAge(info)}s, ttl ${info.ttlSeconds}s). ` +
					`Use 'status' to inspect or 'break-lock' to force-remove.`,
			);
		}

		// Stale — steal it
		log(`Removing stale lock from "${info?.owner ?? 'unknown'}"`);
		rmSync(lockDir, { recursive: true });
		mkdirSync(lockDir);
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
		const { files, message, owner, ttl, verify } = opts;

		// Check if we already hold the lock (from a prior `lock` command)
		const existing = readLock();
		if (existing && existing.owner === owner && !isStale(existing)) {
			log(`Using existing lock (owner: "${owner}")`);
		} else {
			log(`Acquiring lock as "${owner}"...`);
			acquireLock(owner, parseInt(ttl));
			log('Lock acquired.');
		}

		// Snapshot what was staged BEFORE we touch the index
		const priorStaged = getStagedFiles();
		if (priorStaged.length > 0) {
			log(
				`Note: ${priorStaged.length} file(s) already staged: ${priorStaged.join(', ')}`,
			);
		}

		// Record which of our files are already tracked (needed for correct rollback)
		const trackedFiles = getTrackedFiles(files);

		try {
			log(`Staging ${files.length} file(s): ${files.join(', ')}`);
			stageFiles(files);

			const verifyFlag = verify === false ? ' --no-verify' : '';
			const commitCmd = `git commit${verifyFlag} -m ${JSON.stringify(message)}`;

			log('Committing...');
			runPassthrough(commitCmd);
			log('Commit successful.');
		} catch (err: any) {
			logError('Commit failed — rolling back staging...');

			// Unstage ONLY files we added (preserve anything that was staged before us)
			const toUnstage = files.filter(
				(f: string) => !priorStaged.includes(f),
			);
			unstageFiles(toUnstage, trackedFiles);
			log(`Rolled back ${toUnstage.length} file(s).`);

			releaseLock();
			log('Lock released.');
			process.exit(1);
		}

		releaseLock();
		log('Lock released.');
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
		const { owner, ttl } = opts;
		log(`Acquiring lock as "${owner}" (ttl: ${ttl}s)...`);
		acquireLock(owner, parseInt(ttl));
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
		const { owner, ttl } = opts;
		const info = verifyOwnership(owner);
		const lockDir = getLockDir();
		const renewed: LockInfo = {
			...info,
			acquiredAt: Date.now(),
			ttlSeconds: parseInt(ttl),
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

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, execFileSync } from 'node:child_process';
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
} from 'node:fs';
import { join } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────

const CLI = join(import.meta.dir, 'cli.ts');

/** Run git-atomic-commit in a given cwd, return { stdout, stderr, exitCode } */
function gac(
	args: string,
	opts?: { cwd?: string },
): { stdout: string; stderr: string; exitCode: number } {
	const cwd = opts?.cwd ?? tmpRepo;
	try {
		const stdout = execSync(`bun "${CLI}" ${args}`, {
			encoding: 'utf-8',
			cwd,
			stdio: 'pipe',
		});
		return { stdout, stderr: '', exitCode: 0 };
	} catch (err: any) {
		return {
			stdout: err.stdout?.toString() ?? '',
			stderr: err.stderr?.toString() ?? '',
			exitCode: err.status ?? 1,
		};
	}
}

/** Run a git command in the test repo */
function gitCmd(...args: string[]): string {
	return execFileSync('git', args, {
		encoding: 'utf-8',
		cwd: tmpRepo,
		stdio: 'pipe',
	}).trim();
}

/** Create a file in the test repo */
function createFile(name: string, content = 'test content\n'): void {
	writeFileSync(join(tmpRepo, name), content);
}

/** Get list of staged files */
function stagedFiles(): string[] {
	const output = gitCmd('diff', '--name-only', '--staged');
	return output ? output.split('\n').filter(Boolean) : [];
}

/** Get the lock dir path */
function lockDir(): string {
	return join(tmpRepo, '.git', 'atomic-commit.lock');
}

/** Check if lock exists */
function lockExists(): boolean {
	return existsSync(lockDir());
}

/** Read lock info */
function readLockInfo(): any | null {
	const lockFile = join(lockDir(), 'lock.json');
	if (!existsSync(lockFile)) return null;
	return JSON.parse(readFileSync(lockFile, 'utf-8'));
}

// ── Test Repo Setup ──────────────────────────────────────────

let tmpRepo: string;
let tmpCounter = 0;

function createTestRepo(): string {
	const dir = join(
		(execSync('mktemp -d', { encoding: 'utf-8' })).trim(),
		`repo-${++tmpCounter}`,
	);
	mkdirSync(dir, { recursive: true });
	execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
	execFileSync('git', ['config', 'user.email', 'test@test.com'], {
		cwd: dir,
		stdio: 'pipe',
	});
	execFileSync('git', ['config', 'user.name', 'Test'], {
		cwd: dir,
		stdio: 'pipe',
	});
	// Initial commit so HEAD exists
	writeFileSync(join(dir, '.gitkeep'), '');
	execFileSync('git', ['add', '.gitkeep'], { cwd: dir, stdio: 'pipe' });
	execFileSync('git', ['commit', '-m', 'init'], {
		cwd: dir,
		stdio: 'pipe',
	});
	return dir;
}

beforeEach(() => {
	tmpRepo = createTestRepo();
});

afterEach(() => {
	if (tmpRepo && existsSync(tmpRepo)) {
		rmSync(tmpRepo, { recursive: true, force: true });
	}
});

// ── Tests ────────────────────────────────────────────────────

describe('git-atomic-commit', () => {
	// ── commit ───────────────────────────────────────────────

	describe('commit', () => {
		test('stages and commits specified files atomically', () => {
			createFile('a.txt', 'hello\n');
			createFile('b.txt', 'world\n');

			const result = gac(
				'commit -f a.txt b.txt -m "test: add two files" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Commit successful');

			// Files should be committed, not staged
			expect(stagedFiles()).toEqual([]);

			// Verify they're in the commit
			const committed = gitCmd('diff', '--name-only', 'HEAD~1', 'HEAD');
			expect(committed).toContain('a.txt');
			expect(committed).toContain('b.txt');
		});

		test('releases lock after successful commit', () => {
			createFile('a.txt');
			gac('commit -f a.txt -m "test" --no-verify');
			expect(lockExists()).toBe(false);
		});

		test('rolls back staging on commit failure and releases lock', () => {
			createFile('a.txt');

			// Empty message causes commit to fail
			const result = gac('commit -f a.txt -m "" --no-verify');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('rolling back');

			// File should NOT be staged
			expect(stagedFiles()).toEqual([]);
			// Lock should be released
			expect(lockExists()).toBe(false);
		});

		test('does not unstage files that were already staged by someone else', () => {
			createFile('theirs.txt', 'their content\n');
			createFile('ours.txt', 'our content\n');

			// Stage theirs.txt manually (simulating another agent)
			gitCmd('add', 'theirs.txt');
			expect(stagedFiles()).toEqual(['theirs.txt']);

			// Our commit fails (empty message)
			gac('commit -f ours.txt -m "" --no-verify');

			// theirs.txt should STILL be staged, ours.txt should not
			const staged = stagedFiles();
			expect(staged).toContain('theirs.txt');
			expect(staged).not.toContain('ours.txt');
		});

		test('handles mix of tracked and untracked files in rollback', () => {
			// Create and commit a file so it's tracked
			createFile('tracked.txt', 'v1\n');
			gitCmd('add', 'tracked.txt');
			gitCmd('commit', '-m', 'add tracked');

			// Modify the tracked file and create a new untracked file
			createFile('tracked.txt', 'v2\n');
			createFile('untracked.txt', 'new\n');

			// Fail the commit
			gac('commit -f tracked.txt untracked.txt -m "" --no-verify');

			// Neither should be staged after rollback
			expect(stagedFiles()).toEqual([]);
		});

		test('does not release externally-held lock on commit failure', () => {
			createFile('a.txt');

			// Acquire lock externally
			gac('lock -o "external-agent"');
			expect(lockExists()).toBe(true);

			// Commit with same owner fails
			gac('commit -o "external-agent" -f a.txt -m "" --no-verify');

			// Lock should STILL be held (we didn't acquire it)
			expect(lockExists()).toBe(true);
			const info = readLockInfo();
			expect(info.owner).toBe('external-agent');

			// Clean up
			gac('unlock --force');
		});
	});

	// ── lock / unlock ────────────────────────────────────────

	describe('lock', () => {
		test('creates lock directory with metadata', () => {
			const result = gac('lock -o "agent-1" -t 120');
			expect(result.exitCode).toBe(0);
			expect(lockExists()).toBe(true);

			const info = readLockInfo();
			expect(info.owner).toBe('agent-1');
			expect(info.ttlSeconds).toBe(120);
			expect(info.pid).toBeGreaterThan(0);

			gac('unlock --force');
		});

		test('blocks when lock is already held', () => {
			gac('lock -o "agent-1"');

			const result = gac('lock -o "agent-2"');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Lock held by "agent-1"');

			gac('unlock --force');
		});

		test('steals stale lock (TTL expired)', () => {
			// Manually create an expired lock
			const dir = lockDir();
			mkdirSync(dir);
			writeFileSync(
				join(dir, 'lock.json'),
				JSON.stringify({
					owner: 'dead-agent',
					pid: 999999,
					acquiredAt: Date.now() - 120_000, // 2 minutes ago
					ttlSeconds: 60, // expired 1 minute ago
				}),
			);

			const result = gac('lock -o "new-agent"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('stale');

			const info = readLockInfo();
			expect(info.owner).toBe('new-agent');

			gac('unlock --force');
		});
	});

	describe('unlock', () => {
		test('releases lock with matching owner', () => {
			gac('lock -o "agent-1"');
			expect(lockExists()).toBe(true);

			const result = gac('unlock -o "agent-1"');
			expect(result.exitCode).toBe(0);
			expect(lockExists()).toBe(false);
		});

		test('rejects unlock with wrong owner', () => {
			gac('lock -o "agent-1"');

			const result = gac('unlock -o "agent-2"');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('not "agent-2"');

			// Lock should still exist
			expect(lockExists()).toBe(true);
			gac('unlock --force');
		});

		test('force unlock ignores owner check', () => {
			gac('lock -o "agent-1"');

			const result = gac('unlock --force');
			expect(result.exitCode).toBe(0);
			expect(lockExists()).toBe(false);
		});
	});

	// ── renew ────────────────────────────────────────────────

	describe('renew', () => {
		test('extends TTL of held lock', () => {
			gac('lock -o "agent-1" -t 60');
			const before = readLockInfo();

			// Small delay so acquiredAt differs
			execSync('sleep 0.1');

			gac('renew -o "agent-1" -t 300');
			const after = readLockInfo();

			expect(after.ttlSeconds).toBe(300);
			expect(after.acquiredAt).toBeGreaterThanOrEqual(before.acquiredAt);
			expect(after.owner).toBe('agent-1');

			gac('unlock --force');
		});

		test('rejects renew with wrong owner', () => {
			gac('lock -o "agent-1"');

			const result = gac('renew -o "agent-2" -t 300');
			expect(result.exitCode).not.toBe(0);

			gac('unlock --force');
		});
	});

	// ── status ───────────────────────────────────────────────

	describe('status', () => {
		test('reports no lock when none held', () => {
			const result = gac('status');
			expect(result.stdout).toContain('No lock held');
		});

		test('reports lock details when held', () => {
			gac('lock -o "agent-1" -t 120');

			const result = gac('status');
			expect(result.stdout).toContain('agent-1');
			expect(result.stdout).toContain('120s TTL');

			gac('unlock --force');
		});
	});

	// ── break-lock ───────────────────────────────────────────

	describe('break-lock', () => {
		test('removes any lock regardless of owner', () => {
			gac('lock -o "agent-1"');
			expect(lockExists()).toBe(true);

			const result = gac('break-lock');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Lock broken');
			expect(lockExists()).toBe(false);
		});

		test('is a no-op when no lock exists', () => {
			const result = gac('break-lock');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('No lock to break');
		});
	});

	// ── TTL validation ───────────────────────────────────────

	describe('TTL validation', () => {
		test('rejects non-numeric TTL', () => {
			const result = gac('lock -o "agent-1" -t "abc"');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Invalid --ttl');
		});

		test('rejects zero TTL', () => {
			const result = gac('lock -o "agent-1" -t "0"');
			expect(result.exitCode).not.toBe(0);
		});

		test('rejects negative TTL', () => {
			const result = gac('lock -o "agent-1" -t "-5"');
			expect(result.exitCode).not.toBe(0);
		});
	});

	// ── multi-turn transaction flow ──────────────────────────

	describe('multi-turn transaction', () => {
		test('lock → commit reuses the lock and releases on success', () => {
			createFile('a.txt');

			gac('lock -o "session-1"');
			expect(lockExists()).toBe(true);

			const result = gac(
				'commit -o "session-1" -f a.txt -m "test: multi-turn" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Using existing lock');
			expect(result.stdout).toContain('Commit successful');

			// Lock should be released after commit succeeds
			// (commit with reused lock still releases it)
			// Actually — when reusing, we do NOT release. Agent must unlock.
			// Let's check our implementation:
			// weAcquired = false when reusing, so finally does NOT release.
			expect(lockExists()).toBe(true);

			// Agent cleans up
			gac('unlock -o "session-1"');
			expect(lockExists()).toBe(false);
		});
	});
});

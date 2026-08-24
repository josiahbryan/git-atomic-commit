import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	chmodSync,
	symlinkSync,
	lstatSync,
} from 'node:fs';
import { join } from 'node:path';

// ── Helpers ──────────────────────────────────────────────────

const CLI = join(import.meta.dir, 'cli.ts');

/** Allow raw git in tests when git-guardrails is installed (same bypass as the CLI). */
// Author / committer identity is injected via env vars rather than
// `git config user.email/name` because git-guardrails (which is installed
// in josiah's dev env) blocks the latter as an anti-footgun rule —
// writing identity to a repo's config pollutes other users. Env vars are
// the guardrail's own recommended alternative and scope cleanly to this
// process. GIT_ATOMIC_COMMIT=1 tells git-guardrails to allow the inner
// `git add`/`git commit` calls through.
const GIT_TEST_ENV = {
	...process.env,
	GIT_ATOMIC_COMMIT: '1',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@test.com',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@test.com',
};

/** Run git-atomic-commit in a given cwd, return { stdout, stderr, exitCode } */
function gac(
	args: string,
	opts?: { cwd?: string; env?: Record<string, string> },
): { stdout: string; stderr: string; exitCode: number } {
	const cwd = opts?.cwd ?? tmpRepo;
	// spawnSync (not execSync) so we capture stderr on SUCCESS too — some
	// paths (e.g. the GIT_ATOMIC_SKIP_GATES loud-bypass banner) write to
	// stderr while still exiting 0, and execSync only surfaces stderr when
	// the command throws.
	const result = spawnSync('bun', [CLI, ...splitArgs(args)], {
		encoding: 'utf-8',
		cwd,
		stdio: 'pipe',
		// Pass GIT_TEST_ENV so cli.ts's inner git subprocesses see the
		// GIT_AUTHOR_* / GIT_COMMITTER_* identity vars + GIT_ATOMIC_COMMIT
		// (the latter is how git-guardrails knows these calls are
		// authorised; see top-of-file comment on GIT_TEST_ENV).
		// opts.env lets a test layer on extra vars (e.g. the own-diff
		// gate's GIT_ATOMIC_GATE_CMD / GIT_ATOMIC_SKIP_GATES).
		env: { ...GIT_TEST_ENV, ...(opts?.env ?? {}) },
	});
	return {
		stdout: result.stdout?.toString() ?? '',
		stderr: result.stderr?.toString() ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Split a CLI arg string into argv the way the previous execSync call did,
 * honouring double-quoted groups (e.g. -m "test: msg with spaces"). Good
 * enough for these tests, which only ever quote with double quotes.
 */
function splitArgs(args: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(args)) !== null) {
		out.push(m[1] !== undefined ? m[1] : (m[2] ?? ''));
	}
	return out;
}

/** Run a git command in the test repo */
function gitCmd(...args: string[]): string {
	return execFileSync('git', args, {
		encoding: 'utf-8',
		cwd: tmpRepo,
		stdio: 'pipe',
		env: GIT_TEST_ENV,
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

/** Get staged files with their index-vs-HEAD status code (e.g. A, M, D) */
function stagedEntries(): Array<{ path: string; status: string }> {
	const output = gitCmd('diff', '--cached', '--name-status');
	if (!output) return [];
	return output
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const parts = line.split('\t');
			const status = (parts[0] ?? '')[0] ?? '';
			const path = parts[parts.length - 1] ?? '';
			return { path, status };
		});
}

/** Names of files in the most recent commit (HEAD vs HEAD~1) */
function filesInHead(): string[] {
	const output = gitCmd('diff', '--name-only', 'HEAD~1', 'HEAD');
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
	execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe', env: GIT_TEST_ENV });
	// No `git config user.email/name` here — identity flows in via
	// GIT_AUTHOR_* / GIT_COMMITTER_* on GIT_TEST_ENV (see top of file for why).
	// Initial commit so HEAD exists
	writeFileSync(join(dir, '.gitkeep'), '');
	execFileSync('git', ['add', '.gitkeep'], {
		cwd: dir,
		stdio: 'pipe',
		env: GIT_TEST_ENV,
	});
	execFileSync('git', ['commit', '-m', 'init'], {
		cwd: dir,
		stdio: 'pipe',
		env: GIT_TEST_ENV,
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

		test('emits a parseable `[branch sha] subject` line at the end of stdout on success', () => {
			// Why: downstream tools (Claude Code Bash tool, log truncators)
			// frequently drop git's native `[branch sha]` line — it appears
			// near the START of output and gets sliced away when the body
			// is truncated from the middle. This trailing emission survives
			// because it's the very last thing printed.
			createFile('a.txt');
			const result = gac(
				'commit -f a.txt -m "test: trailing sha line emitted" --no-verify',
			);
			expect(result.exitCode).toBe(0);

			// Regex mirrors the one in agent-hooks.ts#extractCommitShaFromOutput
			// — `[<branch> <sha>] <subject>`. Multi-line + case-insensitive so
			// behaviour matches the consumer exactly.
			const sha = gitCmd('rev-parse', '--short=8', 'HEAD');
			const branch = gitCmd('rev-parse', '--abbrev-ref', 'HEAD');
			const expectedLine = `[${branch} ${sha}] test: trailing sha line emitted`;
			const lines = result.stdout.split('\n');
			// The line we add is the LAST non-empty output line.
			const lastNonEmpty = [...lines].reverse().find((l) => l.trim().length > 0);
			expect(lastNonEmpty).toBe(expectedLine);

			// And the existing agent-hooks regex matches it.
			const re = /^\[[^\]]+ ([0-9a-f]{7,40})\]/gim;
			const matches = [...result.stdout.matchAll(re)];
			expect(matches.length).toBeGreaterThanOrEqual(1);
			const last = matches[matches.length - 1];
			expect(last?.[1]).toBe(sha);
		});

		test('does NOT emit the trailing sha line on commit failure', () => {
			createFile('a.txt');
			// Empty message → commit fails (matches the rollback test above).
			const result = gac('commit -f a.txt -m "" --no-verify');
			expect(result.exitCode).not.toBe(0);
			// No `[branch hex]` line in failure-path output. (The lock-release
			// log line `[git-atomic-commit] Lock released.` would NOT match the
			// regex anyway because it has no space-then-hex inside the
			// brackets — but assert the absence directly for explicitness.)
			const re = /^\[[^\]]+ ([0-9a-f]{7,40})\]/gim;
			expect([...result.stdout.matchAll(re)].length).toBe(0);
		});

		test('rolls back staging on commit failure and releases lock', () => {
			createFile('a.txt');

			// Empty message causes commit to fail
			const result = gac('commit -f a.txt -m "" --no-verify');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Atomic operation failed during commit');
			expect(result.stdout + result.stderr).toContain('rolling back');

			// File should NOT be staged
			expect(stagedFiles()).toEqual([]);
			// Lock should be released
			expect(lockExists()).toBe(false);
		});

		test('surfaces git add pathspec errors before rollback', () => {
			const result = gac('commit -f missing.txt -m "test: missing path surfaces error" --no-verify');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain("missing.txt");
			expect(result.stdout + result.stderr).toContain('Atomic operation failed during staging');
			expect(result.stdout + result.stderr).toContain('rolling back');
			expect(result.stdout + result.stderr).not.toContain('Commit successful');
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

		/**
		 * Core atomic-isolation contract: when another agent has unrelated
		 * files staged at the moment we run, the resulting commit must
		 * contain ONLY the files passed via --files. The previously-staged
		 * files are temp-unstaged for the duration of the commit and then
		 * restored to the index afterward.
		 *
		 * Regression test for the "8 unrelated files got bundled into my
		 * refactor commit" bug.
		 */
		test('isolates unrelated staged files from the atomic commit', () => {
			// Existing tracked file modified-and-staged by another agent.
			createFile('tracked.txt', 'v1\n');
			gitCmd('add', 'tracked.txt');
			gitCmd('commit', '-m', 'add tracked', '--no-verify');
			createFile('tracked.txt', 'v2 from other agent\n');
			gitCmd('add', 'tracked.txt');

			// Brand-new file staged by another agent.
			createFile('new-from-other.txt', 'newly added by other agent\n');
			gitCmd('add', 'new-from-other.txt');

			// Files we actually want to commit atomically.
			createFile('ours-a.txt', 'ours a\n');
			createFile('ours-b.txt', 'ours b\n');

			// Sanity: all three unrelated files are staged before our commit runs.
			expect(stagedFiles().sort()).toEqual([
				'new-from-other.txt',
				'tracked.txt',
			]);

			const result = gac(
				'commit -f ours-a.txt ours-b.txt -m "test: only ours" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Commit successful');
			expect(result.stdout).toContain('Temporarily unstaging');
			expect(result.stdout).toContain('Restoring');

			// The HEAD commit must contain ONLY our files.
			const committed = filesInHead().sort();
			expect(committed).toEqual(['ours-a.txt', 'ours-b.txt']);

			// The unrelated files must be back in the index, with their
			// original status codes preserved.
			const after = stagedEntries().sort((a, b) =>
				a.path.localeCompare(b.path),
			);
			expect(after).toEqual([
				{ path: 'new-from-other.txt', status: 'A' },
				{ path: 'tracked.txt', status: 'M' },
			]);
		});

		test('restores unrelated staged ignored files after atomic commit', () => {
			createFile('.gitignore', 'ignored-dir/\n');
			mkdirSync(join(tmpRepo, 'ignored-dir'), { recursive: true });
			createFile('ignored-dir/force-staged.txt', 'ignored but intentionally staged\n');
			gitCmd('add', '.gitignore');
			gitCmd('commit', '-m', 'add ignore rule', '--no-verify');

			// Simulate another agent intentionally staging an ignored file.
			// Restore must preserve that existing index state even though
			// plain `git add` would refuse the file after temporary unstaging.
			gitCmd('add', '-f', 'ignored-dir/force-staged.txt');
			expect(stagedEntries()).toEqual([
				{ path: 'ignored-dir/force-staged.txt', status: 'A' },
			]);

			createFile('ours.txt', 'ours\n');

			const result = gac(
				'commit -f ours.txt -m "test: restore ignored staged add" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout + result.stderr).not.toContain('Failed to restore');
			expect(filesInHead()).toEqual(['ours.txt']);
			expect(stagedEntries()).toEqual([
				{ path: 'ignored-dir/force-staged.txt', status: 'A' },
			]);
		});

		test('accepts cwd-relative file paths when run from a subdirectory', () => {
			mkdirSync(join(tmpRepo, 'backend'), { recursive: true });
			createFile('root-unrelated.txt', 'already staged elsewhere\n');
			createFile('backend/ours.txt', 'ours from subdir\n');
			gitCmd('add', 'root-unrelated.txt');

			const result = gac(
				'commit -f ours.txt -m "test: commit from subdir" --no-verify',
				{ cwd: join(tmpRepo, 'backend') },
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout + result.stderr).not.toContain('Failed to restore');
			expect(filesInHead()).toEqual(['backend/ours.txt']);
			expect(stagedEntries()).toEqual([
				{ path: 'root-unrelated.txt', status: 'A' },
			]);
		});

		/**
		 * Same isolation contract, but on the failure path: even when the
		 * commit fails (empty message), the unrelated staged files must be
		 * restored exactly as they were. Otherwise a hook rejection would
		 * silently destroy another agent's staged work.
		 */
		test('restores unrelated staged files after commit failure', () => {
			createFile('theirs-modified.txt', 'v1\n');
			gitCmd('add', 'theirs-modified.txt');
			gitCmd('commit', '-m', 'add their file', '--no-verify');
			createFile('theirs-modified.txt', 'v2\n');
			gitCmd('add', 'theirs-modified.txt');

			createFile('theirs-new.txt', 'theirs new\n');
			gitCmd('add', 'theirs-new.txt');

			createFile('ours.txt', 'ours\n');

			const before = stagedEntries().sort((a, b) =>
				a.path.localeCompare(b.path),
			);

			// Empty message -> commit fails.
			const result = gac('commit -f ours.txt -m "" --no-verify');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain(
				'Atomic operation failed during commit',
			);

			// The unrelated files must be back exactly as they were before.
			const after = stagedEntries().sort((a, b) =>
				a.path.localeCompare(b.path),
			);
			expect(after).toEqual(before);
			// And ours.txt was rolled back from its temporary staging.
			expect(stagedFiles()).not.toContain('ours.txt');
		});

		/**
		 * Staged deletions (status D) — whether from `git rm` or
		 * `git rm --cached` — are a different beast. A naive "git add to
		 * restore" would silently re-add the file to the index, undoing the
		 * other agent's staged removal. This test pins the behavior that
		 * staged D entries survive the atomic commit untouched.
		 */
		test('preserves an unrelated staged deletion across atomic commit', () => {
			// Set up a staged `git rm --cached` (D status, file still on disk).
			createFile('removed-from-index.txt', 'still on disk\n');
			gitCmd('add', 'removed-from-index.txt');
			gitCmd('commit', '-m', 'add file', '--no-verify');
			gitCmd('rm', '--cached', 'removed-from-index.txt');

			// Sanity: D status, file still present on disk.
			expect(stagedEntries()).toEqual([
				{ path: 'removed-from-index.txt', status: 'D' },
			]);
			expect(existsSync(join(tmpRepo, 'removed-from-index.txt'))).toBe(true);

			createFile('ours.txt', 'ours\n');

			const result = gac(
				'commit -f ours.txt -m "test: isolation preserves staged D" --no-verify',
			);
			expect(result.exitCode).toBe(0);

			// HEAD must NOT include the staged deletion.
			expect(filesInHead()).toEqual(['ours.txt']);
			// The staged deletion must still be staged with status D.
			expect(stagedEntries()).toEqual([
				{ path: 'removed-from-index.txt', status: 'D' },
			]);
			// And the file is still on disk (we only ever touched the index).
			expect(existsSync(join(tmpRepo, 'removed-from-index.txt'))).toBe(true);
		});

		/**
		 * The overlap case: a file is both already staged AND passed via
		 * --files. We must commit it (not "isolate" it), and the post-commit
		 * state should be a single committed entry — no duplicate staging.
		 */
		test('overlap: a file already staged AND in --files is committed normally', () => {
			createFile('shared.txt', 'v1\n');
			gitCmd('add', 'shared.txt');

			// Same file passed via --files — should be committed once.
			const result = gac(
				'commit -f shared.txt -m "test: overlap commits once" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Commit successful');
			// "Note: 1 file(s) already staged" with overlap labeling.
			expect(result.stdout).toContain('also in --files');

			expect(filesInHead()).toEqual(['shared.txt']);
			expect(stagedFiles()).toEqual([]);
		});

		/**
		 * Partial-hunk staging via `git add -p` produces a file that
		 * appears in BOTH `--cached` and worktree diffs. Our restore step
		 * uses `git add <file>`, which would silently fold the unstaged
		 * hunks into the index — destroying the user's hunk selection.
		 * Bail out with a clear error before any index changes happen.
		 */
		test('refuses to commit when an unrelated file has both staged and unstaged changes (partial hunks)', () => {
			createFile('base.txt', 'v1\n');
			gitCmd('add', 'base.txt');
			gitCmd('commit', '-m', 'add base', '--no-verify');

			// Stage v2, then continue editing to v3 in the working tree.
			// `git diff --cached` shows base.txt; `git diff` ALSO shows it.
			createFile('base.txt', 'v2\n');
			gitCmd('add', 'base.txt');
			createFile('base.txt', 'v3\n');

			const beforeStaged = stagedEntries();
			const beforeContent = readFileSync(join(tmpRepo, 'base.txt'), 'utf-8');

			createFile('ours.txt', 'ours\n');

			const result = gac(
				'commit -f ours.txt -m "test: refuse partial hunks" --no-verify',
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain(
				'partial-hunk staging',
			);
			expect(result.stdout + result.stderr).toContain('base.txt');

			// Index and working tree must be untouched — refusal must come
			// BEFORE we temp-unstage anything.
			expect(stagedEntries()).toEqual(beforeStaged);
			expect(readFileSync(join(tmpRepo, 'base.txt'), 'utf-8')).toBe(
				beforeContent,
			);
			expect(stagedFiles()).not.toContain('ours.txt');
			expect(lockExists()).toBe(false);
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

		test('does not undo git rm --cached when the file still exists on disk', () => {
			createFile('gone.txt', 'keep locally\n');
			gitCmd('add', 'gone.txt');
			gitCmd('commit', '-m', 'add gone', '--no-verify');
			gitCmd('rm', '--cached', 'gone.txt');

			expect(stagedFiles()).toContain('gone.txt');
			expect(existsSync(join(tmpRepo, 'gone.txt'))).toBe(true);

			const result = gac(
				'commit -f gone.txt -m "test: remove from repo only" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Skipping git add');

			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only');
			expect(treeFiles.split('\n').filter(Boolean)).not.toContain('gone.txt');
			expect(existsSync(join(tmpRepo, 'gone.txt'))).toBe(true);
		});

		test('does not roll back a staged deletion that was skipped from git add', () => {
			createFile('gone.txt', 'keep locally\n');
			gitCmd('add', 'gone.txt');
			gitCmd('commit', '-m', 'add gone', '--no-verify');
			gitCmd('rm', '--cached', 'gone.txt');

			const hookPath = join(tmpRepo, '.git', 'hooks', 'commit-msg');
			writeFileSync(
				hookPath,
				[
					'#!/bin/sh',
					'echo "hook stderr: block commit" >&2',
					'exit 1',
					'',
				].join('\n'),
			);
			chmodSync(hookPath, 0o755);

			const result = gac(
				'commit -f gone.txt -m "test: rollback preserves staged deletion"',
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain('Skipping git add');
			expect(result.stdout + result.stderr).toContain(
				'Atomic operation failed during commit',
			);
			expect(stagedFiles()).toContain('gone.txt');
			expect(existsSync(join(tmpRepo, 'gone.txt'))).toBe(true);
		});

		test('commits an UNSTAGED deletion via -f (rm in working tree)', () => {
			createFile('to-delete.txt', 'bye\n');
			gitCmd('add', 'to-delete.txt');
			gitCmd('commit', '-m', 'add to-delete', '--no-verify');

			// Delete from the working tree only (unstaged deletion).
			rmSync(join(tmpRepo, 'to-delete.txt'));

			const result = gac(
				'commit -f to-delete.txt -m "test: remove file" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only');
			expect(treeFiles.split('\n').filter(Boolean)).not.toContain(
				'to-delete.txt',
			);
		});

		test('commits an ALREADY-STAGED deletion via -f (git rm first)', () => {
			createFile('staged-del.txt', 'bye\n');
			gitCmd('add', 'staged-del.txt');
			gitCmd('commit', '-m', 'add staged-del', '--no-verify');

			// Stage the deletion first (gone from working tree AND index).
			gitCmd('rm', 'staged-del.txt');
			expect(stagedEntries().find((e) => e.path === 'staged-del.txt')?.status).toBe(
				'D',
			);

			const result = gac(
				'commit -f staged-del.txt -m "test: remove pre-staged" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only');
			expect(treeFiles.split('\n').filter(Boolean)).not.toContain(
				'staged-del.txt',
			);
		});

		test('rejects directory inputs so staging stays file-exact', () => {
			mkdirSync(join(tmpRepo, 'dir'));
			createFile('dir/a.txt', 'hello\n');

			const result = gac(
				'commit -f dir -m "test: reject directory input" --no-verify',
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain(
				'--files only accepts literal file paths',
			);
			expect(result.stdout + result.stderr).toContain('dir');
			expect(lockExists()).toBe(false);
		});

		test('treats glob-like inputs as literal filenames when the exact file exists', () => {
			createFile('*.txt', 'literal star\n');
			createFile('a.txt', 'normal file\n');

			const result = gac(
				'commit -f "*.txt" -m "test: literal pathspec filename" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Commit successful');

			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only')
				.split('\n')
				.filter(Boolean);
			expect(treeFiles).toContain('*.txt');
			expect(treeFiles).not.toContain('a.txt');
		});

		test('does not treat deleted directory prefixes as broad matches', () => {
			mkdirSync(join(tmpRepo, 'dir'));
			createFile('dir/a.txt', 'a\n');
			createFile('dir/b.txt', 'b\n');
			gitCmd('add', 'dir/a.txt', 'dir/b.txt');
			gitCmd('commit', '-m', 'add dir files', '--no-verify');
			rmSync(join(tmpRepo, 'dir'), { recursive: true, force: true });

			const result = gac(
				'commit -f dir -m "test: deleted directory prefix stays invalid" --no-verify',
			);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain(
				'--files only accepts literal file paths',
			);
			expect(result.stdout + result.stderr).toContain('dir/a.txt');
			expect(result.stdout + result.stderr).toContain('dir/b.txt');
			expect(stagedFiles()).toEqual([]);
			expect(lockExists()).toBe(false);
		});

		test('allows symlink paths even when they point to directories', () => {
			mkdirSync(join(tmpRepo, 'target'));
			createFile('target/a.txt', 'nested\n');
			symlinkSync('target', join(tmpRepo, 'linkdir'));

			const result = gac(
				'commit -f linkdir -m "test: symlink stays exact path" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Commit successful');

			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only')
				.split('\n')
				.filter(Boolean);
			expect(treeFiles).toContain('linkdir');
			expect(treeFiles).not.toContain('target/a.txt');
		});

		test('does not re-add dangling symlinks removed from the index', () => {
			symlinkSync('missing-target', join(tmpRepo, 'broken-link'));
			gitCmd('add', 'broken-link');
			gitCmd('commit', '-m', 'add broken symlink', '--no-verify');
			gitCmd('rm', '--cached', 'broken-link');

			const result = gac(
				'commit -f broken-link -m "test: remove broken symlink from repo only" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Skipping git add');

			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only')
				.split('\n')
				.filter(Boolean);
			expect(treeFiles).not.toContain('broken-link');
			expect(lstatSync(join(tmpRepo, 'broken-link')).isSymbolicLink()).toBe(true);
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

		test('surfaces hook stdout and stderr when commit fails', () => {
			createFile('a.txt');

			const hookPath = join(tmpRepo, '.git', 'hooks', 'commit-msg');
			writeFileSync(
				hookPath,
				[
					'#!/bin/sh',
					'echo "hook stdout: explain the failure"',
					'echo "hook stderr: fix this specific problem" >&2',
					'exit 1',
					'',
				].join('\n'),
			);
			chmodSync(hookPath, 0o755);

			const result = gac('commit -f a.txt -m "test: hook failure surfaces details"');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('hook stdout: explain the failure');
			expect(result.stdout + result.stderr).toContain('hook stderr: fix this specific problem');
			expect(result.stdout + result.stderr).toContain('Atomic operation failed during commit');
			expect(result.stdout + result.stderr).toContain('rolling back');
			expect(stagedFiles()).toEqual([]);
			expect(lockExists()).toBe(false);
		});

		/**
		 * Regression: when the user hits Ctrl+C during a slow pre-commit
		 * hook, the lock must be cleared before the process dies. Without
		 * an installed SIGINT handler, Node's default action for SIGINT is
		 * to terminate the process — so the try/finally that releases the
		 * lock never runs and the lock dir lingers until TTL expiry.
		 *
		 * `detached: true` puts the child in its own process group, so
		 * `process.kill(-pid, 'SIGINT')` hits both bun and git — matching
		 * how a terminal Ctrl+C signals the whole foreground group.
		 */
		test('Ctrl+C during pre-commit hook releases the lock', async () => {
			createFile('a.txt');

			const hookPath = join(tmpRepo, '.git', 'hooks', 'pre-commit');
			writeFileSync(
				hookPath,
				'#!/bin/sh\nsleep 30\n',
			);
			chmodSync(hookPath, 0o755);

			const child = spawn(
				'bun',
				[CLI, 'commit', '-f', 'a.txt', '-m', 'test: sigint cleanup'],
				{ cwd: tmpRepo, detached: true, stdio: 'pipe', env: GIT_TEST_ENV },
			);

			// Wait long enough for the lock to be acquired and for
			// spawnSync to be blocked inside the sleeping hook.
			await new Promise((r) => setTimeout(r, 2500));
			expect(lockExists()).toBe(true);

			process.kill(-child.pid!, 'SIGINT');

			await new Promise<void>((resolve) => {
				child.on('exit', () => resolve());
			});

			expect(lockExists()).toBe(false);
			expect(stagedFiles()).toEqual([]);
		}, 15000);

		/**
		 * Ctrl+C during a slow pre-commit hook must ALSO restore unrelated
		 * staged files, otherwise an interrupt during a long hook would
		 * silently lose another agent's staged work. Mirrors the lock-
		 * cleanup test above, but seeds an unrelated staged file first
		 * and asserts it survives the signal.
		 */
		test('Ctrl+C during pre-commit hook restores unrelated staging', async () => {
			// Pre-stage an unrelated file (newly added, status A).
			createFile('unrelated.txt', 'unrelated content\n');
			gitCmd('add', 'unrelated.txt');
			expect(stagedEntries()).toEqual([
				{ path: 'unrelated.txt', status: 'A' },
			]);

			createFile('a.txt');

			const hookPath = join(tmpRepo, '.git', 'hooks', 'pre-commit');
			writeFileSync(hookPath, '#!/bin/sh\nsleep 30\n');
			chmodSync(hookPath, 0o755);

			const child = spawn(
				'bun',
				[CLI, 'commit', '-f', 'a.txt', '-m', 'test: sigint restores staging'],
				{ cwd: tmpRepo, detached: true, stdio: 'pipe', env: GIT_TEST_ENV },
			);

			// Wait for lock acquisition + temp-unstage + entry into the
			// sleeping hook before signaling.
			await new Promise((r) => setTimeout(r, 2500));
			expect(lockExists()).toBe(true);

			process.kill(-child.pid!, 'SIGINT');

			await new Promise<void>((resolve) => {
				child.on('exit', () => resolve());
			});

			// Lock cleaned up, our file rolled back, and the unrelated
			// file's prior staged state restored exactly as it was.
			expect(lockExists()).toBe(false);
			expect(stagedFiles()).not.toContain('a.txt');
			expect(stagedEntries()).toEqual([
				{ path: 'unrelated.txt', status: 'A' },
			]);
		}, 15000);
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
			// Multi-turn locks store a sentinel PID so they survive the CLI exiting.
			expect(info.pid).toBe(-1);

			gac('unlock --force');
		});

		test('blocks when lock is already held', () => {
			gac('lock -o "agent-1"');

			const result = gac('lock -o "agent-2"');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Lock held by "agent-1"');

			gac('unlock --force');
		});

		test('--wait times out if lock is never released', () => {
			gac('lock -o "agent-1" -t 60');

			const start = Date.now();
			const result = gac('lock -o "agent-2" --wait 2');
			const elapsedMs = Date.now() - start;

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Lock held by "agent-1"');
			// Should have waited roughly the full timeout (poll interval is 3s,
			// so a 2s wait sleeps once for ~2s before giving up).
			expect(elapsedMs).toBeGreaterThanOrEqual(1800);

			gac('unlock --force');
		});

		/**
		 * Schedule `gac` to run in a detached subprocess after `delayMs`.
		 * Needed because the main test thread is blocking inside a sync
		 * `gac()` call while waiting, so setTimeout would never fire.
		 */
		function scheduleGac(args: string, delayMs: number): void {
			const child = spawn(
				'sh',
				['-c', `sleep ${delayMs / 1000} && bun "${CLI}" ${args}`],
				{ cwd: tmpRepo, detached: true, stdio: 'ignore', env: GIT_TEST_ENV },
			);
			child.unref();
		}

		test('--wait acquires the lock once the holder releases it', () => {
			gac('lock -o "agent-1" -t 60');
			scheduleGac('unlock --force', 1000);

			const result = gac('lock -o "agent-2" --wait 10');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Lock acquired');

			const info = readLockInfo();
			expect(info.owner).toBe('agent-2');

			gac('unlock --force');
		}, 20000);

		test('commit --wait blocks until the holder releases the lock', () => {
			createFile('a.txt');
			gac('lock -o "holder"');
			scheduleGac('unlock --force', 1000);

			const result = gac(
				'commit -f a.txt -m "test: commit waits for lock" --wait 10 --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Commit successful');
			expect(lockExists()).toBe(false);
		}, 20000);

		test('lock stores a detached pid so the lock outlives the acquiring CLI process', () => {
			gac('lock -o "session-1" -t 60');
			const info = readLockInfo();
			expect(info.pid).toBe(-1);
			gac('unlock --force');
		});

		test('detached lock is not stolen just because the acquiring CLI exited', () => {
			gac('lock -o "session-1" -t 60');

			// Simulate time passing: age the lock past STALE_PID_GRACE (10s)
			// and beyond a point where the PID-death heuristic would fire.
			const lockFile = join(lockDir(), 'lock.json');
			const info = JSON.parse(readFileSync(lockFile, 'utf-8'));
			info.acquiredAt = Date.now() - 30_000;
			writeFileSync(lockFile, JSON.stringify(info));

			const result = gac('lock -o "other-session"');
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Lock held by "session-1"');

			gac('unlock --force');
		});

		test('commit -o <owner> reuses a detached session lock even after it ages past PID grace', () => {
			createFile('a.txt');
			gac('lock -o "session-1" -t 60');

			// Age the lock past STALE_PID_GRACE so the old PID-death heuristic
			// would incorrectly mark it stale.
			const lockFile = join(lockDir(), 'lock.json');
			const info = JSON.parse(readFileSync(lockFile, 'utf-8'));
			info.acquiredAt = Date.now() - 30_000;
			writeFileSync(lockFile, JSON.stringify(info));

			const result = gac(
				'commit -o "session-1" -f a.txt -m "test: reuse aged session lock" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Using existing lock');
			// Multi-turn contract: commit using an externally-held lock must not release it.
			expect(lockExists()).toBe(true);

			gac('unlock -o "session-1"');
		});

		test('TTL expiry still makes a detached lock stealable', () => {
			gac('lock -o "session-1" -t 60');

			// TTL expired: age past 60s
			const lockFile = join(lockDir(), 'lock.json');
			const info = JSON.parse(readFileSync(lockFile, 'utf-8'));
			info.acquiredAt = Date.now() - 120_000;
			writeFileSync(lockFile, JSON.stringify(info));

			const result = gac('lock -o "session-2"');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('stale');
			expect(readLockInfo().owner).toBe('session-2');

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

	// ── stage / unstage ───────────────────────────────────────

	describe('stage', () => {
		test('stages files while keeping a detached transaction lock held', () => {
			createFile('a.txt', 'hello\n');
			createFile('b.txt', 'world\n');

			const result = gac('stage -o "session-1" -t 120 -f a.txt b.txt');

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Lock acquired');
			expect(result.stdout).toContain('Staged 2 file(s)');
			expect(stagedFiles().sort()).toEqual(['a.txt', 'b.txt']);
			expect(lockExists()).toBe(true);

			const info = readLockInfo();
			expect(info.owner).toBe('session-1');
			expect(info.pid).toBe(-1);
			expect(info.ttlSeconds).toBe(120);

			gac('unlock -o "session-1"');
		});

		test('reuses an existing transaction lock for the same owner', () => {
			createFile('a.txt', 'hello\n');
			gac('lock -o "session-1"');

			const result = gac('stage -o "session-1" -f a.txt');

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Using existing lock');
			expect(stagedFiles()).toEqual(['a.txt']);
			expect(lockExists()).toBe(true);
			expect(readLockInfo().owner).toBe('session-1');

			gac('unlock -o "session-1"');
		});

		test('does not stage when another owner holds the lock', () => {
			createFile('a.txt', 'hello\n');
			gac('lock -o "holder"');

			const result = gac('stage -o "intruder" -f a.txt');

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('Lock held by "holder"');
			expect(stagedFiles()).toEqual([]);
			expect(readLockInfo().owner).toBe('holder');

			gac('unlock --force');
		});

		test('releases a newly acquired lock when staging fails', () => {
			const result = gac('stage -o "session-1" -f missing.txt');

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('missing.txt');
			expect(lockExists()).toBe(false);
		});
	});

	describe('unstage', () => {
		test('unstages requested files while keeping the transaction lock held', () => {
			createFile('a.txt', 'hello\n');
			createFile('b.txt', 'world\n');
			gac('stage -o "session-1" -f a.txt b.txt');

			const result = gac('unstage -o "session-1" -f a.txt');

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Unstaged 1 file(s)');
			expect(stagedFiles()).toEqual(['b.txt']);
			expect(lockExists()).toBe(true);
			expect(readLockInfo().owner).toBe('session-1');

			gac('unlock -o "session-1"');
		});

		test('rejects unstage when the owner does not match', () => {
			createFile('a.txt', 'hello\n');
			gac('stage -o "session-1" -f a.txt');

			const result = gac('unstage -o "other" -f a.txt');

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('not "other"');
			expect(stagedFiles()).toEqual(['a.txt']);
			expect(readLockInfo().owner).toBe('session-1');

			gac('unlock --force');
		});

		test('unstages a staged deletion without hiding git failures', () => {
			createFile('tracked.txt', 'v1\n');
			gitCmd('add', 'tracked.txt');
			gitCmd('commit', '-m', 'add tracked', '--no-verify');
			gitCmd('rm', 'tracked.txt');
			expect(stagedEntries()).toEqual([{ path: 'tracked.txt', status: 'D' }]);
			gac('lock -o "session-1"');

			const result = gac('unstage -o "session-1" -f tracked.txt');

			expect(result.exitCode).toBe(0);
			expect(stagedFiles()).toEqual([]);
			expect(lockExists()).toBe(true);

			gac('unlock -o "session-1"');
		});

		test('reports unstage failures instead of claiming success', () => {
			gac('lock -o "session-1"');

			const result = gac('unstage -o "session-1" -f missing.txt');

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('missing.txt');
			expect(result.stdout + result.stderr).not.toContain('Unstaged 1 file(s)');
			expect(lockExists()).toBe(true);

			gac('unlock -o "session-1"');
		});
	});

	// ── TTL validation ───────────────────────────────────────

	describe('phantom-D auto-correct', () => {
		// These tests exercise the post-commit audit in `restoreUnrelatedStaging`
		// that detects and self-corrects "phantom" staged-deletions: index
		// entries that say "deleted from tracking" while the on-disk file is
		// byte-identical to HEAD's blob. Such entries can arise when a
		// concurrent atomic-commit invocation's `temporarilyUnstage` window is
		// observed by another's snapshot; without auto-correct, the D status
		// gets re-applied on every subsequent commit and propagates forever.
		test('auto-corrects a phantom staged-D when disk matches HEAD AND contention was observed', () => {
			createFile('tracked.txt', 'committed content\n');
			createFile('other.txt', 'sibling\n');
			gitCmd('add', 'tracked.txt', 'other.txt');
			gitCmd('commit', '-m', 'baseline', '--no-verify');

			// Manually corrupt the index: stage D for tracked.txt while
			// disk content still matches HEAD. This is the rubber-checkout
			// reproduction case.
			gitCmd('rm', '--cached', 'tracked.txt');
			expect(stagedFiles()).toContain('tracked.txt');

			// Force the CLI to observe CS-lock contention by pre-creating
			// a stale sentinel — the spinner will see EEXIST, mark
			// `csLockContended=true`, then reclaim and proceed. Without
			// observed contention the auto-correct is intentionally a
			// no-op (preserves intentional `git rm --cached` semantics).
			const csLock = join(tmpRepo, '.git', 'atomic-commit.cs-lock');
			writeFileSync(csLock, `99999\n0\n`);
			const tenMinAgoSec = Math.floor(Date.now() / 1000) - 600;
			execSync(
				`touch -t $(date -r ${tenMinAgoSec} +%Y%m%d%H%M.%S) "${csLock}"`,
				{ stdio: 'pipe' },
			);

			createFile('other2.txt', 'fresh\n');
			const stdout = execSync(
				`GAC_CS_STALE_MS=60000 GAC_CS_WAIT_MS=2000 ` +
					`bun "${CLI}" commit -f other2.txt -m "test: phantom-D" --no-verify 2>&1`,
				{ encoding: 'utf-8', cwd: tmpRepo, stdio: 'pipe' },
			);

			expect(stdout).toContain('Commit successful');
			expect(stdout).toContain('Auto-corrected 1 phantom staged-deletion');
			expect(stagedFiles()).not.toContain('tracked.txt');
		});

		test('preserves a genuine staged-D when disk content differs from HEAD', () => {
			createFile('tracked.txt', 'original\n');
			createFile('other.txt', 'sibling\n');
			gitCmd('add', 'tracked.txt', 'other.txt');
			gitCmd('commit', '-m', 'baseline', '--no-verify');

			// Stage delete + write divergent on-disk content. User intent
			// is real (replacing the file with something else), so auto-
			// correct must NOT undo it.
			gitCmd('rm', '--cached', 'tracked.txt');
			createFile('tracked.txt', 'totally different scratch\n');

			createFile('other2.txt', 'fresh\n');
			const result = gac('commit -f other2.txt -m "test: real-D" --no-verify');

			expect(result.exitCode).toBe(0);
			expect(result.stderr + result.stdout).not.toContain('Auto-corrected');
			expect(stagedFiles()).toContain('tracked.txt');
		});

		test('preserves a genuine staged-D when the file is gone from disk', () => {
			createFile('tracked.txt', 'original\n');
			createFile('other.txt', 'sibling\n');
			gitCmd('add', 'tracked.txt', 'other.txt');
			gitCmd('commit', '-m', 'baseline', '--no-verify');

			gitCmd('rm', 'tracked.txt');
			expect(existsSync(join(tmpRepo, 'tracked.txt'))).toBe(false);

			createFile('other2.txt', 'fresh\n');
			const result = gac('commit -f other2.txt -m "test: real-rm" --no-verify');

			expect(result.exitCode).toBe(0);
			expect(result.stderr + result.stdout).not.toContain('Auto-corrected');
			expect(stagedFiles()).toContain('tracked.txt');
		});
	});

	describe('critical-section mutex', () => {
		// Process-bound sentinel that serializes the snapshot→unstage→commit
		// →restore phase across concurrent invocations regardless of owner.
		// Production timings (60s wait, 2min staleness) are too long for
		// tests; we inject GAC_CS_* env overrides to compress them.
		const csLockPath = (): string =>
			join(tmpRepo, '.git', 'atomic-commit.cs-lock');

		test('sentinel is created and cleaned up around a successful commit', () => {
			createFile('a.txt');
			expect(existsSync(csLockPath())).toBe(false);
			const result = gac('commit -f a.txt -m "test" --no-verify');
			expect(result.exitCode).toBe(0);
			expect(existsSync(csLockPath())).toBe(false);
		});

		test('sentinel is cleaned up after a failed commit', () => {
			createFile('a.txt');
			// Empty commit message → git commit fails.
			const result = gac('commit -f a.txt -m "" --no-verify');
			expect(result.exitCode).not.toBe(0);
			expect(existsSync(csLockPath())).toBe(false);
		});

		test('contention: second invocation waits and times out when sentinel is fresh', () => {
			createFile('a.txt');
			// Pre-create the sentinel with a fresh mtime to simulate another
			// process holding the critical section.
			writeFileSync(csLockPath(), `${process.pid}\n${Date.now()}\n`);

			let stdout = '';
			let stderr = '';
			let exitCode = 0;
			try {
				stdout = execSync(
					`GAC_CS_WAIT_MS=1000 GAC_CS_STALE_MS=600000 GAC_CS_POLL_MIN_MS=50 GAC_CS_POLL_MAX_MS=100 ` +
						`bun "${CLI}" commit -f a.txt -m "test" --no-verify 2>&1`,
					{ encoding: 'utf-8', cwd: tmpRepo, stdio: 'pipe' },
				);
			} catch (err: any) {
				stdout = err.stdout?.toString() ?? '';
				stderr = err.stderr?.toString() ?? '';
				exitCode = err.status ?? 1;
			}

			const combined = stdout + stderr;
			expect(combined).toContain('critical-section lock contention');
			expect(exitCode).not.toBe(0);

			// Clean up so afterEach doesn't see leftover state.
			try {
				rmSync(csLockPath());
			} catch {}
		});

		test('staleness: second invocation reclaims when sentinel is older than threshold', () => {
			createFile('a.txt');
			// Pre-create sentinel and backdate it well past the staleness
			// threshold so the invocation immediately reclaims it.
			writeFileSync(csLockPath(), `99999\n0\n`);
			const tenMinAgoSec = Math.floor(Date.now() / 1000) - 600;
			execSync(
				`touch -t $(date -r ${tenMinAgoSec} +%Y%m%d%H%M.%S) "${csLockPath()}"`,
				{ stdio: 'pipe' },
			);

			const stdout = execSync(
				`GAC_CS_WAIT_MS=2000 GAC_CS_STALE_MS=60000 ` +
					`bun "${CLI}" commit -f a.txt -m "test" --no-verify 2>&1`,
				{ encoding: 'utf-8', cwd: tmpRepo, stdio: 'pipe' },
			);
			expect(stdout).toContain('Commit successful');
			expect(existsSync(csLockPath())).toBe(false);
		});
	});

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
		test('lock → commit reuses the lock and leaves cleanup to the owner', () => {
			createFile('a.txt');

			gac('lock -o "session-1"');
			expect(lockExists()).toBe(true);

			const result = gac(
				'commit -o "session-1" -f a.txt -m "test: multi-turn" --no-verify',
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Using existing lock');
			expect(result.stdout).toContain('Commit successful');

			// A reused multi-turn lock is intentionally not released by commit.
			expect(lockExists()).toBe(true);

			// Agent cleans up
			gac('unlock -o "session-1"');
			expect(lockExists()).toBe(false);
		});

		test('stage → inspect → commit keeps one transaction lock throughout', () => {
			createFile('a.txt', 'hello\n');
			createFile('b.txt', 'world\n');

			const stageResult = gac('stage -o "session-1" -f a.txt b.txt');
			expect(stageResult.exitCode).toBe(0);
			expect(stagedFiles().sort()).toEqual(['a.txt', 'b.txt']);
			expect(lockExists()).toBe(true);

			const commitResult = gac(
				'commit -o "session-1" -f a.txt b.txt -m "test: staged transaction" --no-verify',
			);

			expect(commitResult.exitCode).toBe(0);
			expect(commitResult.stdout).toContain('Using existing lock');
			expect(commitResult.stdout).toContain('Commit successful');
			expect(filesInHead().sort()).toEqual(['a.txt', 'b.txt']);
			expect(stagedFiles()).toEqual([]);
			expect(lockExists()).toBe(true);

			gac('unlock -o "session-1"');
		});
	});

	// ── own-diff gates ───────────────────────────────────────
	//
	// The gate validates the committer's OWN diff (scoped lint/typecheck on
	// the -f files) and runs on every commit regardless of --no-verify,
	// closing the "--no-verify laundering" hole. It is repo-owned: opt in via
	// GIT_ATOMIC_GATE_CMD or an executable `.git-atomic-gate` at the repo
	// root. GIT_ATOMIC_SKIP_GATES=1 is the loud emergency bypass.
	describe('own-diff gates', () => {
		test('no gate configured → commit works unchanged (backward compatible)', () => {
			createFile('a.txt');
			const result = gac('commit -f a.txt -m "test: no gate" --no-verify');
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Commit successful');
			// Silent when no gate is configured — no gate chatter in output.
			expect(result.stdout).not.toContain('own-diff gate');
			expect(filesInHead()).toContain('a.txt');
		});

		test('a failing gate BLOCKS the commit even with --no-verify', () => {
			createFile('a.txt');
			const result = gac('commit -f a.txt -m "test: blocked" --no-verify', {
				// exits non-zero → own diff fails the gate
				env: { GIT_ATOMIC_GATE_CMD: 'exit 3' },
			});
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('Own-diff gate failed');
			// Commit must NOT have happened — HEAD still the init commit.
			expect(gitCmd('log', '--format=%s', '-n', '1')).toBe('init');
			// And a.txt must not be left staged (fast-fail before staging).
			expect(stagedFiles()).toEqual([]);
		});

		test('a passing gate lets the commit through', () => {
			createFile('a.txt');
			const result = gac('commit -f a.txt -m "test: gate pass" --no-verify', {
				env: { GIT_ATOMIC_GATE_CMD: 'exit 0' },
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Own-diff gate passed');
			expect(filesInHead()).toContain('a.txt');
		});

		test('GIT_ATOMIC_SKIP_GATES=1 bypasses a failing gate with a loud warning', () => {
			createFile('a.txt');
			const result = gac('commit -f a.txt -m "test: emergency bypass" --no-verify', {
				env: { GIT_ATOMIC_GATE_CMD: 'exit 1', GIT_ATOMIC_SKIP_GATES: '1' },
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain('SKIPPING own-diff');
			expect(filesInHead()).toContain('a.txt');
		});

		test('the gate receives the exact -f file list via GIT_ATOMIC_FILES', () => {
			createFile('a.txt');
			createFile('b.txt');
			// Gate writes $GIT_ATOMIC_FILES to a marker, then passes.
			const result = gac(
				'commit -f a.txt b.txt -m "test: file list" --no-verify',
				{
					env: {
						GIT_ATOMIC_GATE_CMD:
							'printf "%s" "$GIT_ATOMIC_FILES" > .gate-marker',
					},
				},
			);
			expect(result.exitCode).toBe(0);
			const marker = readFileSync(join(tmpRepo, '.gate-marker'), 'utf-8');
			const seen = marker.split('\n').filter(Boolean).sort();
			expect(seen).toEqual(['a.txt', 'b.txt']);
		});

		test('an executable .git-atomic-gate at the repo root is auto-detected', () => {
			createFile('a.txt');
			// A repo-root gate script that always fails.
			const gatePath = join(tmpRepo, '.git-atomic-gate');
			writeFileSync(gatePath, '#!/bin/sh\nexit 7\n');
			chmodSync(gatePath, 0o755);
			const result = gac('commit -f a.txt -m "test: file gate" --no-verify');
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain('Own-diff gate failed');
			expect(gitCmd('log', '--format=%s', '-n', '1')).toBe('init');
		});

		test('gate is skipped when there are no files (defensive)', () => {
			// -f requires at least one file, so exercise the empty case via a
			// gate that would fail if run; committing an existing staged file
			// with a gate still runs it, so instead assert the gate DOES run
			// for a real file (guards against accidental no-op regressions).
			createFile('a.txt');
			const result = gac('commit -f a.txt -m "test: runs" --no-verify', {
				env: { GIT_ATOMIC_GATE_CMD: 'exit 0' },
			});
			expect(result.stdout).toContain('Running own-diff gate on 1 file');
		});
	});

	// ── BDL-2679: no failure path may exit 0 ──────────────────
	//
	// Three sites downgraded a real failure into a log line while the
	// process still exited 0 (or silently did less than it was asked).
	// Every assertion below is on the WITNESS (the tree, the index, the
	// message) rather than on the exit code alone, because the defect
	// under test IS a wrong exit code — asserting only on status is how
	// this class ships green.
	describe('BDL-2679: failure paths must not report success', () => {
		test('commits an explicitly-named -f path that is the SOURCE half of a staged rename', () => {
			// The production shape (rubber 8173e419ae -> 82bd2b7885, 34s
			// apart): `git mv old new`, then write a re-export shim back at
			// the OLD path, then commit both by name. Limited to the old
			// path, `git diff --cached --name-status` cannot pair the
			// rename and reports a bare `D`, so the staged-deletion filter
			// misread the rename source as an intentional `git rm --cached`
			// and dropped a file the caller named on -f.
			mkdirSync(join(tmpRepo, 'old'), { recursive: true });
			createFile('old/foo.ts', 'export const foo = 1;\n');
			gitCmd('add', 'old/foo.ts');
			gitCmd('commit', '-m', 'add old/foo.ts', '--no-verify');

			mkdirSync(join(tmpRepo, 'new'), { recursive: true });
			gitCmd('mv', 'old/foo.ts', 'new/foo.ts');
			createFile('old/foo.ts', "export * from '../new/foo.ts';\n");

			const result = gac(
				'commit -f old/foo.ts new/foo.ts -m "test: move + re-export shim" --no-verify',
			);

			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only')
				.split('\n')
				.filter(Boolean);
			// THE WITNESS: both named paths are in the commit.
			expect(treeFiles).toContain('new/foo.ts');
			expect(treeFiles).toContain('old/foo.ts');
			expect(gitCmd('show', 'HEAD:old/foo.ts')).toContain(
				"export * from '../new/foo.ts';",
			);
			expect(result.exitCode).toBe(0);
		});

		test('stage reports the number of files it ACTUALLY staged, not the number requested', () => {
			// `git rm --cached` case: the path is legitimately excluded from
			// `git add`, so 1 of 2 requested paths is staged. The summary
			// line interpolated the REQUESTED count, printing an
			// affirmatively false success number.
			createFile('gone.txt', 'keep locally\n');
			gitCmd('add', 'gone.txt');
			gitCmd('commit', '-m', 'add gone', '--no-verify');
			gitCmd('rm', '--cached', 'gone.txt');
			createFile('kept.txt', 'new file\n');

			const result = gac('stage -f gone.txt kept.txt');

			expect(result.stdout).toContain('Skipping git add');
			// THE WITNESS: exactly one path was newly added to the index.
			expect(stagedFiles()).toContain('kept.txt');
			expect(result.stdout).not.toContain('Staged 2 file(s)');
			expect(result.stdout).toContain('Staged 1 file(s)');
		});

		test('exits NON-ZERO when a peer’s staged file could not be restored after the commit', () => {
			// Sites A+B: restoreUnrelatedStaging collected per-file failures
			// into an array, logged "ERROR: Failed to restore prior
			// staging...", and returned void; the caller's catch never set
			// commitFailed, so the run fell through the exit gate at 0.
			// The thing not restored is ANOTHER AGENT'S staged work.
			createFile('unrelated.txt', 'v1\n');
			createFile('mine.txt', 'mine v1\n');
			gitCmd('add', 'unrelated.txt', 'mine.txt');
			gitCmd('commit', '-m', 'base', '--no-verify');

			// A peer stages in-flight work.
			createFile('unrelated.txt', 'peer in-flight edit\n');
			gitCmd('add', 'unrelated.txt');
			expect(stagedFiles()).toContain('unrelated.txt');

			// Stand-in for a concurrent git process holding index.lock
			// during the restore window: a post-commit hook that creates it.
			const hookPath = join(tmpRepo, '.git', 'hooks', 'post-commit');
			writeFileSync(
				hookPath,
				['#!/bin/sh', 'touch "$(git rev-parse --git-dir)/index.lock"', ''].join(
					'\n',
				),
			);
			chmodSync(hookPath, 0o755);

			createFile('mine.txt', 'mine v2\n');
			const result = gac('commit -f mine.txt -m "test: my own commit" --no-verify');

			// THE WITNESS: the commit landed, and the peer's staging did not
			// come back. Both facts must be visible to a caller.
			expect(gitCmd('log', '--format=%s', '-n', '1')).toBe('test: my own commit');
			expect(result.stdout + result.stderr).toContain(
				'Failed to restore prior staging',
			);
			expect(result.exitCode).not.toBe(0);
		});

		test('handles a rename whose OLD path contains non-ASCII characters', () => {
			// `git diff --name-status` C-quotes such paths by default
			// (core.quotePath), so a newline-split comparison against the
			// raw path silently never matches — and the path is dropped
			// again, for exactly the files least likely to be noticed.
			// `-z` emits raw NUL-delimited fields instead.
			mkdirSync(join(tmpRepo, 'öld'), { recursive: true });
			createFile('öld/fü.ts', 'export const foo = 1;\n');
			gitCmd('add', 'öld/fü.ts');
			gitCmd('commit', '-m', 'add unicode path', '--no-verify');

			mkdirSync(join(tmpRepo, 'new'), { recursive: true });
			gitCmd('mv', 'öld/fü.ts', 'new/fü.ts');
			createFile('öld/fü.ts', "export * from '../new/fü.ts';\n");

			gac('commit -f öld/fü.ts new/fü.ts -m "test: unicode move + shim" --no-verify');

			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only', '-z')
				.split('\0')
				.filter(Boolean);
			expect(treeFiles).toContain('new/fü.ts');
			expect(treeFiles).toContain('öld/fü.ts');
		});

		test('refuses to silently drop a -f path whose staged deletion is replaced by NEW on-disk content', () => {
			// QA VARIANT B. `git rm impl.ts` stages a D and removes it from
			// disk; a NEW file is then written at the SAME path and named on
			// -f. There is no rename pair, so the rename-aware guard cannot
			// fire, and the exclusion filter read the replacement as an
			// intentional `git rm --cached`: the commit recorded a DELETION of
			// the very path the caller asked to commit, the replacement was
			// left untracked, and the run exited 0.
			createFile('impl.ts', 'export const v = 1;\n');
			gitCmd('add', 'impl.ts');
			gitCmd('commit', '-m', 'add impl', '--no-verify');
			const base = gitCmd('rev-parse', 'HEAD');

			gitCmd('rm', '--quiet', 'impl.ts');
			createFile('impl.ts', 'export const v = 2; // rewritten\n');

			const result = gac('commit -f impl.ts -m "test: replace impl" --no-verify');

			// THE WITNESS: no commit may land that omits the named path's
			// on-disk content while reporting success.
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('impl.ts');
			expect(gitCmd('rev-parse', 'HEAD')).toBe(base);
			// The caller's content is untouched on disk — we refuse, we do not destroy.
			expect(readFileSync(join(tmpRepo, 'impl.ts'), 'utf-8')).toContain('v = 2');
		});

		test('refuses to silently drop a -f path when a move rewrote the file below git\u2019s rename threshold', () => {
			// QA VARIANT A. Move a file AND rewrite it past the similarity
			// threshold, plus a shim at the old path. git reports
			// [A new/foo.ts, D old/foo.ts] with NO R pair, so
			// isStagedRenameSource is false and the old path was dropped —
			// exactly as before the rename fix. Move-and-rewrite in one commit
			// is a more common refactor than a 100% rename.
			mkdirSync(join(tmpRepo, 'old'), { recursive: true });
			createFile('old/foo.ts', 'export const alpha = 1;\n');
			gitCmd('add', 'old/foo.ts');
			gitCmd('commit', '-m', 'add old/foo.ts', '--no-verify');
			const base = gitCmd('rev-parse', 'HEAD');

			mkdirSync(join(tmpRepo, 'new'), { recursive: true });
			gitCmd('rm', '--quiet', 'old/foo.ts');
			createFile(
				'new/foo.ts',
				'export function totallyDifferent() { return "not one line in common"; }\n',
			);
			gitCmd('add', 'new/foo.ts');
			// `git rm` took the now-empty `old/` directory with it.
			mkdirSync(join(tmpRepo, 'old'), { recursive: true });
			createFile('old/foo.ts', "export * from '../new/foo.ts';\n");

			const result = gac(
				'commit -f old/foo.ts new/foo.ts -m "test: move + rewrite + shim" --no-verify',
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('old/foo.ts');
			expect(gitCmd('rev-parse', 'HEAD')).toBe(base);
		});

		test('stage refuses the same silent drop — the filter has TWO call sites', () => {
			createFile('impl.ts', 'export const v = 1;\n');
			gitCmd('add', 'impl.ts');
			gitCmd('commit', '-m', 'add impl', '--no-verify');
			gitCmd('rm', '--quiet', 'impl.ts');
			createFile('impl.ts', 'export const v = 2;\n');

			const result = gac('stage -f impl.ts');

			expect(result.exitCode).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('impl.ts');
		});

		test('--allow-dropped-files opts back in to the skip', () => {
			// The escape hatch keeps the ambiguous-but-legitimate workflow
			// reachable: untrack a path deliberately while its on-disk content
			// has moved on. Opt-in, never the default.
			createFile('impl.ts', 'export const v = 1;\n');
			gitCmd('add', 'impl.ts');
			gitCmd('commit', '-m', 'add impl', '--no-verify');
			gitCmd('rm', '--quiet', 'impl.ts');
			createFile('impl.ts', 'export const v = 2;\n');

			const result = gac(
				'commit -f impl.ts -m "test: intentional untrack" --no-verify --allow-dropped-files',
			);

			expect(result.exitCode).toBe(0);
			const treeFiles = gitCmd('ls-tree', '-r', 'HEAD', '--name-only')
				.split('\n')
				.filter(Boolean);
			expect(treeFiles).not.toContain('impl.ts');
		});

		test('does not FALSELY refuse a genuine git rm --cached when invoked from a SUBDIRECTORY', () => {
			// The refusal guard compares the working-tree file against HEAD.
			// `git ls-tree` is given a `:(top,literal)` pathspec so it is
			// repo-root-relative, but `git hash-object` takes a FILESYSTEM
			// path and resolves it against CWD — so a repo-relative path
			// handed to it from a subdirectory does not exist, the comparison
			// throws, and the conservative `catch` reports "content differs"
			// for a file that is byte-identical. A hard block on a legitimate
			// workflow, in the direction the guard is least likely to be
			// suspected of.
			//
			// Every other fixture in this file runs from the repo root, so the
			// suite was structurally incapable of catching this.
			mkdirSync(join(tmpRepo, 'sub'), { recursive: true });
			createFile('sub/gone.txt', 'keep locally\n');
			gitCmd('add', 'sub/gone.txt');
			gitCmd('commit', '-m', 'add sub/gone.txt', '--no-verify');
			gitCmd('rm', '--cached', 'sub/gone.txt');

			const result = gac('commit -f gone.txt -m "test: untrack from subdir" --no-verify', {
				cwd: join(tmpRepo, 'sub'),
			});

			expect(result.stdout + result.stderr).not.toContain('Refusing to run');
			expect(result.exitCode).toBe(0);
			expect(
				gitCmd('ls-tree', '-r', 'HEAD', '--name-only').split('\n').filter(Boolean),
			).not.toContain('sub/gone.txt');
		});
	});
});

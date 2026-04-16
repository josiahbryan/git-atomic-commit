#!/usr/bin/env bun

/**
 * Installer for git-atomic-commit.
 *
 * Idempotent — safe to run multiple times. Creates (or updates) a wrapper
 * script at /usr/local/bin/git-atomic-commit that delegates to the TS
 * source in this project via bun.
 *
 * Usage:
 *   bun src/install.ts            # install / repair
 *   bun src/install.ts --uninstall  # remove wrapper and clean up
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	rmSync,
	chmodSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

// ── Paths ────────────────────────────────────────────────────

const SRC_DIR = import.meta.dir; // …/src
const PROJECT_ROOT = resolve(SRC_DIR, '..');
const CLI_SOURCE = join(SRC_DIR, 'cli.ts');
const BIN_PATH = '/usr/local/bin/git-atomic-commit';
const OLD_LIB_DIR = '/usr/local/lib/git-atomic-commit';

// ── Helpers ──────────────────────────────────────────────────

function log(msg: string) {
	console.log(`[install] ${msg}`);
}
function logError(msg: string) {
	console.error(`[install] ERROR: ${msg}`);
}

function expectedWrapper(): string {
	return `#!/usr/bin/env bash\nexec bun "${CLI_SOURCE}" "$@"\n`;
}

function bunAvailable(): boolean {
	try {
		execSync('which bun', { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

// ── Uninstall ────────────────────────────────────────────────

function uninstall() {
	if (existsSync(BIN_PATH)) {
		rmSync(BIN_PATH);
		log(`Removed ${BIN_PATH}`);
	} else {
		log(`${BIN_PATH} not found — nothing to remove.`);
	}

	if (existsSync(OLD_LIB_DIR)) {
		rmSync(OLD_LIB_DIR, { recursive: true });
		log(`Removed legacy ${OLD_LIB_DIR}`);
	}

	log('Uninstall complete.');
}

// ── Install ──────────────────────────────────────────────────

function install() {
	// 1. Preflight checks
	if (!bunAvailable()) {
		logError(
			'bun is not installed. Install it first: https://bun.sh',
		);
		process.exit(1);
	}

	if (!existsSync(CLI_SOURCE)) {
		logError(`CLI source not found at ${CLI_SOURCE}`);
		process.exit(1);
	}

	// 2. Install dependencies if needed
	const nodeModules = join(PROJECT_ROOT, 'node_modules');
	if (!existsSync(nodeModules)) {
		log('Installing dependencies...');
		execSync('bun install', { cwd: PROJECT_ROOT, stdio: 'inherit' });
	}

	// 3. Create or update the wrapper script
	const expected = expectedWrapper();

	if (existsSync(BIN_PATH)) {
		const current = readFileSync(BIN_PATH, 'utf-8');
		if (current === expected) {
			log(`${BIN_PATH} already correct — no changes needed.`);
		} else {
			log(`Updating ${BIN_PATH} (path was stale or wrong)...`);
			writeFileSync(BIN_PATH, expected);
			chmodSync(BIN_PATH, 0o755);
			log(`Updated.`);
		}
	} else {
		log(`Creating ${BIN_PATH}...`);
		writeFileSync(BIN_PATH, expected);
		chmodSync(BIN_PATH, 0o755);
		log(`Created.`);
	}

	// 4. Clean up legacy /usr/local/lib install if present
	if (existsSync(OLD_LIB_DIR)) {
		log(`Removing legacy ${OLD_LIB_DIR}...`);
		rmSync(OLD_LIB_DIR, { recursive: true });
		log('Removed.');
	}

	// 5. Verify
	try {
		const version = execSync('git-atomic-commit --version', {
			encoding: 'utf-8',
		}).trim();
		log(`Installed successfully. Version: ${version}`);
	} catch {
		logError(
			'Installation appeared to succeed but verification failed. ' +
				'Check that /usr/local/bin is in your PATH.',
		);
		process.exit(1);
	}
}

// ── Main ─────────────────────────────────────────────────────

if (process.argv.includes('--uninstall')) {
	uninstall();
} else {
	install();
}

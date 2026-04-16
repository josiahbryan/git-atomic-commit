# git-atomic-commit

Atomic git stage+commit with repo-wide locking for multi-agent safety.

## The Problem

When multiple AI agents (or developers) work in the same git repo simultaneously, `git add` and `git commit` are two separate operations on a shared staging area. This creates a race condition:

1. Agent A stages `file-a.ts`
2. Agent B stages `file-b.ts`
3. Agent A commits — accidentally including `file-b.ts`

This tool wraps staging and committing into a single locked operation, like a database transaction for your git index.

## Install

### One-liner (recommended)

No dependencies required — downloads a pre-compiled native binary:

```bash
curl -fsSL https://raw.githubusercontent.com/josiahbryan/git-atomic-commit/main/scripts/install-remote.sh | bash
```

Supports macOS (Apple Silicon + Intel) and Linux (x64 + ARM64).

### From source

Requires [bun](https://bun.sh):

```bash
git clone https://github.com/josiahbryan/git-atomic-commit.git
cd git-atomic-commit
bun install && bun run setup
```

This compiles a native binary and installs it to `/usr/local/bin/`.

## Usage

### Atomic commit (one-shot)

Stage files and commit in a single locked operation:

```bash
git-atomic-commit commit \
  -f src/foo.ts src/bar.ts \
  -m "feat(module): add feature"
```

If the commit fails (e.g., pre-commit hook rejection), the tool automatically:
1. Rolls back staging (unstages only the files it added)
2. Releases the lock
3. Exits with code 1

No manual cleanup needed. Fix the issue and re-run.

### Options

```
-f, --files <files...>   Files to stage and commit (required)
-m, --message <message>  Commit message (required)
-o, --owner <owner>      Lock owner identifier (default: pid-<PID>)
-t, --ttl <seconds>      Lock TTL in seconds (default: 60)
--no-verify              Skip pre-commit hooks
```

### Multi-turn transactions

For workflows that span multiple steps (e.g., an AI agent iterating on lint fixes):

```bash
# Acquire the lock with a stable owner name
git-atomic-commit lock -o "my-session" -t 600

# ... do work across multiple turns ...

# Extend the lock if needed
git-atomic-commit renew -o "my-session"

# Commit (uses existing lock, then releases it)
git-atomic-commit commit -o "my-session" \
  -f src/foo.ts -m "feat: add foo"

# Or abort without committing
git-atomic-commit unlock -o "my-session"
```

### Inspecting locks

```bash
# Check if a lock is held
git-atomic-commit status

# Output:
# [git-atomic-commit] Owner:  my-session
# [git-atomic-commit] PID:    12345 (alive)
# [git-atomic-commit] Age:    42s / 600s TTL
# [git-atomic-commit] Status: ACTIVE
```

### Emergency lock removal

If a lock is stuck (crashed agent, stale TTL):

```bash
git-atomic-commit break-lock
```

Stale locks are also automatically detected and stolen — a lock is considered stale if:
- Its TTL has expired, OR
- The owning PID is dead and the lock is older than 10 seconds

## How It Works

### Lock mechanism

The lock is a directory at `.git/atomic-commit.lock/` containing a `lock.json` metadata file. Directory creation via `mkdir` is atomic on POSIX — exactly one process wins the race.

```json
{
  "owner": "my-session",
  "pid": 12345,
  "acquiredAt": 1713283200000,
  "ttlSeconds": 60
}
```

### Rollback on failure

When a commit fails, the tool needs to unstage files it added without disturbing files that were already staged by someone else. It does this by:

1. Snapshotting the staged file list **before** touching the index
2. Recording which files are tracked vs. new (untracked)
3. On failure: unstaging only its own files using the correct git command:
   - Tracked files: `git reset HEAD -- <file>`
   - New files: `git rm --cached <file>`

### Per-repo isolation

The lock lives inside `.git/`, so different repos have independent locks. The lock directory is never committed (it's inside the git metadata directory).

## Commands

| Command | Description |
|---------|-------------|
| `commit` | Atomically stage files and commit |
| `lock` | Acquire lock for multi-turn transaction |
| `unlock` | Release a lock you hold |
| `renew` | Extend lock TTL |
| `status` | Show current lock state |
| `break-lock` | Force-remove a stuck lock |

## Requirements

- git >= 2.23
- Pre-compiled binaries: no other dependencies
- Building from source: [bun](https://bun.sh) >= 1.0

## Uninstall

```bash
# If installed via one-liner or from source:
bash scripts/uninstall.sh

# Or manually:
rm /usr/local/bin/git-atomic-commit
```

## License

MIT

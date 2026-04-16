# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

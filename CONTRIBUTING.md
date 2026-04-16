# Contributing

Thanks for your interest in contributing to git-atomic-commit!

## Getting Started

1. Fork and clone the repo
2. Install dependencies: `bun install`
3. Install the CLI locally: `bun run setup`
4. Make your changes in `src/cli.ts`
5. Test manually in a git repo

## Development

The project is intentionally simple — one main file (`src/cli.ts`) and one installer (`src/install.ts`). Both are TypeScript, run directly by bun with no build step.

To test changes without reinstalling:

```bash
bun src/cli.ts status
bun src/cli.ts commit -f file.txt -m "test" --no-verify
```

## Submitting Changes

1. Create a branch: `git checkout -b my-feature`
2. Make your changes
3. Update CHANGELOG.md
4. Open a pull request

## Code Style

- Keep it simple. This is a small, focused tool.
- No build step. Bun runs TypeScript directly.
- Minimal dependencies (currently just `commander`).

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Your OS and bun version (`bun --version`)

# Contributing to Ziggurat

Contributions are welcome! This guide covers the development workflow and conventions used in this project.

## Getting Started

```bash
git clone https://github.com/camcima/ziggurat.git
cd ziggurat
pnpm install
```

Running `pnpm install` automatically sets up [Lefthook](https://github.com/evilmartians/lefthook) git hooks, which enforce code quality and commit message standards.

### Node versions

Two different floors apply, and they are not the same number:

| Where                             | Node    | Why                                                                        |
| --------------------------------- | ------- | -------------------------------------------------------------------------- |
| **Developing this repo**          | ≥ 22.13 | pnpm 11 loads the `node:sqlite` builtin, which does not exist before 22.13 |
| **Consuming a published package** | ≥ 20    | What the shipped bundles actually require at runtime                       |

The root `package.json` is `private: true`, so its `engines.node` (`>=22.13`) constrains contributors only. The six published packages declare `>=20` because that is what their built output needs — `scripts/smoke-test.mjs` loads every bundle and exercises the core API on Node 20 in CI, so the claim stays honest.

Don't "fix" the mismatch by raising the packages to match the root. They describe different audiences.

## Git Hooks

This project uses Lefthook to run the following hooks automatically:

### Pre-commit

- **Lint** — runs ESLint on staged `.js`, `.ts`, `.jsx`, `.tsx` files
- **Format** — runs Prettier check on staged files

### Commit Message

- **Commitlint** — validates that commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification

## Commit Message Format

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) format, enforced by [`@commitlint/config-conventional`](https://github.com/conventional-changelog/commitlint/tree/master/%40commitlint/config-conventional):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Description                                               |
| ---------- | --------------------------------------------------------- |
| `feat`     | A new feature                                             |
| `fix`      | A bug fix                                                 |
| `docs`     | Documentation only changes                                |
| `style`    | Changes that do not affect the meaning of the code        |
| `refactor` | A code change that neither fixes a bug nor adds a feature |
| `perf`     | A code change that improves performance                   |
| `test`     | Adding missing tests or correcting existing tests         |
| `build`    | Changes that affect the build system or dependencies      |
| `ci`       | Changes to CI configuration files and scripts             |
| `chore`    | Other changes that don't modify src or test files         |
| `revert`   | Reverts a previous commit                                 |

### Examples

```
feat(redis): add connection pooling support
fix(core): prevent stampede when TTL is zero
docs: update getting started guide
test(memcache): add integration tests for mget
chore: bump typescript to 5.6
```

### Breaking Changes

Indicate breaking changes with a `!` after the type/scope, or with a `BREAKING CHANGE:` footer:

```
feat(core)!: change CacheManager constructor signature

BREAKING CHANGE: The `layers` option is now required.
```

## Development Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes and write tests
4. Ensure all checks pass:
   ```bash
   pnpm build
   pnpm test
   pnpm lint
   pnpm format:check
   ```
5. Commit using a conventional commit message
6. Submit a pull request

## Releasing

`pnpm release` runs [release-it](https://github.com/release-it/release-it), which derives the version bump and the `CHANGELOG.md` entry from the conventional commits since the last tag. Preview it without changing anything:

```bash
npx release-it --dry-run
```

> **One-time note for the next release:** commit [`4c0a23c`](https://github.com/camcima/ziggurat/commit/4c0a23c) carries the footer `BREAKING CHANGE: minimum supported Node.js is now 22.13 (was 20).`, so the generated changelog will list it. That change only raised the **private root** `engines.node` and the CI runner — the published packages never dropped Node 20, and CI verifies they still work on it. Delete that one bullet from the generated `CHANGELOG.md` before completing the release, so it doesn't announce a consumer-facing break that never happened. This note can go away once that release has shipped.

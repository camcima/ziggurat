# Contributing to Ziggurat

Contributions are welcome! This guide covers the development workflow and conventions used in this project.

## Getting Started

```bash
git clone https://github.com/camcima/ziggurat.git
cd ziggurat
pnpm install
```

Running `pnpm install` automatically sets up [Lefthook](https://github.com/evilmartians/lefthook) git hooks, which enforce code quality and commit message standards.

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

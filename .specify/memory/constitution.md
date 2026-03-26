<!--
  Sync Impact Report
  ===================
  Version change: 1.0.0 → 1.0.1

  Added principles:
    - I. Library-First Architecture
    - II. Test-Driven Development (NON-NEGOTIABLE)
    - III. Adapter Contract Compliance
    - IV. Type Safety
    - V. Code Quality (ESLint + Prettier)
    - VI. Simplicity

  Added sections:
    - Quality Standards
    - Continuous Integration
    - Release Management
    - Development Workflow
    - Governance

  Removed sections: N/A (initial version)

  Templates requiring updates:
    - .specify/templates/plan-template.md — ✅ compatible
      (Constitution Check section is a dynamic placeholder; no update needed)
    - .specify/templates/spec-template.md — ✅ compatible
      (User stories already require independent testability)
    - .specify/templates/tasks-template.md — ✅ compatible
      (Already supports test-first ordering: "Tests MUST be written
      and FAIL before implementation")
    - .specify/templates/commands/*.md — ✅ no files present

  Follow-up TODOs:
    - Keep this report current on future amendments
-->

# Ziggurat Constitution

## Core Principles

### I. Library-First Architecture

Every feature MUST start as a standalone, independently publishable
package within the monorepo. Packages MUST be self-contained with
their own entry points, type exports, and documentation. The core
package (`@ziggurat/core`) MUST have zero framework-specific
dependencies. Adapter and integration packages MUST depend only on
the core package's public API — never on its internals.

### II. Test-Driven Development (NON-NEGOTIABLE)

All production code MUST follow the Red-Green-Refactor cycle:

1. **Red**: Write a failing test that defines the desired behavior.
2. **Green**: Write the minimum code to make the test pass.
3. **Refactor**: Clean up while keeping tests green.

Tests MUST be written and approved before implementation begins.
No production code may be merged without corresponding tests that
were written first. This applies to unit tests, contract tests,
and integration tests alike.

### III. Adapter Contract Compliance

Every `CacheAdapter` implementation MUST pass a shared contract
test suite that exercises all interface methods (`get`, `set`,
`delete`, `clear`) with consistent semantics. New adapters MUST
NOT be considered complete until the full contract suite passes.
Contract tests are the authoritative definition of adapter
behavior — if the contract tests pass, the adapter is correct.

### IV. Type Safety

All public APIs MUST use TypeScript generics to preserve type
information through cache operations. `any` types MUST NOT appear
in public-facing signatures. Internal use of `any` MUST be
justified and isolated behind typed boundaries. Strict TypeScript
compiler options (`strict: true`) MUST be enabled across all
packages.

### V. Code Quality

All packages MUST enforce consistent code style via ESLint and
Prettier. ESLint MUST be configured with strict rules appropriate
for TypeScript (e.g., `@typescript-eslint` recommended rules).
Prettier MUST be the sole authority on formatting — ESLint
formatting rules MUST be disabled to avoid conflicts. All code
MUST pass linting and formatting checks before merge. Shared
ESLint and Prettier configurations MUST be defined at the
monorepo root and inherited by all packages.

### VI. Simplicity

Start with the simplest solution that satisfies the requirement.
Abstractions MUST be justified by at least two concrete use cases
— never introduced speculatively. Prefer explicit code over clever
indirection. Configuration options MUST have sensible defaults so
the zero-config path works correctly. Follow YAGNI: do not build
for hypothetical future requirements.

## Quality Standards

- Every package MUST maintain test coverage that exercises all
  public API methods and documented edge cases.
- Contract tests MUST exist for every `CacheAdapter` implementation
  and MUST be run as part of the CI pipeline.
- Concurrency tests MUST verify stampede protection guarantees
  (e.g., N concurrent callers, exactly 1 factory invocation).
- Integration tests requiring external services (Redis, databases)
  MUST be isolated and skippable in environments without those
  services.

## Continuous Integration

GitHub Actions MUST be used for all CI/CD pipelines. The following
pipelines MUST exist:

- **Validation pipeline**: Runs on every push and pull request.
  MUST execute ESLint, Prettier format check, and TypeScript
  compilation across all packages. The pipeline MUST fail if any
  linting, formatting, or type errors are detected.
- **Test pipeline**: Runs on every push and pull request. MUST
  execute the full test suite (unit, contract, and integration
  tests where applicable). Integration tests requiring external
  services SHOULD run in CI with service containers (e.g., Redis
  via Docker).

No code MUST be merged to the main branch unless both pipelines
pass.

## Release Management

All package releases MUST be managed via `release-it`. Each
package MUST be independently releasable with its own version.
Releases MUST follow semantic versioning. The release process
MUST publish to npm and create a corresponding GitHub release
with a changelog. Release configuration MUST be defined at the
monorepo root with per-package overrides where needed.

## Development Workflow

- **TDD cycle**: For every task, write tests first, verify they
  fail, then implement. Commits SHOULD reflect this progression
  (test commit, then implementation commit).
- **Code review**: All changes MUST be reviewed against this
  constitution's principles before merge.
- **Commit discipline**: Commit after each task or logical group.
  Each commit SHOULD leave the test suite green.
- **Package boundaries**: Changes to a package's public API MUST
  be accompanied by updated contract tests and type exports.
- **Documentation last**: Creating or updating documentation MUST
  be the final step of the development workflow for each completed
  task or feature.

## Governance

This constitution is the authoritative reference for development
practices on Ziggurat. All code reviews and planning artifacts
MUST verify compliance with these principles.

Amendments require:
1. A documented rationale for the change.
2. Review and approval by the project maintainer.
3. A migration plan if the change affects existing code or
   workflows.
4. Version bump following semantic versioning (see below).

Versioning policy:
- **MAJOR**: Principle removal or backward-incompatible redefinition.
- **MINOR**: New principle added or existing principle materially
  expanded.
- **PATCH**: Clarifications, wording fixes, non-semantic
  refinements.

**Version**: 1.0.1 | **Ratified**: 2026-03-25 | **Last Amended**: 2026-03-25

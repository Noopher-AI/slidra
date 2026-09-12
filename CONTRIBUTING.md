# Contributing to Slidra

Thanks for your interest in contributing to Slidra.

## Development environment

- **Rust**: the pinned toolchain is `1.85.0` (see `rust-toolchain.toml`). Run `rustup show` from the
  repo root and rustup will install the pinned version automatically.
- **Node.js**: a recent LTS release works; this repo uses `npm` (via npm workspaces), not `pnpm` or
  `yarn`.

## Building and testing

Run these from the repository root:

```bash
cargo build
cargo test
npm run build
```

`npm test` already runs `npm run build` as a prerequisite, so you don't need to build manually before
running the unit tests:

```bash
npm test
```

For manual acceptance of a change, always start with `npm run verify:setup` rather than assembling the
steps yourself — see `.dev_docs/verify-setup.md` for details.

## Branching and commits

- Branch off `main`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `spec:`, `refactor:`, `chore:`, etc.
- Every commit must be signed off (see DCO below).

## Developer Certificate of Origin (DCO)

Slidra does not require a CLA. Instead, every commit must include a `Signed-off-by` line certifying you
wrote it or otherwise have the right to submit it under the project's license. Add this automatically
with:

```bash
git commit -s
```

We use Apache-2.0 + DCO because it is the lowest-friction, most community-trusted combination. If
Noopher AI later wants to incorporate community-contributed web app code into a closed-source app,
Apache-2.0 already permits that — no CLA is needed.

## Pull request process

1. Open an issue to discuss the change before starting significant work.
2. Fork the repository and create a branch for your change.
3. Open a pull request against `main`.
4. Make sure CI is green.
5. Address review feedback.

Every PR should also include:

- Tests for the behavior being added or fixed.
- A `CHANGELOG.md` entry under `[Unreleased]`.
- A DCO sign-off on every commit.

## Changing the `.slidra` format

Any change to the `.slidra` file format goes through an RFC, not a direct PR. Open a markdown file
under `spec/rfcs/`, numbered sequentially (e.g. `0001-my-proposal.md`), describing the motivation and
the proposed change, and open a PR for discussion before implementing it.

## Scope: open source vs. commercial

Slidra (this repo) is and will remain Apache-2.0. Noopher AI builds Noopa, a commercial editor on top
of Slidra. Anything that runs locally belongs here; hosted services and native apps are Noopa.

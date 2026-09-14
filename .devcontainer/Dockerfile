# Playwright 1.62's WebKit binary is built against Noble's ICU 74 / AVIF 16 /
# JPEG 8 ABI.  The matching official image supplies all three browser engines
# and their system libraries. It ships Node 24; CI (.github/workflows/e2e.yml)
# pins Node 22, so Node 22 is installed below and asserted at build time
# (asserting v22 against the image's own Node failed the build).
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ARG UID=1000

# The base image ships a pre-existing "node" user at uid/gid 1000; drop it so
# the requested UID is free, then create the user the sandbox expects files
# to be owned by.
RUN if getent passwd node >/dev/null; then userdel -r node; fi \
    && if getent group node >/dev/null; then groupdel node; fi \
    && useradd -m -u ${UID} -s /bin/bash dev

# The GitHub CLI is used to drive PR/workflow automation (create/inspect
# PRs, trigger and watch e2e.yml runs) from inside the sandbox; it isn't
# part of the base Node image and isn't an npm dependency, so it belongs
# here as a system package.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Playwright's browser builds need a set of shared libraries that aren't in
# the base Node image. `playwright install-deps` is the project's own tool
# for resolving that list per-distro; running it here (as root, at build
# time) installs only the apt packages, not the npm package or browser
# binaries themselves — those are project dependencies and belong in
# postCreateCommand. CI (.github/workflows/e2e.yml) installs all three
# engines via `playwright install --with-deps`; match that here so the
# devcontainer can run the same e2e suite CI does.
#
# The builder previously cached this layer from a run where
# `install-deps` had silently failed to pull in libglib2.0-0, and every
# later build reused that broken layer since the instruction text never
# changed. The `: '...'` no-op below changes the instruction text once to
# bust that stale cache; the explicit packages and trailing dpkg checks make
# missing Firefox/X11 dependencies a hard build error instead of another
# undetected bad layer. This Bookworm base names the GTK package `libgtk-3-0`
# (the `libgtk-3-0t64` name is from newer Ubuntu/Debian releases), and ships
# ICU 72, AVIF 15, and turbo-JPEG 62 as its WebKit runtime providers.
# Match CI's Node 22: the base image installs Node 24 from NodeSource's node_24.x
# list, so point that list at node_22.x (setup_22.x leaves an existing list
# alone), reinstall from it, and make the version a hard build-time check.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource-22.gpg \
    && rm -f /etc/apt/sources.list.d/nodesource.list \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource-22.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get remove -y nodejs \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version | grep -q '^v22\.'

RUN : 'cache-bust: verify Noble Playwright browser system deps' \
    && npx --yes playwright@1.62.1 install-deps chromium firefox webkit \
    && apt-get install -y libxcb-shm0 libgtk-3-0t64 libicu74 libavif16 libjpeg8 \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l | grep -q '^ii  libglib2.0-0t64' \
    && dpkg -l | grep -q '^ii  libxcb-shm0' \
    && dpkg -l | grep -q '^ii  libgtk-3-0t64' \
    && dpkg -l | grep -q '^ii  libicu74' \
    && dpkg -l | grep -q '^ii  libavif16' \
    && dpkg -l | grep -q '^ii  libjpeg8'

# `rustc` links every binary (including pure-Rust crates with proc-macro
# build scripts, e.g. `quote`/`proc-macro2`) via a C linker — it does not
# ship its own. The Playwright/Node base image has no C toolchain at all
# (`cargo build --release` failed with `linker `cc` not
# found` the moment dependencies started compiling). `build-essential` is
# the standard Debian/Ubuntu meta-package for this (gcc + libc dev headers +
# make); nothing here is Rust-specific, it is a system-level linker, so it
# belongs in the image rather than a Cargo dependency.
RUN apt-get update \
    && apt-get install -y build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l | grep -q '^ii  gcc '

# The agent sandbox (packages/server/src/sandbox/) shells out to `srt`,
# which on Linux enforces the write sandbox via bubblewrap and needs socat
# to mediate the loopback network path; both are unconditional dependencies
# of its Linux code path (it throws at startup if either is missing), so
# they belong in the image rather than an npm dependency.
RUN apt-get update \
    && apt-get install -y bubblewrap socat \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l | grep -q '^ii  bubblewrap' \
    && dpkg -l | grep -q '^ii  socat'

USER dev
ENV HOME=/home/dev

# Rust toolchain for the slidra CLI skeleton.
# `--default-toolchain none` deliberately leaves rustup without a pinned
# version here: `rust-toolchain.toml` (repo root) is the single source of
# truth for the channel, and it is only visible to `rustup` once the repo is
# mounted in postCreateCommand — not at image-build time, when the build
# context is just `.devcontainer/`. Installing the toolchain itself (`rustup
# show`, which auto-installs the pinned channel on first use) therefore also
# happens in postCreateCommand, not here.
ENV CARGO_HOME=/home/dev/.cargo RUSTUP_HOME=/home/dev/.rustup
ENV PATH=/home/dev/.cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal

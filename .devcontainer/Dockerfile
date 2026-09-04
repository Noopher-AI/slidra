FROM node:22-bookworm

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
# NOOP-31: the builder previously cached this layer from a run where
# `install-deps` had silently failed to pull in libglib2.0-0, and every
# later build reused that broken layer since the instruction text never
# changed. The `: '...'` no-op below changes the instruction text once to
# bust that stale cache; the explicit packages and trailing dpkg checks make
# missing Firefox/X11 dependencies a hard build error instead of another
# undetected bad layer. This Bookworm base names the GTK package `libgtk-3-0`
# (the `libgtk-3-0t64` name is from newer Ubuntu/Debian releases), and ships
# ICU 72, AVIF 15, and turbo-JPEG 62 as its WebKit runtime providers.
RUN : 'cache-bust NOOP-52: verify all Playwright browser system deps' \
    && npx --yes playwright@1.62.1 install-deps chromium firefox webkit \
    && apt-get install -y libxcb-shm0 libgtk-3-0 libicu72 libavif15 libjpeg62-turbo \
    && rm -rf /var/lib/apt/lists/* \
    && dpkg -l | grep -q '^ii  libglib2.0-0' \
    && dpkg -l | grep -q '^ii  libxcb-shm0' \
    && dpkg -l | grep -q '^ii  libgtk-3-0' \
    && dpkg -l | grep -q '^ii  libicu72' \
    && dpkg -l | grep -q '^ii  libavif15' \
    && dpkg -l | grep -q '^ii  libjpeg62-turbo'

USER dev
ENV HOME=/home/dev

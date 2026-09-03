FROM node:22-bookworm

ARG UID=1000

# The base image ships a pre-existing "node" user at uid/gid 1000; drop it so
# the requested UID is free, then create the user the sandbox expects files
# to be owned by.
RUN if getent passwd node >/dev/null; then userdel -r node; fi \
    && if getent group node >/dev/null; then groupdel node; fi \
    && useradd -m -u ${UID} -s /bin/bash dev

# Playwright's browser builds need a set of shared libraries that aren't in
# the base Node image. `playwright install-deps` is the project's own tool
# for resolving that list per-distro; running it here (as root, at build
# time) installs only the apt packages, not the npm package or browser
# binaries themselves — those are project dependencies and belong in
# postCreateCommand. CI (.github/workflows/e2e.yml) installs all three
# engines via `playwright install --with-deps`; match that here so the
# devcontainer can run the same e2e suite CI does.
RUN npx --yes playwright@1.62.1 install-deps chromium firefox webkit \
    && rm -rf /var/lib/apt/lists/*

USER dev
ENV HOME=/home/dev

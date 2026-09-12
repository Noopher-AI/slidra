#!/bin/sh
# Starts the public demo. The presentation id was resolved at image build
# time (see Dockerfile.vercel); this only binds and serves.
set -e

# 0.0.0.0, not the default loopback: inside a container a loopback bind is
# unreachable from outside it.
exec ./target/release/slidra serve "$(cat /app/presentation-id)" \
  --port "${PORT:-80}" \
  --host 0.0.0.0

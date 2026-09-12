# Public Demo Deployment

This directory contains the deployment-specific implementation for the public Slidra demo. Product source code remains outside this directory.

## Layout

- `container/`: Builds the self-hosted Slidra service, including headless Chromium for PDF export.
- `vercel/`: Authenticates demo visitors and injects the private origin credential into authenticated API requests.
- `../vercel.json`: Vercel requires this small project entrypoint at the repository root. It points to the middleware in this directory and rewrites `/api/*` to the self-hosted origin.
- `.dockerignore`: Docker requires the ignore file at the build-context root, so it also remains at the repository root.

The Kubernetes resources are maintained in the infrastructure repository under `k8s/slidra-demo/`.

## Architecture

1. A visitor opens the Vercel URL with a one-time URL parameter: `/?key=<DEMO_ACCESS_KEY>`.
2. Vercel Routing Middleware validates the key, issues an eight-hour `HttpOnly`, `Secure`, `SameSite=Strict` session cookie, and redirects to a clean URL without the key.
3. Authenticated `/api/*` requests are rewritten to the Cloudflare Tunnel origin. Middleware overwrites the private origin and client-ID headers before forwarding.
4. An nginx sidecar in Kubernetes rejects requests without the private origin token, enforces request-size and rate limits, and proxies accepted traffic to the single Slidra container.

AI agents are intentionally disabled. Do not add Claude, Codex, model-provider keys, or agent credentials to this deployment.

## Required secrets

Configure these values outside Git. Never put their values in this repository, command examples, screenshots, issues, or pull requests.

### Vercel production environment

- `DEMO_ACCESS_KEY`: Invitation key exchanged for a browser session.
- `DEMO_SESSION_SECRET`: HMAC key used to sign browser sessions.
- `SLIDRA_ORIGIN_TOKEN`: Credential attached to authenticated origin requests.

### Kubernetes

The `slidra-demo/origin-auth` Secret must contain the same origin credential under the `token` key.

## Build the container

Run from the repository root. Use the platform of the target Kubernetes node; the current GB10 node is ARM64.

```sh
docker build \
  --platform linux/arm64 \
  -f deploy/container/Dockerfile \
  -t localhost:5000/slidra-demo:<git-commit> \
  -t localhost:5000/slidra-demo:latest \
  .
```

Push through the local port-forward to the in-cluster registry, then update the immutable image tag in the infrastructure manifest.

## Deploy the Vercel frontend

The project is linked as `noopher-ai/slidra-demo`.

```sh
npx vercel@latest build --prod --yes --scope noopher-ai
npx vercel@latest deploy . --prod -y --no-wait --scope noopher-ai
```

Inspect the deployment until its status is `Ready`:

```sh
npx vercel@latest inspect https://slidra-demo.vercel.app --scope noopher-ai
```

## Security invariants

- Never commit an invitation URL containing `?key=` or any secret value.
- Keep the README demo badge disabled until an intentional public launch.
- Keep the Kubernetes Deployment at one replica and use the `Recreate` strategy. Multiple Slidra processes contend for the same presentation editing lock.
- Preserve `no-store` headers and unbuffered proxying for `/api/*` and SSE endpoints.
- Direct requests to the Cloudflare origin must return `403`; requests without a valid Vercel session must return `401`.
- Rotate all three secrets if an invitation URL or origin token is disclosed.

## Acceptance checks

- Vercel `/` without a session returns `401`.
- A valid invitation redirects to `/` and sets a protected session cookie.
- Vercel `/api/presentation` returns the four-slide `Acceptance Demo Deck` for an authenticated session.
- Direct origin access without the origin token returns `403`.
- Oversized command bodies return `413`.
- Excess requests return `429`.
- `/api/events` remains open and emits SSE heartbeat frames through both Vercel and Cloudflare.

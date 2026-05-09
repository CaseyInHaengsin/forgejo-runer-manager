# Forgejo Runner Manager

Self-hosted MVP web app for managing Forgejo Actions runner containers on an Unraid Docker host.

This app only manages Forgejo runner containers. It does not manage Forgejo itself.

## Features

- Store one Forgejo instance URL.
- Store runner registration tokens.
- Create runner container records with name, image tag, labels, volume, container name, Docker socket mount, and user mode.
- Start, stop, restart, delete, inspect status, and view logs for managed runner containers.
- Edit runner labels and container settings. When a managed container already exists, the app recreates the container while preserving the runner data volume.
- Generate equivalent Docker CLI commands for transparency.
- Basic HTTP authentication.
- SQLite config storage.
- Example templates for Elixir, Node, Ubuntu, and deploy-only runners.

## Security Warning

Mounting `/var/run/docker.sock` gives this app root-equivalent control over the Docker host. Any user who can access this app can create privileged containers, mount host paths, read secrets from other containers, and mutate services on the Unraid server.

Do not expose this app directly to the public internet. Use strong credentials, keep it on a private network or behind a trusted VPN/reverse proxy with authentication, and restrict access to administrators only.

Forgejo also warns that sharing Docker socket access with job containers removes meaningful isolation. Only enable runner Docker socket access for trusted workflows and trusted Forgejo users.

## Local Development

```sh
cd forgejo-runner-manager
pnpm install
cp .env.example .env
APP_USERNAME=admin APP_PASSWORD=dev-password pnpm dev
```

Open `http://localhost:3000` and sign in with the configured basic auth credentials.

## Unraid Deployment

### Option A: Use a GitHub Container Registry image

This repo includes a GitHub Actions workflow that builds and publishes a multi-architecture image to GitHub Container Registry on pushes to `main`:

```text
ghcr.io/<github-owner>/<repo-name>:latest
```

After the first successful workflow run, make the package public in GitHub if your Unraid server should pull it without a GitHub token:

1. Open the GitHub repository.
2. Go to Packages.
3. Open the container package.
4. Package settings.
5. Change visibility to public.

Then in Unraid, use this repository/image:

```text
ghcr.io/<github-owner>/<repo-name>:latest
```

Set the Web UI port to `3000`, persist `/app/data`, and mount `/var/run/docker.sock`.

### Option B: Build on the server

1. Copy this directory to your Unraid appdata or a persistent share.
2. Edit `docker-compose.yml`.
3. Set a strong `APP_PASSWORD`.
4. Keep this volume mount:

```yaml
- /var/run/docker.sock:/var/run/docker.sock
```

5. Start the app:

```sh
docker compose up -d --build
```

6. Open `http://<unraid-ip>:3000`.

For Unraid Community Apps, create a custom Docker container with:

- Repository/image: the image you build from this Dockerfile, or build locally with Compose.
- Web UI port: `3000`.
- Path: `/app/data` mapped to persistent appdata storage.
- Path: `/var/run/docker.sock` mapped to `/var/run/docker.sock`.
- Environment variables:
  - `APP_USERNAME`
  - `APP_PASSWORD`
  - `DATA_DIR=/app/data`
  - `DOCKER_SOCKET_PATH=/var/run/docker.sock`

## Runner Behavior

Each runner gets its own Docker volume mounted at `/data`. The startup script writes `/data/config.yml`, registers the runner only when `/data/.runner` does not exist, then starts:

```sh
forgejo-runner daemon --config /data/config.yml
```

Because the volume is preserved by default, multiple runners can coexist and runner identity survives container recreation. Deleting a runner in the UI asks whether to also remove the Docker volume.

Label changes update `/data/config.yml` and recreate the runner container while preserving the volume. If Forgejo requires re-registration for a specific label change, delete the runner volume and create a fresh runner with the same settings.

## Templates

Elixir + Node + Ubuntu:

```text
elixir:docker://hexpm/elixir:1.18.4-erlang-28-debian-trixie-slim,node:docker://node:22,ubuntu:docker://ubuntu:24.04
```

Node:

```text
node:docker://node:22,ubuntu:docker://ubuntu:24.04
```

Ubuntu:

```text
ubuntu:docker://ubuntu:24.04,ubuntu-latest:docker://ubuntu:24.04
```

Deploy only:

```text
deploy:host
```

## References

- Forgejo runner installation and registration: https://forgejo.org/docs/next/admin/runner-installation
- Forgejo runner labels and configuration: https://forgejo.org/docs/next/admin/actions/configuration/
- Forgejo Docker socket access warning: https://forgejo.org/docs/next/admin/actions/docker-access/

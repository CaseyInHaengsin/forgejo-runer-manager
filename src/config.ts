import path from "node:path";
import "dotenv/config";

export const PORT = Number(process.env.PORT ?? 3000);
export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = path.join(DATA_DIR, "forgejo-runner-manager.sqlite");
export const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock";
export const DEFAULT_RUNNER_IMAGE = "data.forgejo.org/forgejo/runner:12";
export const MANAGED_BY_LABEL = "com.forgejo-runner-manager.managed";
export const MANAGED_BY_VALUE = "true";
export const RUNNER_ID_LABEL = "com.forgejo-runner-manager.runner-id";

export function requireAuthConfig() {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;

  if (!username || !password || password === "change-me") {
    throw new Error("Set APP_USERNAME and APP_PASSWORD before starting the app.");
  }

  return { username, password };
}

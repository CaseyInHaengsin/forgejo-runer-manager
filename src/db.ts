import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle, type AsyncRemoteCallback } from "drizzle-orm/sqlite-proxy";
import { nanoid } from "nanoid";
import { DATA_DIR, DB_PATH, DEFAULT_RUNNER_IMAGE } from "./config.js";
import type { AppConfig, RegistrationToken, Runner } from "./types.js";
import { appConfig, registrationTokens, runners } from "./schema.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const sqlite = new DatabaseSync(DB_PATH);
const execute: AsyncRemoteCallback = async (query, params, method) => {
  const statement = sqlite.prepare(query);
  statement.setReturnArrays(true);

  if (method === "run") {
    statement.run(...params);
    return { rows: [] };
  }

  if (method === "get") {
    return { rows: statement.get(...params) as any };
  }

  return { rows: statement.all(...params) as unknown as any[] };
};

export const db = drizzle(execute, { schema: { appConfig, registrationTokens, runners } });
sqlite.exec("pragma journal_mode = WAL");
sqlite.exec("pragma foreign_keys = ON");

sqlite.exec(`
  create table if not exists app_config (
    id integer primary key check (id = 1),
    forgejo_url text not null default ''
  );

  insert or ignore into app_config (id, forgejo_url) values (1, '');

  create table if not exists registration_tokens (
    id text primary key,
    name text not null,
    token text not null,
    created_at text not null default current_timestamp
  );

  create table if not exists runners (
    id text primary key,
    name text not null,
    token_id text not null references registration_tokens(id) on delete restrict,
    image text not null,
    labels text not null,
    volume_name text not null unique,
    container_name text not null unique,
    mount_docker_socket integer not null default 0,
    run_as_root integer not null default 0,
    created_at text not null default current_timestamp,
    updated_at text not null default current_timestamp
  );
`);

export const repo = {
  async getConfig(): Promise<AppConfig> {
    return (await db.select({ forgejoUrl: appConfig.forgejoUrl }).from(appConfig).where(eq(appConfig.id, 1)).get())!;
  },

  async updateConfig(forgejoUrl: string): Promise<AppConfig> {
    await db.update(appConfig).set({ forgejoUrl }).where(eq(appConfig.id, 1)).run();
    return await this.getConfig();
  },

  async listTokens(): Promise<RegistrationToken[]> {
    return await db.select().from(registrationTokens).orderBy(desc(registrationTokens.createdAt)).all();
  },

  async getToken(id: string): Promise<RegistrationToken | undefined> {
    return await db.select().from(registrationTokens).where(eq(registrationTokens.id, id)).get();
  },

  async createToken(name: string, token: string): Promise<RegistrationToken> {
    const id = nanoid();
    await db.insert(registrationTokens).values({ id, name, token }).run();
    return (await this.getToken(id))!;
  },

  async deleteToken(id: string) {
    await db.delete(registrationTokens).where(eq(registrationTokens.id, id)).run();
  },

  async listRunners(): Promise<Runner[]> {
    return await db.select().from(runners).orderBy(desc(runners.createdAt)).all();
  },

  async getRunner(id: string): Promise<Runner | undefined> {
    return await db.select().from(runners).where(eq(runners.id, id)).get();
  },

  async createRunner(input: Omit<Runner, "id" | "createdAt" | "updatedAt">): Promise<Runner> {
    const id = nanoid();
    await db.insert(runners).values({
      id,
      name: input.name,
      tokenId: input.tokenId,
      image: input.image || DEFAULT_RUNNER_IMAGE,
      labels: input.labels,
      volumeName: input.volumeName,
      containerName: input.containerName,
      mountDockerSocket: input.mountDockerSocket,
      runAsRoot: input.runAsRoot
    }).run();
    return (await this.getRunner(id))!;
  },

  async updateRunner(id: string, patch: Partial<Omit<Runner, "id" | "createdAt" | "updatedAt">>): Promise<Runner | undefined> {
    const current = await this.getRunner(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await db.update(runners)
      .set({
        name: next.name,
        tokenId: next.tokenId,
        image: next.image,
        labels: next.labels,
        volumeName: next.volumeName,
        containerName: next.containerName,
        mountDockerSocket: next.mountDockerSocket,
        runAsRoot: next.runAsRoot,
        updatedAt: sql`CURRENT_TIMESTAMP`
      })
      .where(eq(runners.id, id))
      .run();
    return await this.getRunner(id);
  },

  async deleteRunner(id: string) {
    await db.delete(runners).where(eq(runners.id, id)).run();
  }
};

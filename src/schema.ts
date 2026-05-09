import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appConfig = sqliteTable("app_config", {
  id: integer("id").primaryKey(),
  forgejoUrl: text("forgejo_url").notNull().default("")
});

export const registrationTokens = sqliteTable("registration_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  token: text("token").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const runners = sqliteTable("runners", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenId: text("token_id")
    .notNull()
    .references(() => registrationTokens.id, { onDelete: "restrict" }),
  image: text("image").notNull(),
  labels: text("labels").notNull(),
  volumeName: text("volume_name").notNull().unique(),
  containerName: text("container_name").notNull().unique(),
  mountDockerSocket: integer("mount_docker_socket", { mode: "boolean" }).notNull().default(false),
  runAsRoot: integer("run_as_root", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`)
});

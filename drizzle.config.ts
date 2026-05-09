import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATA_DIR ? `${process.env.DATA_DIR}/forgejo-runner-manager.sqlite` : "./data/forgejo-runner-manager.sqlite"
  }
});

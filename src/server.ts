import express from "express";
import path from "node:path";
import { ZodError } from "zod";
import { PORT } from "./config.js";
import { basicAuth } from "./auth.js";
import { api } from "./routes.js";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(basicAuth);
app.use("/api", api);
app.use(express.static(path.join(process.cwd(), "public")));

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    return res.status(400).json({ error: "Validation failed", details: error.flatten() });
  }
  console.error(error);
  return res.status(500).json({ error: error.message ?? "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`Forgejo Runner Manager listening on http://0.0.0.0:${PORT}`);
});

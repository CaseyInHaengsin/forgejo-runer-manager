import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { DEFAULT_RUNNER_IMAGE } from "./config.js";
import { repo } from "./db.js";
import {
  dockerCliCommand,
  listRunnerStatuses,
  recreateRunnerContainer,
  removeRunnerContainer,
  restartRunner,
  runnerLogs,
  runnerStatus,
  startRunner,
  stopRunner
} from "./docker.js";

export const api = Router();

const configSchema = z.object({
  forgejoUrl: z.string().url()
});

const tokenSchema = z.object({
  name: z.string().min(1),
  token: z.string().min(1)
});

const runnerSchema = z.object({
  name: z.string().min(1),
  tokenId: z.string().min(1),
  image: z.string().min(1).default(DEFAULT_RUNNER_IMAGE),
  labels: z.string().min(1),
  volumeName: z.string().min(1),
  containerName: z.string().min(1),
  mountDockerSocket: z.boolean().default(false),
  runAsRoot: z.boolean().default(false)
});

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res, next)).catch(next);
}

api.get("/config", asyncRoute(async (_req, res) => {
  res.json(await repo.getConfig());
}));

api.put("/config", asyncRoute(async (req, res) => {
  const input = configSchema.parse(req.body);
  res.json(await repo.updateConfig(input.forgejoUrl));
}));

api.get("/tokens", asyncRoute(async (_req, res) => {
  const tokens = (await repo.listTokens()).map((token) => ({
    ...token,
    token: `${token.token.slice(0, 6)}...${token.token.slice(-4)}`
  }));
  res.json(tokens);
}));

api.post("/tokens", asyncRoute(async (req, res) => {
  const input = tokenSchema.parse(req.body);
  res.status(201).json(await repo.createToken(input.name, input.token));
}));

api.delete("/tokens/:id", asyncRoute(async (req, res) => {
  await repo.deleteToken(req.params.id);
  res.status(204).end();
}));

api.get("/runners", asyncRoute(async (_req, res) => {
  res.json(await listRunnerStatuses(await repo.listRunners()));
}));

api.post("/runners", asyncRoute(async (req, res) => {
  const input = runnerSchema.parse(req.body);
  const runner = await repo.createRunner(input);
  res.status(201).json({ ...(await runnerStatus(runner)), command: await dockerCliCommand(runner) });
}));

api.get("/runners/:id", asyncRoute(async (req, res) => {
  const runner = await repo.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: "Runner not found" });
  res.json({ ...(await runnerStatus(runner)), command: await dockerCliCommand(runner) });
}));

api.put("/runners/:id", asyncRoute(async (req, res) => {
  const current = await repo.getRunner(req.params.id);
  if (!current) return res.status(404).json({ error: "Runner not found" });

  const input = runnerSchema.partial().parse(req.body);
  const next = await repo.updateRunner(req.params.id, input);
  if (!next) return res.status(404).json({ error: "Runner not found" });

  const needsRecreate =
    input.labels !== undefined ||
    input.image !== undefined ||
    input.volumeName !== undefined ||
    input.containerName !== undefined ||
    input.mountDockerSocket !== undefined ||
    input.runAsRoot !== undefined ||
    input.name !== undefined;

  if (needsRecreate) {
    await recreateRunnerContainer(next);
  }

  res.json({ ...(await runnerStatus(next)), command: await dockerCliCommand(next) });
}));

api.delete("/runners/:id", asyncRoute(async (req, res) => {
  const runner = await repo.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: "Runner not found" });
  const removeVolume = req.query.removeVolume === "true";
  await removeRunnerContainer(runner, removeVolume);
  await repo.deleteRunner(req.params.id);
  res.status(204).end();
}));

api.post("/runners/:id/start", asyncRoute(async (req, res) => {
  const runner = await repo.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: "Runner not found" });
  await startRunner(runner);
  res.json(await runnerStatus(runner));
}));

api.post("/runners/:id/stop", asyncRoute(async (req, res) => {
  const runner = await repo.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: "Runner not found" });
  await stopRunner(runner);
  res.json(await runnerStatus(runner));
}));

api.post("/runners/:id/restart", asyncRoute(async (req, res) => {
  const runner = await repo.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: "Runner not found" });
  await restartRunner(runner);
  res.json(await runnerStatus(runner));
}));

api.get("/runners/:id/logs", asyncRoute(async (req, res) => {
  const runner = await repo.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: "Runner not found" });
  res.type("text/plain").send(await runnerLogs(runner, Number(req.query.tail ?? 300)));
}));

api.get("/runners/:id/command", asyncRoute(async (req, res) => {
  const runner = await repo.getRunner(req.params.id);
  if (!runner) return res.status(404).json({ error: "Runner not found" });
  res.type("text/plain").send(await dockerCliCommand(runner));
}));

api.get("/templates", (_req, res) => {
  res.json([
    {
      name: "Elixir + Node + Ubuntu",
      labels: "elixir:docker://hexpm/elixir:1.18.4-erlang-28-debian-trixie-slim,node:docker://node:22,ubuntu:docker://ubuntu:24.04",
      mountDockerSocket: true,
      runAsRoot: true
    },
    {
      name: "Node",
      labels: "node:docker://node:22,ubuntu:docker://ubuntu:24.04",
      mountDockerSocket: false,
      runAsRoot: false
    },
    {
      name: "Ubuntu",
      labels: "ubuntu:docker://ubuntu:24.04,ubuntu-latest:docker://ubuntu:24.04",
      mountDockerSocket: false,
      runAsRoot: false
    },
    {
      name: "Deploy only",
      labels: "deploy:host",
      mountDockerSocket: false,
      runAsRoot: false
    }
  ]);
});

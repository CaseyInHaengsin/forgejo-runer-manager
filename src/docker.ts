import Docker from "dockerode";
import {
  DEFAULT_RUNNER_IMAGE,
  DOCKER_SOCKET_PATH,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  RUNNER_ID_LABEL
} from "./config.js";
import { repo } from "./db.js";
import type Dockerode from "dockerode";
import type { DiscoveredRunner, Runner, RunnerStatus, RunnerWithStatus } from "./types.js";

const docker = new Docker({ socketPath: DOCKER_SOCKET_PATH });

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function labelsArray(labels: string) {
  return labels
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function configYaml(labels: string) {
  const yamlLabels = labelsArray(labels).map((label) => `    - ${JSON.stringify(label)}`).join("\n");
  return `log:\n  level: info\nrunner:\n  labels:\n${yamlLabels || "    []"}\ncontainer:\n  docker_host: automount\n`;
}

function startupScript(runner: Runner, token: string, forgejoUrl: string) {
  const config = configYaml(runner.labels);
  return [
    "set -eu",
    `cat > /data/config.yml <<'EOF'\n${config}EOF`,
    "cd /data",
    'if [ ! -f /data/.runner ]; then',
    [
      "forgejo-runner register",
      "--no-interactive",
      `--instance ${shellQuote(forgejoUrl)}`,
      `--token ${shellQuote(token)}`,
      `--name ${shellQuote(runner.name)}`,
      `--labels ${shellQuote(labelsArray(runner.labels).join(","))}`
    ].join(" "),
    "fi",
    "exec forgejo-runner daemon --config /data/config.yml"
  ].join("\n");
}

function containerOptions(runner: Runner, token: string, forgejoUrl: string) {
  const binds = [`${runner.volumeName}:/data`];
  if (runner.mountDockerSocket) {
    binds.push(`${DOCKER_SOCKET_PATH}:/var/run/docker.sock`);
  }

  return {
    Image: runner.image || DEFAULT_RUNNER_IMAGE,
    name: runner.containerName,
    Labels: {
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [RUNNER_ID_LABEL]: runner.id,
      "com.forgejo-runner-manager.runner-name": runner.name
    },
    Env: [
      `FORGEJO_INSTANCE_URL=${forgejoUrl}`,
      `RUNNER_NAME=${runner.name}`,
      `RUNNER_LABELS=${labelsArray(runner.labels).join(",")}`
    ],
    User: runner.runAsRoot ? "0:0" : undefined,
    Cmd: ["/bin/sh", "-c", startupScript(runner, token, forgejoUrl)],
    HostConfig: {
      Binds: binds,
      RestartPolicy: { Name: "unless-stopped" as const }
    }
  };
}

async function findContainer(runner: Runner) {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: [`${RUNNER_ID_LABEL}=${runner.id}`]
    }
  });
  if (containers[0]) return containers[0];

  const byName = await docker.listContainers({
    all: true,
    filters: {
      name: [runner.containerName]
    }
  });

  return byName.find((container) => container.Names.some((name) => name === `/${runner.containerName}`));
}

function statusFromDocker(state?: string): RunnerStatus {
  if (!state) return "missing";
  if (state === "running") return "running";
  if (state === "paused") return "paused";
  if (state === "restarting") return "restarting";
  if (state === "exited") return "exited";
  if (state === "created") return "created";
  if (state === "dead") return "dead";
  return "unknown";
}

export async function runnerStatus(runner: Runner): Promise<RunnerWithStatus> {
  const container = await findContainer(runner);
  if (!container) {
    return { ...runner, status: "missing" };
  }

  return {
    ...runner,
    status: statusFromDocker(container.State),
    dockerId: container.Id,
    dockerImage: container.Image,
    startedAt: container.Status
  };
}

export async function listRunnerStatuses(runners: Runner[]) {
  return Promise.all(runners.map(runnerStatus));
}

function looksLikeForgejoRunner(container: Dockerode.ContainerInfo) {
  const haystack = [
    container.Image,
    container.Command,
    ...container.Names,
    ...Object.entries(container.Labels ?? {}).map(([key, value]) => `${key}=${value}`)
  ].join(" ").toLowerCase();

  return haystack.includes("forgejo") && haystack.includes("runner");
}

function inferLabels(inspect: Dockerode.ContainerInspectInfo) {
  const env = inspect.Config.Env ?? [];
  const envLabels = env.find((value) => value.startsWith("RUNNER_LABELS="))?.slice("RUNNER_LABELS=".length);
  if (envLabels) return envLabels;

  const command = [...(inspect.Config.Cmd ?? []), ...(inspect.Args ?? [])].join(" ");
  const flagMatch = command.match(/--labels(?:=|\s+)(['"]?)([^'"\s]+)\1/);
  if (flagMatch?.[2]) return flagMatch[2];

  return "";
}

function inferVolumeName(inspect: Dockerode.ContainerInspectInfo) {
  const dataMount = inspect.Mounts?.find((mount) => mount.Destination === "/data");
  return dataMount?.Name || dataMount?.Source || `${inspect.Name.replace(/^\//, "")}_data`;
}

function inferDockerSocket(inspect: Dockerode.ContainerInspectInfo) {
  return Boolean(inspect.Mounts?.some((mount) => mount.Destination === "/var/run/docker.sock" || mount.Source === DOCKER_SOCKET_PATH));
}

function inferRunAsRoot(inspect: Dockerode.ContainerInspectInfo) {
  const user = inspect.Config.User || "";
  return user === "0" || user === "0:0" || user === "root";
}

export async function discoverExistingRunners(): Promise<DiscoveredRunner[]> {
  const [containers, tracked] = await Promise.all([
    docker.listContainers({ all: true }),
    repo.listRunners()
  ]);
  const trackedNames = new Set(tracked.map((runner) => runner.containerName));
  const trackedDockerIds = new Set((await listRunnerStatuses(tracked)).map((runner) => runner.dockerId).filter(Boolean));
  const candidates = containers.filter(looksLikeForgejoRunner);

  const discovered = await Promise.all(candidates.map(async (container): Promise<DiscoveredRunner> => {
    const inspect = await docker.getContainer(container.Id).inspect();
    const containerName = inspect.Name.replace(/^\//, "");
    const labels = inferLabels(inspect);
    const volumeName = inferVolumeName(inspect);
    const notes = [];

    if (!labels) notes.push("Labels could not be inferred; review before adopting.");
    if (!inspect.Mounts?.some((mount) => mount.Destination === "/data")) notes.push("No /data mount found; preserving registration may require manual review.");
    if (volumeName.startsWith("/")) notes.push("/data appears to be a bind mount, not a named Docker volume.");
    if (!inspect.Config.Labels?.[RUNNER_ID_LABEL]) notes.push("Container does not have this app's management labels; operations will fall back to container name.");

    const confidence = labels && inspect.Mounts?.some((mount) => mount.Destination === "/data")
      ? "high"
      : labels || inspect.Mounts?.some((mount) => mount.Destination === "/data")
        ? "medium"
        : "low";

    return {
      dockerId: container.Id,
      containerName,
      image: inspect.Config.Image || container.Image,
      status: statusFromDocker(inspect.State.Status),
      labels,
      volumeName,
      mountDockerSocket: inferDockerSocket(inspect),
      runAsRoot: inferRunAsRoot(inspect),
      alreadyTracked: trackedNames.has(containerName) || trackedDockerIds.has(container.Id),
      confidence,
      notes
    };
  }));

  return discovered.sort((left, right) => Number(left.alreadyTracked) - Number(right.alreadyTracked));
}

export async function ensureImage(image: string) {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function createContainer(runner: Runner) {
  const config = await repo.getConfig();
  const token = await repo.getToken(runner.tokenId);
  if (!config.forgejoUrl) throw new Error("Forgejo instance URL is required before creating a runner.");
  if (!token) throw new Error("Runner registration token was not found.");

  const existing = await findContainer(runner);
  if (existing) throw new Error("A managed container already exists for this runner.");

  const options = containerOptions(runner, token.token, config.forgejoUrl);
  await docker.createVolume({ Name: runner.volumeName, Labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [RUNNER_ID_LABEL]: runner.id } }).catch((error: any) => {
    if (error.statusCode !== 409) throw error;
  });
  try {
    await docker.getImage(options.Image).inspect();
  } catch {
    await ensureImage(options.Image);
  }
  const container = await docker.createContainer(options);
  return container.id;
}

export async function startRunner(runner: Runner) {
  let container = await findContainer(runner);
  if (!container) {
    await createContainer(runner);
    container = await findContainer(runner);
  }
  if (!container) throw new Error("Unable to create runner container.");
  await docker.getContainer(container.Id).start().catch((error: any) => {
    if (error.statusCode !== 304) throw error;
  });
}

export async function stopRunner(runner: Runner) {
  const container = await findContainer(runner);
  if (!container) return;
  await docker.getContainer(container.Id).stop({ t: 20 }).catch((error: any) => {
    if (error.statusCode !== 304) throw error;
  });
}

export async function restartRunner(runner: Runner) {
  const container = await findContainer(runner);
  if (!container) {
    await startRunner(runner);
    return;
  }
  await docker.getContainer(container.Id).restart({ t: 20 });
}

export async function removeRunnerContainer(runner: Runner, removeVolume = false) {
  const container = await findContainer(runner);
  if (container) {
    const handle = docker.getContainer(container.Id);
    await handle.stop({ t: 20 }).catch(() => undefined);
    await handle.remove({ force: true });
  }
  if (removeVolume) {
    await docker.getVolume(runner.volumeName).remove().catch(() => undefined);
  }
}

export async function recreateRunnerContainer(runner: Runner) {
  const before = await runnerStatus(runner);
  await removeRunnerContainer(runner, false);
  await createContainer(runner);
  if (before.status === "running") {
    await startRunner(runner);
  }
}

export async function runnerLogs(runner: Runner, tail = 300) {
  const container = await findContainer(runner);
  if (!container) return "";
  const buffer = await docker.getContainer(container.Id).logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    tail
  });
  return decodeDockerLogBuffer(buffer);
}

function decodeDockerLogBuffer(buffer: Buffer) {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const nextOffset = offset + 8 + size;

    if ((streamType === 1 || streamType === 2) && size >= 0 && nextOffset <= buffer.length) {
      chunks.push(buffer.subarray(offset + 8, nextOffset));
      offset = nextOffset;
    } else {
      return buffer.toString("utf8");
    }
  }

  if (offset < buffer.length) {
    chunks.push(buffer.subarray(offset));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function dockerCliCommand(runner: Runner, redactToken = true) {
  const config = await repo.getConfig();
  const token = await repo.getToken(runner.tokenId);
  const tokenValue = redactToken ? "<registration-token>" : token?.token ?? "<missing-token>";
  const binds = [`-v ${shellQuote(`${runner.volumeName}:/data`)}`];
  if (runner.mountDockerSocket) {
    binds.push(`-v ${shellQuote(`${DOCKER_SOCKET_PATH}:/var/run/docker.sock`)}`);
  }
  const user = runner.runAsRoot ? " --user 0:0" : "";
  const env = [
    `-e FORGEJO_INSTANCE_URL=${shellQuote(config.forgejoUrl || "<forgejo-url>")}`,
    `-e RUNNER_NAME=${shellQuote(runner.name)}`,
    `-e RUNNER_LABELS=${shellQuote(labelsArray(runner.labels).join(","))}`
  ].join(" ");

  const command = startupScript(runner, tokenValue, config.forgejoUrl || "<forgejo-url>");
  return [
    `docker volume create ${shellQuote(runner.volumeName)}`,
    `docker run -d --name ${shellQuote(runner.containerName)} --restart unless-stopped${user} ${binds.join(" ")} ${env} ${shellQuote(runner.image)} /bin/sh -c ${shellQuote(command)}`
  ].join("\n");
}

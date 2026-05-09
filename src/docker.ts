import Docker from "dockerode";
import {
  DEFAULT_RUNNER_IMAGE,
  DOCKER_SOCKET_PATH,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  RUNNER_ID_LABEL
} from "./config.js";
import { repo } from "./db.js";
import type { Runner, RunnerStatus, RunnerWithStatus } from "./types.js";

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
  return containers[0];
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
  await docker.getContainer(container.Id).start();
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
  const stream = await docker.getContainer(container.Id).logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    tail
  });
  return stream.toString("utf8").replaceAll(/\u0001|\u0002|\u0003|\u0000/g, "");
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

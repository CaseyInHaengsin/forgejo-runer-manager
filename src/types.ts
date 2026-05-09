export type RunnerStatus = "missing" | "created" | "running" | "paused" | "restarting" | "exited" | "dead" | "unknown";

export interface AppConfig {
  forgejoUrl: string;
}

export interface RegistrationToken {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export interface Runner {
  id: string;
  name: string;
  tokenId: string;
  image: string;
  labels: string;
  volumeName: string;
  containerName: string;
  mountDockerSocket: boolean;
  runAsRoot: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RunnerWithStatus extends Runner {
  status: RunnerStatus;
  dockerId?: string;
  dockerImage?: string;
  startedAt?: string;
  finishedAt?: string;
}

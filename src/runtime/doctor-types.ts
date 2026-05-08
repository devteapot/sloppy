import type { SloppyConfig } from "../config/schema";
import type { CredentialStore } from "../llm/credential-store";

export type RuntimeDoctorCheck = {
  id: string;
  status: "ok" | "warning" | "error" | "skipped";
  summary: string;
  detail?: string;
};

export type RuntimeDoctorOptions = {
  workspaceRoot?: string;
  config?: SloppyConfig;
  litellmUrl?: string;
  acpAdapterId?: string;
  timeoutMs?: number;
  credentialStore?: CredentialStore;
  eventLogPath?: string;
  socketPath?: string;
};

export type RuntimeDoctorContext = {
  config: SloppyConfig;
  workspaceRoot: string;
  options: RuntimeDoctorOptions;
  timeoutMs: number;
};

export type RuntimeDoctorResult = {
  workspaceRoot: string;
  checks: RuntimeDoctorCheck[];
};

export type RuntimeDoctorCheckFactory = (
  context: RuntimeDoctorContext,
) => RuntimeDoctorCheck | Promise<RuntimeDoctorCheck>;

export type RuntimeDoctorSubprocessProbe = {
  label: string;
  command: string;
  cwd: string;
};

export type RuntimeDoctorSubprocessProbeFactory = (
  context: RuntimeDoctorContext,
) => RuntimeDoctorSubprocessProbe[] | Promise<RuntimeDoctorSubprocessProbe[]>;

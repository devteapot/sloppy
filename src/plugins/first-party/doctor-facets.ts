import type { SloppyConfig } from "../../config/schema";
import type {
  RuntimeDoctorCheckFactory,
  RuntimeDoctorSubprocessProbeFactory,
} from "../../runtime/doctor-types";
import { checkAcpAdapter, checkAcpBoundary, collectAcpSubprocessProbes } from "./delegation/doctor";
import { checkWorkspacePaths } from "./filesystem/doctor";
import { checkMcpEnvironmentExposure, collectMcpSubprocessProbes } from "./mcp/doctor";
import { checkMetaRuntimePersistence } from "./meta-runtime/doctor";
import { checkVoiceConfiguration, collectVoiceSubprocessProbes } from "./voice/doctor";

export function createFirstPartyDoctorChecks(_config: SloppyConfig): RuntimeDoctorCheckFactory[] {
  return [
    checkWorkspacePaths,
    checkMetaRuntimePersistence,
    checkAcpAdapter,
    checkAcpBoundary,
    checkMcpEnvironmentExposure,
    checkVoiceConfiguration,
  ];
}

export function createFirstPartyDoctorSubprocessProbes(
  _config: SloppyConfig,
): RuntimeDoctorSubprocessProbeFactory[] {
  return [collectAcpSubprocessProbes, collectMcpSubprocessProbes, collectVoiceSubprocessProbes];
}

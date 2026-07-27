import type { OmhResult } from "../cli/render.js";
import type { EnvironmentInstanceId } from "../domain/environment-instance.js";

export interface TargetRequest {
  readonly argv: readonly string[];
  readonly repositoryRoot: string;
  readonly startIfStopped: boolean;
  readonly targetId: EnvironmentInstanceId;
  readonly signal?: AbortSignal;
}

export interface TargetPort {
  run(request: TargetRequest): Promise<OmhResult>;
}

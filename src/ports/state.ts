import type { AgentId } from "../domain/catalog.js";
import type {
  CapabilitySet,
  EnvironmentInstance,
  ToolRoute,
} from "../domain/environment-instance.js";

export interface ApplyJournal {
  readonly schemaVersion: "2.0.0";
  readonly kind: "apply-journal";
  readonly planDigest: string;
  readonly catalogRevision: string;
  readonly completedActionIds: readonly string[];
  readonly pendingRecoveries?: readonly ApplyRecoveryRecord[];
  readonly status: "applying" | "partial-unready" | "ready";
  readonly failure?: string;
}

export interface ApplyRecoveryRecord {
  readonly actionId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ManagedStateReceipt {
  readonly $schema: "../contracts/managed-state-receipt.schema.json";
  readonly schemaVersion: "2.0.0";
  readonly kind: "managed-state-receipt";
  readonly catalogRevision: string;
  readonly planDigest: string;
  readonly appliedAt: string;
  readonly completedActionIds: readonly string[];
  readonly desiredState: {
    readonly profileId: string;
    readonly selectedAgents: readonly AgentId[];
    readonly instance?: EnvironmentInstance;
    readonly capabilitySet?: CapabilitySet;
    readonly selectedCapabilities?: readonly string[];
    readonly selectedPackages?: readonly string[];
    readonly toolRoutes?: readonly ToolRoute[];
  };
  readonly startupConsent: {
    readonly repairPinned: boolean;
    readonly addReviewedContent: boolean;
    readonly channelId: string;
    readonly profileId: string;
    readonly artifactClasses: readonly (
      | "managed-skill"
      | "plugin"
      | "hook"
      | "mcp-server"
      | "lsp-binary"
      | "external-command"
      | "package-script"
    )[];
    readonly permissionScopes: readonly string[];
  };
  readonly runtimeReadiness: readonly {
    readonly agentId: AgentId;
    readonly state: "ready" | "pending" | "unsupported" | "unverifiable";
  }[];
  readonly ownership: readonly {
    readonly id: string;
    readonly kind: "file" | "directory" | "registration" | "executable";
    readonly scope: "external" | "managed";
    readonly target: string;
    readonly digest: string;
    readonly repairSource?: string;
  }[];
  readonly releaseChannels?: Readonly<
    Record<
      string,
      {
        readonly sequence: number;
        readonly manifestDigest: string;
      }
    >
  >;
}

export interface StatePort {
  withApplyLock<T>(operation: () => Promise<T>): Promise<T>;
  readJournal(): Promise<ApplyJournal | null>;
  readReceipt?(): Promise<ManagedStateReceipt | null>;
  writeJournal(journal: ApplyJournal): Promise<void>;
  publishReceipt(receipt: ManagedStateReceipt): Promise<void>;
}

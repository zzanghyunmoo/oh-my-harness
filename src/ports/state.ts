export interface ApplyJournal {
  readonly schemaVersion: "2.0.0";
  readonly kind: "apply-journal";
  readonly planDigest: string;
  readonly catalogRevision: string;
  readonly completedActionIds: readonly string[];
  readonly status: "applying" | "partial-unready" | "ready";
  readonly failure?: string;
}

export interface ManagedStateReceipt {
  readonly schemaVersion: "2.0.0";
  readonly kind: "managed-state-receipt";
  readonly catalogRevision: string;
  readonly planDigest: string;
  readonly desiredState: {
    readonly profileId: string;
    readonly selectedAgents: readonly string[];
  };
  readonly completedActionIds: readonly string[];
  readonly appliedAt: string;
}

export interface StatePort {
  withApplyLock<T>(operation: () => Promise<T>): Promise<T>;
  readJournal(): Promise<ApplyJournal | null>;
  writeJournal(journal: ApplyJournal): Promise<void>;
  publishReceipt(receipt: ManagedStateReceipt): Promise<void>;
}

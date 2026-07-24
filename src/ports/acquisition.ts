export interface AcquisitionRequest {
  readonly id: string;
  readonly source: string;
  readonly expectedSha256: string;
}

export interface AcquisitionResult {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
}

export interface AcquisitionPort {
  acquire(request: AcquisitionRequest): Promise<AcquisitionResult>;
}

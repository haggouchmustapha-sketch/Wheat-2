export const UPDATE_SCHEMA_VERSION = 1 as const;

export type UpdateRelease = {
  schemaVersion: typeof UPDATE_SCHEMA_VERSION;
  version: string;
  releaseDate: string;
  notes: string[];
  artifact: string;
  sha256: string;
  minimumVersion?: string;
  artifactSize?: number;
  signature?: {
    algorithm: string;
    value: string;
  };
};

export type AcquiredUpdate = {
  release: UpdateRelease;
  artifactPath: string;
};

export type StagedUpdate = AcquiredUpdate & {
  stagedAt: string;
  source: string;
};

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "staging"
  | "ready"
  | "installing"
  | "awaiting-confirmation"
  | "updated"
  | "error";

export type InstalledUpdateNotice = Pick<UpdateRelease, "version" | "releaseDate" | "notes"> & {
  installedAt: string;
};

export type UpdateStatus = {
  phase: UpdatePhase;
  source: string;
  currentVersion: string;
  availableVersion?: string;
  lastCheckedAt?: string;
  message?: string;
  error?: string;
  automaticInstallationEnabled: boolean;
  installedUpdate?: InstalledUpdateNotice;
};

export type PersistedUpdateState = {
  schemaVersion: typeof UPDATE_SCHEMA_VERSION;
  status: UpdateStatus;
  pending?: {
    release: UpdateRelease;
    artifactPath: string;
    previousVersion: string;
    stagedAt: string;
    installStartedAt?: string;
    rollbackPath?: string;
  };
  lastSuccessfullyInstalledVersion?: string;
  notification?: InstalledUpdateNotice & { consumed: boolean };
};

export interface UpdateProvider {
  readonly name: string;
  getLatestRelease(): Promise<UpdateRelease | null>;
  acquireUpdate(release: UpdateRelease, stagingDirectory: string): Promise<AcquiredUpdate>;
  validateUpdate(update: AcquiredUpdate): Promise<void>;
}

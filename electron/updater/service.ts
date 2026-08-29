import fs from "node:fs";
import path from "node:path";
import type { PersistedUpdateState, StagedUpdate, UpdateProvider, UpdateStatus } from "./types";
import { assertUpdateCompatibility } from "./validation";
import { UpdateStateStore } from "./state";
import { UpdateLogger } from "./logger";

export type UpdateServiceOptions = {
  currentVersion: string;
  provider: UpdateProvider;
  stateDirectory: string;
  automaticInstallationEnabled: boolean;
  onStatus?: (status: UpdateStatus) => void;
};

export class UpdateService {
  readonly store: UpdateStateStore;
  readonly logger: UpdateLogger;
  private readonly options: UpdateServiceOptions;
  private checkPromise: Promise<PersistedUpdateState> | null = null;
  private installPromise: Promise<PersistedUpdateState> | null = null;

  constructor(options: UpdateServiceOptions) {
    this.options = options;
    this.store = new UpdateStateStore(options.stateDirectory, options.currentVersion, options.provider.name, options.automaticInstallationEnabled);
    this.logger = new UpdateLogger(options.stateDirectory);
  }

  async getStatus() {
    return (await this.store.read()).status;
  }

  async confirmSuccessfulStartup() {
    const state = await this.store.confirmSuccessfulStartup();
    if (state.status.phase === "updated") await this.logger.log("update-success", { version: this.options.currentVersion });
    this.emit(state.status);
    return state.status;
  }

  async acknowledgeInstalledUpdate() {
    const state = await this.store.acknowledgeInstalledUpdate();
    this.emit(state.status);
    return state.status;
  }

  async hasUnresolvedInstallationFailure() {
    const state = await this.store.read();
    return state.status.phase === "error" && Boolean(state.pending?.installStartedAt);
  }

  checkForUpdates() {
    if (this.installPromise) return this.installPromise;
    if (!this.checkPromise) this.checkPromise = this.performCheck().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  private async performCheck() {
    const checkedAt = new Date().toISOString();
    await this.logger.log("check-started", { source: this.options.provider.name, installedVersion: this.options.currentVersion });
    await this.setStatus({ phase: "checking", lastCheckedAt: checkedAt, message: "Checking for updates", error: undefined });
    try {
      const release = await this.options.provider.getLatestRelease();
      if (!release) {
        await this.logger.log("check-complete", { result: "no-local-release", installedVersion: this.options.currentVersion });
        return this.setStatus({ phase: "up-to-date", lastCheckedAt: checkedAt, availableVersion: undefined, message: "Up to date", error: undefined });
      }
      await this.logger.log("metadata-valid", { availableVersion: release.version, schemaVersion: release.schemaVersion });
      const isNewer = assertUpdateCompatibility(this.options.currentVersion, release);
      if (!isNewer) {
        await this.logger.log("check-complete", { result: "up-to-date", availableVersion: release.version, installedVersion: this.options.currentVersion });
        return this.setStatus({ phase: "up-to-date", lastCheckedAt: checkedAt, availableVersion: undefined, message: "Up to date", error: undefined });
      }
      await this.setStatus({ phase: "available", lastCheckedAt: checkedAt, availableVersion: release.version, message: `Update ${release.version} available`, error: undefined });
      await this.logger.log("update-available", { availableVersion: release.version, installedVersion: this.options.currentVersion });
      const stagingDirectory = path.join(this.options.stateDirectory, "staging", release.version);
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
      await this.setStatus({ phase: "staging", message: `Staging update ${release.version}` });
      const acquired = await this.options.provider.acquireUpdate(release, stagingDirectory);
      await this.options.provider.validateUpdate(acquired);
      await this.logger.log("artifact-valid", { availableVersion: release.version, artifact: path.basename(acquired.artifactPath) });
      const staged: StagedUpdate = { ...acquired, stagedAt: new Date().toISOString(), source: this.options.provider.name };
      const state = await this.store.read();
      state.pending = {
        release,
        artifactPath: acquired.artifactPath,
        previousVersion: this.options.currentVersion,
        stagedAt: staged.stagedAt,
      };
      state.status = {
        ...state.status,
        phase: "ready",
        lastCheckedAt: checkedAt,
        availableVersion: release.version,
        message: this.options.automaticInstallationEnabled ? `Update ${release.version} is ready to install` : `Update ${release.version} validated; installation is disabled in development`,
        error: undefined,
      };
      await this.store.write(state);
      await this.logger.log("staging-complete", { availableVersion: release.version });
      this.emit(state.status);
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger.log("update-rejected", { reason: message });
      return this.setStatus({ phase: "error", lastCheckedAt: checkedAt, message: "Update check failed", error: message });
    }
  }

  installStagedUpdate(launch: (state: PersistedUpdateState) => Promise<void>) {
    if (!this.installPromise) this.installPromise = this.performInstall(launch).finally(() => { this.installPromise = null; });
    return this.installPromise;
  }

  private async performInstall(launch: (state: PersistedUpdateState) => Promise<void>) {
    const state = await this.store.read();
    if (!this.options.automaticInstallationEnabled) return state;
    if (!state.pending || state.status.phase !== "ready") throw new Error("No validated Wheat update is ready to install.");
    state.status = { ...state.status, phase: "installing", message: `Installing update ${state.pending.release.version}`, error: undefined };
    state.pending.installStartedAt = new Date().toISOString();
    await this.store.write(state);
    this.emit(state.status);
    await this.logger.log("installation-started", { availableVersion: state.pending.release.version });
    try {
      await launch(state);
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.status = { ...state.status, phase: "error", message: "Update installation could not start", error: message };
      await this.store.write(state);
      await this.logger.log("installation-launch-failed", { reason: message });
      this.emit(state.status);
      return state;
    }
  }

  private async setStatus(patch: Partial<UpdateStatus>) {
    const state = await this.store.updateStatus(patch);
    this.emit(state.status);
    return state;
  }

  private emit(status: UpdateStatus) {
    this.options.onStatus?.(status);
  }
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AcquiredUpdate, UpdateProvider, UpdateRelease } from "./types";
import { sha256File, validateReleaseManifest } from "./validation";

const MAX_MANIFEST_BYTES = 1024 * 1024;

export class LocalUpdateProvider implements UpdateProvider {
  readonly name = "local";
  private readonly updatesDirectory: string;

  constructor(updatesDirectory: string) {
    this.updatesDirectory = updatesDirectory;
  }

  async getLatestRelease() {
    const manifestPath = path.join(this.updatesDirectory, "latest.json");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) throw new Error("Local update manifest is missing, empty, or too large.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error("Local update manifest is not valid JSON.", { cause: error });
    }
    return validateReleaseManifest(parsed);
  }

  private resolveArtifact(release: UpdateRelease) {
    const root = path.resolve(this.updatesDirectory);
    const artifactPath = path.resolve(root, release.artifact);
    if (!artifactPath.startsWith(`${root}${path.sep}`)) throw new Error("Update artifact escapes the configured local update directory.");
    return artifactPath;
  }

  async acquireUpdate(release: UpdateRelease, stagingDirectory: string): Promise<AcquiredUpdate> {
    const sourcePath = this.resolveArtifact(release);
    const sourceStat = await fs.promises.stat(sourcePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Update artifact is missing: ${path.basename(sourcePath)}.`);
      throw error;
    });
    if (!sourceStat.isFile()) throw new Error("Update artifact is not a regular file.");
    const [realRoot, realArtifact] = await Promise.all([
      fs.promises.realpath(path.resolve(this.updatesDirectory)),
      fs.promises.realpath(sourcePath),
    ]);
    if (!realArtifact.startsWith(`${realRoot}${path.sep}`)) throw new Error("Update artifact resolves outside the configured local update directory.");
    if (release.artifactSize && sourceStat.size !== release.artifactSize) throw new Error("Update artifact size does not match its metadata.");
    await fs.promises.mkdir(stagingDirectory, { recursive: true });
    const finalPath = path.join(stagingDirectory, path.basename(sourcePath));
    const temporaryPath = `${finalPath}.${randomUUID()}.part`;
    try {
      await fs.promises.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
      await fs.promises.rename(temporaryPath, finalPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return { release, artifactPath: finalPath };
  }

  async validateUpdate(update: AcquiredUpdate) {
    const stat = await fs.promises.stat(update.artifactPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Staged update artifact is missing.");
      throw error;
    });
    if (!stat.isFile() || stat.size < 1) throw new Error("Staged update artifact is empty or invalid.");
    if (update.release.artifactSize && stat.size !== update.release.artifactSize) throw new Error("Staged update artifact size does not match its metadata.");
    const checksum = await sha256File(update.artifactPath);
    if (checksum !== update.release.sha256) throw new Error("Update artifact failed SHA-256 verification and was rejected.");
  }
}

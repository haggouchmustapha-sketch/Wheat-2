import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { PersistedUpdateState } from "./types";

export type WindowsInstallerOptions = {
  stateDirectory: string;
  helperPath: string;
  currentExecutable: string;
  parentPid: number;
};

export function launchWindowsUpdateHelper(state: PersistedUpdateState, options: WindowsInstallerOptions) {
  if (process.platform !== "win32") throw new Error("Automatic installation is currently supported only on Windows packaged builds.");
  if (!state.pending) throw new Error("No staged update is available.");
  for (const filePath of [state.pending.artifactPath, options.helperPath, options.currentExecutable]) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Required update file is missing: ${path.basename(filePath)}.`);
  }
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(powershell)) throw new Error("Windows PowerShell is required to apply this local update.");
  const rollbackDirectory = path.join(options.stateDirectory, "rollback", state.pending.previousVersion);
  state.pending.rollbackPath = rollbackDirectory;
  const child = spawn(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", options.helperPath,
    "-ParentPid", String(options.parentPid),
    "-InstallerPath", state.pending.artifactPath,
    "-CurrentExecutable", options.currentExecutable,
    "-StatePath", path.join(options.stateDirectory, "state.json"),
    "-RollbackDirectory", rollbackDirectory,
    "-LogPath", path.join(options.stateDirectory, "updater.log"),
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

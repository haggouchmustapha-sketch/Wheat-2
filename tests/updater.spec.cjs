const { test, expect } = require("@playwright/test");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.ATLAS_LEDGER_CWD ?? path.resolve(__dirname, "..");
let updater;

test.beforeAll(() => {
  updater = tsxRequire(path.join(root, "electron", "updater", "index.ts"), __filename);
});

function temporaryWorkspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-updater-"));
  return {
    directory,
    feed: path.join(directory, "updates"),
    state: path.join(directory, "profile", "updater"),
    dataFile: path.join(directory, "profile", "atlas-ledger.sqlite"),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeRelease(feed, overrides = {}, artifactBytes = Buffer.from("valid Wheat installer")) {
  const version = overrides.version ?? "2.2.0";
  const artifactName = `AtlasLedgerSetup-${version}.exe`;
  const releaseDirectory = path.join(feed, version);
  fs.mkdirSync(releaseDirectory, { recursive: true });
  fs.writeFileSync(path.join(releaseDirectory, artifactName), artifactBytes);
  const release = {
    schemaVersion: 1,
    version,
    releaseDate: "2026-08-28",
    notes: ["Added automatic updates", "Fixed a startup issue"],
    artifact: `${version}/${artifactName}`,
    sha256: sha256(artifactBytes),
    artifactSize: artifactBytes.length,
    ...overrides,
  };
  fs.mkdirSync(feed, { recursive: true });
  fs.writeFileSync(path.join(feed, "latest.json"), JSON.stringify(release));
  fs.writeFileSync(path.join(releaseDirectory, "release.json"), JSON.stringify(release));
  return release;
}

function serviceFor(workspace, currentVersion = "2.1.0", automaticInstallationEnabled = false, provider) {
  return new updater.UpdateService({
    currentVersion,
    provider: provider ?? new updater.LocalUpdateProvider(workspace.feed),
    stateDirectory: workspace.state,
    automaticInstallationEnabled,
  });
}

test("semantic versions compare numerically, including 2.10.0 versus 2.9.0", () => {
  expect(updater.assertUpdateCompatibility("2.9.0", writeReleaseObject("2.10.0"))).toBe(true);
  expect(() => updater.assertUpdateCompatibility("2.10.0", writeReleaseObject("2.9.0"))).toThrow(/Downgrade rejected/);
});

test("no local manifest continues as up to date without an error", async () => {
  const workspace = temporaryWorkspace();
  try {
    const result = await serviceFor(workspace).checkForUpdates();
    expect(result.status.phase).toBe("up-to-date");
    expect(result.status.error).toBeUndefined();
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("a newer release is acquired, checksum-validated, and staged", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const result = await serviceFor(workspace).checkForUpdates();
    expect(result.status).toMatchObject({ phase: "ready", availableVersion: "2.2.0", automaticInstallationEnabled: false });
    expect(result.pending.artifactPath).toContain(path.join("staging", "2.2.0"));
    expect(fs.existsSync(result.pending.artifactPath)).toBe(true);
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("same-version metadata reports no update", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed, { version: "2.1.0" });
    expect((await serviceFor(workspace).checkForUpdates()).status.phase).toBe("up-to-date");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

for (const scenario of [
  {
    name: "malformed manifest",
    arrange(workspace) { fs.mkdirSync(workspace.feed, { recursive: true }); fs.writeFileSync(path.join(workspace.feed, "latest.json"), "{broken"); },
    message: /valid JSON/,
  },
  {
    name: "missing artifact",
    arrange(workspace) { const release = writeRelease(workspace.feed); fs.rmSync(path.join(workspace.feed, release.version, path.basename(release.artifact))); },
    message: /artifact is missing/,
  },
  {
    name: "invalid SHA-256 metadata",
    arrange(workspace) { writeRelease(workspace.feed, { sha256: "not-a-hash" }); },
    message: /invalid SHA-256/,
  },
  {
    name: "corrupt update artifact",
    arrange(workspace) { const release = writeRelease(workspace.feed); fs.appendFileSync(path.join(workspace.feed, release.version, path.basename(release.artifact)), "corruption"); },
    message: /size does not match|SHA-256 verification/,
  },
  {
    name: "downgrade attempt",
    arrange(workspace) { writeRelease(workspace.feed, { version: "2.0.9" }); },
    message: /Downgrade rejected/,
  },
  {
    name: "incompatible release",
    arrange(workspace) { writeRelease(workspace.feed, { minimumVersion: "2.1.5" }); },
    message: /requires Wheat 2.1.5/,
  },
]) {
  test(`${scenario.name} is rejected and logged`, async () => {
    const workspace = temporaryWorkspace();
    try {
      scenario.arrange(workspace);
      const result = await serviceFor(workspace).checkForUpdates();
      expect(result.status.phase).toBe("error");
      expect(result.status.error).toMatch(scenario.message);
      expect(fs.readFileSync(path.join(workspace.state, "updater.log"), "utf8")).toContain("update-rejected");
    } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
  });
}

test("successful staged installation is confirmed only by the updated version after restart", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const oldService = serviceFor(workspace, "2.1.0", true);
    await oldService.checkForUpdates();
    let launched = 0;
    const installing = await oldService.installStagedUpdate(async (state) => {
      launched += 1;
      expect(state.pending.release.version).toBe("2.2.0");
    });
    expect(launched).toBe(1);
    expect(installing.status.phase).toBe("installing");
    expect(installing.status.installedUpdate).toBeUndefined();

    const updatedService = serviceFor(workspace, "2.2.0", true);
    const confirmed = await updatedService.confirmSuccessfulStartup();
    expect(confirmed.phase).toBe("updated");
    expect(confirmed.installedUpdate.notes).toEqual(["Added automatic updates", "Fixed a startup issue"]);
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("failed installation launch records recovery-safe error and leaves user data untouched", async () => {
  const workspace = temporaryWorkspace();
  try {
    fs.mkdirSync(path.dirname(workspace.dataFile), { recursive: true });
    fs.writeFileSync(workspace.dataFile, "precious accounting data");
    writeRelease(workspace.feed);
    const service = serviceFor(workspace, "2.1.0", true);
    await service.checkForUpdates();
    const failed = await service.installStagedUpdate(async () => { throw new Error("helper could not start"); });
    expect(failed.status).toMatchObject({ phase: "error", message: "Update installation could not start" });
    expect(fs.readFileSync(workspace.dataFile, "utf8")).toBe("precious accounting data");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("update success state survives restart and the modal notice is consumable exactly once", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const service = serviceFor(workspace, "2.1.0", true);
    await service.checkForUpdates();
    await service.installStagedUpdate(async () => undefined);
    const restarted = serviceFor(workspace, "2.2.0", true);
    await restarted.confirmSuccessfulStartup();
    expect((await restarted.getStatus()).installedUpdate.version).toBe("2.2.0");
    await restarted.acknowledgeInstalledUpdate();
    expect((await restarted.getStatus()).installedUpdate).toBeUndefined();
    expect((await serviceFor(workspace, "2.2.0", true).getStatus()).installedUpdate).toBeUndefined();
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("manual checks and concurrent automatic checks share one provider operation", async () => {
  const workspace = temporaryWorkspace();
  try {
    const release = writeRelease(workspace.feed);
    const local = new updater.LocalUpdateProvider(workspace.feed);
    let calls = 0;
    const provider = {
      name: "test-local",
      async getLatestRelease() { calls += 1; await new Promise((resolve) => setTimeout(resolve, 40)); return release; },
      acquireUpdate: (...args) => local.acquireUpdate(...args),
      validateUpdate: (...args) => local.validateUpdate(...args),
    };
    const service = serviceFor(workspace, "2.1.0", false, provider);
    const [automatic, manual] = await Promise.all([service.checkForUpdates(), service.checkForUpdates()]);
    expect(calls).toBe(1);
    expect(automatic.status.phase).toBe("ready");
    expect(manual.status.phase).toBe("ready");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("development mode stages safely without invoking the installer", async () => {
  const workspace = temporaryWorkspace();
  try {
    writeRelease(workspace.feed);
    const service = serviceFor(workspace, "2.1.0", false);
    await service.checkForUpdates();
    let invoked = false;
    const state = await service.installStagedUpdate(async () => { invoked = true; });
    expect(invoked).toBe(false);
    expect(state.status.phase).toBe("ready");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("development and packaged local feed paths are isolated and deterministic", () => {
  const project = path.join("D:\\", "atlas-project");
  const userData = path.join("C:\\", "Users", "Atlas", "AppData", "Roaming", "Wheat");
  expect(updater.resolveLocalUpdateDirectory({ isPackaged: false, getPath: () => userData }, project, {})).toBe(path.resolve(project, "updates"));
  expect(updater.resolveLocalUpdateDirectory({ isPackaged: false, getPath: () => userData }, project, { ATLAS_LEDGER_UPDATES_DIR: path.join(project, "test-feed") })).toBe(path.resolve(project, "test-feed"));
  expect(updater.resolveLocalUpdateDirectory({ isPackaged: true, getPath: () => userData }, project, { ATLAS_LEDGER_UPDATES_DIR: "untrusted" })).toBe(path.join(userData, "updates"));
  expect(updater.resolveUpdaterStateDirectory({ isPackaged: true, getPath: () => userData })).toBe(path.join(userData, "updater"));
});

test("Wheat keeps the historical Atlas Ledger profile while using Wheat as the product name", () => {
  const mainSource = fs.readFileSync(path.join(root, "electron", "main.ts"), "utf8");
  expect(mainSource).toContain('const LEGACY_PROFILE_DIRECTORY_NAME = "Atlas Ledger";');
  expect(mainSource).toContain('app.setName("Wheat");');
  expect(mainSource).toContain('app.setPath("userData", path.join(app.getPath("appData"), LEGACY_PROFILE_DIRECTORY_NAME));');
});

test("the release packaging command generates matching manifests and SHA-256 automatically", () => {
  const workspace = temporaryWorkspace();
  try {
    // The packaging script reads the product version from package.json, so the
    // expectation follows it instead of pinning a release number here.
    const productVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    const artifact = path.join(workspace.directory, `WheatSetup-${productVersion}.exe`);
    const notes = path.join(workspace.directory, "notes.md");
    fs.writeFileSync(artifact, "test NSIS bytes");
    fs.writeFileSync(notes, `# Wheat ${productVersion}\n- Added local updates\n- Fixed recovery\n`);
    execFileSync(process.execPath, [
      path.join(root, "scripts", "package-update.mjs"),
      "--artifact", artifact,
      "--notes-file", notes,
      "--output", workspace.feed,
      "--no-publish",
    ], { cwd: root, stdio: "pipe" });
    const latest = JSON.parse(fs.readFileSync(path.join(workspace.feed, "latest.json"), "utf8"));
    const release = JSON.parse(fs.readFileSync(path.join(workspace.feed, productVersion, "release.json"), "utf8"));
    expect(latest).toEqual(release);
    expect(latest).toMatchObject({
      schemaVersion: 1,
      version: productVersion,
      notes: ["Added local updates", "Fixed recovery"],
      artifact: `${productVersion}/WheatSetup-${productVersion}.exe`,
      sha256: sha256(Buffer.from("test NSIS bytes")),
    });
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

test("the Windows helper snapshots program files and records recovery after installer failure", () => {
  test.skip(process.platform !== "win32", "Windows update helper test");
  const workspace = temporaryWorkspace();
  try {
    const installDirectory = path.join(workspace.directory, "installed");
    const currentExecutable = path.join(installDirectory, "Wheat.exe");
    const installer = path.join(workspace.directory, "broken-installer.exe");
    const rollback = path.join(workspace.state, "rollback", "2.1.0");
    const statePath = path.join(workspace.state, "state.json");
    const logPath = path.join(workspace.state, "updater.log");
    fs.mkdirSync(installDirectory, { recursive: true });
    fs.mkdirSync(workspace.state, { recursive: true });
    fs.writeFileSync(currentExecutable, "old executable bytes");
    fs.writeFileSync(path.join(installDirectory, "program.txt"), "old working program");
    fs.writeFileSync(installer, "not an executable");
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 1,
      status: { phase: "installing", source: "local", currentVersion: "2.1.0", automaticInstallationEnabled: true },
      pending: {
        release: writeReleaseObject("2.2.0"),
        artifactPath: installer,
        previousVersion: "2.1.0",
        stagedAt: new Date().toISOString(),
        installStartedAt: new Date().toISOString(),
      },
    }));
    let helperFailure;
    try {
      execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", path.join(root, "resources", "updater", "update-helper.ps1"),
        "-ParentPid", "999999",
        "-InstallerPath", installer,
        "-CurrentExecutable", currentExecutable,
        "-StatePath", statePath,
        "-RollbackDirectory", rollback,
        "-LogPath", logPath,
      ], { windowsHide: true, stdio: "pipe", timeout: 30000 });
    } catch (error) {
      helperFailure = error;
      // The intentionally invalid installer makes the helper exit non-zero.
    }
    const helperState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (helperState.status.phase !== "error") {
      throw new Error(`Update helper did not record recovery. ${helperFailure?.stderr?.toString() ?? helperFailure?.message ?? "No helper error was captured."}`);
    }
    expect(fs.readFileSync(path.join(rollback, "program.txt"), "utf8")).toBe("old working program");
    expect(fs.readFileSync(path.join(installDirectory, "program.txt"), "utf8")).toBe("old working program");
    expect(fs.readFileSync(logPath, "utf8")).toContain("rollback-restored");
  } finally { fs.rmSync(workspace.directory, { recursive: true, force: true }); }
});

function writeReleaseObject(version) {
  return {
    schemaVersion: 1,
    version,
    releaseDate: "2026-08-28",
    notes: ["Test"],
    artifact: `${version}/AtlasLedgerSetup-${version}.exe`,
    sha256: "a".repeat(64),
  };
}

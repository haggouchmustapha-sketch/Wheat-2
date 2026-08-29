const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("packaged Wheat discovers its bundled offline PaddleOCR runtime", async () => {
  const executablePath = process.env.ATLAS_LEDGER_EXE;
  test.skip(!executablePath, "Set ATLAS_LEDGER_EXE to verify a packaged PaddleOCR build.");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-paddle-packaged-"));
  const app = await electron.launch({
    executablePath,
    args: [],
    env: {
      ...process.env,
      APPDATA: path.join(tempDir, "appData"),
      LOCALAPPDATA: path.join(tempDir, "localAppData"),
      ATLAS_LEDGER_USER_DATA_DIR: path.join(tempDir, "userData"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.atlas?.getPaddleOcrStatus), null, { timeout: 20_000 });
    const status = await page.evaluate(() => window.atlas.getPaddleOcrStatus());
    expect(status).toMatchObject({
      available: true,
      local: true,
      version: "3.7.0",
      pythonVersion: "3.12.10",
      language: "fr",
      device: "cpu",
      reason: null,
    });
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

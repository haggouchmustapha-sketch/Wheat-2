const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("@playwright/test");

const root = path.resolve(__dirname, "..", "..", "..");
const output = __dirname;
const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const axePath = path.join(__dirname, "axe.min.js");
const routes = [
  "Accueil", "Production", "Tableau", "Societes", "Saisie", "Documents",
  "Factures & paiements", "Banque", "TVA", "Paie", "Rapports", "Livres fiables",
  "Liasse fiscale", "Wheat 1.0.0", "Atlas AI", "Export Sage", "Analyse locale", "Reglages",
];
const responsiveRoutes = ["Accueil", "Saisie", "Wheat 1.0.0", "Atlas AI"];
const targetWidths = [1180, 980, 760, 700, 640, 560];

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}

async function injectAxe(page) {
  if (!await page.evaluate(() => Boolean(window.axe)).catch(() => false)) throw new Error("axe-core was not injected before navigation");
}

async function axeAudit(page, label, context = ".page") {
  await injectAxe(page);
  return page.evaluate(async ({ auditLabel, selector }) => {
    const rootNode = selector === "document" ? document : document.querySelector(selector);
    const report = await window.axe.run(rootNode || document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    return report.violations.map((violation) => ({
      label: auditLabel,
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.slice(0, 8).map((node) => ({ target: node.target, summary: node.failureSummary })),
    }));
  }, { auditLabel: label, selector: context });
}

async function dialogFocusAudit(page, selector, label) {
  const locator = page.locator(selector);
  const escaped = [];
  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press(index === 12 ? "Shift+Tab" : "Tab");
    const state = await page.evaluate((dialogSelector) => {
      const dialog = document.querySelector(dialogSelector);
      const active = document.activeElement;
      return {
        inside: Boolean(dialog && active && dialog.contains(active)),
        active: active ? `${active.tagName.toLowerCase()}${active.getAttribute("aria-label") ? `[aria-label="${active.getAttribute("aria-label")}"]` : ""}` : "none",
      };
    }, selector);
    if (!state.inside) escaped.push({ index, active: state.active });
  }
  return { label, escaped };
}

async function responsiveAudit(page, browserWindow, route, targetWidth) {
  await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1));
  await browserWindow.evaluate((win) => win.setSize(1200, 1000));
  const baseWidth = await page.evaluate(() => window.innerWidth);
  await browserWindow.evaluate((win, zoom) => win.webContents.setZoomFactor(zoom), baseWidth / targetWidth);
  await page.waitForTimeout(140);
  return page.evaluate(({ routeName, requestedWidth }) => {
    const tolerance = 2;
    const mainPage = document.querySelector(".page");
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const safelyContained = (element) => {
      let parent = element.parentElement;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX) && rect.left >= -tolerance && rect.right <= innerWidth + tolerance) return true;
        parent = parent.parentElement;
      }
      return false;
    };
    const offenders = Array.from(document.querySelectorAll("body *"))
      .filter(visible)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ element, rect }) => (rect.left < -tolerance || rect.right > innerWidth + tolerance) && !safelyContained(element))
      .slice(0, 12)
      .map(({ element, rect }) => ({ selector: `${element.tagName.toLowerCase()}.${Array.from(element.classList).slice(0, 2).join(".")}`, left: Math.round(rect.left), right: Math.round(rect.right) }));
    return {
      route: routeName,
      requestedWidth,
      actual: `${innerWidth}x${innerHeight}`,
      direction: document.documentElement.dir,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + tolerance,
      pageOverflow: Boolean(mainPage && mainPage.scrollWidth > mainPage.clientWidth + tolerance),
      offenders,
    };
  }, { routeName: route, requestedWidth: targetWidth });
}

async function launch(profile) {
  const app = await electron.launch({
    executablePath: electronExe,
    args: [root],
    cwd: root,
    env: { ...process.env, ATLAS_LEDGER_USER_DATA_DIR: profile },
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript({ path: axePath });
  const browserWindow = await app.browserWindow(page);
  await browserWindow.evaluate((win) => win.setSize(1366, 900));
  return { app, page, browserWindow };
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-ui-audit-"));
  const profile = path.join(temporary, "profile");
  const violations = [];
  const focus = [];
  const responsive = [];
  const errors = [];
  const csvPath = path.join(temporary, "audit-bank.csv");
  fs.writeFileSync(csvPath, "Date;Description;Reference;Amount;Currency\n2026-08-28;Audit visuel;WHEAT-AUDIT;-12,50;MAD\n");

  const { app, page, browserWindow } = await launch(profile);
  try {
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await page.waitForFunction(() => Boolean(window.atlas), null, { timeout: 15_000 });
    await page.evaluate(async () => {
      await window.atlas.resetWorkspace({ mode: "demo" });
      localStorage.setItem("atlas-ledger-language", "fr");
    });
    await page.reload();
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 20_000 });

    for (const theme of ["light", "dark"]) {
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      if ((theme === "dark") !== isDark) await page.getByRole("button", { name: "Changer le theme", exact: true }).click();
      for (const route of routes) {
        await page.getByRole("button", { name: route, exact: true }).click();
        await page.waitForTimeout(650);
        violations.push(...await axeAudit(page, `surface:${theme}:${route}`));
      }
    }

    if (await page.evaluate(() => document.documentElement.classList.contains("dark"))) await page.getByRole("button", { name: "Changer le theme", exact: true }).click();
    for (const targetWidth of targetWidths) {
      for (const route of responsiveRoutes) {
        await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1));
        await browserWindow.evaluate((win) => win.setSize(1366, 900));
        await page.getByRole("button", { name: route, exact: true }).click();
        responsive.push(await responsiveAudit(page, browserWindow, route, targetWidth));
        if ([1180, 760, 560].includes(targetWidth)) await screenshot(page, `responsive-${targetWidth}-${route.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      }
    }
    await browserWindow.evaluate((win) => win.webContents.setZoomFactor(1));
    await browserWindow.evaluate((win) => win.setSize(1366, 900));

    await page.getByRole("button", { name: "Accueil", exact: true }).click();
    await page.keyboard.press("Control+K");
    await page.locator(".command-palette").waitFor({ state: "visible" });
    await screenshot(page, "overlay-command-palette-light");
    violations.push(...await axeAudit(page, "overlay:command-palette", "document"));
    focus.push(await dialogFocusAudit(page, ".command-palette", "command-palette"));
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Nouvelle ecriture", exact: true }).click();
    await page.getByRole("dialog", { name: "Nouvelle écriture · Brouillon" }).waitFor({ state: "visible" });
    await screenshot(page, "overlay-entry-modal-light");
    violations.push(...await axeAudit(page, "overlay:entry-modal", "document"));
    focus.push(await dialogFocusAudit(page, ".entry-modal", "entry-modal"));
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Saisie", exact: true }).click();
    await page.locator("tbody tr").first().click({ button: "right" });
    await page.locator(".context-menu").waitFor({ state: "visible" });
    await screenshot(page, "overlay-context-menu-light");
    violations.push(...await axeAudit(page, "overlay:context-menu", "document"));
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Factures & paiements", exact: true }).click();
    const cancelAction = page.getByRole("button", { name: "Annuler", exact: true }).first();
    if (await cancelAction.isVisible().catch(() => false)) {
      await cancelAction.click();
      await page.locator("[role='alertdialog']").waitFor({ state: "visible" });
      await screenshot(page, "overlay-confirm-reason-light");
      violations.push(...await axeAudit(page, "overlay:confirm-reason", "document"));
      focus.push(await dialogFocusAudit(page, "[role='alertdialog']", "confirm-reason"));
      await page.keyboard.press("Escape");
    }

    await page.getByRole("button", { name: "Banque", exact: true }).click();
    const bankSelect = page.locator(".op-field--bank select");
    if (await bankSelect.locator("option").count() > 1) await bankSelect.selectOption(await bankSelect.locator("option").nth(1).getAttribute("value"));
    await app.evaluate(({ dialog }, selectedPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] }); }, csvPath);
    await page.getByRole("button", { name: "Importer un relevé" }).click();
    await page.getByRole("dialog", { name: "Contrôler le relevé bancaire" }).waitFor({ state: "visible", timeout: 15_000 });
    await screenshot(page, "overlay-bank-import-light");
    violations.push(...await axeAudit(page, "overlay:bank-import", "document"));
    focus.push(await dialogFocusAudit(page, ".bank-import-modal", "bank-import"));
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Reglages", exact: true }).click();
    await page.getByRole("button", { name: "Lire la licence complète" }).click();
    await page.locator(".license-modal").waitFor({ state: "visible" });
    await screenshot(page, "overlay-license-light");
    violations.push(...await axeAudit(page, "overlay:license", "document"));
    focus.push(await dialogFocusAudit(page, ".license-modal", "license"));
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Vérifier les mises à jour" }).click();
    await page.locator(".toast").waitFor({ state: "visible", timeout: 15_000 });
    await screenshot(page, "overlay-toast-light");
    violations.push(...await axeAudit(page, "overlay:toast", "document"));

    await page.evaluate(async () => {
      await window.atlas.setupLocalLock({ newPin: "123456", idleMinutes: 15, lockOnStartup: true });
      await window.atlas.lockLocalApp();
    });
    await page.reload();
    await page.locator(".local-lock-shell").waitFor({ state: "visible", timeout: 15_000 });
    await injectAxe(page);
    await screenshot(page, "pre-shell-pin-lock-light");
    violations.push(...await axeAudit(page, "pre-shell:pin-lock-light", "document"));
    await page.getByLabel("Code PIN").fill("123456");
    await page.getByRole("button", { name: "Déverrouiller" }).click();
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("button", { name: "Changer le theme", exact: true }).click();
    await page.getByRole("button", { name: "Reglages", exact: true }).click();
    await page.getByRole("button", { name: "Verrouiller maintenant" }).click();
    await page.locator(".local-lock-shell").waitFor({ state: "visible" });
    await screenshot(page, "pre-shell-pin-lock-dark");
    await page.getByLabel("Code PIN").fill("123456");
    await page.getByRole("button", { name: "Déverrouiller" }).click();
    await page.locator(".app-shell").waitFor({ state: "visible" });

    await page.evaluate(() => localStorage.setItem("atlas-ledger-language", "ar"));
    await page.reload();
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 15_000 });
    await screenshot(page, "rtl-shell-light");
    const rtlMetrics = await page.evaluate(() => ({
      dir: document.documentElement.dir,
      lang: document.documentElement.lang,
      rootOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      sidebar: document.querySelector(".sidebar")?.getBoundingClientRect().toJSON(),
      workspace: document.querySelector(".workspace")?.getBoundingClientRect().toJSON(),
    }));
    violations.push(...await axeAudit(page, "rtl:home", "document"));

    fs.writeFileSync(path.join(output, "ui-audit.json"), JSON.stringify({ violations, focus, responsive, rtlMetrics, errors }, null, 2));
  } finally {
    await app.close();
  }

  const recoveryProfile = path.join(temporary, "recovery-profile");
  fs.mkdirSync(recoveryProfile, { recursive: true });
  fs.writeFileSync(path.join(recoveryProfile, "atlas-ledger.sqlite"), "not a sqlite database and never demo data");
  const recovery = await launch(recoveryProfile);
  try {
    await recovery.page.locator(".recovery-shell").waitFor({ state: "visible", timeout: 15_000 });
    await screenshot(recovery.page, "pre-shell-recovery-light");
    await recovery.page.evaluate(() => document.documentElement.classList.add("dark"));
    await screenshot(recovery.page, "pre-shell-recovery-dark");
  } finally { await recovery.app.close(); }

  const updateProfile = path.join(temporary, "update-profile");
  const updaterDirectory = path.join(updateProfile, "updater");
  fs.mkdirSync(updaterDirectory, { recursive: true });
  fs.writeFileSync(path.join(updaterDirectory, "state.json"), JSON.stringify({
    schemaVersion: 1,
    status: { phase: "updated", source: "local", currentVersion: "1.0.0", automaticInstallationEnabled: false, message: "Updated to 1.0.0" },
    lastSuccessfullyInstalledVersion: "1.0.0",
    notification: { version: "1.0.0", releaseDate: "2026-08-28", notes: ["Wheat 1.0.0"], installedAt: "2026-08-28T00:00:00.000Z", consumed: false },
  }));
  const updated = await launch(updateProfile);
  try {
    await updated.page.getByRole("dialog", { name: "Wheat a été mis à jour" }).waitFor({ state: "visible", timeout: 20_000 });
    await screenshot(updated.page, "overlay-update-success-light");
    await updated.page.evaluate(() => document.documentElement.classList.add("dark"));
    await screenshot(updated.page, "overlay-update-success-dark");
  } finally { await updated.app.close(); }

  fs.rmSync(temporary, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

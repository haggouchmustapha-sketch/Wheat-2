const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("@playwright/test");

const root = path.resolve(__dirname, "..", "..", "..");
const output = __dirname;
const routes = [
  "Accueil",
  "Production",
  "Tableau",
  "Societes",
  "Saisie",
  "Documents",
  "Factures & paiements",
  "Banque",
  "TVA",
  "Paie",
  "Rapports",
  "Livres fiables",
  "Liasse fiscale",
  "Wheat 1.0.0",
  "Atlas AI",
  "Export Sage",
  "Analyse locale",
  "Reglages",
];

const slugs = [
  "accueil", "production", "tableau", "societes", "saisie", "documents",
  "factures-paiements", "banque", "tva", "paie", "rapports", "livres-fiables",
  "liasse-fiscale", "atlas-2-1", "atlas-ai", "export-sage", "analyse-locale", "reglages",
];

async function capture(page, name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}

async function surfaceMetrics(page, route, theme) {
  return page.evaluate(({ routeName, themeName }) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const text = (element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const overflow = Array.from(document.querySelectorAll(".page *"))
      .filter(visible)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < -1 || rect.right > window.innerWidth + 1)
      .slice(0, 10)
      .map(({ element, rect }) => ({
        selector: `${element.tagName.toLowerCase()}${element.classList.length ? `.${Array.from(element.classList).slice(0, 2).join(".")}` : ""}`,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      }));
    const whiteSurfaces = themeName === "dark" ? Array.from(document.querySelectorAll(".page *"))
      .filter(visible)
      .filter((element) => ["rgb(255, 255, 255)", "rgba(255, 255, 255, 1)"].includes(getComputedStyle(element).backgroundColor))
      .slice(0, 10)
      .map((element) => `${element.tagName.toLowerCase()}${element.classList.length ? `.${Array.from(element.classList).slice(0, 2).join(".")}` : ""}`) : [];
    const primary = Array.from(document.querySelectorAll("button.primary-button, button.atlas21-primary, button.op-button--primary, button.books13-button--primary"))
      .filter(visible)
      .map(text)
      .filter(Boolean);
    const headings = Array.from(document.querySelectorAll(".page h1, .page h2"))
      .filter(visible)
      .map((element) => ({ level: element.tagName.toLowerCase(), text: text(element) }));
    return {
      route: routeName,
      theme: themeName,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      headings,
      primary,
      overflow,
      whiteSurfaces,
      pageScroll: {
        clientWidth: document.querySelector(".page")?.clientWidth,
        scrollWidth: document.querySelector(".page")?.scrollWidth,
      },
    };
  }, { routeName: route, themeName: theme });
}

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "wheat-visual-audit-"));
  const errors = [];
  const results = [];
  const app = await electron.launch({
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root],
    cwd: root,
    env: { ...process.env, ATLAS_LEDGER_USER_DATA_DIR: path.join(temporary, "userData") },
  });
  try {
    const page = await app.firstWindow();
    const browserWindow = await app.browserWindow(page);
    await browserWindow.evaluate((win) => win.setSize(1366, 900));
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

    if (await page.locator(".loading-shell").isVisible().catch(() => false)) await capture(page, "00-loading-light");
    await page.locator(".onboarding-shell").waitFor({ state: "visible", timeout: 20_000 });
    await capture(page, "00-onboarding-light");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await capture(page, "00-onboarding-dark");
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.evaluate(async () => {
      await window.atlas.resetWorkspace({ mode: "demo" });
      window.localStorage.setItem("atlas-ledger-language", "fr");
    });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.atlas), null, { timeout: 15_000 });
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 20_000 });

    for (const theme of ["light", "dark"]) {
      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      if ((theme === "dark") !== isDark) {
        await page.getByRole("button", { name: "Changer le theme", exact: true }).click();
        await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, theme === "dark");
      }
      for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        await page.getByRole("button", { name: route, exact: true }).click();
        await page.locator(".page").waitFor({ state: "visible", timeout: 15_000 });
        await page.waitForTimeout(route === "Tableau" || route === "Atlas AI" ? 900 : 300);
        const prefix = String(index + 1).padStart(2, "0");
        await capture(page, `${prefix}-${slugs[index]}-${theme}`);
        results.push(await surfaceMetrics(page, route, theme));
      }
    }

    await page.getByRole("button", { name: "Tableau", exact: true }).click();
    await page.waitForTimeout(1000);
    const runtime = await page.evaluate(() => ({
      cssTokens: {
        chart1: getComputedStyle(document.documentElement).getPropertyValue("--chart-1").trim(),
        red: getComputedStyle(document.documentElement).getPropertyValue("--red").trim(),
        brandFont: getComputedStyle(document.documentElement).getPropertyValue("--font-brand").trim(),
      },
      chartPaint: Array.from(document.querySelectorAll(".recharts-wrapper path, .recharts-wrapper sector"))
        .slice(0, 12)
        .map((element) => ({
          fill: element.getAttribute("fill"),
          stroke: element.getAttribute("stroke"),
          computedFill: getComputedStyle(element).fill,
          computedStroke: getComputedStyle(element).stroke,
        })),
      wordmarkFont: getComputedStyle(document.querySelector(".wheat-wordmark")).fontFamily,
      sidebarLogos: Array.from(document.querySelectorAll(".sidebar .wheat-mark img")).map((image) => ({
        src: image.getAttribute("src"),
        opacity: getComputedStyle(image).opacity,
      })),
      direction: document.documentElement.dir,
    }));

    fs.writeFileSync(path.join(output, "audit.json"), JSON.stringify({ results, runtime, errors }, null, 2));
  } finally {
    await app.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

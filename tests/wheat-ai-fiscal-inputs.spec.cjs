const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chooseOption } = require("./wheat-ui-helpers.cjs");

async function launchIsolatedAtlas() {
  const root = process.env.ATLAS_LEDGER_CWD ?? path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-ai-fiscal-inputs-"));
  const app = await electron.launch({
    executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root],
    cwd: root,
    env: { ...process.env, ATLAS_LEDGER_USER_DATA_DIR: path.join(temporary, "profile") },
  });
  return { app, temporary };
}

async function createCompanyWithKeyboard(page, name) {
  await expect(page.locator(".onboarding-shell")).toBeVisible({ timeout: 15000 });
  const form = page.locator(".onboarding-form");
  await form.locator("#onboarding-name").click();
  await page.keyboard.type(name);
  await form.locator("#onboarding-city").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Rabat");
  await form.locator("#onboarding-ice").click();
  await page.keyboard.type("003333333333333");
  await form.locator("#onboarding-tax").click();
  await page.keyboard.type("IF 333333");
  // Forme juridique and Déclaration de TVA are Wheat searchable comboboxes.
  await form.getByRole("combobox", { name: "Forme juridique" }).click();
  await page.getByRole("option", { name: /^SAS/ }).click();
  await form.getByRole("combobox", { name: "Déclaration de TVA" }).click();
  await page.getByRole("option", { name: /Trimestrielle/ }).click();
  await expect(form.locator("#onboarding-name")).toHaveValue(name);
  await expect(form.locator("#onboarding-city")).toHaveValue("Rabat");
  await expect(form.getByRole("combobox", { name: "Forme juridique" })).toContainText("SAS");
  await form.getByRole("button", { name: /Créer mon dossier comptable/ }).click();
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
}

test("one font, company inputs, fiscal package and Wheat AI model input remain usable", async () => {
  test.setTimeout(180000);
  const { app, temporary } = await launchIsolatedAtlas();
  const rendererErrors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (entry) => { if (entry.type() === "error") rendererErrors.push(entry.text()); });
    await page.waitForFunction(() => Boolean(window.atlas), null, { timeout: 15000 });
    await createCompanyWithKeyboard(page, "INPUT RELIABILITY SAS");

    const fonts = await page.locator("body *").evaluateAll((elements) => [...new Set(elements.filter((element) => element.getClientRects().length > 0).map((element) => getComputedStyle(element).fontFamily))]);
    expect(fonts).toEqual(["Inter", 'Georgia, "Times New Roman", "Noto Serif", serif']);

    await page.getByRole("button", { name: "Nouvelle societe" }).click();
    const companyDialog = page.getByRole("dialog", { name: "Créer une société" });
    await companyDialog.getByLabel("Nom de la société").click();
    await page.keyboard.type("SECOND COMPANY SARL");
    await companyDialog.getByLabel("Forme juridique").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("SARL AU");
    await chooseOption(page, companyDialog.getByRole("combobox", { name: "Exercice comptable" }), { index: 2 });
    await chooseOption(page, companyDialog.getByRole("combobox", { name: "Périodicité de la TVA" }), { value: "QUARTERLY" });
    await expect(companyDialog.getByLabel("Nom de la société")).toHaveValue("SECOND COMPANY SARL");
    await expect(companyDialog.getByLabel("Forme juridique")).toHaveValue("SARL AU");
    await page.keyboard.press("Escape");
    await expect(companyDialog).toHaveCount(0);

    await page.locator(".wt-rail").getByRole("button", { name: "Liasse fiscale", exact: true }).click();
    await expect(page.getByRole("heading", { name: "25 tableaux traçables" })).toBeVisible();
    await chooseOption(page, page.getByRole("combobox", { name: "Régime fiscal" }), { value: "SIMPLIFIED" });
    await page.getByRole("button", { name: "Préparer la liasse fiscale" }).click();
    await expect(page.getByText("Résultat fiscal calculé")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Libellé de l'ajustement").click();
    await page.keyboard.type("Charge à vérifier");
    await page.getByLabel("Montant de l'ajustement").click();
    await page.keyboard.type("125,50");
    await page.getByLabel("Référence légale").click();
    await page.keyboard.type("Référence de test à valider");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Ajouter au brouillon" }).click();
    await expect(page.getByRole("cell", { name: "Charge à vérifier" })).toBeVisible({ timeout: 15000 });
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Vérifier" }).click();
    await expect(page.locator(".fiscal-ws-adjustment-verified")).toContainText("Vérifié");

    await page.getByRole("button", { name: "Wheat AI" }).click();
    const modelPicker = page.getByLabel("Modèle Wheat AI");
    await expect(modelPicker).toBeVisible({ timeout: 20000 });
    const optionValues = await modelPicker.locator("option").evaluateAll((options) => options.map((option) => option.value));
    const ollamaModelId = optionValues.find((value) => value.startsWith("ollama:"));
    expect(ollamaModelId).toBeTruthy();
    await chooseOption(page, modelPicker, { value: ollamaModelId });
    const prompt = page.getByLabel("Message Wheat AI");
    await prompt.click();
    await page.keyboard.type("Explique la différence entre balance et bilan.");
    await expect(prompt).toHaveValue("Explique la différence entre balance et bilan.");
    await expect(page.getByRole("button", { name: "Envoyer" })).toBeEnabled();
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Wheat AI completes a real local Ollama response and exposes only final content", async () => {
  test.skip(process.env.ATLAS_OLLAMA_LIVE_TEST !== "1", "Set ATLAS_OLLAMA_LIVE_TEST=1 to exercise an installed Ollama model.");
  test.setTimeout(10 * 60 * 1000);
  const { app, temporary } = await launchIsolatedAtlas();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.atlas), null, { timeout: 15000 });
    await createCompanyWithKeyboard(page, "OLLAMA LIVE TEST SARL");
    const result = await page.evaluate(async () => {
      const api = window.atlas;
      const companyId = (await api.getBootstrap()).companies[0].id;
      const status = await api.getWheatAiStatus({ companyId });
      const model = status.models.find((item) => item.id === "ollama:qwen3.5:9b-q8_0") ?? status.models.find((item) => item.provider === "OLLAMA");
      if (!model) throw new Error("No Ollama model was discovered.");
      await api.selectWheatAiModel({ companyId, modelId: model.id });
      const chat = await api.chatWithWheatAi({ companyId, modelId: model.id, messages: [{ role: "user", content: "Réponds uniquement par OK." }] });
      return { model, chat };
    });
    expect(result.model.provider).toBe("OLLAMA");
    expect(result.chat).toMatchObject({ local: true, provider: "OLLAMA", modelId: result.model.id });
    expect(result.chat.text.trim().length).toBeGreaterThan(0);
    expect(result.chat.text).not.toMatch(/<think>|<analysis>|Thinking:/i);
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

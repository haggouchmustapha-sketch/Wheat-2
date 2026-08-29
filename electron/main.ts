import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain as electronIpcMain, safeStorage, shell } from "electron";
import { fileURLToPath } from "node:url";
import { disconnectPrisma, ensureDatabaseFile, getPrisma, migrateAndValidateDatabase, resolveDatabasePath, restoreBundledSeed } from "./database";
import { closeSmartOcrWorker, processSmartOcrFiles } from "./smartOcr";
import { getPaddleOcrStatus } from "./paddleOcr";
import {
  createWheatBackup,
  extractWheatBackupToStaging,
  validateWheatSqliteDatabase,
  type WheatBackupFileManifest,
} from "./archive";
import {
  assertManagedFileSetMatchesArchive,
  verifyManagedFileProvenance,
  type ManagedFileProvenanceResult,
} from "./managedFileProvenance";
import { counterpartyIdentityKey, registerSubledgerIpc } from "./subledger";
import { deriveReconciliationState, registerReconciliationIpc } from "./reconciliation";
import { parseBankStatement } from "./bankStatementImporter";
import { registerLocalSecurityIpc, type LocalSecurityService } from "./localSecurity";
import { rollbackDatabaseReplacement, runBestEffortCleanup } from "./databaseRestore";
import { registerReportingIpc } from "./reporting";
import { registerReporting21Ipc } from "./reporting21";
import { registerFiscal21Ipc } from "./fiscal21";
import { registerWheatAiIpc } from "./wheatAi";
import { setWheatAiRemoteProviderService } from "./wheatAi";
import { WheatAiProviderService, registerWheatAiProviderIpc } from "./wheatAiProviderService";
import { registerOperations13Ipc } from "./operations13";
import { registerCompliance14Ipc } from "./compliance14";
import { registerCreditNotes14Ipc } from "./creditNotes14";
import { createEntryCommandService, postDraftEntryInTransaction } from "./entryCommands21";
import { buildDashboardMetrics } from "./dashboard";
import { appendActivityAndAudit } from "./audit13";
import { seedPcgeForCompany } from "./chartOfAccounts21";
import { allocatePieceNumber, previewNextPieceNumber } from "./pieceNumbering21";
import { WHEAT_APP_VERSION } from "../src/appVersion";
import {
  assertTrustedIpcSender,
  installBrowserWindowSecurity,
  prepareRuntimeEnvironment,
  resolveTrustedRendererLocation,
  type TrustedRendererLocation,
} from "./securityBoundary";
import {
  currentPayrollPeriod,
  ENTRY_STATUS,
  madToCents,
  optionalText,
  parseAccountingDate,
  parseIsoDay,
  parsePayrollPeriod,
  provisionalEntryNumber,
  rendererSerialize,
  requireId,
  requireText,
} from "./accounting";
import {
  LocalUpdateProvider,
  UpdateService,
  launchWindowsUpdateHelper,
  resolveLocalUpdateDirectory,
  resolveUpdaterStateDirectory,
  type PersistedUpdateState,
} from "./updater";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const serialize = rendererSerialize;
let startupDatabaseError: Error | null = null;
let localSecurity: LocalSecurityService | null = null;
let subledgerService: ReturnType<typeof registerSubledgerIpc> | null = null;
let entryCommandService: ReturnType<typeof createEntryCommandService> | null = null;
let maintenanceOperation: string | null = null;
let allowSecurityMaintenanceAccess = false;
let trustedActorUserId: string | null = null;
let activeBusinessOperations = 0;
let maintenancePending = false;
let shutdownPending = false;
let internalRestartPending = false;
let mainWindow: BrowserWindow | null = null;
let trustedRendererLocation: TrustedRendererLocation | null = null;
let updateService: UpdateService | null = null;
let wheatAiProviderService: WheatAiProviderService | null = null;
let automaticUpdateCheckStarted = false;
const businessIdleWaiters = new Set<() => void>();
const operationDrainWaiters = new Set<() => void>();

const UNGUARDED_IPC_CHANNELS = new Set([
  "wheat:workspace:reset",
  "wheat:backup:create",
  "wheat:backup:restore",
  "wheat:window:control",
  "wheat:app:restart",
  "wheat:update:status",
  "wheat:update:check",
  "wheat:update:confirm-startup",
  "wheat:update:acknowledge",
]);

const ipcMain = {
  handle(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any) {
    return electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedIpcSender(event, mainWindow, trustedRendererLocation);
      if (UNGUARDED_IPC_CHANNELS.has(channel)) return listener(event, ...args);
      return runBusinessOperation(() => listener(event, ...args));
    });
  },
};

function assertNoMaintenance() {
  if (shutdownPending) {
    throw new Error("Wheat est en cours de fermeture. Aucune nouvelle opération ne peut commencer.");
  }
  if (maintenancePending || maintenanceOperation) {
    throw new Error(`Wheat termine une opération de maintenance${maintenanceOperation ? ` (${maintenanceOperation})` : ""}. Réessayez dans un instant.`);
  }
}

function notifyOperationDrainWaiters() {
  if (activeBusinessOperations > 0 || maintenancePending || maintenanceOperation) return;
  for (const resolve of operationDrainWaiters) resolve();
  operationDrainWaiters.clear();
}

async function waitForOperationsToDrain() {
  if (activeBusinessOperations === 0 && !maintenancePending && !maintenanceOperation) return;
  await new Promise<void>((resolve) => operationDrainWaiters.add(resolve));
}

async function runBusinessOperation<T>(operation: () => Promise<T> | T): Promise<T> {
  assertNoMaintenance();
  activeBusinessOperations += 1;
  try {
    return await operation();
  } finally {
    activeBusinessOperations -= 1;
    if (activeBusinessOperations === 0) {
      for (const resolve of businessIdleWaiters) resolve();
      businessIdleWaiters.clear();
    }
    notifyOperationDrainWaiters();
  }
}

async function runExclusiveMaintenance<T>(label: string, operation: () => Promise<T>): Promise<T> {
  assertNoMaintenance();
  maintenancePending = true;
  if (activeBusinessOperations > 0) {
    await new Promise<void>((resolve) => businessIdleWaiters.add(resolve));
  }
  maintenanceOperation = label;
  try {
    return await operation();
  } finally {
    maintenanceOperation = null;
    maintenancePending = false;
    notifyOperationDrainWaiters();
  }
}

async function withAuthorizedPrisma<T>(operation: (prisma: Awaited<ReturnType<typeof getPrisma>>) => Promise<T>): Promise<T> {
  if (localSecurity) {
    await localSecurity.assertUnlocked();
    await localSecurity.touch();
  }
  return operation(await getPrisma(app));
}

async function getAuthorizedPrisma() {
  return withAuthorizedPrisma(async (prisma) => prisma);
}

async function getTrustedActorUserId() {
  return trustedActorUserId;
}

async function appendTrustedAudit(tx: any, data: {
  companyId: string;
  action: string;
  entity: string;
  entityId?: string | null;
  description: string;
  details?: Record<string, unknown>;
}) {
  await appendActivityAndAudit(tx, {
    companyId: data.companyId,
    actorUserId: trustedActorUserId,
    action: data.action,
    entityType: data.entity,
    entityId: data.entityId ?? null,
    description: data.description,
    payload: data.details ?? {},
  });
}

async function resetLocalSecurityAfterDatabaseReplacement() {
  allowSecurityMaintenanceAccess = true;
  try {
    await localSecurity?.resetAfterDatabaseReplacement();
    const prisma = await getPrisma(app);
    trustedActorUserId = (await prisma.user.findFirst({ select: { id: true } }))?.id ?? null;
  } finally {
    allowSecurityMaintenanceAccess = false;
  }
}

async function reopenDatabaseAndResetSession() {
  ensureDatabaseFile(app);
  await resetLocalSecurityAfterDatabaseReplacement();
  startupDatabaseError = null;
}

function bestEffortRestoreCleanup(description: string, cleanup: () => void) {
  runBestEffortCleanup(cleanup, (error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeMainProcessError(new Error(`Nettoyage différé après restauration (${description}) : ${message}`, { cause: error }));
  });
}

function restoreFailure(
  prefix: string,
  originalError: unknown,
  rollbackError: unknown | null,
  livePath: string,
  previousPath: string,
) {
  const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
  if (!rollbackError) {
    return new Error(`${prefix} La base précédente a été restaurée, validée et rouverte. ${originalMessage}`, { cause: originalError });
  }

  const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
  return new Error(
    `${prefix} Wheat n'a pas pu confirmer le retour à la base précédente. ` +
    `N'écrivez plus de données avant vérification manuelle. Base active : ${livePath}. ` +
    `Copie précédente : ${previousPath}. Erreur initiale : ${originalMessage}. ` +
    `Erreur du retour arrière : ${rollbackMessage}`,
    { cause: new AggregateError([originalError, rollbackError], "Échec de restauration et de retour arrière") },
  );
}

function writeMainProcessError(error: unknown) {
  const message = error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`;
  const targetDir = app.isReady() ? app.getPath("userData") : process.cwd();
  try {
    fs.appendFileSync(path.join(targetDir, "atlas-ledger-main-errors.log"), `[${new Date().toISOString()}]\n${message}\n`);
  } catch {
    // Last-resort guard: never let error logging create a second main-process failure.
  }
  console.error(error);
}

process.on("uncaughtException", (error) => {
  writeMainProcessError(error);
});

process.on("unhandledRejection", (reason) => {
  writeMainProcessError(reason);
});

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);

const starterJournals = [
  { code: "OD", label: "Operations diverses", nextNumber: 1, allowManualPieceOverride: true },
  { code: "BQ", label: "Banque", nextNumber: 1, allowManualPieceOverride: true },
  { code: "VE", label: "Ventes", nextNumber: 1, allowManualPieceOverride: true },
  { code: "AC", label: "Achats", nextNumber: 1, allowManualPieceOverride: true },
  { code: "CA", label: "Caisse", nextNumber: 1, allowManualPieceOverride: true },
  { code: "PA", label: "Paie", nextNumber: 1, allowManualPieceOverride: true },
];

const starterAccounts = [
  { code: "111100", label: "Capital social", classNo: 1, type: "EQUITY" },
  { code: "211100", label: "Frais preliminaires", classNo: 2, type: "ASSET" },
  { code: "233200", label: "Materiel de transport", classNo: 2, type: "ASSET" },
  { code: "342100", label: "Clients", classNo: 3, type: "ASSET" },
  { code: "345510", label: "TVA recuperable sur immobilisations", classNo: 3, type: "ASSET" },
  { code: "345520", label: "TVA recuperable sur charges", classNo: 3, type: "ASSET" },
  { code: "441100", label: "Fournisseurs", classNo: 4, type: "LIABILITY" },
  { code: "445500", label: "Etat - TVA facturee", classNo: 4, type: "LIABILITY" },
  { code: "445660", label: "Etat - TVA due", classNo: 4, type: "LIABILITY" },
  { code: "514100", label: "Banques", classNo: 5, type: "ASSET" },
  { code: "516100", label: "Caisses", classNo: 5, type: "ASSET" },
  { code: "611100", label: "Achats de marchandises", classNo: 6, type: "EXPENSE" },
  { code: "612500", label: "Achats non stockes", classNo: 6, type: "EXPENSE" },
  { code: "614100", label: "Locations et charges locatives", classNo: 6, type: "EXPENSE" },
  { code: "617100", label: "Remunerations du personnel", classNo: 6, type: "EXPENSE" },
  { code: "711100", label: "Ventes de marchandises", classNo: 7, type: "REVENUE" },
  { code: "712400", label: "Prestations de services", classNo: 7, type: "REVENUE" },
];

async function clearWorkspace(prisma: Awaited<ReturnType<typeof getPrisma>>) {
  await prisma.$transaction(async (tx) => {
    // Immutable invoice artifacts intentionally reject ordinary deletion. An
    // explicit, backed-up workspace reset is the sole maintenance path that
    // temporarily removes these triggers; the surrounding SQLite transaction
    // guarantees they return even if any later delete fails.
    await tx.$executeRawUnsafe('DROP TRIGGER IF EXISTS "InvoiceArtifact_immutable_update"');
    await tx.$executeRawUnsafe('DROP TRIGGER IF EXISTS "InvoiceArtifact_immutable_delete"');

    await tx.vatWorkpaperEvidence.deleteMany();
    await tx.vatWorkpaperAdjustment.deleteMany();
    await tx.vatWorkpaperLine.deleteMany();
    await tx.vatWorkpaper.updateMany({ data: { supersedesWorkpaperId: null } });
    await tx.vatWorkpaper.deleteMany();
    await tx.invoiceArtifact.updateMany({ data: { supersedesArtifactId: null } });
    await tx.invoiceArtifact.deleteMany();
    await tx.fiscalYear.updateMany({ data: { closeRunId: null } });
    await tx.fiscalCloseRun.deleteMany();
    await tx.auditSeal.deleteMany();
    await tx.auditEvent.deleteMany();
    await tx.auditChain.deleteMany();
    await tx.atlasAiAuditEvent.deleteMany();
    await tx.atlasKnowledgePattern.deleteMany();
    await tx.atlasAiSettings.deleteMany();
    await tx.fiscalTableEvidence.deleteMany();
    await tx.fiscalTableWorkpaper.deleteMany();
    await tx.fiscalAdjustment.deleteMany();
    await tx.fiscalPackage.deleteMany();
    await tx.reportConfiguration.deleteMany();
    await tx.openingBalanceLine.deleteMany();
    await tx.openingBalanceRun.deleteMany();
    await tx.journalPieceSequence.deleteMany();
    await tx.activityLog.deleteMany();
    await tx.ledgerImportRow.deleteMany();
    await tx.ledgerImportBatch.deleteMany();
    await tx.bankImportProfile.deleteMany();
    await tx.companyUser.deleteMany();
    await tx.user.deleteMany();
    await tx.employee.deleteMany();
    await tx.taxPeriod.deleteMany();
    await tx.bankReconciliationPaymentEvidence.deleteMany();
    await tx.bankReconciliationAllocation.deleteMany();
    await tx.bankReconciliation.deleteMany();
    await tx.paymentAllocation.deleteMany();
    await tx.document.deleteMany();
    await tx.payment.deleteMany();
    await tx.invoiceLine.updateMany({ data: { creditedInvoiceLineId: null } });
    await tx.invoiceLine.deleteMany();
    await tx.invoice.updateMany({ data: { creditedInvoiceId: null, taxConfigurationVersionId: null } });
    await tx.invoice.deleteMany();
    await tx.taxRateDefinition.deleteMany();
    await tx.taxConfigurationVersion.deleteMany();
    await tx.invoiceSequence.deleteMany();
    await tx.bankMovement.deleteMany();
    await tx.bankStatementImport.deleteMany();
    await tx.bankAccount.deleteMany();
    await tx.payrollRun.deleteMany();
    await tx.entry.updateMany({ data: { reversalOfId: null } });
    await tx.entryLine.deleteMany();
    await tx.entry.deleteMany();
    await tx.counterparty.deleteMany();
    await tx.journal.deleteMany();
    await tx.account.deleteMany();
    await tx.fiscalYear.deleteMany();
    await tx.company.deleteMany();

    await tx.$executeRawUnsafe(`CREATE TRIGGER "InvoiceArtifact_immutable_update"
      BEFORE UPDATE ON "InvoiceArtifact"
      WHEN OLD."immutable" = true
      BEGIN
        SELECT RAISE(ABORT, 'Immutable invoice artifacts cannot be updated; append a revision instead.');
      END`);
    await tx.$executeRawUnsafe(`CREATE TRIGGER "InvoiceArtifact_immutable_delete"
      BEFORE DELETE ON "InvoiceArtifact"
      WHEN OLD."immutable" = true
      BEGIN
        SELECT RAISE(ABORT, 'Immutable invoice artifacts cannot be deleted.');
      END`);
  }, { timeout: 60_000 });
}

async function ensureDefaultUser(prisma: Awaited<ReturnType<typeof getPrisma>>) {
  const user = await prisma.user.upsert({
    where: { email: "admin@atlasledger.local" },
    create: { name: "Administrateur local", email: "admin@atlasledger.local", role: "ADMIN", twoFactorOn: false },
    update: {},
  });
  trustedActorUserId = user.id;
  return user;
}

type StarterCompanyInput = {
  name: string;
  legalForm?: string;
  ice?: string;
  taxId?: string;
  city?: string;
  fiscalYearStart?: string;
  fiscalYearEnd?: string;
  vatFrequency?: "MONTHLY" | "QUARTERLY";
};

function starterPeriod(input: StarterCompanyInput) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const startsOn = input.fiscalYearStart ? parseIsoDay(input.fiscalYearStart, "La date de début d'exercice") : d(`${year}-01-01`);
  const endsOn = input.fiscalYearEnd ? parseIsoDay(input.fiscalYearEnd, "La date de fin d'exercice") : d(`${year}-12-31`);
  if (startsOn > endsOn) throw new Error("La fin de l'exercice doit être postérieure à son début.");

  const vatFrequency = input.vatFrequency ?? "MONTHLY";
  if (!(["MONTHLY", "QUARTERLY"] as const).includes(vatFrequency)) {
    throw new Error("La fréquence de TVA doit être mensuelle ou trimestrielle.");
  }
  const reference = now < startsOn ? startsOn : now > endsOn ? endsOn : now;
  const periodEndMonth = vatFrequency === "MONTHLY"
    ? reference.getUTCMonth() + 1
    : Math.min(12, Math.ceil((reference.getUTCMonth() + 1) / 3) * 3);
  const periodEnd = new Date(Date.UTC(reference.getUTCFullYear(), periodEndMonth, 0));
  const declarationDue = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() + 1, 20));
  const periodLabel = vatFrequency === "MONTHLY"
    ? `TVA mensuelle ${reference.getUTCFullYear()}-${String(reference.getUTCMonth() + 1).padStart(2, "0")}`
    : `TVA trimestrielle T${Math.ceil((reference.getUTCMonth() + 1) / 3)} ${reference.getUTCFullYear()}`;

  return { startsOn, endsOn, declarationDue, periodLabel };
}

async function createStarterCompany(prisma: Awaited<ReturnType<typeof getPrisma>>, input: StarterCompanyInput) {
  const user = await ensureDefaultUser(prisma);
  const period = starterPeriod(input);
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: {
      name: input.name.trim(),
      legalForm: input.legalForm?.trim() || "SARL",
      ice: input.ice?.trim() || "",
      taxId: input.taxId?.trim() || "",
      city: input.city?.trim() || "Casablanca",
      vatFrequency: input.vatFrequency ?? "MONTHLY",
      fiscalYears: {
        create: [
          {
            label: `Exercice ${period.startsOn.toISOString().slice(0, 10)} au ${period.endsOn.toISOString().slice(0, 10)}`,
            startsOn: period.startsOn,
            endsOn: period.endsOn,
            status: "OPEN",
          },
        ],
      },
      journals: { create: starterJournals },
      accounts: { create: starterAccounts },
      bankAccounts: {
        create: {
          bankName: "Compte bancaire principal",
          iban: "Renseigner IBAN",
          balanceCents: 0n,
          currency: "MAD",
        },
      },
      taxPeriods: {
        create: {
          label: period.periodLabel,
          collectedVatCents: 0n,
          deductibleVatCents: 0n,
          dueVatCents: 0n,
          creditVatCents: 0n,
          status: "DRAFT",
          declarationDue: period.declarationDue,
        },
      },
        companyUsers: {
          create: { userId: user.id, role: "ADMIN" },
        },
      },
      include: { accounts: true, journals: true, fiscalYears: true, bankAccounts: true },
    });

    await seedPcgeForCompany(tx, company.id);

    const defaultBankLedger = company.accounts.find((account) => account.code === "514100");
    const defaultBankAccount = company.bankAccounts[0];
    if (defaultBankLedger && defaultBankAccount) {
      await tx.bankAccount.update({
        where: { id: defaultBankAccount.id },
        data: { ledgerAccountId: defaultBankLedger.id, balanceSource: "OPENING_BALANCE" },
      });
    }
    await appendActivityAndAudit(tx, {
      companyId: company.id,
      actorUserId: user.id,
      action: "CREATE_COMPANY",
      entityType: "Company",
      entityId: company.id,
      description: "Société créée depuis l'assistant Wheat",
      payload: { name: company.name, legalForm: company.legalForm, fiscalYearStart: period.startsOn, fiscalYearEnd: period.endsOn },
    });
    return tx.company.findUniqueOrThrow({
      where: { id: company.id },
      include: { accounts: true, journals: true, fiscalYears: true, bankAccounts: true },
    });
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindow;
  }

  trustedRendererLocation = resolveTrustedRendererLocation({
    isPackaged: app.isPackaged,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    rendererFilePath: path.join(__dirname, "../dist/index.html"),
  });
  const win = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    title: "Wheat",
    backgroundColor: "#f7f9fc",
    autoHideMenuBar: true,
    icon: path.join(process.cwd(), "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  installBrowserWindowSecurity(win, trustedRendererLocation);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.once("did-finish-load", () => {
    if (!automaticUpdateCheckStarted) {
      automaticUpdateCheckStarted = true;
      setTimeout(() => void checkAndInstallUpdate(true).catch(writeMainProcessError), 1_500);
    }
  });

  if (trustedRendererLocation.mode === "development") {
    void win.loadURL(trustedRendererLocation.url);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  return win;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Wheat is the product name shown everywhere in the interface and to the OS.
 *
 * The on-disk profile directory keeps its historical "Atlas Ledger" name so
 * that installations created before Wheat 2.0 keep their database, backups,
 * managed documents, OCR cache and updater state exactly where they are.
 * The same reasoning applies to the application user-model id, which the
 * Windows installer and existing Start menu shortcuts already reference.
 * Both are storage/OS compatibility aliases: neither ever reaches the UI.
 */
const LEGACY_PROFILE_DIRECTORY_NAME = "Atlas Ledger";
const LEGACY_APP_USER_MODEL_ID = "ma.atlasledger.desktop";

app.setName("Wheat");
app.setAppUserModelId(LEGACY_APP_USER_MODEL_ID);
app.setPath("userData", path.join(app.getPath("appData"), LEGACY_PROFILE_DIRECTORY_NAME));

const explicitDevelopmentProfile = prepareRuntimeEnvironment({ isPackaged: app.isPackaged, env: process.env });
if (explicitDevelopmentProfile) {
  fs.mkdirSync(explicitDevelopmentProfile, { recursive: true });
  app.setPath("userData", explicitDevelopmentProfile);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (app.isReady()) focusMainWindow();
    else void app.whenReady().then(focusMainWindow);
  });
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  try {
    ensureDatabaseFile(app);
    startupDatabaseError = null;
  } catch (error) {
    startupDatabaseError = error instanceof Error ? error : new Error(String(error));
    writeMainProcessError(startupDatabaseError);
  }
  localSecurity = registerLocalSecurityIpc({
    ipcMain,
    getPrisma: () => {
      if (!allowSecurityMaintenanceAccess) assertNoMaintenance();
      return getPrisma(app);
    },
    serialize,
  });
  const updaterStateDirectory = resolveUpdaterStateDirectory(app);
  updateService = new UpdateService({
    currentVersion: WHEAT_APP_VERSION,
    provider: new LocalUpdateProvider(resolveLocalUpdateDirectory(app, path.resolve(__dirname, ".."))),
    stateDirectory: updaterStateDirectory,
    automaticInstallationEnabled: app.isPackaged && process.platform === "win32" && !process.env.PORTABLE_EXECUTABLE_DIR,
    onStatus: (status) => mainWindow?.webContents.send("wheat:update:status", status),
  });
  entryCommandService = createEntryCommandService({ getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId });
  registerIpc();
  subledgerService = registerSubledgerIpc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  registerReconciliationIpc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  registerReportingIpc({ ipcMain, getPrisma: getAuthorizedPrisma, serialize });
  registerReporting21Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, serialize });
  registerFiscal21Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  registerWheatAiIpc({
    ipcMain,
    getPrisma: getAuthorizedPrisma,
    getActorUserId: getTrustedActorUserId,
    manifestPath: app.isPackaged
      ? path.join(process.resourcesPath, "models", "atlas-model-manifest.json")
      : path.resolve(__dirname, "..", "resources", "models", "atlas-model-manifest.json"),
    modelRoot: path.join(app.getPath("userData"), "atlas-ai"),
    appVersion: WHEAT_APP_VERSION,
    send: (channel, payload) => mainWindow?.webContents.send(channel, payload),
    serialize,
  });
  wheatAiProviderService = registerWheatAiProviderIpc({
    ipcMain,
    service: new WheatAiProviderService({
      directory: path.join(app.getPath("userData"), "wheat-ai"),
      safeStorage,
    }),
  });
  setWheatAiRemoteProviderService(wheatAiProviderService);
  registerOperations13Ipc({
    ipcMain,
    getPrisma: getAuthorizedPrisma,
    getActorUserId: getTrustedActorUserId,
    serialize,
    persistImportSource: persistManagedLedgerImportSource,
    readImportSource: (storedPath) => fs.promises.readFile(storedPath),
  });
  registerCreditNotes14Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  registerCompliance14Ipc({ ipcMain, getPrisma: getAuthorizedPrisma, getActorUserId: getTrustedActorUserId, serialize });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", async (event) => {
  if (!hasSingleInstanceLock) return;
  event.preventDefault();
  if (shutdownPending) return;
  shutdownPending = true;
  try {
    await waitForOperationsToDrain();
    await closeSmartOcrWorker();
    await disconnectPrisma();
  } catch (error) {
    writeMainProcessError(error);
  } finally {
    app.exit(0);
  }
});

async function relaunchWheat() {
  if (internalRestartPending) return { restarting: true };
  internalRestartPending = true;
  // Reject new operations while allowing the existing drain predicate to
  // become true. Setting maintenancePending here would deadlock because the
  // drain predicate itself requires maintenancePending to be false.
  shutdownPending = true;
  mainWindow?.webContents.send("wheat:app:will-restart");
  try {
    await waitForOperationsToDrain();
    await closeSmartOcrWorker();
    await disconnectPrisma();
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
    return { restarting: true };
  } catch (error) {
    internalRestartPending = false;
    shutdownPending = false;
    throw error;
  }
}

async function checkAndInstallUpdate(automatic = false) {
  if (!updateService) throw new Error("Wheat updater is not ready.");
  if (automatic && await updateService.hasUnresolvedInstallationFailure()) return updateService.getStatus();
  const state = await updateService.checkForUpdates();
  if (state.status.phase === "ready" && state.status.automaticInstallationEnabled) {
    const installState = await updateService.installStagedUpdate(launchStagedUpdateAndExit);
    return installState.status;
  }
  return state.status;
}

async function launchStagedUpdateAndExit(state: PersistedUpdateState) {
  if (!updateService || !state.pending) throw new Error("No validated update is ready to install.");
  if (internalRestartPending) return;
  internalRestartPending = true;
  shutdownPending = true;
  mainWindow?.webContents.send("wheat:app:will-restart");
  try {
    await waitForOperationsToDrain();
    await closeSmartOcrWorker();
    await disconnectPrisma();
    state.pending.rollbackPath = path.join(resolveUpdaterStateDirectory(app), "rollback", state.pending.previousVersion);
    await updateService.store.write(state);
    launchWindowsUpdateHelper(state, {
      stateDirectory: resolveUpdaterStateDirectory(app),
      helperPath: path.join(process.resourcesPath, "updater", "update-helper.ps1"),
      currentExecutable: process.execPath,
      parentPid: process.pid,
    });
    await updateService.logger.log("restart-requested", { availableVersion: state.pending.release.version });
    app.exit(0);
  } catch (error) {
    internalRestartPending = false;
    shutdownPending = false;
    throw error;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function normalizeSageMappings(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} est invalide.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10_000) throw new Error(`${label} contient trop de codes.`);
  const normalized: Record<string, string> = {};
  for (const [rawSource, rawTarget] of entries) {
    const source = rawSource.trim();
    if (!source || source.length > 30 || /[\r\n;]/.test(source)) throw new Error(`${label} contient un code source invalide.`);
    if (typeof rawTarget !== "string") throw new Error(`${label} contient une cible invalide.`);
    const target = rawTarget.trim();
    if (target.length > 30 || /[\r\n;]/.test(target)) throw new Error(`${label} contient une cible invalide.`);
    normalized[source] = target;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)));
}

function parseStoredSageMappings(value: string) {
  try {
    return normalizeSageMappings(JSON.parse(value), "Le profil Sage enregistré");
  } catch (error) {
    throw new Error(`Le profil Sage enregistré est endommagé. ${error instanceof Error ? error.message : ""}`.trim(), { cause: error });
  }
}

function normalizeSageProfilePayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Le profil Sage est invalide.");
  const input = payload as Record<string, unknown>;
  const outputKind = requireText(input.outputKind, "Le type de fichier Sage", 10);
  if (!new Set(["TXT", "CSV", "PNM"]).has(outputKind)) throw new Error("Le type de fichier Sage est invalide.");
  const encoding = requireText(input.encoding, "L'encodage Sage", 30);
  if (!new Set(["windows-1252", "utf-8"]).has(encoding)) throw new Error("L'encodage Sage est invalide.");
  const accountLength = String(input.accountLength ?? "VARIABLE");
  if (accountLength !== "VARIABLE" && (!/^\d+$/.test(accountLength) || Number(accountLength) < 6 || Number(accountLength) > 13)) {
    throw new Error("La longueur des comptes Sage est invalide.");
  }
  if (typeof input.includeHeader !== "boolean" || typeof input.requireJournalMapping !== "boolean") {
    throw new Error("Les options du profil Sage sont invalides.");
  }

  return {
    companyId: requireId(input.companyId, "La société"),
    profileType: requireText(input.profileType, "Le profil Sage", 120),
    outputKind,
    encoding,
    includeHeader: input.includeHeader,
    accountLength,
    journalMappings: JSON.stringify(normalizeSageMappings(input.journalMappings, "Le mapping des journaux")),
    accountMappings: JSON.stringify(normalizeSageMappings(input.accountMappings, "Le mapping des comptes")),
    requireJournalMapping: input.requireJournalMapping,
  };
}

function registerIpc() {
  ipcMain.handle("wheat:update:status", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    return updateService.getStatus();
  });
  ipcMain.handle("wheat:update:check", async () => checkAndInstallUpdate());
  ipcMain.handle("wheat:update:confirm-startup", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    if (startupDatabaseError) return updateService.getStatus();
    return updateService.confirmSuccessfulStartup();
  });
  ipcMain.handle("wheat:update:acknowledge", async () => {
    if (!updateService) throw new Error("Wheat updater is not ready.");
    return updateService.acknowledgeInstalledUpdate();
  });

  ipcMain.handle("wheat:bootstrap", async (_event, companyId?: string) => {
    let prisma: Awaited<ReturnType<typeof getPrisma>>;
    try {
      assertNoMaintenance();
      prisma = await getPrisma(app);
      assertNoMaintenance();
      startupDatabaseError = null;
    } catch (error) {
      startupDatabaseError = error instanceof Error ? error : new Error(String(error));
      const databasePath = resolveDatabasePath(app);
      throw new Error(
        `La base locale Wheat n'a pas pu être ouverte. Base concernée : ${databasePath}. ${startupDatabaseError.message}`,
        { cause: error },
      );
    }
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const user = await prisma.user.findFirst();
    trustedActorUserId = user?.id ?? null;
    const companyIds = await prisma.company.findMany({ select: { id: true } });
    for (const company of companyIds) {
      await prisma.$transaction((tx) => seedPcgeForCompany(tx, company.id), { timeout: 60_000 });
    }
    const companies = await prisma.company.findMany({
      include: {
        fiscalYears: true,
        accounts: { orderBy: { code: "asc" } },
        journals: { orderBy: { code: "asc" } },
        _count: { select: { entries: true, invoices: true, documents: true, employees: true } },
      },
      orderBy: { name: "asc" },
    });

    const activeCompanyId = companyId ?? companies[0]?.id;

    const [entries, invoices, documents, bankAccounts, taxPeriods, employees, activityLogs, ledgerEntryCount, dashboardMetrics] = await Promise.all([
      prisma.entry.findMany({
        where: { companyId: activeCompanyId },
        include: {
          journal: true,
          lines: { include: { account: true }, orderBy: { position: "asc" } },
        },
        orderBy: [{ date: "desc" }, { number: "desc" }],
        take: 500,
      }),
      prisma.invoice.findMany({ where: { companyId: activeCompanyId }, orderBy: { dueDate: "asc" }, take: 500 }),
      prisma.document.findMany({ where: { companyId: activeCompanyId }, orderBy: { createdAt: "desc" }, take: 500 }),
      prisma.bankAccount.findMany({
        where: { companyId: activeCompanyId },
        include: {
          movements: {
            include: {
              reconciliations: {
                where: { status: "ACTIVE" },
                include: { allocations: true },
              },
            },
            orderBy: { date: "desc" },
            take: 500,
          },
        },
        orderBy: { bankName: "asc" },
      }),
      prisma.taxPeriod.findMany({ where: { companyId: activeCompanyId }, orderBy: { declarationDue: "asc" } }),
      prisma.employee.findMany({ where: { companyId: activeCompanyId }, orderBy: { fullName: "asc" } }),
      prisma.activityLog.findMany({ where: { companyId: activeCompanyId }, include: { user: true }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.entry.count({ where: { companyId: activeCompanyId } }),
      buildDashboardMetrics(prisma, activeCompanyId),
    ]);

    return serialize({
      appVersion: WHEAT_APP_VERSION,
      databasePath: resolveDatabasePath(app),
      user,
      companies,
      activeCompanyId,
      entries,
      invoices,
      documents,
      bankAccounts: bankAccounts.map((bankAccount) => ({
        ...bankAccount,
        movements: bankAccount.movements.map((movement) => {
          const allocatedCents = movement.reconciliations.reduce(
            (sum, reconciliation) => sum + reconciliation.allocations.reduce((batch, allocation) => batch + allocation.amountCents, 0n),
            0n,
          );
          const reconciliation = deriveReconciliationState({
            amountCents: movement.amountCents,
            allocatedCents,
            excludedAt: movement.excludedAt,
            legacyMatchClaimed: movement.legacyMatchClaimed,
          });
          return {
            ...movement,
            reconciliationStatus: reconciliation.status,
            allocatedCents: reconciliation.allocatedCents,
            remainingCents: reconciliation.remainingCents,
            status: reconciliation.status === "RECONCILED" ? "MATCHED" : reconciliation.status,
          };
        }),
      })),
      taxPeriods,
      employees,
      activityLogs,
      dashboardMetrics,
      ledgerSummary: { totalEntries: ledgerEntryCount, displayedEntries: entries.length },
      workspaceLimits: { entries: 500, invoices: 500, documents: 500, bankMovementsPerAccount: 500 },
    });
  });

  ipcMain.handle("wheat:entry:sage-export-set", async (_event, rawCompanyId: unknown) => {
    const companyId = requireId(rawCompanyId, "La société");
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new Error("La société sélectionnée n'existe plus.");
    const entries = await prisma.entry.findMany({
      where: { companyId, status: { in: [ENTRY_STATUS.posted, ENTRY_STATUS.reversed] } },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select: {
        id: true,
        number: true,
        date: true,
        pieceNumber: true,
        label: true,
        status: true,
        journalCodeSnapshot: true,
        lines: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            position: true,
            accountCodeSnapshot: true,
            label: true,
            debitCents: true,
            creditCents: true,
            thirdParty: true,
          },
        },
      },
    });
    return serialize(entries.map((entry) => ({
      ...entry,
      journal: { code: entry.journalCodeSnapshot },
      lines: entry.lines.map((line) => ({
        ...line,
        account: { code: line.accountCodeSnapshot },
      })),
    })));
  });

  ipcMain.handle("wheat:sage-profile:get", async (_event, rawCompanyId: unknown) => {
    const companyId = requireId(rawCompanyId, "La société");
    const prisma = await getAuthorizedPrisma();
    const profile = await prisma.sageExportProfile.findUnique({ where: { companyId } });
    if (!profile) return null;
    return serialize({
      ...profile,
      journalMappings: parseStoredSageMappings(profile.journalMappings),
      accountMappings: parseStoredSageMappings(profile.accountMappings),
    });
  });

  ipcMain.handle("wheat:sage-profile:save", async (_event, payload: unknown) => {
    const input = normalizeSageProfilePayload(payload);
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUnique({ where: { id: input.companyId }, select: { id: true } });
    if (!company) throw new Error("La société sélectionnée n'existe plus.");

    const saved = await prisma.$transaction(async (tx) => {
      const profile = await tx.sageExportProfile.upsert({
        where: { companyId: input.companyId },
        create: input,
        update: {
          profileType: input.profileType,
          outputKind: input.outputKind,
          encoding: input.encoding,
          includeHeader: input.includeHeader,
          accountLength: input.accountLength,
          journalMappings: input.journalMappings,
          accountMappings: input.accountMappings,
          requireJournalMapping: input.requireJournalMapping,
          version: { increment: 1 },
        },
      });
      await appendActivityAndAudit(tx, {
        companyId: input.companyId,
        actorUserId: trustedActorUserId,
        action: "SAVE_SAGE_EXPORT_PROFILE",
        entityType: "SageExportProfile",
        entityId: profile.id,
        description: "Profil d'export Sage enregistré",
        payload: { outputKind: profile.outputKind, encoding: profile.encoding, accountLength: profile.accountLength, version: profile.version },
      });
      return profile;
    });

    return serialize({
      ...saved,
      journalMappings: parseStoredSageMappings(saved.journalMappings),
      accountMappings: parseStoredSageMappings(saved.accountMappings),
    });
  });

  ipcMain.handle("wheat:user:update", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données utilisateur sont invalides.");
    const name = requireText((payload as Record<string, unknown>).name, "Le nom utilisateur", 80);

    const prisma = await getAuthorizedPrisma();
    const user = await prisma.user.findFirst() ?? await ensureDefaultUser(prisma);
    trustedActorUserId = user.id;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.user.update({ where: { id: user.id }, data: { name } });
      const memberships = await tx.companyUser.findMany({ where: { userId: user.id }, select: { companyId: true } });
      for (const membership of memberships) {
        await appendActivityAndAudit(tx, {
          companyId: membership.companyId,
          actorUserId: user.id,
          action: "UPDATE_LOCAL_USER_NAME",
          entityType: "User",
          entityId: user.id,
          description: "Nom du profil local modifié",
          payload: { previousName: user.name, name },
        });
      }
      return result;
    });

    return serialize(updated);
  });

  ipcMain.handle("wheat:company:create", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données de la société sont invalides.");
    const input = payload as Record<string, unknown>;
    const name = requireText(input.name, "Le nom de la société", 160);
    const legalForm = optionalText(input.legalForm, 60) ?? undefined;
    const ice = optionalText(input.ice, 30) ?? undefined;
    const taxId = optionalText(input.taxId, 40) ?? undefined;
    const city = optionalText(input.city, 100) ?? undefined;
    const fiscalYearStart = optionalText(input.fiscalYearStart, 10) ?? undefined;
    const fiscalYearEnd = optionalText(input.fiscalYearEnd, 10) ?? undefined;
    const vatFrequency = input.vatFrequency ?? "MONTHLY";
    if (vatFrequency !== "MONTHLY" && vatFrequency !== "QUARTERLY") throw new Error("La fréquence de TVA doit être mensuelle ou trimestrielle.");

    const prisma = await getAuthorizedPrisma();
    const company = await createStarterCompany(prisma, {
      name,
      legalForm,
      ice,
      taxId,
      city,
      fiscalYearStart,
      fiscalYearEnd,
      vatFrequency,
    });

    return serialize(company);
  });

  ipcMain.handle("wheat:company:delete", async (_event, companyId: string) => {
    const id = requireId(companyId, "La société");
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            entries: { where: { status: { not: ENTRY_STATUS.draft } } },
            documents: true,
            invoices: true,
            payments: true,
            ledgerImportBatches: true,
          },
        },
      },
    });
    if (!company) throw new Error("La société à supprimer n'existe plus.");
    if (company._count.entries > 0) {
      throw new Error("Cette société contient des écritures comptabilisées. Elle ne peut pas être supprimée ; créez une sauvegarde puis conservez-la comme archive.");
    }
    if (company._count.documents > 0) {
      throw new Error("Cette société contient encore des documents. Supprimez-les explicitement depuis le classement OCR avant de supprimer la société.");
    }
    if (company._count.invoices > 0 || company._count.payments > 0) {
      throw new Error("Cette société contient un historique de factures ou de paiements. Wheat le conserve pour l'audit ; seule la réinitialisation explicite de tout l'espace peut l'effacer.");
    }
    if (company._count.ledgerImportBatches > 0) {
      throw new Error("Cette société contient des sources d'import comptable conservées comme preuve. Utilisez une réinitialisation explicite de l'espace après sauvegarde complète.");
    }
    const bankMovementCount = await prisma.bankMovement.count({ where: { bankAccount: { companyId: id } } });
    if (bankMovementCount > 0) {
      throw new Error("Cette société contient un relevé bancaire importé. Excluez ou archivez les mouvements au lieu de supprimer leur historique.");
    }

    await prisma.company.delete({ where: { id } });

    return serialize({ ok: true, id, name: company.name });
  });

  ipcMain.handle("wheat:bank:account:set-ledger", async (_event, payload: { companyId?: unknown; bankAccountId?: unknown; ledgerAccountId?: unknown }) => {
    const prisma = await getAuthorizedPrisma();
    const companyId = requireId(payload?.companyId, "La société");
    const bankAccountId = requireId(payload?.bankAccountId, "Le compte bancaire");
    const ledgerAccountId = requireId(payload?.ledgerAccountId, "Le compte comptable bancaire");

    return prisma.$transaction(async (tx) => {
      const [bankAccount, ledgerAccount] = await Promise.all([
        tx.bankAccount.findUnique({ where: { id: bankAccountId } }),
        tx.account.findUnique({ where: { id: ledgerAccountId } }),
      ]);
      if (!bankAccount || bankAccount.companyId !== companyId) throw new Error("Le compte bancaire n'appartient pas à cette société.");
      if (!ledgerAccount || ledgerAccount.companyId !== companyId || !ledgerAccount.active || !ledgerAccount.code.startsWith("514")) {
        throw new Error("Sélectionnez un compte bancaire actif de la classe 514 dans cette société.");
      }
      if (bankAccount.ledgerAccountId === ledgerAccountId) {
        return serialize(await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId }, include: { ledgerAccount: true } }));
      }
      const alreadyMapped = await tx.bankAccount.findFirst({ where: { ledgerAccountId, NOT: { id: bankAccountId } } });
      if (alreadyMapped) throw new Error("Ce compte comptable est déjà associé à un autre compte bancaire.");
      if (bankAccount.ledgerAccountId) {
        const activeReconciliationCount = await tx.bankReconciliation.count({
          where: { status: "ACTIVE", movement: { bankAccountId } },
        });
        if (activeReconciliationCount > 0) {
          throw new Error("Annulez d'abord les rapprochements actifs avant de changer le compte comptable associé.");
        }
      }
      const updated = await tx.bankAccount.update({
        where: { id: bankAccountId },
        data: { ledgerAccountId },
        include: { ledgerAccount: true },
      });
      await appendTrustedAudit(tx, {
        companyId,
        action: "MAP_BANK_LEDGER_ACCOUNT",
        entity: "BankAccount",
        entityId: bankAccountId,
        description: `${bankAccount.bankName} associé au compte ${ledgerAccount.code}`,
        details: { previousLedgerAccountId: bankAccount.ledgerAccountId, ledgerAccountId },
      });
      return serialize(updated);
    });
  });

  ipcMain.handle("wheat:bank:account:create-ledger", async (_event, payload: { companyId?: unknown; bankAccountId?: unknown; code?: unknown; label?: unknown }) => {
    const prisma = await getAuthorizedPrisma();
    const companyId = requireId(payload?.companyId, "La société");
    const bankAccountId = requireId(payload?.bankAccountId, "Le compte bancaire");
    const code = requireText(payload?.code, "Le numéro de compte", 20).replace(/\s+/g, "");
    const label = requireText(payload?.label, "Le libellé du compte", 160);
    if (!/^514\d{3,}$/.test(code)) throw new Error("Utilisez un numéro de compte bancaire commençant par 514 et comportant au moins 6 chiffres.");
    return prisma.$transaction(async (tx) => {
      const bankAccount = await tx.bankAccount.findUnique({ where: { id: bankAccountId } });
      if (!bankAccount || bankAccount.companyId !== companyId) throw new Error("Le compte bancaire n'appartient pas à cette société.");
      if (bankAccount.ledgerAccountId) throw new Error("Ce compte bancaire possède déjà un compte comptable associé.");
      const duplicate = await tx.account.findUnique({ where: { companyId_code: { companyId, code } } });
      if (duplicate) throw new Error("Ce numéro existe déjà dans le plan comptable. Sélectionnez-le dans la liste ou choisissez un autre sous-compte.");
      const account = await tx.account.create({ data: { companyId, code, label, classNo: 5, type: "ASSET", active: true } });
      const updated = await tx.bankAccount.update({ where: { id: bankAccountId }, data: { ledgerAccountId: account.id }, include: { ledgerAccount: true } });
      await appendTrustedAudit(tx, {
        companyId,
        action: "CREATE_AND_MAP_BANK_LEDGER_ACCOUNT",
        entity: "BankAccount",
        entityId: bankAccountId,
        description: `${code} ${label} créé et associé à ${bankAccount.bankName}`,
        details: { ledgerAccountId: account.id, code },
      });
      return serialize(updated);
    });
  });

  ipcMain.handle("wheat:workspace:reset", async (event, payload: { mode: "blank" | "demo" }) => {
    if (!payload || (payload.mode !== "blank" && payload.mode !== "demo")) throw new Error("Le mode de réinitialisation est invalide.");
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const invokingWindow = BrowserWindow.fromWebContents(event.sender);

    try {
      return await runExclusiveMaintenance("réinitialisation de l'espace", async () => {
        if (payload.mode === "demo") {
          const currentPrisma = await getPrisma(app);
          const security = await currentPrisma.localAppSecurity.findUnique({ where: { id: "local" } });
          await disconnectPrisma();
          if (restoreBundledSeed(app)) {
            if (security) {
              const restoredPrisma = await getPrisma(app);
              const securityData = {
                enabled: security.enabled,
                pinSalt: security.pinSalt,
                pinHash: security.pinHash,
                pinKeyLength: security.pinKeyLength,
                idleMinutes: security.idleMinutes,
                lockOnStartup: security.lockOnStartup,
                failedAttempts: security.failedAttempts,
                lockedUntil: security.lockedUntil,
              };
              await restoredPrisma.localAppSecurity.upsert({
                where: { id: "local" },
                create: { id: "local", ...securityData },
                update: securityData,
              });
            }
            startupDatabaseError = null;
            const restoredPrisma = await getPrisma(app);
            trustedActorUserId = (await restoredPrisma.user.findFirst({ select: { id: true } }))?.id ?? null;
            return { ok: true, mode: "demo" };
          }
        }

        const prisma = await getPrisma(app);
        await clearWorkspace(prisma);
        const resetUser = await ensureDefaultUser(prisma);
        trustedActorUserId = resetUser.id;

        if (payload.mode === "demo") {
          await createStarterCompany(prisma, {
            name: "SOCIETE DEMO SARL",
            legalForm: "SARL",
            ice: "001589742000063",
            taxId: "IF 48291073",
            city: "Casablanca",
          });
        }

        return { ok: true, mode: payload.mode };
      });
    } finally {
      if (invokingWindow && !invokingWindow.isDestroyed()) {
        if (invokingWindow.isMinimized()) invokingWindow.restore();
        invokingWindow.show();
        invokingWindow.focus();
      }
    }
  });

  ipcMain.handle("wheat:entry:create", async (_event, payload) => {
    if (!entryCommandService) throw new Error("Le service des écritures n'est pas encore disponible.");
    return serialize(await entryCommandService.createEntry(payload));
  });

  ipcMain.handle("wheat:piece-number:preview", async (_event, payload: Record<string, unknown>) => {
    const prisma = await getAuthorizedPrisma();
    const companyId = requireId(payload?.companyId, "La société");
    const journalId = requireId(payload?.journalId, "Le journal");
    const date = parseAccountingDate(payload?.date, "La date de l'écriture");
    return serialize(await previewNextPieceNumber(prisma, companyId, journalId, date));
  });

  ipcMain.handle("wheat:entry:post", async (_event, entryId: string) => {
    const id = requireId(entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const target = await prisma.entry.findUnique({ where: { id }, select: { companyId: true } });
    if (!target || !entryCommandService) throw new Error("L'écriture demandée n'existe plus.");
    return serialize(await entryCommandService.postEntry({ companyId: target.companyId, entryId: id }));
  });

  ipcMain.handle("wheat:entry:duplicate", async (_event, entryId: string) => {
    const id = requireId(entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const source = await prisma.entry.findUnique({ where: { id }, select: { companyId: true } });
    if (!source || !entryCommandService) throw new Error("L'écriture à dupliquer n'existe plus.");
    const duplicate = await entryCommandService.duplicateEntry({ companyId: source.companyId, entryId: id });
    return serialize({ ok: true, number: duplicate.number, entry: duplicate });
  });

  ipcMain.handle("wheat:entry:reverse", async (_event, entryIdOrPayload: string | { entryId?: string; date?: string }, requestedDate?: string) => {
    const input = typeof entryIdOrPayload === "string" ? { entryId: entryIdOrPayload, date: requestedDate } : entryIdOrPayload;
    const entryId = requireId(input?.entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const source = await prisma.entry.findUnique({ where: { id: entryId }, select: { companyId: true } });
    if (!source || !entryCommandService) throw new Error("L'écriture à extourner n'existe plus.");
    const reversal = await entryCommandService.reverseEntry({ companyId: source.companyId, entryId, date: input?.date });
    return serialize({ ok: true, number: reversal.number, entry: reversal });
  });

  ipcMain.handle("wheat:entry:delete", async (_event, entryId: string) => {
    const id = requireId(entryId, "L'écriture");
    const prisma = await getAuthorizedPrisma();
    const target = await prisma.entry.findUnique({ where: { id }, select: { companyId: true } });
    if (!target || !entryCommandService) throw new Error("L'écriture à supprimer n'existe plus.");
    return serialize(await entryCommandService.deleteDraftEntry({ companyId: target.companyId, entryId: id }));
  });

  ipcMain.handle("wheat:fiscal-period:lock", async (_event, payload: { companyId?: string; fiscalYearId?: string; lockedTo?: string }) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données de verrouillage sont invalides.");
    const companyId = requireId(payload.companyId, "La société");
    const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
    const lockedTo = parseIsoDay(payload.lockedTo, "La date de verrouillage");
    const prisma = await getAuthorizedPrisma();
    const result = await prisma.$transaction(async (tx) => {
      const fiscalYear = await tx.fiscalYear.findUnique({ where: { id: fiscalYearId } });
      if (!fiscalYear || fiscalYear.companyId !== companyId) throw new Error("L'exercice n'appartient pas à la société sélectionnée.");
      if (fiscalYear.status !== "OPEN") throw new Error("Un exercice clôturé ne peut pas être verrouillé ou déverrouillé.");
      if (lockedTo < fiscalYear.startsOn || lockedTo > fiscalYear.endsOn) throw new Error("La date de verrouillage doit se situer dans l'exercice.");
      if (fiscalYear.lockedTo && lockedTo < fiscalYear.lockedTo) {
        throw new Error("Utilisez d'abord le déverrouillage explicite pour réduire la période verrouillée.");
      }
      if (fiscalYear.lockedTo?.getTime() === lockedTo.getTime()) throw new Error("La période est déjà verrouillée à cette date.");
      const updated = await tx.fiscalYear.update({ where: { id: fiscalYear.id }, data: { lockedTo } });
      await appendTrustedAudit(tx, {
        companyId,
        action: "LOCK_FISCAL_PERIOD",
        entity: "FiscalYear",
        entityId: fiscalYearId,
        description: `${fiscalYear.label} verrouillé jusqu'au ${payload.lockedTo} inclus`,
        details: { lockedTo: payload.lockedTo },
      });
      return updated;
    });
    return serialize(result);
  });

  ipcMain.handle("wheat:fiscal-period:unlock", async (_event, payload: { companyId?: string; fiscalYearId?: string }) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données de déverrouillage sont invalides.");
    const companyId = requireId(payload.companyId, "La société");
    const fiscalYearId = requireId(payload.fiscalYearId, "L'exercice");
    const prisma = await getAuthorizedPrisma();
    const result = await prisma.$transaction(async (tx) => {
      const fiscalYear = await tx.fiscalYear.findUnique({ where: { id: fiscalYearId } });
      if (!fiscalYear || fiscalYear.companyId !== companyId) throw new Error("L'exercice n'appartient pas à la société sélectionnée.");
      if (fiscalYear.status !== "OPEN") throw new Error("Un exercice clôturé ne peut pas être déverrouillé.");
      if (!fiscalYear.lockedTo) throw new Error("Aucune période n'est actuellement verrouillée pour cet exercice.");
      const previousDate = fiscalYear.lockedTo.toISOString().slice(0, 10);
      const updated = await tx.fiscalYear.update({ where: { id: fiscalYear.id }, data: { lockedTo: null } });
      await appendTrustedAudit(tx, {
        companyId,
        action: "UNLOCK_FISCAL_PERIOD",
        entity: "FiscalYear",
        entityId: fiscalYearId,
        description: `${fiscalYear.label} déverrouillé (ancien verrou : ${previousDate})`,
        details: { previousLockedTo: previousDate },
      });
      return updated;
    });
    return serialize(result);
  });

  ipcMain.handle("wheat:document:create-invoice-draft", async (_event, documentId: string) => {
    const id = requireId(documentId, "Le document");
    const prisma = await getAuthorizedPrisma();
    const document = await prisma.document.findUnique({ where: { id } });
    if (!document) throw new Error("Le document demandé n'existe plus.");
    if (document.invoiceId) {
      const existing = await prisma.invoice.findUnique({ where: { id: document.invoiceId }, include: { lines: true } });
      if (existing) return serialize({ document, invoiceDraft: existing });
    }
    if (!subledgerService) throw new Error("Le sous-livre des factures n'est pas encore disponible.");

    let extracted: Record<string, any>;
    try {
      extracted = JSON.parse(document.extracted || "{}") as Record<string, any>;
    } catch {
      throw new Error("Les données OCR sont illisibles. Relancez l'extraction avant de créer la facture.");
    }
    const fields = (extracted.fields ?? extracted) as Record<string, any>;
    const displayName = requireText(
      String(fields.supplier ?? fields.counterparty ?? fields.client ?? extracted.counterparty ?? document.title),
      "Le tiers extrait",
      200,
    );
    const ice = optionalText(typeof fields.ice === "string" ? fields.ice : undefined, 30);
    const identityKey = counterpartyIdentityKey({ displayName, ice });
    const accounts = await prisma.account.findMany({
      where: { companyId: document.companyId, code: { in: ["441100", "345520", "612500"] }, active: true },
    });
    const byCode = new Map(accounts.map((account) => [account.code, account]));
    const payableAccount = byCode.get("441100");
    const vatAccount = byCode.get("345520");
    const expenseAccount = byCode.get("612500");
    if (!payableAccount || !vatAccount || !expenseAccount) {
      throw new Error("Configurez les comptes 441100, 345520 et 612500 avant de créer une facture fournisseur depuis l'OCR.");
    }
    let htCents = madToCents(fields.ht ?? extracted.ht ?? "0", "Le montant HT extrait");
    const vatCents = madToCents(fields.tva ?? fields.vat ?? extracted.vat ?? "0", "Le montant de TVA extrait");
    let ttcCents = madToCents(fields.ttc ?? extracted.ttc ?? "0", "Le montant TTC extrait");
    if (ttcCents === 0n) ttcCents = htCents + vatCents;
    if (htCents === 0n && ttcCents >= vatCents) htCents = ttcCents - vatCents;
    if (ttcCents <= 0n || htCents < 0n || vatCents < 0n || htCents + vatCents !== ttcCents) {
      throw new Error("Les totaux OCR ne sont pas cohérents. Corrigez HT, TVA et TTC avant de créer le brouillon.");
    }
    const invoiceDate = parseAccountingDate(fields.date ?? extracted.date ?? new Date(), "La date de facture extraite");
    const sourceInvoiceNumber = String(fields.invoiceNo ?? fields.invoiceNumber ?? fields.number ?? extracted.invoiceNo ?? "").trim();
    const titleInvoiceNumber = /\b(?:FA|FAC|FACT|FR|INV)[-_ /]?\d[\w/-]*/i.exec(document.title)?.[0]?.replace(/\s+/g, "-");
    const invoiceNo = sourceInvoiceNumber || titleInvoiceNumber;
    if (!invoiceNo) {
      throw new Error("Le numéro de facture fournisseur est introuvable. Corrigez le champ numéro dans la revue OCR avant de créer le brouillon.");
    }
    const result = await prisma.$transaction(async (tx) => {
      const currentDocument = await tx.document.findUnique({ where: { id } });
      if (!currentDocument || currentDocument.companyId !== document.companyId) throw new Error("Le document n'existe plus dans cette société.");
      if (currentDocument.invoiceId) throw new Error("Ce document est déjà lié à une facture.");
      const currentAccounts = await tx.account.count({
        where: { companyId: document.companyId, id: { in: [payableAccount.id, vatAccount.id, expenseAccount.id] }, active: true },
      });
      if (currentAccounts !== 3) throw new Error("Un compte OCR a été archivé ou modifié. Actualisez puis recommencez.");

      let counterparty = await tx.counterparty.findUnique({
        where: { companyId_identityKey: { companyId: document.companyId, identityKey } },
      });
      let counterpartyCreated = false;
      if (!counterparty) {
        counterparty = await tx.counterparty.create({
          data: {
            companyId: document.companyId,
            kind: "SUPPLIER",
            displayName,
            legalName: displayName,
            ice,
            identityKey,
            defaultPayableAccountId: payableAccount.id,
          },
        });
        counterpartyCreated = true;
      }
      if (!counterparty.active || !["SUPPLIER", "BOTH"].includes(counterparty.kind)) {
        throw new Error("Le tiers OCR existe mais n'est pas un fournisseur actif.");
      }
      const dueDate = fields.dueDate
        ? parseAccountingDate(fields.dueDate, "La date d'échéance extraite")
        : new Date(Date.UTC(invoiceDate.getUTCFullYear(), invoiceDate.getUTCMonth(), invoiceDate.getUTCDate() + counterparty.paymentTermsDays));
      const canonicalInvoiceNo = invoiceNo
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toUpperCase()
        .replace(/[^\p{L}\p{N}]+/gu, "")
        .trim();
      if (!canonicalInvoiceNo) throw new Error("Le numéro de facture fournisseur est invalide.");
      const numberKey = `PURCHASE:${counterparty.id}:${canonicalInvoiceNo}`;
      const duplicate = await tx.invoice.findUnique({ where: { companyId_numberKey: { companyId: document.companyId, numberKey } } });
      if (duplicate) throw new Error("Une facture portant ce numéro existe déjà pour ce fournisseur.");

      const invoiceDraft = await tx.invoice.create({
        data: {
          companyId: document.companyId,
          kind: "PURCHASE",
          counterparty: counterparty.displayName,
          ice: counterparty.ice,
          invoiceNo,
          invoiceDate,
          dueDate,
          paymentDate: null,
          htCents,
          vatCents,
          ttcCents,
          status: "DRAFT",
          paymentMethod: typeof fields.paymentMethod === "string" ? fields.paymentMethod : null,
          counterpartyId: counterparty.id,
          numberKey,
          currency: "MAD",
          counterpartyNameSnapshot: counterparty.displayName,
          iceSnapshot: counterparty.ice,
          taxIdSnapshot: counterparty.taxId,
          billingAddressSnapshot: counterparty.address,
          lifecycleStatus: "DRAFT",
          source: "OCR_1_3",
          notes: `Brouillon créé depuis le document OCR « ${document.title} ». Contrôle humain requis avant comptabilisation.`,
          needsReview: true,
          reviewNote: "Créé depuis OCR : vérifier tiers, numéro, date, comptes et montants.",
          controlAccountId: payableAccount.id,
          vatAccountId: vatAccount.id,
          lines: {
            create: {
              position: 1,
              description: String(fields.description ?? `Achat — ${displayName}`).slice(0, 250),
              accountId: expenseAccount.id,
              htCents,
              vatCents,
              ttcCents,
            },
          },
        },
        include: { lines: true, counterpartyModel: true },
      });
      const linked = await tx.document.updateMany({
        where: { id, companyId: document.companyId, invoiceId: null, paymentId: null, entryId: null },
        data: { invoiceId: invoiceDraft.id, status: "INVOICE_DRAFT" },
      });
      if (linked.count !== 1) throw new Error("Le document a été lié ou modifié dans une autre opération.");
      if (counterpartyCreated) {
        await appendTrustedAudit(tx, {
          companyId: document.companyId,
          action: "CREATE_COUNTERPARTY_FROM_OCR",
          entity: "Counterparty",
          entityId: counterparty.id,
          description: `Fournisseur ${counterparty.displayName} créé depuis OCR`,
          details: { identityKey, documentId: id },
        });
      }
      await appendTrustedAudit(tx, {
        companyId: document.companyId,
        action: "CREATE_INVOICE_DRAFT_FROM_OCR",
        entity: "Invoice",
        entityId: invoiceDraft.id,
        description: `Brouillon ${invoiceNo} créé et lié au document ${document.title}`,
        details: { documentId: id, counterpartyId: counterparty.id, htCents: htCents.toString(), vatCents: vatCents.toString(), ttcCents: ttcCents.toString() },
      });
      const updatedDocument = await tx.document.findUniqueOrThrow({ where: { id } });
      return { document: updatedDocument, invoiceDraft };
    });
    return serialize(result);
  });

  ipcMain.handle("wheat:payroll:post", async (_event, companyIdOrPayload: string | { companyId?: string; period?: string }, requestedPeriod?: string) => {
    const input = typeof companyIdOrPayload === "string"
      ? { companyId: companyIdOrPayload, period: requestedPeriod }
      : companyIdOrPayload;
    const companyId = requireId(input?.companyId, "La société");
    const { period, endDate } = parsePayrollPeriod(input?.period ?? currentPayrollPeriod());
    const prisma = await getAuthorizedPrisma();
    try {
      const created = await prisma.$transaction(async (tx) => {
      const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new Error("La société sélectionnée n'existe plus.");
      const priorRun = await tx.payrollRun.findUnique({ where: { companyId_period: { companyId, period } } });
      if (priorRun) throw new Error(`La paie ${period} a déjà été générée.`);
      const employees = await tx.employee.findMany({ where: { companyId } });
      if (!employees.length) throw new Error("Aucun salarié n'est enregistré pour cette société.");

      for (const employee of employees) {
        const calculatedGross = employee.netSalaryCents + employee.cnssEmployeeCents + employee.amoEmployeeCents + employee.irCents;
        if (calculatedGross !== employee.grossSalaryCents) {
          throw new Error(`La fiche de ${employee.fullName} est déséquilibrée. Corrigez les retenues ou le salaire net avant de générer la paie.`);
        }
      }

      const grossCents = employees.reduce((sum, employee) => sum + employee.grossSalaryCents, 0n);
      const cnssAmoCents = employees.reduce((sum, employee) => sum + employee.cnssEmployeeCents + employee.amoEmployeeCents, 0n);
      const irCents = employees.reduce((sum, employee) => sum + employee.irCents, 0n);
      const netCents = employees.reduce((sum, employee) => sum + employee.netSalaryCents, 0n);
      const payrollRun = await tx.payrollRun.create({
        data: {
          companyId,
          period,
          status: ENTRY_STATUS.draft,
          lines: {
            create: employees.map((employee) => ({
              employeeId: employee.id,
              employeeName: employee.fullName,
              cin: employee.cin,
              cnss: employee.cnss,
              position: employee.position,
              grossSalaryCents: employee.grossSalaryCents,
              cnssEmployeeCents: employee.cnssEmployeeCents,
              amoEmployeeCents: employee.amoEmployeeCents,
              irCents: employee.irCents,
              netSalaryCents: employee.netSalaryCents,
            })),
          },
        },
      });

      const [journal, payrollExpense, staffPayable, socialPayable, taxPayable] = await Promise.all([
        tx.journal.findFirstOrThrow({ where: { companyId, code: "PA", active: true, locked: false } }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "617100" } },
          update: {},
          create: { companyId, code: "617100", label: "Rémunérations du personnel", classNo: 6, type: "EXPENSE" },
        }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "443200" } },
          update: {},
          create: { companyId, code: "443200", label: "Personnel - rémunérations dues", classNo: 4, type: "LIABILITY" },
        }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "444100" } },
          update: {},
          create: { companyId, code: "444100", label: "CNSS et AMO à payer", classNo: 4, type: "LIABILITY" },
        }),
        tx.account.upsert({
          where: { companyId_code: { companyId, code: "445250" } },
          update: {},
          create: { companyId, code: "445250", label: "Etat - IR salarial", classNo: 4, type: "LIABILITY" },
        }),
      ]);

      const piece = await allocatePieceNumber(tx, { companyId, journalId: journal.id, date: endDate, source: "PAYROLL" });

      const draft = await tx.entry.create({
        data: {
          companyId,
          journalId: journal.id,
          journalCodeSnapshot: journal.code,
          number: provisionalEntryNumber(),
          date: endDate,
          ...piece,
          label: `Paie ${period}`,
          status: ENTRY_STATUS.draft,
          source: "PAYROLL",
          auditNote: `Paie ${period} générée pour ${employees.length} salarié(s)`,
          lines: {
            create: [
              { accountId: payrollExpense.id, accountCodeSnapshot: payrollExpense.code, accountLabelSnapshot: payrollExpense.label, label: `Salaires bruts ${period}`, debitCents: grossCents, creditCents: 0n },
              { accountId: staffPayable.id, accountCodeSnapshot: staffPayable.code, accountLabelSnapshot: staffPayable.label, label: "Net à payer", debitCents: 0n, creditCents: netCents },
              ...(cnssAmoCents > 0n ? [{ accountId: socialPayable.id, accountCodeSnapshot: socialPayable.code, accountLabelSnapshot: socialPayable.label, label: "CNSS/AMO salarié", debitCents: 0n, creditCents: cnssAmoCents }] : []),
              ...(irCents > 0n ? [{ accountId: taxPayable.id, accountCodeSnapshot: taxPayable.code, accountLabelSnapshot: taxPayable.label, label: "IR salarial", debitCents: 0n, creditCents: irCents }] : []),
            ].map((line, index) => ({ ...line, position: index + 1 })),
          },
        },
      });

      const entry = await postDraftEntryInTransaction(tx, draft.id, companyId);
      await tx.payrollRun.update({
        where: { id: payrollRun.id },
        data: { status: ENTRY_STATUS.posted, postedEntryId: entry.id, postedAt: new Date() },
      });
      await appendTrustedAudit(tx, {
        companyId,
        action: "POST_PAYROLL",
        entity: "PayrollRun",
        entityId: payrollRun.id,
        description: `${entry.number} générée pour la paie ${period}`,
        details: { entryId: entry.id, period, employeeCount: employees.length },
      });

      return entry;
    });

      return serialize(created);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        throw new Error(`La paie ${period} a déjà été générée.`, { cause: error });
      }
      throw error;
    }
  });

  ipcMain.handle("wheat:employee:save", async (_event, payload: unknown) => {
    if (!payload || typeof payload !== "object") throw new Error("Les données du salarié sont invalides.");
    const input = payload as Record<string, unknown>;
    const companyId = requireId(input.companyId, "La société");
    const id = input.id ? requireId(input.id, "Le salarié") : null;
    const fullName = requireText(input.fullName, "Le nom du salarié", 160);
    const cin = requireText(input.cin, "Le CIN", 40);
    const cnss = requireText(input.cnss, "Le numéro CNSS", 40);
    const position = requireText(input.position, "Le poste", 120);
    const grossSalaryCents = madToCents(input.grossSalary, "Le salaire brut");
    const cnssEmployeeCents = madToCents(input.cnssEmployee, "La retenue CNSS");
    const amoEmployeeCents = madToCents(input.amoEmployee, "La retenue AMO");
    const irCents = madToCents(input.ir, "La retenue IR");
    const netSalaryCents = madToCents(input.netSalary, "Le salaire net");
    const amounts = [grossSalaryCents, cnssEmployeeCents, amoEmployeeCents, irCents, netSalaryCents];
    if (amounts.some((amount) => amount < 0n)) throw new Error("Les montants de paie ne peuvent pas être négatifs.");
    if (netSalaryCents + cnssEmployeeCents + amoEmployeeCents + irCents !== grossSalaryCents) {
      throw new Error("Le salaire brut doit être égal au net plus les retenues CNSS, AMO et IR.");
    }

    const prisma = await getAuthorizedPrisma();
    const employee = await prisma.$transaction(async (tx) => {
      const company = await tx.company.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) throw new Error("La société sélectionnée n'existe plus.");
      if (id) {
        const existing = await tx.employee.findUnique({ where: { id }, select: { companyId: true } });
        if (!existing || existing.companyId !== companyId) throw new Error("Le salarié à modifier n'existe plus dans cette société.");
      }
      const data = {
        companyId,
        fullName,
        cin,
        cnss,
        position,
        grossSalaryCents,
        cnssEmployeeCents,
        amoEmployeeCents,
        irCents,
        netSalaryCents,
      };
      const saved = id
        ? await tx.employee.update({ where: { id }, data })
        : await tx.employee.create({ data });
      await appendTrustedAudit(tx, {
        companyId,
        action: id ? "UPDATE_EMPLOYEE" : "CREATE_EMPLOYEE",
        entity: "Employee",
        entityId: saved.id,
        description: `${fullName} ${id ? "mis à jour" : "ajouté"} dans la paie`,
        details: { position, grossSalaryCents, netSalaryCents },
      });
      return saved;
    });

    return serialize(employee);
  });

  ipcMain.handle("wheat:employee:delete", async (_event, employeeId: string) => {
    const prisma = await getAuthorizedPrisma();
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });

    await prisma.$transaction(async (tx) => {
      await tx.employee.delete({ where: { id: employeeId } });
      await appendTrustedAudit(tx, {
        companyId: employee.companyId,
        action: "DELETE_EMPLOYEE",
        entity: "Employee",
        entityId: employee.id,
        description: `${employee.fullName} supprimé de la paie`,
        details: { cin: employee.cin, cnss: employee.cnss },
      });
    });

    return serialize({ ok: true, id: employeeId, name: employee.fullName });
  });

  const smartOcrImport = async (companyId: string, providedPaths?: string[]) => {
    const prisma = await getAuthorizedPrisma();
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    let filePaths = providedPaths?.length ? providedPaths : [];

    if (!filePaths.length) {
      const selection = await dialog.showOpenDialog({
        title: "Smart OCR Organizer - importer un document",
        properties: ["openFile"],
        filters: [
          { name: "Document", extensions: ["pdf", "png", "jpg", "jpeg", "webp", "heic", "heif", "tif", "tiff", "bmp", "gif", "csv", "txt", "xlsx"] },
          { name: "Tous les fichiers", extensions: ["*"] },
        ],
      });

      if (selection.canceled) return [];
      filePaths = selection.filePaths;
    }

    const importFiles = pickSingleImportFile(filePaths);
    if (!importFiles.length) return [];

    const existingDocuments = await prisma.document.findMany({
      where: { companyId },
      select: { id: true, title: true, type: true, extracted: true },
    });
    const processed = await processSmartOcrFiles(app, {
      companyId,
      companyName: company.name,
      filePaths: importFiles,
      existingDocuments,
    });

    const { createHash } = await import("node:crypto");
    const preparedDocuments = processed.map((doc) => {
      const storedBytes = fs.readFileSync(doc.storedPath);
      return {
        data: {
          companyId,
          title: doc.title,
          type: doc.type,
          fiscalYear: doc.fiscalYear,
          tags: doc.tags,
          storedPath: doc.storedPath,
          contentSha256: createHash("sha256").update(storedBytes).digest("hex"),
          mimeType: mimeTypeForManagedDocument(doc.storedPath),
          byteSize: BigInt(storedBytes.length),
          ocrText: doc.ocrText,
          extracted: JSON.stringify(doc.extracted),
          status: doc.status,
        },
      };
    });
    const created = await prisma.$transaction(async (tx) => {
      const documents: Array<{ id: string } & Record<string, unknown>> = [];
      for (const prepared of preparedDocuments) {
        documents.push(await tx.document.create({ data: prepared.data }));
      }
      await appendTrustedAudit(tx, {
        companyId,
        action: "SMART_OCR_IMPORT",
        entity: "Document",
        description: `${documents.length} document(s) traités par l'organiseur OCR`,
        details: {
          documents: documents.map((document, index) => ({
            id: document.id,
            sha256: preparedDocuments[index].data.contentSha256,
            title: preparedDocuments[index].data.title,
          })),
        },
      });
      return documents;
    });

    return serialize(created);
  };

  ipcMain.handle("wheat:documents:upload", async (_event, companyId: string) => smartOcrImport(companyId));

  ipcMain.handle("wheat:documents:select-file", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Smart OCR Organizer - choisir un document",
      properties: ["openFile"],
      filters: [
        { name: "Document", extensions: ["pdf", "png", "jpg", "jpeg", "webp", "heic", "heif", "tif", "tiff", "bmp", "gif", "csv", "txt", "xlsx"] },
        { name: "Tous les fichiers", extensions: ["*"] },
      ],
    });

    if (selection.canceled) return null;
    return pickSingleImportFile(selection.filePaths)[0] ?? null;
  });

  ipcMain.handle("wheat:smart-ocr:process", async (_event, payload: { companyId: string; filePaths?: string[] }) => smartOcrImport(payload.companyId, payload.filePaths));
  ipcMain.handle("wheat:paddle-ocr:status", async () => serialize(await getPaddleOcrStatus(app)));

  ipcMain.handle("wheat:document:update-extraction", async (_event, payload: { documentId: string; type?: string; fields?: Record<string, unknown>; tags?: string }) => {
    const prisma = await getAuthorizedPrisma();
    const document = await prisma.document.findUniqueOrThrow({ where: { id: payload.documentId } });
    if (document.invoiceId || document.paymentId || document.entryId) {
      throw new Error("Ce document est déjà lié à un brouillon ou à une écriture. Corrigez le sous-livre lié, ou supprimez d'abord son brouillon, afin de préserver la preuve source.");
    }
    const previous = JSON.parse(document.extracted || "{}");
    const correctedFields = payload.fields ?? {};
    const next = {
      ...previous,
      fields: {
        ...(previous.fields ?? {}),
        ...correctedFields,
      },
      fieldConfidence: {
        ...(previous.fieldConfidence ?? {}),
        ...Object.fromEntries(Object.keys(correctedFields).map((key) => [key, 100])),
      },
      manualCorrectedAt: new Date().toISOString(),
    };

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.document.update({
        where: { id: payload.documentId },
        data: {
          type: payload.type ?? document.type,
          tags: payload.tags ?? `${document.tags},corrected`,
          extracted: JSON.stringify(next),
          status: "EXTRACTED",
        },
      });
      await appendTrustedAudit(tx, {
        companyId: document.companyId,
        action: "SMART_OCR_CORRECT",
        entity: "Document",
        entityId: document.id,
        description: `${document.title} : extraction corrigée manuellement`,
        details: { correctedFields: Object.keys(correctedFields), type: result.type, tags: result.tags },
      });
      return result;
    });

    return serialize(updated);
  });

  ipcMain.handle("wheat:document:delete", async (_event, documentId: string) => {
    const prisma = await getAuthorizedPrisma();
    const document = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    if (document.invoiceId || document.paymentId || document.entryId) {
      throw new Error("Ce document est lié à un brouillon, une facture, un paiement ou une écriture. Supprimez d'abord le brouillon lié ; les pièces comptabilisées restent conservées comme preuve.");
    }
    const storedPath = document.storedPath;
    let storedFileDeleted = false;

    await prisma.$transaction(async (tx) => {
      await tx.document.delete({ where: { id: documentId } });
      await appendTrustedAudit(tx, {
        companyId: document.companyId,
        action: "DELETE_DOCUMENT",
        entity: "Document",
        entityId: document.id,
        description: `${document.title} supprimé de l'organiseur de documents`,
        details: { contentSha256: document.contentSha256, byteSize: document.byteSize },
      });
    });

    if (storedPath) {
      storedFileDeleted = await trashStoredDocumentFile(app, storedPath);
    }

    return serialize({ ok: true, id: documentId, storedFileDeleted });
  });

  ipcMain.handle("wheat:import:file", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Importer Excel ou CSV",
      properties: ["openFile"],
      filters: [{ name: "Excel / CSV", extensions: ["xlsx", "xls", "csv"] }],
    });

    if (selection.canceled || !selection.filePaths[0]) return null;
    const filePath = selection.filePaths[0];
    return {
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      bytesBase64: fs.readFileSync(filePath).toString("base64"),
    };
  });

  ipcMain.handle("wheat:bank:statement:select-file", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const selection = await dialog.showOpenDialog({
      title: "Sélectionner un relevé bancaire",
      properties: ["openFile"],
      filters: [
        { name: "Relevés bancaires", extensions: ["csv", "txt", "xlsx", "xls", "ofx", "qif", "sta", "mt940", "xml", "pdf", "png", "jpg", "jpeg", "tif", "tiff"] },
        { name: "Tous les fichiers", extensions: ["*"] },
      ],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const filePath = selection.filePaths[0];
    return {
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      bytesBase64: fs.readFileSync(filePath).toString("base64"),
    };
  });

  ipcMain.handle("wheat:bank:statement:parse", async (_event, payload: Record<string, unknown>) => {
    return serialize(await parseBankStatement({
      sourceName: requireText(payload?.sourceName, "Le nom du relevé", 250),
      bytesBase64: requireText(payload?.bytesBase64, "Le contenu du relevé", 40_000_000),
      mimeType: typeof payload?.mimeType === "string" ? payload.mimeType : undefined,
      app,
    }));
  });

  ipcMain.handle("wheat:bank:statement:prepare", async (_event, payload: Record<string, unknown>) => {
    const prisma = await getAuthorizedPrisma();
    const bankAccountId = requireId(payload?.bankAccountId, "Le compte bancaire");
    const sourceName = path.basename(requireText(payload?.sourceName, "Le nom du relevé", 250));
    const sourceSha256 = requireText(payload?.sourceSha256, "L'empreinte du relevé", 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("L'empreinte SHA-256 du relevé est invalide.");
    const bankAccount = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
    if (!bankAccount) throw new Error("Le compte bancaire n'existe plus.");
    if (!bankAccount.active) throw new Error("Restaurez ce compte bancaire archivé avant d'importer un relevé.");
    const bytesBase64 = requireText(payload?.sourceBytesBase64, "Le contenu du relevé", 40_000_000);
    const bytes = Buffer.from(bytesBase64, "base64");
    if (!bytes.length || bytes.length > 25_000_000) throw new Error("Le relevé est vide ou dépasse 25 Mo.");
    const calculated = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    if (calculated !== sourceSha256) throw new Error("Le contenu du relevé ne correspond pas à son empreinte SHA-256.");
    const safeName = sourceName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160) || "statement";
    const statementDir = path.join(managedDocumentsRoot(app), bankAccount.companyId, "bank-statements");
    fs.mkdirSync(statementDir, { recursive: true });
    const storedPath = path.join(statementDir, `${sourceSha256}-${safeName}`);
    if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, bytes, { flag: "wx" });
    const { sourceBytesBase64: _discarded, ...prepared } = payload;
    void _discarded;
    return { ...prepared, sourceStoredPath: storedPath };
  });

  ipcMain.handle("wheat:export:file", async (_event, payload: { suggestedName: string; bytesBase64: string; filters: Electron.FileFilter[] }) => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const result = await dialog.showSaveDialog({
      title: "Exporter depuis Wheat",
      defaultPath: payload.suggestedName,
      filters: payload.filters,
    });

    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, Buffer.from(payload.bytesBase64, "base64"));
    return result.filePath;
  });

  ipcMain.handle("wheat:backup:create", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const result = await dialog.showSaveDialog({
      title: "Créer une sauvegarde complète Wheat",
      defaultPath: `wheat-${new Date().toISOString().slice(0, 10)}.wheatbackup`,
      filters: [{ name: "Sauvegarde complète Wheat", extensions: ["wheatbackup", "atlasbackup"] }],
    });

    if (result.canceled || !result.filePath) return null;
    const livePath = path.resolve(resolveDatabasePath(app));
    const requestedPath = path.resolve(result.filePath);
    const targetPath = /\.(wheat|atlas)backup$/i.test(requestedPath)
      ? requestedPath
      : `${requestedPath}.wheatbackup`;
    if (targetPath === livePath) throw new Error("La sauvegarde doit être enregistrée dans un fichier différent de la base active.");
    return runExclusiveMaintenance("création de la sauvegarde", async () => {
      try {
        if (!fs.existsSync(livePath)) throw new Error("La base active est introuvable ; aucune sauvegarde n'a été créée.");
        return await createFullWheatBackup(targetPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`La sauvegarde complète n'a pas pu être créée. Aucun fichier existant n'a été remplacé. ${message}`, { cause: error });
      }
    });
  });

  ipcMain.handle("wheat:database:path", async () => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    return resolveDatabasePath(app);
  });

  ipcMain.handle("wheat:backup:restore", async () => {
    let recoveryRestoreAllowed = Boolean(startupDatabaseError);
    if (localSecurity) {
      try {
        const securityStatus = await localSecurity.status();
        recoveryRestoreAllowed ||= securityStatus.configurationError;
      } catch {
        recoveryRestoreAllowed ||= Boolean(startupDatabaseError);
      }
      if (!recoveryRestoreAllowed) {
        await localSecurity.assertUnlocked();
        await localSecurity.touch();
      }
    }
    const result = await dialog.showOpenDialog({
      title: "Restaurer une sauvegarde Wheat",
      properties: ["openFile"],
      filters: [
        { name: "Sauvegarde complète Wheat", extensions: ["wheatbackup", "atlasbackup"] },
        { name: "Ancienne sauvegarde SQLite", extensions: ["sqlite", "db"] },
      ],
    });

    if (result.canceled || !result.filePaths[0]) return null;
    const sourcePath = path.resolve(result.filePaths[0]);
    const livePath = path.resolve(resolveDatabasePath(app));
    if (sourcePath === livePath) throw new Error("Sélectionnez une sauvegarde différente de la base active.");
    const isFullArchive = /\.(wheat|atlas)backup$/i.test(sourcePath);

    return runExclusiveMaintenance("restauration de la sauvegarde", async () => {

    if (!isFullArchive) {
      validateSqliteBackup(sourcePath);
      const backupDir = path.join(path.dirname(livePath), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const rollbackPath = path.join(backupDir, `atlas-ledger-${timestampForBackup()}-before-legacy-restore.sqlite`);
      const stagingPath = path.join(path.dirname(livePath), `.atlas-restore-${process.pid}-${Date.now()}.sqlite`);
      const previousPath = path.join(path.dirname(livePath), `.atlas-previous-${process.pid}-${Date.now()}.sqlite`);
      const hadLiveDatabase = fs.existsSync(livePath);
      let databaseDetached = false;
      let replacementDone = false;

      try {
        await disconnectPrisma();
        databaseDetached = true;
        checkpointWheatDatabase(livePath);
        if (fs.existsSync(livePath)) fs.copyFileSync(livePath, rollbackPath, fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
        migrateAndValidateDatabase(stagingPath);
        if (fs.existsSync(livePath)) fs.renameSync(livePath, previousPath);
        fs.renameSync(stagingPath, livePath);
        replacementDone = true;
        safeUnlink(`${livePath}-wal`);
        safeUnlink(`${livePath}-shm`);
        await reopenDatabaseAndResetSession();
      } catch (error) {
        let rollbackError: unknown | null = null;
        if (databaseDetached) {
          try {
            await rollbackDatabaseReplacement(
              { livePath, previousPath, replacementDone, hadLiveDatabase },
              {
                disconnect: disconnectPrisma,
                reopenAndReset: reopenDatabaseAndResetSession,
                onCleanupError: writeMainProcessError,
              },
            );
          } catch (caughtRollbackError) {
            rollbackError = caughtRollbackError;
            startupDatabaseError = caughtRollbackError instanceof Error
              ? caughtRollbackError
              : new Error(String(caughtRollbackError));
          }
        }

        if (!rollbackError) {
          bestEffortRestoreCleanup("fichier SQLite de préparation", () => safeUnlink(stagingPath));
        }
        if (!databaseDetached) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`La restauration a été annulée avant toute modification de la base active. ${message}`, { cause: error });
        }
        throw restoreFailure("La restauration SQLite a échoué.", error, rollbackError, livePath, previousPath);
      }

      // The restore is committed once the replacement database has been
      // validated, Prisma reopened and the lock/session state reset. Cleanup is
      // deliberately best-effort and can no longer send execution to rollback.
      bestEffortRestoreCleanup("copie SQLite précédente", () => safeUnlink(previousPath));
      bestEffortRestoreCleanup("fichier SQLite de préparation", () => safeUnlink(stagingPath));
      return livePath;
    }

    const userDataDir = resolveWheatUserDataDir(app);
    const documentsRoot = managedDocumentsRoot(app);
    const restoredParent = path.join(documentsRoot, "restored");
    const backupDir = path.join(userDataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const previousPath = path.join(userDataDir, `.atlas-previous-${process.pid}-${Date.now()}.sqlite`);
    const hadLiveDatabase = fs.existsSync(livePath);
    let staged: Awaited<ReturnType<typeof extractWheatBackupToStaging>> | null = null;
    let restoredAttachmentsRoot: string | null = null;
    let databaseDetached = false;
    let replacementDone = false;

    try {
      staged = await extractWheatBackupToStaging({ archivePath: sourcePath, stagingParentDirectory: userDataDir });
      migrateAndValidateDatabase(staged.databasePath);

      const attachmentFiles = staged.manifest.files.filter((file) => file.kind === "attachment");
      const prospectiveRestoredAttachmentsRoot = path.join(
        restoredParent,
        `restore-${timestampForBackup()}-${staged.manifest.backupId}`,
      );
      if (attachmentFiles.length) {
        restoredAttachmentsRoot = prospectiveRestoredAttachmentsRoot;
        rewriteRestoredDocumentPaths(staged.databasePath, attachmentFiles, restoredAttachmentsRoot);
      }
      validateWheatSqliteDatabase(staged.databasePath);
      const restoredProvenance = verifyManagedFileProvenance({
        databasePath: staged.databasePath,
        storedPathsRoot: prospectiveRestoredAttachmentsRoot,
        physicalFilesRoot: staged.attachmentsDirectory,
      });
      assertManagedFileSetMatchesArchive(
        restoredProvenance.relativePaths,
        attachmentFiles.map((file) => file.path.slice("attachments/".length)),
      );

      await disconnectPrisma();
      databaseDetached = true;
      if (fs.existsSync(livePath)) {
        const rollbackArchive = path.join(backupDir, `wheat-${timestampForBackup()}-before-restore.wheatbackup`);
        try {
          await createFullWheatBackup(rollbackArchive);
        } catch (backupError) {
          const emergencyCopy = path.join(backupDir, `atlas-ledger-${timestampForBackup()}-before-restore-unverified.sqlite`);
          fs.copyFileSync(livePath, emergencyCopy, fs.constants.COPYFILE_EXCL);
          writeMainProcessError(backupError);
        }
      }

      if (restoredAttachmentsRoot) {
        fs.mkdirSync(restoredParent, { recursive: true });
        if (fs.existsSync(restoredAttachmentsRoot)) throw new Error("Le dossier cible des pièces jointes restaurées existe déjà.");
        fs.renameSync(staged.attachmentsDirectory, restoredAttachmentsRoot);
      }

      if (fs.existsSync(livePath)) fs.renameSync(livePath, previousPath);
      fs.renameSync(staged.databasePath, livePath);
      replacementDone = true;
      safeUnlink(`${livePath}-wal`);
      safeUnlink(`${livePath}-shm`);
      await reopenDatabaseAndResetSession();
    } catch (error) {
      let rollbackError: unknown | null = null;
      if (databaseDetached) {
        try {
          await rollbackDatabaseReplacement(
            { livePath, previousPath, replacementDone, hadLiveDatabase },
            {
              disconnect: disconnectPrisma,
              reopenAndReset: reopenDatabaseAndResetSession,
              onCleanupError: writeMainProcessError,
            },
          );
        } catch (caughtRollbackError) {
          rollbackError = caughtRollbackError;
          startupDatabaseError = caughtRollbackError instanceof Error
            ? caughtRollbackError
            : new Error(String(caughtRollbackError));
        }
      }

      // If rollback itself failed after the database was replaced, preserve all
      // restore artifacts: they may be required to recover the database that is
      // still active. Successful/no-file-change failures can be cleaned safely.
      if (!rollbackError) {
        if (restoredAttachmentsRoot && fs.existsSync(restoredAttachmentsRoot)) {
          bestEffortRestoreCleanup("pièces jointes restaurées", () => {
            removePrivateRestoreDirectory(restoredAttachmentsRoot!, restoredParent, "restore-");
          });
        }
        if (staged && fs.existsSync(staged.stagingDirectory)) {
          bestEffortRestoreCleanup("dossier temporaire de restauration", () => {
            removePrivateRestoreDirectory(staged!.stagingDirectory, userDataDir, "atlas-backup-restore-");
          });
        }
      }
      if (!databaseDetached) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`La restauration complète a été annulée avant toute modification de la base active. ${message}`, { cause: error });
      }
      throw restoreFailure("La restauration complète a échoué.", error, rollbackError, livePath, previousPath);
    }

    // Commit precedes cleanup so a locked/undeletable temporary file can never
    // roll back a database that Wheat has already reopened for normal use.
    bestEffortRestoreCleanup("copie SQLite précédente", () => safeUnlink(previousPath));
    if (staged && fs.existsSync(staged.stagingDirectory)) {
      bestEffortRestoreCleanup("dossier temporaire de restauration", () => {
        removePrivateRestoreDirectory(staged!.stagingDirectory, userDataDir, "atlas-backup-restore-");
      });
    }
    return livePath;
    });
  });

  ipcMain.handle("wheat:open-path", async (_event, target: string) => {
    await localSecurity?.assertUnlocked();
    await localSecurity?.touch();
    const requestedPath = path.resolve(requireText(target, "Le chemin", 2048));
    const userDataPath = path.resolve(process.env.ATLAS_LEDGER_USER_DATA_DIR || app.getPath("userData"));
    const databasePath = path.resolve(resolveDatabasePath(app));
    const insideUserData = requestedPath === userDataPath || requestedPath.startsWith(`${userDataPath}${path.sep}`);
    const isDatabaseLocation = requestedPath === databasePath || requestedPath === path.dirname(databasePath);
    if (!insideUserData && !isDatabaseLocation) throw new Error("Wheat refuse d'ouvrir un chemin extérieur à son espace de données local.");
    if (!fs.existsSync(requestedPath)) throw new Error("Le chemin demandé n'existe plus.");
    if (requestedPath === databasePath) {
      shell.showItemInFolder(requestedPath);
      return;
    }
    const errorMessage = await shell.openPath(requestedPath);
    if (errorMessage) throw new Error(`Windows n'a pas pu ouvrir ce chemin : ${errorMessage}`);
  });

  ipcMain.handle("wheat:window:control", (event, action: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    if (action === "minimize") {
      win.minimize();
      return false;
    }

    if (action === "toggle-maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return win.isMaximized();
    }

    if (action === "focus") {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return true;
    }

    if (action === "close") {
      win.close();
      return true;
    }

    return null;
  });

  ipcMain.handle("wheat:app:restart", async () => relaunchWheat());
}

function pickSingleImportFile(inputPaths: string[]) {
  const supported = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp", ".gif", ".csv", ".txt", ".xlsx"]);
  const filePath = inputPaths.find((target) => {
    if (!target || !fs.existsSync(target)) return false;
    const stat = fs.statSync(target);
    return stat.isFile() && supported.has(path.extname(target).toLowerCase());
  });

  return filePath ? [filePath] : [];
}

async function trashStoredDocumentFile(appInstance: Electron.App, storedPath: string) {
  const userDataDir = process.env.ATLAS_LEDGER_USER_DATA_DIR || appInstance.getPath("userData");
  const resolvedStoredPath = path.resolve(storedPath);
  const resolvedUserDataDir = path.resolve(userDataDir);
  if (!resolvedStoredPath.startsWith(`${resolvedUserDataDir}${path.sep}`)) return false;
  if (!fs.existsSync(resolvedStoredPath)) return false;
  const stat = fs.statSync(resolvedStoredPath);
  if (!stat.isFile()) return false;
  try {
    await shell.trashItem(resolvedStoredPath);
    return true;
  } catch {
    // The database record can still be removed without destroying an
    // attachment that Windows could not move to the Recycle Bin.
    return false;
  }
}

function validateSqliteBackup(filePath: string) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error("Le fichier de sauvegarde sélectionné n'existe plus.");
  if (fs.statSync(filePath).size < 100) throw new Error("Le fichier sélectionné est trop petit pour être une base SQLite valide.");
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (header.toString("binary") !== "SQLite format 3\0") throw new Error("Le fichier sélectionné n'est pas une base SQLite.");
  } finally {
    fs.closeSync(descriptor);
  }

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    if (result.length !== 1 || Object.values(result[0] ?? {})[0] !== "ok") throw new Error("Le contrôle d'intégrité SQLite a échoué.");
    const companyTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Company'").get();
    if (!companyTable) throw new Error("Cette base ne contient pas les données d'une installation Wheat.");
  } finally {
    database.close();
  }
}

function timestampForBackup(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeUnlink(filePath: string) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
}

function resolveWheatUserDataDir(appInstance: Electron.App) {
  return path.resolve(process.env.ATLAS_LEDGER_USER_DATA_DIR || appInstance.getPath("userData"));
}

function managedDocumentsRoot(appInstance: Electron.App) {
  return path.join(resolveWheatUserDataDir(appInstance), "documents");
}

function mimeTypeForManagedDocument(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".bmp": "image/bmp",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function persistManagedLedgerImportSource(input: { companyId: string; sourceName: string; sourceSha256: string; bytes: Buffer }) {
  const safeName = path.basename(input.sourceName).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 160) || "ledger-import";
  const importDirectory = path.join(managedDocumentsRoot(app), input.companyId, "ledger-imports");
  fs.mkdirSync(importDirectory, { recursive: true });
  const storedPath = path.join(importDirectory, `${input.sourceSha256}-${safeName}`);
  if (!fs.existsSync(storedPath)) fs.writeFileSync(storedPath, input.bytes, { flag: "wx" });
  return storedPath;
}

function pathIsStrictlyInside(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function checkpointWheatDatabase(databasePath: string) {
  if (!fs.existsSync(databasePath)) return;
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

async function createFullWheatBackup(destinationPath: string) {
  const livePath = path.resolve(resolveDatabasePath(app));
  const documentsRoot = managedDocumentsRoot(app);
  await disconnectPrisma();
  checkpointWheatDatabase(livePath);
  const provenance = verifyManagedFileProvenance({
    databasePath: livePath,
    storedPathsRoot: documentsRoot,
  });
  const summary = await createWheatBackup({
    destinationPath,
    databasePath: livePath,
    managedAttachmentsRoot: provenance.relativePaths.length ? documentsRoot : undefined,
    managedAttachmentPaths: provenance.relativePaths,
    appVersion: WHEAT_APP_VERSION,
    workingDirectory: resolveWheatUserDataDir(app),
  });
  try {
    assertBackupManifestMatchesProvenance(summary.manifest.files, provenance);
  } catch (error) {
    safeUnlink(summary.archivePath);
    throw error;
  }
  return summary.archivePath;
}

function assertBackupManifestMatchesProvenance(
  manifestFiles: readonly WheatBackupFileManifest[],
  provenance: ManagedFileProvenanceResult,
) {
  const attachments = manifestFiles.filter((file) => file.kind === "attachment");
  assertManagedFileSetMatchesArchive(
    provenance.relativePaths,
    attachments.map((file) => file.path.slice("attachments/".length)),
  );
  const expectedByPath = new Map(provenance.files.map((file) => [file.relativePath, file]));
  for (const attachment of attachments) {
    const relativePath = attachment.path.slice("attachments/".length);
    const expected = expectedByPath.get(relativePath);
    if (!expected || expected.sha256 !== attachment.sha256 || expected.byteSize !== attachment.size) {
      throw new Error(`Le fichier géré a changé pendant la création de la sauvegarde : ${relativePath}.`);
    }
  }
}

function rewriteRestoredDocumentPaths(databasePath: string, files: WheatBackupFileManifest[], destinationRoot: string) {
  const candidates = files
    .filter((file) => file.kind === "attachment" && file.path.startsWith("attachments/"))
    .map((file) => file.path.slice("attachments/".length))
    .sort((left, right) => right.length - left.length);
  if (!candidates.length) return;

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    const documentTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Document'").get();
    const statementTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'BankStatementImport'").get();
    const ledgerImportTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'LedgerImportBatch'").get();
    if (!documentTable && !statementTable && !ledgerImportTable) return;
    const rows: Array<{ table: "Document" | "BankStatementImport" | "LedgerImportBatch"; id: string; storedPath: string }> = [];
    if (documentTable) {
      rows.push(...(database.prepare('SELECT "id", "storedPath" FROM "Document" WHERE "storedPath" IS NOT NULL').all() as Array<{ id: string; storedPath: string }>).map((row) => ({ ...row, table: "Document" as const })));
    }
    if (statementTable) {
      rows.push(...(database.prepare('SELECT "id", "sourceStoredPath" AS "storedPath" FROM "BankStatementImport" WHERE "sourceStoredPath" IS NOT NULL').all() as Array<{ id: string; storedPath: string }>).map((row) => ({ ...row, table: "BankStatementImport" as const })));
    }
    if (ledgerImportTable) {
      rows.push(...(database.prepare('SELECT "id", "sourceStoredPath" AS "storedPath" FROM "LedgerImportBatch" WHERE "sourceStoredPath" IS NOT NULL').all() as Array<{ id: string; storedPath: string }>).map((row) => ({ ...row, table: "LedgerImportBatch" as const })));
    }
    const updateDocument = documentTable ? database.prepare('UPDATE "Document" SET "storedPath" = ? WHERE "id" = ?') : null;
    const updateStatement = statementTable ? database.prepare('UPDATE "BankStatementImport" SET "sourceStoredPath" = ? WHERE "id" = ?') : null;
    const updateLedgerImport = ledgerImportTable ? database.prepare('UPDATE "LedgerImportBatch" SET "sourceStoredPath" = ? WHERE "id" = ?') : null;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const normalized = row.storedPath.replaceAll("\\", "/").normalize("NFC").toLocaleLowerCase("en-US");
        const relative = candidates.find((candidate) => {
          const key = candidate.normalize("NFC").toLocaleLowerCase("en-US");
          return normalized === key || normalized.endsWith(`/${key}`);
        });
        if (relative) {
          const nextPath = path.join(destinationRoot, ...relative.split("/"));
          if (row.table === "Document") updateDocument?.run(nextPath, row.id);
          else if (row.table === "BankStatementImport") updateStatement?.run(nextPath, row.id);
          else updateLedgerImport?.run(nextPath, row.id);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function removePrivateRestoreDirectory(target: string, permittedParent: string, expectedPrefix?: string) {
  const resolved = path.resolve(target);
  const parent = path.resolve(permittedParent);
  if (!pathIsStrictlyInside(parent, resolved)) throw new Error("Wheat a refusé de supprimer un dossier de restauration hors de son espace privé.");
  if (expectedPrefix && !path.basename(resolved).startsWith(expectedPrefix)) {
    throw new Error("Wheat a refusé de supprimer un dossier qui ne ressemble pas à un dossier de restauration privé.");
  }
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

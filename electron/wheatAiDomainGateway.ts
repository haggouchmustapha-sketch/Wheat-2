import { appendActivityAndAudit, verifyAuditChain } from "./audit13";
import { searchCompanyAccounts } from "./chartOfAccounts21";
import { createCompliance14Service } from "./compliance14";
import { createEntryCommandService } from "./entryCommands21";
import {
  addFiscalAdjustment,
  attachFiscalTableEvidence,
  buildComparativeCpc,
  buildFiscalControl,
  clearFiscalTableNotApplicable,
  generateFiscalPackage,
  getFiscalTable,
  listFiscalTables,
  markFiscalTableNotApplicable,
  refreshFiscalTable,
  removeFiscalTableEvidence,
  reopenFiscalTable,
  reviewFiscalTable,
  saveFiscalTable,
  validateFiscalPackage,
  verifyFiscalAdjustment,
} from "./fiscal21";
import { createOperations13Service } from "./operations13";
import { PCGE_SOURCE } from "./pcgeData";
import { createReconciliationService } from "./reconciliation";
import { createReportingService } from "./reporting";
import { buildBalanceFamily, buildBankTotal, buildBilan } from "./reporting21";
import { createSubledgerService } from "./subledger";
import {
  type WheatAiCapabilityDefinition,
  getWheatAiCapability,
  validateWheatAiCapabilityInput,
} from "./wheatAiCapabilityRegistry";

type PrismaLike = Record<string, any> & {
  $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
};

export type WheatAiDomainGatewayOptions = {
  getPrisma: () => any | Promise<any>;
  getActorUserId?: () => string | null | Promise<string | null>;
};

export type AtlasAiAuthorizedContext = {
  companyId: string;
  actorUserId: string;
  actorRole: string;
};

export type AtlasAiMutationPreview = {
  summary: string;
  target: string;
  changes: Array<{ field: string; label: string; before: unknown; after: unknown }>;
  warnings: string[];
  affectedRecords: Array<{ type: string; id?: string; label: string }>;
};

export type PreparedWheatAiCapability = {
  definition: WheatAiCapabilityDefinition;
  arguments: Record<string, any>;
  preview: AtlasAiMutationPreview;
  preconditions: Record<string, unknown>;
};

function safeJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function displayValue(value: unknown) {
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") return safeJson(value).slice(0, 500);
  return value ?? "";
}

function boundedLimit(value: unknown, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, maximum)) : fallback;
}

function centsToDecimal(value: unknown) {
  const cents = BigInt(String(value ?? "0"));
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  return `${negative ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
}

function invoiceServicePayload(payload: Record<string, any>) {
  return {
    ...payload,
    lines: (payload.lines ?? []).map((line: Record<string, any>) => ({
      description: line.description,
      accountId: line.accountId,
      quantity: line.quantity,
      unitPrice: line.unitPriceCents === undefined ? undefined : centsToDecimal(line.unitPriceCents),
      discount: line.discountCents === undefined ? "0.00" : centsToDecimal(line.discountCents),
      ht: centsToDecimal(line.htCents),
      vat: centsToDecimal(line.vatCents),
      ttc: centsToDecimal(line.ttcCents),
      vatRateBps: line.vatRateBps,
      taxRateDefinitionId: line.taxRateDefinitionId,
    })),
  };
}

function paymentServicePayload(payload: Record<string, any>) {
  return { ...payload, amount: centsToDecimal(payload.amountCents), allocations: [] };
}

export function createWheatAiDomainGateway(options: WheatAiDomainGatewayOptions) {
  const operations = createOperations13Service(options);
  const reporting = createReportingService({ getPrisma: options.getPrisma });
  const subledger = createSubledgerService(options);
  const compliance = createCompliance14Service(options);
  const entries = createEntryCommandService(options);

  async function prisma() {
    return options.getPrisma();
  }

  async function authorize(companyId: string, definition: WheatAiCapabilityDefinition): Promise<AtlasAiAuthorizedContext> {
    const actorUserId = await options.getActorUserId?.();
    if (!actorUserId) throw new Error("Une session utilisateur identifiée est requise pour Wheat AI.");
    const db = await prisma();
    const [company, actor, membership] = await Promise.all([
      db.company.findUnique({ where: { id: companyId }, select: { id: true } }),
      db.user.findUnique({ where: { id: actorUserId }, select: { id: true, role: true } }),
      db.companyUser.findFirst({ where: { companyId, userId: actorUserId }, select: { role: true } }),
    ]);
    if (!company) throw new Error("Le dossier actif n'existe plus.");
    if (!actor || !membership) throw new Error("L'utilisateur actif n'a pas accès à ce dossier.");
    const actorRole = actor.role === "ADMIN" ? "ADMIN" : String(membership.role || actor.role || "VIEWER").toUpperCase();
    if (!definition.requiredRoles.includes(actorRole)) throw new Error(`Le rôle ${actorRole} ne permet pas l'action ${definition.id}.`);
    return { companyId, actorUserId, actorRole };
  }

  async function findScopedRecord(db: PrismaLike, companyId: string, model: string, id: string) {
    const delegate = db[model];
    if (!delegate?.findFirst) throw new Error("La précondition demandée n'est pas prise en charge.");
    return delegate.findFirst({ where: { id, companyId } });
  }

  async function hydrateVersion(companyId: string, definition: WheatAiCapabilityDefinition, args: Record<string, any>) {
    const db = await prisma();
    const versionTargets: Record<string, { model: string; idKey: string; versionKey: string }> = {
      "company.update": { model: "company", idKey: "_company", versionKey: "expectedVersion" },
      "accounts.save": { model: "account", idKey: "id", versionKey: "expectedVersion" },
      "accounts.set_active": { model: "account", idKey: "id", versionKey: "expectedVersion" },
      "journals.save": { model: "journal", idKey: "id", versionKey: "expectedVersion" },
      "journals.set_active": { model: "journal", idKey: "id", versionKey: "expectedVersion" },
      "fiscal_years.save": { model: "fiscalYear", idKey: "id", versionKey: "expectedVersion" },
      "banking.save_account": { model: "bankAccount", idKey: "id", versionKey: "expectedVersion" },
      "banking.set_account_active": { model: "bankAccount", idKey: "id", versionKey: "expectedVersion" },
      "entries.update_draft": { model: "entry", idKey: "entryId", versionKey: "expectedVersion" },
      "counterparties.update": { model: "counterparty", idKey: "id", versionKey: "expectedVersion" },
      "counterparties.archive": { model: "counterparty", idKey: "id", versionKey: "expectedVersion" },
      "counterparties.restore": { model: "counterparty", idKey: "id", versionKey: "expectedVersion" },
      "invoices.update_draft": { model: "invoice", idKey: "id", versionKey: "expectedVersion" },
      "invoices.delete_draft": { model: "invoice", idKey: "id", versionKey: "expectedVersion" },
      "invoices.post": { model: "invoice", idKey: "id", versionKey: "expectedVersion" },
      "invoices.void": { model: "invoice", idKey: "id", versionKey: "expectedVersion" },
      "payments.update_draft": { model: "payment", idKey: "id", versionKey: "expectedVersion" },
      "payments.delete_draft": { model: "payment", idKey: "id", versionKey: "expectedVersion" },
      "payments.post": { model: "payment", idKey: "id", versionKey: "expectedVersion" },
      "payments.void": { model: "payment", idKey: "id", versionKey: "expectedVersion" },
      "payments.allocate": { model: "payment", idKey: "paymentId", versionKey: "expectedVersion" },
      "vat.regenerate": { model: "vatWorkpaper", idKey: "id", versionKey: "expectedVersion" },
      "vat.add_adjustment": { model: "vatWorkpaper", idKey: "id", versionKey: "expectedVersion" },
      "vat.attach_evidence": { model: "vatWorkpaper", idKey: "id", versionKey: "expectedVersion" },
      "vat.remove_evidence": { model: "vatWorkpaper", idKey: "id", versionKey: "expectedVersion" },
      "vat.review": { model: "vatWorkpaper", idKey: "id", versionKey: "expectedVersion" },
      "vat.return_to_draft": { model: "vatWorkpaper", idKey: "id", versionKey: "expectedVersion" },
      "payroll.void": { model: "payrollRun", idKey: "payrollRunId", versionKey: "expectedVersion" },
    };
    const target = versionTargets[definition.id];
    if (target && args[target.versionKey] === undefined) {
      const id = target.idKey === "_company" ? companyId : args[target.idKey];
      if (id) {
        const current = target.model === "company"
          ? await db.company.findUnique({ where: { id: companyId } })
          : await findScopedRecord(db, companyId, target.model, String(id));
        if (!current) throw new Error("La cible n'existe plus ou appartient à un autre dossier.");
        args[target.versionKey] = current.version;
      }
    }
    if (definition.id.startsWith("fiscal.") && args.fiscalPackageId && args.tableId && args.expectedRevision === undefined) {
      const workpaper = await db.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId: args.fiscalPackageId, tableId: args.tableId, fiscalPackage: { companyId } } });
      if (!workpaper) throw new Error("Le tableau fiscal n'existe pas dans ce dossier.");
      args.expectedRevision = workpaper.revision;
    }
    if (["banking.confirm_reconciliation", "banking.exclude_movement", "banking.restore_movement"].includes(definition.id)) {
      if (args.expectedRevision === undefined) {
        const movement = await db.bankMovement.findFirst({ where: { id: args.movementId, bankAccount: { companyId } } });
        if (!movement) throw new Error("Le mouvement bancaire n'existe pas dans ce dossier.");
        args.expectedRevision = movement.revision;
      }
    }
    if (definition.id === "banking.void_reconciliation" && args.expectedRevision === undefined) {
      const reconciliation = await db.bankReconciliation.findFirst({ where: { id: args.reconciliationId, companyId }, include: { movement: true } });
      if (!reconciliation) throw new Error("Le rapprochement n'existe pas dans ce dossier.");
      args.expectedRevision = reconciliation.movement.revision;
    }
    if (definition.id === "payments.reverse_allocation" && args.expectedPaymentVersion === undefined) {
      const allocation = await db.paymentAllocation.findFirst({ where: { id: args.allocationId, payment: { companyId } }, include: { payment: { select: { version: true } } } });
      if (!allocation) throw new Error("L'imputation n'existe pas dans ce dossier.");
      args.expectedPaymentVersion = allocation.payment.version;
    }
    return args;
  }

  async function assertArgumentScope(companyId: string, definition: WheatAiCapabilityDefinition, args: Record<string, any>) {
    const db = await prisma();
    const checks: Array<[string, string, string]> = [
      ["accountId", "account", "Le compte"], ["ledgerAccountId", "account", "Le compte comptable bancaire"], ["journalId", "journal", "Le journal"], ["fiscalYearId", "fiscalYear", "L'exercice"],
      ["entryId", "entry", "L'écriture"], ["counterpartyId", "counterparty", "Le tiers"], ["invoiceId", "invoice", "La facture"],
      ["paymentId", "payment", "Le paiement"], ["payrollRunId", "payrollRun", "La paie"], ["bankAccountId", "bankAccount", "Le compte bancaire"], ["documentId", "document", "Le document"],
      ["evidenceDocumentId", "document", "La preuve"], ["fiscalPackageId", "fiscalPackage", "La liasse"], ["batchId", "ledgerImportBatch", "Le lot d'import"],
    ];
    for (const [key, model, label] of checks) {
      if (!args[key]) continue;
      const current = await findScopedRecord(db, companyId, model, String(args[key]));
      if (!current) throw new Error(`${label} n'existe pas dans le dossier actif.`);
    }
    if (args.movementId) {
      const movement = await db.bankMovement.findFirst({ where: { id: args.movementId, bankAccount: { companyId } }, select: { id: true } });
      if (!movement) throw new Error("Le mouvement bancaire n'existe pas dans le dossier actif.");
    }
    if (args.reconciliationId) {
      const reconciliation = await db.bankReconciliation.findFirst({ where: { id: args.reconciliationId, companyId }, select: { id: true } });
      if (!reconciliation) throw new Error("Le rapprochement n'existe pas dans le dossier actif.");
    }
    if (args.allocationId) {
      const allocation = await db.paymentAllocation.findFirst({ where: { id: args.allocationId, payment: { companyId } }, select: { id: true } });
      if (!allocation) throw new Error("L'imputation n'existe pas dans le dossier actif.");
    }
    if (args.id) {
      const idModels: Record<string, string> = { accounts: "account", journals: "journal", "fiscal-years": "fiscalYear", subledger: "counterparty", invoices: "invoice", payments: "payment", vat: "vatWorkpaper" };
      const model = definition.id.startsWith("banking.") && ["banking.save_account", "banking.set_account_active"].includes(definition.id) ? "bankAccount" : idModels[definition.category];
      if (model && !await findScopedRecord(db, companyId, model, String(args.id))) throw new Error("La cible n'existe pas dans le dossier actif.");
    }
  }

  async function capturePreconditions(companyId: string, definition: WheatAiCapabilityDefinition, args: Record<string, any>) {
    const db = await prisma();
    const preconditions: Record<string, unknown> = {};
    const id = args.id ?? args.entryId ?? args.paymentId ?? args.payrollRunId ?? args.movementId ?? args.reconciliationId ?? args.batchId;
    const models: Record<string, string> = {
      accounts: "account", journals: "journal", entries: "entry", subledger: definition.id.startsWith("counterparties.") ? "counterparty" : "",
      invoices: "invoice", payments: "payment", vat: "vatWorkpaper", imports: "ledgerImportBatch", payroll: "payrollRun",
    };
    let model = models[definition.category];
    if (definition.id === "payments.reverse_allocation") {
      const allocation = await db.paymentAllocation.findFirst({ where: { id: args.allocationId, payment: { companyId } }, include: { payment: true } });
      if (!allocation) throw new Error("L'imputation n'existe plus ou appartient à un autre dossier.");
      preconditions.entity = { model: "payment", id: allocation.payment.id, version: allocation.payment.version, status: allocation.payment.lifecycleStatus };
      model = "";
    }
    if (model && id) {
      const current = model === "bankMovement"
        ? await db.bankMovement.findFirst({ where: { id, bankAccount: { companyId } } })
        : await findScopedRecord(db, companyId, model, String(id));
      if (!current) throw new Error("La cible n'existe plus ou appartient à un autre dossier.");
      preconditions.entity = { model, id: current.id, version: current.version ?? current.revision ?? null, status: current.status ?? current.lifecycleStatus ?? null };
    }
    if (definition.id === "company.update") {
      const company = await db.company.findUnique({ where: { id: companyId }, select: { version: true } });
      preconditions.entity = { model: "company", id: companyId, version: company?.version ?? null, status: null };
    }
    if (definition.id.startsWith("fiscal.") && args.fiscalPackageId) {
      const fiscalPackage = await db.fiscalPackage.findFirst({ where: { id: args.fiscalPackageId, companyId } });
      if (!fiscalPackage) throw new Error("La liasse n'existe pas dans ce dossier.");
      preconditions.fiscalPackage = { id: fiscalPackage.id, status: fiscalPackage.status, version: fiscalPackage.version ?? null };
      if (args.tableId) {
        const table = await db.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId: fiscalPackage.id, tableId: args.tableId } });
        if (!table) throw new Error("Le tableau fiscal n'existe pas dans cette liasse.");
        preconditions.fiscalTable = { id: table.id, revision: table.revision, status: table.status };
      }
    }
    return preconditions;
  }

  async function assertPreconditions(companyId: string, preconditions: Record<string, any>) {
    const db = await prisma();
    if (preconditions.entity) {
      const target = preconditions.entity;
      const current = await findScopedRecord(db, companyId, target.model, String(target.id));
      if (!current) throw new Error("La cible a disparu depuis la prévisualisation.");
      const currentVersion = current.version ?? current.revision ?? null;
      const currentStatus = current.status ?? current.lifecycleStatus ?? null;
      if (target.version !== currentVersion || target.status !== currentStatus) throw new Error("La cible a changé depuis la prévisualisation. Actualisez et préparez l'action à nouveau.");
    }
    if (preconditions.fiscalPackage) {
      const expected = preconditions.fiscalPackage;
      const current = await db.fiscalPackage.findFirst({ where: { id: expected.id, companyId } });
      if (!current || current.status !== expected.status || (expected.version !== null && current.version !== expected.version)) throw new Error("La liasse a changé depuis la prévisualisation.");
    }
    if (preconditions.fiscalTable) {
      const expected = preconditions.fiscalTable;
      const current = await db.fiscalTableWorkpaper.findFirst({ where: { id: expected.id, fiscalPackage: { companyId } } });
      if (!current || current.revision !== expected.revision || current.status !== expected.status) throw new Error("Le tableau fiscal a changé depuis la prévisualisation.");
    }
  }

  async function prepare(companyId: string, capabilityValue: unknown, inputValue: unknown): Promise<PreparedWheatAiCapability> {
    const definition = getWheatAiCapability(capabilityValue);
    if (!definition) throw new Error("Cette capacité Wheat AI n'est pas enregistrée.");
    await authorize(companyId, definition);
    const validated = validateWheatAiCapabilityInput(definition, inputValue);
    await assertArgumentScope(companyId, definition, validated);
    const args = await hydrateVersion(companyId, definition, { ...validated });
    let special: any = null;
    if (definition.id === "entries.create_draft") special = await entries.previewCreateEntry({ companyId, ...args, status: "DRAFT", source: "ATLAS_AI" });
    if (definition.id === "entries.post") special = await entries.previewPostEntry({ companyId, ...args });
    const preconditions = await capturePreconditions(companyId, definition, args);
    const affected = args.id ?? args.entryId ?? args.movementId ?? args.fiscalPackageId ?? args.batchId;
    const changes = Object.entries(args)
      .filter(([key]) => !["expectedVersion", "expectedRevision"].includes(key))
      .slice(0, 20)
      .map(([field, after]) => ({ field, label: field, before: "Valeur actuelle conservée dans le dossier", after: displayValue(after) }));
    const warning = definition.riskLevel === 3
      ? "Cette action est à impact élevé et exigera une confirmation immédiate avant exécution."
      : definition.riskLevel === 2
        ? "Cette action modifie des données comptables ou de conformité et sera revalidée au moment de l'exécution."
        : "Cette modification reste soumise aux validations normales de Wheat.";
    return {
      definition,
      arguments: args,
      preconditions,
      preview: {
        summary: special ? (definition.id === "entries.post" ? `Comptabiliser ${special.number}` : `Créer un brouillon équilibré de ${special.debitCents} centimes`) : definition.description,
        target: special?.label ?? String(affected ?? args.code ?? args.label ?? definition.category),
        changes,
        warnings: [warning, ...(special?.warning ? [special.warning] : [])],
        affectedRecords: [{ type: definition.category, ...(affected ? { id: String(affected) } : {}), label: special?.label ?? String(args.code ?? args.label ?? definition.description) }],
      },
    };
  }

  async function readDocuments(companyId: string, args: Record<string, any>) {
    const db = await prisma();
    const query = String(args.query ?? "").trim().slice(0, 160);
    return db.document.findMany({
      where: { companyId, ...(query ? { OR: [{ title: { contains: query } }, { type: { contains: query } }, { tags: { contains: query } }] } : {}) },
      select: { id: true, title: true, type: true, fiscalYear: true, tags: true, status: true, revision: true, contentSha256: true, byteSize: true, createdAt: true, entryId: true, invoiceId: true },
      orderBy: { createdAt: "desc" },
      take: boundedLimit(args.limit, 40, 100),
    });
  }

  async function execute(companyId: string, capabilityValue: unknown, inputValue: unknown, optionsValue: { preconditions?: Record<string, any>; sessionId?: string } = {}) {
    const definition = getWheatAiCapability(capabilityValue);
    if (!definition) throw new Error("Cette capacité Wheat AI n'est pas enregistrée.");
    const context = await authorize(companyId, definition);
    const args = validateWheatAiCapabilityInput(definition, inputValue);
    await assertArgumentScope(companyId, definition, args);
    if (optionsValue.preconditions) await assertPreconditions(companyId, optionsValue.preconditions);
    const payload = { companyId, ...args, origin: "ATLAS_AI" };
    let result: any;
    switch (definition.id) {
      case "company.get": {
        const db = await prisma();
        result = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, legalForm: true, ice: true, taxId: true, city: true, baseCurrency: true, vatFrequency: true, version: true, fiscalYears: { orderBy: { startsOn: "desc" }, take: 50, select: { id: true, label: true, startsOn: true, endsOn: true, status: true, lockedTo: true, version: true } }, _count: { select: { accounts: true, journals: true, entries: true, invoices: true, documents: true, bankAccounts: true } } } });
        break;
      }
      case "settings.get": result = await operations.getSettingsWorkspace(payload); break;
      case "company.update": result = await operations.updateCompanySettings(payload); break;
      case "accounts.search": result = await searchCompanyAccounts(await prisma(), companyId, args); break;
      case "accounts.get": {
        const db = await prisma();
        result = await db.account.findFirst({ where: { companyId, ...(args.accountId ? { id: args.accountId } : { code: args.code }) }, select: { id: true, code: true, label: true, labelArabic: true, parentCode: true, classNo: true, type: true, isStandard: true, active: true, category: true, reportNature: true, auxiliaryEligible: true, postable: true, version: true } });
        if (!result) throw new Error("Le compte n'existe pas dans ce dossier.");
        break;
      }
      case "accounts.save": result = await operations.saveAccount(payload); break;
      case "accounts.set_active": result = await operations.setAccountActive(payload); break;
      case "journals.list": result = (await operations.getSettingsWorkspace(payload)).journals; break;
      case "journals.save": result = await operations.saveJournal(payload); break;
      case "journals.set_active": result = await operations.setJournalActive(payload); break;
      case "fiscal_years.list": result = (await operations.getSettingsWorkspace(payload)).fiscalYears; break;
      case "fiscal_years.save": result = await operations.saveFiscalYear(payload); break;
      case "entries.search": result = await reporting.queryEntries(payload); break;
      case "entries.get": result = await entries.getEntry({ companyId, entryId: args.entryId }); break;
      case "entries.preview_post": result = await entries.previewPostEntry(payload); break;
      case "entries.create_draft": result = await entries.createEntry({ ...payload, status: "DRAFT", source: "ATLAS_AI" }); break;
      case "entries.update_draft": result = await operations.updateEntryDraft(payload); break;
      case "entries.duplicate": result = await entries.duplicateEntry(payload); break;
      case "entries.delete_draft": result = await entries.deleteDraftEntry(payload); break;
      case "entries.post": result = await entries.postEntry(payload); break;
      case "entries.reverse": result = await entries.reverseEntry(payload); break;
      case "reports.trial_balance": result = await reporting.trialBalance(payload); break;
      case "reports.general_ledger": result = await reporting.generalLedger(payload); break;
      case "reports.journal": result = await reporting.journal(payload); break;
      case "reports.aged_receivables": result = await reporting.agedReceivables(payload); break;
      case "reports.aged_payables": result = await reporting.agedPayables(payload); break;
      case "reports.integrity": result = await reporting.integrityChecks(payload); break;
      case "reports.balance": result = await buildBalanceFamily(await prisma(), payload); break;
      case "reports.bilan": result = await buildBilan(await prisma(), payload); break;
      case "reports.cpc": result = await buildComparativeCpc(await prisma(), payload); break;
      case "counterparties.list": result = await subledger.listCounterparties(payload); break;
      case "counterparties.create": result = await subledger.createCounterparty(payload); break;
      case "counterparties.update": result = await subledger.updateCounterparty(payload); break;
      case "counterparties.archive": result = await subledger.archiveCounterparty(payload); break;
      case "counterparties.restore": result = await subledger.restoreCounterparty(payload); break;
      case "invoices.list": result = await subledger.listInvoices(payload); break;
      case "invoices.create_draft": result = await subledger.createInvoiceDraft(invoiceServicePayload(payload)); break;
      case "invoices.update_draft": result = await subledger.updateInvoiceDraft(invoiceServicePayload(payload)); break;
      case "invoices.delete_draft": result = await subledger.deleteInvoiceDraft(payload); break;
      case "invoices.post": result = await subledger.postInvoice(payload); break;
      case "invoices.void": result = await subledger.voidInvoice(payload); break;
      case "payments.list": result = await subledger.listPayments(payload); break;
      case "payments.create_draft": result = await subledger.createPaymentDraft(paymentServicePayload(payload)); break;
      case "payments.update_draft": result = await subledger.updatePaymentDraft(paymentServicePayload(payload)); break;
      case "payments.delete_draft": result = await subledger.deletePaymentDraft(payload); break;
      case "payments.post": result = await subledger.postPayment(payload); break;
      case "payments.void": result = await subledger.voidPayment(payload); break;
      case "payments.allocate": result = await subledger.allocatePayment({ ...payload, amount: centsToDecimal(args.amountCents) }); break;
      case "payments.reverse_allocation": result = await subledger.reversePaymentAllocation(payload); break;
      case "banking.position": result = await buildBankTotal(await prisma(), payload); break;
      case "banking.reconciliation_workspace": result = await createReconciliationService(await prisma()).workspace(payload); break;
      case "banking.reconciliation_candidates": result = await createReconciliationService(await prisma()).candidates(payload as any); break;
      case "banking.confirm_reconciliation": result = await createReconciliationService(await prisma()).confirm({ ...payload, actorUserId: context.actorUserId } as any); break;
      case "banking.void_reconciliation": result = await createReconciliationService(await prisma()).void({ ...payload, actorUserId: context.actorUserId } as any); break;
      case "banking.exclude_movement": result = await createReconciliationService(await prisma()).exclude({ ...payload, actorUserId: context.actorUserId } as any); break;
      case "banking.restore_movement": result = await createReconciliationService(await prisma()).restore({ ...payload, actorUserId: context.actorUserId } as any); break;
      case "banking.save_account": result = await operations.saveBankAccount(payload); break;
      case "banking.set_account_active": result = await operations.setBankAccountActive(payload); break;
      case "documents.search": result = await readDocuments(companyId, args); break;
      case "vat.workspace": result = await compliance.taxWorkspace(payload); break;
      case "vat.workpapers": result = await compliance.listVatWorkpapers(payload); break;
      case "vat.workpaper": result = await compliance.getVatWorkpaper(payload); break;
      case "vat.generate": result = await compliance.generateVatWorkpaper(payload); break;
      case "vat.regenerate": result = await compliance.regenerateVatWorkpaper(payload); break;
      case "vat.add_adjustment": result = await compliance.addVatAdjustment(payload); break;
      case "vat.attach_evidence": result = await compliance.attachVatEvidence(payload); break;
      case "vat.remove_evidence": result = await compliance.removeVatEvidence(payload); break;
      case "vat.review": result = await compliance.reviewVatWorkpaper(payload); break;
      case "vat.return_to_draft": result = await compliance.returnVatWorkpaperToDraft(payload); break;
      case "vat.reopen": result = await compliance.reopenVatWorkpaper(payload); break;
      case "fiscal.control": {
        const db = await prisma();
        const fiscalPackageId = args.fiscalPackageId ?? (await db.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL" }, orderBy: { updatedAt: "desc" }, select: { id: true } }))?.id;
        result = fiscalPackageId ? await buildFiscalControl(db, { companyId, fiscalPackageId }) : { prepared: false, message: "Aucune liasse normale n'a encore été préparée." };
        break;
      }
      case "fiscal.tables": result = await listFiscalTables(await prisma(), payload); break;
      case "fiscal.table": result = await getFiscalTable(await prisma(), payload); break;
      case "fiscal.validate_package": result = await validateFiscalPackage(await prisma(), { companyId, id: args.fiscalPackageId }); break;
      case "fiscal.generate_package": {
        const db = await prisma();
        result = await db.$transaction(async (tx: any) => {
          const generated = await generateFiscalPackage(tx, { companyId, fiscalYearId: args.fiscalYearId, regime: args.variant ?? "NORMAL" });
          await appendActivityAndAudit(tx, { companyId, actorUserId: context.actorUserId, action: "ATLAS_AI_GENERATE_FISCAL_PACKAGE", entityType: "FiscalPackage", entityId: generated.id, description: `Wheat AI a préparé la liasse ${generated.regime}`, payload: { origin: "ATLAS_AI", fiscalYearId: args.fiscalYearId, regime: generated.regime } });
          return generated;
        });
        break;
      }
      case "fiscal.add_adjustment": result = await addFiscalAdjustment({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.verify_adjustment": result = await verifyFiscalAdjustment({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.refresh_table": result = await refreshFiscalTable({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.save_table": result = await saveFiscalTable({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.mark_not_applicable": result = await markFiscalTableNotApplicable({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.attach_evidence": result = await attachFiscalTableEvidence({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.review_table": result = await reviewFiscalTable({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.reopen_table": result = await reopenFiscalTable({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.clear_not_applicable": result = await clearFiscalTableNotApplicable({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "fiscal.remove_evidence": result = await removeFiscalTableEvidence({ prisma: await prisma(), actorUserId: context.actorUserId }, { ...payload, confirmed: true }); break;
      case "imports.list": result = await operations.listLedgerImports(payload); break;
      case "imports.confirm": result = await operations.confirmLedgerImport({ ...payload, confirmed: true }); break;
      case "imports.cancel": result = await operations.cancelLedgerImport(payload); break;
      case "payroll.runs": {
        const runs = await operations.listPayrollRuns(payload);
        result = runs.map((run: any) => ({ id: run.id, period: run.period, status: run.status, postedAt: run.postedAt, voidedAt: run.voidedAt, version: run.version, lineCount: run.lines?.length ?? 0 }));
        break;
      }
      case "payroll.void": result = await operations.voidPayrollRun(payload); break;
      case "audit.events": result = await operations.listAuditEvents(payload); break;
      case "audit.verify": result = await verifyAuditChain(await prisma(), companyId); break;
      case "knowledge.retrieve": {
        const db = await prisma();
        result = { source: PCGE_SOURCE, patterns: await db.atlasKnowledgePattern.findMany({ where: { companyId, active: true, ...(args.kind ? { kind: args.kind } : {}) }, orderBy: [{ confidenceBps: "desc" }, { updatedAt: "desc" }], take: boundedLimit(args.limit, 30, 100) }) };
        break;
      }
      case "knowledge.remember": {
        const db = await prisma();
        result = await db.$transaction(async (tx: any) => {
          const saved = await tx.atlasKnowledgePattern.upsert({ where: { companyId_kind_key: { companyId, kind: args.kind.toUpperCase(), key: args.key } }, create: { companyId, kind: args.kind.toUpperCase(), key: args.key, valueJson: safeJson(args.value), evidenceJson: safeJson(args.evidence ?? []), confidenceBps: args.confidenceBps ?? 5000 }, update: { valueJson: safeJson(args.value), evidenceJson: safeJson(args.evidence ?? []), confidenceBps: args.confidenceBps ?? 5000, active: true } });
          await appendActivityAndAudit(tx, { companyId, actorUserId: context.actorUserId, action: "ATLAS_AI_REMEMBER_KNOWLEDGE", entityType: "AtlasKnowledgePattern", entityId: saved.id, description: `Wheat AI a mémorisé la règle ${args.key}`, payload: { origin: "ATLAS_AI", kind: args.kind, key: args.key, confidenceBps: args.confidenceBps ?? 5000 } });
          return saved;
        });
        break;
      }
      case "navigation.open": result = { navigation: { target: args.target, entityId: args.entityId ?? null }, message: `Ouverture de ${args.target}.` }; break;
      default: throw new Error(`La capacité ${definition.id} n'a pas d'adaptateur de domaine.`);
    }
    return { capabilityId: definition.id, result };
  }

  async function executePlan(companyId: string, callsValue: unknown, optionsValue: { stopOnError?: boolean; sessionId?: string } = {}) {
    if (!Array.isArray(callsValue) || callsValue.length < 1 || callsValue.length > 25) throw new Error("Un plan Wheat AI doit contenir entre 1 et 25 actions.");
    const results: Array<Record<string, unknown>> = [];
    for (const [index, raw] of callsValue.entries()) {
      const call = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, any> : {};
      try {
        const executed = await execute(companyId, call.capabilityId ?? call.toolName, call.arguments ?? {}, { preconditions: call.preconditions, sessionId: optionsValue.sessionId });
        results.push({ index, capabilityId: executed.capabilityId, status: "SUCCEEDED", result: executed.result });
      } catch (error) {
        results.push({ index, capabilityId: String(call.capabilityId ?? call.toolName ?? "unknown"), status: "FAILED", error: error instanceof Error ? error.message : String(error) });
        if (optionsValue.stopOnError !== false) break;
      }
    }
    return { total: callsValue.length, completed: results.filter((item) => item.status === "SUCCEEDED").length, failed: results.filter((item) => item.status === "FAILED").length, stoppedEarly: results.length < callsValue.length, results };
  }

  return { authorize, prepare, execute, executePlan, assertPreconditions };
}

export type WheatAiDomainGateway = ReturnType<typeof createWheatAiDomainGateway>;

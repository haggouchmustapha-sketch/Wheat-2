export const SAGE_TXT_SEPARATOR = ";";

export const SAGE_TXT_FIELDS = [
  { key: "journalCode", label: "Code journal", maximum: 6, required: true },
  { key: "date", label: "Date de pièce", maximum: 6, required: true },
  { key: "pieceNumber", label: "N° pièce", maximum: 13, required: true },
  { key: "accountNumber", label: "N° compte général", maximum: 13, required: true },
  { key: "thirdParty", label: "N° compte tiers", maximum: 17, required: false },
  { key: "label", label: "Libellé écriture", maximum: 35, required: true },
  { key: "debit", label: "Montant débit", maximum: 13, required: true },
  { key: "credit", label: "Montant crédit", maximum: 13, required: true },
  { key: "dueDate", label: "Date d'échéance", maximum: 6, required: false },
  { key: "reference", label: "Référence de pièce", maximum: 17, required: false },
] as const;

export type SageOutputKind = "TXT" | "CSV" | "PNM";

export type SageTxtProfile = {
  profileType: string;
  outputKind: SageOutputKind;
  encoding: "windows-1252" | "utf-8";
  includeHeader: boolean;
  accountLength: "VARIABLE" | string | number;
  journalMappings: Record<string, string>;
  accountMappings: Record<string, string>;
  requireJournalMapping?: boolean;
};

export type SageEntryLineInput = {
  id?: string;
  position?: number;
  accountCodeSnapshot?: string | null;
  account?: { code?: string | null } | null;
  label?: string | null;
  debitCents?: unknown;
  creditCents?: unknown;
  debit?: unknown;
  credit?: unknown;
  thirdParty?: string | null;
};

export type SageEntryInput = {
  id?: string;
  number?: string | null;
  date?: string | Date | null;
  pieceNumber?: string | null;
  label?: string | null;
  journalCodeSnapshot?: string | null;
  journal?: { code?: string | null } | null;
  lines?: SageEntryLineInput[];
};

export type SageTxtRow = {
  entryId: string;
  sourceJournalCode: string;
  rawPieceNumber: string;
  rawAccountNumber: string;
  journalCode: string;
  date: string;
  pieceNumber: string;
  accountNumber: string;
  thirdParty: string;
  label: string;
  debitCents: string;
  creditCents: string;
  debit: string;
  credit: string;
  dueDate: string;
  reference: string;
};

export type SageTxtValidation = {
  errors: string[];
  warnings: string[];
  totalDebitCents: string;
  totalCreditCents: string;
  differenceCents: string;
};

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function exactCents(value: unknown, decimalFallback: unknown, label: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim()).toString();

  const text = String(decimalFallback ?? "0").trim().replace(",", ".");
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`${label} n'est pas un montant décimal exact à deux chiffres.`);
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return `${match[1] === "-" ? "-" : ""}${cents}`;
}

export function formatSageDate(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) return "";
  const year = String(parsed.getUTCFullYear()).slice(-2);
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${day}${month}${year}`;
}

export function formatSageAmountFromCents(value: unknown): string {
  const cents = typeof value === "bigint" ? value : BigInt(String(value ?? "0"));
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  return `${negative ? "-" : ""}${magnitude / 100n},${String(magnitude % 100n).padStart(2, "0")}`;
}

export function sanitizeSagePieceNumber(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
}

export function normalizeSagePhysicalText(value: unknown): string {
  const withoutControls = Array.from(String(value ?? ""), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  return withoutControls
    .replace(/;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mappedValue(mappings: Record<string, string> | undefined, source: string) {
  if (!mappings || !Object.prototype.hasOwnProperty.call(mappings, source)) return source;
  return String(mappings[source] ?? "").trim();
}

export function buildSageTxtRows(entries: SageEntryInput[], profile: SageTxtProfile): SageTxtRow[] {
  return entries.flatMap((entry, entryIndex) => {
    const sourceJournalCode = String(entry.journalCodeSnapshot ?? entry.journal?.code ?? "").trim();
    const rawPieceNumber = String(entry.pieceNumber ?? entry.number ?? "").trim();
    const entryId = String(entry.id ?? `entry-${entryIndex + 1}`);

    return (entry.lines ?? []).map((line, lineIndex) => {
      const rawAccountNumber = String(line.accountCodeSnapshot ?? line.account?.code ?? "").trim();
      const debitCents = exactCents(line.debitCents, line.debit, `Le débit de la ligne ${lineIndex + 1}`);
      const creditCents = exactCents(line.creditCents, line.credit, `Le crédit de la ligne ${lineIndex + 1}`);
      return {
        entryId,
        sourceJournalCode,
        rawPieceNumber,
        rawAccountNumber,
        journalCode: mappedValue(profile.journalMappings, sourceJournalCode),
        date: formatSageDate(entry.date),
        pieceNumber: sanitizeSagePieceNumber(rawPieceNumber),
        accountNumber: mappedValue(profile.accountMappings, rawAccountNumber),
        thirdParty: normalizeSagePhysicalText(line.thirdParty),
        label: normalizeSagePhysicalText(line.label || entry.label),
        debitCents,
        creditCents,
        debit: formatSageAmountFromCents(debitCents),
        credit: formatSageAmountFromCents(creditCents),
        dueDate: "",
        reference: normalizeSagePhysicalText(entry.number ?? entry.pieceNumber),
      };
    });
  });
}

function configuredAccountLength(value: SageTxtProfile["accountLength"]): number | null {
  if (value === "VARIABLE" || value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 13 ? parsed : null;
}

function rowFields(row: SageTxtRow): string[] {
  return [
    row.journalCode,
    row.date,
    row.pieceNumber,
    row.accountNumber,
    row.thirdParty,
    row.label,
    row.debit,
    row.credit,
    row.dueDate,
    row.reference,
  ];
}

export function buildSageTxtLine(row: SageTxtRow): string {
  return rowFields(row).join(SAGE_TXT_SEPARATOR);
}

export function buildSageTxtLines(rows: SageTxtRow[], includeHeader = false): string[] {
  const body = rows.map(buildSageTxtLine);
  if (!includeHeader) return body;
  return [SAGE_TXT_FIELDS.map((field) => field.label).join(SAGE_TXT_SEPARATOR), ...body];
}

export function validateSageTxtExport(
  entries: SageEntryInput[],
  rows: SageTxtRow[],
  profile: SageTxtProfile,
): SageTxtValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const accountLength = configuredAccountLength(profile.accountLength);

  if (profile.outputKind === "PNM") {
    errors.push("Export PNM bloqué : Wheat ne possède pas encore de schéma de positions PNM vérifié.");
  }
  if (!entries.length || !rows.length) errors.push("Aucune écriture comptabilisée à exporter pour cette société.");

  const entryTotals = new Map<string, { debit: bigint; credit: bigint; label: string }>();
  const pieceSources = new Map<string, string>();
  let totalDebit = 0n;
  let totalCredit = 0n;

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const prefix = `Ligne ${rowNumber}`;
    const debit = BigInt(row.debitCents);
    const credit = BigInt(row.creditCents);
    totalDebit += debit;
    totalCredit += credit;

    const entryTotal = entryTotals.get(row.entryId) ?? { debit: 0n, credit: 0n, label: row.rawPieceNumber || row.entryId };
    entryTotal.debit += debit;
    entryTotal.credit += credit;
    entryTotals.set(row.entryId, entryTotal);

    if (profile.requireJournalMapping !== false && !Object.prototype.hasOwnProperty.call(profile.journalMappings ?? {}, row.sourceJournalCode)) {
      errors.push(`${prefix} — Journal ${row.sourceJournalCode || "vide"} non mappé dans le profil Sage.`);
    }

    SAGE_TXT_FIELDS.forEach((field, fieldIndex) => {
      const value = rowFields(row)[fieldIndex];
      if (field.required && !value) errors.push(`${prefix} — ${field.label} est obligatoire.`);
      if (value.length > field.maximum) {
        errors.push(`${prefix} — ${field.label} trop long. Valeur : ${value}. Longueur : ${value.length}. Maximum Sage : ${field.maximum}.`);
      }
    });

    if (!/^\d{6}$/.test(row.date)) errors.push(`${prefix} — Date de pièce invalide : ${row.date || "vide"}. Format attendu : DDMMYY.`);
    if (row.dueDate && !/^\d{6}$/.test(row.dueDate)) errors.push(`${prefix} — Date d'échéance invalide : ${row.dueDate}. Format attendu : DDMMYY.`);
    if (!/^[A-Za-z0-9]+$/.test(row.pieceNumber)) errors.push(`${prefix} — N° pièce incompatible après normalisation : ${row.pieceNumber || "vide"}.`);
    if (!/^\d+(?:,\d{2})$/.test(row.debit) || !/^\d+(?:,\d{2})$/.test(row.credit)) {
      errors.push(`${prefix} — Débit/crédit doivent utiliser une virgule et exactement deux décimales.`);
    }
    if (debit < 0n || credit < 0n || (debit === 0n && credit === 0n) || (debit > 0n && credit > 0n)) {
      errors.push(`${prefix} — Une ligne ordinaire doit porter un montant positif sur un seul côté.`);
    }
    if (accountLength !== null && row.accountNumber.length !== accountLength) {
      errors.push(`${prefix} — Compte ${row.accountNumber || "vide"} incompatible. Longueur attendue : ${accountLength}. Longueur actuelle : ${row.accountNumber.length}.`);
    }

    const existingRawPiece = pieceSources.get(row.pieceNumber);
    if (existingRawPiece && existingRawPiece !== row.rawPieceNumber) {
      errors.push(`${prefix} — Collision N° pièce après normalisation : ${existingRawPiece} et ${row.rawPieceNumber} deviennent ${row.pieceNumber}.`);
    } else if (row.pieceNumber) {
      pieceSources.set(row.pieceNumber, row.rawPieceNumber);
    }

    const physicalLine = buildSageTxtLine(row);
    if (physicalLine.split(SAGE_TXT_SEPARATOR).length !== 10 || (physicalLine.match(/;/g) ?? []).length !== 9) {
      errors.push(`${prefix} — La ligne Sage doit contenir exactement 10 champs et 9 points-virgules.`);
    }
    if (/[\r\n\t]/.test(physicalLine)) errors.push(`${prefix} — La ligne contient un caractère de contrôle incompatible.`);
  });

  for (const total of entryTotals.values()) {
    if (total.debit !== total.credit) {
      errors.push(`${total.label} — écriture déséquilibrée de ${formatSageAmountFromCents(total.debit - total.credit)}.`);
    }
  }
  if (totalDebit !== totalCredit) {
    errors.push(`Export Sage impossible — total débit ${formatSageAmountFromCents(totalDebit)}, total crédit ${formatSageAmountFromCents(totalCredit)}, écart ${formatSageAmountFromCents(totalDebit - totalCredit)}.`);
  }
  if (rows.some((row) => !row.thirdParty)) {
    warnings.push("Certaines lignes n'ont pas de compte tiers. Vérifiez que ces comptes sont bien généraux dans le dossier Sage cible.");
  }
  warnings.push("Les codes journaux et comptes doivent exister dans le dossier Sage cible ; Wheat ne les crée jamais automatiquement.");

  return {
    errors: unique(errors),
    warnings: unique(warnings),
    totalDebitCents: totalDebit.toString(),
    totalCreditCents: totalCredit.toString(),
    differenceCents: (totalDebit - totalCredit).toString(),
  };
}

export function encodeSageWindows1252(text: string): Uint8Array {
  const extensionMap: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
    0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
    0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };
  return Uint8Array.from(Array.from(text).map((character) => {
    const code = character.charCodeAt(0);
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) return code;
    return extensionMap[code] ?? 0x3f;
  }));
}

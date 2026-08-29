const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { require: tsxRequire } = require("tsx/cjs/api");

const root = process.env.ATLAS_LEDGER_CWD ?? path.resolve(__dirname, "..");
let sage;
let decimal;

test.beforeAll(async () => {
  sage = tsxRequire(path.join(root, "src", "lib", "sageTxt.ts"), __filename);
  decimal = tsxRequire(path.join(root, "src", "lib", "exactDecimal.ts"), __filename);
});

function profile(overrides = {}) {
  return {
    profileType: "Sage 100 TXT — test",
    outputKind: "TXT",
    encoding: "windows-1252",
    includeHeader: false,
    accountLength: "VARIABLE",
    journalMappings: { VE: "VTE" },
    accountMappings: {},
    requireJournalMapping: true,
    ...overrides,
  };
}

function entry(overrides = {}) {
  return {
    id: "entry-1",
    number: "VE-2026-000001",
    date: "2026-05-29T00:00:00.000Z",
    pieceNumber: "FA-2026/0001",
    label: "Vente locale",
    journalCodeSnapshot: "VE",
    lines: [
      { id: "line-1", accountCodeSnapshot: "342100", label: "Client à facturer", debitCents: "1300000", creditCents: "0" },
      { id: "line-2", accountCodeSnapshot: "712000", label: "Prestation", debitCents: "0", creditCents: "1300000" },
    ],
    ...overrides,
  };
}

test("dates, amounts, piece identifiers, and exact UI decimals are deterministic", () => {
  expect(sage.formatSageDate("2026-05-29T00:00:00.000Z")).toBe("290526");
  expect(sage.formatSageDate("2026-05-30T00:00:00.000Z")).toBe("300526");
  expect(sage.formatSageAmountFromCents("1300000")).toBe("13000,00");
  expect(sage.formatSageAmountFromCents("260000")).toBe("2600,00");
  expect(sage.formatSageAmountFromCents("2083333")).toBe("20833,33");
  expect(sage.formatSageAmountFromCents("416667")).toBe("4166,67");
  expect(sage.formatSageAmountFromCents("0")).toBe("0,00");
  expect(sage.sanitizeSagePieceNumber("FR-9876")).toBe("FR9876");
  expect(sage.sanitizeSagePieceNumber("FA-2026-1287")).toBe("FA20261287");
  expect(sage.sanitizeSagePieceNumber("VIR-BMCI-156")).toBe("VIRBMCI156");
  expect(sage.sanitizeSagePieceNumber("OD-245")).toBe("OD245");
  expect(sage.sanitizeSagePieceNumber("Pièce n° 7")).toBe("Piecen7");
  expect(decimal.parseExactDecimalCents("0.01")).toBe(1n);
  expect(decimal.parseExactDecimalCents("20 833,33".replace(" ", ""))).toBe(2_083_333n);
  expect(decimal.exactDecimalFromCents(2_083_333n)).toBe("20833.33");
  expect(decimal.formatExactCentsForUi(2_083_333n)).toBe("20 833,33 MAD");
  expect(() => decimal.parseExactDecimalCents("1.001")).toThrow(/deux décimales/i);
});

test("TXT rows use exactly ten fixed-position semicolon fields and no header by default", () => {
  const entries = [entry()];
  const rows = sage.buildSageTxtRows(entries, profile());
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    journalCode: "VTE",
    date: "290526",
    pieceNumber: "FA20260001",
    accountNumber: "342100",
    thirdParty: "",
    debit: "13000,00",
    credit: "0,00",
    dueDate: "",
    reference: "VE-2026-000001",
  });
  const lines = sage.buildSageTxtLines(rows);
  expect(lines).toHaveLength(2);
  expect(lines[0].split(";")).toEqual([
    "VTE", "290526", "FA20260001", "342100", "", "Client à facturer", "13000,00", "0,00", "", "VE-2026-000001",
  ]);
  expect((lines[0].match(/;/g) ?? [])).toHaveLength(9);
  expect(lines[0]).not.toMatch(/[\r\n\t]/);

  const withHeader = sage.buildSageTxtLines(rows, true);
  expect(withHeader).toHaveLength(3);
  expect(withHeader[0].split(";")).toHaveLength(10);
  expect(withHeader[0]).toContain("Code journal;Date de pièce;N° pièce");
});

test("validation checks mappings, field limits, exact balance, and account policy", () => {
  const entries = [entry()];
  const validProfile = profile();
  const rows = sage.buildSageTxtRows(entries, validProfile);
  const valid = sage.validateSageTxtExport(entries, rows, validProfile);
  expect(valid.errors).toEqual([]);
  expect(valid).toMatchObject({ totalDebitCents: "1300000", totalCreditCents: "1300000", differenceCents: "0" });

  const unmappedProfile = profile({ journalMappings: {} });
  expect(sage.validateSageTxtExport(entries, sage.buildSageTxtRows(entries, unmappedProfile), unmappedProfile).errors.join("\n")).toMatch(/journal VE non mappé/i);

  const fixedProfile = profile({ accountLength: "8", accountMappings: { "342100": "03421000", "712000": "07120000" } });
  expect(sage.validateSageTxtExport(entries, sage.buildSageTxtRows(entries, fixedProfile), fixedProfile).errors).toEqual([]);
  const wrongLengthProfile = profile({ accountLength: "8" });
  expect(sage.validateSageTxtExport(entries, sage.buildSageTxtRows(entries, wrongLengthProfile), wrongLengthProfile).errors.join("\n")).toMatch(/longueur attendue : 8/i);

  const longLabelEntries = [entry({ lines: entry().lines.map((line) => ({ ...line, label: "X".repeat(36) })) })];
  expect(sage.validateSageTxtExport(longLabelEntries, sage.buildSageTxtRows(longLabelEntries, validProfile), validProfile).errors.join("\n")).toMatch(/Libellé écriture trop long.*Maximum Sage : 35/i);

  const unbalancedEntries = [entry({ lines: [entry().lines[0], { ...entry().lines[1], creditCents: "1299999" }] })];
  expect(sage.validateSageTxtExport(unbalancedEntries, sage.buildSageTxtRows(unbalancedEntries, validProfile), validProfile).errors.join("\n")).toMatch(/déséquilibrée/i);
});

test("every Sage field accepts its maximum width and blocks one character above it", () => {
  const entries = [entry()];
  const validProfile = profile();
  const baseRows = sage.buildSageTxtRows(entries, validProfile);

  for (const field of sage.SAGE_TXT_FIELDS) {
    const valueAtMaximum = "X".repeat(field.maximum);
    const rowsAtMaximum = baseRows.map((row, index) => index === 0 ? { ...row, [field.key]: valueAtMaximum } : row);
    const maximumErrors = sage.validateSageTxtExport(entries, rowsAtMaximum, validProfile).errors;
    expect(maximumErrors.some((message) => message.includes(`${field.label} trop long`)), field.label).toBe(false);

    const rowsOverMaximum = baseRows.map((row, index) => index === 0 ? { ...row, [field.key]: `${valueAtMaximum}X` } : row);
    const overErrors = sage.validateSageTxtExport(entries, rowsOverMaximum, validProfile).errors;
    expect(overErrors.some((message) => message.includes(`${field.label} trop long`) && message.includes(`Maximum Sage : ${field.maximum}`)), field.label).toBe(true);
  }
});

test("piece normalization collisions and unverified PNM are blocking", () => {
  const entries = [
    entry({ id: "entry-a", pieceNumber: "FR-1" }),
    entry({ id: "entry-b", number: "VE-2026-000002", pieceNumber: "FR1" }),
  ];
  const txtProfile = profile();
  const collision = sage.validateSageTxtExport(entries, sage.buildSageTxtRows(entries, txtProfile), txtProfile);
  expect(collision.errors.join("\n")).toMatch(/Collision N° pièce.*FR-1.*FR1.*FR1/i);

  const pnmProfile = profile({ outputKind: "PNM" });
  const pnm = sage.validateSageTxtExport([entry()], sage.buildSageTxtRows([entry()], pnmProfile), pnmProfile);
  expect(pnm.errors.join("\n")).toMatch(/Export PNM bloqué.*schéma de positions PNM vérifié/i);
});

test("Windows-1252 encoding preserves French characters and known extension bytes", () => {
  expect(Array.from(sage.encodeSageWindows1252("é€—"))).toEqual([0xe9, 0x80, 0x97]);
  expect(Array.from(sage.encodeSageWindows1252("🙂"))).toEqual([0x3f]);
  const decoder = new TextDecoder("windows-1252");
  for (const phrase of ["TVA récupérable", "Règlement", "TVA facturée", "Échéance"]) {
    const encoded = sage.encodeSageWindows1252(phrase);
    expect(Array.from(encoded)).not.toContain(0x3f);
    expect(decoder.decode(encoded)).toBe(phrase);
  }
});

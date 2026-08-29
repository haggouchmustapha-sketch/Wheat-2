import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "electron";
import { closePaddleOcrWorker, recognizeWithPaddle } from "./paddleOcr";

type ExistingDocument = {
  id: string;
  title: string;
  type: string;
  extracted: string;
};

type FieldResult = {
  value: string | number | null;
  confidence: number;
  raw?: string;
  source?: string;
};

type WheatOcrPage = {
  page: number;
  text: string;
  confidence: number;
  engine: string;
  preprocessing: string[];
  words: WheatWord[];
  tables?: string[][][];
  candidates?: Array<{ engine: string; confidence: number }>;
};

type WheatWord = {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
};

type WheatOcrOutput = {
  text: string;
  confidence: number;
  engine: string;
  pages: WheatOcrPage[];
  tables: string[][][];
  warnings: string[];
  preprocessing: string[];
  note: string;
};

type BankTransaction = {
  Date: string;
  Description: string;
  Debit: number | null;
  Credit: number | null;
  Balance: number | null;
};

type SmartOcrResult = {
  originalPath: string;
  originalName: string;
  storedPath: string;
  title: string;
  type: string;
  fiscalYear: string;
  tags: string;
  ocrText: string;
  extracted: Record<string, unknown>;
  status: string;
};

const nodeRequire = createRequire(import.meta.url);
let worker: any = null;
let sharpModule: any = null;

const engineName = "Wheat Vision OCR";
const engineVersion = "2.1.0";

const imageExtensions = new Set([".avif", ".bmp", ".gif", ".heic", ".heif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"]);
const spreadsheetExtensions = new Set([".xlsx"]);
const acceptedExtensions = new Set([".pdf", ".csv", ".txt", ...spreadsheetExtensions, ...imageExtensions]);

const documentTypeLabels: Record<string, string> = {
  INVOICE: "Facture",
  BANK_STATEMENT: "Releve bancaire",
  RECEIPT: "Recu",
  CONTRACT: "Contrat",
  PAYROLL: "Paie",
  IDENTITY: "Identite",
  TAX: "Fiscal",
  LETTER: "Courrier",
  TABLE: "Tableau",
  UNKNOWN: "Inconnu",
};

const folderNames: Record<string, string> = {
  INVOICE: "Invoices",
  BANK_STATEMENT: "Bank statements",
  RECEIPT: "Receipts",
  CONTRACT: "Contracts",
  PAYROLL: "Payroll",
  IDENTITY: "Identity docs",
  TAX: "Tax docs",
  LETTER: "Letters",
  TABLE: "Tables",
  UNKNOWN: "Unknown",
};

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const resolveUserDataDir = (app: App) => process.env.ATLAS_LEDGER_USER_DATA_DIR || app.getPath("userData");

export async function closeSmartOcrWorker() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  await closePaddleOcrWorker();
}

export async function processSmartOcrFiles(app: App, params: { companyId: string; companyName: string; filePaths: string[]; existingDocuments: ExistingDocument[] }) {
  const results: SmartOcrResult[] = [];
  const seenFingerprints = new Map<string, string>();

  for (const filePath of params.filePaths.filter(Boolean)) {
    if (!fs.existsSync(filePath)) continue;

    const extension = path.extname(filePath).toLowerCase();
    if (!acceptedExtensions.has(extension)) {
      results.push(await buildUnsupportedResult(app, params.companyName, filePath, `Format ${extension || "sans extension"} non pris en charge.`));
      continue;
    }

    const extraction = await runWheatVisionOcr(app, filePath, extension);
    const text = normalizeText(extraction.text);
    const classification = classifyDocument(text, filePath, extraction.tables);
    const structured = extractStructuredData(text, classification.type, filePath, extraction.tables, extraction.pages);
    const fingerprint = buildFingerprint(classification.type, structured.fields);
    const duplicateIds = [
      ...findExistingDuplicates(params.existingDocuments, fingerprint),
      ...(seenFingerprints.has(fingerprint) ? [seenFingerprints.get(fingerprint) as string] : []),
    ].filter(Boolean);
    seenFingerprints.set(fingerprint, filePath);

    const confidence = calculateConfidence(extraction.confidence, classification.confidence, structured.fields, structured.tableRows.length);
    const required = requiredFieldsForType(classification.type);
    const uncertainFields = Object.entries(structured.fields)
      .filter(([key, fieldItem]) => required.includes(key) && fieldItem.confidence < 72)
      .map(([key]) => key);
    const documentDate = parseDateValue(asText(structured.fields.date?.value)) ?? new Date();
    const fiscalYear = String(documentDate.getFullYear());
    const counterparty =
      asText(structured.fields.counterparty?.value) ||
      asText(structured.fields.supplier?.value) ||
      asText(structured.fields.client?.value) ||
      "Unknown";
    const storedPath = copyToSmartFolder(app, params.companyName, filePath, documentDate, classification.type, counterparty);
    const status = confidence < 78 || uncertainFields.length > 0 ? "TO_REVIEW" : "EXTRACTED";

    results.push({
      originalPath: filePath,
      originalName: path.basename(filePath),
      storedPath,
      title: path.basename(filePath),
      type: documentTypeLabels[classification.type],
      fiscalYear,
      tags: [
        "atlas-vision-ocr",
        classification.type.toLowerCase().replaceAll("_", "-"),
        `${confidence}%`,
        duplicateIds.length ? "duplicate" : "",
        uncertainFields.length ? "needs-review" : "",
      ].filter(Boolean).join(","),
      ocrText: text || extraction.note,
      extracted: {
        engine: engineName,
        engineVersion,
        stack: {
          pdf: "pdf-parse text layer + scanned-page raster fallback",
          imagePreprocessing: "sharp auto-rotate/grayscale/normalize/sharpen/threshold variants",
          recognizer: "PaddleOCR 3.7 authoritative local engine (PP-OCR for documents, PP-StructureV3 for bank tables, optional locally installed PaddleOCR-VL-1.6 fallback); tesseract.js only when PaddleOCR is unavailable or returns no usable text",
          understanding: "Wheat rules + layout and accounting-field heuristics",
        },
        language: "fra+eng+ara",
        documentType: classification.type,
        documentTypeLabel: documentTypeLabels[classification.type],
        confidence,
        ocrConfidence: extraction.confidence,
        classificationConfidence: classification.confidence,
        classificationScores: classification.scores,
        uncertainFields,
        duplicateIds,
        duplicateFingerprint: fingerprint,
        organizedPath: storedPath,
        preprocessing: extraction.preprocessing,
        warnings: extraction.warnings,
        pages: extraction.pages.map((page) => ({
          page: page.page,
          confidence: page.confidence,
          engine: page.engine,
          preprocessing: page.preprocessing,
          textLength: page.text.length,
          wordCount: page.words.length,
          tableCount: page.tables?.length ?? 0,
          candidates: page.candidates ?? [{ engine: page.engine, confidence: page.confidence }],
        })),
        layout: buildLayoutSummary(text, extraction.pages, structured.tableRows),
        fields: mapFieldValues(structured.fields),
        fieldConfidence: mapFieldConfidence(structured.fields),
        fieldRaw: mapFieldRaw(structured.fields),
        fieldSources: mapFieldSources(structured.fields),
        invoiceSchema: classification.type === "INVOICE" ? buildInvoiceSchema(structured.fields, structured.tableRows, extraction.pages) : null,
        bankTransactions: structured.bankTransactions,
        tableRows: structured.tableRows,
        freeText: text.slice(0, 32000),
      },
      status,
    });
  }

  return results;
}

async function buildUnsupportedResult(app: App, companyName: string, filePath: string, note: string): Promise<SmartOcrResult> {
  const storedPath = copyToSmartFolder(app, companyName, filePath, new Date(), "UNKNOWN", "Unsupported");
  return {
    originalPath: filePath,
    originalName: path.basename(filePath),
    storedPath,
    title: path.basename(filePath),
    type: documentTypeLabels.UNKNOWN,
    fiscalYear: String(new Date().getFullYear()),
    tags: "atlas-vision-ocr,unsupported,needs-review",
    ocrText: note,
    extracted: {
      engine: engineName,
      engineVersion,
      documentType: "UNKNOWN",
      documentTypeLabel: documentTypeLabels.UNKNOWN,
      confidence: 5,
      uncertainFields: ["freeText"],
      duplicateIds: [],
      organizedPath: storedPath,
      preprocessing: ["stored-original"],
      warnings: [note],
      fields: {},
      fieldConfidence: {},
      bankTransactions: [],
      tableRows: [],
      freeText: note,
    },
    status: "TO_REVIEW",
  };
}

async function runWheatVisionOcr(app: App, filePath: string, extension: string): Promise<WheatOcrOutput> {
  if (extension === ".txt" || extension === ".csv") {
    const text = fs.readFileSync(filePath, "utf8");
    return {
      text,
      confidence: 96,
      engine: "atlas-text-reader",
      pages: [{ page: 1, text, confidence: 96, engine: "text-reader", preprocessing: ["direct-text"], words: wordsFromText(text) }],
      tables: extension === ".csv" ? [readDelimitedTable(text)] : [],
      warnings: [],
      preprocessing: ["direct-text", "amount/date-normalized"],
      note: "",
    };
  }

  if (spreadsheetExtensions.has(extension)) return extractSpreadsheet(filePath);
  if (extension === ".pdf") return extractPdf(app, filePath);
  return extractImage(app, filePath);
}

async function extractSpreadsheet(filePath: string): Promise<WheatOcrOutput> {
  const ExcelJS = nodeRequire("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const tables: string[][][] = [];
  const textSections: string[] = [];
  for (const worksheet of workbook.worksheets) {
    const rows: string[][] = [];
    worksheet.eachRow({ includeEmpty: false }, (row: any) => {
      const cells: string[] = [];
      for (let index = 1; index <= Math.max(row.cellCount, worksheet.columnCount); index += 1) {
        cells.push(spreadsheetCellText(row.getCell(index).value));
      }
      if (cells.some(Boolean)) rows.push(cells);
    });

    if (rows.length) {
      tables.push(rows);
      textSections.push(`Feuille: ${worksheet.name}\n${rows.map((row) => row.filter(Boolean).join("; ")).join("\n")}`);
    }
  }

  const text = normalizeText(textSections.join("\n\n"));
  return {
    text,
    confidence: text.length ? 96 : 20,
    engine: "atlas-spreadsheet-reader",
    pages: [{ page: 1, text, confidence: text.length ? 96 : 20, engine: "spreadsheet-reader", preprocessing: ["xlsx-structured-reader"], words: wordsFromText(text) }],
    tables,
    warnings: [],
    preprocessing: ["xlsx-structured-reader", "table-preserved"],
    note: text ? "" : "No exploitable rows were extracted from the spreadsheet.",
  };
}

async function extractPdf(app: App, filePath: string): Promise<WheatOcrOutput> {
  const warnings: string[] = [];
  const pages: WheatOcrPage[] = [];
  const tables: string[][][] = [];
  const preprocessing = ["stored-original", "pdf-inspection"];
  const { PDFParse } = await import("pdf-parse");
  const workerUrl = resolvePdfWorkerUrl(app);
  if (workerUrl && typeof PDFParse.setWorker === "function") {
    PDFParse.setWorker(workerUrl);
    preprocessing.push("pdf-worker-local");
  } else {
    warnings.push("PDF worker was not found locally; PDF parsing may be limited.");
  }
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });

  try {
    const textResult = await parser.getText({ first: 1, last: 20 });
    const digitalText = normalizeText(textResult.text ?? "");

    try {
      const tableResult = await parser.getTable({ first: 1, last: 10 });
      for (const page of tableResult.pages ?? []) {
        for (const table of page.tables ?? []) tables.push(table.map((row: unknown[]) => row.map((cell) => String(cell ?? "").trim())));
      }
    } catch (error) {
      warnings.push(`Table extraction from PDF text layer was limited: ${errorMessage(error)}`);
    }

    if (digitalText.length >= 80) {
      pages.push({ page: 1, text: digitalText, confidence: 93, engine: "pdf-text-layer", preprocessing: ["digital-pdf-text-layer"], words: wordsFromText(digitalText) });
      return {
        text: digitalText,
        confidence: 93,
        engine: "atlas-pdf-text-layer",
        pages,
        tables,
        warnings,
        preprocessing: [...preprocessing, "digital-pdf-text-layer"],
        note: "",
      };
    }

    warnings.push("PDF has no reliable text layer; rendering pages locally and running OCR.");
    try {
      const screenshot = await parser.getScreenshot({ scale: 2.2, first: 1, last: 8, imageDataUrl: false, imageBuffer: true });
      let pageNo = 1;
      for (const page of screenshot.pages ?? []) {
        if (!page.data) continue;
        const pageResult = await recognizeImageWithPreprocessing(app, Buffer.from(page.data), pageNo);
        pages.push(pageResult);
        if (pageResult.tables?.length) tables.push(...pageResult.tables);
        pageNo += 1;
      }
    } catch (screenshotError) {
      warnings.push(`PDF page rendering failed: ${errorMessage(screenshotError)}`);
    }
  } catch (error) {
    warnings.push(`PDF processing failed: ${errorMessage(error)}`);
  } finally {
    await parser.destroy();
  }

  const text = mergePageText(pages);
  return {
    text,
    confidence: average(pages.map((page) => page.confidence)) || 12,
    engine: "atlas-pdf-raster-ocr",
    pages,
    tables,
    warnings,
    preprocessing: [...preprocessing, "pdf-rasterized", "image-normalized"],
    note: text ? "" : "No exploitable text was extracted from the PDF.",
  };
}

async function extractImage(app: App, filePath: string): Promise<WheatOcrOutput> {
  const warnings: string[] = [];
  try {
    const page = await recognizeImageWithPreprocessing(app, filePath, 1);
    return {
      text: page.text,
      confidence: page.confidence,
      engine: "atlas-image-ocr",
      pages: [page],
      tables: page.tables ?? [],
      warnings,
      preprocessing: page.preprocessing,
      note: "",
    };
  } catch (error) {
    warnings.push(`Image OCR failed: ${errorMessage(error)}`);
    return {
      text: "",
      confidence: 8,
      engine: "atlas-image-ocr",
      pages: [],
      tables: [],
      warnings,
      preprocessing: ["stored-original", "preprocessing-failed"],
      note: "Image was stored, but OCR failed. The document is marked for manual review.",
    };
  }
}

async function recognizeImageWithPreprocessing(app: App, input: string | Buffer, pageNo: number): Promise<WheatOcrPage> {
  const candidates: WheatOcrPage[] = [];
  const paddleWarnings: string[] = [];
  try {
    const paddleVariant = await buildPaddlePrimaryImage(input);
    const paddle = await recognizeWithPaddle(app, paddleVariant.buffer, { mode: "ocr", extension: ".png" });
    const paddleText = normalizeText(paddle.text);
    if (paddleText.length >= 8) {
      const paddleCandidate: WheatOcrPage = {
        page: pageNo,
        text: paddleText,
        confidence: paddle.confidence,
        engine: `${paddle.engine}:${paddle.engineVersion}`,
        preprocessing: [...paddleVariant.steps, "paddleocr-local-primary", ...paddle.warnings.map((warning) => `note:${warning}`)],
        words: paddle.words,
        tables: paddle.tables,
      };
      return {
        ...paddleCandidate,
        candidates: [{ engine: paddleCandidate.engine, confidence: paddleCandidate.confidence }],
      };
    }
    paddleWarnings.push(...paddle.warnings);
    paddleWarnings.push("PaddleOCR n'a retourné aucun texte exploitable; repli Tesseract local.");
  } catch (error) {
    paddleWarnings.push(`PaddleOCR indisponible; repli Tesseract local: ${errorMessage(error)}`);
  }

  const variants = await buildImageVariants(input);
  const { PSM } = nodeRequire("tesseract.js");
  const passes = [
    { name: "auto-page", psm: PSM.AUTO },
    { name: "sparse-text", psm: PSM.SPARSE_TEXT },
  ];

  for (const variant of variants) {
    for (const pass of passes) {
      const recognized = await recognizePreparedImage(app, variant.buffer, pass.psm);
      candidates.push({
        page: pageNo,
        text: recognized.text,
        confidence: recognized.confidence,
        engine: `tesseract.js:${pass.name}`,
        preprocessing: variant.steps,
        words: recognized.words,
      });

      if (recognized.confidence >= 88 && hasAccountingAnchors(recognized.text)) break;
    }

    if (bestCandidate(candidates).confidence >= 84 && hasAccountingAnchors(bestCandidate(candidates).text)) break;
  }

  const best = bestCandidate(candidates);
  const mergedText = mergeCandidateText(candidates);
  const candidateSummary = candidates.map((candidate) => ({ engine: candidate.engine, confidence: candidate.confidence }));
  return {
    ...best,
    text: mergedText.length > best.text.length + 40 ? mergedText : best.text,
    confidence: Math.round(Math.max(best.confidence, average(candidates.map((candidate) => candidate.confidence)))),
    preprocessing: [...best.preprocessing, ...paddleWarnings.map((warning) => `note:${warning}`)],
    tables: best.tables,
    candidates: candidateSummary,
  };
}

async function buildPaddlePrimaryImage(input: string | Buffer): Promise<{ buffer: Buffer; steps: string[] }> {
  const sharp = await getSharp();
  const source = sharp(input, { limitInputPixels: false }).rotate();
  const metadata = await source.metadata();
  const width = metadata.width ?? 0;
  const resizeWidth = width > 1800 ? 1800 : width > 0 && width < 1200 ? 1600 : undefined;
  const buffer = await sharp(input, { limitInputPixels: false })
    .rotate()
    .resize(resizeWidth ? { width: resizeWidth, withoutEnlargement: false } : undefined)
    .png({ compressionLevel: 3 })
    .toBuffer();
  return {
    buffer,
    steps: ["sharp-auto-rotate", resizeWidth ? `paddle-resize-width-${resizeWidth}` : "paddle-native-size", "paddle-png"],
  };
}

async function buildImageVariants(input: string | Buffer): Promise<Array<{ name: string; buffer: Buffer; steps: string[] }>> {
  const sharp = await getSharp();
  const base = sharp(input, { limitInputPixels: false }).rotate();
  const metadata = await base.metadata();
  const width = metadata.width ?? 0;
  const resizeWidth = width && width < 1700 ? 2200 : width > 3200 ? 3200 : undefined;

  const clean = sharp(input, { limitInputPixels: false })
    .rotate()
    .resize(resizeWidth ? { width: resizeWidth, withoutEnlargement: false } : undefined)
    .grayscale()
    .normalize()
    .median(1)
    .sharpen()
    .png({ compressionLevel: 6 });

  const cleanBuffer = await clean.toBuffer();
  const variants = [{
    name: "normalized",
    buffer: cleanBuffer,
    steps: ["sharp-auto-rotate", resizeWidth ? `resize-width-${resizeWidth}` : "native-size", "grayscale", "normalize", "median-denoise", "sharpen", "png"],
  }];

  const thresholdBuffer = await sharp(cleanBuffer, { limitInputPixels: false })
    .linear(1.12, -8)
    .threshold(178)
    .png({ compressionLevel: 6 })
    .toBuffer();

  variants.push({
    name: "threshold",
    buffer: thresholdBuffer,
    steps: [...variants[0].steps, "linear-contrast", "threshold-178"],
  });

  return variants;
}

async function recognizePreparedImage(app: App, image: Buffer, psm: number) {
  const activeWorker = await withTimeout(getWorker(app), 45000, "OCR worker initialization took too long.");
  await activeWorker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const result: any = await withTimeout(activeWorker.recognize(image, {}, { text: true, blocks: true, words: true }), 120000, "OCR recognition took too long.");
  const words = Array.isArray(result.data.words)
    ? result.data.words.map((word: any) => ({
      text: String(word.text ?? "").trim(),
      confidence: Math.round(Number(word.confidence ?? word.conf ?? 0)),
      bbox: word.bbox,
    })).filter((word: WheatWord) => word.text)
    : [];
  return {
    text: normalizeText(result.data.text ?? ""),
    confidence: Math.round(Number(result.data.confidence ?? average(words.map((word: WheatWord) => word.confidence)) ?? 0)),
    words,
  };
}

async function getWorker(app: App) {
  if (!worker) {
    const { createWorker } = nodeRequire("tesseract.js");
    worker = await createWorker("fra+eng+ara", 1, {
      workerPath: resolveTesseractNodeWorkerPath(app),
      langPath: resolveTessdataPath(app),
      cachePath: path.join(resolveUserDataDir(app), "ocr-cache"),
      gzip: true,
      logger: () => undefined,
    });
  }

  return worker;
}

async function getSharp() {
  if (!sharpModule) {
    const module = await import("sharp");
    sharpModule = module.default ?? module;
  }
  return sharpModule;
}

function classifyDocument(text: string, filePath: string, tables: string[][][]) {
  const source = `${path.basename(filePath)}\n${text}`.toLowerCase();
  const bankTable = looksLikeBankTable(tables, source);
  const scores: Record<string, number> = {
    INVOICE: weightedScore(source, [
      ["facture", 4], ["invoice", 4], ["total ttc", 5], ["montant ht", 5], ["hors taxe", 4], ["tva", 3], ["ice", 2], ["fournisseur", 2], ["client", 1],
    ]),
    BANK_STATEMENT: weightedScore(source, [
      ["releve bancaire", 5], ["releve-bancaire", 5], ["releve_de_compte", 5], ["releve de compte", 5], ["bank statement", 5], ["solde depart", 5], ["solde", 3], ["balance", 3], ["debit", 2], ["credit", 2], ["libelle", 2], ["valeur", 1], ["iban", 3], ["operation", 2], ["description", 1], ["attijari", 2], ["bmci", 2], ["bmce", 2], ["cih", 2],
    ]) + (bankTable ? 10 : 0),
    RECEIPT: weightedScore(source, [
      ["bon de livraison", 7], ["bl ", 2], ["code article", 4], ["designation qte", 4], ["recu", 4], ["receipt", 4], ["ticket", 3], ["caisse", 2], ["paiement", 2], ["espece", 2],
    ]),
    CONTRACT: weightedScore(source, [
      ["contrat", 5], ["convention", 4], ["bail", 4], ["accord", 2], ["signature", 2], ["conditions generales", 3],
    ]),
    PAYROLL: weightedScore(source, [
      ["bulletin de paie", 6], ["salaire brut", 4], ["net a payer", 4], ["cnss", 3], ["amo", 3], ["ir salarial", 3],
    ]),
    IDENTITY: weightedScore(source, [
      ["carte nationale", 5], ["cnie", 5], ["cin", 3], ["passport", 4], ["passeport", 4], ["date de naissance", 3],
    ]),
    TAX: weightedScore(source, [
      ["releve de deduction", 9], ["relevededuction", 9], ["edi tva", 7], ["article 112", 7], ["id_fiscal", 5], ["id fiscal", 5], ["fact_num", 5], ["date_paie", 4], ["date_fac", 4], ["declaration tva", 5], ["dgi", 5], ["direction generale des impots", 5], ["taxe professionnelle", 4], ["impot", 3], ["is", 2], ["ir", 2],
    ]),
    LETTER: weightedScore(source, [
      ["objet", 3], ["monsieur", 2], ["madame", 2], ["lettre", 3], ["courrier", 3], ["ref:", 2],
    ]),
    TABLE: tables.length ? (bankTable ? 4 : 8) : weightedScore(source, [["date description debit credit", 5], ["tableau", 3], ["spreadsheet", 4], ["colonnes", 2]]),
    UNKNOWN: 1,
  };
  const [type, rawScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return {
    type: rawScore < 4 ? "UNKNOWN" : type,
    confidence: Math.max(18, Math.min(97, 32 + rawScore * 7)),
    scores,
  };
}

function extractStructuredData(text: string, type: string, filePath: string, pdfTables: string[][][], pages: WheatOcrPage[]) {
  const supplier = type === "INVOICE" || type === "RECEIPT"
    ? findCounterparty(text, filePath, ["fournisseur", "supplier", "vendeur", "emetteur", "issuer"])
    : emptyField();
  let client = findLabeledLine(text, ["client", "customer", "destinataire", "adresse a", "adressed to"], "client");
  if (client.value && isBadCounterpartyCandidate(asText(client.value))) client = emptyField();
  const counterparty = supplier.value ? supplier : findCounterparty(text, filePath);
  const fields: Record<string, FieldResult> = {
    date: findDate(text),
    invoiceNumber: findInvoiceNumber(text),
    reference: findReference(text),
    counterparty,
    supplier,
    client,
    ice: findIdentifier(text, "ice"),
    if: findIdentifier(text, "if"),
    ht: findAmount(text, ["total ht", "montant ht", "hors taxe", "ht", "subtotal"], "ht"),
    tva: findAmount(text, ["montant tva", "total tva", "tva", "vat", "taxe"], "tva"),
    ttc: findAmount(text, ["total ttc", "net a payer", "net a paye", "ttc", "total"], "ttc"),
    paymentTerms: findPaymentTerms(text),
    dueDate: findDueDate(text),
    currency: findCurrency(text),
  };

  rebalanceAmountFields(fields);

  if (type === "PAYROLL") {
    fields.employee = findLabeledLine(text, ["salarie", "employee", "nom"], "employee");
    fields.gross = findAmount(text, ["salaire brut", "brut", "gross"], "gross");
    fields.cnss = findAmount(text, ["cnss"], "cnss");
    fields.amo = findAmount(text, ["amo"], "amo");
    fields.ir = findAmount(text, ["ir salarial", "impot sur le revenu", "ir"], "ir");
    fields.net = findAmount(text, ["net a payer", "net"], "net");
  }

  const tableRows = normalizeTables(pdfTables, text, pages);
  const bankTransactions = type === "BANK_STATEMENT" ? extractBankTransactions(text, tableRows) : [];
  return { fields, bankTransactions, tableRows };
}

function textLines(text: string) {
  return text.split(/\r?\n/).map((line) => cleanValue(line)).filter(Boolean);
}

function compactHeader(value: string) {
  return normalizeHeader(value).replace(/\s+/g, "");
}

function matchesAnyLabel(line: string, labels: string[]) {
  const normalized = normalizeHeader(line);
  const compact = compactHeader(line);
  return labels.some((label) => {
    const labelNormalized = normalizeHeader(label);
    const labelCompact = compactHeader(label);
    return normalized.startsWith(labelNormalized) || normalized.includes(` ${labelNormalized} `) || compact.includes(labelCompact);
  });
}

function valueAfterLabel(line: string) {
  const parts = line.split(/[:#=]/);
  if (parts.length < 2) return "";
  return cleanValue(parts.slice(1).join(":"));
}

function isBadCounterpartyCandidate(value: string) {
  const normalized = normalizeHeader(value);
  return !normalized
    || looksLikeAmount(value)
    || /^[0-9.,\s-]+$/.test(value)
    || /@/.test(value)
    || /\b(casablanca le|mandala|modele|model|id fiscal|id_fiscal|facture|bon de livraison|code article|designation|qte|montant|total|tva|ttc|ht|date|client|adresse|telephone|tel|email|web|www|ice|if|rc|rib|banque|bank|swift|patente|cnss)\b/.test(normalized)
    || /\b(rib|swift|iban|banque|bank)\b/.test(normalized);
}

function findDateInText(source: string, confidence: number, fieldSource: string): FieldResult {
  const numeric = source.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/);
  if (numeric) return { value: normalizeDate(numeric[1]), confidence, raw: numeric[0], source: fieldSource };

  const normalized = normalizeHeader(source);
  const french = normalized.match(/\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\s+(\d{4})\b/);
  if (!french) return emptyField();
  const months: Record<string, number> = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };
  return {
    value: `${french[3]}-${String(months[french[2]]).padStart(2, "0")}-${String(french[1]).padStart(2, "0")}`,
    confidence,
    raw: french[0],
    source: fieldSource,
  };
}

function findReferenceNearLabels(text: string, labels: string[], source: string): FieldResult {
  const lines = textLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!matchesAnyLabel(line, labels)) continue;
    const sameLineToken = extractReferenceToken(valueAfterLabel(line) || line);
    if (sameLineToken) return { value: sameLineToken, confidence: 82, raw: line, source };
    const nextLineToken = extractReferenceToken(lines[index + 1] ?? "");
    if (nextLineToken) return { value: nextLineToken, confidence: 72, raw: `${line}\n${lines[index + 1]}`, source };
  }
  return emptyField();
}

function extractReferenceToken(value: string) {
  const cleaned = cleanValue(value).replace(/\b(n|no|num|numero)\b/gi, " ");
  const alphaNumeric = cleaned.match(/\b(?=[A-Z0-9./_-]*[A-Z])(?=[A-Z0-9./_-]*\d)[A-Z0-9][A-Z0-9./_-]{3,}\b/i);
  if (alphaNumeric) return cleanValue(alphaNumeric[0]);
  const numeric = cleaned.match(/\b\d{4,}\b/);
  return numeric ? numeric[0] : "";
}

function findAmountNearLabels(text: string, labels: string[], source: string): FieldResult {
  const lines = textLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!matchesAnyLabel(line, labels)) continue;
    const normalizedLine = normalizeHeader(line);
    if (normalizedLine.includes("code article") || normalizedLine.includes("designation qte")) continue;
    const sameLine = extractAmounts(line).at(-1);
    if (sameLine !== undefined) return { value: sameLine, confidence: source === "ttc" ? 84 : 76, raw: line, source };
    const nextLine = extractAmounts(lines[index + 1] ?? "").at(-1);
    if (nextLine !== undefined) return { value: nextLine, confidence: 66, raw: `${line}\n${lines[index + 1]}`, source };
  }
  return emptyField();
}

function extractAmounts(value: string) {
  const amounts: number[] = [];
  const strictMatches = [...value.matchAll(/([0-9]{1,3}(?:\s+[0-9]{3})+(?:[.,][0-9]{2})|[0-9]+(?:[.,][0-9]{2}))(?:\s*(MAD|DHS?|EUR|USD))?/gi)];
  const matches = strictMatches.length ? strictMatches : [...value.matchAll(/([0-9][0-9\s.,']{1,18})(?:\s*(MAD|DHS?|EUR|USD))?/gi)];
  for (const match of matches) {
    const after = value.slice((match.index ?? 0) + match[1].length, (match.index ?? 0) + match[1].length + 3);
    if (after.trimStart().startsWith("%")) continue;
    const parsed = parseAmount(match[1]);
    if (parsed !== null) amounts.push(parsed);
  }
  return amounts;
}

function rebalanceAmountFields(fields: Record<string, FieldResult>) {
  const ht = Number(fields.ht.value);
  const tva = Number(fields.tva.value);
  const ttc = Number(fields.ttc.value);
  if (Number.isFinite(ht) && Number.isFinite(tva) && ht > 0 && tva >= 0) {
    const computedTtc = Number((ht + tva).toFixed(2));
    if (!Number.isFinite(ttc) || ttc <= 0 || Math.abs(ttc - tva) < 0.01 || Math.abs(ttc - computedTtc) > Math.max(2, computedTtc * 0.15)) {
      fields.ttc = { value: computedTtc, confidence: 72, raw: `${fields.ht.raw ?? ""} ${fields.tva.raw ?? ""}`.trim(), source: "computed-ht-plus-tva" };
    }
  }
}

function findDate(text: string): FieldResult {
  const labeled = findDateNearLabels(text, ["date facture", "date", "invoice date"]);
  if (labeled.value) return labeled;
  const detected = findDateInText(text, 72, "first-date");
  if (detected.value) return detected;

  const numeric = text.match(/\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}[./-]\d{1,2}[./-]\d{1,2})\b/);
  if (numeric) return { value: normalizeDate(numeric[1]), confidence: 72, raw: numeric[0], source: "first-date" };

  const french = text.match(/\b(\d{1,2})\s+(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\s+(\d{4})\b/i);
  if (!french) return emptyField();
  const months: Record<string, number> = { janvier: 1, fevrier: 2, "février": 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, "août": 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, "décembre": 12 };
  return {
    value: `${french[3]}-${String(months[french[2].toLowerCase()]).padStart(2, "0")}-${String(french[1]).padStart(2, "0")}`,
    confidence: 76,
    raw: french[0],
    source: "french-date",
  };
}

function findDateNearLabels(text: string, labels: string[]): FieldResult {
  const lines = textLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    if (!matchesAnyLabel(lines[index], labels)) continue;
    const sameLineDate = findDateInText(lines[index], 88, labels[0]);
    if (sameLineDate.value) return sameLineDate;
    const nextLineDate = findDateInText(lines[index + 1] ?? "", 78, labels[0]);
    if (nextLineDate.value) return nextLineDate;
  }

  for (const label of labels) {
    const regex = new RegExp(`${escapeRegex(label)}\\s*[:=\\-]?\\s*(\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|\\d{4}[./-]\\d{1,2}[./-]\\d{1,2})`, "i");
    const match = text.match(regex);
    if (match) return { value: normalizeDate(match[1]), confidence: 86, raw: match[0], source: label };
  }
  return emptyField();
}

function findDueDate(text: string): FieldResult {
  return findDateNearLabels(text, ["echeance", "échéance", "due date", "date limite", "payable le"]);
}

function findInvoiceNumber(text: string): FieldResult {
  const labeled = findReferenceNearLabels(text, ["facture", "invoice", "n facture", "numero facture", "no facture", "reference facture", "ref", "reference"], "invoiceNumber");
  if (labeled.value) return labeled;

  const labels = ["facture", "invoice", "n facture", "numero facture", "no facture", "reference facture"];
  for (const label of labels) {
    const regex = new RegExp(`${escapeRegex(label)}\\s*(?:n|no|num|numero|°|\\.)*\\s*[:#\\-]?\\s*([A-Z0-9][A-Z0-9./_\\-]{2,})`, "i");
    const match = text.match(regex);
    if (match) return { value: cleanValue(match[1]), confidence: 78, raw: match[0], source: label };
  }
  const generic = text.match(/\b([A-Z]{1,4}[-/]\d{2,4}[-/][A-Z0-9]{2,8}|[A-Z]{1,4}[-/]\d{3,8})\b/);
  return generic ? { value: generic[1], confidence: 58, raw: generic[0], source: "document-reference-pattern" } : emptyField();
}

function findReference(text: string): FieldResult {
  const labeled = findReferenceNearLabels(text, ["reference", "ref", "piece", "bon", "order"], "reference");
  if (labeled.value) return labeled;
  const line = findLabeledLine(text, ["reference", "ref", "piece", "bon", "order"], "reference");
  if (line.value) return line;
  return findInvoiceNumber(text);
}

function findCounterparty(text: string, filePath: string, preferredLabels = ["fournisseur", "supplier", "vendeur", "client", "societe", "société", "raison sociale", "raison social"]): FieldResult {
  for (const label of preferredLabels) {
    const result = findLabeledLine(text, [label], label);
    if (result.value && !looksLikeAmount(asText(result.value))) return { ...result, confidence: Math.max(result.confidence, 76) };
  }

  const lines = textLines(text).filter((line) => line.length >= 3 && line.length <= 90);
  const headerCandidate = lines.slice(0, 14).find((line) => !isBadCounterpartyCandidate(line) && /[A-Za-z]{4,}/.test(line));
  if (headerCandidate) return { value: headerCandidate, confidence: 58, raw: headerCandidate, source: "document-header" };
  const legal = lines.find((line) => !isBadCounterpartyCandidate(line) && /\b(sarl|sa|sas|sasu|sarl au|ste|societe|company|telecom|office|group|groupe)\b/i.test(line));
  if (legal) return { value: legal, confidence: 62, raw: legal, source: "legal-form-line" };

  return {
    value: path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ").slice(0, 80),
    confidence: 36,
    source: "filename",
  };
}

function findLabeledLine(text: string, labels: string[], source: string): FieldResult {
  const lines = textLines(text);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!matchesAnyLabel(line, labels)) continue;
    const inline = valueAfterLabel(line);
    if (inline && !isBadCounterpartyCandidate(inline)) return { value: inline, confidence: 76, raw: line, source };
    if (normalizeHeader(line).includes("code client")) continue;

    for (let offset = 1; offset <= 4; offset += 1) {
      const next = cleanValue(lines[index + offset] ?? "");
      if (!next) continue;
      if (matchesAnyLabel(next, labels)) continue;
      if (isBadCounterpartyCandidate(next)) continue;
      return { value: next, confidence: 76, raw: `${line}\n${next}`, source };
    }
  }

  for (const label of labels) {
    const regex = new RegExp(`${escapeRegex(label)}\\s*[:#=\\-]?\\s*([^\\n\\r]{2,120})`, "i");
    const match = text.match(regex);
    if (match) return { value: cleanValue(match[1]), confidence: 68, raw: match[0], source };
  }
  return emptyField();
}

function findIdentifier(text: string, kind: "ice" | "if"): FieldResult {
  const regex = kind === "ice"
    ? /(?:\bI\s*\.?\s*C\s*\.?\s*E\b|identifiant commun de l'entreprise)\s*(?:n|no|num|numero|n°)?\s*[:#=-]?\s*([0-9\s]{10,18})/i
    : /(?:\bI\s*\.?\s*F\b|identifiant fiscal)\s*(?:n|no|num|numero|n°)?\s*[:#=-]?\s*([0-9\s]{5,12})/i;
  const match = text.match(regex);
  if (!match) return emptyField();
  return { value: match[1].replace(/\s/g, ""), confidence: kind === "ice" ? 92 : 86, raw: match[0], source: kind.toUpperCase() };
}

function findAmount(text: string, labels: string[], source: string): FieldResult {
  const normalizedText = normalizeAccountingAbbreviations(text);
  const amount = "([0-9][0-9\\s.,']{1,18})(?!\\s*%)";
  const priorityLabels = source === "ht"
    ? ["total ht", "montant ht"]
    : source === "tva"
      ? ["total tva", "montant tva"]
      : source === "ttc"
        ? ["total ttc", "net a payer", "montant ttc"]
        : [];
  if (priorityLabels.length) {
    const priorityMatch = findAmountNearLabels(normalizedText, priorityLabels, source);
    if (priorityMatch.value !== null) return priorityMatch;
  }
  const lineMatch = findAmountNearLabels(normalizedText, labels, source);
  if (lineMatch.value !== null) return lineMatch;
  for (const label of labels) {
    const after = new RegExp(`${escapeRegex(label)}\\s*(?:[0-9]{1,2}(?:[.,][0-9]+)?\\s*%)?\\s*[:=\\-]?\\s*${amount}\\s*(?:mad|dh|dhs|eur|usd)?`, "i");
    const before = new RegExp(`${amount}\\s*(?:mad|dh|dhs|eur|usd)?\\s*${escapeRegex(label)}`, "i");
    const match = normalizedText.match(after) ?? normalizedText.match(before);
    if (!match) continue;
    const parsed = parseAmount(match[1]);
    if (parsed !== null) return { value: parsed, confidence: source === "ttc" ? 84 : 76, raw: match[0], source };
  }
  return emptyField();
}

function findPaymentTerms(text: string): FieldResult {
  const labeled = findLabeledLine(text, ["conditions de paiement", "mode de paiement", "payment terms", "reglement", "règlement"], "paymentTerms");
  if (labeled.value) return labeled;
  if (/virement/i.test(text)) return { value: "Virement", confidence: 68, source: "keyword" };
  if (/cheque|chèque/i.test(text)) return { value: "Cheque", confidence: 68, source: "keyword" };
  if (/espece|espèce|cash/i.test(text)) return { value: "Espece", confidence: 68, source: "keyword" };
  return emptyField();
}

function findCurrency(text: string): FieldResult {
  if (/\b(MAD|DHS?|DIRHAM|DIRHAMS)\b/i.test(text)) return { value: "MAD", confidence: 92, source: "currency-keyword" };
  if (/\bEUR\b|€/i.test(text)) return { value: "EUR", confidence: 92, source: "currency-keyword" };
  if (/\bUSD\b|\$/i.test(text)) return { value: "USD", confidence: 92, source: "currency-keyword" };
  return { value: "MAD", confidence: 62, source: "default-morocco" };
}

function extractBankTransactions(text: string, tableRows: string[][] = []) {
  const tableTransactions = extractBankTransactionsFromTable(tableRows);
  if (tableTransactions.length) return tableTransactions;

  const rows: BankTransaction[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s+(.{4,90}?)\s+(-?[0-9][0-9\s.,']*)\s+(-?[0-9][0-9\s.,']*)?\s+(-?[0-9][0-9\s.,']*)?$/);
    if (!match) continue;
    const first = parseAmount(match[3]);
    const second = match[4] ? parseAmount(match[4]) : null;
    const third = match[5] ? parseAmount(match[5]) : null;
    rows.push({
      Date: normalizeDate(match[1]),
      Description: cleanValue(match[2]),
      Debit: second === null && first !== null && first < 0 ? Math.abs(first) : first,
      Credit: second,
      Balance: third,
    });
  }
  return rows.slice(0, 1000);
}

function extractBankTransactionsFromTable(tableRows: string[][]): BankTransaction[] {
  const headerIndex = tableRows.findIndex((row) => {
    const joined = normalizeHeader(row.join(" "));
    return joined.includes("date") && (joined.includes("debit") || joined.includes("credit")) && (joined.includes("solde") || joined.includes("balance") || joined.includes("description") || joined.includes("libelle"));
  });
  if (headerIndex < 0) return [];

  const header = tableRows[headerIndex].map(normalizeHeader);
  const contextYear = extractContextYear(tableRows.slice(0, headerIndex + 1));
  const findIndex = (patterns: RegExp[], fallback: number) => {
    const found = header.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
    return found >= 0 ? found : fallback;
  };

  const dateIndex = findIndex([/date/], 0);
  const descriptionIndex = findIndex([/description/, /libelle/, /operation/, /details?/], 1);
  const debitIndex = findIndex([/debit/, /debit mad/, /sortie/], -1);
  const creditIndex = findIndex([/credit/, /credit mad/, /entree/], -1);
  const balanceIndex = findIndex([/solde/, /balance/], -1);

  return tableRows
    .slice(headerIndex + 1)
    .map((row) => {
      const date = row[dateIndex] ? normalizeBankDate(row[dateIndex], row.join(" "), contextYear) : "";
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const debit = debitIndex >= 0 ? parseAmount(row[debitIndex] ?? "") : null;
      const credit = creditIndex >= 0 ? parseAmount(row[creditIndex] ?? "") : null;
      const balance = balanceIndex >= 0 ? parseAmount(row[balanceIndex] ?? "") : null;
      return {
        Date: date,
        Description: cleanValue(row[descriptionIndex] ?? ""),
        Debit: debit,
        Credit: credit,
        Balance: balance,
      };
    })
    .filter((row): row is BankTransaction => Boolean(row && row.Description && (row.Debit !== null || row.Credit !== null || row.Balance !== null)))
    .slice(0, 1000);
}

function extractContextYear(rows: string[][]) {
  for (const row of rows) {
    const match = row.join(" ").match(/\b(20\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return new Date().getFullYear();
}

function normalizeBankDate(value: string, rowText: string, fallbackYear: number) {
  const fullDate = rowText.match(/\b(\d{1,2})[ /.-](\d{1,2})[ /.-](20\d{2}|\d{2})\b/);
  if (fullDate && /[ /.-]/.test(value) && value.trim().split(/[ /.-]+/).length >= 3) return normalizeDate(fullDate[0]);
  const parts = value.trim().match(/^(\d{1,2})[ /.-](\d{1,2})(?:[ /.-](20\d{2}|\d{2}))?$/);
  if (parts) {
    const year = parts[3] ? (parts[3].length === 2 ? `20${parts[3]}` : parts[3]) : String(fallbackYear);
    return `${year}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  }
  return normalizeDate(value);
}

function normalizeTables(pdfTables: string[][][], text: string, pages: WheatOcrPage[]) {
  const rows: string[][] = [];
  for (const table of pdfTables) {
    for (const row of table) rows.push(row.map((cell) => cleanValue(cell)));
  }
  const deductionRows = extractTaxDeductionRows(text);
  if (deductionRows.length) rows.push(...deductionRows);
  if (rows.length) return rows.slice(0, 1000);

  const lineRows = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(\s{2,}|\||;|\t)/.test(line))
    .map((line) => line.split(/\s{2,}|\||;|\t/).map((cell) => cleanValue(cell)).filter(Boolean))
    .filter((row) => row.length >= 3);
  if (lineRows.length) return lineRows.slice(0, 1000);

  const wordRows = rowsFromWordGeometry(pages);
  return wordRows.slice(0, 1000);
}

function extractTaxDeductionRows(text: string) {
  if (!/(fact_num|date_paie|date_fac|releve de deduction|relevededuction|article 112)/i.test(normalizeHeader(text))) return [];
  const rows: string[][] = [[
    "Ordre",
    "Facture",
    "Designation",
    "HT",
    "TVA",
    "TTC",
    "IF",
    "Fournisseur",
    "ICE",
    "Taux",
    "Paiement",
    "Date paiement",
    "Date facture",
  ]];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = cleanValue(rawLine.replace(/[\u200e\u200f\u202a-\u202e]/g, " "));
    const withOrder = line.match(/^\D*(\d{1,4})\s+([A-Z0-9][A-Z0-9/-]{3,})\s+(.+?)\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9]{5,12})\s+(.+?)\s+([0-9]{10,18})\s+([0-9]{1,2}\.\d{2})\s+([0-9])\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/i);
    const withoutOrder = line.match(/^\D*([A-Z0-9][A-Z0-9/-]{3,})\s+(.+?)\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9][0-9 ]*\.\d{2})\s+([0-9]{5,12})\s+(.+?)\s+([0-9]{10,18})\s+([0-9]{1,2}\.\d{2})\s+([0-9])\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\D*(\d{1,4})?$/i);
    if (withOrder) {
      rows.push([
        withOrder[1],
        withOrder[2],
        cleanValue(withOrder[3]),
        String(parseAmount(withOrder[4]) ?? ""),
        String(parseAmount(withOrder[5]) ?? ""),
        String(parseAmount(withOrder[6]) ?? ""),
        withOrder[7],
        cleanValue(withOrder[8]),
        withOrder[9],
        withOrder[10],
        withOrder[11],
        normalizeDate(withOrder[12]),
        normalizeDate(withOrder[13]),
      ]);
    } else if (withoutOrder) {
      rows.push([
        withoutOrder[13] ?? "",
        withoutOrder[1],
        cleanValue(withoutOrder[2]),
        String(parseAmount(withoutOrder[3]) ?? ""),
        String(parseAmount(withoutOrder[4]) ?? ""),
        String(parseAmount(withoutOrder[5]) ?? ""),
        withoutOrder[6],
        cleanValue(withoutOrder[7]),
        withoutOrder[8],
        withoutOrder[9],
        withoutOrder[10],
        normalizeDate(withoutOrder[11]),
        normalizeDate(withoutOrder[12]),
      ]);
    }
  }

  return rows.length > 1 ? rows : [];
}

function rowsFromWordGeometry(pages: WheatOcrPage[]) {
  const rows: string[][] = [];
  for (const page of pages) {
    const words = page.words.filter((word) => word.bbox && word.confidence >= 35);
    const buckets = new Map<number, WheatWord[]>();
    for (const word of words) {
      const y = Math.round(((word.bbox!.y0 + word.bbox!.y1) / 2) / 14) * 14;
      buckets.set(y, [...(buckets.get(y) ?? []), word]);
    }
    for (const bucket of [...buckets.values()]) {
      const line = bucket.sort((a, b) => (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0)).map((word) => word.text).join(" ");
      if (!/\d/.test(line)) continue;
      const cells = line.split(/\s{2,}/).map((cell) => cleanValue(cell)).filter(Boolean);
      if (cells.length >= 3) rows.push(cells);
    }
  }
  return rows;
}

function buildLayoutSummary(text: string, pages: WheatOcrPage[], tableRows: string[][]) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const words = pages.reduce((sum, page) => sum + page.words.length, 0) || text.split(/\s+/).filter(Boolean).length;
  return {
    pages: pages.length || 1,
    lineCount: lines.length,
    wordCount: words,
    tableRowCount: tableRows.length,
    hasTables: tableRows.length > 0,
    readingOrder: "top-to-bottom",
  };
}

function decimalCents(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const source = String(value).trim().replace(/[\s']/g, "");
  const negative = /^-/.test(source) || /^\(.*\)$/.test(source);
  const unsigned = source.replace(/[()\-+]/g, "").replace(/[^0-9.,]/g, "");
  if (!unsigned) return null;
  const decimalSeparator = unsigned.includes(",") && unsigned.lastIndexOf(",") > unsigned.lastIndexOf(".") ? "," : ".";
  const parts = unsigned.split(decimalSeparator);
  const fractionCandidate = parts.length > 1 ? parts.at(-1)! : "";
  const hasDecimal = fractionCandidate.length > 0 && fractionCandidate.length <= 2;
  const whole = (hasDecimal ? parts.slice(0, -1).join("") : parts.join("")).replace(/\D/g, "") || "0";
  const fraction = (hasDecimal ? fractionCandidate : "").replace(/\D/g, "").padEnd(2, "0").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(fraction || "0");
  return (negative ? -cents : cents).toString();
}

function evidenceForField(field: FieldResult | undefined, pages: WheatOcrPage[]) {
  if (!field || field.value === null || field.value === "") return [];
  const targets = normalizeHeader(`${field.value} ${field.raw ?? ""}`).split(/\s+/).filter((item) => item.length >= 3);
  if (!targets.length) return [];
  for (const page of pages) {
    const matches = page.words.filter((word) => word.bbox && targets.some((target) => normalizeHeader(word.text).includes(target) || target.includes(normalizeHeader(word.text)))).slice(0, 12);
    if (!matches.length) continue;
    return [{
      page: page.page,
      text: matches.map((word) => word.text).join(" "),
      bbox: {
        x0: Math.min(...matches.map((word) => word.bbox!.x0)),
        y0: Math.min(...matches.map((word) => word.bbox!.y0)),
        x1: Math.max(...matches.map((word) => word.bbox!.x1)),
        y1: Math.max(...matches.map((word) => word.bbox!.y1)),
      },
    }];
  }
  return [];
}

function invoiceField(field: FieldResult | undefined, pages: WheatOcrPage[], transform?: (value: unknown) => unknown) {
  return {
    value: field?.value === null || field?.value === undefined || field.value === "" ? null : transform ? transform(field.value) : field.value,
    confidence: field?.confidence ?? 0,
    raw: field?.raw ?? null,
    source: field?.source ?? null,
    evidence: evidenceForField(field, pages),
  };
}

function invoiceLineItems(tableRows: string[][]) {
  const headerIndex = tableRows.findIndex((row) => {
    const joined = normalizeHeader(row.join(" "));
    return /(designation|description|article|produit|service)/.test(joined) && /(montant|total|prix|ht|ttc)/.test(joined);
  });
  if (headerIndex < 0) return [];
  const header = tableRows[headerIndex].map(normalizeHeader);
  const indexOf = (patterns: RegExp[]) => header.findIndex((cell) => patterns.some((pattern) => pattern.test(cell)));
  const descriptionIndex = indexOf([/designation/, /description/, /article/, /produit/, /service/]);
  const quantityIndex = indexOf([/qte/, /quantite/, /qty/]);
  const unitPriceIndex = indexOf([/prix unitaire/, /p\.?u/, /unit price/]);
  const vatIndex = indexOf([/tva/, /vat/, /tax/]);
  const totalIndex = indexOf([/total/, /montant/, /ttc/, /ht/]);
  return tableRows.slice(headerIndex + 1).map((row, index) => {
    const joined = normalizeHeader(row.join(" "));
    if (!row.some(Boolean) || /^(total|sous total|subtotal|net a payer)/.test(joined)) return null;
    const description = cleanValue(row[descriptionIndex] ?? "");
    if (!description) return null;
    const vatRaw = vatIndex >= 0 ? row[vatIndex] ?? "" : "";
    const vatRate = /([0-9]+(?:[.,][0-9]+)?)\s*%/.exec(vatRaw)?.[1];
    return {
      position: index + 1,
      description,
      quantity: quantityIndex >= 0 ? cleanValue(row[quantityIndex] ?? "") || null : null,
      unitPriceCents: unitPriceIndex >= 0 ? decimalCents(row[unitPriceIndex]) : null,
      vatRateBps: vatRate ? Math.round(Number(vatRate.replace(",", ".")) * 100) : null,
      lineTotalCents: totalIndex >= 0 ? decimalCents(row[totalIndex]) : null,
      confidence: Math.max(35, Math.min(88, 52 + Number(unitPriceIndex >= 0) * 8 + Number(totalIndex >= 0) * 12 + Number(vatIndex >= 0) * 6)),
      rawCells: row,
      evidence: { kind: "TABLE_ROW", row: headerIndex + index + 2, bbox: null },
    };
  }).filter(Boolean).slice(0, 500);
}

/** Stable, review-first invoice contract consumed by the posting workbench. */
export function buildInvoiceSchema(fields: Record<string, FieldResult>, tableRows: string[][], pages: WheatOcrPage[]) {
  const fieldValues = {
    supplierName: invoiceField(fields.supplier?.value ? fields.supplier : fields.counterparty, pages),
    supplierIce: invoiceField(fields.ice, pages),
    supplierTaxId: invoiceField(fields.if, pages),
    customerName: invoiceField(fields.client, pages),
    invoiceNumber: invoiceField(fields.invoiceNumber, pages),
    invoiceDate: invoiceField(fields.date, pages),
    dueDate: invoiceField(fields.dueDate, pages),
    currency: invoiceField(fields.currency, pages),
    paymentTerms: invoiceField(fields.paymentTerms, pages),
    htCents: invoiceField(fields.ht, pages, decimalCents),
    vatCents: invoiceField(fields.tva, pages, decimalCents),
    ttcCents: invoiceField(fields.ttc, pages, decimalCents),
  };
  const populated = Object.values(fieldValues).filter((field) => field.value !== null);
  const fieldConfidence = populated.length ? Math.round(populated.reduce((sum, field) => sum + field.confidence, 0) / populated.length) : 0;
  const lineItems = invoiceLineItems(tableRows);
  return {
    schemaVersion: "ATLAS_INVOICE_1",
    reviewRequired: ["supplierName", "invoiceDate", "ttcCents"].some((key) => (fieldValues as Record<string, any>)[key].confidence < 72),
    fields: fieldValues,
    lineItems,
    confidence: {
      fieldExtraction: fieldConfidence,
      lineItemReconstruction: lineItems.length ? Math.round(lineItems.reduce((sum, item: any) => sum + item.confidence, 0) / lineItems.length) : 0,
      accountingConsistency: fieldValues.htCents.value !== null && fieldValues.vatCents.value !== null && fieldValues.ttcCents.value !== null
        ? (BigInt(String(fieldValues.htCents.value)) + BigInt(String(fieldValues.vatCents.value)) === BigInt(String(fieldValues.ttcCents.value)) ? 100 : 0)
        : null,
    },
    exactUnit: "CENTIME",
  };
}

function requiredFieldsForType(type: string) {
  if (type === "INVOICE") return ["date", "counterparty", "ttc"];
  if (type === "BANK_STATEMENT") return ["date", "counterparty"];
  if (type === "PAYROLL") return ["employee", "gross", "net"];
  if (type === "TAX") return ["date", "reference"];
  return ["date", "counterparty"];
}

function calculateConfidence(ocrConfidence: number, classificationConfidence: number, fields: Record<string, FieldResult>, tableCount: number) {
  const knownFields = Object.values(fields).filter((fieldItem) => fieldItem.value !== null && fieldItem.value !== "");
  const fieldScore = knownFields.length ? average(knownFields.map((fieldItem) => fieldItem.confidence)) : 12;
  const tableBoost = Math.min(8, tableCount / 20);
  return Math.round(Math.max(1, Math.min(99, ocrConfidence * 0.42 + classificationConfidence * 0.25 + fieldScore * 0.30 + tableBoost)));
}

function buildFingerprint(type: string, fields: Record<string, FieldResult>) {
  const parts = [
    type,
    asText(fields.date?.value),
    asText(fields.invoiceNumber?.value || fields.reference?.value),
    asText(fields.counterparty?.value).toLowerCase(),
    asText(fields.ttc?.value),
  ].join("|");
  return crypto.createHash("sha1").update(parts).digest("hex");
}

function findExistingDuplicates(existingDocuments: ExistingDocument[], fingerprint: string) {
  if (!fingerprint) return [];
  return existingDocuments
    .filter((doc) => {
      const extracted = safeJson(doc.extracted);
      return extracted.duplicateFingerprint === fingerprint;
    })
    .map((doc) => doc.id);
}

function copyToSmartFolder(app: App, companyName: string, sourcePath: string, documentDate: Date, type: string, counterparty: string) {
  const year = String(documentDate.getFullYear());
  const month = `${String(documentDate.getMonth() + 1).padStart(2, "0")}-${monthNames[documentDate.getMonth()]}`;
  const targetDir = path.join(resolveUserDataDir(app), "documents", safeSegment(companyName), year, month, folderNames[type] ?? folderNames.UNKNOWN, safeSegment(counterparty || "Unknown"));
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${Date.now()}-${safeSegment(path.basename(sourcePath))}`);
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function readDelimitedTable(text: string) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const delimiter = firstLine.includes(";") ? ";" : firstLine.includes("\t") ? "\t" : ",";
  return text.split(/\r?\n/)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
}

function spreadsheetCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const item = value as Record<string, any>;
    if (Array.isArray(item.richText)) return cleanValue(item.richText.map((part) => part.text ?? "").join(""));
    if (item.result !== undefined) return spreadsheetCellText(item.result);
    if (item.text !== undefined) return cleanValue(String(item.text));
    if (item.hyperlink !== undefined && item.text !== undefined) return cleanValue(String(item.text));
    if (item.formula !== undefined) return spreadsheetCellText(item.result ?? item.formula);
  }
  return cleanValue(String(value));
}

function looksLikeBankTable(tables: string[][][], source: string) {
  if (/(releve[-_\s]+bancaire|releve[-_\s]+de[-_\s]+compte|bank[-_\s]+statement)/i.test(source)) return true;
  return tables.some((table) => table.some((row) => {
    const joined = normalizeHeader(row.join(" "));
    return joined.includes("date") && (joined.includes("debit") || joined.includes("credit")) && (joined.includes("solde") || joined.includes("balance") || joined.includes("description") || joined.includes("libelle"));
  }));
}

function mergePageText(pages: WheatOcrPage[]) {
  return pages.map((page) => page.text).filter(Boolean).join("\n\n");
}

function mergeCandidateText(candidates: WheatOcrPage[]) {
  const lines = new Map<string, string>();
  for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence)) {
    for (const line of candidate.text.split(/\r?\n/)) {
      const clean = cleanValue(line);
      if (!clean) continue;
      const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (key.length >= 3 && !lines.has(key)) lines.set(key, clean);
    }
  }
  return [...lines.values()].join("\n");
}

function bestCandidate(candidates: WheatOcrPage[]) {
  return [...candidates].sort((a, b) => candidateScore(b) - candidateScore(a))[0] ?? {
    page: 1,
    text: "",
    confidence: 0,
    engine: "none",
    preprocessing: [],
    words: [],
  };
}

function candidateScore(candidate: WheatOcrPage) {
  return candidate.confidence + Math.min(20, candidate.text.length / 80) + (hasAccountingAnchors(candidate.text) ? 12 : 0);
}

function hasAccountingAnchors(text: string) {
  return /(facture|invoice|tva|ttc|ice|if|solde|debit|credit|cnss|amo|dgi)/i.test(text);
}

function wordsFromText(text: string): WheatWord[] {
  return text.split(/\s+/).filter(Boolean).map((word) => ({ text: word, confidence: 92 }));
}

function normalizeDate(value: string) {
  const parts = value.trim().replaceAll(".", "/").replaceAll("-", "/").replace(/\s+/g, "/").split("/").filter(Boolean);
  if (parts.length < 3) return "";
  if (parts[0]?.length === 4) return `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
  return `${year}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
}

function parseDateValue(value: string) {
  if (!value) return null;
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseAmount(value: string) {
  const clean = value.replace(/\s/g, "").replace(/'/g, "");
  const normalized = clean.includes(",") && clean.lastIndexOf(",") > clean.lastIndexOf(".")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean.replace(/,/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function looksLikeAmount(value: string) {
  return /^[0-9\s.,']+\s*(mad|dh|dhs|eur|usd)?$/i.test(value);
}

function emptyField(): FieldResult {
  return { value: null, confidence: 10 };
}

function mapFieldValues(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.value]));
}

function mapFieldConfidence(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.confidence]));
}

function mapFieldRaw(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.raw).map(([key, value]) => [key, value.raw]));
}

function mapFieldSources(fields: Record<string, FieldResult>) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value.source).map(([key, value]) => [key, value.source]));
}

function safeSegment(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Unknown";
}

function normalizeText(text: string) {
  return normalizeAccountingAbbreviations(text)
    .replaceAll("\u0000", "")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeAccountingAbbreviations(text: string) {
  return text
    .replace(/\bT\s*\.?\s*V\s*\.?\s*A\b/gi, "TVA")
    .replace(/\bT\s*\.?\s*T\s*\.?\s*C\b/gi, "TTC")
    .replace(/\bH\s*\.?\s*T\b/gi, "HT")
    .replace(/\bI\s*\.?\s*C\s*\.?\s*E\b/gi, "ICE")
    .replace(/\bI\s*\.?\s*F\b/gi, "IF");
}

function weightedScore(source: string, terms: Array<[string, number]>) {
  return terms.reduce((sum, [term, weight]) => sum + (source.includes(term.toLowerCase()) ? weight : 0), 0);
}

function average(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function cleanValue(value: string) {
  return value.replace(/[|•]+/g, " ").replace(/\s+/g, " ").replace(/^[#:.\-\s]+|[#:.\-\s]+$/g, "").trim().slice(0, 160);
}

function asText(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function resolveTessdataPath(app: App) {
  if (app.isPackaged) return path.join(process.resourcesPath, "tessdata");
  return path.join(process.cwd(), "resources", "tessdata");
}

function resolveTesseractNodeWorkerPath(app: App) {
  const relativeWorkerPath = path.join("node_modules", "tesseract.js", "src", "worker-script", "node", "index.js");
  if (app.isPackaged) return path.join(process.resourcesPath, "app.asar.unpacked", relativeWorkerPath);
  return path.join(process.cwd(), relativeWorkerPath);
}

function resolvePdfWorkerUrl(app: App) {
  const candidates = app.isPackaged
    ? [
      path.join(process.resourcesPath, "ocr", "pdf.worker.mjs"),
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"),
      path.join(path.dirname(process.execPath), "resources", "ocr", "pdf.worker.mjs"),
    ]
    : [
      path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "worker", "pdf.worker.mjs"),
      path.join(process.cwd(), "node_modules", "pdf-parse", "dist", "pdf-parse", "esm", "pdf.worker.mjs"),
    ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ? pathToFileURL(found).toString() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeHeader(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

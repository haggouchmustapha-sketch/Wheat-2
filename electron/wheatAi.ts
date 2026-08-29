import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { rendererSerialize, requireId, requireText } from "./accounting";
import { buildBalanceFamily, buildBankTotal, buildBilan } from "./reporting21";
import { createCustomSubaccount, searchCompanyAccounts } from "./chartOfAccounts21";
import { PCGE_SOURCE } from "./pcgeData";
import { appendActivityAndAudit } from "./audit13";
import { addFiscalAdjustment, buildComparativeCpc, buildFiscalControl, markFiscalTableNotApplicable, saveFiscalTable } from "./fiscal21";
import { fiscalTableDefinition } from "./fiscalCatalog";
import { wheatProductKnowledge, WHEAT_AI_MUTATION_CAPABILITIES, WHEAT_PRODUCT_KNOWLEDGE_VERSION } from "./wheatProductKnowledge";
import { WHEAT_APP_VERSION } from "../src/appVersion";
import {
  AUTOMATIC_FREE_MODEL_ID,
  REMOTE_MODEL_PREFIX,
  type WheatAiProviderService,
} from "./wheatAiProviderService";
import { PROVIDER_LABELS, type WheatAiChatMessage } from "./wheatAiProviders";
import {
  ATLAS_AI_CAPABILITY_REGISTRY,
  canonicalWheatAiCapabilityId,
  classifyWheatAiIntent,
  getWheatAiCapability,
  publicWheatAiCapabilities,
  selectWheatAiCapabilities,
  type WheatAiCapabilityDefinition,
  type WheatAiIntent,
} from "./wheatAiCapabilityRegistry";
import { createWheatAiDomainGateway, type WheatAiDomainGateway } from "./wheatAiDomainGateway";

type PrismaLike = Record<string, any>;
type GetPrisma = () => PrismaLike | Promise<PrismaLike>;
type IpcLike = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): unknown };
type Send = (channel: string, payload: unknown) => void;
type PermissionMode = "READ_ONLY" | "ASSISTANT" | "AUTOMATED";
type LocalModelProvider = "ATLAS" | "OLLAMA" | "HUGGINGFACE" | "OPENROUTER" | "GROQ";

type ModelArtifact = {
  tier: "LITE" | "STANDARD" | "ADVANCED";
  id: string;
  displayName: string;
  fileName: string;
  url: string;
  sha256: string;
  bytes: number;
  source: string;
  baseModel: string;
  quantization: string;
  license: string;
  conversionProvenance?: string;
  minimumRamBytes: number;
  recommendedFreeRamBytes: number;
  recommendedGpuVramBytes?: number;
};

type ModelManifest = {
  schemaVersion: string;
  manifestVersion: string;
  runtime: { id: string; version: string; fileName: string; url: string; sha256: string; bytes: number; source: string; license: string };
  models: ModelArtifact[];
};

type LocalModel = {
  id: string;
  provider: LocalModelProvider;
  displayName: string;
  installed: boolean;
  chatReady: boolean;
  removable: boolean;
  integrity: "VERIFIED" | "LOCAL" | "ABSENT" | "INVALID";
  bytes: number;
  source: string;
  baseModel?: string;
  quantization?: string;
  tier?: ModelArtifact["tier"] | "EXTERNAL";
  fileName?: string;
  filePath?: string;
  repoRoot?: string;
  digest?: string;
  parameterSize?: string;
};

type ZipEntry = {
  path: string;
  type: string;
  stream(): NodeJS.ReadableStream & { [Symbol.asyncIterator](): AsyncIterator<Buffer | string | Uint8Array> };
};
type UnzipperModule = { Open: { file(archivePath: string): Promise<{ files: ZipEntry[] }> } };

const unzipper = createRequire(import.meta.url)("unzipper") as UnzipperModule;
const execFileAsync = promisify(execFile);

export const WHEAT_AI_CHANNELS = {
  status: "wheat:ai:status",
  benchmark: "wheat:ai:benchmark",
  install: "wheat:ai:install",
  uninstall: "wheat:ai:uninstall",
  select: "wheat:ai:select",
  configure: "wheat:ai:configure",
  tools: "wheat:ai:tools",
  executeTool: "wheat:ai:execute-tool",
  executePlan: "wheat:ai:execute-plan",
  chat: "wheat:ai:chat",
  confirmAction: "wheat:ai:confirm-action",
  cancelAction: "wheat:ai:cancel-action",
  progress: "wheat:ai:progress",
} as const;

/**
 * Optional remote-provider service (OpenRouter / Groq). When it is absent or
 * unconfigured, Wheat AI behaves exactly as before: local models only.
 */
let remoteProviderService: WheatAiProviderService | null = null;

export function setWheatAiRemoteProviderService(service: WheatAiProviderService | null) {
  remoteProviderService = service;
}

const OLLAMA_API = "http://127.0.0.1:11434";
const WHEAT_AI_SYSTEM_PROMPT = [
  "Tu es Wheat AI, l'assistant intégré à Wheat, logiciel de comptabilité marocaine.",
  "Utilise la connaissance produit versionnée pour expliquer exactement les modules, la navigation et les workflows. Utilise uniquement le contexte d'outils typés pour parler du dossier actif.",
  "Ne lis jamais directement une base, un chemin local ou un fichier libre. N'invente aucune donnée, preuve, référence légale, règle fiscale, taux ou conversion.",
  "Pour une demande d'action explicite, utilise les capacités typées pertinentes. Tu peux proposer plusieurs capacités seulement si elles forment un plan cohérent et entièrement demandé. Si la cible ou une valeur requise est ambiguë, pose une question courte et ne propose aucun outil.",
  "Distingue toujours information, planification, prévisualisation et exécution. Une question, une demande d'explication ou « que se passerait-il » n'autorise jamais une mutation.",
  "Les montants d'outils sont des chaînes de centimes entiers. Les identifiants T01 à T25 désignent les workpapers de la liasse normale.",
  "Une proposition est seulement un brouillon: Wheat la normalise, montre l'avant/après et recontrôle sa version. Ne prétends jamais qu'elle est exécutée avant confirmation explicite dans l'application.",
  "La comptabilisation, l'extourne, la suppression, la clôture et la réouverture restent soumises aux validations et confirmations de niveau 3. Wheat ne télédéclare jamais.",
  "N'expose jamais ton raisonnement interne. Fournis uniquement la réponse finale, en français, clairement et brièvement.",
].join(" ");

const TOOL_DEFINITIONS = [
  { name: "search_accounts", risk: "READ" as const, description: "Rechercher des comptes PCGE et subdivisions du dossier.", input: { query: "string", classNo: "number?", limit: "number?" } },
  { name: "get_entries", risk: "READ" as const, description: "Lire un extrait borné du journal comptable.", input: { from: "YYYY-MM-DD?", to: "YYYY-MM-DD?", query: "string?", limit: "number?" } },
  { name: "get_balance", risk: "READ" as const, description: "Calculer une balance exacte depuis le moteur partagé.", input: { view: "BalanceView", from: "YYYY-MM-DD?", to: "YYYY-MM-DD" } },
  { name: "get_bilan", risk: "READ" as const, description: "Calculer le bilan normal ou simplifié depuis le moteur partagé.", input: { asOf: "YYYY-MM-DD", variant: "NORMAL|SIMPLIFIED" } },
  { name: "get_cpc", risk: "READ" as const, description: "Calculer le CPC comparatif et les soldes exacts de l'exercice.", input: { fiscalYearId: "string?" } },
  { name: "get_bank_position", risk: "READ" as const, description: "Lire la position de trésorerie par devise.", input: { asOf: "YYYY-MM-DD?" } },
  { name: "get_invoices", risk: "READ" as const, description: "Lire une liste bornée de factures ou avoirs sans contenu de fichier.", input: { from: "YYYY-MM-DD?", to: "YYYY-MM-DD?", query: "string?", limit: "number?" } },
  { name: "get_documents", risk: "READ" as const, description: "Lire les métadonnées bornées des documents, jamais leur chemin local ni leur contenu OCR complet.", input: { query: "string?", limit: "number?" } },
  { name: "get_vat_status", risk: "READ" as const, description: "Lire les périodes et montants TVA enregistrés dans le dossier.", input: { limit: "number?" } },
  { name: "get_payroll_summary", risk: "READ" as const, description: "Lire les périodes et états des traitements de paie sans données personnelles salarié.", input: { limit: "number?" } },
  { name: "get_fiscal_package", risk: "READ" as const, description: "Lire l'avancement et les contrôles des 25 tableaux de préparation normale.", input: {} },
  { name: "retrieve_company_knowledge", risk: "READ" as const, description: "Retrouver des schémas locaux avec leurs preuves et confiance.", input: { kind: "string?", limit: "number?" } },
  { name: "create_account_subdivision", risk: "MUTATING" as const, description: "Créer une subdivision de dossier héritant d'un parent PCGE.", input: { parentCode: "string", code: "string", label: "string" } },
  { name: "update_company_profile", risk: "MUTATING" as const, description: "Modifier des champs d'identité du dossier après confirmation.", input: { name: "string?", legalForm: "string?", ice: "string?", taxId: "string?", city: "string?", vatFrequency: "MONTHLY|QUARTERLY?" } },
  { name: "rename_custom_account", risk: "MUTATING" as const, description: "Renommer un compte personnalisé; un compte officiel PCGE reste immuable.", input: { accountCode: "string", label: "string" } },
  { name: "add_fiscal_table_row", risk: "MUTATING" as const, description: "Ajouter une ligne manuelle documentée à un tableau fiscal normal en brouillon. La ligne doit suivre les colonnes du tableau et contenir sourceRef pour tout montant.", input: { tableId: "T01|T02|T03|T04|T05|T06|T07|T08|T09|T10|T11|T12|T13|T14|T15|T16|T17|T18|T19|T20|T21|T22|T23|T24|T25", row: "object" } },
  { name: "mark_fiscal_table_not_applicable", risk: "MUTATING" as const, description: "Documenter un tableau fiscal normal en brouillon comme non applicable avec un motif précis.", input: { tableId: "T01|T02|T03|T04|T05|T06|T07|T08|T09|T10|T11|T12|T13|T14|T15|T16|T17|T18|T19|T20|T21|T22|T23|T24|T25", reason: "string" } },
  { name: "add_fiscal_adjustment", risk: "MUTATING" as const, description: "Ajouter une réintégration ou déduction documentée, non vérifiée, à la liasse normale en brouillon. Ne jamais inventer la référence légale.", input: { kind: "REINTEGRATION|DEDUCTION", label: "string", amountCents: "string", legalReference: "string" } },
  { name: "remember_company_knowledge", risk: "MUTATING" as const, description: "Enregistrer une règle propre au dossier avec sa preuve et son niveau de confiance.", input: { kind: "string", key: "string", value: "object", evidence: "array?", confidenceBps: "number?" } },
  { name: "post_entry", risk: "HIGH_STAKES" as const, description: "Indisponible à l'IA : la comptabilisation reste une action humaine dans l'écran de saisie.", input: {} },
] as const;

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La demande Wheat AI est invalide.");
  return value as Record<string, any>;
}

function safeJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

const EMPTY_FINAL_RESPONSE = "Le modèle n’a pas fourni de réponse finale.";
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripModelReasoning(value: unknown) {
  let text = String(value ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text) return EMPTY_FINAL_RESPONSE;

  // Some chat templates expose explicit analysis/final channels instead of
  // XML-style reasoning tags. When a final channel exists, it is the only
  // model-authored content that may cross the renderer boundary.
  const channelMarkers = [
    /<\|start\|>assistant<\|channel\|>final<\|message\|>/gi,
    /<\|channel\|>final<\|message\|>/gi,
  ];
  for (const marker of channelMarkers) {
    const matches = [...text.matchAll(marker)];
    const last = matches.at(-1);
    if (last?.index !== undefined) text = text.slice(last.index + last[0].length);
  }

  for (const tag of ["think", "analysis", "reasoning"]) {
    const complete = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    text = text.replace(complete, "");

    const close = new RegExp(`<\\/${tag}\\s*>`, "gi");
    const closes = [...text.matchAll(close)];
    const lastClose = closes.at(-1);
    if (lastClose?.index !== undefined) text = text.slice(lastClose.index + lastClose[0].length);

    // Never reveal an unterminated reasoning section. A malformed model turn
    // is safer as an empty final answer than as leaked chain-of-thought.
    const open = new RegExp(`<${tag}\\b[^>]*>`, "i");
    const openIndex = text.search(open);
    if (openIndex >= 0) text = text.slice(0, openIndex);
  }

  for (const tag of ["THINK", "ANALYSIS", "REASONING"]) {
    const complete = new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, "gi");
    text = text.replace(complete, "");

    const closing = new RegExp(`\\[\\/${tag}\\]`, "gi");
    const closes = [...text.matchAll(closing)];
    const lastClose = closes.at(-1);
    if (lastClose?.index !== undefined) text = text.slice(lastClose.index + lastClose[0].length);

    const opening = new RegExp(`\\[${tag}\\]`, "i");
    const openIndex = text.search(opening);
    if (openIndex >= 0) text = text.slice(0, openIndex);
  }

  text = text.replace(/<\|(?:start|end|channel|message)\|>/gi, "").trim();

  // Handle plain-text reasoning only when the model also provides an explicit
  // final-answer delimiter, avoiding accidental removal of ordinary prose.
  if (/^(?:thinking|reasoning|analysis|réflexion|raisonnement)(?:\s*:|\s*\n)/i.test(text)) {
    const finalMarker = /(?:^|\n)\s*(?:final(?: answer| response)?|réponse(?: finale)?)\s*:\s*/gi;
    const matches = [...text.matchAll(finalMarker)];
    const last = matches.at(-1);
    text = last?.index !== undefined ? text.slice(last.index + last[0].length).trim() : "";
  }

  return text || EMPTY_FINAL_RESPONSE;
}

function day(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} doit utiliser AAAA-MM-JJ.`);
  const result = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(result.getTime()) || result.toISOString().slice(0, 10) !== value) throw new Error(`${label} est invalide.`);
  return result;
}

export async function readModelManifest(manifestPath: string): Promise<ModelManifest> {
  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ModelManifest;
  if (parsed.schemaVersion !== "ATLAS_LOCAL_MODELS_1" || !parsed.runtime || parsed.models?.length !== 3) throw new Error("Le manifeste des modèles locaux est invalide.");
  for (const artifact of [parsed.runtime, ...parsed.models]) {
    const url = new URL(artifact.url);
    if (url.protocol !== "https:" || !["github.com", "huggingface.co"].includes(url.hostname)) throw new Error(`URL de modèle non approuvée : ${artifact.url}`);
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) throw new Error(`Empreinte ou taille invalide pour ${artifact.id}.`);
  }
  return parsed;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
  return hash.digest("hex");
}

async function validPinnedFile(filePath: string, expectedBytes: number, expectedSha: string) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size === expectedBytes && await sha256File(filePath) === expectedSha;
  } catch { return false; }
}

async function downloadPinned(artifact: { id: string; url: string; sha256: string; bytes: number }, destination: string, send: Send) {
  if (await validPinnedFile(destination, artifact.bytes, artifact.sha256)) return destination;
  const partial = `${destination}.partial`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let received = 0;
  try { received = (await fs.stat(partial)).size; } catch { /* no partial */ }
  if (received > artifact.bytes) {
    await fs.rename(partial, `${partial}.invalid-${randomUUID()}`);
    received = 0;
  }
  if (received === artifact.bytes) {
    send(WHEAT_AI_CHANNELS.progress, { artifactId: artifact.id, phase: "VERIFY", receivedBytes: received, totalBytes: artifact.bytes });
    const resumedDigest = await sha256File(partial);
    if (resumedDigest !== artifact.sha256) {
      await fs.rename(partial, `${partial}.sha256-failed-${randomUUID()}`);
      throw new Error(`Échec SHA-256 pour ${artifact.id}. Le fichier repris a été isolé.`);
    }
    try { await fs.rename(destination, `${destination}.invalid-${randomUUID()}`); } catch { /* target absent */ }
    await fs.rename(partial, destination);
    return destination;
  }
  const abort = new AbortController();
  let inactivityTimer: NodeJS.Timeout | undefined;
  const armInactivityTimeout = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => abort.abort(new Error("Aucun octet reçu depuis 60 secondes.")), 60_000);
  };
  armInactivityTimeout();
  try {
    const response = await fetch(artifact.url, { redirect: "follow", headers: received ? { Range: `bytes=${received}-` } : {}, signal: abort.signal });
    if (!response.ok || !response.body) throw new Error(`Téléchargement refusé (${response.status}) pour ${artifact.id}.`);
    if (received && response.status !== 206) {
      await fs.rename(partial, `${partial}.range-unsupported-${randomUUID()}`);
      return downloadPinned(artifact, destination, send);
    }
    const tracker = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      armInactivityTimeout();
      send(WHEAT_AI_CHANNELS.progress, { artifactId: artifact.id, phase: "DOWNLOAD", receivedBytes: received, totalBytes: artifact.bytes });
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as any), tracker, createWriteStream(partial, { flags: received ? "a" : "w" }));
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`Téléchargement interrompu pour ${artifact.id} après 60 secondes sans données. Le fichier partiel est conservé pour reprise.`, { cause: error });
    throw error;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
  }
  const stat = await fs.stat(partial);
  if (stat.size !== artifact.bytes) throw new Error(`Taille reçue invalide pour ${artifact.id} (${stat.size}/${artifact.bytes}). Le fichier partiel est conservé pour reprise.`);
  send(WHEAT_AI_CHANNELS.progress, { artifactId: artifact.id, phase: "VERIFY", receivedBytes: stat.size, totalBytes: artifact.bytes });
  const digest = await sha256File(partial);
  if (digest !== artifact.sha256) {
    await fs.rename(partial, `${partial}.sha256-failed-${randomUUID()}`);
    throw new Error(`Échec SHA-256 pour ${artifact.id}. Le fichier rejeté a été isolé.`);
  }
  try {
    if (await validPinnedFile(destination, artifact.bytes, artifact.sha256)) { await fs.rename(partial, `${partial}.duplicate-${randomUUID()}`); return destination; }
    await fs.rename(destination, `${destination}.invalid-${randomUUID()}`);
  } catch { /* target absent */ }
  await fs.rename(partial, destination);
  return destination;
}

async function findFile(root: string, name: string): Promise<string | null> {
  try {
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
      const target = path.join(root, item.name);
      if (item.isFile() && item.name.toLowerCase() === name.toLowerCase()) return target;
      if (item.isDirectory()) { const nested = await findFile(target, name); if (nested) return nested; }
    }
  } catch { /* absent */ }
  return null;
}

async function installRuntime(manifest: ModelManifest, root: string, send: Send) {
  const target = path.join(root, "runtime", manifest.runtime.version);
  const existing = await findFile(target, "llama-cli.exe");
  if (existing) return existing;
  const downloads = path.join(root, "downloads");
  const archive = await downloadPinned(manifest.runtime, path.join(downloads, manifest.runtime.fileName), send);
  const staging = path.join(root, "staging", `runtime-${manifest.runtime.version}-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  const directory = await unzipper.Open.file(archive);
  for (const entry of directory.files) {
    const relative = entry.path.replace(/\\/g, "/");
    const output = path.resolve(staging, relative);
    const boundary = `${path.resolve(staging)}${path.sep}`;
    if (!output.startsWith(boundary) || relative.includes("../") || path.isAbsolute(relative)) throw new Error("L'archive llama.cpp contient un chemin non sûr.");
    if (entry.type === "Directory") { await fs.mkdir(output, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(output), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(output, { flags: "wx" }));
  }
  const executable = await findFile(staging, "llama-cli.exe");
  if (!executable) throw new Error("L'archive llama.cpp vérifiée ne contient pas llama-cli.exe.");
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.rename(target, `${target}.invalid-${randomUUID()}`); } catch { /* absent */ }
  await fs.rename(staging, target);
  const installed = await findFile(target, "llama-cli.exe");
  if (!installed) throw new Error("L'installation du moteur local est incomplète.");
  return installed;
}

async function gpuProfile() {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress";
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const parsed = JSON.parse(stdout.trim() || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((gpu: any) => ({ name: String(gpu.Name ?? "GPU"), vramBytes: Number(gpu.AdapterRAM ?? 0), driverVersion: String(gpu.DriverVersion ?? "") }));
  } catch { return []; }
}

export async function profileHardware(modelRoot: string) {
  const disk = await fs.statfs(modelRoot).catch(async () => { await fs.mkdir(modelRoot, { recursive: true }); return fs.statfs(modelRoot); });
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? "Unknown CPU",
    logicalCores: os.cpus().length,
    totalRamBytes: os.totalmem(),
    freeRamBytes: os.freemem(),
    freeDiskBytes: disk.bavail * disk.bsize,
    gpus: await gpuProfile(),
  };
}

export function recommendModel(profile: Awaited<ReturnType<typeof profileHardware>>, manifest: ModelManifest) {
  const diskReserve = 2 * 1024 ** 3;
  const eligible = manifest.models.filter((model) => profile.totalRamBytes >= model.minimumRamBytes && profile.freeRamBytes >= model.recommendedFreeRamBytes && profile.freeDiskBytes >= model.bytes + manifest.runtime.bytes + diskReserve);
  const recommended = eligible.at(-1) ?? manifest.models[0];
  return {
    tier: recommended.tier,
    modelId: recommended.id,
    reason: eligible.length ? `${recommended.displayName} tient dans la RAM et l'espace libre mesurés.` : `${recommended.displayName} est le profil minimal; libérez de la mémoire et au moins ${Math.ceil((recommended.bytes + diskReserve) / 1024 ** 3)} Gio avant installation.`,
    eligibleModelIds: eligible.map((model) => model.id),
  };
}

async function localBenchmark() {
  const iterations = 1_250_000;
  let state = 0x9e3779b9;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) state = Math.imul(state ^ index, 2654435761) >>> 0;
  const durationMs = performance.now() - started;
  return { kind: "CPU_INTEGER_CALIBRATION", iterations, durationMs: Math.round(durationMs * 100) / 100, operationsPerSecond: Math.round(iterations / (durationMs / 1000)), checksum: state, measuredAt: new Date().toISOString() };
}

function modelPath(root: string, model: ModelArtifact) { return path.join(root, "models", model.fileName); }

async function modelStatuses(root: string, manifest: ModelManifest) {
  return Promise.all(manifest.models.map(async (model) => {
    const filePath = modelPath(root, model);
    let present = false; let valid = false;
    try { present = (await fs.stat(filePath)).isFile(); valid = present && await validPinnedFile(filePath, model.bytes, model.sha256); } catch { /* absent */ }
    const integrity: LocalModel["integrity"] = valid ? "VERIFIED" : present ? "INVALID" : "ABSENT";
    return { ...model, present, installed: valid, integrity };
  }));
}

async function ollamaRequest(endpoint: string, init?: RequestInit, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${OLLAMA_API}${endpoint}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = (await response.text().catch(() => "")).trim();
      throw new Error(`Ollama a refusé la demande (${response.status})${details ? ` : ${details.slice(0, 500)}` : "."}`);
    }
    if (response.status === 204) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Ollama n'a pas répondu dans le délai prévu.", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function listOllamaModels(): Promise<{ available: boolean; error?: string; models: LocalModel[] }> {
  try {
    const payload = await ollamaRequest("/api/tags") as { models?: any[] };
    const models = (Array.isArray(payload.models) ? payload.models : []).map((item): LocalModel => {
      const name = String(item?.name ?? item?.model ?? "").trim();
      return {
        id: `ollama:${name}`,
        provider: "OLLAMA",
        displayName: name,
        installed: Boolean(name),
        chatReady: Boolean(name),
        removable: true,
        integrity: "LOCAL",
        bytes: Math.max(0, Number(item?.size ?? 0)),
        source: "Ollama local",
        baseModel: String(item?.details?.family ?? "") || undefined,
        quantization: String(item?.details?.quantization_level ?? "") || undefined,
        parameterSize: String(item?.details?.parameter_size ?? "") || undefined,
        digest: String(item?.digest ?? "") || undefined,
        tier: "EXTERNAL",
      };
    }).filter((item) => item.installed);
    return { available: true, models };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error), models: [] };
  }
}

function huggingFaceCacheRoots() {
  const roots = new Set<string>();
  if (process.env.HF_HUB_CACHE) roots.add(path.resolve(process.env.HF_HUB_CACHE));
  if (process.env.HF_HOME) roots.add(path.resolve(process.env.HF_HOME, "hub"));
  roots.add(path.join(os.homedir(), ".cache", "huggingface", "hub"));
  if (process.platform === "win32") roots.add(path.join(os.homedir(), "AppData", "Local", "huggingface", "hub"));
  return [...roots];
}

async function collectGgufFiles(directory: string, depth: number, output: string[]) {
  if (depth > 5 || output.length >= 500) return;
  let entries: Array<import("node:fs").Dirent>;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (output.length >= 500) return;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectGgufFiles(candidate, depth + 1, output);
    else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase().endsWith(".gguf")) output.push(candidate);
  }
}

export async function listHuggingFaceGgufModels(): Promise<{ roots: string[]; models: LocalModel[] }> {
  const roots: string[] = [];
  const models: LocalModel[] = [];
  const seenFiles = new Set<string>();
  for (const root of huggingFaceCacheRoots()) {
    let repositories: Array<import("node:fs").Dirent>;
    try { repositories = await fs.readdir(root, { withFileTypes: true }); roots.push(root); } catch { continue; }
    for (const repository of repositories) {
      if (!repository.isDirectory() || !repository.name.startsWith("models--")) continue;
      const repoRoot = path.resolve(root, repository.name);
      const candidates: string[] = [];
      await collectGgufFiles(path.join(repoRoot, "snapshots"), 0, candidates);
      for (const candidate of candidates) {
        try {
          const realPath = path.resolve(await fs.realpath(candidate));
          if (realPath !== repoRoot && !realPath.startsWith(`${repoRoot}${path.sep}`)) continue;
          const key = realPath.toLocaleLowerCase("en-US");
          if (seenFiles.has(key)) continue;
          seenFiles.add(key);
          const stat = await fs.stat(realPath);
          if (!stat.isFile()) continue;
          const repoId = repository.name.slice("models--".length).replace("--", "/");
          const fileName = path.basename(candidate);
          const id = `huggingface:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
          models.push({
            id,
            provider: "HUGGINGFACE",
            displayName: `${repoId} · ${fileName}`,
            installed: true,
            chatReady: false,
            removable: false,
            integrity: "LOCAL",
            bytes: stat.size,
            source: "Cache Hugging Face local",
            baseModel: repoId,
            quantization: fileName.match(/(?:Q\d[^.]*)/i)?.[0],
            tier: "EXTERNAL",
            fileName,
            filePath: realPath,
            repoRoot,
          });
        } catch { /* Ignore incomplete cache entries. */ }
      }
    }
  }
  return { roots, models };
}

async function discoverLocalModels(root: string, manifest: ModelManifest) {
  const runtimeExecutable = await findFile(path.join(root, "runtime", manifest.runtime.version), "llama-cli.exe");
  const [atlasModels, ollama, huggingFace] = await Promise.all([
    modelStatuses(root, manifest),
    listOllamaModels(),
    listHuggingFaceGgufModels(),
  ]);
  const atlas: LocalModel[] = atlasModels.map((model) => ({
    ...model,
    provider: "ATLAS",
    displayName: model.displayName,
    installed: model.installed,
    chatReady: model.installed && Boolean(runtimeExecutable),
    removable: model.installed,
    integrity: model.integrity,
    filePath: modelPath(root, model),
  }));
  const huggingFaceModels = huggingFace.models.map((model) => ({ ...model, chatReady: Boolean(runtimeExecutable) }));
  const remote = await discoverRemoteModels();
  return { models: [...remote, ...ollama.models, ...huggingFaceModels, ...atlas], runtimeExecutable, ollama, huggingFace };
}

/**
 * Free remote models, exposed alongside the local ones so the AI workspace can
 * offer them in the same picker. The first entry is the automatic mode, which
 * lets Wheat rank and fail over across every verified free model.
 */
async function discoverRemoteModels(): Promise<LocalModel[]> {
  if (!remoteProviderService?.isRemoteAvailable()) return [];
  const models: LocalModel[] = [{
    id: AUTOMATIC_FREE_MODEL_ID,
    provider: "OPENROUTER",
    displayName: "Automatique — modeles gratuits",
    installed: true,
    chatReady: true,
    removable: false,
    sizeLabel: "Selection automatique",
    notes: "Wheat classe les modeles gratuits verifies et bascule automatiquement en cas d'indisponibilite.",
  } as unknown as LocalModel];
  try {
    const listed = await remoteProviderService.listSelectableModels({});
    for (const model of listed.models) {
      models.push({
        id: model.selectionId,
        provider: model.provider === "groq" ? "GROQ" : "OPENROUTER",
        displayName: model.label,
        installed: true,
        chatReady: true,
        removable: false,
        sizeLabel: `${Math.round(model.contextTokens / 1000)}k contexte`,
        notes: `${PROVIDER_LABELS[model.provider]} · gratuit verifie · ${model.rankingReason}`,
      } as unknown as LocalModel);
    }
  } catch {
    // A discovery failure must never hide the local models; the provider card
    // in Settings reports the reason.
  }
  return models;
}

/** Remote chat, mapped onto the same result shape the local runners return. */
async function runRemoteChat(model: LocalModel, payload: Record<string, any>) {
  if (!remoteProviderService) throw new Error("Le service de fournisseurs Wheat AI n'est pas disponible.");
  const messages = normalizedChatMessages(payload);
  if (!messages.length) throw new Error("Le message est vide.");
  const context = payload.toolContext ? `\n\nContexte d'outils types (JSON):\n${safeJson(payload.toolContext).slice(0, 30_000)}` : "";
  const product = payload.productKnowledge ? `\n\nConnaissance produit verifiee:\n${String(payload.productKnowledge).slice(0, 20_000)}` : "";
  const capabilities = Array.isArray(payload.availableCapabilities) ? payload.availableCapabilities as WheatAiCapabilityDefinition[] : [];
  const allowed = payload.mutationToolsAllowed === false
    ? capabilities.filter((item) => item.mode === "READ" || item.mode === "NAVIGATION")
    : capabilities;

  const chatMessages: WheatAiChatMessage[] = [
    { role: "system", content: `${WHEAT_AI_SYSTEM_PROMPT}${product}${context}` },
    ...messages.map((item) => ({ role: item.role === "assistant" ? "assistant" as const : "user" as const, content: item.content })),
  ];

  const pinned = model.id === AUTOMATIC_FREE_MODEL_ID ? null : model.id;
  const result = await remoteProviderService.chat({
    messages: chatMessages,
    tools: allowed.map((definition) => ({
      type: "function",
      function: {
        name: modelCapabilityName(definition.id),
        description: definition.description,
        parameters: definition.inputSchema,
      },
    })),
    temperature: 0.2,
    maxTokens: 1024,
    pinnedModelId: pinned,
  });

  const proposedToolCalls = result.toolCalls.map((call) => ({
    capabilityId: capabilityIdFromModelName(call.name),
    arguments: call.arguments,
  }));
  const text = result.text || (proposedToolCalls.length
    ? "J'ai prepare les actions demandees. Wheat appliquera les regles de risque et de confirmation ci-dessous."
    : EMPTY_FINAL_RESPONSE);
  const failoverNote = result.failedOver.length
    ? `\n\n(Wheat a bascule sur ${PROVIDER_LABELS[result.provider]}/${result.modelId} apres ${result.failedOver.length} modele(s) indisponible(s).)`
    : "";

  return {
    text: `${text}${failoverNote}`,
    proposedToolCall: proposedToolCalls[0] ? { toolName: proposedToolCalls[0].capabilityId, arguments: proposedToolCalls[0].arguments } : null,
    proposedToolCalls,
    metrics: { evalCount: result.usage?.completionTokens, promptTokens: result.usage?.promptTokens, remoteModelId: result.modelId, remoteProvider: result.provider },
  };
}

function publicModel(model: LocalModel) {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model)) {
    if (key !== "filePath" && key !== "repoRoot") safe[key] = value;
  }
  return safe;
}

async function verifyInstalledModel(executable: string, modelFile: string) {
  const { stdout: versionOutput, stderr: versionErrors } = await execFileAsync(executable, ["--version"], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const { stdout: inferenceOutput } = await execFileAsync(executable, [
    "-m", modelFile,
    "-p", "Réponds uniquement par OK.",
    "-n", "8",
    "-c", "512",
    "-t", String(Math.max(1, Math.min(4, os.cpus().length))),
    "-ngl", "0",
    "--temp", "0",
    "--no-display-prompt",
    "--single-turn",
  ], {
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (!inferenceOutput.trim()) throw new Error("Le test d'inférence local n'a produit aucune réponse.");
  return {
    runtimeVersion: (versionOutput || versionErrors).trim().slice(0, 500),
    inferenceSample: inferenceOutput.trim().slice(0, 500),
  };
}

async function getSettings(prisma: PrismaLike, companyId: string) {
  return prisma.atlasAiSettings.findUnique({ where: { companyId } });
}

type MutationPreview = {
  summary: string;
  target: string;
  changes: Array<{ field: string; label: string; before: unknown; after: unknown }>;
  warnings: string[];
};

function normalizeCompanyProfileChanges(args: Record<string, any>) {
  const data: Record<string, string> = {};
  if (args.name !== undefined) data.name = requireText(args.name, "La raison sociale", 180);
  if (args.legalForm !== undefined) data.legalForm = requireText(args.legalForm, "La forme juridique", 80);
  if (args.city !== undefined) data.city = requireText(args.city, "La ville", 120);
  if (args.ice !== undefined) {
    const ice = String(args.ice ?? "").trim();
    if (ice && !/^\d{15}$/.test(ice)) throw new Error("L'ICE doit contenir exactement 15 chiffres.");
    data.ice = ice;
  }
  if (args.taxId !== undefined) data.taxId = String(args.taxId ?? "").trim().slice(0, 40);
  if (args.vatFrequency !== undefined) {
    const frequency = String(args.vatFrequency).toUpperCase();
    if (!new Set(["MONTHLY", "QUARTERLY"]).has(frequency)) throw new Error("La fréquence TVA est invalide.");
    data.vatFrequency = frequency;
  }
  if (!Object.keys(data).length) throw new Error("Aucun champ du dossier n'a été proposé.");
  return data;
}

function positiveCentString(value: unknown, label: string) {
  const raw = requireText(value, label, 30);
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error(`${label} doit contenir un nombre positif de centimes entiers.`);
  return BigInt(raw).toString();
}

export async function prepareWheatAiMutation(prisma: PrismaLike, companyId: string, toolName: string, rawArgs: Record<string, any>) {
  const args = { ...rawArgs };
  let preview: MutationPreview;
  let preconditions: Record<string, unknown> = {};
  if (toolName === "create_account_subdivision") {
    const parentCode = requireText(args.parentCode, "Le compte parent", 20).toUpperCase();
    const code = requireText(args.code, "Le nouveau compte", 20).toUpperCase();
    const label = requireText(args.label, "Le libellé", 180);
    if (!/^[0-9][0-9A-Z._-]{1,19}$/.test(code)) throw new Error("Le code du sous-compte est invalide.");
    const parent = await prisma.account.findFirst({ where: { companyId, code: parentCode } });
    if (!parent) throw new Error(`Le compte parent ${parentCode} n'existe pas dans ce dossier.`);
    if (!parent.active) throw new Error(`Le compte parent ${parentCode} est inactif.`);
    if (!code.startsWith(parent.code) || code.length <= parent.code.length) throw new Error(`Le sous-compte doit prolonger le code parent ${parent.code}.`);
    if (await prisma.account.findFirst({ where: { companyId, code }, select: { id: true } })) throw new Error(`Le compte ${code} existe déjà dans ce dossier.`);
    Object.assign(args, { parentCode, code, label });
    preview = { summary: `Créer la subdivision ${code}`, target: `Compte parent ${parent.code} · ${parent.label}`, changes: [{ field: "account", label: "Nouveau compte", before: "Absent", after: `${code} · ${label}` }], warnings: ["Le nouveau compte héritera des mappings et de la nature du compte parent."] };
    preconditions = { parentAccountId: parent.id, parentAccountVersion: parent.version, accountCodeMustBeAbsent: code };
  } else if (toolName === "update_company_profile") {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new Error("La société n'existe plus.");
    const data = normalizeCompanyProfileChanges(args);
    const changes = Object.entries(data).filter(([field, value]) => String(company[field] ?? "") !== value).map(([field, value]) => ({ field, label: ({ name: "Raison sociale", legalForm: "Forme juridique", ice: "ICE", taxId: "Identifiant fiscal", city: "Ville", vatFrequency: "Fréquence TVA" } as Record<string, string>)[field] ?? field, before: company[field] ?? "", after: value }));
    if (!changes.length) throw new Error("Les valeurs proposées sont déjà enregistrées dans le dossier.");
    Object.keys(args).forEach((key) => { if (!(key in data)) delete args[key]; });
    Object.assign(args, data);
    preview = { summary: "Modifier l'identité du dossier", target: company.name, changes, warnings: ["La version du dossier sera incrémentée et l'action sera auditée."] };
    preconditions = { companyVersion: company.version };
  } else if (toolName === "rename_custom_account") {
    const accountCode = requireText(args.accountCode, "Le compte", 20).toUpperCase();
    const label = requireText(args.label, "Le libellé", 180);
    const account = await prisma.account.findFirst({ where: { companyId, code: accountCode } });
    if (!account) throw new Error(`Le compte ${accountCode} n'existe pas dans ce dossier.`);
    if (account.isStandard) throw new Error("Un compte officiel PCGE ne peut pas être renommé.");
    if (account.label === label) throw new Error("Le compte porte déjà ce libellé.");
    Object.assign(args, { accountCode, label });
    preview = { summary: `Renommer le compte ${accountCode}`, target: `${accountCode} · ${account.label}`, changes: [{ field: "label", label: "Libellé", before: account.label, after: label }], warnings: ["Les libellés instantanés des écritures encore en brouillon seront actualisés."] };
    preconditions = { accountId: account.id, accountVersion: account.version };
  } else if (toolName === "add_fiscal_table_row" || toolName === "mark_fiscal_table_not_applicable") {
    const tableId = requireText(args.tableId, "Le tableau", 10).toUpperCase();
    const definition = fiscalTableDefinition(tableId);
    if (!definition) throw new Error("Le tableau fiscal doit être compris entre T01 et T25.");
    const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
    if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
    const workpaper = await prisma.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId: fiscalPackage.id, tableId } });
    if (!workpaper || workpaper.status !== "DRAFT") throw new Error("Le tableau fiscal ciblé n'est plus modifiable.");
    Object.assign(args, { tableId, _fiscalPackageId: fiscalPackage.id, _expectedRevision: workpaper.revision });
    if (toolName === "add_fiscal_table_row") {
      if (!args.row || typeof args.row !== "object" || Array.isArray(args.row)) throw new Error("La ligne fiscale proposée est invalide.");
      preview = { summary: `Ajouter une ligne au tableau ${definition.number}`, target: definition.label, changes: [{ field: "manualRows", label: "Nouvelle ligne", before: "Aucune modification", after: args.row }], warnings: ["La ligne sera enregistrée en brouillon et devra satisfaire les contrôles du tableau avant revue."] };
    } else {
      const reason = requireText(args.reason, "Le motif de non-applicabilité", 500);
      if (reason.length < 5) throw new Error("Le motif de non-applicabilité doit être suffisamment précis.");
      args.reason = reason;
      preview = { summary: `Marquer le tableau ${definition.number} non applicable`, target: definition.label, changes: [{ field: "status", label: "Statut", before: "Brouillon", after: "Non applicable" }, { field: "reason", label: "Motif", before: "", after: reason }], warnings: ["Le tableau restera visible et comptera comme complet."] };
    }
    preconditions = { fiscalPackageId: fiscalPackage.id, fiscalPackageStatus: fiscalPackage.status, workpaperId: workpaper.id, workpaperRevision: workpaper.revision, workpaperStatus: workpaper.status };
  } else if (toolName === "add_fiscal_adjustment") {
    const kind = requireText(args.kind, "Le type d'ajustement", 20).toUpperCase();
    if (!new Set(["REINTEGRATION", "DEDUCTION"]).has(kind)) throw new Error("Le type d'ajustement fiscal est invalide.");
    const label = requireText(args.label, "Le libellé", 250);
    const amountCents = positiveCentString(args.amountCents, "Le montant");
    const legalReference = requireText(args.legalReference, "La référence légale", 500);
    const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
    if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
    Object.assign(args, { kind, label, amountCents, legalReference, _fiscalPackageId: fiscalPackage.id });
    preview = { summary: kind === "REINTEGRATION" ? "Ajouter une réintégration fiscale" : "Ajouter une déduction fiscale", target: `Liasse ${fiscalPackage.templateVersion}`, changes: [{ field: "adjustment", label: label, before: "Absent", after: `${amountCents} centimes · ${legalReference}` }], warnings: ["L'ajustement sera non vérifié et bloquera la revue du tableau 3 jusqu'à validation humaine."] };
    preconditions = { fiscalPackageId: fiscalPackage.id, fiscalPackageStatus: fiscalPackage.status };
  } else if (toolName === "remember_company_knowledge") {
    const kind = requireText(args.kind, "Le type de règle", 60).toUpperCase();
    const key = requireText(args.key, "La clé de la règle", 160);
    const confidenceBps = Math.min(10_000, Math.max(0, Number(args.confidenceBps ?? 5_000)));
    if (!Number.isInteger(confidenceBps)) throw new Error("Le niveau de confiance doit être exprimé en points de base entiers.");
    Object.assign(args, { kind, key, confidenceBps, value: args.value ?? {}, evidence: Array.isArray(args.evidence) ? args.evidence : [] });
    preview = { summary: `Mémoriser la règle ${key}`, target: `Connaissance ${kind}`, changes: [{ field: "knowledge", label: "Règle dossier", before: "Non enregistrée ou ancienne valeur", after: args.value }], warnings: ["Cette connaissance reste propre au dossier et ne constitue pas une règle légale."] };
  } else {
    throw new Error("Cette modification Wheat AI n'est pas prise en charge.");
  }
  return { arguments: args, preview, preconditions };
}

async function assertProposalFresh(prisma: PrismaLike, companyId: string, preconditions: Record<string, any>) {
  if (preconditions.companyVersion !== undefined) {
    const company = await prisma.company.findUnique({ where: { id: companyId }, select: { version: true } });
    if (!company || company.version !== preconditions.companyVersion) throw new Error("Le dossier a changé depuis la proposition. Demandez à Wheat AI de la préparer à nouveau.");
  }
  if (preconditions.parentAccountId) {
    const parent = await prisma.account.findFirst({ where: { id: preconditions.parentAccountId, companyId } });
    if (!parent || parent.version !== preconditions.parentAccountVersion || !parent.active) throw new Error("Le compte parent a changé depuis la proposition.");
    if (await prisma.account.findFirst({ where: { companyId, code: preconditions.accountCodeMustBeAbsent }, select: { id: true } })) throw new Error("Le compte proposé existe désormais. Préparez une nouvelle proposition.");
  }
  if (preconditions.accountId) {
    const account = await prisma.account.findFirst({ where: { id: preconditions.accountId, companyId } });
    if (!account || account.version !== preconditions.accountVersion) throw new Error("Le compte a changé depuis la proposition. Demandez une nouvelle proposition.");
  }
  if (preconditions.fiscalPackageId) {
    const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { id: preconditions.fiscalPackageId, companyId } });
    if (!fiscalPackage || fiscalPackage.status !== preconditions.fiscalPackageStatus) throw new Error("La liasse a changé depuis la proposition.");
  }
  if (preconditions.workpaperId) {
    const workpaper = await prisma.fiscalTableWorkpaper.findFirst({ where: { id: preconditions.workpaperId, fiscalPackage: { companyId } } });
    if (!workpaper || workpaper.revision !== preconditions.workpaperRevision || workpaper.status !== preconditions.workpaperStatus) throw new Error("Le tableau fiscal a changé depuis la proposition. Préparez-la à nouveau.");
  }
}

async function executeTypedTool(prisma: PrismaLike, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const toolName = String(payload.toolName ?? "");
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === toolName);
  if (!definition) throw new Error("Cet outil Wheat AI n'est pas enregistré.");
  const settings = await getSettings(prisma, companyId);
  const permissionMode = String(settings?.permissionMode ?? "ASSISTANT") as PermissionMode;
  const sessionId = typeof payload.sessionId === "string" && payload.sessionId ? payload.sessionId.slice(0, 120) : randomUUID();
  const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments) ? payload.arguments as Record<string, any> : {};
  const requiresConfirmation = definition.risk === "HIGH_STAKES" || definition.risk === "MUTATING";
  const started = Date.now(); let status = "SUCCEEDED"; let result: any;
  try {
    if (definition.risk !== "READ" && permissionMode === "READ_ONLY") throw new Error("Wheat AI est en lecture seule.");
    if (requiresConfirmation && payload.confirmed !== true) throw new Error("Cet outil exige une confirmation humaine explicite.");
    if (definition.risk === "HIGH_STAKES") throw new Error("La comptabilisation reste indisponible depuis Wheat AI. Utilisez l'écran métier dédié.");
    if (toolName === "search_accounts") result = await searchCompanyAccounts(prisma, companyId, { query: String(args.query ?? ""), classNo: args.classNo === undefined ? undefined : Number(args.classNo), active: true, limit: Math.min(Number(args.limit ?? 50), 200) });
    else if (toolName === "get_entries") {
      const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
      result = await prisma.entry.findMany({ where: { companyId, ...(args.from || args.to ? { date: { ...(args.from ? { gte: day(args.from, "La date de début") } : {}), ...(args.to ? { lte: day(args.to, "La date de fin") } : {}) } } : {}), ...(args.query ? { OR: [{ number: { contains: String(args.query) } }, { pieceNumber: { contains: String(args.query) } }, { label: { contains: String(args.query) } }] } : {}) }, include: { journal: true, lines: true }, orderBy: [{ date: "desc" }, { number: "desc" }], take: limit });
    } else if (toolName === "get_balance") result = await buildBalanceFamily(prisma, { companyId, ...args });
    else if (toolName === "get_bilan") result = await buildBilan(prisma, { companyId, ...args });
    else if (toolName === "get_cpc") result = await buildComparativeCpc(prisma, { companyId, ...args });
    else if (toolName === "get_bank_position") result = await buildBankTotal(prisma, { companyId, ...args });
    else if (toolName === "get_invoices") {
      const limit = Math.min(Math.max(Number(args.limit ?? 40), 1), 100);
      const query = String(args.query ?? "").trim().slice(0, 160);
      result = await prisma.invoice.findMany({ where: { companyId, ...(args.from || args.to ? { invoiceDate: { ...(args.from ? { gte: day(args.from, "La date de début") } : {}), ...(args.to ? { lte: day(args.to, "La date de fin") } : {}) } } : {}), ...(query ? { OR: [{ invoiceNo: { contains: query } }, { counterparty: { contains: query } }, { counterpartyNameSnapshot: { contains: query } }] } : {}) }, select: { id: true, kind: true, documentType: true, invoiceNo: true, invoiceDate: true, dueDate: true, counterparty: true, currency: true, htCents: true, vatCents: true, ttcCents: true, lifecycleStatus: true, needsReview: true }, orderBy: [{ invoiceDate: "desc" }, { invoiceNo: "desc" }], take: limit });
    }
    else if (toolName === "get_documents") {
      const limit = Math.min(Math.max(Number(args.limit ?? 40), 1), 100);
      const query = String(args.query ?? "").trim().slice(0, 160);
      result = await prisma.document.findMany({ where: { companyId, ...(query ? { OR: [{ title: { contains: query } }, { type: { contains: query } }, { tags: { contains: query } }] } : {}) }, select: { id: true, title: true, type: true, fiscalYear: true, tags: true, status: true, revision: true, contentSha256: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: limit });
    }
    else if (toolName === "get_vat_status") result = await prisma.taxPeriod.findMany({ where: { companyId }, select: { id: true, label: true, collectedVatCents: true, deductibleVatCents: true, dueVatCents: true, creditVatCents: true, status: true, declarationDue: true }, orderBy: { declarationDue: "desc" }, take: Math.min(Math.max(Number(args.limit ?? 24), 1), 60) });
    else if (toolName === "get_payroll_summary") result = await prisma.payrollRun.findMany({ where: { companyId }, select: { id: true, period: true, status: true, postedAt: true, voidedAt: true, _count: { select: { lines: true } } }, orderBy: { period: "desc" }, take: Math.min(Math.max(Number(args.limit ?? 24), 1), 60) });
    else if (toolName === "get_fiscal_package") {
      const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL" }, orderBy: { updatedAt: "desc" } });
      result = fiscalPackage ? await buildFiscalControl(prisma, { companyId, fiscalPackageId: fiscalPackage.id }) : { prepared: false, message: "Aucune liasse normale n'a encore été préparée." };
    }
    else if (toolName === "retrieve_company_knowledge") result = { source: PCGE_SOURCE, patterns: await prisma.atlasKnowledgePattern.findMany({ where: { companyId, active: true, ...(args.kind ? { kind: String(args.kind) } : {}) }, orderBy: [{ confidenceBps: "desc" }, { updatedAt: "desc" }], take: Math.min(Math.max(Number(args.limit ?? 30), 1), 100) }) };
    else if (toolName === "create_account_subdivision") {
      result = await createCustomSubaccount(prisma, { companyId, parentCode: String(args.parentCode ?? ""), code: String(args.code ?? ""), label: String(args.label ?? "") });
      await appendActivityAndAudit(prisma, { companyId, actorUserId: actorUserId ?? null, action: "ATLAS_AI_CREATE_ACCOUNT", entityType: "Account", entityId: result.id, description: `Wheat AI a créé le compte ${result.code} après confirmation`, payload: { parentCode: args.parentCode, code: result.code, label: result.label, sessionId } });
    } else if (toolName === "update_company_profile") {
      const current = await prisma.company.findUnique({ where: { id: companyId } });
      if (!current) throw new Error("La société n'existe plus.");
      const data = normalizeCompanyProfileChanges(args);
      result = await prisma.company.update({ where: { id: companyId }, data: { ...data, version: { increment: 1 } } });
      await appendActivityAndAudit(prisma, { companyId, actorUserId: actorUserId ?? null, action: "ATLAS_AI_UPDATE_COMPANY", entityType: "Company", entityId: companyId, description: "Wheat AI a modifié l'identité du dossier après confirmation", payload: { changedFields: Object.keys(data), beforeVersion: current.version, afterVersion: result.version, sessionId } });
    } else if (toolName === "rename_custom_account") {
      const accountCode = requireText(args.accountCode, "Le compte", 20);
      const label = requireText(args.label, "Le libellé", 180);
      const account = await prisma.account.findFirst({ where: { companyId, code: accountCode } });
      if (!account) throw new Error("Le compte proposé n'existe pas dans ce dossier.");
      if (account.isStandard) throw new Error("Un compte officiel PCGE ne peut pas être renommé.");
      result = await prisma.account.update({ where: { id: account.id }, data: { label, searchText: `${account.code} ${label}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(), version: { increment: 1 } } });
      await prisma.entryLine.updateMany({ where: { accountId: account.id, entry: { status: "DRAFT" } }, data: { accountLabelSnapshot: label } });
      await appendActivityAndAudit(prisma, { companyId, actorUserId: actorUserId ?? null, action: "ATLAS_AI_RENAME_ACCOUNT", entityType: "Account", entityId: account.id, description: `Wheat AI a renommé le compte ${account.code} après confirmation`, payload: { before: account.label, after: label, sessionId } });
    } else if (toolName === "add_fiscal_table_row") {
      const tableId = requireText(args.tableId, "Le tableau", 10).toUpperCase();
      const fiscalPackage = args._fiscalPackageId
        ? await prisma.fiscalPackage.findFirst({ where: { id: String(args._fiscalPackageId), companyId, regime: "NORMAL", status: "DRAFT" } })
        : await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
      if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
      const workpaper = await prisma.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId: fiscalPackage.id, tableId } });
      if (!workpaper) throw new Error("Le tableau fiscal proposé n'existe pas dans la liasse active.");
      const existingRows = JSON.parse(workpaper.manualJson || "[]");
      result = await saveFiscalTable({ prisma, actorUserId }, { companyId, fiscalPackageId: fiscalPackage.id, tableId, expectedRevision: workpaper.revision, manualRows: [...existingRows, args.row], confirmed: true });
    } else if (toolName === "mark_fiscal_table_not_applicable") {
      const tableId = requireText(args.tableId, "Le tableau", 10).toUpperCase();
      const fiscalPackage = args._fiscalPackageId
        ? await prisma.fiscalPackage.findFirst({ where: { id: String(args._fiscalPackageId), companyId, regime: "NORMAL", status: "DRAFT" } })
        : await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
      if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
      const workpaper = await prisma.fiscalTableWorkpaper.findFirst({ where: { fiscalPackageId: fiscalPackage.id, tableId } });
      if (!workpaper) throw new Error("Le tableau fiscal proposé n'existe pas dans la liasse active.");
      result = await markFiscalTableNotApplicable({ prisma, actorUserId }, { companyId, fiscalPackageId: fiscalPackage.id, tableId, expectedRevision: workpaper.revision, reason: args.reason, confirmed: true });
    } else if (toolName === "add_fiscal_adjustment") {
      const fiscalPackage = args._fiscalPackageId
        ? await prisma.fiscalPackage.findFirst({ where: { id: String(args._fiscalPackageId), companyId, regime: "NORMAL", status: "DRAFT" } })
        : await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL", status: "DRAFT" }, orderBy: { updatedAt: "desc" } });
      if (!fiscalPackage) throw new Error("Préparez d'abord une liasse normale en brouillon.");
      result = await addFiscalAdjustment({ prisma, actorUserId }, { companyId, fiscalPackageId: fiscalPackage.id, kind: args.kind, label: args.label, amountCents: args.amountCents, legalReference: args.legalReference, evidence: [], confirmed: true });
    } else if (toolName === "remember_company_knowledge") {
      const kind = requireText(args.kind, "Le type de règle", 60).toUpperCase();
      const key = requireText(args.key, "La clé de la règle", 160);
      const confidenceBps = Math.min(10_000, Math.max(0, Number(args.confidenceBps ?? 5_000)));
      if (!Number.isInteger(confidenceBps)) throw new Error("Le niveau de confiance doit être exprimé en points de base entiers.");
      result = await prisma.atlasKnowledgePattern.upsert({
        where: { companyId_kind_key: { companyId, kind, key } },
        create: { companyId, kind, key, valueJson: safeJson(args.value ?? {}), evidenceJson: safeJson(Array.isArray(args.evidence) ? args.evidence : []), confidenceBps },
        update: { valueJson: safeJson(args.value ?? {}), evidenceJson: safeJson(Array.isArray(args.evidence) ? args.evidence : []), confidenceBps, active: true },
      });
      await appendActivityAndAudit(prisma, { companyId, actorUserId: actorUserId ?? null, action: "ATLAS_AI_REMEMBER_KNOWLEDGE", entityType: "AtlasKnowledgePattern", entityId: result.id, description: `Wheat AI a mémorisé la règle ${key} après confirmation`, payload: { kind, key, confidenceBps, sessionId } });
    }
    else throw new Error("L'outil Wheat AI n'a pas d'implémentation.");
    return { sessionId, toolName, result };
  } catch (error) { status = "FAILED"; throw error; }
  finally {
    const summary = result ? { kind: Array.isArray(result) ? "ARRAY" : "OBJECT", count: Array.isArray(result) ? result.length : undefined, keys: result && !Array.isArray(result) ? Object.keys(result).slice(0, 20) : undefined } : {};
    await prisma.atlasAiAuditEvent.create({ data: { companyId, actorUserId: actorUserId ?? null, sessionId, toolName, permissionMode, requestJson: safeJson(args).slice(0, 100_000), resultSummaryJson: safeJson(summary), confirmationJson: safeJson({ required: requiresConfirmation, confirmed: payload.confirmed === true }), status, durationMs: Date.now() - started } }).catch(() => undefined);
  }
}

function normalizedChatMessages(payload: Record<string, any>) {
  if (!Array.isArray(payload.messages)) return [];
  return payload.messages.slice(-20).map((item: any) => ({
    role: item?.role === "assistant" ? "assistant" as const : "user" as const,
    content: String(item?.content ?? "").slice(0, 8000),
  })).filter((item: { content: string }) => item.content.trim());
}

function boundedReference(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, any>;
  const allowed = ["id", "entryId", "invoiceId", "paymentId", "documentId", "fiscalPackageId", "tableId", "movementId", "reconciliationId", "batchId", "code", "number", "label", "displayName", "status", "lifecycleStatus", "version", "revision", "date"];
  const result: Record<string, unknown> = Object.fromEntries(allowed.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, String(source[key]).slice(0, 240)]));
  if (source.navigation && typeof source.navigation === "object") result.navigation = { target: String(source.navigation.target ?? "").slice(0, 40), entityId: source.navigation.entityId ? String(source.navigation.entityId).slice(0, 200) : null };
  return Object.keys(result).length ? result : null;
}

function boundedRecentActionContext(payload: Record<string, any>) {
  if (!Array.isArray(payload.messages)) return [];
  const recent: Array<Record<string, unknown>> = [];
  for (const message of payload.messages.slice(-10)) {
    const proposals = Array.isArray(message?.actionProposals) ? message.actionProposals : message?.actionProposal ? [message.actionProposal] : [];
    for (const proposal of proposals.slice(0, 10)) {
      recent.push({ kind: "PROPOSAL", capabilityId: String(proposal?.toolName ?? proposal?.capabilityId ?? "").slice(0, 100), status: String(proposal?.actionStatus ?? "PENDING").slice(0, 40), arguments: boundedReference(proposal?.arguments), affectedRecords: Array.isArray(proposal?.preview?.affectedRecords) ? proposal.preview.affectedRecords.slice(0, 20).map(boundedReference).filter(Boolean) : [] });
    }
    for (const action of (Array.isArray(message?.actionResults) ? message.actionResults : []).slice(0, 25)) {
      const rawResult = action?.result?.result ?? action?.result;
      recent.push({ kind: "RESULT", capabilityId: String(action?.capabilityId ?? action?.toolName ?? "").slice(0, 100), status: String(action?.status ?? "UNKNOWN").slice(0, 40), entity: boundedReference(rawResult), affectedRecords: Array.isArray(action?.affectedRecords) ? action.affectedRecords.slice(0, 20).map(boundedReference).filter(Boolean) : [] });
    }
  }
  return recent.slice(-30);
}

function isoDay(value: unknown) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
}

function lastUserMessage(payload: Record<string, any>) {
  return [...normalizedChatMessages(payload)].reverse().find((item) => item.role === "user")?.content ?? "";
}

function modelCapabilityName(id: string) {
  return `atlas__${id.replace(/\./g, "__")}`;
}

function capabilityIdFromModelName(value: unknown) {
  const name = String(value ?? "");
  return name.startsWith("atlas__") ? name.slice(7).replace(/__/g, ".") : canonicalWheatAiCapabilityId(name);
}

function ollamaCapabilitySchema(definition: WheatAiCapabilityDefinition) {
  return { type: "function", function: { name: modelCapabilityName(definition.id), description: `[Niveau ${definition.riskLevel} · ${definition.mode}] ${definition.description}`, parameters: definition.inputSchema } };
}

function boundedToolResult(name: string, value: any) {
  if (["get_entries", "search_accounts", "get_invoices", "get_documents", "get_vat_status", "get_payroll_summary", "retrieve_company_knowledge"].includes(name) && Array.isArray(value)) return value.slice(0, 100);
  if (name === "get_balance" && Array.isArray(value?.rows)) return { ...value, rows: value.rows.slice(0, 80), omittedRowCount: Math.max(0, value.rows.length - 80) };
  if (name === "get_bilan") return { ...value, actif: value?.actif?.slice?.(0, 80) ?? [], passif: value?.passif?.slice?.(0, 80) ?? [], omittedRowCount: Math.max(0, Number(value?.actif?.length ?? 0) + Number(value?.passif?.length ?? 0) - 160) };
  if (name === "get_cpc" && Array.isArray(value?.rows)) return { ...value, rows: value.rows.slice(0, 100), omittedRowCount: Math.max(0, value.rows.length - 100) };
  if (name === "get_bank_position" && Array.isArray(value?.rows)) return { ...value, rows: value.rows.slice(0, 100), omittedRowCount: Math.max(0, value.rows.length - 100) };
  if (name === "retrieve_company_knowledge" && Array.isArray(value?.patterns)) return { ...value, patterns: value.patterns.slice(0, 30), omittedPatternCount: Math.max(0, value.patterns.length - 30) };
  return value;
}

export async function buildWheatAiChatContext(prisma: PrismaLike, companyId: string, payload: Record<string, any>, appVersion: string) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true, name: true, legalForm: true, ice: true, taxId: true, city: true, baseCurrency: true, vatFrequency: true, version: true,
      fiscalYears: { orderBy: { endsOn: "desc" }, select: { id: true, label: true, startsOn: true, endsOn: true, status: true, lockedTo: true } },
      _count: { select: { accounts: true, journals: true, entries: true, invoices: true, documents: true, bankAccounts: true, payments: true, counterparties: true, taxPeriods: true, employees: true, payrollRuns: true, fiscalPackages: true, atlasKnowledgePatterns: true } },
    },
  });
  if (!company) throw new Error("La société n'existe plus.");
  const fiscalYear = company.fiscalYears.find((year: any) => year.status === "OPEN") ?? company.fiscalYears[0];
  const prompt = lastUserMessage(payload);
  const normalized = prompt.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const date = prompt.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  const to = date ?? (fiscalYear ? isoDay(fiscalYear.endsOn) : undefined);
  const from = fiscalYear ? isoDay(fiscalYear.startsOn) : undefined;
  const results: Record<string, unknown> = {};
  const toolsUsed: string[] = [];
  const contextSources = [`Guide produit Wheat ${appVersion}`, `Dossier ${company.name}`];
  const recordToolResult = (name: string, result: unknown) => { results[name] = boundedToolResult(name, result); toolsUsed.push(name); contextSources.push(name); };
  if (fiscalYear && /\b(balance|soldes? des comptes)\b/.test(normalized) && !/\bbilan\b/.test(normalized)) {
    recordToolResult("get_balance", await buildBalanceFamily(prisma, { companyId, view: "GENERAL", from, to }));
  }
  if (fiscalYear && /\b(bilan|actif|passif)\b/.test(normalized)) recordToolResult("get_bilan", await buildBilan(prisma, { companyId, asOf: to, variant: "NORMAL", view: "COMPARATIVE" }));
  if (fiscalYear && /\b(cpc|esg|solde[s]? de gestion|resultat comptable)\b/.test(normalized)) recordToolResult("get_cpc", await buildComparativeCpc(prisma, { companyId, fiscalYearId: fiscalYear.id }));
  if (/\b(tresorerie|banque|position bancaire|cash)\b/.test(normalized)) recordToolResult("get_bank_position", await buildBankTotal(prisma, { companyId, asOf: to }));
  if (/\b(ecriture|journal|piece comptable)\b/.test(normalized)) {
    recordToolResult("get_entries", await prisma.entry.findMany({ where: { companyId, ...(from && to ? { date: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } } : {}) }, select: { id: true, number: true, pieceNumber: true, date: true, label: true, status: true, source: true }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 40 }));
  }
  if (/\b(compte|pcge|plan comptable)\b/.test(normalized)) {
    const accountCodes = [...new Set(normalized.match(/\b[0-9][0-9a-z._-]{1,19}\b/g) ?? [])].slice(0, 4);
    if (accountCodes.length) {
      const matches = (await Promise.all(accountCodes.map((query) => searchCompanyAccounts(prisma, companyId, { query, active: true, limit: 15 })))).flat();
      recordToolResult("search_accounts", [...new Map(matches.map((item: any) => [item.id ?? item.code, item])).values()].slice(0, 40));
    } else recordToolResult("search_accounts", await searchCompanyAccounts(prisma, companyId, { query: prompt.slice(0, 200), active: true, limit: 40 }));
  }
  if (/\b(factures?|avoirs?|echeances?|impayes?|clients?|fournisseurs?)\b/.test(normalized)) {
    recordToolResult("get_invoices", await prisma.invoice.findMany({ where: { companyId, ...(from && to ? { invoiceDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } } : {}) }, select: { id: true, kind: true, documentType: true, invoiceNo: true, invoiceDate: true, dueDate: true, counterparty: true, currency: true, htCents: true, vatCents: true, ttcCents: true, lifecycleStatus: true, needsReview: true }, orderBy: [{ invoiceDate: "desc" }, { invoiceNo: "desc" }], take: 40 }));
  }
  if (/\b(documents?|pieces? jointes?|ocr|justificatifs?)\b/.test(normalized)) recordToolResult("get_documents", await prisma.document.findMany({ where: { companyId }, select: { id: true, title: true, type: true, fiscalYear: true, tags: true, status: true, revision: true, contentSha256: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 40 }));
  if (/\b(tva|taxe sur la valeur ajoutee|declaration tva)\b/.test(normalized)) recordToolResult("get_vat_status", await prisma.taxPeriod.findMany({ where: { companyId }, select: { id: true, label: true, collectedVatCents: true, deductibleVatCents: true, dueVatCents: true, creditVatCents: true, status: true, declarationDue: true }, orderBy: { declarationDue: "desc" }, take: 24 }));
  if (/\b(paie|salaire|bulletin|masse salariale)\b/.test(normalized)) recordToolResult("get_payroll_summary", await prisma.payrollRun.findMany({ where: { companyId }, select: { id: true, period: true, status: true, postedAt: true, voidedAt: true, _count: { select: { lines: true } } }, orderBy: { period: "desc" }, take: 24 }));
  if (/\b(liasse|fiscal|tableau fiscal)\b/.test(normalized)) {
    const fiscalPackage = await prisma.fiscalPackage.findFirst({ where: { companyId, regime: "NORMAL" }, orderBy: { updatedAt: "desc" } });
    recordToolResult("get_fiscal_package", fiscalPackage ? await buildFiscalControl(prisma, { companyId, fiscalPackageId: fiscalPackage.id }) : { prepared: false, message: "Aucune liasse normale n'a encore été préparée." });
  }
  if (/\b(habitude|regle du dossier|schema|connaissance|modif|creer|ajouter|renommer|memoriser)\b/.test(normalized) && prisma.atlasKnowledgePattern?.findMany) recordToolResult("retrieve_company_knowledge", { source: PCGE_SOURCE, patterns: await prisma.atlasKnowledgePattern.findMany({ where: { companyId, active: true }, orderBy: [{ confidenceBps: "desc" }, { updatedAt: "desc" }], take: 30 }) });
  const dossier = {
    ...company,
    activeFiscalYearId: fiscalYear?.id ?? null,
    activeFiscalYearSelection: company.fiscalYears.some((year: any) => year.status === "OPEN") ? "LATEST_OPEN" : "LATEST_AVAILABLE",
    availableModules: {
      accounting: true,
      invoicing: true,
      documents: true,
      banking: true,
      vat: true,
      payroll: true,
      fiscalPreparation: true,
      atlasAi: true,
      statutoryFiscalExport: false,
    },
    fiscalYears: company.fiscalYears.map((year: any) => ({ ...year, startsOn: isoDay(year.startsOn), endsOn: isoDay(year.endsOn), lockedTo: year.lockedTo ? isoDay(year.lockedTo) : null })),
  };
  return {
    productKnowledge: wheatProductKnowledge(appVersion),
    dossier,
    routedResults: results,
    contextSources,
    toolsUsed,
  };
}

function actionFromText(textValue: unknown) {
  const text = String(textValue ?? "");
  const marker = text.search(/ACTION_PROPOSAL\s*:?/i);
  if (marker < 0) return null;
  const start = text.indexOf("{", marker);
  if (start < 0) return null;
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quoted) { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(start, index + 1));
        const legacy = TOOL_DEFINITIONS.find((tool) => tool.name === parsed?.toolName && tool.risk === "MUTATING");
        const capability = getWheatAiCapability(parsed?.toolName);
        if ((!legacy && (!capability || capability.mode === "READ")) || !parsed.arguments || typeof parsed.arguments !== "object" || Array.isArray(parsed.arguments)) return null;
        return { toolName: capability?.id ?? legacy!.name, arguments: parsed.arguments, visibleText: text.slice(0, marker).trim() };
      } catch { return null; }
    }
  }
  return null;
}

function proposalLabel(toolName: string, args: Record<string, any>) {
  if (toolName === "create_account_subdivision") return `Créer le compte ${String(args.code ?? "")} · ${String(args.label ?? "")}`;
  if (toolName === "update_company_profile") return "Modifier l'identité du dossier";
  if (toolName === "rename_custom_account") return `Renommer le compte ${String(args.accountCode ?? "")}`;
  if (toolName === "add_fiscal_table_row") return `Ajouter une ligne au tableau ${String(args.tableId ?? "")}`;
  if (toolName === "mark_fiscal_table_not_applicable") return `Marquer le tableau ${String(args.tableId ?? "")} non applicable`;
  if (toolName === "add_fiscal_adjustment") return `Ajouter ${String(args.kind ?? "") === "DEDUCTION" ? "une déduction" : "une réintégration"} fiscale`;
  if (toolName === "remember_company_knowledge") return `Mémoriser la règle ${String(args.key ?? "")}`;
  return `Exécuter ${toolName}`;
}

function capabilityActionLabel(definition: WheatAiCapabilityDefinition, prepared: { preview: { summary: string } }) {
  return prepared.preview.summary || definition.description;
}

function capabilityRequiresConfirmation(definition: WheatAiCapabilityDefinition, permissionMode: PermissionMode) {
  if (definition.confirmation === "ALWAYS" || definition.riskLevel === 3) return true;
  if (definition.riskLevel === 2) return permissionMode !== "AUTOMATED";
  return false;
}

function resolvedAffectedRecords(prepared: { preview: { affectedRecords: Array<Record<string, any>> } } | null, result: unknown) {
  const records = (prepared?.preview.affectedRecords ?? []).map((item) => ({ ...item }));
  const reference = boundedReference(result) as Record<string, any> | null;
  if (!records.length && reference?.id) records.push({ type: "record", id: reference.id, label: reference.label ?? reference.displayName ?? reference.code ?? reference.number ?? reference.id });
  if (records[0] && reference) {
    records[0].id ??= reference.id;
    records[0].label = [reference.code ?? reference.number, reference.label ?? reference.displayName].filter(Boolean).join(" — ") || records[0].label;
  }
  return records;
}

async function persistCapabilityProposal(prisma: PrismaLike, gateway: WheatAiDomainGateway, input: { companyId: string; actorUserId?: string | null; sessionId: string; permissionMode: PermissionMode; capabilityId: string; arguments: Record<string, any> }) {
  const prepared = await gateway.prepare(input.companyId, input.capabilityId, input.arguments);
  const event = await prisma.atlasAiAuditEvent.create({ data: {
    companyId: input.companyId,
    actorUserId: input.actorUserId ?? null,
    sessionId: input.sessionId,
    toolName: prepared.definition.id,
    permissionMode: input.permissionMode,
    requestJson: safeJson(prepared.arguments).slice(0, 100_000),
    resultSummaryJson: safeJson({ category: prepared.definition.category, riskLevel: prepared.definition.riskLevel, origin: "ATLAS_AI" }),
    confirmationJson: safeJson({ required: true, confirmed: false, preview: prepared.preview, preconditions: prepared.preconditions, riskLevel: prepared.definition.riskLevel, auditCategory: prepared.definition.auditCategory }),
    status: "PENDING_CONFIRMATION",
    durationMs: 0,
  } });
  return { id: event.id, toolName: prepared.definition.id, capabilityId: prepared.definition.id, label: capabilityActionLabel(prepared.definition, prepared), arguments: prepared.arguments, preview: prepared.preview, riskLevel: prepared.definition.riskLevel, requiresConfirmation: true, actionStatus: "PENDING" };
}

async function auditImmediateCapability(prisma: PrismaLike, input: { companyId: string; actorUserId?: string | null; sessionId: string; permissionMode: PermissionMode; definition: WheatAiCapabilityDefinition; arguments: Record<string, any>; status: string; durationMs: number; result?: unknown; error?: unknown; intent: WheatAiIntent }) {
  const summary = input.error
    ? { origin: "ATLAS_AI", riskLevel: input.definition.riskLevel, intent: input.intent, error: input.error instanceof Error ? input.error.message : String(input.error) }
    : { origin: "ATLAS_AI", riskLevel: input.definition.riskLevel, intent: input.intent, resultKind: Array.isArray(input.result) ? "ARRAY" : typeof input.result };
  await prisma.atlasAiAuditEvent.create({ data: {
    companyId: input.companyId, actorUserId: input.actorUserId ?? null, sessionId: input.sessionId, toolName: input.definition.id, permissionMode: input.permissionMode,
    requestJson: safeJson(input.arguments).slice(0, 100_000), resultSummaryJson: safeJson(summary), confirmationJson: safeJson({ required: false, confirmed: false, intent: input.intent }), status: input.status, durationMs: input.durationMs,
  } }).catch(() => undefined);
}

export async function processWheatAiCapabilityCalls(input: {
  prisma: PrismaLike;
  gateway: WheatAiDomainGateway;
  companyId: string;
  actorUserId?: string | null;
  sessionId: string;
  permissionMode: PermissionMode;
  prompt: string;
  dryRun: boolean;
  calls: Array<{ capabilityId?: string; toolName?: string; arguments?: Record<string, any> }>;
}) {
  const intent = classifyWheatAiIntent(input.prompt, input.dryRun);
  const proposals: any[] = [];
  const results: any[] = [];
  for (const [index, call] of input.calls.slice(0, 25).entries()) {
    const capabilityId = canonicalWheatAiCapabilityId(call.capabilityId ?? call.toolName);
    const definition = getWheatAiCapability(capabilityId);
    if (!definition) {
      results.push({ index, capabilityId, status: "REJECTED", error: "Capacité inconnue." });
      continue;
    }
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
    if (definition.mode !== "READ" && definition.mode !== "NAVIGATION" && input.permissionMode === "READ_ONLY") {
      results.push({ index, capabilityId, status: "REJECTED", error: "Wheat AI est en lecture seule." });
      continue;
    }
    if (definition.riskLevel > 0 && intent !== "EXECUTION" && intent !== "PREVIEW") {
      results.push({ index, capabilityId, status: "NOT_AUTHORIZED_BY_INTENT", error: "La formulation ne constitue pas une autorisation explicite de modifier le dossier." });
      continue;
    }
    if (definition.riskLevel > 0 && intent === "PREVIEW") {
      try {
        const prepared = await input.gateway.prepare(input.companyId, definition.id, args);
        proposals.push({ id: `dry-run-${randomUUID()}`, toolName: definition.id, capabilityId: definition.id, label: capabilityActionLabel(definition, prepared), arguments: prepared.arguments, preview: prepared.preview, riskLevel: definition.riskLevel, requiresConfirmation: false, dryRun: true, actionStatus: "DRY_RUN" });
        results.push({ index, capabilityId: definition.id, status: "DRY_RUN", preview: prepared.preview });
      } catch (error) {
        results.push({ index, capabilityId: definition.id, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    if (definition.riskLevel > 0 && capabilityRequiresConfirmation(definition, input.permissionMode)) {
      try {
        const proposal = await persistCapabilityProposal(input.prisma, input.gateway, { companyId: input.companyId, actorUserId: input.actorUserId, sessionId: input.sessionId, permissionMode: input.permissionMode, capabilityId: definition.id, arguments: args });
        proposals.push(proposal);
        results.push({ index, capabilityId: definition.id, status: "PENDING_CONFIRMATION", proposalId: proposal.id });
      } catch (error) {
        results.push({ index, capabilityId: definition.id, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    const started = Date.now();
    try {
      const prepared = definition.riskLevel > 0 ? await input.gateway.prepare(input.companyId, definition.id, args) : null;
      const executed = await input.gateway.execute(input.companyId, definition.id, prepared?.arguments ?? args, { preconditions: prepared?.preconditions, sessionId: input.sessionId });
      results.push({ index, capabilityId: definition.id, status: "SUCCEEDED", result: executed.result, affectedRecords: resolvedAffectedRecords(prepared, executed.result) });
      await auditImmediateCapability(input.prisma, { companyId: input.companyId, actorUserId: input.actorUserId, sessionId: input.sessionId, permissionMode: input.permissionMode, definition, arguments: prepared?.arguments ?? args, status: "SUCCEEDED", durationMs: Date.now() - started, result: executed.result, intent });
    } catch (error) {
      results.push({ index, capabilityId: definition.id, status: "FAILED", error: error instanceof Error ? error.message : String(error) });
      await auditImmediateCapability(input.prisma, { companyId: input.companyId, actorUserId: input.actorUserId, sessionId: input.sessionId, permissionMode: input.permissionMode, definition, arguments: args, status: "FAILED", durationMs: Date.now() - started, error, intent });
    }
  }
  return { intent, proposals, results };
}

export async function runOllamaChat(model: LocalModel, payload: Record<string, any>) {
  const messages = normalizedChatMessages(payload);
  if (!messages.length) throw new Error("Le message est vide.");
  const context = payload.toolContext ? `\n\nContexte d'outils typés (JSON):\n${safeJson(payload.toolContext).slice(0, 30_000)}` : "";
  const product = payload.productKnowledge ? `\n\nConnaissance produit vérifiée:\n${String(payload.productKnowledge).slice(0, 20_000)}` : "";
  const capabilities = Array.isArray(payload.availableCapabilities) ? payload.availableCapabilities as WheatAiCapabilityDefinition[] : [];
  const response = await ollamaRequest("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      model: model.displayName,
      messages: [{ role: "system", content: `${WHEAT_AI_SYSTEM_PROMPT}${product}${context}` }, ...messages],
      tools: payload.mutationToolsAllowed === false
        ? capabilities.filter((item) => item.mode === "READ" || item.mode === "NAVIGATION").map(ollamaCapabilitySchema)
        : capabilities.map(ollamaCapabilitySchema),
      stream: false,
      options: { temperature: 0.2, num_predict: 512 },
    }),
  }, 300_000) as any;
  const text = stripModelReasoning(response?.message?.content);
  const proposedToolCalls = (Array.isArray(response?.message?.tool_calls) ? response.message.tool_calls : [])
    .slice(0, 25)
    .map((item: any) => item?.function)
    .filter((toolCall: any) => toolCall && typeof toolCall.name === "string" && toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments))
    .map((toolCall: any) => ({ capabilityId: capabilityIdFromModelName(toolCall.name), arguments: toolCall.arguments }));
  if ((!text || text === EMPTY_FINAL_RESPONSE) && !proposedToolCalls.length) throw new Error("Ollama a terminé sans fournir de réponse finale.");
  const proposedToolCall = proposedToolCalls[0] ? { toolName: proposedToolCalls[0].capabilityId, arguments: proposedToolCalls[0].arguments } : null;
  return { text: proposedToolCalls.length && (!text || text === EMPTY_FINAL_RESPONSE) ? "J'ai préparé les actions demandées. Wheat appliquera les règles de risque et de confirmation ci-dessous." : text, proposedToolCall, proposedToolCalls, metrics: { totalDurationNs: response?.total_duration, evalCount: response?.eval_count, evalDurationNs: response?.eval_duration } };
}

async function runLlamaCppChat(model: LocalModel, executable: string | null, payload: Record<string, any>) {
  if (!executable) throw new Error("Le moteur llama.cpp vérifié est requis pour ce modèle GGUF.");
  if (!model.filePath) throw new Error("Le fichier GGUF sélectionné est introuvable.");
  const messages = normalizedChatMessages(payload).map((item) => `${item.role === "assistant" ? "Assistant" : "Utilisateur"}: ${item.content}`).join("\n");
  if (!messages) throw new Error("Le message est vide.");
  const context = payload.toolContext ? `\nContexte d'outils typés (JSON):\n${safeJson(payload.toolContext).slice(0, 30_000)}` : "";
  const product = payload.productKnowledge ? `\n\nConnaissance produit vérifiée:\n${String(payload.productKnowledge).slice(0, 20_000)}` : "";
  const availableCapabilities = Array.isArray(payload.availableCapabilities) ? payload.availableCapabilities as WheatAiCapabilityDefinition[] : [];
  const mutationTools = payload.mutationToolsAllowed === false ? "Aucun : Wheat AI est en lecture seule." : safeJson(availableCapabilities.map((tool) => ({ name: tool.id, riskLevel: tool.riskLevel, description: tool.description, inputSchema: tool.inputSchema })));
  const actionFormat = "Pour appeler une capacité, termine par ACTION_PROPOSAL: {\"toolName\":\"identifiant.capacite\",\"arguments\":{...},\"visibleText\":\"résumé utilisateur\"}. N'émets ce bloc que pour une exécution explicitement demandée; une question ou prévisualisation reste sans action exécutée.";
  const prompt = `${WHEAT_AI_SYSTEM_PROMPT}${product}${context}\nCapacités pertinentes: ${mutationTools}\n${actionFormat}\n\n${messages}\nAssistant:`;
  const { stdout } = await execFileAsync(executable, ["-m", model.filePath, "-p", prompt, "-n", "512", "-c", "4096", "--temp", "0.2", "--no-display-prompt", "--single-turn"], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const text = stripModelReasoning(stdout);
  const action = actionFromText(text);
  const proposedToolCall = action ? { toolName: canonicalWheatAiCapabilityId(action.toolName), arguments: action.arguments } : null;
  return { text: action?.visibleText || (action ? "Je peux préparer cette action. Vérifiez-la puis confirmez-la dans Wheat." : text), proposedToolCall, proposedToolCalls: proposedToolCall ? [{ capabilityId: proposedToolCall.toolName, arguments: proposedToolCall.arguments }] : [], metrics: {} };
}

async function runModelHealthCheck(root: string, manifest: ModelManifest, modelId: string) {
  const discovered = await discoverLocalModels(root, manifest);
  const model = discovered.models.find((item) => item.id === modelId && item.installed);
  if (!model) throw new Error("Sélectionnez un modèle local disponible avant de lancer le test.");
  const started = Date.now();
  if (model.provider === "OLLAMA") {
    const result = await runOllamaChat(model, { messages: [{ role: "user", content: "Réponds uniquement par OK." }] });
    return { kind: "MODEL_INFERENCE", provider: model.provider, modelId: model.id, durationMs: Date.now() - started, response: result.text.slice(0, 120), ...result.metrics, measuredAt: new Date().toISOString() };
  }
  if (!model.filePath || !discovered.runtimeExecutable) throw new Error("Le moteur llama.cpp vérifié est requis pour tester ce modèle GGUF.");
  const health = await verifyInstalledModel(discovered.runtimeExecutable, model.filePath);
  return { kind: "MODEL_INFERENCE", provider: model.provider, modelId: model.id, durationMs: Date.now() - started, response: stripModelReasoning(health.inferenceSample).slice(0, 120), runtimeVersion: health.runtimeVersion, measuredAt: new Date().toISOString() };
}

async function runLocalChat(root: string, manifest: ModelManifest, prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null, appVersion = WHEAT_APP_VERSION) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const settings = await getSettings(prisma, companyId);
  const selectedModelId = String(payload.modelId ?? settings?.selectedModelId ?? "");
  if (!settings?.enabled || !selectedModelId) throw new Error("Sélectionnez un modèle local pour activer Wheat AI sur ce dossier.");
  const discovered = await discoverLocalModels(root, manifest);
  const model = discovered.models.find((item) => item.id === selectedModelId && item.installed);
  if (!model) throw new Error("Le modèle sélectionné n'est plus disponible pour ce dossier.");
  if (!model.chatReady) throw new Error("Le moteur nécessaire à ce modèle n'est pas disponible.");
  const isRemoteModel = selectedModelId === AUTOMATIC_FREE_MODEL_ID || selectedModelId.startsWith(REMOTE_MODEL_PREFIX);
  const routed = await buildWheatAiChatContext(prisma, companyId, payload, appVersion);
  const prompt = lastUserMessage(payload);
  const availableCapabilities = selectWheatAiCapabilities(prompt, payload.applicationContext?.module ?? payload.activeModule);
  const enrichedPayload = {
    ...payload,
    productKnowledge: routed.productKnowledge,
    toolContext: {
      dossier: routed.dossier,
      routedResults: routed.routedResults,
      applicationContext: {
        module: String(payload.applicationContext?.module ?? payload.activeModule ?? "atlas-ai").slice(0, 80),
        selectedEntity: boundedReference(payload.applicationContext?.selectedEntity),
      },
      recentActions: boundedRecentActionContext(payload),
    },
    mutationToolsAllowed: settings.permissionMode !== "READ_ONLY",
    availableCapabilities,
  };
  const started = Date.now(); let status = "SUCCEEDED"; let resultSummary: Record<string, unknown> = {};
  try {
    const result = isRemoteModel
      ? await runRemoteChat(model, enrichedPayload)
      : model.provider === "OLLAMA"
        ? await runOllamaChat(model, enrichedPayload)
        : await runLlamaCppChat(model, discovered.runtimeExecutable, enrichedPayload);
    const embeddedAction = actionFromText(result.text);
    const candidates = Array.isArray(result.proposedToolCalls) && result.proposedToolCalls.length
      ? result.proposedToolCalls
      : result.proposedToolCall
        ? [{ capabilityId: result.proposedToolCall.toolName, arguments: result.proposedToolCall.arguments }]
        : embeddedAction
          ? [{ capabilityId: embeddedAction.toolName, arguments: embeddedAction.arguments }]
          : [];
    const sessionId = String(payload.sessionId ?? randomUUID()).slice(0, 120);
    const processed = candidates.length ? await processWheatAiCapabilityCalls({ prisma, gateway, companyId, actorUserId, sessionId, permissionMode: settings.permissionMode, prompt, dryRun: payload.dryRun === true, calls: candidates }) : { intent: classifyWheatAiIntent(prompt, payload.dryRun === true), proposals: [], results: [] };
    const actionProposal = processed.proposals[0] ?? null;
    const succeeded = processed.results.filter((item: any) => item.status === "SUCCEEDED").length;
    const failed = processed.results.filter((item: any) => ["FAILED", "REJECTED", "NOT_AUTHORIZED_BY_INTENT"].includes(item.status)).length;
    const pending = processed.results.filter((item: any) => item.status === "PENDING_CONFIRMATION").length;
    const dryRuns = processed.results.filter((item: any) => item.status === "DRY_RUN").length;
    const executionSummary = processed.results.length
      ? `\n\nPlan Wheat AI : ${succeeded} exécutée(s), ${pending} en attente de confirmation, ${dryRuns} prévisualisée(s), ${failed} en échec ou refusée(s).`
      : "";
    const baseText = embeddedAction?.visibleText || result.text;
    const text = `${baseText && baseText !== EMPTY_FINAL_RESPONSE ? baseText : "Action analysée."}${executionSummary}`;
    resultSummary = { provider: model.provider, modelId: model.id, responseCharacters: text.length, toolsUsed: routed.toolsUsed, availableCapabilityCount: availableCapabilities.length, intent: processed.intent, actionProposed: actionProposal?.toolName ?? null, actionCount: processed.results.length, succeeded, pending, dryRuns, failed };
    return { text, local: true, provider: model.provider, modelId: model.id, toolBoundary: "TYPED_TOOLS_ONLY", capabilityBoundary: "TYPED_CAPABILITY_REGISTRY", contextSources: routed.contextSources, toolsUsed: routed.toolsUsed, availableCapabilities: availableCapabilities.map((item) => item.id), productKnowledgeVersion: WHEAT_PRODUCT_KNOWLEDGE_VERSION, intent: processed.intent, actionProposal, actionProposals: processed.proposals, actionResults: processed.results };
  } catch (error) {
    status = "FAILED";
    throw new Error(
      `${isRemoteModel ? "Le fournisseur Wheat AI" : "Le modèle local"} n'a pas répondu : ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await prisma.atlasAiAuditEvent.create({ data: { companyId, actorUserId: actorUserId ?? null, sessionId: String(payload.sessionId ?? randomUUID()).slice(0, 120), toolName: "wheat_ai_chat", permissionMode: settings.permissionMode, requestJson: safeJson({ messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0, productKnowledgeVersion: WHEAT_PRODUCT_KNOWLEDGE_VERSION, provider: model.provider, modelId: model.id }), resultSummaryJson: safeJson(resultSummary), status, durationMs: Date.now() - started } }).catch(() => undefined);
  }
}

async function confirmWheatAiAction(prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const proposalId = requireId(payload.proposalId, "La proposition");
  if (payload.confirmed !== true) throw new Error("L'action Wheat AI exige une confirmation explicite.");
  const proposal = await prisma.atlasAiAuditEvent.findFirst({ where: { id: proposalId, companyId, status: "PENDING_CONFIRMATION" } });
  if (!proposal) throw new Error("Cette proposition n'est plus disponible ou a déjà été traitée.");
  const args = JSON.parse(proposal.requestJson || "{}");
  const confirmation = JSON.parse(proposal.confirmationJson || "{}");
  try {
    const capability = proposal.toolName.includes(".") ? getWheatAiCapability(proposal.toolName) : null;
    const executed = capability
      ? await gateway.execute(companyId, capability.id, args, { preconditions: confirmation.preconditions ?? {}, sessionId: proposal.sessionId })
      : (await assertProposalFresh(prisma, companyId, confirmation.preconditions ?? {}), await executeTypedTool(prisma, { companyId, sessionId: proposal.sessionId, toolName: proposal.toolName, arguments: args, confirmed: true }, actorUserId));
    await prisma.atlasAiAuditEvent.update({ where: { id: proposal.id }, data: { status: "CONFIRMED_EXECUTED", confirmationJson: safeJson({ ...confirmation, required: true, confirmed: true, confirmedAt: new Date(), actorUserId: actorUserId ?? null }), resultSummaryJson: safeJson({ executedTool: proposal.toolName, resultKind: Array.isArray(executed.result) ? "ARRAY" : "OBJECT" }) } });
    return { ...executed, proposalId, confirmed: true, actionStatus: "EXECUTED", affectedRecords: capability ? resolvedAffectedRecords({ preview: confirmation.preview ?? { affectedRecords: [] } }, executed.result) : [], text: `${capability ? capability.description : proposalLabel(proposal.toolName, args)} : action exécutée et auditée.` };
  } catch (error) {
    await prisma.atlasAiAuditEvent.update({ where: { id: proposal.id }, data: { status: "CONFIRMATION_FAILED", confirmationJson: safeJson({ ...confirmation, required: true, confirmed: true, failedAt: new Date(), actorUserId: actorUserId ?? null }), resultSummaryJson: safeJson({ error: error instanceof Error ? error.message : String(error) }) } }).catch(() => undefined);
    throw error;
  }
}

async function cancelWheatAiAction(prisma: PrismaLike, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const proposalId = requireId(payload.proposalId, "La proposition");
  const proposal = await prisma.atlasAiAuditEvent.findFirst({ where: { id: proposalId, companyId, status: "PENDING_CONFIRMATION" } });
  if (!proposal) throw new Error("Cette proposition n'est plus disponible ou a déjà été traitée.");
  const confirmation = JSON.parse(proposal.confirmationJson || "{}");
  const result = await prisma.atlasAiAuditEvent.updateMany({ where: { id: proposalId, companyId, status: "PENDING_CONFIRMATION" }, data: { status: "CANCELLED", confirmationJson: safeJson({ ...confirmation, required: true, confirmed: false, cancelledAt: new Date(), actorUserId: actorUserId ?? null }) } });
  if (result.count !== 1) throw new Error("Cette proposition n'est plus disponible ou a déjà été traitée.");
  return { proposalId, cancelled: true };
}

export async function executeRegisteredCapability(prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  const capabilityId = canonicalWheatAiCapabilityId(payload.capabilityId ?? payload.toolName);
  const definition = getWheatAiCapability(capabilityId);
  if (!definition) throw new Error("Cette capacité Wheat AI n'est pas enregistrée.");
  const settings = await getSettings(prisma, companyId);
  const permissionMode = String(settings?.permissionMode ?? "ASSISTANT") as PermissionMode;
  if (definition.riskLevel > 0 && permissionMode === "READ_ONLY") throw new Error("Wheat AI est en lecture seule.");
  const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments) ? payload.arguments as Record<string, any> : {};
  const prepared = definition.riskLevel > 0 ? await gateway.prepare(companyId, definition.id, args) : null;
  if (payload.dryRun === true) return { capabilityId: definition.id, dryRun: true, executed: false, preview: prepared?.preview ?? null, riskLevel: definition.riskLevel };
  if (capabilityRequiresConfirmation(definition, permissionMode) && payload.confirmed !== true) throw new Error(`La capacité ${definition.id} exige une confirmation explicite immédiatement avant l'exécution.`);
  const sessionId = String(payload.sessionId ?? randomUUID()).slice(0, 120);
  const started = Date.now();
  try {
    const executed = await gateway.execute(companyId, definition.id, prepared?.arguments ?? args, { preconditions: prepared?.preconditions, sessionId });
    await auditImmediateCapability(prisma, { companyId, actorUserId, sessionId, permissionMode, definition, arguments: prepared?.arguments ?? args, status: "SUCCEEDED", durationMs: Date.now() - started, result: executed.result, intent: "EXECUTION" });
    return { ...executed, executed: true, riskLevel: definition.riskLevel, affectedRecords: resolvedAffectedRecords(prepared, executed.result) };
  } catch (error) {
    await auditImmediateCapability(prisma, { companyId, actorUserId, sessionId, permissionMode, definition, arguments: prepared?.arguments ?? args, status: "FAILED", durationMs: Date.now() - started, error, intent: "EXECUTION" });
    throw error;
  }
}

export async function executeRegisteredPlan(prisma: PrismaLike, gateway: WheatAiDomainGateway, payloadValue: unknown, actorUserId?: string | null) {
  const payload = record(payloadValue);
  const companyId = requireId(payload.companyId, "La société");
  if (!Array.isArray(payload.calls) || payload.calls.length < 1 || payload.calls.length > 25) throw new Error("Un plan Wheat AI doit contenir entre 1 et 25 actions.");
  const settings = await getSettings(prisma, companyId);
  const permissionMode = String(settings?.permissionMode ?? "ASSISTANT") as PermissionMode;
  const prepared: any[] = [];
  for (const callValue of payload.calls) {
    const call = record(callValue);
    const definition = getWheatAiCapability(call.capabilityId ?? call.toolName);
    if (!definition) throw new Error("Le plan contient une capacité non enregistrée.");
    if (definition.riskLevel > 0 && permissionMode === "READ_ONLY") throw new Error("Wheat AI est en lecture seule.");
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? call.arguments : {};
    const item = definition.riskLevel > 0 ? await gateway.prepare(companyId, definition.id, args) : { definition, arguments: args, preview: null, preconditions: {} };
    prepared.push({ capabilityId: definition.id, arguments: item.arguments, preconditions: item.preconditions, preview: item.preview, requiresConfirmation: capabilityRequiresConfirmation(definition, permissionMode) });
  }
  if (payload.dryRun === true) return { dryRun: true, executed: false, actions: prepared };
  if (prepared.some((item) => item.requiresConfirmation) && payload.confirmed !== true) throw new Error("Ce plan contient une ou plusieurs actions exigeant une confirmation explicite.");
  const sessionId = String(payload.sessionId ?? randomUUID()).slice(0, 120);
  const result = await gateway.executePlan(companyId, prepared, { stopOnError: payload.stopOnError !== false, sessionId });
  await prisma.atlasAiAuditEvent.create({ data: { companyId, actorUserId: actorUserId ?? null, sessionId, toolName: "atlas_ai_plan", permissionMode, requestJson: safeJson(prepared.map((item) => ({ capabilityId: item.capabilityId, arguments: item.arguments }))).slice(0, 100_000), resultSummaryJson: safeJson({ origin: "ATLAS_AI", total: result.total, completed: result.completed, failed: result.failed, stoppedEarly: result.stoppedEarly }), confirmationJson: safeJson({ required: prepared.some((item) => item.requiresConfirmation), confirmed: payload.confirmed === true }), status: result.failed ? "PARTIAL_FAILURE" : "SUCCEEDED" } }).catch(() => undefined);
  return { dryRun: false, executed: true, ...result };
}

export function registerWheatAiIpc(options: { ipcMain: IpcLike; getPrisma: GetPrisma; getActorUserId?: () => string | null | Promise<string | null>; manifestPath: string; modelRoot: string; appVersion?: string; send: Send; serialize?: <T>(value: T) => T }) {
  const serialize = options.serialize ?? rendererSerialize;
  const gateway = createWheatAiDomainGateway({ getPrisma: options.getPrisma, getActorUserId: options.getActorUserId });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.status, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    await gateway.authorize(companyId, getWheatAiCapability("company.get")!);
    const manifest = await readModelManifest(options.manifestPath);
    const [profile, discovered, prisma] = await Promise.all([profileHardware(options.modelRoot), discoverLocalModels(options.modelRoot, manifest), options.getPrisma()]);
    return serialize({
      manifestVersion: manifest.manifestVersion,
      runtime: { ...manifest.runtime, installed: Boolean(discovered.runtimeExecutable) },
      models: discovered.models.map(publicModel),
      profile,
      recommendation: recommendModel(profile, manifest),
      settings: await getSettings(prisma, companyId),
      providers: {
        ollama: { available: discovered.ollama.available, error: discovered.ollama.error, modelCount: discovered.ollama.models.length },
        huggingFace: { cacheRoots: discovered.huggingFace.roots, compatibleGgufCount: discovered.huggingFace.models.length },
      },
      productKnowledgeVersion: WHEAT_PRODUCT_KNOWLEDGE_VERSION,
      confirmedMutationCapabilities: WHEAT_AI_MUTATION_CAPABILITIES,
      capabilityRegistry: {
        version: "ATLAS_CAPABILITIES_2_1_1",
        total: ATLAS_AI_CAPABILITY_REGISTRY.length,
        categories: [...new Set(ATLAS_AI_CAPABILITY_REGISTRY.map((item) => item.category))],
        byRiskLevel: Object.fromEntries([0, 1, 2, 3].map((riskLevel) => [riskLevel, ATLAS_AI_CAPABILITY_REGISTRY.filter((item) => item.riskLevel === riskLevel).length])),
        dryRunCount: ATLAS_AI_CAPABILITY_REGISTRY.filter((item) => item.supportsDryRun).length,
      },
      privacy: { localOnly: true, databaseAccess: false, toolBoundary: "TYPED_TOOLS_ONLY", capabilityBoundary: "TYPED_CAPABILITY_REGISTRY", rawSql: false, rawPrisma: false, shell: false, arbitraryFilesystem: false },
    });
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.benchmark, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    const prisma = await options.getPrisma();
    const settings = await getSettings(prisma, companyId);
    const modelId = String(payload.modelId ?? settings?.selectedModelId ?? "");
    const result = modelId
      ? await runModelHealthCheck(options.modelRoot, await readModelManifest(options.manifestPath), modelId)
      : await localBenchmark();
    await prisma.atlasAiSettings.upsert({ where: { companyId }, create: { companyId, benchmarkJson: safeJson(result) }, update: { benchmarkJson: safeJson(result), ...(modelId ? { lastHealthCheckAt: new Date() } : {}) } });
    return result;
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.install, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    if (payload.confirmed !== true) throw new Error("Le téléchargement du modèle exige une confirmation explicite.");
    const manifest = await readModelManifest(options.manifestPath);
    const model = manifest.models.find((item) => item.id === payload.modelId);
    if (!model) throw new Error("Ce modèle n'appartient pas au manifeste Wheat.");
    const profile = await profileHardware(options.modelRoot);
    if (profile.freeDiskBytes < model.bytes + manifest.runtime.bytes + 1024 ** 3) throw new Error("L'espace disque libre est insuffisant pour télécharger, vérifier et installer ce modèle.");
    const runtime = await installRuntime(manifest, options.modelRoot, options.send);
    const target = modelPath(options.modelRoot, model);
    const knownWorkingBefore = await validPinnedFile(target, model.bytes, model.sha256);
    await downloadPinned(model, target, options.send);
    let health;
    try {
      health = await verifyInstalledModel(runtime, target);
    } catch (error) {
      if (!knownWorkingBefore) {
        await fs.rename(target, `${target}.inference-failed-${randomUUID()}`).catch(() => undefined);
      }
      throw new Error(`Le modèle téléchargé a échoué au test d'inférence et n'a pas été activé : ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const prisma = await options.getPrisma();
    await prisma.atlasAiSettings.upsert({
      where: { companyId },
      create: { companyId, enabled: true, selectedTier: model.tier, selectedModelId: model.id, modelManifestVersion: manifest.manifestVersion, runtimeVersion: manifest.runtime.version, hardwareProfileJson: safeJson(profile), lastHealthCheckAt: new Date() },
      update: { enabled: true, selectedTier: model.tier, selectedModelId: model.id, modelManifestVersion: manifest.manifestVersion, runtimeVersion: manifest.runtime.version, hardwareProfileJson: safeJson(profile), lastHealthCheckAt: new Date() },
    });
    options.send(WHEAT_AI_CHANNELS.progress, { artifactId: model.id, phase: "READY", receivedBytes: model.bytes, totalBytes: model.bytes });
    return { installed: true, modelId: model.id, path: target, runtimeHealth: health.runtimeVersion, testInference: health.inferenceSample };
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.uninstall, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    if (payload.confirmed !== true) throw new Error("La suppression du modèle exige une confirmation explicite.");
    const manifest = await readModelManifest(options.manifestPath);
    const discovered = await discoverLocalModels(options.modelRoot, manifest);
    const model = discovered.models.find((item) => item.id === payload.modelId && item.installed);
    if (!model) throw new Error("Le modèle local sélectionné n'est plus disponible.");
    let recoverable = false;
    if (model.provider === "OLLAMA") {
      await ollamaRequest("/api/delete", { method: "DELETE", body: JSON.stringify({ model: model.displayName }) }, 120_000);
    } else if (model.provider === "HUGGINGFACE") {
      throw new Error("Wheat ne supprime pas directement un dépôt Hugging Face partagé. Utilisez le gestionnaire de cache Hugging Face pour éviter de corrompre ses snapshots.");
    } else if (model.filePath) {
      if (payload.permanent === true) await fs.rm(model.filePath, { force: true });
      else {
        await fs.rename(model.filePath, `${model.filePath}.uninstalled-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        recoverable = true;
      }
    }
    const prisma = await options.getPrisma();
    await prisma.atlasAiSettings.updateMany({ where: { companyId, selectedModelId: model.id }, data: { enabled: false, selectedModelId: null, selectedTier: null } });
    if (model.provider === "ATLAS" && payload.permanent !== true) return { uninstalled: true, recoverable: true };
    return { uninstalled: true, recoverable, provider: model.provider, modelId: model.id };
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.select, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const companyId = requireId(payload.companyId, "La société");
    const modelId = String(payload.modelId ?? "").trim();
    const prisma = await options.getPrisma();
    if (!modelId) {
      return prisma.atlasAiSettings.upsert({ where: { companyId }, create: { companyId, enabled: false }, update: { enabled: false, selectedModelId: null, selectedTier: null } });
    }
    const manifest = await readModelManifest(options.manifestPath);
    const model = (await discoverLocalModels(options.modelRoot, manifest)).models.find((item) => item.id === modelId && item.installed);
    if (!model) throw new Error("Le modèle choisi n'est plus installé sur cet ordinateur.");
    if (!model.chatReady) throw new Error("Ce modèle GGUF a besoin du moteur llama.cpp local avant de pouvoir dialoguer.");
    return prisma.atlasAiSettings.upsert({
      where: { companyId },
      create: { companyId, enabled: true, selectedTier: model.tier ?? "EXTERNAL", selectedModelId: model.id, modelManifestVersion: model.provider === "ATLAS" ? manifest.manifestVersion : model.provider, runtimeVersion: model.provider === "OLLAMA" ? "OLLAMA_LOCAL_API" : manifest.runtime.version, lastHealthCheckAt: null },
      update: { enabled: true, selectedTier: model.tier ?? "EXTERNAL", selectedModelId: model.id, modelManifestVersion: model.provider === "ATLAS" ? manifest.manifestVersion : model.provider, runtimeVersion: model.provider === "OLLAMA" ? "OLLAMA_LOCAL_API" : manifest.runtime.version, lastHealthCheckAt: null },
    });
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.configure, async (_event, payloadValue) => { const payload = record(payloadValue); const companyId = requireId(payload.companyId, "La société"); const permissionMode = String(payload.permissionMode ?? "ASSISTANT") as PermissionMode; if (!["READ_ONLY", "ASSISTANT", "AUTOMATED"].includes(permissionMode)) throw new Error("Le mode de permission Wheat AI est invalide."); if (permissionMode === "AUTOMATED" && payload.confirmed !== true) throw new Error("Le mode automatisé exige une confirmation explicite."); const prisma = await options.getPrisma(); return prisma.atlasAiSettings.upsert({ where: { companyId }, create: { companyId, permissionMode }, update: { permissionMode } }); });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.tools, () => publicWheatAiCapabilities());
  options.ipcMain.handle(WHEAT_AI_CHANNELS.executeTool, async (_event, payloadValue) => {
    const payload = record(payloadValue);
    const requested = String(payload.capabilityId ?? payload.toolName ?? "");
    return requested.includes(".")
      ? serialize(await executeRegisteredCapability(await options.getPrisma(), gateway, payload, await options.getActorUserId?.()))
      : serialize(await executeTypedTool(await options.getPrisma(), payload, await options.getActorUserId?.()));
  });
  options.ipcMain.handle(WHEAT_AI_CHANNELS.executePlan, async (_event, payload) => serialize(await executeRegisteredPlan(await options.getPrisma(), gateway, payload, await options.getActorUserId?.())));
  options.ipcMain.handle(WHEAT_AI_CHANNELS.chat, async (_event, payload) => serialize(await runLocalChat(options.modelRoot, await readModelManifest(options.manifestPath), await options.getPrisma(), gateway, payload, await options.getActorUserId?.(), options.appVersion)));
  options.ipcMain.handle(WHEAT_AI_CHANNELS.confirmAction, async (_event, payload) => serialize(await confirmWheatAiAction(await options.getPrisma(), gateway, payload, await options.getActorUserId?.())));
  options.ipcMain.handle(WHEAT_AI_CHANNELS.cancelAction, async (_event, payload) => serialize(await cancelWheatAiAction(await options.getPrisma(), payload, await options.getActorUserId?.())));
  return WHEAT_AI_CHANNELS;
}

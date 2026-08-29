import type { ProviderId } from "./wheatAiSecrets";

/**
 * Wheat AI remote providers — OpenRouter and Groq.
 *
 * Design constraints, in order of importance:
 *
 *  1. **No silent paid usage.** A model is éligible only when the provider's
 *     own metadata proves it is free. For OpenRouter that means prompt AND
 *     completion pricing parse to exactly zero; unknown or unparseable pricing
 *     is rejected, never assumed free. Groq does not expose billing tier or
 *     zero-cost pricing in `/models`; the provider service therefore requires
 *     an explicit Free-plan attestation before these discovered models become
 *     eligible — Wheat never invents or hard-codes a model identifier.
 *  2. **No key leakage.** Keys are passed as arguments, used once to build an
 *     Authorization header, and never logged or copied into an error message.
 *     `redactSecrets()` scrubs anything provider-shaped out of error text.
 *  3. **Bounded failover.** Retryable conditions (rate limit, quota, model
 *     unavailable, timeout, transient 5xx) move to the next éligible model, at
 *     most `MAX_ATTEMPTS` times, never revisiting a model. Non-retryable
 *     conditions (bad key, revoked authorization, malformed request, safety
 *     refusal, user cancellation) stop immediately.
 *
 * Everything here runs in the main process. The renderer never sees a key,
 * a raw provider response, or an unredacted provider error.
 */

export type WheatAiChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };

export type FreeModel = {
  id: string;
  provider: ProviderId;
  label: string;
  /** Maximum prompt + completion tokens the model accepts. */
  contextTokens: number;
  supportsTools: boolean;
  /** Ranking score — higher is better. Explained by `rankingReason`. */
  score: number;
  rankingReason: string;
};

export type ModelDiscovery = {
  provider: ProviderId;
  models: FreeModel[];
  /** Models the provider listed that Wheat refused, with the reason. */
  rejected: Array<{ id: string; reason: string }>;
  fetchedAt: string;
};

export type ChatResult = {
  text: string;
  provider: ProviderId;
  modelId: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Models tried and rejected before this one succeeded. */
  failedOver: Array<{ provider: ProviderId; modelId: string; reason: string }>;
  usage?: { promptTokens?: number; completionTokens?: number };
};

export type FailureKind =
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "MODEL_UNAVAILABLE"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_KEY"
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "SAFETY_REFUSAL"
  | "CANCELLED"
  | "EMPTY_RESPONSE";

/** Only these move Wheat AI to the next éligible free model. */
const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "MODEL_UNAVAILABLE",
  "TIMEOUT",
  "PROVIDER_ERROR",
  "EMPTY_RESPONSE",
]);

export class WheatAiProviderError extends Error {
  readonly kind: FailureKind;
  readonly provider: ProviderId;
  readonly modelId?: string;
  readonly retryable: boolean;

  constructor(kind: FailureKind, provider: ProviderId, message: string, modelId?: string) {
    super(redactSecrets(message));
    this.name = "WheatAiProviderError";
    this.kind = kind;
    this.provider = provider;
    this.modelId = modelId;
    this.retryable = RETRYABLE.has(kind);
  }
}

/** Hard ceiling on failover hops, so a bad day never becomes an infinite loop. */
export const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 90_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const MODEL_CACHE_TTL_MS = 10 * 60_000;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  groq: "Groq",
};

const ENDPOINTS: Record<ProviderId, { models: string; chat: string }> = {
  openrouter: {
    models: "https://openrouter.ai/api/v1/models",
    chat: "https://openrouter.ai/api/v1/chat/completions",
  },
  groq: {
    models: "https://api.groq.com/openai/v1/models",
    chat: "https://api.groq.com/openai/v1/chat/completions",
  },
};

/**
 * Strips anything shaped like a provider credential out of text before it can
 * reach a log line, an IPC payload or an error message shown to the user.
 */
export function redactSecrets(value: string): string {
  return String(value ?? "")
    .replace(/sk-or-[A-Za-z0-9._-]{8,}/g, "sk-or-[clé masquée]")
    .replace(/gsk_[A-Za-z0-9._-]{8,}/g, "gsk_[clé masquée]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [clé masquée]");
}

/** True only when the provider's metadata proves the price is exactly zero. */
export function isZeroPrice(value: unknown): boolean {
  if (value === 0) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === 0;
}

type FetchLike = (url: string, init?: any) => Promise<any>;

async function requestJson(
  fetchImpl: FetchLike,
  provider: ProviderId,
  url: string,
  init: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  if (signal?.aborted) {
    throw new WheatAiProviderError("CANCELLED", provider, "La demande a été annulée.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw await httpFailure(provider, response);
    return await response.json();
  } catch (error) {
    if (error instanceof WheatAiProviderError) throw error;
    if (signal?.aborted) throw new WheatAiProviderError("CANCELLED", provider, "La demande a été annulée.");
    const name = (error as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new WheatAiProviderError("TIMEOUT", provider, `${PROVIDER_LABELS[provider]} n'a pas répondu dans le délai imparti.`);
    }
    throw new WheatAiProviderError(
      "PROVIDER_ERROR",
      provider,
      `${PROVIDER_LABELS[provider]} est injoignable : ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function httpFailure(provider: ProviderId, response: any): Promise<WheatAiProviderError> {
  let detail: string;
  try {
    detail = String(await response.text()).slice(0, 400);
  } catch {
    detail = "";
  }
  const label = PROVIDER_LABELS[provider];
  const status = Number(response.status);

  if (status === 401) {
    return new WheatAiProviderError("INVALID_KEY", provider, `${label} a refusé la clé d'API. Vérifiez-la ou remplacez-la dans Réglages.`);
  }
  if (status === 403) {
    return new WheatAiProviderError("UNAUTHORIZED", provider, `${label} a refusé l'acces a cette ressource avec cette clé.`);
  }
  if (status === 429) {
    return new WheatAiProviderError("RATE_LIMITED", provider, `${label} limite temporairement le nombre de requetes.`);
  }
  if (status === 402) {
    return new WheatAiProviderError("QUOTA_EXHAUSTED", provider, `Le quota gratuit ${label} est épuisé pour ce modèle.`);
  }
  if (status === 404) {
    return new WheatAiProviderError("MODEL_UNAVAILABLE", provider, `${label} ne propose plus ce modèle.`);
  }
  if (status === 400 || status === 422) {
    return new WheatAiProviderError("BAD_REQUEST", provider, `${label} a rejeté la requête : ${detail || "requête invalide"}.`);
  }
  if (status >= 500) {
    return new WheatAiProviderError("PROVIDER_ERROR", provider, `${label} rencontre une panne temporaire (HTTP ${status}).`);
  }
  return new WheatAiProviderError("PROVIDER_ERROR", provider, `${label} a répondu HTTP ${status}. ${detail}`);
}

function authHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (provider === "openrouter") {
    // OpenRouter asks callers to identify themselves; both values are public.
    headers["HTTP-Referer"] = "https://wheat.local/";
    headers["X-Title"] = "Wheat";
  }
  return headers;
}

/* ------------------------------------------------------------------ ranking */

/**
 * Scores an éligible free model for Wheat AI's accounting workload.
 *
 * Weighted, in order:
 *   - tool calling (Wheat AI drives typed capabilities — a model without it
 *     can answer but cannot prepare an action);
 *   - context capacity (dossier context and workpaper extracts are long);
 *   - a small bonus for instruction-tuned families known to follow a strict
 *     JSON tool schema reliably;
 *   - a penalty for preview/experimental tags, which are withdrawn without
 *     notice and therefore fail over more often.
 */
export function scoreModel(input: { id: string; contextTokens: number; supportsTools: boolean }): { score: number; reason: string } {
  const id = input.id.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (input.supportsTools) {
    score += 500;
    reasons.push("compatible avec les actions Wheat AI");
  } else {
    reasons.push("réponses uniquement, sans action");
  }

  const contextScore = Math.min(300, Math.round(input.contextTokens / 512));
  score += contextScore;
  if (input.contextTokens >= 100_000) reasons.push("très grande fenêtre de contexte");
  else if (input.contextTokens >= 32_000) reasons.push("grande fenêtre de contexte");
  else if (input.contextTokens > 0) reasons.push("fenêtre de contexte limitée");

  if (/(instruct|-it\b|chat)/.test(id)) {
    score += 60;
    reasons.push("modèle instruit");
  }
  if (/(llama|qwen|mistral|gemma|deepseek|phi)/.test(id)) {
    score += 40;
    reasons.push("famille éprouvée sur des taches structurees");
  }
  if (/(preview|experimental|alpha|beta|-exp)/.test(id)) {
    score -= 120;
    reasons.push("version expérimentale, disponibilité incertaine");
  }
  if (/(vision|image|audio|whisper|tts|embed|guard|rerank)/.test(id)) {
    // A specialised model must never outrank a plain chat model, whatever its
    // context size or tool support: Wheat AI is a conversational workload.
    score -= 1200;
    reasons.push("modèle spécialisé non conversationnel");
  }

  return { score, reason: reasons.join(" · ") };
}

/* --------------------------------------------------------------- discovery */

/**
 * OpenRouter: a model is free only when the official metadata reports a prompt
 * price AND a completion price that both parse to exactly zero. Anything with
 * missing, non-numeric or non-zero pricing is rejected with a stated reason —
 * never assumed free.
 */
export function selectOpenRouterFreeModels(payload: any): { models: FreeModel[]; rejected: Array<{ id: string; reason: string }> } {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models: FreeModel[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id) continue;

    const pricing = row?.pricing;
    if (!pricing || typeof pricing !== "object") {
      rejected.push({ id, reason: "tarification absente des métadonnées" });
      continue;
    }
    if (!("prompt" in pricing) || !("completion" in pricing)) {
      rejected.push({ id, reason: "tarification incomplète" });
      continue;
    }
    if (!isZeroPrice(pricing.prompt) || !isZeroPrice(pricing.completion)) {
      rejected.push({ id, reason: "modèle payant" });
      continue;
    }
    // Some listings price the request itself separately; a non-zero value there
    // is still a chargé, so it disqualifies the model.
    for (const extra of ["request", "image", "web_search", "internal_reasoning"]) {
      if (extra in pricing && !isZeroPrice((pricing as any)[extra])) {
        rejected.push({ id, reason: `frais additionnel (${extra})` });
      }
    }
    if (rejected.some((entry) => entry.id === id)) continue;

    const contextTokens = Number(row?.context_length ?? row?.top_provider?.context_length ?? 0);
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
      rejected.push({ id, reason: "fenêtre de contexte inconnue" });
      continue;
    }

    const parameters: string[] = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];
    const supportsTools = parameters.includes("tools") || parameters.includes("tool_choice");
    const { score, reason } = scoreModel({ id, contextTokens, supportsTools });
    models.push({
      id,
      provider: "openrouter",
      label: typeof row?.name === "string" && row.name.trim() ? row.name.trim() : id,
      contextTokens,
      supportsTools,
      score,
      rankingReason: reason,
    });
  }

  models.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { models, rejected };
}

/**
 * Groq's `/models` listing proves availability, but not the account's billing
 * tier. This selector therefore only performs availability/capability checks;
 * the provider service must gate its result behind explicit Free-plan consent
 * before exposing any entry as an eligible model.
 */
export function selectGroqFreeModels(payload: any): { models: FreeModel[]; rejected: Array<{ id: string; reason: string }> } {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models: FreeModel[] = [];
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    if (row?.active === false) {
      rejected.push({ id, reason: "modèle désactivé par le fournisseur" });
      continue;
    }
    if (/(whisper|tts|guard|embed|rerank|vision)/i.test(id)) {
      rejected.push({ id, reason: "modèle spécialisé non conversationnel" });
      continue;
    }
    const contextTokens = Number(row?.context_window ?? 0);
    if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
      rejected.push({ id, reason: "fenêtre de contexte inconnue" });
      continue;
    }
    // Groq exposes tool calling on its instruction-tuned chat models.
    const supportsTools = !/(guard|whisper|tts)/i.test(id);
    const { score, reason } = scoreModel({ id, contextTokens, supportsTools });
    models.push({
      id,
      provider: "groq",
      label: id,
      contextTokens,
      supportsTools,
      score,
      rankingReason: reason,
    });
  }

  models.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { models, rejected };
}

/* ----------------------------------------------------------------- adapter */

export type ProviderAdapter = {
  id: ProviderId;
  label: string;
  listFreeModels(apiKey: string, signal?: AbortSignal): Promise<ModelDiscovery>;
  chat(input: {
    apiKey: string;
    modelId: string;
    messages: WheatAiChatMessage[];
    tools?: Array<Record<string, unknown>>;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<ChatResult>;
};

function parseChatResponse(provider: ProviderId, modelId: string, payload: any): ChatResult {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const finishReason = String(choice?.finish_reason ?? "");
  if (finishReason === "content_filter") {
    throw new WheatAiProviderError("SAFETY_REFUSAL", provider, "Le fournisseur a refusé de répondre a cette demande.", modelId);
  }

  const message = choice?.message ?? {};
  const text = typeof message.content === "string" ? message.content.trim() : "";
  const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawToolCalls
    .slice(0, 25)
    .map((call: any) => {
      const name = typeof call?.function?.name === "string" ? call.function.name : "";
      if (!name) return null;
      let args: Record<string, unknown> = {};
      const raw = call?.function?.arguments;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          return null;
        }
      } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        args = raw as Record<string, unknown>;
      }
      return { name, arguments: args };
    })
    .filter(Boolean) as ChatResult["toolCalls"];

  if (!text && !toolCalls.length) {
    throw new WheatAiProviderError("EMPTY_RESPONSE", provider, `${PROVIDER_LABELS[provider]} n'a fourni aucune réponse exploitable.`, modelId);
  }

  return {
    text,
    provider,
    modelId,
    toolCalls,
    failedOver: [],
    usage: {
      promptTokens: Number(payload?.usage?.prompt_tokens) || undefined,
      completionTokens: Number(payload?.usage?.completion_tokens) || undefined,
    },
  };
}

export function createProviderAdapter(provider: ProviderId, fetchImpl: FetchLike): ProviderAdapter {
  return {
    id: provider,
    label: PROVIDER_LABELS[provider],

    async listFreeModels(apiKey, signal) {
      const payload = await requestJson(
        fetchImpl,
        provider,
        ENDPOINTS[provider].models,
        { method: "GET", headers: authHeaders(provider, apiKey) },
        DISCOVERY_TIMEOUT_MS,
        signal,
      );
      const sélection = provider === "openrouter" ? selectOpenRouterFreeModels(payload) : selectGroqFreeModels(payload);
      return { provider, models: sélection.models, rejected: sélection.rejected, fetchedAt: new Date().toISOString() };
    },

    async chat(input) {
      const body: Record<string, unknown> = {
        model: input.modelId,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 1024,
        stream: false,
      };
      if (input.tools?.length) {
        body.tools = input.tools;
        body.tool_choice = "auto";
      }
      const payload = await requestJson(
        fetchImpl,
        provider,
        ENDPOINTS[provider].chat,
        { method: "POST", headers: authHeaders(provider, apiKey_(input.apiKey)), body: JSON.stringify(body) },
        REQUEST_TIMEOUT_MS,
        input.signal,
      );
      return parseChatResponse(provider, input.modelId, payload);
    },
  };
}

/** Identity pass-through that documents where the only key use happens. */
function apiKey_(value: string): string {
  return value;
}

/* ----------------------------------------------------------------- failover */

export type ProviderRuntime = {
  /** Returns the decrypted key, or null when the provider is not configured. */
  getKey(provider: ProviderId): string | null;
  adapter(provider: ProviderId): ProviderAdapter;
};

/**
 * Builds the ordered candidate list for `Automatic — Free models`.
 *
 * Ranking is provider-agnostic: models from both providers are merged and
 * sorted by score, so the best free model wins regardless of who serves it.
 * Cross-provider fallback only happens when both keys are configured; with a
 * single key the list stays inside that provider.
 */
export function buildCandidateList(
  discoveries: ModelDiscovery[],
  options: { preferredProvider?: ProviderId | "auto"; pinnedProvider?: ProviderId | null; pinnedModelId?: string | null; limit?: number } = {},
): FreeModel[] {
  const limit = options.limit ?? MAX_ATTEMPTS;
  let pool = discoveries.flatMap((discovery) => discovery.models);

  if (options.preferredProvider && options.preferredProvider !== "auto") {
    const preferred = pool.filter((model) => model.provider === options.preferredProvider);
    const others = pool.filter((model) => model.provider !== options.preferredProvider);
    pool = [...preferred, ...others];
  } else {
    pool = [...pool].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  if (options.pinnedModelId) {
    const pinned = pool.find((model) =>
      model.id === options.pinnedModelId && (!options.pinnedProvider || model.provider === options.pinnedProvider),
    );
    if (pinned) pool = [pinned, ...pool.filter((model) => model !== pinned)];
  }

  // De-duplicate on provider+id so a model never gets a second attempt.
  const seen = new Set<string>();
  const ordered: FreeModel[] = [];
  for (const model of pool) {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(model);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

/**
 * Runs one chat request with bounded failover across the candidate list.
 *
 * A candidate is abandoned only for a retryable failure. The first
 * non-retryable failure (invalid key, revoked authorization, malformed
 * request, safety refusal, cancellation) aborts the whole run so Wheat never
 * masks a configuration problem behind a silent model switch.
 */
export async function chatWithFailover(
  runtime: ProviderRuntime,
  candidates: FreeModel[],
  request: { messages: WheatAiChatMessage[]; tools?: Array<Record<string, unknown>>; temperature?: number; maxTokens?: number; signal?: AbortSignal },
): Promise<ChatResult> {
  const eligibleCandidates = request.tools?.length
    ? candidates.filter((candidate) => candidate.supportsTools)
    : candidates;
  if (!eligibleCandidates.length) {
    const capability = request.tools?.length ? " compatible avec les actions demandées" : "";
    throw new Error(`Aucun modèle gratuit éligible${capability} n'est disponible. Ouvrez Réglages > Wheat AI pour vérifier le fournisseur et la clé d'API.`);
  }

  const failedOver: ChatResult["failedOver"] = [];
  let lastError: WheatAiProviderError | null = null;

  for (const candidate of eligibleCandidates.slice(0, MAX_ATTEMPTS)) {
    const apiKey = runtime.getKey(candidate.provider);
    if (!apiKey) {
      failedOver.push({ provider: candidate.provider, modelId: candidate.id, reason: "aucune clé configuree pour ce fournisseur" });
      continue;
    }
    try {
      const result = await runtime.adapter(candidate.provider).chat({
        apiKey,
        modelId: candidate.id,
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });
      return { ...result, failedOver };
    } catch (error) {
      const failure = error instanceof WheatAiProviderError
        ? error
        : new WheatAiProviderError("PROVIDER_ERROR", candidate.provider, error instanceof Error ? error.message : String(error), candidate.id);
      lastError = failure;
      if (!failure.retryable) throw failure;
      failedOver.push({ provider: candidate.provider, modelId: candidate.id, reason: failure.message });
    }
  }

  const attempted = failedOver.map((entry) => `${PROVIDER_LABELS[entry.provider]}/${entry.modelId}`).join(", ");
  throw new WheatAiProviderError(
    lastError?.kind ?? "PROVIDER_ERROR",
    lastError?.provider ?? eligibleCandidates[0].provider,
    `Aucun modèle gratuit n'a pu répondre après ${failedOver.length} tentative(s) (${attempted}). ${lastError?.message ?? ""}`.trim(),
  );
}

/* -------------------------------------------------------- discovery cache */

/** Short-lived cache so a burst of questions does not re-list models each time. */
export class ModelDiscoveryCache {
  private readonly entries = new Map<ProviderId, { discovery: ModelDiscovery; expiresAt: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = MODEL_CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(provider: ProviderId): ModelDiscovery | null {
    const entry = this.entries.get(provider);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(provider);
      return null;
    }
    return entry.discovery;
  }

  set(provider: ProviderId, discovery: ModelDiscovery): void {
    this.entries.set(provider, { discovery, expiresAt: Date.now() + this.ttlMs });
  }

  clear(provider?: ProviderId): void {
    if (provider) this.entries.delete(provider);
    else this.entries.clear();
  }
}

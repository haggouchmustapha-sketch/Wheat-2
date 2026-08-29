export type NormalizedFlexibleDate = {
  iso: string;
  date: Date;
  raw: string;
  inferred: boolean;
  precision: "DAY";
};

export type FlexibleDateContext = {
  year?: number | null;
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
};

function fourDigitYear(value: string) {
  const year = Number(value);
  if (value.length === 4) return year;
  return year <= 69 ? 2000 + year : 1900 + year;
}

function contextYear(context: FlexibleDateContext) {
  if (Number.isInteger(context.year) && Number(context.year) >= 1900 && Number(context.year) <= 2200) return Number(context.year);
  const candidates = [context.periodStart, context.periodEnd]
    .filter(Boolean)
    .map((value) => value instanceof Date ? value : new Date(String(value)))
    .filter((date) => !Number.isNaN(date.getTime()))
    .map((date) => date.getUTCFullYear());
  return candidates.length && candidates.every((year) => year === candidates[0]) ? candidates[0] : null;
}

function validDate(year: number, month: number, day: number, raw: string, inferred: boolean): NormalizedFlexibleDate {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`La date « ${raw} » est invalide.`);
  }
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error(`La date « ${raw} » n'existe pas dans le calendrier.`);
  return { iso, date, raw, inferred, precision: "DAY" };
}

/** Normalizes common Moroccan accounting dates without discarding the source value. */
export function normalizeFlexibleDate(value: unknown, context: FlexibleDateContext = {}): NormalizedFlexibleDate {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("La date importée doit être du texte.");
  const raw = String(value).trim();
  if (!raw) throw new Error("La date importée est vide.");
  let match: RegExpExecArray | null;

  match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]), raw, false);

  match = /^(\d{1,2})[/.\-\s](\d{1,2})[/.\-\s](\d{2}|\d{4})$/.exec(raw.replace(/\s+/g, " "));
  if (match) return validDate(fourDigitYear(match[3]), Number(match[2]), Number(match[1]), raw, false);

  match = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (match) return validDate(fourDigitYear(match[3]), Number(match[2]), Number(match[1]), raw, false);

  match = /^(\d{8})$/.exec(raw);
  if (match) {
    const leadingYear = Number(raw.slice(0, 4));
    const trailingYear = Number(raw.slice(4, 8));
    if (leadingYear >= 1900 && leadingYear <= 2200) {
      return validDate(leadingYear, Number(raw.slice(4, 6)), Number(raw.slice(6, 8)), raw, false);
    }
    if (trailingYear >= 1900 && trailingYear <= 2200) {
      return validDate(trailingYear, Number(raw.slice(2, 4)), Number(raw.slice(0, 2)), raw, false);
    }
    throw new Error(`La date « ${raw} » ne contient pas une année plausible.`);
  }

  match = /^(\d{1,2})[/.\-\s](\d{1,2})$/.exec(raw.replace(/\s+/g, " "));
  if (match) {
    const year = contextYear(context);
    if (!year) throw new Error(`La date « ${raw} » ne contient pas d'année et aucun contexte de relevé fiable ne permet de l'inférer.`);
    return validDate(year, Number(match[2]), Number(match[1]), raw, true);
  }

  throw new Error(`Le format de date « ${raw} » n'est pas reconnu. Formats acceptés : 290526, 29/05/26, 29/05/2026, 29-05-2026, 29.05.2026 ou 2026-05-29.`);
}

export function inferUniqueYear(values: unknown[]) {
  const years = new Set<number>();
  for (const value of values) {
    try {
      const normalized = normalizeFlexibleDate(value);
      years.add(normalized.date.getUTCFullYear());
    } catch {
      // Missing-year and malformed values are deliberately ignored here.
    }
  }
  return years.size === 1 ? [...years][0] : null;
}

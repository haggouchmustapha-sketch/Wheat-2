import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Banknote, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Cpu, Download, FileSpreadsheet, Landmark, Lock, Plus, RefreshCw, Scale, Search, Send, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { confirmWithAppFocus } from "../lib/confirmWithAppFocus";
import { Badge, Button, Callout, Card, EmptyState, Explainer, Field, HelpDisclosure, LoadingState, TabPanel, Tabs } from "./ui";
import { WheatAiMark } from "./ui/brand";
import { WheatSelect, type WheatSelectOption } from "./ui/WheatSelect";
import "./FiscalWorkspace.css";
import "./WheatAiWorkspace.css";
import "./FiscalWorkspaceTables.css";

type Tone = "success" | "warning" | "error" | "info";
type Loose = Record<string, any>;

export interface FiscalWorkspaceProps {
  company: Loose;
  documents?: Loose[];
  currency?: string;
  initialTab?: Tab;
  onChanged?: () => void | Promise<void>;
  onNotify?: (message: string, tone: Tone) => void;
}

type Tab = "pcge" | "balance" | "bilan" | "bank" | "fiscal";

const tabs: Array<{ id: Tab; label: string; note: string; help: string; icon: typeof BookOpen }> = [
  { id: "pcge", label: "Plan comptable", note: "Les comptes officiels PCGE", help: "La liste normalisee des comptes marocains (classes 0 a 9) utilisables pour ce dossier.", icon: BookOpen },
  { id: "balance", label: "Balances", note: "14 vues de contrôle", help: "Pour chaque compte, le total debit, le total credit et le solde à la date choisie.", icon: FileSpreadsheet },
  { id: "bilan", label: "Bilan & CPC", note: "Patrimoine et résultat", help: "Le bilan est la photo du patrimoine ; le CPC explique comment le résultat s'est forme.", icon: Scale },
  { id: "bank", label: "Trésorerie", note: "Comptable et bancaire", help: "Le solde des comptes 51/53 vu par la comptabilité, compare aux relevés importés.", icon: Banknote },
  { id: "fiscal", label: "Liasse fiscale", note: "Tableaux et contrôles", help: "Les tableaux fiscaux normalisés, leurs retraitements et les contrôles avant dépôt.", icon: ShieldCheck },
];

const balanceViews = [
  ["GENERAL", "Générale"], ["CUMULATIVE", "Cumulative"], ["OPENING", "Ouverture"],
  ["PRE_INVENTORY", "Avant inventaire"], ["POST_INVENTORY", "Après inventaire"], ["POST_CLOSING", "Après clôture"],
  ["AUXILIARY_CUSTOMERS", "Auxiliaire clients"], ["AUXILIARY_SUPPLIERS", "Auxiliaire fournisseurs"],
  ["AGED_CUSTOMERS", "Âgée clients"], ["AGED_SUPPLIERS", "Âgée fournisseurs"],
  ["BY_JOURNAL", "Par journal"], ["BY_PERIOD", "Par période"], ["COMPARATIVE", "Comparative"], ["ANALYTICAL", "Analytique"],
] as const;

/**
 * What each PCGE class holds, in plain language. Shown next to the class
 * number so a non-accountant can pick the right one without a reference sheet.
 */
const PCGE_CLASS_NOTES = [
  "Comptes speciaux",                    // 0
  "Comptes de financement permanent",    // 1
  "Comptes d'actif immobilise",          // 2
  "Actif circulant, hors trésorerie",    // 3
  "Passif circulant, hors trésorerie",   // 4
  "Comptes de trésorerie",               // 5
  "Comptes de charges",                  // 6
  "Comptes de produits",                 // 7
  "Comptes de résultats",                // 8
  "Comptes analytiques",                 // 9
];

const compact = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

function api(): Loose {
  return (window.wheat ?? {}) as Loose;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function iso(value: unknown) {
  return String(value ?? "").slice(0, 10);
}

function cents(value: unknown, currency = "MAD") {
  const raw = String(value ?? "0");
  if (!/^-?\d+$/.test(raw)) return "—";
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  return `${negative ? "−" : ""}${Number(digits.slice(0, -2)).toLocaleString("fr-FR")},${digits.slice(-2)} ${currency}`;
}

function amountInputToCents(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) throw new Error("Le montant doit être positif avec au maximum deux décimales.");
  const [whole, fraction = ""] = normalized.split(".");
  const result = BigInt(`${whole}${fraction.padEnd(2, "0")}`);
  if (result <= 0n) throw new Error("Le montant doit être supérieur à zéro.");
  return result.toString();
}

function signedAmountInputToCents(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(normalized)) throw new Error("Le montant doit utiliser au maximum deux décimales.");
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const result = BigInt(`${whole}${fraction.padEnd(2, "0")}`);
  return `${negative && result !== 0n ? "-" : ""}${result.toString()}`;
}

function centsToAmountInput(value: unknown) {
  const raw = String(value ?? "");
  if (!/^-?\d+$/.test(raw)) return raw;
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)},${digits.slice(-2)}`;
}

function rateInputToBps(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d{0,2})?$/.test(normalized)) throw new Error("Le taux doit utiliser au maximum deux décimales.");
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const result = BigInt(`${whole}${fraction.padEnd(2, "0")}`);
  return `${negative && result !== 0n ? "-" : ""}${result.toString()}`;
}

function bpsToRateInput(value: unknown) {
  const raw = String(value ?? "");
  if (!/^-?\d+$/.test(raw)) return raw;
  return centsToAmountInput(raw);
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export function FiscalWorkspace({ company, documents = [], currency = "MAD", initialTab = "pcge", onChanged, onNotify }: FiscalWorkspaceProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setTab(initialTab), [company.id, initialTab]);
  const active = tabs.find((item) => item.id === tab) ?? tabs[0];
  return (
    <section className="fiscal-ws wt-stack" aria-label="Comptes et états du dossier">
      <Tabs
        variant="cards"
        ariaLabel="Modules comptables et fiscaux"
        value={tab}
        onChange={(next) => setTab(next as Tab)}
        items={tabs.map((item) => {
          const Icon = item.icon;
          return { id: item.id, label: item.label, note: item.note, icon: <Icon size={17} aria-hidden="true" /> };
        })}
      />

      <Explainer icon={<CheckCircle2 size={16} aria-hidden="true" />}>
        <strong>{active.label}</strong> — {active.help} Les montants sont calculés au centime exact, en local, à partir des écritures comptabilisées de {company.name}.
      </Explainer>

      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          <TabPanel id={tab}>
            {tab === "pcge" && <PcgePanel company={company} onChanged={onChanged} onNotify={onNotify} />}
            {tab === "balance" && <BalancePanel company={company} currency={currency} onNotify={onNotify} />}
            {tab === "bilan" && <BilanPanel company={company} currency={currency} onNotify={onNotify} />}
            {tab === "bank" && <BankPanel company={company} currency={currency} onNotify={onNotify} />}
            {tab === "fiscal" && <FiscalPanel company={company} documents={documents} currency={currency} onChanged={onChanged} onNotify={onNotify} />}
          </TabPanel>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

function PcgePanel({ company, onChanged, onNotify }: Omit<FiscalWorkspaceProps, "currency">) {
  const accounts = useMemo(() => [...(company.accounts ?? [])].sort((a, b) => a.code.localeCompare(b.code, "fr", { numeric: true })), [company.accounts]);
  const [query, setQuery] = useState("");
  const [classNo, setClassNo] = useState("ALL");
  const [showInactive, setShowInactive] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]));
  const [parentCode, setParentCode] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const children = useMemo(() => accounts.reduce((map: Map<string | null, Loose[]>, account) => {
    const key = account.parentCode ?? null;
    map.set(key, [...(map.get(key) ?? []), account]);
    return map;
  }, new Map()), [accounts]);
  const needle = normalize(query);
  const filtered = useMemo(() => {
    if (needle) return accounts.filter((account) => normalize(`${account.code} ${account.label} ${account.labelArabic ?? ""}`).includes(needle) && (classNo === "ALL" || String(account.classNo) === classNo) && (showInactive || account.active));
    const rows: Loose[] = [];
    const visit = (parent: string | null) => {
      for (const account of children.get(parent) ?? []) {
        if ((classNo === "ALL" || String(account.classNo) === classNo) && (showInactive || account.active)) rows.push(account);
        if (expanded.has(account.code)) visit(account.code);
      }
    };
    visit(null);
    return rows;
  }, [accounts, children, classNo, expanded, needle, showInactive]);

  const toggle = (account: Loose) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(account.code)) next.delete(account.code); else next.add(account.code);
    return next;
  });

  const createSubdivision = async (event: FormEvent) => {
    event.preventDefault();
    if (!parentCode) return onNotify?.("Choisissez le compte parent.", "warning");
    const parent = accounts.find((item) => item.code === parentCode);
    setSaving(true);
    try {
      await api().saveAccount({ companyId: company.id, code, label, parentCode, classNo: Number(code[0]), type: parent?.type ?? "MEMO" });
      setCode(""); setLabel(""); setExpanded((value) => new Set(value).add(parentCode));
      await onChanged?.();
      onNotify?.("Subdivision créée avec les mappings hérités du compte parent.", "success");
    } catch (error) { onNotify?.(message(error), "error"); } finally { setSaving(false); }
  };

  return <div className="fiscal-ws-pane">
    <div className="fiscal-ws-toolbar">
      <label className="fiscal-ws-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher numéro, libellé ou arabe…" /></label>
      <WheatSelect
        ariaLabel="Classe de comptes"
        value={classNo}
        onChange={setClassNo}
        options={[
          { value: "ALL", label: "Toutes les classes", note: "Aucun filtre" },
          ...Array.from({ length: 10 }, (_, index): WheatSelectOption => ({
            value: String(index),
            label: `Classe ${index}`,
            note: PCGE_CLASS_NOTES[index],
          })),
        ]}
      />
      <label className="fiscal-ws-check"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Inactifs</label>
      <span className="fiscal-ws-count">{compact.format(accounts.filter((a) => a.isStandard).length)} comptes officiels</span>
    </div>
    <div className="fiscal-ws-split">
      <div className="fiscal-ws-table-wrap">
        <table className="fiscal-ws-table"><thead><tr><th>Compte</th><th>Libellé</th><th>Nature</th><th>État</th></tr></thead><tbody>
          {filtered.map((account) => {
            const hasChildren = (children.get(account.code)?.length ?? 0) > 0;
            return <tr key={account.id} className={!account.active ? "muted" : account.isStandard ? "standard" : "custom"}>
              <td><div className="fiscal-ws-tree-code" style={{ paddingLeft: `${Math.min(Number(account.hierarchyDepth ?? 0), 6) * 15}px` }}>
                <button disabled={!hasChildren || !!needle} onClick={() => toggle(account)} aria-label={`${expanded.has(account.code) ? "Replier" : "Déplier"} ${account.code}`}>{hasChildren ? expanded.has(account.code) ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : <span />}</button>
                <strong>{account.code}</strong>
              </div></td>
              <td>{account.label}{account.isStandard ? <small className="fiscal-ws-badge">PCGE</small> : <small className="fiscal-ws-badge custom">DOSSIER</small>}</td>
              <td><span className="fiscal-ws-nature">{account.reportNature === "BALANCE_SHEET" ? "Bilan" : account.reportNature === "PROFIT_AND_LOSS" ? "CPC" : account.category ?? "Mémo"}</span></td>
              <td>{account.active ? "Actif" : "Désactivé"}</td>
            </tr>;
          })}
        </tbody></table>
      </div>
      <aside className="fiscal-ws-context">
        <p className="fiscal-ws-kicker">EXTENSION DU DOSSIER</p><h2>Créer une subdivision</h2>
        <p>Le compte reste distinct du référentiel officiel et hérite de la nature, du sens attendu et des mappings de son parent.</p>
        <form onSubmit={createSubdivision}>
          <label>Compte parent<WheatSelect
            required
            ariaLabel="Compte parent"
            placeholder="Choisir un compte parent…"
            searchPlaceholder="Numéro ou libellé du compte…"
            noOptionsLabel="Aucun compte parent disponible"
            value={parentCode}
            onChange={(value) => { setParentCode(value); if (!code) setCode(`${value}1`); }}
            options={accounts.filter((account) => account.isStandard).map((account): WheatSelectOption => ({
              value: String(account.code),
              label: `${account.code} — ${account.label}`,
              keywords: String(account.label ?? ""),
              group: `Classe ${String(account.code).slice(0, 1)}`,
            }))}
          /></label>
          <label>Nouveau numéro<input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 20))} required /></label>
          <label>Libellé<input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={180} required /></label>
          <button className="fiscal-ws-primary" disabled={saving}><Plus size={16} /> {saving ? "Création…" : "Créer la subdivision"}</button>
        </form>
        <p className="fiscal-ws-footnote">Source enregistrée avec le jeu de données : CGNC / PCGE marocain, referentiel officiel embarque dans Wheat. Les comptes officiels ne sont pas modifiables.</p>
      </aside>
    </div>
  </div>;
}

function period(company: Loose) {
  return (company.fiscalYears ?? []).find((year: Loose) => year.status === "OPEN") ?? company.fiscalYears?.[0];
}

function BalancePanel({ company, currency, onNotify }: FiscalWorkspaceProps) {
  const fy = period(company);
  const [view, setView] = useState("GENERAL");
  const [from, setFrom] = useState(iso(fy?.startsOn));
  const [to, setTo] = useState(iso(fy?.endsOn));
  const [result, setResult] = useState<Loose | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); try { setResult(await api().getBalanceFamily({ companyId: company.id, view, from, to })); } catch (error) { onNotify?.(message(error), "error"); } finally { setBusy(false); } };
  useEffect(() => { void load(); }, [company.id, view]);
  return <div className="fiscal-ws-pane">
    <div className="fiscal-ws-toolbar"><WheatSelect
      ariaLabel="Vue de balance"
      searchPlaceholder="Nom de la vue…"
      value={view}
      onChange={setView}
      options={balanceViews.map(([id, label]): WheatSelectOption => ({ value: id, label }))}
    /><label>Du <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>Au <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><button onClick={load} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} /> Actualiser</button><span className={result?.balanced ? "fiscal-ws-ok" : "fiscal-ws-warn"}>{result?.balanced ? "Débits = crédits" : "Écart à contrôler"}</span></div>
    <div className="fiscal-ws-table-wrap report"><table className="fiscal-ws-table numeric"><thead><tr><th>Compte</th><th>Libellé</th><th>Ouverture</th><th>Débit période</th><th>Crédit période</th><th>Solde débiteur</th><th>Solde créditeur</th>{view === "COMPARATIVE" && <><th>Solde N−1</th><th>Variation</th></>}</tr></thead><tbody>
      {(result?.rows ?? []).map((row: Loose) => <tr key={row.key}><td><strong>{row.code}</strong></td><td>{row.label}</td><td>{cents(row.openingBalanceCents, currency)}</td><td>{cents(row.periodDebitCents, currency)}</td><td>{cents(row.periodCreditCents, currency)}</td><td>{cents(row.debitBalanceCents, currency)}</td><td>{cents(row.creditBalanceCents, currency)}</td>{view === "COMPARATIVE" && <><td>{cents(row.priorBalanceCents, currency)}</td><td>{cents(row.varianceCents, currency)}</td></>}</tr>)}
    </tbody>{result?.totals && <tfoot><tr><th colSpan={2}>Totaux exacts</th><th>—</th><th>{cents(result.totals.periodDebitCents, currency)}</th><th>{cents(result.totals.periodCreditCents, currency)}</th><th>{cents(result.totals.debitBalanceCents, currency)}</th><th>{cents(result.totals.creditBalanceCents, currency)}</th>{view === "COMPARATIVE" && <><th>{cents(result.comparative?.totals?.priorBalanceCents, currency)}</th><th>{cents(result.comparative?.totals?.varianceCents, currency)}</th></>}</tr></tfoot>}</table>{!busy && !result?.rows?.length && <div className="fiscal-ws-empty">Aucun mouvement pour ces filtres.</div>}</div>
  </div>;
}

function BilanPanel({ company, currency, onNotify }: FiscalWorkspaceProps) {
  const fy = period(company); const [variant, setVariant] = useState("NORMAL"); const [view, setView] = useState("INTERIM"); const [asOf, setAsOf] = useState(iso(fy?.endsOn)); const [result, setResult] = useState<Loose | null>(null);
  const load = async () => { try { setResult(await api().getBilan({ companyId: company.id, variant, view, asOf })); } catch (error) { onNotify?.(message(error), "error"); } };
  useEffect(() => { void load(); }, [company.id, variant, view]);
  return <div className="fiscal-ws-pane"><div className="fiscal-ws-toolbar"><select value={variant} onChange={(e) => setVariant(e.target.value)}><option value="NORMAL">Modèle normal</option><option value="SIMPLIFIED">Modèle simplifié</option></select><select value={view} onChange={(e) => setView(e.target.value)}><option value="INTERIM">Situation intermédiaire</option><option value="CLOSING">Clôture</option><option value="COMPARATIVE">Comparatif N / N−1</option></select><label>Arrêté au <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label><button onClick={load}><RefreshCw size={15} /> Calculer</button></div>
    <div className="fiscal-ws-bilan-grid"><BilanSide title="ACTIF" rows={result?.actif ?? []} total={result?.totals?.totalActifCents} priorTotal={result?.comparative?.totals?.priorActifCents} currency={currency} comparative={view === "COMPARATIVE"} /><BilanSide title="PASSIF" rows={result?.passif ?? []} total={result?.totals?.totalPassifCents} priorTotal={result?.comparative?.totals?.priorPassifCents} currency={currency} comparative={view === "COMPARATIVE"} /></div>
    {result && <div className="fiscal-ws-guard"><AlertTriangle size={18} /><div><strong>Calcul opérationnel · export statutaire bloqué</strong><p>{result.statutoryWarning}</p></div><span>{result.balanced ? "Équilibré" : `Écart ${cents(result.totals.differenceCents, currency)}`}</span></div>}
  </div>;
}

function BilanSide({ title, rows, total, priorTotal, currency, comparative }: { title: string; rows: Loose[]; total: unknown; priorTotal?: unknown; currency?: string; comparative?: boolean }) {
  return <section className="fiscal-ws-statement"><header><span>{title}</span><small>{comparative ? "N · N−1" : "Postes PCGE"}</small></header><div>{rows.map((row) => <p key={row.key}><span><b>{row.code}</b>{row.label}</span><strong>{cents(row.amountCents, currency)}{comparative && <small> N−1 {cents(row.priorAmountCents, currency)}</small>}</strong></p>)}</div><footer><span>Total {title.toLowerCase()}</span><strong>{cents(total, currency)}{comparative && <small> N−1 {cents(priorTotal, currency)}</small>}</strong></footer></section>;
}

function BankPanel({ company, onNotify }: FiscalWorkspaceProps) {
  const [result, setResult] = useState<Loose | null>(null); const load = async () => { try { setResult(await api().getBankTotal({ companyId: company.id })); } catch (error) { onNotify?.(message(error), "error"); } };
  useEffect(() => { void load(); }, [company.id]);
  return <div className="fiscal-ws-pane"><div className="fiscal-ws-toolbar"><div><p className="fiscal-ws-kicker">POSITION DE TRÉSORERIE</p><strong>Solde comptable et dernier relevé importé</strong></div><button onClick={load}><RefreshCw size={15} /> Actualiser</button></div><div className="fiscal-ws-table-wrap"><table className="fiscal-ws-table numeric"><thead><tr><th>Banque</th><th>Compte</th><th>Devise</th><th>Comptabilité</th><th>Banque</th><th>Écart</th><th>Source</th></tr></thead><tbody>{(result?.rows ?? []).map((row: Loose) => <tr key={row.bankAccountId}><td><strong>{row.bankName}</strong></td><td>{row.ledgerAccountCode ?? "À mapper"}</td><td>{row.currency}</td><td>{cents(row.accountingCents, row.currency)}</td><td>{row.bankCents == null ? "Non importé" : cents(row.bankCents, row.currency)}</td><td>{row.differenceCents == null ? "—" : cents(row.differenceCents, row.currency)}</td><td>{row.source}</td></tr>)}</tbody></table></div>{result?.mixedCurrency && <div className="fiscal-ws-guard"><AlertTriangle size={18} /><div><strong>Plusieurs devises</strong><p>Wheat présente un total distinct par devise et ne fabrique jamais de conversion.</p></div></div>}{(result?.totalsByCurrency ?? []).map((row: Loose) => <div className="fiscal-ws-bank-total" key={row.currency}><span>Total {row.currency}</span><strong>{cents(row.accountingCents, row.currency)}</strong><small>{row.bankBalanceComplete ? `Banque ${cents(row.bankCents, row.currency)}` : "Relevé manquant pour au moins un compte"}</small></div>)}</div>;
}

function FiscalPanel({ company, documents = [], currency, onChanged, onNotify }: FiscalWorkspaceProps) {
  const years = company.fiscalYears ?? [];
  const [yearId, setYearId] = useState(period(company)?.id ?? "");
  const [retained, setRetained] = useState("");
  const [preview, setPreview] = useState<Loose | null>(null);
  const [fiscal, setFiscal] = useState<Loose | null>(null);
  const [validation, setValidation] = useState<Loose | null>(null);
  const [regime, setRegime] = useState("NORMAL");
  const [busy, setBusy] = useState(false);
  const [adjustment, setAdjustment] = useState({ kind: "REINTEGRATION", label: "", amount: "", legalReference: "" });
  const retainedAccounts = (company.accounts ?? []).filter((account: Loose) => account.classNo === 1 && account.active && account.postable);
  const resetPackage = () => { setFiscal(null); setValidation(null); };
  const previewOpening = async () => {
    setBusy(true);
    try { setPreview(await api().previewOpeningBalance({ companyId: company.id, fiscalYearId: yearId, retainedEarningsAccountCode: retained || undefined })); }
    catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const post = async () => {
    if (!preview?.canPost || !confirmWithAppFocus("Comptabiliser définitivement ces à-nouveaux dans le journal OD ?")) return;
    setBusy(true);
    try {
      await api().postOpeningBalance({ companyId: company.id, fiscalYearId: yearId, retainedEarningsAccountCode: retained || undefined, confirmed: true });
      await onChanged?.();
      onNotify?.("À-nouveaux comptabilisés et audités.", "success");
    } catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const generate = async () => {
    setBusy(true);
    try {
      const next = await api().generateFiscalPackage({ companyId: company.id, fiscalYearId: yearId, regime });
      setFiscal(next);
      setValidation(await api().validateFiscalPackage({ companyId: company.id, id: next.id }));
    } catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const addAdjustment = async (event: FormEvent) => {
    event.preventDefault();
    if (!fiscal) return;
    if (!adjustment.label.trim() || !adjustment.legalReference.trim()) return onNotify?.("Le libellé et la référence légale sont obligatoires.", "warning");
    if (!confirmWithAppFocus("Ajouter cet ajustement à la liasse fiscale en brouillon ? Il restera bloqué jusqu'à vérification humaine.")) return;
    setBusy(true);
    try {
      await api().addFiscalAdjustment({ companyId: company.id, fiscalPackageId: fiscal.id, kind: adjustment.kind, label: adjustment.label.trim(), amountCents: amountInputToCents(adjustment.amount), legalReference: adjustment.legalReference.trim(), evidence: [], confirmed: true });
      setAdjustment((current) => ({ ...current, label: "", amount: "", legalReference: "" }));
      const next = await api().generateFiscalPackage({ companyId: company.id, fiscalYearId: yearId, regime });
      setFiscal(next);
      setValidation(await api().validateFiscalPackage({ companyId: company.id, id: next.id }));
      onNotify?.("Ajustement ajouté au brouillon fiscal.", "success");
    } catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const verifyAdjustment = async (adjustmentId: string) => {
    if (!fiscal || !confirmWithAppFocus("Confirmer que cet ajustement et sa référence ont été contrôlés par le responsable du dossier ?")) return;
    setBusy(true);
    try {
      await api().verifyFiscalAdjustment({ companyId: company.id, fiscalPackageId: fiscal.id, adjustmentId, confirmed: true });
      const next = await api().generateFiscalPackage({ companyId: company.id, fiscalYearId: yearId, regime });
      setFiscal(next);
      setValidation(await api().validateFiscalPackage({ companyId: company.id, id: next.id }));
      onNotify?.("Ajustement fiscal vérifié. Recalculez le tableau 3 pour actualiser son snapshot.", "success");
    } catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const issues = validation?.issues ?? [];
  return <div className="fiscal-ws-pane">
    <div className="fiscal-ws-split fiscal">
      <section className="fiscal-ws-context wide">
        <p className="fiscal-ws-kicker">PRÉPARATION DE L'EXERCICE</p><h2>À-nouveaux contrôlés</h2>
        <p>Seuls les comptes de bilan sont repris. L'affectation du résultat reste une décision humaine.</p>
        <label>Exercice cible<WheatSelect
          ariaLabel="Exercice cible"
          searchPlaceholder="Libellé de l'exercice…"
          value={yearId}
          onChange={(value) => { setYearId(value); setPreview(null); resetPackage(); }}
          options={years.map((year: Loose): WheatSelectOption => ({
            value: String(year.id),
            label: String(year.label),
            note: `${iso(year.startsOn)} → ${iso(year.endsOn)}`,
          }))}
        /></label>
        <label>Compte d'affectation du résultat<WheatSelect
          ariaLabel="Compte d'affectation du résultat"
          placeholder="Ne pas présumer"
          searchPlaceholder="Numéro ou libellé du compte…"
          allowClear
          noOptionsLabel="Aucun compte de report disponible"
          value={retained}
          onChange={setRetained}
          options={retainedAccounts.map((account: Loose): WheatSelectOption => ({
            value: String(account.id),
            label: `${account.code} — ${account.label}`,
            keywords: String(account.label ?? ""),
          }))}
        /></label>
        <div className="fiscal-ws-actions"><button onClick={previewOpening} disabled={busy}><RefreshCw size={15} /> Prévisualiser</button><button className="fiscal-ws-primary" onClick={post} disabled={!preview?.canPost || busy}>Comptabiliser avec confirmation</button></div>
        {preview && <><div className="fiscal-ws-fiscal-summary"><span>{preview.rows.length} lignes</span><strong>{cents(preview.debitCents, currency)} = {cents(preview.creditCents, currency)}</strong></div>{preview.warnings?.map((warning: string) => <p className="fiscal-ws-warning" key={warning}><AlertTriangle size={15} />{warning}</p>)}</>}
      </section>
      <section className="fiscal-ws-context wide">
        <p className="fiscal-ws-kicker">LIASSE FISCALE · DOSSIER DE PRÉPARATION</p><h2>{regime === "NORMAL" ? "25 tableaux traçables" : "Résultat fiscal simplifié"}</h2>
        <p>{regime === "NORMAL" ? "Wheat calculé ce que le grand livre prouve et laisse le reste à compléter avec une source." : "Le catalogue normal n'est pas appliqué au régime simplifié."}</p>
        <label>Régime<select aria-label="Régime fiscal" value={regime} onChange={(event) => { setRegime(event.target.value); resetPackage(); }}><option value="NORMAL">Normal</option><option value="SIMPLIFIED">Simplifié</option></select></label>
        <button onClick={generate} disabled={busy || !yearId}><FileSpreadsheet size={15} /> {fiscal ? "Actualiser le dossier" : "Préparer la liasse fiscale"}</button>
        {fiscal && <><div className="fiscal-ws-fiscal-summary block"><span>Résultat comptable</span><strong>{cents(fiscal.accountingProfitCents, currency)}</strong><small>{fiscal.templateVersion} · {fiscal.status} · exercice {fiscal.fiscalYear?.label}</small></div><div className="fiscal-ws-fiscal-summary block"><span>Résultat fiscal calculé</span><strong>{cents(validation?.taxableProfitCents ?? fiscal.taxableProfitCents, currency)}</strong><small>{fiscal.adjustments?.length ?? 0} ajustement(s) · {regime === "NORMAL" ? `${validation?.tableSummaries?.filter((item: Loose) => ["REVIEWED", "NOT_APPLICABLE"].includes(item.status) && !item.stale).length ?? 0}/25 tableaux complets` : `${issues.length} contrôle(s)`}</small></div></>}
        {issues.filter((issue: Loose) => issue.code !== "FISCAL_TABLES_INCOMPLETE").slice(0, 3).map((issue: Loose, index: number) => <p className="fiscal-ws-warning" key={`${issue.code}-${index}`}><AlertTriangle size={15} />{issue.message}</p>)}
        <div className="fiscal-ws-guard compact"><Landmark size={18} /><div><strong>Dossier de préparation</strong><p>Aucune télédéclaration ni export statutaire n'est produit sans millésime officiel vérifié.</p></div></div>
      </section>
    </div>
    {fiscal && regime === "NORMAL" && <FiscalWorkpaperWorkspace company={company} documents={documents} fiscal={fiscal} currency={currency ?? "MAD"} onNotify={onNotify} />}
    {fiscal && <section className="fiscal-ws-context wide fiscal-ws-fiscal-adjustments"><div><p className="fiscal-ws-kicker">AJUSTEMENTS FISCAUX</p><h2>Réintégrations et déductions documentées</h2></div><div className="fiscal-ws-table-wrap"><table className="fiscal-ws-table numeric"><thead><tr><th>Type</th><th>Libellé</th><th>Référence légale</th><th>Montant</th><th>Vérification</th></tr></thead><tbody>{(fiscal.adjustments ?? []).map((item: Loose) => <tr key={item.id}><td>{item.kind === "DEDUCTION" ? "Déduction" : "Réintégration"}</td><td>{item.label}</td><td>{item.legalReference}</td><td>{cents(item.amountCents, currency)}</td><td>{item.verified ? <span className="fiscal-ws-adjustment-verified"><CheckCircle2 size={13} /> Vérifié</span> : <button type="button" onClick={() => void verifyAdjustment(item.id)} disabled={busy}>Vérifier</button>}</td></tr>)}</tbody></table>{!fiscal.adjustments?.length && <div className="fiscal-ws-empty">Aucun ajustement saisi.</div>}</div><form className="fiscal-ws-adjustment-form" onSubmit={addAdjustment}><label>Type<select aria-label="Type d'ajustement" value={adjustment.kind} onChange={(event) => setAdjustment((current) => ({ ...current, kind: event.target.value }))}><option value="REINTEGRATION">Réintégration</option><option value="DEDUCTION">Déduction</option></select></label><label>Libellé<input aria-label="Libellé de l'ajustement" value={adjustment.label} onChange={(event) => setAdjustment((current) => ({ ...current, label: event.target.value }))} /></label><label>Montant ({currency})<input aria-label="Montant de l'ajustement" inputMode="decimal" value={adjustment.amount} onChange={(event) => setAdjustment((current) => ({ ...current, amount: event.target.value }))} placeholder="0,00" /></label><label>Référence légale<input aria-label="Référence légale" value={adjustment.legalReference} onChange={(event) => setAdjustment((current) => ({ ...current, legalReference: event.target.value }))} placeholder="Article, note ou source vérifiée" /></label><button className="fiscal-ws-primary" disabled={busy || !adjustment.label.trim() || !adjustment.amount.trim() || !adjustment.legalReference.trim()}><Plus size={15} /> Ajouter au brouillon</button></form></section>}
  </div>;
}

/**
 * Per-workpaper view preference. The pre-2.0 key is still read once so an
 * existing installation keeps the view the user last opened; it is never
 * written again and never shown in the interface.
 */
const fiscalViewKey = (fiscalId: string) => `wheat.fiscal.view.${fiscalId}`;
const legacyFiscalViewKey = (fiscalId: string) => `atlas:fiscal:view:${fiscalId}`;

function readFiscalView(fiscalId: string) {
  try {
    return localStorage.getItem(fiscalViewKey(fiscalId)) ?? localStorage.getItem(legacyFiscalViewKey(fiscalId)) ?? "CONTROL";
  } catch {
    return "CONTROL";
  }
}

function FiscalWorkpaperWorkspace({ company, documents, fiscal, currency, onNotify }: { company: Loose; documents: Loose[]; fiscal: Loose; currency: string; onNotify?: FiscalWorkspaceProps["onNotify"] }) {
  const [catalog, setCatalog] = useState<Loose | null>(null);
  const [summaries, setSummaries] = useState<Loose[]>([]);
  const [control, setControl] = useState<Loose | null>(null);
  const [selectedView, setSelectedView] = useState(() => readFiscalView(fiscal.id));
  const [detail, setDetail] = useState<Loose | null>(null);
  const [manualRows, setManualRows] = useState<Loose[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);
  const [evidenceDocumentId, setEvidenceDocumentId] = useState("");
  const [reasonAction, setReasonAction] = useState<"REOPEN" | "NOT_APPLICABLE" | null>(null);
  const [reason, setReason] = useState("");
  const hashedDocuments = documents.filter((document) => document.contentSha256);
  const tableIdForView = (view: string) => view.startsWith("T01_") ? "T01" : view.startsWith("T02_") ? "T02" : view;
  const hydrateRows = (record: Loose) => {
    const columns = record.definition?.manualColumns ?? [];
    setManualRows((record.manualRows ?? []).map((row: Loose) => ({ ...row, ...Object.fromEntries(columns.map((column: Loose) => [column.key, column.type === "MONEY" ? centsToAmountInput(row[column.key]) : column.type === "RATE" ? bpsToRateInput(row[column.key]) : String(row[column.key] ?? "")])) })));
    setDirty(false);
  };
  const loadSummaries = async () => {
    const [listed, checked] = await Promise.all([
      api().listFiscalTables({ companyId: company.id, fiscalPackageId: fiscal.id }),
      api().getFiscalControl({ companyId: company.id, fiscalPackageId: fiscal.id }),
    ]);
    setSummaries(listed.tables ?? []); setControl(checked);
  };
  const loadDetail = async (view: string) => {
    if (view === "CONTROL") { setDetail(null); return; }
    const record = await api().getFiscalTable({ companyId: company.id, fiscalPackageId: fiscal.id, tableId: tableIdForView(view) });
    setDetail(record); hydrateRows(record);
  };
  useEffect(() => {
    let active = true;
    setCatalogError(null);
    void Promise.all([api().getFiscalTableCatalog(), api().listFiscalTables({ companyId: company.id, fiscalPackageId: fiscal.id }), api().getFiscalControl({ companyId: company.id, fiscalPackageId: fiscal.id })]).then(([nextCatalog, listed, checked]) => {
      if (!active) return;
      const stored = readFiscalView(fiscal.id);
      const valid = stored === "CONTROL" || nextCatalog.views?.some((view: Loose) => view.id === stored);
      const nextView = valid ? stored : "CONTROL";
      setCatalog(nextCatalog); setSummaries(listed.tables ?? []); setControl(checked); setSelectedView(nextView);
      void loadDetail(nextView).catch((error) => onNotify?.(message(error), "error"));
    }).catch((error) => {
      if (!active) return;
      const detail = message(error);
      setCatalogError(detail);
      onNotify?.(detail, "error");
    });
    return () => { active = false; };
  }, [company.id, fiscal.id, catalogReload]);
  useEffect(() => { void loadDetail(selectedView).catch((error) => onNotify?.(message(error), "error")); }, [fiscal.id, selectedView]);
  useEffect(() => { localStorage.setItem(fiscalViewKey(fiscal.id), selectedView); }, [fiscal.id, selectedView]);
  const selectedLabel = selectedView === "CONTROL" ? "Contrôle de la liasse fiscale" : catalog?.views?.find((view: Loose) => view.id === selectedView)?.label ?? selectedView;
  const tableOptions = useMemo<WheatSelectOption[]>(() => [
    {
      value: "CONTROL",
      label: "Contrôle de la liasse fiscale",
      note: "Vue d'ensemble des contrôles",
      keywords: "contrôle progression anomalies",
    },
    ...(catalog?.tables ?? []).flatMap((table: Loose) => {
      const summary = summaries.find((item) => item.tableId === table.id);
      const status = summary?.stale
        ? "À recalculer"
        : summary?.status === "REVIEWED"
          ? "Revu"
          : summary?.status === "NOT_APPLICABLE"
            ? "Non applicable"
            : "Brouillon";
      return (table.views ?? []).map((view: Loose): WheatSelectOption => ({
        value: String(view.id),
        label: String(view.label ?? view.id),
        note: `Tableau ${table.number} · ${status}`,
        keywords: `${table.number} ${table.label ?? ""} ${status}`,
        group: `Tableau ${table.number} — ${table.label ?? "Sans libellé"}`,
      }));
    }),
  ], [catalog, summaries]);
  const choose = (viewId: string) => {
    if (viewId !== selectedView && dirty && !confirmWithAppFocus("Ignorer les modifications non enregistrées de ce tableau ?")) return;
    setSelectedView(viewId);
  };
  const run = async (method: string, payload: Loose, success: string) => {
    if (!detail) return false;
    setBusy(true);
    try {
      const result = await api()[method]({ companyId: company.id, fiscalPackageId: fiscal.id, tableId: detail.tableId, expectedRevision: detail.revision, confirmed: true, ...payload });
      setDetail(result); hydrateRows(result); await loadSummaries(); onNotify?.(success, "success");
      return true;
    } catch (error) { onNotify?.(message(error), "error"); return false; }
    finally { setBusy(false); }
  };
  const serializeManualRows = () => manualRows.map((row) => ({ ...row, ...Object.fromEntries((detail?.definition?.manualColumns ?? []).map((column: Loose) => {
    const value = String(row[column.key] ?? "").trim();
    return [column.key, !value ? "" : column.type === "MONEY" ? signedAmountInputToCents(value) : column.type === "RATE" ? rateInputToBps(value) : value];
  })) }));
  const save = () => run("saveFiscalTable", { manualRows: serializeManualRows() }, "Tableau enregistré et audité.");
  const review = () => { if (!dirty && confirmWithAppFocus("Marquer ce tableau comme revu et le verrouiller ?")) void run("reviewFiscalTable", {}, "Tableau revu et verrouillé."); };
  const requestReason = (action: "REOPEN" | "NOT_APPLICABLE") => { setReason(""); setReasonAction(action); };
  const submitReason = async () => {
    if (!reasonAction || !reason.trim()) return;
    const completed = reasonAction === "NOT_APPLICABLE"
      ? await run("markFiscalTableNotApplicable", { reason: reason.trim() }, "Non-applicabilité documentée.")
      : await run(detail?.status === "NOT_APPLICABLE" ? "clearFiscalTableNotApplicable" : "reopenFiscalTable", { reason: reason.trim() }, "Tableau rouvert en brouillon.");
    if (completed) { setReasonAction(null); setReason(""); }
  };
  const refresh = () => { if (confirmWithAppFocus("Recalculer les données comptables de ce tableau ? Les lignes manuelles sont conservées.")) void run("refreshFiscalTable", {}, "Sources comptables recalculées."); };
  const attachEvidence = () => { if (evidenceDocumentId) void run("attachFiscalTableEvidence", { documentId: evidenceDocumentId, role: "SUPPORT" }, "Pièce hashée rattachée."); };
  const removeEvidence = (evidenceId: string) => { if (confirmWithAppFocus("Retirer cette pièce du tableau ?")) void run("removeFiscalTableEvidence", { evidenceId }, "Pièce retirée du tableau."); };
  const addManualRow = () => {
    if (!detail) return;
    setManualRows((rows) => [...rows, { rowId: `${Date.now()}-${rows.length}`, ...Object.fromEntries((detail.definition?.manualColumns ?? []).map((column: Loose) => [column.key, ""])) }]);
    setDirty(true);
  };
  const removeManualRow = (rowId: string) => { setManualRows((rows) => rows.filter((row) => row.rowId !== rowId)); setDirty(true); };
  const sectionId = selectedView === "T01_ACTIF" ? "ACTIF" : selectedView === "T01_PASSIF" ? "PASSIF" : selectedView === "T02_CPC" ? "CPC" : selectedView === "T02_SUITE" ? "SUITE" : undefined;
  const sections = detail?.computed?.sections ?? [];
  const visibleSections = sectionId ? sections.filter((section: Loose) => section.id === sectionId) : sections;
  const formatCell = (value: unknown, type: string) => type === "MONEY" ? cents(value, currency) : type === "DATE" ? iso(value) : String(value ?? "—");
  return <section className="fiscal-ws-liasse-workspace" aria-label="Tableaux de la liasse fiscale">
    <div className="fiscal-ws-liasse-bar">
      <div className="fiscal-ws-liasse-picker">
        <span id="fiscal-table-picker-label" className="fiscal-ws-liasse-picker__label">Tableau sélectionné</span>
        <WheatSelect
          labelledBy="fiscal-table-picker-label"
          value={selectedView}
          onChange={choose}
          options={tableOptions}
          searchable
          searchPlaceholder="Numéro ou nom du tableau…"
          noOptionsLabel="Aucun tableau disponible"
          emptyLabel="Aucun tableau correspondant"
          loading={!catalog && !catalogError}
          loadingLabel="Chargement des tableaux…"
          error={catalogError}
          onRetry={() => setCatalogReload((current) => current + 1)}
          footerNote="25 tableaux et vues fiscales"
        />
      </div>
      <div className="fiscal-ws-liasse-progress"><span style={{ width: `${Math.round((control?.completed ?? 0) / Math.max(control?.total ?? 25, 1) * 100)}%` }} /><small>{control?.completed ?? 0} / {control?.total ?? 25} tableaux complets</small></div>
    </div>
    <AnimatePresence mode="wait"><motion.div key={selectedView} className="fiscal-ws-liasse-body" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: .15 }}>
      {selectedView === "CONTROL" ? <FiscalControlView control={control} currency={currency} onSelect={(tableId) => choose(catalog?.tables?.find((table: Loose) => table.id === tableId)?.views?.[0]?.id ?? tableId)} /> : !detail ? <div className="fiscal-ws-empty">Chargement du tableau…</div> : <>
        <header className="fiscal-ws-workpaper-head"><div><p className="fiscal-ws-kicker">TABLEAU {detail.definition.number} · {detail.definition.mode === "AUTOMATIC" ? "CALCULÉ" : detail.definition.mode === "HYBRID" ? "COMPTABLE + MANUEL" : "À COMPLÉTER"}</p><h2>{selectedLabel}</h2><p>Révision {detail.revision} · source {String(detail.sourceHash ?? "aucune").slice(0, 12)}… · {detail.stale ? "sources modifiées" : "sources à jour"}</p></div><span className={`fiscal-ws-workpaper-status ${detail.stale ? "stale" : detail.status.toLowerCase()}`}>{detail.stale ? "À recalculer" : detail.status === "REVIEWED" ? "Revu" : detail.status === "NOT_APPLICABLE" ? "Non applicable" : "Brouillon"}</span></header>
        {detail.notApplicableReason ? <div className="fiscal-ws-na-reason"><strong>Non applicable</strong><p>{detail.notApplicableReason}</p></div> : <>
          {visibleSections.map((section: Loose) => <div className="fiscal-ws-workpaper-section" key={section.id}><h3>{section.label}</h3><div className="fiscal-ws-table-wrap"><table className="fiscal-ws-table"><thead><tr>{section.columns.map((column: Loose) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>{(section.rows ?? []).map((row: Loose, index: number) => <tr key={row.key ?? row.code ?? row.id ?? index}>{section.columns.map((column: Loose) => <td key={column.key}>{formatCell(row[column.key], column.type)}</td>)}</tr>)}</tbody></table>{!section.rows?.length && <div className="fiscal-ws-empty">Aucune donnée comptable pour cet exercice.</div>}</div></div>)}
          {!visibleSections.length && <div className="fiscal-ws-empty fiscal"><FileSpreadsheet size={23} /><p>{detail.computed?.note ?? "Ce tableau doit être complété à partir des pièces du dossier."}</p></div>}
          <div className="fiscal-ws-manual-block"><div><p className="fiscal-ws-kicker">LIGNES DOCUMENTÉES</p><h3>{detail.definition.mode === "AUTOMATIC" ? "Corrections et compléments" : "Informations du dossier"}</h3></div><div className="fiscal-ws-table-wrap"><table className="fiscal-ws-table fiscal-ws-editable-table"><thead><tr>{detail.definition.manualColumns.map((column: Loose) => <th key={column.key}>{column.label}{column.required ? " *" : ""}</th>)}<th /></tr></thead><tbody>{manualRows.map((row) => <tr key={row.rowId}>{detail.definition.manualColumns.map((column: Loose) => <td key={column.key}><input aria-label={`${column.label} ligne ${manualRows.indexOf(row) + 1}`} type={column.type === "DATE" ? "date" : "text"} inputMode={["MONEY", "RATE", "INTEGER"].includes(column.type) ? "decimal" : undefined} value={row[column.key] ?? ""} disabled={detail.status !== "DRAFT"} onChange={(event) => { setManualRows((rows) => rows.map((item) => item.rowId === row.rowId ? { ...item, [column.key]: event.target.value } : item)); setDirty(true); }} /></td>)}<td><button type="button" aria-label="Supprimer la ligne" disabled={detail.status !== "DRAFT"} onClick={() => removeManualRow(row.rowId)}><Trash2 size={14} /></button></td></tr>)}</tbody></table>{!manualRows.length && <div className="fiscal-ws-empty">Aucune ligne manuelle.</div>}</div>{detail.status === "DRAFT" && <button type="button" className="fiscal-ws-add-row" onClick={addManualRow}><Plus size={14} /> Ajouter une ligne</button>}</div>
        </>}
        <div className="fiscal-ws-evidence-row"><div><p className="fiscal-ws-kicker">PIÈCES HASHÉES</p>{(detail.evidence ?? []).map((item: Loose) => <span key={item.id}><strong>{item.documentTitleSnapshot}</strong><small>{item.role} · {String(item.contentSha256Snapshot).slice(0, 12)}…</small>{detail.status === "DRAFT" && <button onClick={() => removeEvidence(item.id)} aria-label={`Retirer ${item.documentTitleSnapshot}`}>×</button>}</span>)}{!detail.evidence?.length && <small>Aucune pièce rattachée.</small>}</div>{detail.status === "DRAFT" && <div><WheatSelect
          ariaLabel="Document justificatif"
          placeholder="Sélectionner un document…"
          searchPlaceholder="Titre du document…"
          noOptionsLabel="Aucun document disponible"
          value={evidenceDocumentId}
          onChange={setEvidenceDocumentId}
          options={hashedDocuments.map((document: Loose): WheatSelectOption => ({
            value: String(document.id),
            label: String(document.title ?? document.id),
            note: document.type ? String(document.type) : undefined,
          }))}
        /><button onClick={attachEvidence} disabled={!evidenceDocumentId || busy}>Rattacher</button></div>}</div>
        {(detail.validation ?? []).filter((issue: Loose) => issue.severity === "BLOCKING").map((issue: Loose, index: number) => <p className="fiscal-ws-warning" key={`${issue.code}-${index}`}><AlertTriangle size={15} />{issue.message}</p>)}
        <footer className="fiscal-ws-workpaper-actions">{detail.status === "DRAFT" ? <><button onClick={refresh} disabled={busy}><RefreshCw size={15} /> Recalculer</button><button onClick={() => requestReason("NOT_APPLICABLE")} disabled={busy}>Non applicable</button><button onClick={save} disabled={busy || !dirty}>Enregistrer</button><button className="fiscal-ws-primary" onClick={review} disabled={busy || dirty || detail.stale}><CheckCircle2 size={15} /> Marquer revu</button></> : <button onClick={() => requestReason("REOPEN")} disabled={busy}>Réouvrir avec motif</button>}</footer>
      </>}
    </motion.div></AnimatePresence>
    {reasonAction && <div className="fiscal-ws-reason-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setReasonAction(null); }}>
      <div className="fiscal-ws-reason-dialog" role="dialog" aria-modal="true" aria-labelledby="fiscal-ws-reason-title" onKeyDown={(event) => { if (event.key === "Escape" && !busy) setReasonAction(null); }}>
        <p className="fiscal-ws-kicker">TRACE D'AUDIT Obligatoire</p>
        <h3 id="fiscal-ws-reason-title">{reasonAction === "NOT_APPLICABLE" ? "Documenter la non-applicabilité" : "Réouvrir le tableau"}</h3>
        <p>{reasonAction === "NOT_APPLICABLE" ? "Expliquez pourquoi ce tableau ne s'applique pas au dossier. Il restera visible dans le contrôle." : "Le tableau retournera en brouillon. Le motif sera conservé dans la piste d'audit."}</p>
        <label>{reasonAction === "NOT_APPLICABLE" ? "Motif de non-applicabilité" : "Motif de réouverture"}<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} rows={3} /></label>
        <div><button type="button" onClick={() => setReasonAction(null)} disabled={busy}>Annuler</button><button type="button" className="fiscal-ws-primary" onClick={() => void submitReason()} disabled={busy || reason.trim().length < 5}>{reasonAction === "NOT_APPLICABLE" ? "Confirmer la non-applicabilité" : "Confirmer la réouverture"}</button></div>
      </div>
    </div>}
  </section>;
}

function FiscalControlView({ control, currency, onSelect }: { control: Loose | null; currency: string; onSelect: (tableId: string) => void }) {
  if (!control) return <div className="fiscal-ws-empty">Calcul des contrôles…</div>;
  return <div className="fiscal-ws-control-grid"><section><p className="fiscal-ws-kicker">CONTRÔLES CROISÉS</p><h2>{control.preparationComplete ? "Dossier de préparation complet" : `${control.completed} tableaux complets sur ${control.total}`}</h2>{control.checks.map((check: Loose) => <div className={`fiscal-ws-control-check ${check.ok ? "ok" : "issue"}`} key={check.code}>{check.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span><strong>{check.label}</strong><small>{check.code === "TAXABLE_BRIDGE" ? cents(check.detail, currency) : check.detail}</small></span></div>)}<div className="fiscal-ws-guard"><Landmark size={18} /><div><strong>Export statutaire indisponible</strong><p>La complétude du dossier ne vaut pas validation DGI.</p></div></div></section><section className="fiscal-ws-control-list"><p className="fiscal-ws-kicker">25 TABLEAUX</p>{control.tables.map((table: Loose) => <button key={table.tableId} onClick={() => onSelect(table.tableId)}><span><b>{table.number}</b><strong>{table.label}</strong></span><small className={table.stale ? "stale" : table.status.toLowerCase()}>{table.stale ? "À recalculer" : table.status === "REVIEWED" ? "Revu" : table.status === "NOT_APPLICABLE" ? "N/A" : "Brouillon"}</small></button>)}</section></div>;
}

function bytes(value: unknown) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return "—";
  return amount >= 1024 ** 3 ? `${(amount / 1024 ** 3).toFixed(1)} Gio` : `${(amount / 1024 ** 2).toFixed(0)} Mio`;
}

type WheatAiMessage = {
  role: "user" | "assistant";
  content: string;
  contextSources?: string[];
  actionProposal?: Loose | null;
  actionProposals?: Loose[];
  actionResults?: Loose[];
  actionStatus?: "PENDING" | "EXECUTED" | "CANCELLED" | "DRY_RUN" | "FAILED";
};

function proposalConfirmationText(proposal: Loose) {
  const preview = proposal.preview as Loose | undefined;
  const changes = Array.isArray(preview?.changes) ? preview.changes.slice(0, 8).map((change: Loose) => {
    const before = typeof change.before === "object" ? JSON.stringify(change.before) : String(change.before ?? "—");
    const after = typeof change.after === "object" ? JSON.stringify(change.after) : String(change.after ?? "—");
    return `${change.label ?? change.field}: ${before} → ${after}`;
  }) : [];
  const warnings = Array.isArray(preview?.warnings) ? preview.warnings.slice(0, 4).map((warning: unknown) => `• ${String(warning)}`) : [];
  return [proposal.label, preview?.target ? `Cible : ${preview.target}` : "", ...changes, ...warnings, "Confirmer l'exécution dans Wheat ?"].filter(Boolean).join("\n\n");
}

function WheatAiActionCard({ proposal, busy, onResolve }: { proposal: Loose; busy: boolean; onResolve: (proposalId: string, execute: boolean) => void }) {
  const preview = proposal.preview as Loose | undefined;
  const changes = Array.isArray(preview?.changes) ? preview.changes.slice(0, 10) : [];
  const warnings = Array.isArray(preview?.warnings) ? preview.warnings.slice(0, 5) : [];
  const state = String(proposal.actionStatus ?? "PENDING");
  const statusLabel = state === "EXECUTED" ? "Exécutée et auditée" : state === "CANCELLED" ? "Proposition annulée" : state === "DRY_RUN" ? "Prévisualisation · aucune modification" : state === "FAILED" ? "Échec" : "En attente de votre confirmation";
  return <div className={`wheat-ai-proposal ${state.toLowerCase().replace("_", "-")}`}>
    <div className="wheat-ai-proposal-head"><strong>{proposal.label}</strong><span>Niveau {proposal.riskLevel ?? "—"}</span></div>
    <small>{statusLabel}</small>
    {preview?.target && <p className="wheat-ai-target">Cible · {String(preview.target)}</p>}
    {changes.length > 0 && <dl>{changes.map((change: Loose, index: number) => <div key={`${change.field ?? "change"}-${index}`}><dt>{String(change.label ?? change.field ?? "Modification")}</dt><dd><span>{typeof change.before === "object" ? JSON.stringify(change.before).slice(0, 180) : String(change.before ?? "—").slice(0, 180)}</span><b>→</b><span>{typeof change.after === "object" ? JSON.stringify(change.after).slice(0, 240) : String(change.after ?? "—").slice(0, 240)}</span></dd></div>)}</dl>}
    {warnings.length > 0 && <ul>{warnings.map((warning: unknown, index: number) => <li key={index}>{String(warning)}</li>)}</ul>}
    {state === "PENDING" && <div className="wheat-ai-proposal-actions"><button type="button" onClick={() => onResolve(String(proposal.id), false)} disabled={busy}>Annuler</button><button type="button" className="fiscal-ws-primary" onClick={() => onResolve(String(proposal.id), true)} disabled={busy}>Vérifier et confirmer</button></div>}
  </div>;
}

function WheatAiResultCard({ item, onNavigate }: { item: Loose; onNavigate?: (target: string, entityId?: string | null) => void }) {
  const status = String(item.status ?? "SUCCEEDED");
  const navigation = item.result?.navigation as Loose | undefined;
  const affected = Array.isArray(item.affectedRecords) ? item.affectedRecords : [];
  const category = String(item.capabilityId ?? "").split(".")[0];
  const affectedTarget: Record<string, string> = { accounts: "settings", journals: "settings", "fiscal-years": "settings", company: "settings", settings: "settings", entries: "entries", subledger: "invoices", invoices: "invoices", payments: "invoices", banking: "banking", documents: "documents", vat: "vat", fiscal: "fiscal", imports: "entries", payroll: "entries" };
  const viewTarget = navigation?.target ? String(navigation.target) : affected[0] && affectedTarget[category];
  const viewEntityId = navigation?.entityId ? String(navigation.entityId) : affected[0]?.id ? String(affected[0].id) : null;
  return <div className={`wheat-ai-result ${status.toLowerCase()}`}>
    <span>{status === "SUCCEEDED" ? <CheckCircle2 size={15} /> : status === "DRY_RUN" || status === "PENDING_CONFIRMATION" ? <Sparkles size={15} /> : <AlertTriangle size={15} />}</span>
    <div><strong>{String(item.capabilityId ?? "Action Wheat AI")}</strong><small>{status === "SUCCEEDED" ? "Terminée" : status === "PENDING_CONFIRMATION" ? "Confirmation requise" : status === "DRY_RUN" ? "Prévisualisée" : String(item.error ?? "Action non exécutée")}</small>{affected.slice(0, 4).map((record: Loose, index: number) => <p key={index}>{String(record.label ?? record.id ?? "Enregistrement affecté")}</p>)}</div>
    {viewTarget && onNavigate && <button type="button" onClick={() => onNavigate(viewTarget, viewEntityId)}>Ouvrir</button>}
  </div>;
}

function WheatAiPanel({ company, onChanged, onNotify, onNavigate }: FiscalWorkspaceProps & { onNavigate?: (target: string, entityId?: string | null) => void }) {
  const [status, setStatus] = useState<Loose | null>(null);
  const [progress, setProgress] = useState<Loose | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatPending, setChatPending] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<WheatAiMessage[]>([]);
  const load = async () => { try { setStatus(await api().getWheatAiStatus({ companyId: company.id })); } catch (error) { onNotify?.(message(error), "error"); } };
  useEffect(() => {
    void load();
    const remove = api().onWheatAiProgress?.((payload: Loose) => setProgress(payload));
    return () => remove?.();
  }, [company.id]);
  const availableModels = (status?.models ?? []).filter((model: Loose) => model.installed && model.chatReady);
  const recommended = status?.models?.find((model: Loose) => model.id === status?.recommendation?.modelId);
  const selected = status?.models?.find((model: Loose) => model.id === status?.settings?.selectedModelId);
  // The keys are persisted provider codes; the values are the labels the user
// actually sees. "ATLAS" is the historical code for Wheat's own bundled model
// artefacts and is never displayed.
const providerLabel = (provider: string) => ({ OLLAMA: "Ollama", HUGGINGFACE: "Hugging Face · GGUF", ATLAS: "Modèle vérifié Wheat", OPENROUTER: "OpenRouter (gratuit)", GROQ: "Groq (gratuit)" }[provider] ?? provider);
  const install = async () => {
    if (!recommended || !confirmWithAppFocus(`Télécharger ${recommended.displayName} (${bytes(recommended.bytes)}) et le moteur local vérifié ?`)) return;
    setBusy(true);
    try { await api().installWheatAiModel({ companyId: company.id, modelId: recommended.id, confirmed: true }); onNotify?.("Modèle local installé et vérifié.", "success"); await load(); }
    catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const chooseModel = async (modelId: string) => {
    setBusy(true);
    try {
      await api().selectWheatAiModel({ companyId: company.id, modelId });
      await load();
      setMessages([]);
      onNotify?.(modelId ? "Modèle Wheat AI activé." : "Modèle Wheat AI désélectionné.", "success");
    } catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const uninstall = async () => {
    if (!selected) return;
    if (!selected.removable) {
      await chooseModel("");
      onNotify?.("Le fichier Hugging Face partagé reste géré par son cache officiel.", "info");
      return;
    }
    if (!confirmWithAppFocus(`Supprimer définitivement ${selected.displayName} de cet ordinateur ? Cette action libérera son espace disque et devra être retéléchargée pour être annulée.`)) return;
    setBusy(true);
    try { await api().uninstallWheatAiModel({ companyId: company.id, modelId: selected.id, confirmed: true, permanent: true }); onNotify?.("Modèle supprimé du disque.", "success"); setMessages([]); await load(); }
    catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const benchmark = async () => {
    setBusy(true);
    try { const result = await api().benchmarkWheatAi({ companyId: company.id, modelId: selected?.id }); onNotify?.(`Test d'inférence réussi avec ${selected?.displayName} en ${(Number(result.durationMs ?? 0) / 1000).toFixed(1)} s.`, "success"); await load(); }
    catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  const permission = async (mode: string) => {
    const confirmed = mode !== "AUTOMATED" || confirmWithAppFocus("Activer le mode automatisé borné ? Les actions de niveaux 1 et 2 explicitement demandées pourront s'exécuter immédiatement. Les actions de niveau 3 exigeront toujours votre confirmation finale.");
    if (!confirmed) return;
    try { await api().configureWheatAi({ companyId: company.id, permissionMode: mode, confirmed }); await load(); onNotify?.("Permissions Wheat AI mises à jour.", "success"); }
    catch (error) { onNotify?.(message(error), "error"); }
  };
  const chat = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !selected?.chatReady || chatPending) return;
    const submittedPrompt = prompt.trim();
    const priorMessages = messages;
    const next = [...messages, { role: "user" as const, content: submittedPrompt }];
    setMessages(next); setPrompt(""); setBusy(true); setChatPending(true);
    try {
      const result = await api().chatWithWheatAi({ companyId: company.id, modelId: selected.id, messages: next, applicationContext: { module: "wheat-ai" } });
      const proposals = (Array.isArray(result.actionProposals) ? result.actionProposals : result.actionProposal ? [result.actionProposal] : []).map((proposal: Loose) => ({ ...proposal, actionStatus: proposal.actionStatus ?? (proposal.dryRun ? "DRY_RUN" : "PENDING") }));
      setMessages([...next, { role: "assistant", content: result.text, contextSources: result.contextSources, actionProposal: proposals[0] ?? null, actionProposals: proposals, actionResults: result.actionResults }]);
      if ((result.actionResults ?? []).some((item: Loose) => item.status === "SUCCEEDED" && item.capabilityId !== "navigation.open")) await onChanged?.();
    }
    catch (error) { setMessages(priorMessages); setPrompt(submittedPrompt); onNotify?.(message(error), "error"); }
    finally { setChatPending(false); setBusy(false); }
  };
  const resolveAction = async (proposalId: string, execute: boolean) => {
    const proposal = messages.flatMap((candidate) => candidate.actionProposals ?? (candidate.actionProposal ? [candidate.actionProposal] : [])).find((candidate) => candidate.id === proposalId);
    if (!proposal || String(proposal.actionStatus ?? "PENDING") !== "PENDING") return;
    if (execute && !confirmWithAppFocus(proposalConfirmationText(proposal))) return;
    setBusy(true);
    try {
      const result = execute
        ? await api().confirmWheatAiAction({ companyId: company.id, proposalId, confirmed: true })
        : await api().cancelWheatAiAction({ companyId: company.id, proposalId });
      setMessages((current) => current.map((candidate) => {
        const proposals = (candidate.actionProposals ?? (candidate.actionProposal ? [candidate.actionProposal] : [])).map((currentProposal) => currentProposal.id === proposalId ? { ...currentProposal, actionStatus: execute ? "EXECUTED" : "CANCELLED" } : currentProposal);
        return proposals.some((currentProposal) => currentProposal.id === proposalId) ? { ...candidate, content: execute ? `${candidate.content}\n\n${result.text}` : candidate.content, actionProposal: proposals[0] ?? null, actionProposals: proposals } : candidate;
      }));
      if (execute) await onChanged?.();
      onNotify?.(execute ? "Action Wheat AI exécutée et auditée." : "Proposition Wheat AI annulée.", execute ? "success" : "info");
    } catch (error) { onNotify?.(message(error), "error"); }
    finally { setBusy(false); }
  };
  if (!status) {
    return <LoadingState label="Analyse du materiel de ce poste et des modèles disponibles…" rows={3} />;
  }

  const percent = progress ? Math.min(100, Math.round(Number(progress.receivedBytes ?? 0) / Number(progress.totalBytes ?? 1) * 100)) : 0;

  const modelOptions: WheatSelectOption[] = availableModels.map((model: Loose): WheatSelectOption => ({
    value: String(model.id),
    label: String(model.displayName),
    note: [providerLabel(String(model.provider)), model.sizeLabel ?? (model.bytes ? bytes(model.bytes) : undefined)].filter(Boolean).join(" · "),
    group: providerLabel(String(model.provider)),
    keywords: String(model.notes ?? ""),
  }));

  const permissionOptions: WheatSelectOption[] = [
    { value: "READ_ONLY", label: "Lecture seule", note: "Wheat AI répond et explique, sans jamais modifier le dossier" },
    { value: "ASSISTANT", label: "Assistant", note: "Recommande : chaque action est proposee puis confirmée par vous" },
    { value: "AUTOMATED", label: "Automatise (borné)", note: "Les actions a faible risque s'exécutent seules ; les autres restent confirmées" },
  ];

  const starters = [
    "Quel est le total des factures impayées ?",
    "Créé le compte 61234 nomme Honoraires comptables",
    "Montre ce que tu ferais avant de comptabiliser",
    "Prepare la TVA et liste les points bloquants",
  ];

  return (
    <div className="fiscal-ws-pane wheat-ai-layout wt-split">
      <div className="wt-stack">
        <Card
          title="Modèle utilisé"
          note="Wheat AI s'appuie sur un modèle de langage. Il peut tourner sur ce poste, ou chez un fournisseur gratuit configure dans Réglages."
          icon={<Cpu size={18} aria-hidden="true" />}
          actions={<Badge tone={selected?.chatReady ? "success" : "warning"} dot>{selected?.chatReady ? "Pret" : "A configurer"}</Badge>}
        >
          <Field
            label="Modèle actif"
            htmlFor="wheat-ai-model-picker"
            hint="« Automatique — modèles gratuits » utilisé le fournisseur distant configure dans Réglages."
          >
            <WheatSelect
              id="wheat-ai-model-picker"
              ariaLabel="Modèle Wheat AI"
              placeholder="Sélectionner un modèle"
              searchPlaceholder="Nom du modèle…"
              noOptionsLabel="Aucun modèle disponible sur ce poste"
              value={selected?.id ?? ""}
              disabled={busy}
              onChange={(value) => void chooseModel(value)}
              options={modelOptions}
            />
          </Field>

          {progress && progress.phase !== "READY" && (
            <div className="wt-meter">
              <div className="wt-meter__head">
                <span>{String(progress.phase)}</span>
                <strong>{bytes(progress.receivedBytes)} / {bytes(progress.totalBytes)}</strong>
              </div>
              <div className="wt-meter__track"><div className="wt-meter__fill" style={{ width: `${percent}%` }} /></div>
            </div>
          )}

          <dl className="wt-kv">
            <div><dt>Processeur</dt><dd>{status.profile.cpu}</dd></div>
            <div><dt>Memoire</dt><dd>{bytes(status.profile.totalRamBytes)} · {bytes(status.profile.freeRamBytes)} libres</dd></div>
            <div><dt>Ollama</dt><dd>{status.providers?.ollama?.available ? `${status.providers.ollama.modelCount} modèle(s)` : "indisponible"}</dd></div>
            <div><dt>Hugging Face</dt><dd>{status.providers?.huggingFace?.compatibleGgufCount ?? 0} GGUF compatible(s)</dd></div>
            <div><dt>Moteur local</dt><dd>llama.cpp {status.runtime.version} · {status.runtime.installed ? "installé" : "à installer"}</dd></div>
          </dl>

          <div className="wt-row">
            {recommended?.installed ? (
              <Button variant="soft" disabled icon={<CheckCircle2 size={15} />}>Modèle recommandé déjà installé</Button>
            ) : (
              <Button variant="primary" icon={<Download size={15} />} busy={busy} onClick={install}>Installer le modèle recommandé</Button>
            )}
            <Button variant="secondary" icon={<Cpu size={15} />} disabled={busy || !selected?.chatReady} onClick={benchmark}>Tester le modèle</Button>
            {selected?.installed && selected.removable && (
              <Button variant="danger-outline" icon={<Trash2 size={15} />} disabled={busy} onClick={uninstall}>Supprimer du disque</Button>
            )}
            <Button variant="ghost" icon={<RefreshCw size={15} />} disabled={busy} onClick={load}>Rechercher les modèles</Button>
          </div>

          <HelpDisclosure summary="Provenance, capacités et sécurité">
            <p>Profil produit : {status.productKnowledgeVersion ?? "versionne avec l'application"}.</p>
            <p>
              {status.capabilityRegistry?.total ?? status.confirmedMutationCapabilities?.length ?? 0} capacités typees dans{" "}
              {status.capabilityRegistry?.catégories?.length ?? 0} modules, dont {status.capabilityRegistry?.dryRunCount ?? 0} avec previsualisation.
            </p>
            <p>Recommandation : {recommended?.displayName}. {status.recommendation?.reason}</p>
            <p>Les modèles Ollama passent par l'API locale 127.0.0.1. Seuls les fichiers GGUF du cache Hugging Face peuvent être lances directement par llama.cpp.</p>
          </HelpDisclosure>
        </Card>

        <Card
          title="Ce que Wheat AI a le droit de faire"
          note="Le niveau d'autorisation decide si une action est proposee ou exécutée directement."
          icon={<Lock size={18} aria-hidden="true" />}
        >
          <Field label="Niveau d'autorisation" htmlFor="wheat-ai-permission">
            <WheatSelect
              id="wheat-ai-permission"
              ariaLabel="Permissions Wheat AI"
              value={status.settings?.permissionMode ?? "ASSISTANT"}
              onChange={(value) => void permission(value)}
              options={permissionOptions}
              searchable={false}
            />
          </Field>
          <Callout tone="info" icon={<ShieldCheck size={17} />} title="Une action n'est jamais silencieuse">
            Wheat AI ne peut appeler que des <strong>capacités typees</strong> déclarées par Wheat, jamais la base directement. Toute action a risque élevé exige votre confirmation, quel que soit le niveau choisi.
          </Callout>
        </Card>
      </div>

      <Card
        title="Conversation"
        note="Posez votre question en francais. Wheat AI cite ses sources et propose les actions au lieu de les exécuter."
        icon={<WheatAiMark size={20} />}
        flush
      >
        <div className="fiscal-ws-messages wheat-ai-chat" aria-live="polite">
          {messages.length || chatPending ? (
            <>
              {messages.map((item, index) => (
                <div key={index} className={item.role}>
                  <small>{item.role === "user" ? "Vous" : `Wheat AI · ${selected?.displayName ?? "modèle local"}`}</small>
                  <p>{item.content}</p>
                  {item.contextSources?.length ? (
                    <div className="wheat-ai-sources" aria-label="Sources utilisées">
                      {item.contextSources.slice(0, 5).map((source) => <span key={source}>{source}</span>)}
                    </div>
                  ) : null}
                  {item.actionResults?.length ? (
                    <div className="wheat-ai-results">
                      {item.actionResults.map((result, resultIndex) => (
                        <WheatAiResultCard key={`${result.capabilityId ?? "result"}-${resultIndex}`} item={result} onNavigate={onNavigate} />
                      ))}
                    </div>
                  ) : null}
                  {(item.actionProposals ?? (item.actionProposal ? [item.actionProposal] : [])).map((proposal) => (
                    <WheatAiActionCard key={String(proposal.id)} proposal={proposal} busy={busy} onResolve={(id, execute) => void resolveAction(id, execute)} />
                  ))}
                </div>
              ))}
              {chatPending && (
                <div className="assistant thinking" role="status">
                  <small>Wheat AI</small>
                  <p>Analyse du contexte du dossier et des capacités autorisees…</p>
                </div>
              )}
            </>
          ) : (
            <div className="wheat-ai-welcome">
              <EmptyState
                icon={<WheatAiMark size={26} />}
                title={selected?.chatReady ? "Posez votre première question" : "Choisissez d'abord un modèle"}
                text={
                  selected?.chatReady
                    ? "Wheat AI connait le dossier ouvert : ses comptes, ses écritures, ses factures et sa TVA. Il répond, explique, et prépare les actions que vous confirmez."
                    : availableModels.length
                      ? "Sélectionnez un modèle dans la liste à gauche. Vous pouvez déjà écrire votre demande."
                      : "Aucun modèle n'est disponible sur ce poste. Installez-en un, ou ajoutez une clé OpenRouter / Groq dans Réglages > Wheat AI."
                }
              />
              <div className="wt-row" style={{ justifyContent: "center", padding: "0 var(--space-6) var(--space-6)" }}>
                {starters.map((starter) => (
                  <button type="button" key={starter} className="wt-chip" onClick={() => setPrompt(starter)}>{starter}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        <form onSubmit={chat} className="wt-card__foot">
          <textarea
            className="wt-textarea"
            aria-label="Votre question a Wheat AI"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={chatPending}
            placeholder={selected?.chatReady ? "Ex. : Créé un brouillon d'achat équilibre pour la facture FR-2026-014…" : "Ecrivez votre demande, puis choisissez un modèle…"}
            rows={3}
            style={{ flex: "1 1 auto" }}
          />
          <Button type="submit" variant="primary" icon={<Send size={15} />} busy={chatPending} disabled={!selected?.chatReady || !prompt.trim()}>
            Envoyer
          </Button>
        </form>
      </Card>
    </div>
  );
}

export function WheatAiWorkspace({ company, onChanged, onNotify, onNavigate }: FiscalWorkspaceProps & { onNavigate?: (target: string, entityId?: string | null) => void }) {
  return (
    <section className="wheat-ai-workspace wt-stack" aria-label="Wheat AI">
      <Explainer icon={<WheatAiMark size={18} />}>
        <strong>Wheat AI travaille sur {company.name}.</strong> Il lit le dossier ouvert, cite ses sources et prépare les actions
        au lieu de les exécuter : vous gardez la dernière decision sur chaque écriture.
      </Explainer>
      <WheatAiPanel company={company} onChanged={onChanged} onNotify={onNotify} onNavigate={onNavigate} />
    </section>
  );
}

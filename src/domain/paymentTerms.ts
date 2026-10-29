/**
 * CONDIÇÕES DE PAGAMENTO da proforma: estruturadas (% antecipado + quando se paga o saldo) para saírem
 * escritas no idioma do PDF (pt/es/en), mais uma nota livre opcional (sai como digitada).
 */
export type BalanceWhen = 'BEFORE_SHIPMENT' | 'AGAINST_DOCS' | 'ON_ARRIVAL' | 'DAYS_AFTER_SHIPMENT' | 'DAYS_AFTER_INVOICE' | 'LC_AT_SIGHT'

export interface PaymentTerms {
  /** % antecipado (0–100) */
  advancePct: number
  /** quando se paga o saldo (ignorado com 100% antecipado) */
  balanceWhen: BalanceWhen | null
  /** dias (para DAYS_AFTER_*) */
  days?: number | null
  /** nota livre (sai como digitada, sem tradução) */
  note?: string | null
}

export type TermsLang = 'pt' | 'es' | 'en'

export const BALANCE_WHEN_OPTIONS: BalanceWhen[] = ['BEFORE_SHIPMENT', 'AGAINST_DOCS', 'ON_ARRIVAL', 'DAYS_AFTER_SHIPMENT', 'DAYS_AFTER_INVOICE', 'LC_AT_SIGHT']

const WHEN: Record<TermsLang, Record<BalanceWhen, (days: number) => string>> = {
  pt: {
    BEFORE_SHIPMENT: () => 'antes do embarque',
    AGAINST_DOCS: () => 'contra cópia dos documentos de embarque (BL)',
    ON_ARRIVAL: () => 'na chegada da mercadoria ao destino',
    DAYS_AFTER_SHIPMENT: (d) => `a ${d} dias da data de embarque`,
    DAYS_AFTER_INVOICE: (d) => `a ${d} dias da data da fatura`,
    LC_AT_SIGHT: () => 'por carta de crédito à vista',
  },
  es: {
    BEFORE_SHIPMENT: () => 'antes del embarque',
    AGAINST_DOCS: () => 'contra copia de los documentos de embarque (BL)',
    ON_ARRIVAL: () => 'a la llegada de la mercadería a destino',
    DAYS_AFTER_SHIPMENT: (d) => `a ${d} días de la fecha de embarque`,
    DAYS_AFTER_INVOICE: (d) => `a ${d} días de la fecha de factura`,
    LC_AT_SIGHT: () => 'mediante carta de crédito a la vista',
  },
  en: {
    BEFORE_SHIPMENT: () => 'before shipment',
    AGAINST_DOCS: () => 'against copy of shipping documents (B/L)',
    ON_ARRIVAL: () => 'upon arrival of the goods at destination',
    DAYS_AFTER_SHIPMENT: (d) => `${d} days after shipment date`,
    DAYS_AFTER_INVOICE: (d) => `${d} days after invoice date`,
    LC_AT_SIGHT: () => 'by letter of credit at sight',
  },
}
const ADVANCE: Record<TermsLang, { full: string; part: (a: string, rest: string, when: string) => string; none: (when: string) => string }> = {
  pt: { full: '100% antecipado', part: (a, r, w) => `${a}% antecipado e ${r}% ${w}`, none: (w) => `100% ${w}` },
  es: { full: '100% anticipado', part: (a, r, w) => `${a}% de anticipo y ${r}% ${w}`, none: (w) => `100% ${w}` },
  en: { full: '100% advance payment', part: (a, r, w) => `${a}% advance payment and ${r}% ${w}`, none: (w) => `100% ${w}` },
}

/** Rótulo da opção "quando o saldo" (para a tela, em português). */
export const balanceWhenLabel = (w: BalanceWhen) => WHEN.pt[w](0).replace('a 0 dias', 'a N dias')

const pctTxt = (n: number, lang: TermsLang) => (Number.isInteger(n) ? String(n) : n.toLocaleString(lang === 'en' ? 'en-US' : lang === 'es' ? 'es-AR' : 'pt-BR', { maximumFractionDigits: 2 }))

/** Problemas da condição (vazio = válida). */
export function paymentTermsErrors(t: PaymentTerms): string[] {
  const e: string[] = []
  if (!Number.isFinite(t.advancePct) || t.advancePct < 0 || t.advancePct > 100) e.push('% antecipado deve estar entre 0 e 100.')
  if (t.advancePct < 100 && !t.balanceWhen) e.push('Informe quando se paga o saldo.')
  if (t.balanceWhen && !BALANCE_WHEN_OPTIONS.includes(t.balanceWhen)) e.push('Condição de saldo inválida.')
  if (t.balanceWhen && t.balanceWhen.startsWith('DAYS_') && t.advancePct < 100 && !(t.days != null && Number.isInteger(t.days) && t.days > 0 && t.days <= 720)) e.push('Informe o número de dias (1 a 720).')
  if (t.note && t.note.length > 300) e.push('Nota com no máximo 300 caracteres.')
  return e
}

/** número digitado ("30", "12,5") ou já numérico; vazio/ausente → NaN (acusado por paymentTermsErrors) */
const toNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim().replace(',', '.')) : NaN)

/**
 * Condição vinda da tela, do formulário (JSON) ou da IA → forma gravada, IGUAL em todos os caminhos (criação,
 * pedido por IA, divisão em unidades e painel da carga): { advancePct, balanceWhen, days, note }.
 * 100% antecipado → sem saldo (balanceWhen null); dias só para "a N dias" com saldo; nota aparada (vazia → null).
 * Valores inválidos NÃO são corrigidos aqui: passam para paymentTermsErrors acusar. Ausente/não-objeto → null.
 */
export function normalizePaymentTerms(raw: unknown): PaymentTerms | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const advancePct = toNum(t.advancePct)
  const bw = t.balanceWhen == null || t.balanceWhen === '' ? null : (String(t.balanceWhen) as BalanceWhen)
  const balanceWhen = advancePct >= 100 ? null : bw
  const d = toNum(t.days)
  const days = balanceWhen?.startsWith('DAYS_') && Number.isFinite(d) ? d : null
  const note = t.note == null ? null : String(t.note).trim() || null
  return { advancePct, balanceWhen, days, note }
}

/** Normaliza e valida (servidor): condição pronta para gravar (null = sem condição) ou o erro para a tela. */
export function checkPaymentTerms(raw: unknown): { ok: true; terms: PaymentTerms | null } | { ok: false; error: string } {
  const terms = normalizePaymentTerms(raw)
  if (!terms) return { ok: true, terms: null }
  const errs = paymentTermsErrors(terms)
  return errs.length ? { ok: false, error: `Condição de pagamento: ${errs.join(' ')}` } : { ok: true, terms }
}

/**
 * Esquema (JSON Schema) da condição para as ferramentas da IA — o mesmo do assistente da lista de preços:
 * % antecipado, quando se paga o saldo (BALANCE_WHEN_OPTIONS), dias (só DAYS_*) e nota livre.
 */
export const PAYMENT_TERMS_AI_SCHEMA = {
  type: 'object',
  properties: { advance_pct: { type: 'number', minimum: 0, maximum: 100 }, balance_when: { type: 'string', enum: BALANCE_WHEN_OPTIONS }, days: { type: 'integer', minimum: 1, maximum: 720 }, note: { type: 'string', maxLength: 300 } },
  required: ['advance_pct'],
  additionalProperties: false,
}

/** texto da IA para explicar as opções de balance_when (em <dados> / no prompt) */
export const BALANCE_WHEN_AI_HELP =
  'BEFORE_SHIPMENT (antes do embarque), AGAINST_DOCS (contra cópia dos documentos/BL), ON_ARRIVAL (na chegada), DAYS_AFTER_SHIPMENT (N dias após o embarque), DAYS_AFTER_INVOICE (N dias após a fatura), LC_AT_SIGHT (carta de crédito à vista)'

/** Saída da IA ({ advance_pct, balance_when, days, note }) → condição (null se não houver % antecipado). Validar depois. */
export function paymentTermsFromAi(p: { advance_pct?: unknown; balance_when?: unknown; days?: unknown; note?: unknown } | null | undefined): PaymentTerms | null {
  if (!p || typeof p.advance_pct !== 'number' || !Number.isFinite(p.advance_pct)) return null
  const adv = Math.min(100, Math.max(0, p.advance_pct))
  const bw = BALANCE_WHEN_OPTIONS.find((w) => w === p.balance_when) ?? null
  return normalizePaymentTerms({ advancePct: adv, balanceWhen: bw, days: typeof p.days === 'number' ? Math.round(p.days) : null, note: typeof p.note === 'string' ? p.note.slice(0, 300) : null })
}

/** Texto da condição de pagamento no idioma (ex.: "30% de anticipo y 70% antes del embarque"). */
export function paymentTermsText(t: PaymentTerms | null | undefined, lang: TermsLang): string | null {
  if (!t) return null
  const note = t.note?.trim() || null
  let main: string | null = null
  if (t.advancePct >= 100) main = ADVANCE[lang].full
  else if (t.balanceWhen && WHEN[lang][t.balanceWhen]) {
    const when = WHEN[lang][t.balanceWhen](t.days ?? 0)
    main = t.advancePct > 0 ? ADVANCE[lang].part(pctTxt(t.advancePct, lang), pctTxt(Math.round((100 - t.advancePct) * 100) / 100, lang), when) : ADVANCE[lang].none(when)
  }
  return [main, note].filter(Boolean).join('. ') || null
}

/**
 * Valor em dinheiro digitado (pt-BR/es): "3.200" = 3200 (ponto de milhar), "3.200,50" = 3200,5,
 * "1,5" = 1,5. Formato inglês ("3200.5", "2,350.00") → NaN (recusado). Vazio → null.
 */
export function parseMoney(v: string | null | undefined): number | null {
  // FORMATO BRASILEIRO: ponto separa os milhares e vírgula os decimais ("2.350,00"). Outro formato
  // (ex.: "2,350.00" ou "3200.5") é recusado (NaN) para não gravar um valor errado sem aviso.
  const t = String(v ?? '').trim().replace(/\s|USD|US\$|\$/gi, '')
  if (!t) return null
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(t) && !/^\d+(,\d{1,2})?$/.test(t)) return NaN
  const n = Number(t.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

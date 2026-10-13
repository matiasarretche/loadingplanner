/**
 * REGRAS LOGÍSTICAS CENTRALIZADAS (configuração única; não repetir estas condições em outros lugares).
 *
 * Cada regra casa por modalidade e/ou destino e define o que muda: palete padrão e/ou peso bruto
 * máximo da CARGA (mercadoria + paletes; NÃO inclui a tara do veículo/contêiner).
 *
 * Precedência: modalidade → destino → regra específica → padrão geral. As regras são aplicadas da
 * MENOS para a MAIS específica, e a mais específica prevalece em cada campo que define.
 * Para incluir outro país/rota, basta acrescentar uma linha em LOGISTICS_RULES.
 */
import type { LimitSnapshot } from './types'

/** Modalidade comercial (independente do equipamento escolhido). */
export type LogisticsMode = 'SEA' | 'ROAD' | 'AIR'

export interface LogisticsContext {
  mode: LogisticsMode
  /** país de destino como digitado ("Uruguay", "Estados Unidos", "USA", "BR"…) */
  destination: string | null | undefined
  /** país de origem (padrão: Brasil) */
  origin?: string
}

export interface LogisticsRule {
  id: string
  description: string
  match: {
    mode?: LogisticsMode
    /** códigos ISO-2 de destino */
    destination?: string[]
    /** transporte interno: destino = origem */
    domestic?: boolean
  }
  set: {
    /** códigos de palete aceitos, em ordem de preferência (o 1º é o padrão) */
    palletTypeCodes?: string[]
    /** peso bruto máximo da carga (kg) */
    maxCargoKg?: number
  }
}

export const DEFAULT_ORIGIN = 'BR'

/**
 * Altura máxima das MONTAGENS DE REFERÊNCIA com acompanhante por cima (ex.: Hydroforce + kits):
 * a mais restritiva dos contêineres padrão (porta do 20GP/40GP = 2.292 mm), para o palete servir em qualquer um.
 */
export const REFERENCE_PALLET_MAX_HEIGHT_MM = 2292

/**
 * Porta do 40' HC (2.597 mm): o palete padrão do catálogo prevalece — se com os kits por cima ele passa
 * de 2.292 mm, a referência é montada até esta altura e marcada "só 40' HC / rodoviário".
 */
export const REFERENCE_PALLET_HC_HEIGHT_MM = 2597

export const LOGISTICS_RULES: LogisticsRule[] = [
  // ---- padrão por modalidade
  // peso bruto da CARGA (produto + embalagem + paletes); a tara do contêiner (3.700–3.900 kg) fica fora
  { id: 'sea-default', description: 'Marítimo: palete 1,15 × 1,15 m e peso bruto da carga até 27.000 kg (sem a tara do contêiner)', match: { mode: 'SEA' }, set: { palletTypeCodes: ['PCF-1150'], maxCargoKg: 27000 } },
  // ---- destino específico
  { id: 'sea-us', description: 'Marítimo para Estados Unidos: carga até 19.900 kg', match: { mode: 'SEA', destination: ['US'] }, set: { maxCargoKg: 19900 } },
  { id: 'road-br', description: 'Rodoviário interno (Brasil): carreta, palete 1,00 × 1,20 m e carga até 32.000 kg', match: { mode: 'ROAD', domestic: true }, set: { palletTypeCodes: ['PBR-1'], maxCargoKg: 32000 } },
  { id: 'road-uy', description: 'Rodoviário para Uruguai: carga até 28.000 kg', match: { mode: 'ROAD', destination: ['UY'] }, set: { maxCargoKg: 28000 } },
]

// ---------------------------------------------------------------------------
// Países
// ---------------------------------------------------------------------------

const COUNTRY_ALIASES: Record<string, string[]> = {
  BR: ['brasil', 'brazil', 'br', 'bra'],
  US: ['estados unidos', 'eeuu', 'ee uu', 'eua', 'usa', 'us', 'united states', 'estados unidos da america', 'estados unidos de america'],
  UY: ['uruguai', 'uruguay', 'uy', 'ury'],
  AR: ['argentina', 'ar', 'arg'],
  PY: ['paraguai', 'paraguay', 'py', 'pry'],
  CL: ['chile', 'cl', 'chl'],
  BO: ['bolivia', 'bo', 'bol'],
  PE: ['peru', 'pe', 'per'],
  CO: ['colombia', 'co', 'col'],
  MX: ['mexico', 'mx', 'mex'],
  ET: ['etiopia', 'ethiopia', 'et', 'eth'],
  ZA: ['africa do sul', 'sudafrica', 'south africa', 'za'],
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Normaliza o texto do país para ISO-2 (null se desconhecido). */
export function countryCode(text: string | null | undefined): string | null {
  if (!text) return null
  const t = norm(text)
  if (!t) return null
  for (const [code, names] of Object.entries(COUNTRY_ALIASES)) if (names.includes(t)) return code
  return /^[a-z]{2}$/.test(t) ? t.toUpperCase() : null
}

// ---------------------------------------------------------------------------
// Resolução
// ---------------------------------------------------------------------------

export interface LogisticsResolution {
  context: { mode: LogisticsMode; destination: string | null; origin: string; domestic: boolean }
  palletTypeCodes: string[] | null
  maxCargoKg: number | null
  /** regras aplicadas, da mais geral para a mais específica */
  applied: { id: string; description: string }[]
  /** de onde veio cada valor */
  source: { pallet: string | null; maxCargoKg: string | null }
}

const specificity = (r: LogisticsRule) => (r.match.mode ? 1 : 0) + (r.match.destination || r.match.domestic != null ? 2 : 0)

export function resolveLogistics(ctx: LogisticsContext, rules: LogisticsRule[] = LOGISTICS_RULES): LogisticsResolution {
  const origin = countryCode(ctx.origin) ?? DEFAULT_ORIGIN
  const destination = countryCode(ctx.destination)
  const domestic = destination != null && destination === origin
  const matches = rules
    .filter((r) => {
      if (r.match.mode && r.match.mode !== ctx.mode) return false
      if (r.match.destination && (!destination || !r.match.destination.includes(destination))) return false
      if (r.match.domestic != null && r.match.domestic !== domestic) return false
      return true
    })
    .map((r, i) => ({ r, i }))
    .sort((a, b) => specificity(a.r) - specificity(b.r) || a.i - b.i)
    .map((x) => x.r)
  const out: LogisticsResolution = {
    context: { mode: ctx.mode, destination, origin, domestic },
    palletTypeCodes: null,
    maxCargoKg: null,
    applied: [],
    source: { pallet: null, maxCargoKg: null },
  }
  for (const r of matches) {
    out.applied.push({ id: r.id, description: r.description })
    if (r.set.palletTypeCodes) {
      out.palletTypeCodes = r.set.palletTypeCodes
      out.source.pallet = r.id
    }
    if (r.set.maxCargoKg != null) {
      out.maxCargoKg = r.set.maxCargoKg
      out.source.maxCargoKg = r.id
    }
  }
  return out
}

/** Id fixo do limite gerado pela regra (para reconhecer e atualizar o snapshot na carga). */
export const RULE_LIMIT_PROFILE_ID = -100

/** Limite de carga da regra no formato dos perfis de restrição (payload = peso bruto da carga). */
export function ruleLimitSnapshot(res: LogisticsResolution): LimitSnapshot | null {
  if (res.maxCargoKg == null) return null
  const rule = res.applied.find((a) => a.id === res.source.maxCargoKg)
  return {
    profileId: RULE_LIMIT_PROFILE_ID,
    name: `Regra logística: ${rule?.description ?? `carga até ${res.maxCargoKg} kg`}`,
    scope: 'ROUTE',
    maxPayloadKg: res.maxCargoKg,
    maxGrossKg: null,
    maxHeightMm: null,
    minSupportPct: null,
    cgLongTolPct: null,
    cgLatTolPct: null,
    lowUtilPct: null,
  }
}

/** Aplica (ou atualiza) o limite da regra na lista de limites da carga. */
export function withRuleLimit(limits: LimitSnapshot[], res: LogisticsResolution): LimitSnapshot[] {
  const snap = ruleLimitSnapshot(res)
  const rest = limits.filter((l) => l.profileId !== RULE_LIMIT_PROFILE_ID)
  return snap ? [...rest, snap] : rest
}

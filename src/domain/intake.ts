/**
 * PEDIDO DO CLIENTE → interpretação revisável (sem IA aqui: tipos, dados faltantes e conversão de
 * quantidades). A IA só EXTRAI o que está escrito; tudo que falta é perguntado ao usuário, nunca assumido.
 */
import type { PackSnapshot } from './types'
import { isService, serviceFromMode, TYPE_INFO } from './shipmentType'

/** Unidade em que o cliente pediu a quantidade. */
export type QtyUnit = 'UNIT' | 'BOX' | 'PALLET' | 'KG' | 'OTHER'
export const QTY_UNIT_LABEL: Record<QtyUnit, string> = {
  UNIT: 'unidades',
  BOX: 'caixas',
  PALLET: 'paletes completos',
  KG: 'kg',
  OTHER: 'outra (definir)',
}

export type LineStatus = 'MATCHED' | 'AMBIGUOUS' | 'NOT_FOUND'

export interface IntakeCandidate {
  sku: string
  name: string
}

export interface IntakeLine {
  /** texto do cliente (como está no documento) */
  sourceText: string
  quantity: number | null
  unit: QtyUnit
  /** unidade como o cliente escreveu ("rollos", "bobinas", "m²") */
  unitText: string | null
  status: LineStatus
  /** SKU escolhido (só quando MATCHED) */
  sku: string | null
  /** opções quando AMBIGUOUS (ou próximas quando NOT_FOUND) */
  candidates: IntakeCandidate[]
  /** observação da interpretação (ex.: "espessura 240 µm não existe no catálogo") */
  note: string | null
}

/** Campo da operação lido do documento, com o trecho que o justifica (para o usuário conferir). */
export interface ReadField<T = string> {
  value: T
  evidence: string | null
}

export interface IntakeResult {
  /** resumo curto da interpretação (no idioma do usuário) */
  summary: string
  customer: {
    name: ReadField | null
    country: ReadField | null
    city: string | null
    taxId: string | null
    /** cliente já cadastrado que corresponde ao nome lido */
    matchedId: number | null
    /** outros cadastrados parecidos (para escolher); os homônimos vêm primeiro */
    similar: { id: number; name: string }[]
    /** quantos cadastros ativos têm exatamente o nome lido (> 1 = ambíguo: o usuário escolhe pelo código/cidade) */
    homonyms?: number
  }
  orderRef: ReadField | null
  destination: ReadField | null
  mode: ReadField<'SEA' | 'ROAD' | 'AIR' | 'LCL' | 'ROAD_LTL' | 'AIR_LOOSE' | 'COURIER'> | null
  incoterm: ReadField | null
  /** equipamento citado: valor = "CONTAINER:id" / "VEHICLE:id" quando reconhecido no cadastro */
  equipment: (ReadField & { label: string }) | null
  /** texto do equipamento citado mas não reconhecido (para perguntar) */
  equipmentText: string | null
  notes: string | null
  lines: IntakeLine[]
  /** inconsistências, trechos ilegíveis, duplicidades */
  issues: string[]
  /** arquivos lidos (nome + tipo) */
  files: { name: string; kind: string }[]
}

/** Dados da operação confirmados pelo usuário na revisão. */
export interface IntakeDraft {
  area: string
  customerId: number | null
  newCustomer: string
  country: string
  /** TIPO DE ENVIO (FCL, ROAD, AIR_ULD, LCL, AIR_LOOSE, PALLETS_ONLY, COURIER); antigos: SEA/ROAD/AIR */
  mode: string
  incoterm: string
  equipment: string
  /** sem equipamento (paletes): altura máxima do palete carregado (mm) */
  maxHeightMm?: number | null
  /** courier: divisor volumétrico (cm³/kg) */
  courierDivisor?: number | null
  /** caminhão: comprimento útil real (mm), se diferente do cadastro */
  lengthMm?: number | null
  /** transportadora (código ou nome; opcional) */
  transportCompany?: string
  orderRef: string
  /** porto/aeroporto/endereço de origem e destino (conforme a modalidade) e endereço do cliente */
  originPlace?: string
  destinationPlace?: string
  customerAddress?: string
  notes: string
  lines: { sku: string | null; quantity: number | null; unit: QtyUnit; sourceText: string }[]
}

/** O que falta para montar a operação (rótulos para a tela). Nada é assumido. */
export function missingForCreate(d: IntakeDraft): string[] {
  const m: string[] = []
  if (!d.area) m.push('Área')
  if (!d.customerId && !d.newCustomer.trim()) m.push('Cliente')
  if (!d.country.trim()) m.push('País de destino')
  if (!d.mode) m.push('Tipo de envio')
  if (!d.incoterm) m.push('Incoterm')
  const svc = isService(d.mode) ? d.mode : d.mode ? serviceFromMode(d.mode) : null
  if ((!svc || TYPE_INFO[svc].equipment) && !d.equipment) m.push('Equipamento')
  if (!d.lines.length) m.push('Produtos')
  d.lines.forEach((l, i) => {
    const n = `Linha ${i + 1}`
    if (!l.sku) m.push(`${n}: produto do catálogo`)
    if (!l.quantity || l.quantity <= 0) m.push(`${n}: quantidade`)
    if (l.unit === 'OTHER') m.push(`${n}: unidade da quantidade`)
  })
  return m
}

/**
 * Quantidade do cliente → UNIDADES de produto (determinístico). Paletes completos dependem do palete
 * da regra logística e são calculados ao montar (devolve null aqui com `pallets`).
 */
export function unitsFor(quantity: number, unit: QtyUnit, pack: Pick<PackSnapshot, 'unitsPerPackage' | 'netKg'>): { units: number; note?: string } | { pallets: number } | { error: string } {
  if (!(quantity > 0)) return { error: 'quantidade inválida' }
  if (unit === 'UNIT') return { units: Math.round(quantity) }
  if (unit === 'BOX') return { units: Math.round(quantity) * Math.max(1, pack.unitsPerPackage) }
  if (unit === 'PALLET') return { pallets: Math.round(quantity) }
  if (unit === 'KG') {
    const perUnit = pack.netKg / Math.max(1, pack.unitsPerPackage)
    if (!(perUnit > 0)) return { error: 'produto sem peso líquido cadastrado: não dá para converter kg em unidades' }
    const units = Math.ceil(quantity / perUnit - 1e-9)
    return { units, note: `${quantity.toLocaleString('pt-BR')} kg ÷ ${perUnit.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kg/un. = ${units} un.` }
  }
  return { error: 'unidade não definida' }
}

/** Nome normalizado para comparar clientes ("Agro S.A." = "agro sa"). */
export function normName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(s[./]?\s?a\.?|s\.?r\.?l\.?|ltda\.?|ltd\.?|inc\.?|llc|cia\.?|s\.?a\.?s\.?|eireli|me|epp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Cliente cadastrado correspondente (nome igual após normalizar) e parecidos (um contém o outro / palavras em comum).
 * HOMÔNIMOS (a carteira do ERP tem razões sociais repetidas, com códigos diferentes): mais de um cadastro com o
 * mesmo nome = ambíguo — nenhum é escolhido; todos vêm primeiro em `similar` e `homonyms` diz quantos são.
 */
export function matchCustomer(name: string, customers: { id: number; name: string }[]): { matchedId: number | null; similar: { id: number; name: string }[]; homonyms: number } {
  const n = normName(name)
  if (!n) return { matchedId: null, similar: [], homonyms: 0 }
  const exacts = customers.filter((c) => normName(c.name) === n)
  const exact = exacts.length === 1 ? exacts[0] : null
  const words = new Set(n.split(' ').filter((w) => w.length >= 4))
  const others = customers
    .filter((c) => normName(c.name) !== n)
    .map((c) => {
      const cn = normName(c.name)
      const common = cn.split(' ').filter((w) => words.has(w)).length
      const contains = cn.length >= 4 && (cn.includes(n) || n.includes(cn))
      return { c, score: (contains ? 3 : 0) + common }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.c)
  const homonyms = exacts.length > 1 ? exacts : []
  return { matchedId: exact?.id ?? null, similar: [...homonyms, ...others], homonyms: homonyms.length }
}

/** palavras que não identificam cliente (genéricas, de produto ou de transporte) */
const CUSTOMER_STOP = new Set(['para', 'com', 'cliente', 'pedido', 'carga', 'camion', 'caminhao', 'container', 'contenedor', 'conteiner', 'completo', 'completa', 'silo', 'bolsa', 'bolsas', 'lona', 'lonas', 'agro', 'brasil', 'uruguay', 'uruguai', 'paraguay', 'argentina', 'chile', 'mexico', 'bolivia', 'peru', 'pies', 'micras'])

/**
 * Cliente citado num texto livre ("camión completo para Danilo…"): o cadastro cujo nome tem mais
 * palavras significativas (≥ 4 letras) presentes no texto. Empate entre clientes diferentes = nenhum
 * (não adivinha). Nome inteiro presente vale mais que uma palavra solta.
 */
export function customerInText(text: string, customers: { id: number; name: string }[]): number | null {
  const t = ` ${normName(text)} `
  let best: { id: number; score: number } | null = null
  let tie = false
  for (const c of customers) {
    const n = normName(c.name)
    if (!n) continue
    const words = [...new Set(n.split(' ').filter((w) => w.length >= 4 && !CUSTOMER_STOP.has(w)))]
    const hits = words.filter((w) => t.includes(` ${w} `)).length
    if (!hits) continue
    const score = hits + (t.includes(` ${n} `) ? 10 : 0)
    if (!best || score > best.score) {
      best = { id: c.id, score }
      tie = false
    } else if (score === best.score) tie = true
  }
  return best && !tie ? best.id : null
}

/** Modalidade citada em texto livre (só quando explícita). */
export function modeInText(text: string): 'SEA' | 'ROAD' | 'AIR' | null {
  const t = normName(text)
  if (/\b(camion|camiones|caminhao|caminhoes|carreta|truck|rodoviari[oa]|terrestre|semirreboque|sider|bitrem)\b/.test(t)) return 'ROAD'
  if (/\b(aere[oa]|avion|aviao|air|uld)\b/.test(t)) return 'AIR'
  if (/\b(contenedor|contenedores|container|containers|conteiner|conteineres|maritim[oa]|barco|navio)\b/.test(t) || /\b(20|40)\s*(gp|hc|hq|dry|dv)\b/.test(t)) return 'SEA'
  return null
}

/** Equipamento citado em texto livre → código do cadastro (só quando explícito). */
export function equipmentCodeInText(text: string): string | null {
  const t = text.toLowerCase()
  // (?<![\d.,]) em vez de \b: "1x40HC" também conta ("x" e "4" não formam fronteira de palavra)
  if (/(?<![\d.,])40\s*-?\s*(hc|hq)\b|high\s*cube/.test(t)) return '40HC'
  if (/(?<![\d.,])20\s*(gp|dv|dc|dry|st|std|p[eé]s|pies|ft|feet|'|′|’)|(cont[eê]i?ner|contenedor|container)\s+(de\s+)?20\b|\d\s*x\s*20\b/.test(t)) return '20GP'
  if (/(?<![\d.,])40\s*(gp|dv|dc|dry|st|std|p[eé]s|pies|ft|feet|'|′|’)|(cont[eê]i?ner|contenedor|container)\s+(de\s+)?40\b|\d\s*x\s*40\b/.test(t)) return '40GP'
  return null
}

/**
 * Tipo de envio citado em texto livre (só com evidência explícita): courier/DHL/FedEx/UPS → COURIER;
 * caminhão consolidado/fracionado, LTL → ROAD_LTL; LCL/consolidado → LCL; aéreo com carga solta/paletes sem ULD →
 * AIR_LOOSE; "só paletes" → PALLETS_ONLY;
 * senão a modalidade (contêiner → FCL, caminhão → ROAD, aéreo → AIR_ULD). null = não citado.
 */
export function serviceInText(text: string): 'FCL' | 'ROAD' | 'AIR_ULD' | 'LCL' | 'ROAD_LTL' | 'AIR_LOOSE' | 'PALLETS_ONLY' | 'COURIER' | null {
  const t = normName(text)
  if (/\b(courier|dhl|fedex|ups|tnt|paqueteria|paquetaria|encomenda)\b/.test(t)) return 'COURIER'
  // rodoviário consolidado / fracionado (LTL) antes do LCL: "camión consolidado", "carga fracionada rodoviária"
  const roadWord = /\b(caminhao|camion|camiones|rodoviari[oa]|terrestre|carreta|truck)\b/.test(t)
  // sinal marítimo explícito ganha (porto/puerto não conta: "Porto Alegre", entrega no porto por caminhão)
  const seaWord = /\b(lcl|maritim[oa]|barco|navio|buque)\b/.test(t)
  if (/\bltl\b/.test(t) || (roadWord && !seaWord && /\b(consolidad[oa]|fraccionad[oa]|fracionad[oa]|grupaje)\b/.test(t)) || /\bcarga fracionada rodoviaria\b/.test(t)) return 'ROAD_LTL'
  if (/\b(lcl|consolidad[oa]|carga fraccionada|carga fracionada|grupaje)\b/.test(t)) return 'LCL'
  const air = /\b(aere[oa]|avion|aviao|air)\b/.test(t)
  if (air && /\b(carga (solta|suelta)|loose|paletes? (solt|suelt)|sem uld|sin uld)\b/.test(t)) return 'AIR_LOOSE'
  if (/\b(so|solo|solamente|somente) (paletes|pallets|palets)\b/.test(t)) return 'PALLETS_ONLY'
  const m = modeInText(text)
  return m === 'SEA' ? 'FCL' : m === 'ROAD' ? 'ROAD' : m === 'AIR' ? 'AIR_ULD' : null
}

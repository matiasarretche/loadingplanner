/**
 * SEGUIMENTO DE EXPORTAÇÕES (núcleo puro, sem React nem DB): etapas, cálculos de datas e alertas.
 *
 * Uma OPERAÇÃO = uma carga (contêiner/caminhão) cujo pedido foi confirmado pelo cliente. Os dados comerciais
 * (cliente, país, proforma, produtos, pesos, valor, Incoterm, portos, transportadora) NÃO são copiados: vêm da
 * carga/pedido originais. Aqui ficam só os dados de logística e as datas, cada um com a sua ORIGEM (manual,
 * calculado ou API), para que no futuro um rastreio automático (armador, freight forwarder…) atualize os mesmos
 * campos sem reconstruir o módulo.
 *
 * Datas são strings 'YYYY-MM-DD' (dia civil, sem fuso); "hoje" é o dia em São Paulo.
 */
import type { KitBoxLine } from './kitBoxes'
import { serviceOf, ShipmentService, TransportMode, TYPE_INFO } from './shipmentType'

export const EXPORT_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'LOADING_SCHEDULED', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'FINISHED', 'CANCELLED'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]

/** sequência normal (CANCELLED é situação especial, fora da sequência) */
export const EXPORT_PIPELINE: readonly ExportStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'LOADING_SCHEDULED', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'FINISHED']

export const EXPORT_STATUS_LABEL: Record<ExportStatus, string> = {
  CONFIRMED: 'Pedido confirmado',
  IN_PRODUCTION: 'Em produção / preparação',
  LOADING_SCHEDULED: 'Carregamento programado',
  LOADED: 'Carregado',
  IN_TRANSIT: 'Em trânsito',
  ARRIVED: 'Chegou ao destino',
  FINISHED: 'Finalizado',
  CANCELLED: 'Cancelado',
}

/** rótulo curto (pílulas, quadro por etapa) */
export const EXPORT_STATUS_SHORT: Record<ExportStatus, string> = {
  CONFIRMED: 'Confirmado',
  IN_PRODUCTION: 'Produção',
  LOADING_SCHEDULED: 'Carga programada',
  LOADED: 'Carregado',
  IN_TRANSIT: 'Em trânsito',
  ARRIVED: 'Chegou',
  FINISHED: 'Finalizado',
  CANCELLED: 'Cancelado',
}

export const isExportStatus = (x: unknown): x is ExportStatus => typeof x === 'string' && (EXPORT_STATUSES as readonly string[]).includes(x)
/** operações em curso (painel principal); finalizadas e canceladas vão para o histórico */
export const isActiveStatus = (s: ExportStatus) => s !== 'FINISHED' && s !== 'CANCELLED'
/** posição na sequência (CANCELLED = -1) */
export const statusRank = (s: ExportStatus) => EXPORT_PIPELINE.indexOf(s)
/** a operação já chegou (pelo menos) a esta etapa? */
export const reached = (s: ExportStatus, step: ExportStatus) => s !== 'CANCELLED' && statusRank(s) >= statusRank(step)

// ---------------------------------------------------------------------------
// Campos de seguimento e a ORIGEM de cada valor
// ---------------------------------------------------------------------------

/** campos de seguimento editáveis (mesmos nomes das colunas em export_operation) */
export const TRACKING_FIELDS = [
  'status',
  'delayed',
  'incident',
  'confirmedAt',
  'paymentReceivedAt',
  'responsibleUserId',
  'carrier',
  'forwarder',
  'bookingNumber',
  'containerNumber',
  'sealNumber',
  'blNumber',
  'vessel',
  'voyage',
  'plannedLoadingDate',
  'actualLoadingDate',
  'etd',
  'atd',
  'transitDays',
  'eta',
  'ata',
  'deliveredAt',
  'currentLocation',
  'trackingStatus',
  'notes',
] as const
export type TrackingField = (typeof TRACKING_FIELDS)[number]

/** campos do contêiner/caminhão (cada carga tem o seu): nunca são copiados para as outras cargas do pedido */
export const PER_UNIT_FIELDS: readonly TrackingField[] = ['containerNumber', 'sealNumber']
/** campos comuns ao pedido: podem ser aplicados a todas as cargas do pedido de uma vez */
export const SHARED_FIELDS: readonly TrackingField[] = TRACKING_FIELDS.filter((f) => !PER_UNIT_FIELDS.includes(f))

export const DATE_FIELDS: readonly TrackingField[] = ['confirmedAt', 'paymentReceivedAt', 'plannedLoadingDate', 'actualLoadingDate', 'etd', 'atd', 'eta', 'ata', 'deliveredAt']

export const FIELD_LABEL: Record<TrackingField | 'originPlace' | 'destinationPlace', string> = {
  status: 'Status',
  delayed: 'Atrasado',
  incident: 'Incidência',
  confirmedAt: 'Confirmação do pedido',
  paymentReceivedAt: 'Recebimento do pagamento',
  responsibleUserId: 'Responsável',
  carrier: 'Armador / transportadora',
  forwarder: 'Agente de carga (forwarder)',
  bookingNumber: 'Booking',
  containerNumber: 'Nº do contêiner',
  sealNumber: 'Lacre',
  blNumber: 'BL / documento de transporte',
  vessel: 'Navio / veículo',
  voyage: 'Viagem',
  plannedLoadingDate: 'Carregamento previsto',
  actualLoadingDate: 'Carregamento real',
  etd: 'ETD (saída prevista)',
  atd: 'Saída real',
  transitDays: 'Trânsito estimado (dias)',
  eta: 'ETA (chegada prevista)',
  ata: 'Chegada real',
  deliveredAt: 'Entrega ao cliente',
  currentLocation: 'Localização atual',
  trackingStatus: 'Status do rastreio',
  notes: 'Observações',
  originPlace: 'Origem',
  destinationPlace: 'Destino',
}

/** de onde veio um valor: digitado, calculado pelo sistema ou recebido de uma integração */
export type FieldSourceKind = 'MANUAL' | 'CALC' | 'API'
export interface FieldSource {
  source: FieldSourceKind
  /** ISO 8601 */
  at: string
  /** usuário (manual) */
  by?: number | null
  /** integração (API): ex. nome do armador/plataforma */
  provider?: string | null
}
export type FieldSources = Partial<Record<TrackingField | 'originPlace' | 'destinationPlace', FieldSource>>

// ---------------------------------------------------------------------------
// Datas (dia civil 'YYYY-MM-DD')
// ---------------------------------------------------------------------------

export const TRACKING_TZ = 'America/Sao_Paulo'
const ISO = /^\d{4}-\d{2}-\d{2}$/
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/** dia de hoje em São Paulo ('YYYY-MM-DD') */
export function todayBR(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TRACKING_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000)
/** b − a em dias */
export const daysBetween = (a: string, b: string) => dayNum(b) - dayNum(a)
export function addDays(d: string, n: number): string {
  return new Date((dayNum(d) + n) * 86_400_000).toISOString().slice(0, 10)
}
/** '2026-10-25' → '25/10/2026' */
export const fmtDate = (d: string | null | undefined) => (d && ISO.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—')

/** ETA = ETD + trânsito estimado (só quando os dois existem) */
export function etaFrom(etd: string | null | undefined, transitDays: number | null | undefined): string | null {
  return isIsoDate(etd) && transitDays != null && Number.isFinite(transitDays) && transitDays >= 0 ? addDays(etd, Math.round(transitDays)) : null
}

// ---------------------------------------------------------------------------
// Situação calculada: dias restantes, atrasos, alertas e "próximas"
// ---------------------------------------------------------------------------

/**
 * "Próxima a carregar / a chegar": quando falta até esta fração do tempo total da etapa (definido pelo Matías:
 * 10%). Chegada: trânsito (ETD → ETA). Carregamento: da confirmação do pedido até o carregamento previsto.
 * Sempre pelo menos 1 dia.
 */
export const SOON_FRACTION = 0.1
export const soonWindow = (totalDays: number | null | undefined) => Math.max(1, Math.ceil(Math.max(0, totalDays ?? 0) * SOON_FRACTION))

export interface TrackingDates {
  status: ExportStatus
  delayed?: boolean | null
  incident?: string | null
  confirmedAt?: string | null
  plannedLoadingDate?: string | null
  actualLoadingDate?: string | null
  etd?: string | null
  atd?: string | null
  transitDays?: number | null
  eta?: string | null
  ata?: string | null
}

export type AlertKind = 'LOADING_OVERDUE' | 'ETD_OVERDUE' | 'ETA_OVERDUE'
export interface TrackingAlert {
  kind: AlertKind
  /** dias vencidos (≥ 1) */
  days: number
  text: string
}

export interface TrackingSituation {
  /** carregou? (data real de carregamento ou etapa ≥ Carregado) */
  loaded: boolean
  /** saiu? (saída real ou etapa ≥ Em trânsito) */
  departed: boolean
  /** chegou? (chegada real ou etapa ≥ Chegou ao destino) */
  arrived: boolean
  /** dias até o carregamento previsto (negativo = vencido); null se já carregou ou sem data */
  daysToLoading: number | null
  /** dias até a ETA (negativo = vencida); null se já chegou ou sem ETA */
  daysToArrival: number | null
  /** atraso de saída: ATD − ETD, ou hoje − ETD sem saída real (só se > 0) */
  etdDelay: number | null
  /** atraso de chegada: ATA − ETA, ou hoje − ETA sem chegada real (só se > 0) */
  etaDelay: number | null
  /** trânsito em dias (estimado; ou ETA − ETD) */
  transit: number | null
  alerts: TrackingAlert[]
  soonToLoad: boolean
  soonToArrive: boolean
  /** atrasada: algum alerta de data vencida ou marcada como atrasada manualmente */
  late: boolean
}

const plural = (n: number) => (n === 1 ? '1 dia' : `${n} dias`)

export function trackingSituation(t: TrackingDates, today: string = todayBR()): TrackingSituation {
  const s = t.status
  const active = isActiveStatus(s)
  const loaded = Boolean(t.actualLoadingDate) || reached(s, 'LOADED')
  const departed = Boolean(t.atd) || reached(s, 'IN_TRANSIT')
  const arrived = Boolean(t.ata) || reached(s, 'ARRIVED')
  const eta = t.eta && isIsoDate(t.eta) ? t.eta : etaFrom(t.etd, t.transitDays)
  const transit = t.transitDays ?? (isIsoDate(t.etd) && eta ? daysBetween(t.etd, eta) : null)

  const daysToLoading = !loaded && isIsoDate(t.plannedLoadingDate) ? daysBetween(today, t.plannedLoadingDate) : null
  const daysToArrival = !arrived && eta ? daysBetween(today, eta) : null
  const late = (ref: string | null | undefined, actual: string | null | undefined) => {
    if (!isIsoDate(ref)) return null
    const d = isIsoDate(actual) ? daysBetween(ref, actual) : daysBetween(ref, today)
    return d > 0 ? d : null
  }
  const etdDelay = isIsoDate(t.atd) || !departed ? late(t.etd, t.atd) : null
  const etaDelay = isIsoDate(t.ata) || !arrived ? late(eta, t.ata) : null

  const alerts: TrackingAlert[] = []
  if (active) {
    if (daysToLoading != null && daysToLoading < 0) alerts.push({ kind: 'LOADING_OVERDUE', days: -daysToLoading, text: `Carregamento previsto vencido há ${plural(-daysToLoading)}` })
    if (!departed && isIsoDate(t.etd) && daysBetween(t.etd, today) > 0) alerts.push({ kind: 'ETD_OVERDUE', days: daysBetween(t.etd, today), text: `ETD vencido há ${plural(daysBetween(t.etd, today))}` })
    if (daysToArrival != null && daysToArrival < 0) alerts.push({ kind: 'ETA_OVERDUE', days: -daysToArrival, text: `ETA vencida há ${plural(-daysToArrival)}` })
  }
  // próximas: dentro da janela de 10% da etapa (e ainda não vencidas)
  const loadSpan = isIsoDate(t.confirmedAt) && isIsoDate(t.plannedLoadingDate) ? daysBetween(t.confirmedAt, t.plannedLoadingDate) : null
  const soonToLoad = active && daysToLoading != null && daysToLoading >= 0 && daysToLoading <= soonWindow(loadSpan)
  const soonToArrive = active && daysToArrival != null && daysToArrival >= 0 && daysToArrival <= soonWindow(transit)

  return { loaded, departed, arrived, daysToLoading, daysToArrival, etdDelay, etaDelay, transit, alerts, soonToLoad, soonToArrive, late: active && (alerts.length > 0 || Boolean(t.delayed)) }
}

/**
 * Próximo evento da lista (texto "Dias restantes" e ordem "mais urgentes primeiro"): carregamento enquanto
 * não saiu e há carregamento previsto; senão a chegada (já saiu, já carregou ou sem data de carregamento).
 * null = sem data.
 */
export function nextEvent(sit: TrackingSituation): { what: 'carregamento' | 'chegada'; days: number } | null {
  if (!sit.departed && sit.daysToLoading != null) return { what: 'carregamento', days: sit.daysToLoading }
  return sit.daysToArrival != null ? { what: 'chegada', days: sit.daysToArrival } : null
}

/** texto curto de dias restantes para a lista (o mesmo evento usado na ordem: nextEvent); alerta prevalece */
export function remainingLabel(sit: TrackingSituation): string {
  if (sit.alerts.length) return sit.alerts[sit.alerts.length - 1].text
  const n = nextEvent(sit)
  // dias negativos sem alerta só acontecem em operação encerrada (cancelada): nada a contar
  if (!n || n.days < 0) return '—'
  return n.days === 0 ? `${n.what} hoje` : `${plural(n.days)} p/ ${n.what}`
}

// ---------------------------------------------------------------------------
// Histórico: descrição legível de cada alteração
// ---------------------------------------------------------------------------

export type TrackingValue = string | number | boolean | null

/** texto do histórico: "ETD atualizado para 22/10/2026", "Status alterado para “Em trânsito”"… */
export function describeChange(field: TrackingField | 'originPlace' | 'destinationPlace', before: TrackingValue, after: TrackingValue, names?: (id: number) => string): string {
  const label = FIELD_LABEL[field]
  const show = (v: TrackingValue) => {
    if (v == null || v === '') return '—'
    if (field === 'responsibleUserId' && typeof v === 'number') return names?.(v) ?? `#${v}`
    if (DATE_FIELDS.includes(field as TrackingField) && typeof v === 'string') return fmtDate(v)
    return String(v)
  }
  if (field === 'status' && isExportStatus(after)) return `Status alterado para “${EXPORT_STATUS_LABEL[after]}”`
  if (field === 'delayed') return after ? 'Marcado como atrasado' : 'Desmarcado como atrasado'
  if (field === 'incident') return after ? `Incidência registrada: ${after}` : 'Incidência encerrada'
  if (field === 'plannedLoadingDate' && after) return `Carregamento programado para ${show(after)}`
  if (field === 'actualLoadingDate' && after) return `Carregado em ${show(after)}`
  if (field === 'atd' && after) return `Saída real em ${show(after)}`
  if (field === 'ata' && after) return `Chegada real em ${show(after)}`
  if (field === 'deliveredAt' && after) return `Entregue ao cliente em ${show(after)}`
  if (field === 'paymentReceivedAt' && after) return `Pagamento recebido em ${show(after)}`
  if (field === 'notes') return after ? 'Observações atualizadas' : 'Observações apagadas'
  if (after == null || after === '') return `${label} apagado (era ${show(before)})`
  if (before == null || before === '') return `${label}: ${show(after)}`
  return `${label} atualizado para ${show(after)}`
}

/** número de contêiner ISO 6346 (4 letras + 7 dígitos, com dígito verificador): ajuda a pegar erro de digitação */
export function containerNumberValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, '').toUpperCase()
  if (!/^[A-Z]{4}\d{7}$/.test(s)) return false
  const val = (c: string) => {
    if (/\d/.test(c)) return Number(c)
    // A=10…Z=38, pulando múltiplos de 11
    let v = 10
    for (let ch = 65; ch < c.charCodeAt(0); ch++) {
      v++
      if (v % 11 === 0) v++
    }
    return v
  }
  let sum = 0
  for (let i = 0; i < 10; i++) sum += val(s[i]) * 2 ** i
  return (sum % 11) % 10 === Number(s[10])
}

// ---------------------------------------------------------------------------
// RESUMO PARA O CLIENTE (PDF "Status do embarque"): só o que pode sair da empresa
// ---------------------------------------------------------------------------

/**
 * Seções do resumo, na ordem do PDF (o status vem logo depois do pedido: é o que o cliente procura).
 * NUNCA entram no resumo: observações, incidência, "atrasado", responsável, pagamento, preços/valores,
 * origem dos campos (manual/API), histórico, localização/status do rastreio — o mapper abaixo nem os copia.
 */
export const SUMMARY_SECTIONS = ['order', 'status', 'route', 'shipping', 'containers', 'products'] as const
export type SummarySection = (typeof SUMMARY_SECTIONS)[number]
export const isSummarySection = (x: unknown): x is SummarySection => typeof x === 'string' && (SUMMARY_SECTIONS as readonly string[]).includes(x)

/** rótulos das seções no diálogo (pt-BR) */
export const SUMMARY_SECTION_LABEL: Record<SummarySection, string> = {
  order: 'Pedido (proforma, cliente, país de destino)',
  status: 'Etapa atual (as 7 etapas, com a atual destacada)',
  route: 'Rota e datas (origem, destino, ETD/saída, trânsito, ETA/chegada, entrega)',
  shipping: 'Embarque (armador, forwarder, booking, BL, navio, viagem)',
  containers: 'Contêineres (tipo de equipamento, nº, lacre)',
  products: 'Produtos (como na Proforma: caixas, unidades, pesos e totais)',
}

/** "Mensagem ao cliente" (quadro destacado no início do PDF) */
export const SUMMARY_MESSAGE_MAX = 600

/**
 * Campos do formulário do Seguimento que aparecem no resumo (o mapper abaixo lê só estes da operação, mais
 * origem/destino do pedido): alterados e ainda não salvos, o diálogo do resumo pede para salvar antes —
 * o PDF é montado com os dados SALVOS.
 */
export const SUMMARY_TRACKING_FIELDS: readonly (TrackingField | 'originPlace' | 'destinationPlace')[] = [
  'status',
  'carrier',
  'forwarder',
  'bookingNumber',
  'containerNumber',
  'sealNumber',
  'blNumber',
  'vessel',
  'voyage',
  'etd',
  'atd',
  'transitDays',
  'eta',
  'ata',
  'deliveredAt',
  'originPlace',
  'destinationPlace',
]

export interface SummaryProduct {
  sku: string
  /** descrição como na Proforma (nome do produto na versão aprovada) */
  name: string
  /** caixas de kits por tipo (KIT-HF), como na Proforma; null = embalagem normal */
  kitBoxes: KitBoxLine[] | null
  boxes: number
  units: number
  netKg: number
  /** produto + caixa + parte da tara dos paletes (a coluna "Bruto" da Proforma) */
  grossKg: number
}

export interface SummaryTotals {
  pallets: number
  /** caixas/volumes */
  packages: number
  units: number
  netKg: number
  /** peso bruto com paletes (sem a tara do equipamento) */
  grossKg: number
}

/** equipamento da versão aprovada; service = tipo do envio sem equipamento (LCL, AIR_LOOSE…), senão null */
export interface SummaryEquipment {
  code: string
  name: string
  service: string | null
}

export interface SummaryShipping {
  carrier: string | null
  forwarder: string | null
  bookingNumber: string | null
  blNumber: string | null
  vessel: string | null
  voyage: string | null
}

export interface SummaryDates {
  etd: string | null
  atd: string | null
  transitDays: number | null
  eta: string | null
  ata: string | null
  deliveredAt: string | null
}

/** uma carga (contêiner/caminhão) do resumo */
export interface SummaryUnit {
  /** posição no pedido (1, 2…) */
  unitIndex: number
  status: ExportStatus
  equipment: SummaryEquipment | null
  containerNumber: string | null
  sealNumber: string | null
  shipping: SummaryShipping
  dates: SummaryDates
  /** da última versão APROVADA da carga (vazio sem versão aprovada) */
  products: SummaryProduct[]
  totals: SummaryTotals | null
}

/** Conteúdo do PDF do resumo para o cliente (DTO seguro: nada interno). */
export interface TrackingSummary {
  /** operações incluídas (histórico "Resumo gerado/enviado" em cada uma) */
  operationIds: number[]
  /** referência rotulada ("Proforma 192.26"); null = sem referência */
  orderRef: string | null
  customer: string
  /** país de destino (como no pedido, em português) */
  country: string
  service: ShipmentService
  /** como chamar origem/destino: portos (SEA), aeroportos (AIR) ou endereços (ROAD) */
  placeMode: TransportMode
  originPlace: string | null
  destinationPlace: string | null
  /** cargas do pedido (com ou sem seguimento) */
  unitCount: number
  /** na ordem do pedido */
  units: SummaryUnit[]
}

/** linha da operação (a do banco, com TODOS os campos — o mapper só lê os permitidos) */
export type SummaryOpRow = Record<string, unknown> & {
  id: number
  loadPlanId: number
  status: string
  containerNumber?: string | null
  sealNumber?: string | null
  carrier?: string | null
  forwarder?: string | null
  bookingNumber?: string | null
  blNumber?: string | null
  vessel?: string | null
  voyage?: string | null
  etd?: string | null
  atd?: string | null
  transitDays?: number | null
  eta?: string | null
  ata?: string | null
  deliveredAt?: string | null
}

/** dados da última versão APROVADA de uma carga (produtos/totais podem trazer campos a mais: são descartados) */
export interface SummaryVersionInput {
  equipment: (SummaryEquipment & Record<string, unknown>) | null
  products: (SummaryProduct & Record<string, unknown>)[]
  totals: (SummaryTotals & Record<string, unknown>) | null
}

export interface SummarySource {
  /** operação pedida (sempre entra) */
  operationId: number
  /** junta as outras cargas do pedido que têm seguimento */
  includeSiblings: boolean
  /** referência já rotulada (orderRefLabel) */
  orderRef: string | null
  customer: string
  /** pedido (linha do banco; só país, tipo, modalidade e origem/destino são lidos) */
  shipment: Record<string, unknown> & { destinationCountry: string; service?: string | null; mode?: string | null; originPlace?: string | null; destinationPlace?: string | null }
  /** cargas do pedido em ordem (posição = unidade 1, 2…) */
  unitPlanIds: number[]
  /** operações das cargas do pedido */
  ops: SummaryOpRow[]
  /** por loadPlanId */
  versions: Map<number, SummaryVersionInput>
}

const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const day = (v: unknown): string | null => (isIsoDate(v) ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Monta o resumo para o cliente a partir das linhas do banco — PURO e por lista de permissões: cada campo do
 * DTO é copiado explicitamente; o que não está aqui (observações, incidência, atraso, responsável, pagamento e
 * condição de pagamento, CFOP, transportadora/código do ERP, valores, origens, histórico) nunca chega ao PDF.
 * O armador/transportadora do PDF é o do seguimento (op.carrier), nunca a transportadora da carga.
 * null = a operação pedida não é de uma carga do pedido.
 * includeSiblings: todas as cargas do pedido com seguimento (inclusive canceladas), na ordem do pedido.
 */
export function trackingSummaryDto(src: SummarySource): TrackingSummary | null {
  const pos = (planId: number) => src.unitPlanIds.indexOf(planId)
  const ofOrder = src.ops.filter((o) => pos(o.loadPlanId) >= 0)
  const own = ofOrder.find((o) => o.id === src.operationId)
  if (!own) return null
  const chosen = (src.includeSiblings ? ofOrder : [own]).slice().sort((a, b) => pos(a.loadPlanId) - pos(b.loadPlanId) || a.id - b.id)
  const service = serviceOf({ service: txt(src.shipment.service), mode: txt(src.shipment.mode) })

  const units: SummaryUnit[] = chosen.map((o) => {
    const v = src.versions.get(o.loadPlanId)
    const etd = day(o.etd)
    const stored = typeof o.transitDays === 'number' && Number.isInteger(o.transitDays) && o.transitDays >= 0 ? o.transitDays : null
    const eta = day(o.eta) ?? etaFrom(etd, stored)
    // sem trânsito informado: ETA − ETD (como em trackingSituation); data trocada/absurda = sem trânsito
    const span = etd && eta ? daysBetween(etd, eta) : null
    const transitDays = stored ?? (span != null && span >= 0 && span <= 365 ? span : null)
    return {
      unitIndex: pos(o.loadPlanId) + 1,
      status: isExportStatus(o.status) ? o.status : 'CONFIRMED',
      equipment: v?.equipment ? { code: String(v.equipment.code ?? ''), name: String(v.equipment.name ?? ''), service: txt(v.equipment.service) } : null,
      containerNumber: txt(o.containerNumber),
      sealNumber: txt(o.sealNumber),
      shipping: { carrier: txt(o.carrier), forwarder: txt(o.forwarder), bookingNumber: txt(o.bookingNumber), blNumber: txt(o.blNumber), vessel: txt(o.vessel), voyage: txt(o.voyage) },
      dates: { etd, atd: day(o.atd), transitDays, eta, ata: day(o.ata), deliveredAt: day(o.deliveredAt) },
      products: (v?.products ?? []).map((p) => ({
        sku: String(p.sku),
        name: String(p.name ?? ''),
        kitBoxes: Array.isArray(p.kitBoxes) && p.kitBoxes.length ? p.kitBoxes.map((k) => ({ kind: k.kind, code: k.code ?? null, kits: num(k.kits), boxes: num(k.boxes) })) : null,
        boxes: num(p.boxes),
        units: num(p.units),
        netKg: num(p.netKg),
        grossKg: num(p.grossKg),
      })),
      totals: v?.totals ? { pallets: num(v.totals.pallets), packages: num(v.totals.packages), units: num(v.totals.units), netKg: num(v.totals.netKg), grossKg: num(v.totals.grossKg) } : null,
    }
  })

  return {
    operationIds: chosen.map((o) => o.id),
    orderRef: txt(src.orderRef),
    customer: txt(src.customer) ?? '—',
    country: txt(src.shipment.destinationCountry) ?? '—',
    service,
    placeMode: TYPE_INFO[service].placeMode,
    originPlace: txt(src.shipment.originPlace),
    destinationPlace: txt(src.shipment.destinationPlace),
    unitCount: src.unitPlanIds.length,
    units,
  }
}

/** o mesmo valor em todas as cargas do resumo? (dados do embarque/datas uma vez só no PDF; senão, por carga) */
export function sameForAllUnits<T>(units: readonly SummaryUnit[], pick: (u: SummaryUnit) => T): boolean {
  if (units.length < 2) return true
  const first = JSON.stringify(pick(units[0]))
  return units.every((u) => JSON.stringify(pick(u)) === first)
}

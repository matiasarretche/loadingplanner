/**
 * EXPORTAÇÕES EM CURSO — tipos compartilhados entre servidor (src/lib/exportTracking.ts, actions.ts) e telas.
 * Só tipos: nada de código de servidor aqui (pode ser importado por componentes 'use client').
 *
 * Datas do seguimento: 'YYYY-MM-DD' (dia civil, sem fuso; formatar com fmtDate de @/domain/exportTracking).
 * Instantes (updatedAt, closedAt, eventos…): ISO 8601; mostrar com timeZone 'America/Sao_Paulo'.
 * Os dados comerciais (cliente, país, proforma, produtos, pesos, valor, Incoterm, portos, transportadora,
 * CFOP, condição de pagamento, agente, criador da carga) são LIDOS da carga/pedido a cada consulta — nunca
 * copiados para a operação (editam-se na carga).
 */
import type { ExportStatus, FieldSources } from '@/domain/exportTracking'
import type { ShipmentService, TransportMode } from '@/domain/shipmentType'
import type { AvatarRef } from '@/lib/avatar'

/** 'YYYY-MM-DD' */
export type IsoDate = string

/** Linha da lista (painel "Em curso" e aba "Histórico"). Uma por carga (contêiner/caminhão) confirmada. */
export interface ExportRow {
  /** id da operação (export_operation) → /exportacoes/{id} */
  id: number
  /** carga → /cargas/{loadPlanId} */
  loadPlanId: number
  shipmentId: number
  planName: string
  /** pedido com várias unidades: posição desta (1, 2…); null quando o pedido tem uma só */
  unitIndex: number | null
  unitCount: number
  customer: string
  /** país de destino (nome em português, como no pedido) */
  country: string
  /** referência já rotulada ("Proforma 192.26" / "Pedido Camión 5"); null = sem referência */
  orderRef: string | null
  incoterm: string
  /** tipo de envio (FCL, ROAD, AIR_ULD, LCL…) — TYPE_INFO[service] de @/domain/shipmentType */
  service: ShipmentService
  /** modalidade (SEA/ROAD/AIR; null em só paletes/courier) — placeLabels(mode) de @/lib/places */
  mode: TransportMode | null
  /** código do equipamento da última versão APROVADA (ex.: '40HC'); null se não houver */
  equipment: string | null
  /** transportadora da carga, do ERP ("Nome · cód. 12", transportCompanyLabel), de load_plan.transport_company_id */
  transportCompany: string | null
  /** CFOP do pedido (shipment.cfop, "7.101"): uso interno/fiscal — nunca no resumo para o cliente */
  cfop: string | null
  /** condição de pagamento da carga, em português (paymentTermsText); null = não informada ou usuário sem acesso a preços */
  paymentTerms: string | null
  status: ExportStatus
  /** marcada como atrasada manualmente */
  delayed: boolean
  /** incidência (texto); null = sem incidência */
  incident: string | null
  confirmedAt: IsoDate
  /** null = pagamento não informado (mostrar nota discreta, não alerta) */
  paymentReceivedAt: IsoDate | null
  plannedLoadingDate: IsoDate | null
  actualLoadingDate: IsoDate | null
  etd: IsoDate | null
  atd: IsoDate | null
  transitDays: number | null
  eta: IsoDate | null
  ata: IsoDate | null
  deliveredAt: IsoDate | null
  carrier: string | null
  forwarder: string | null
  bookingNumber: string | null
  /** por unidade (nunca copiado para as outras cargas do pedido) */
  containerNumber: string | null
  /** por unidade (nunca copiado para as outras cargas do pedido) */
  sealNumber: string | null
  blNumber: string | null
  vessel: string | null
  voyage: string | null
  /** origem/destino: ficam no PEDIDO (shipment.origin_place / destination_place), editáveis pelo seguimento */
  originPlace: string | null
  destinationPlace: string | null
  responsibleUserId: number | null
  responsibleName: string | null
  responsibleAvatar: AvatarRef
  /** quem criou a carga (load_plan.created_by) */
  loadCreatedByName: string | null
  /** ISO */
  updatedAt: string
  updatedByName: string | null
  /** ISO; preenchido quando FINISHED/CANCELLED (aba Histórico); null = em curso */
  closedAt: string | null
}

export interface ExportProduct {
  sku: string
  name: string
  /** volumes (caixas/embalagens) */
  boxes: number
  /** unidades de venda */
  units: number
  netKg: number
  grossKg: number
}

export interface ExportTotals {
  pallets: number
  packages: number
  units: number
  netKg: number
  /** peso bruto da carga (com paletes, sem equipamento) */
  payloadKg: number
  /** peso com o equipamento (tara incluída) */
  grossKg: number
  cbm: number
}

export interface ExportValue {
  goodsUsd: number | null
  freightUsd: number | null
  insuranceUsd: number | null
  /** mercadoria + frete + seguro; null sem preço da mercadoria */
  totalUsd: number | null
  /** frozen = congelado na aprovação; legacy = aprovada antes do módulo de preços; live = calculado agora */
  source: 'frozen' | 'live' | 'legacy'
}

/** Outra unidade (contêiner/caminhão) do mesmo pedido — a própria operação NÃO está na lista. */
export interface ExportSibling {
  loadPlanId: number
  planName: string
  /** posição no pedido (1, 2…) */
  unitIndex: number
  /** operação de seguimento da unidade (null = pedido ainda não confirmado nela) */
  operationId: number | null
  status: ExportStatus | null
  /** tem versão APROVADA (requisito para confirmar) */
  hasApproved: boolean
}

export type ExportEventSource = 'MANUAL' | 'CALC' | 'API' | 'SYSTEM'
/** 'summary' / 'summary_sent': resumo para o cliente gerado / enviado por e-mail (recordSummaryEvent) */
export type ExportEventKind = 'confirm' | 'status' | 'field' | 'undo' | 'summary' | 'summary_sent'

export interface ExportEvent {
  id: number
  /** ISO */
  at: string
  /** null = integração/sistema */
  userName: string | null
  source: ExportEventSource
  kind: ExportEventKind
  /** campo alterado (TrackingField | 'originPlace' | 'destinationPlace'); null em 'confirm' */
  field: string | null
  /** texto legível: "ETD atualizado para 22/10/2026", "Pedido confirmado" */
  message: string
}

/** Detalhe de uma operação (/exportacoes/[id]). `equipment` aqui é o objeto {code, name}. */
export interface ExportDetail extends Omit<ExportRow, 'equipment'> {
  /** origem (MANUAL | CALC | API) de cada valor gravado — mostrar com .exp-src(.calc/.api) */
  fieldSources: FieldSources
  notes: string | null
  /** rastreio (hoje manual; no futuro, integração) */
  currentLocation: string | null
  trackingStatus: string | null
  /** ISO: última atualização do rastreio (localização/status, ou chamada da integração) */
  lastTrackingUpdate: string | null
  trackingProvider: string | null
  trackingRef: string | null
  /** equipamento da última versão aprovada */
  equipment: { code: string; name: string } | null
  agentName: string | null
  /** última versão APROVADA da carga (produtos, totais e valor vêm dela) */
  approvedVersion: { id: number; version: number; approvedAt: string | null; approvedByName: string | null } | null
  /** versão aprovada no momento da confirmação */
  confirmedVersionId: number | null
  confirmedVersion: number | null
  /** a carga foi reaprovada (nova versão) depois da confirmação */
  newerApprovedThanConfirmed: boolean
  products: ExportProduct[]
  totals: ExportTotals | null
  /** null quando o usuário não vê preços */
  value: ExportValue | null
  siblings: ExportSibling[]
  /** histórico, mais recente primeiro */
  events: ExportEvent[]
  /** usuários ativos que podem editar o seguimento (select "Responsável"), por nome */
  users: { id: number; name: string }[]
  canEdit: boolean
  /** "Desfazer confirmação": só com status CONFIRMED e permissão de edição */
  canUndo: boolean
}

/** Valores editáveis do seguimento (mesmos nomes de TRACKING_FIELDS) + origem/destino do pedido. */
export interface TrackingValues {
  status: ExportStatus
  delayed: boolean
  /** '' ou null = sem incidência / encerrar */
  incident: string | null
  /** obrigatória (não pode ser apagada) */
  confirmedAt: IsoDate
  paymentReceivedAt: IsoDate | null
  responsibleUserId: number | null
  carrier: string | null
  forwarder: string | null
  bookingNumber: string | null
  containerNumber: string | null
  sealNumber: string | null
  blNumber: string | null
  vessel: string | null
  voyage: string | null
  plannedLoadingDate: IsoDate | null
  actualLoadingDate: IsoDate | null
  etd: IsoDate | null
  atd: IsoDate | null
  /** inteiro 0..365 */
  transitDays: number | null
  /** ignorada quando ETD e trânsito existem: o servidor recalcula (origem CALC) */
  eta: IsoDate | null
  ata: IsoDate | null
  deliveredAt: IsoDate | null
  currentLocation: string | null
  trackingStatus: string | null
  notes: string | null
  /** gravados no pedido (shipment), até 300 caracteres */
  originPlace: string | null
  destinationPlace: string | null
}

/** Alteração do seguimento: mande SÓ os campos alterados ('' = apagar). */
export type TrackingPatch = Partial<TrackingValues>

/** Diálogo "Confirmar pedido" (na carga). */
export interface ConfirmInput {
  /** padrão: hoje em São Paulo (todayBR()) */
  confirmedAt: IsoDate
  /** opcional: null = pagamento não informado */
  paymentReceivedAt: IsoDate | null
  /** confirmar também as outras unidades do pedido que têm versão aprovada e ainda não têm operação */
  includeSiblings: boolean
}

/** Dados para o botão/diálogo de confirmação na página da carga (confirmContext em src/lib/exportTracking.ts). */
export interface ConfirmContext {
  /** operação já existente desta carga → "Ver seguimento" (/exportacoes/{operationId}) */
  operationId: number | null
  status: ExportStatus | null
  /** a carga tem versão APROVADA */
  hasApproved: boolean
  /** mostrar "Confirmar pedido": sem operação, com versão aprovada e usuário com permissão */
  canConfirm: boolean
  /** outras unidades do pedido que seriam confirmadas junto (aprovadas e sem operação) */
  siblingsToConfirm: { loadPlanId: number; planName: string; unitIndex: number }[]
}

export type ActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string }

import { describe, expect, it } from 'vitest'
import {
  addDays,
  containerNumberValid,
  daysBetween,
  describeChange,
  etaFrom,
  fmtDate,
  isActiveStatus,
  isExportStatus,
  isIsoDate,
  nextEvent,
  PER_UNIT_FIELDS,
  remainingLabel,
  sameForAllUnits,
  SHARED_FIELDS,
  soonWindow,
  SummaryOpRow,
  SummarySource,
  SummaryVersionInput,
  todayBR,
  TRACKING_FIELDS,
  trackingSituation,
  trackingSummaryDto,
} from './exportTracking'

const TODAY = '2026-10-13'

describe('hoje em São Paulo', () => {
  it('usa o fuso de São Paulo (UTC−3), não o UTC', () => {
    // 02:30 UTC do dia 13 = 23:30 do dia 12 em São Paulo
    expect(todayBR(new Date('2026-10-13T02:30:00Z'))).toBe('2026-10-12')
    expect(todayBR(new Date('2026-10-13T03:00:00Z'))).toBe('2026-10-13')
    expect(todayBR(new Date('2027-01-01T02:59:59Z'))).toBe('2026-12-31')
  })
})

describe('datas civis', () => {
  it('addDays atravessa mês, ano e ano bissexto', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2026-10-13', 0)).toBe('2026-10-13')
  })
  it('daysBetween = b − a, atravessando mês e ano', () => {
    expect(daysBetween('2026-12-25', '2027-01-05')).toBe(11)
    expect(daysBetween('2026-02-01', '2026-03-01')).toBe(28)
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29)
    expect(daysBetween('2026-10-20', '2026-10-13')).toBe(-7)
    expect(daysBetween('2026-10-13', '2026-10-13')).toBe(0)
    // horário de verão antigo (out/2018) não afeta: dia civil
    expect(daysBetween('2018-11-03', '2018-11-05')).toBe(2)
  })
  it('isIsoDate e fmtDate', () => {
    expect(isIsoDate('2026-10-22')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-2-3')).toBe(false)
    expect(isIsoDate('22/10/2026')).toBe(false)
    expect(isIsoDate(null)).toBe(false)
    expect(fmtDate('2026-10-25')).toBe('25/10/2026')
    expect(fmtDate(null)).toBe('—')
  })
})

describe('ETA = ETD + trânsito', () => {
  it('calcula só quando os dois existem', () => {
    expect(etaFrom('2026-10-22', 30)).toBe('2026-11-21')
    expect(etaFrom('2026-12-20', 15)).toBe('2027-01-04')
    expect(etaFrom('2026-10-22', 0)).toBe('2026-10-22')
    expect(etaFrom(null, 30)).toBeNull()
    expect(etaFrom('2026-10-22', null)).toBeNull()
    expect(etaFrom('2026-10-22', -1)).toBeNull()
    expect(etaFrom('22/10/2026', 5)).toBeNull()
  })
})

describe('situação calculada', () => {
  it('alerta de carregamento previsto vencido', () => {
    const s = trackingSituation({ status: 'LOADING_SCHEDULED', plannedLoadingDate: '2026-10-10' }, TODAY)
    expect(s.loaded).toBe(false)
    expect(s.daysToLoading).toBe(-3)
    expect(s.alerts).toEqual([{ kind: 'LOADING_OVERDUE', days: 3, text: 'Carregamento previsto vencido há 3 dias' }])
    expect(s.late).toBe(true)
    expect(s.soonToLoad).toBe(false)
  })
  it('alerta de ETD vencido (ainda não saiu) e atraso de saída', () => {
    const s = trackingSituation({ status: 'LOADED', etd: '2026-10-12' }, TODAY)
    expect(s.departed).toBe(false)
    expect(s.alerts.map((a) => a.text)).toEqual(['ETD vencido há 1 dia'])
    expect(s.etdDelay).toBe(1)
    expect(s.late).toBe(true)
  })
  it('alerta de ETA vencida (em trânsito)', () => {
    const s = trackingSituation({ status: 'IN_TRANSIT', etd: '2026-09-11', eta: '2026-10-11' }, TODAY)
    expect(s.departed).toBe(true)
    expect(s.daysToArrival).toBe(-2)
    expect(s.etaDelay).toBe(2)
    // saiu (pela etapa): sem alerta de ETD nem atraso de saída sem data real
    expect(s.etdDelay).toBeNull()
    expect(s.alerts).toEqual([{ kind: 'ETA_OVERDUE', days: 2, text: 'ETA vencida há 2 dias' }])
    expect(remainingLabel(s)).toBe('ETA vencida há 2 dias')
  })
  it('ETA calculada (ETD + trânsito) quando a ETA não foi informada', () => {
    const s = trackingSituation({ status: 'IN_TRANSIT', etd: '2026-10-01', transitDays: 30 }, TODAY)
    expect(s.transit).toBe(30)
    expect(s.daysToArrival).toBe(18)
    expect(remainingLabel(s)).toBe('18 dias p/ chegada')
  })
  it('próxima a carregar: janela de 10% do tempo entre confirmação e carregamento previsto', () => {
    // 40 dias → janela de 4 dias
    const t = { status: 'IN_PRODUCTION' as const, confirmedAt: '2026-09-13', plannedLoadingDate: '2026-10-23' }
    expect(trackingSituation(t, '2026-10-13').soonToLoad).toBe(false)
    expect(trackingSituation(t, '2026-10-18').soonToLoad).toBe(false)
    expect(trackingSituation(t, '2026-10-19').soonToLoad).toBe(true)
    expect(trackingSituation(t, '2026-10-23').soonToLoad).toBe(true)
    // vencido: deixa de ser "próxima" e vira alerta
    const late = trackingSituation(t, '2026-10-24')
    expect(late.soonToLoad).toBe(false)
    expect(late.alerts[0].kind).toBe('LOADING_OVERDUE')
  })
  it('próxima a chegar: janela de 10% do trânsito', () => {
    // 30 dias → janela de 3 dias (ETA 31/10)
    const t = { status: 'IN_TRANSIT' as const, etd: '2026-10-01', transitDays: 30 }
    expect(trackingSituation(t, '2026-10-27').soonToArrive).toBe(false)
    expect(trackingSituation(t, '2026-10-28').soonToArrive).toBe(true)
    expect(trackingSituation(t, '2026-10-31').soonToArrive).toBe(true)
    expect(remainingLabel(trackingSituation(t, '2026-10-31'))).toBe('chegada hoje')
    // sem trânsito informado: ETA − ETD (20 dias → janela de 2)
    const u = { status: 'IN_TRANSIT' as const, etd: '2026-10-01', eta: '2026-10-21' }
    expect(trackingSituation(u, '2026-10-18').soonToArrive).toBe(false)
    expect(trackingSituation(u, '2026-10-19').soonToArrive).toBe(true)
  })
  it('janela mínima de 1 dia', () => {
    expect(soonWindow(0)).toBe(1)
    expect(soonWindow(null)).toBe(1)
    expect(soonWindow(-3)).toBe(1)
    expect(soonWindow(5)).toBe(1)
    expect(soonWindow(25)).toBe(3)
    expect(soonWindow(40)).toBe(4)
    // sem confirmação: janela de 1 dia
    expect(trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: '2026-10-14' }, TODAY).soonToLoad).toBe(true)
    expect(trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: '2026-10-15' }, TODAY).soonToLoad).toBe(false)
  })
  it('atrasada: marcada manualmente, mesmo sem alerta de data', () => {
    const s = trackingSituation({ status: 'IN_PRODUCTION', delayed: true }, TODAY)
    expect(s.alerts).toEqual([])
    expect(s.late).toBe(true)
    expect(trackingSituation({ status: 'IN_PRODUCTION' }, TODAY).late).toBe(false)
  })
  it('carregado / chegou: pela data real OU pela etapa', () => {
    const byDate = trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: '2026-10-05', actualLoadingDate: '2026-10-10' }, TODAY)
    expect(byDate.loaded).toBe(true)
    expect(byDate.daysToLoading).toBeNull()
    expect(byDate.alerts).toEqual([])
    const byStatus = trackingSituation({ status: 'LOADED', plannedLoadingDate: '2026-10-05' }, TODAY)
    expect(byStatus.loaded).toBe(true)
    expect(byStatus.departed).toBe(false)
    expect(byStatus.alerts).toEqual([])
    const arrivedByStatus = trackingSituation({ status: 'ARRIVED', eta: '2026-10-01' }, TODAY)
    expect(arrivedByStatus.arrived).toBe(true)
    expect(arrivedByStatus.daysToArrival).toBeNull()
    expect(arrivedByStatus.etaDelay).toBeNull()
    expect(arrivedByStatus.alerts).toEqual([])
    const arrivedByDate = trackingSituation({ status: 'IN_TRANSIT', eta: '2026-10-01', ata: '2026-10-05' }, TODAY)
    expect(arrivedByDate.arrived).toBe(true)
    expect(arrivedByDate.etaDelay).toBe(4)
    expect(arrivedByDate.alerts).toEqual([])
    // saiu antes do previsto: sem atraso
    expect(trackingSituation({ status: 'IN_TRANSIT', etd: '2026-10-10', atd: '2026-10-09' }, TODAY).etdDelay).toBeNull()
  })
  it('cancelada e finalizada não geram alertas, "próximas" nem atraso', () => {
    const old = { plannedLoadingDate: '2026-09-01', etd: '2026-09-02', eta: '2026-09-20', delayed: true }
    for (const status of ['CANCELLED', 'FINISHED'] as const) {
      const s = trackingSituation({ status, ...old }, TODAY)
      expect(s.alerts).toEqual([])
      expect(s.late).toBe(false)
      expect(s.soonToLoad).toBe(false)
      expect(s.soonToArrive).toBe(false)
    }
    expect(isActiveStatus('FINISHED')).toBe(false)
    expect(isActiveStatus('CANCELLED')).toBe(false)
    expect(isActiveStatus('ARRIVED')).toBe(true)
    expect(isExportStatus('IN_TRANSIT')).toBe(true)
    expect(isExportStatus('SHIPPED')).toBe(false)
  })
})

describe('texto de dias restantes', () => {
  it('carregamento antes de sair, chegada depois; alerta prevalece', () => {
    expect(remainingLabel(trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: '2026-10-20' }, TODAY))).toBe('7 dias p/ carregamento')
    expect(remainingLabel(trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: '2026-10-14' }, TODAY))).toBe('1 dia p/ carregamento')
    expect(remainingLabel(trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: TODAY }, TODAY))).toBe('carregamento hoje')
    expect(remainingLabel(trackingSituation({ status: 'IN_TRANSIT', eta: '2026-10-23' }, TODAY))).toBe('10 dias p/ chegada')
    expect(remainingLabel(trackingSituation({ status: 'CONFIRMED' }, TODAY))).toBe('—')
    // carregado (sem saída real) ou sem carregamento previsto: conta a chegada, como a ordem da lista
    const loaded = trackingSituation({ status: 'LOADED', etd: '2026-10-20', eta: '2026-11-07' }, TODAY)
    expect(remainingLabel(loaded)).toBe('25 dias p/ chegada')
    expect(nextEvent(loaded)).toEqual({ what: 'chegada', days: 25 })
    expect(remainingLabel(trackingSituation({ status: 'CONFIRMED', etd: '2026-10-20', transitDays: 18 }, TODAY))).toBe('25 dias p/ chegada')
    expect(nextEvent(trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: '2026-10-15', eta: '2026-11-07' }, TODAY))).toEqual({ what: 'carregamento', days: 2 })
    expect(nextEvent(trackingSituation({ status: 'CONFIRMED' }, TODAY))).toBeNull()
    // encerrada (cancelada) com data passada: sem alerta e sem contagem negativa
    expect(remainingLabel(trackingSituation({ status: 'CANCELLED', plannedLoadingDate: '2026-10-10' }, TODAY))).toBe('—')
    // vários alertas: o último (o mais adiantado na sequência)
    expect(remainingLabel(trackingSituation({ status: 'CONFIRMED', plannedLoadingDate: '2026-10-10', etd: '2026-10-12' }, TODAY))).toBe('ETD vencido há 1 dia')
  })
})

describe('histórico: descrição das alterações', () => {
  it('status, atraso e incidência', () => {
    expect(describeChange('status', 'CONFIRMED', 'IN_TRANSIT')).toBe('Status alterado para “Em trânsito”')
    expect(describeChange('delayed', false, true)).toBe('Marcado como atrasado')
    expect(describeChange('delayed', true, false)).toBe('Desmarcado como atrasado')
    expect(describeChange('incident', null, 'Avaria no contêiner')).toBe('Incidência registrada: Avaria no contêiner')
    expect(describeChange('incident', 'Avaria', null)).toBe('Incidência encerrada')
  })
  it('datas com mensagem própria', () => {
    expect(describeChange('plannedLoadingDate', null, '2026-10-25')).toBe('Carregamento programado para 25/10/2026')
    expect(describeChange('actualLoadingDate', null, '2026-10-25')).toBe('Carregado em 25/10/2026')
    expect(describeChange('atd', null, '2026-10-26')).toBe('Saída real em 26/10/2026')
    expect(describeChange('ata', null, '2026-11-20')).toBe('Chegada real em 20/11/2026')
    expect(describeChange('deliveredAt', null, '2026-11-22')).toBe('Entregue ao cliente em 22/11/2026')
    expect(describeChange('paymentReceivedAt', null, '2026-10-12')).toBe('Pagamento recebido em 12/10/2026')
  })
  it('campo informado, atualizado e apagado', () => {
    expect(describeChange('etd', null, '2026-10-22')).toBe('ETD (saída prevista): 22/10/2026')
    expect(describeChange('etd', '2026-10-20', '2026-10-22')).toBe('ETD (saída prevista) atualizado para 22/10/2026')
    expect(describeChange('etd', '2026-10-20', null)).toBe('ETD (saída prevista) apagado (era 20/10/2026)')
    expect(describeChange('transitDays', 20, 30)).toBe('Trânsito estimado (dias) atualizado para 30')
    expect(describeChange('containerNumber', null, 'CSQU3054383')).toBe('Nº do contêiner: CSQU3054383')
    expect(describeChange('originPlace', null, 'Rio Grande')).toBe('Origem: Rio Grande')
    expect(describeChange('destinationPlace', 'Montevidéu', '')).toBe('Destino apagado (era Montevidéu)')
  })
  it('observações e responsável (pelo nome)', () => {
    expect(describeChange('notes', null, 'texto')).toBe('Observações atualizadas')
    expect(describeChange('notes', 'texto', '')).toBe('Observações apagadas')
    expect(describeChange('responsibleUserId', null, 7, (id) => (id === 7 ? 'Matías' : '?'))).toBe('Responsável: Matías')
    expect(describeChange('responsibleUserId', null, 7)).toBe('Responsável: #7')
  })
})

describe('número de contêiner (ISO 6346)', () => {
  it('dígito verificador', () => {
    expect(containerNumberValid('CSQU3054383')).toBe(true)
    expect(containerNumberValid('csqu 305438-3')).toBe(true)
    expect(containerNumberValid('CSQU3054384')).toBe(false)
    expect(containerNumberValid('CSQU3054380')).toBe(false)
  })
  it('placas de caminhão e textos curtos não são contêiner', () => {
    expect(containerNumberValid('ABC1D23')).toBe(false)
    expect(containerNumberValid('IXB 1234')).toBe(false)
    expect(containerNumberValid('AAA-1234')).toBe(false)
    expect(containerNumberValid('')).toBe(false)
  })
})

describe('campos por unidade × comuns ao pedido', () => {
  it('contêiner e lacre nunca são copiados para as outras cargas do pedido', () => {
    expect(SHARED_FIELDS).not.toContain('containerNumber')
    expect(SHARED_FIELDS).not.toContain('sealNumber')
    expect([...PER_UNIT_FIELDS].sort()).toEqual(['containerNumber', 'sealNumber'])
    expect(SHARED_FIELDS).toContain('etd')
    expect(SHARED_FIELDS).toContain('status')
    expect(SHARED_FIELDS.length + PER_UNIT_FIELDS.length).toBe(TRACKING_FIELDS.length)
  })
})

describe('resumo para o cliente: DTO seguro (trackingSummaryDto)', () => {
  // linhas "do banco" com TODOS os campos internos preenchidos com marcadores que não podem vazar
  const shipment = {
    id: 7,
    customerId: 3,
    orderRef: 'Proforma 192.26',
    destinationCountry: 'Uruguai',
    incoterm: 'FOB',
    mode: 'SEA',
    service: 'FCL',
    originPlace: 'Rio Grande',
    destinationPlace: 'Montevideo',
    customerAddress: 'ENDERECO-INTERNO',
    area: 'EXPORT',
    notes: 'NOTA-INTERNA-PEDIDO',
    // fiscais/comerciais internos (CFOP do pedido; condição de pagamento e transportadora do ERP vêm da carga):
    // se alguém juntar a carga ao pedido por engano, nada disto pode sair no resumo
    cfop: 'CFOP-INTERNO',
    paymentTerms: { advancePct: 30, balanceWhen: 'AGAINST_DOCS', days: null, note: 'PAGAMENTO-INTERNO' },
    transportCompanyId: 4242,
    transportCompany: { id: 4242, code: 'COD-ERP-INTERNO', name: 'TRANSPORTADORA-INTERNA' },
  }
  const op = (id: number, loadPlanId: number, extra: Partial<SummaryOpRow> = {}): SummaryOpRow => ({
    id,
    loadPlanId,
    confirmedVersionId: 900,
    status: 'IN_TRANSIT',
    delayed: true,
    incident: 'INCIDENCIA-INTERNA',
    confirmedAt: '2026-10-01',
    confirmedBy: 5,
    paymentReceivedAt: '2026-10-02',
    responsibleUserId: 4242,
    carrier: 'Maersk',
    forwarder: 'Fwd Uno',
    bookingNumber: 'BK-1',
    containerNumber: `MSKU000000${id}`,
    sealNumber: `LACRE-${id}`,
    blNumber: 'BL-1',
    vessel: 'MSC Ana',
    voyage: '123E',
    plannedLoadingDate: '2026-10-08',
    actualLoadingDate: '2026-10-09',
    etd: '2026-10-12',
    atd: '2026-10-13',
    transitDays: 5,
    eta: '2026-10-17',
    ata: null,
    deliveredAt: null,
    currentLocation: 'LOCAL-INTERNO',
    trackingStatus: 'RASTREIO-INTERNO',
    lastTrackingUpdate: new Date('2026-10-13T12:00:00Z'),
    trackingProvider: 'PROVEDOR-INTERNO',
    trackingRef: 'REF-INTERNA',
    notes: 'OBSERVACAO-INTERNA',
    fieldSources: { carrier: { source: 'API', at: '2026-10-13T12:00:00Z', provider: 'PROVEDOR-INTERNO', by: 4242 } },
    closedAt: null,
    createdBy: 5,
    updatedBy: 5,
    ...extra,
  })
  const version: SummaryVersionInput = {
    equipment: { code: '40HC', name: "40' High Cube", service: null, tareKg: 3900, verification: 'ESTIMATED' },
    products: [{ sku: 'HS-2M-10K', name: 'Hidrosilo 2 × 10 m', kitBoxes: null, boxes: 26, units: 26, netKg: 581.62, grossKg: 760.5, unitPrice: 777.77, amount: 20222.02, currency: 'USD' }],
    totals: { pallets: 1, packages: 26, units: 26, netKg: 581.62, grossKg: 760.5, valueUsd: 20222.02, cbm: 9.9 },
  }
  const src = (o: Partial<SummarySource> = {}): SummarySource => ({
    operationId: 11,
    includeSiblings: false,
    orderRef: 'Proforma 192.26',
    customer: 'Agro Uruguay SA',
    shipment,
    unitPlanIds: [100, 101, 102],
    // fora de ordem; a 99 é de OUTRO pedido (carga 555)
    ops: [op(12, 101, { carrier: 'MSC' }), op(11, 100), op(99, 555)],
    versions: new Map([
      [100, version],
      [101, version],
    ]),
    ...o,
  })

  /** todas as chaves do objeto, em qualquer profundidade */
  const keysOf = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [])
  const FORBIDDEN_KEYS = [
    'delayed', 'incident', 'notes', 'responsibleUserId', 'paymentReceivedAt', 'confirmedAt', 'confirmedBy', 'fieldSources', 'currentLocation', 'trackingStatus', 'trackingProvider', 'trackingRef', 'lastTrackingUpdate',
    'unitPrice', 'amount', 'currency', 'valueUsd', 'tareKg', 'customerAddress', 'incoterm', 'plannedLoadingDate', 'actualLoadingDate', 'createdBy', 'updatedBy', 'closedAt', 'confirmedVersionId', 'provider', 'by',
    // condição de pagamento, CFOP e transportadora do ERP (uso interno)
    'paymentTerms', 'cfop', 'transportCompanyId', 'transportCompany', 'transportCompanyCode', 'advancePct', 'balanceWhen',
  ]
  const FORBIDDEN_VALUES = ['INTERN', '4242', '777.77', '20222', '2026-10-02', '2026-10-08', '2026-10-09', 'FOB', 'COD-ERP', 'AGAINST_DOCS']
  /** 'code' só existe no equipamento (40HC) e nas caixas de kit; em qualquer outro lugar seria código interno (ex.: do ERP) */
  const CODE_ALLOWED_UNDER = new Set(['equipment', 'kitBoxes'])
  const keysOutsideCodeOwners = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysOutsideCodeOwners) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...(CODE_ALLOWED_UNDER.has(k) ? [] : keysOutsideCodeOwners(x))]) : []

  it('nunca contém campos internos (observações, incidência, atraso, responsável, pagamento, CFOP, transportadora do ERP, valores, origens…)', () => {
    for (const includeSiblings of [false, true]) {
      const dto = trackingSummaryDto(src({ includeSiblings }))
      expect(dto).not.toBeNull()
      const keys = keysOf(dto)
      for (const k of FORBIDDEN_KEYS) expect(keys).not.toContain(k)
      expect(keysOutsideCodeOwners(dto)).not.toContain('code')
      const json = JSON.stringify(dto)
      for (const v of FORBIDDEN_VALUES) expect(json).not.toContain(v)
    }
  })

  it('só os campos permitidos, com os valores certos', () => {
    const dto = trackingSummaryDto(src())!
    expect(Object.keys(dto).sort()).toEqual(['country', 'customer', 'destinationPlace', 'operationIds', 'orderRef', 'originPlace', 'placeMode', 'service', 'unitCount', 'units'])
    expect(dto).toMatchObject({ orderRef: 'Proforma 192.26', customer: 'Agro Uruguay SA', country: 'Uruguai', service: 'FCL', placeMode: 'SEA', originPlace: 'Rio Grande', destinationPlace: 'Montevideo', unitCount: 3 })
    const u = dto.units[0]
    expect(Object.keys(u).sort()).toEqual(['containerNumber', 'dates', 'equipment', 'products', 'sealNumber', 'shipping', 'status', 'totals', 'unitIndex'])
    expect(u).toMatchObject({ unitIndex: 1, status: 'IN_TRANSIT', containerNumber: 'MSKU00000011', sealNumber: 'LACRE-11', equipment: { code: '40HC', name: "40' High Cube", service: null } })
    expect(u.shipping).toEqual({ carrier: 'Maersk', forwarder: 'Fwd Uno', bookingNumber: 'BK-1', blNumber: 'BL-1', vessel: 'MSC Ana', voyage: '123E' })
    expect(u.dates).toEqual({ etd: '2026-10-12', atd: '2026-10-13', transitDays: 5, eta: '2026-10-17', ata: null, deliveredAt: null })
    expect(u.products).toEqual([{ sku: 'HS-2M-10K', name: 'Hidrosilo 2 × 10 m', kitBoxes: null, boxes: 26, units: 26, netKg: 581.62, grossKg: 760.5 }])
    expect(u.totals).toEqual({ pallets: 1, packages: 26, units: 26, netKg: 581.62, grossKg: 760.5 })
  })

  it('sem as outras cargas: só a operação pedida', () => {
    const dto = trackingSummaryDto(src())!
    expect(dto.operationIds).toEqual([11])
    expect(dto.units.map((u) => u.containerNumber)).toEqual(['MSKU00000011'])
  })

  it('com as outras cargas: todas as do pedido (nunca de outro pedido), na ordem do pedido', () => {
    const dto = trackingSummaryDto(src({ includeSiblings: true }))!
    expect(dto.operationIds).toEqual([11, 12])
    expect(dto.units.map((u) => u.unitIndex)).toEqual([1, 2])
    expect(dto.units.map((u) => u.containerNumber)).toEqual(['MSKU00000011', 'MSKU00000012'])
    // pedida a partir da 2ª carga: mesma ordem (do pedido)
    expect(trackingSummaryDto(src({ includeSiblings: true, operationId: 12 }))!.operationIds).toEqual([11, 12])
  })

  it('dados do embarque iguais × diferentes entre as cargas (sameForAllUnits)', () => {
    const dto = trackingSummaryDto(src({ includeSiblings: true }))!
    // o armador difere (Maersk × MSC); as datas e a etapa são iguais; o contêiner é sempre por carga
    expect(sameForAllUnits(dto.units, (u) => u.shipping)).toBe(false)
    expect(sameForAllUnits(dto.units, (u) => u.dates)).toBe(true)
    expect(sameForAllUnits(dto.units, (u) => u.status)).toBe(true)
    expect(sameForAllUnits(dto.units, (u) => u.containerNumber)).toBe(false)
    expect(sameForAllUnits(dto.units.slice(0, 1), (u) => u.shipping)).toBe(true)
  })

  it('operação de outro pedido ou inexistente: null', () => {
    expect(trackingSummaryDto(src({ operationId: 99 }))).toBeNull()
    expect(trackingSummaryDto(src({ operationId: 12345 }))).toBeNull()
  })

  it('carga sem versão aprovada: sem produtos, totais e equipamento', () => {
    const dto = trackingSummaryDto(src({ versions: new Map() }))!
    expect(dto.units[0]).toMatchObject({ products: [], totals: null, equipment: null })
  })

  it('ETA calculada quando falta (ETD + trânsito); textos vazios viram null; tipo do envio dá os rótulos de origem/destino', () => {
    const dto = trackingSummaryDto(
      src({
        shipment: { ...shipment, service: 'ROAD_LTL', mode: 'ROAD', originPlace: '  ', destinationPlace: null },
        ops: [op(11, 100, { eta: null, etd: '2026-10-20', transitDays: 3, carrier: '  ', status: 'CANCELLED' })],
      }),
    )!
    expect(dto.units[0].dates.eta).toBe('2026-10-23')
    expect(dto.units[0].shipping.carrier).toBeNull()
    expect(dto.units[0].status).toBe('CANCELLED')
    expect(dto).toMatchObject({ service: 'ROAD_LTL', placeMode: 'ROAD', originPlace: null, destinationPlace: null })
  })

  it('trânsito não informado: ETA − ETD (como na tela); informado prevalece; ETA antes da ETD = sem trânsito', () => {
    const only = (extra: Partial<SummaryOpRow>) => trackingSummaryDto(src({ ops: [op(11, 100, extra)] }))!.units[0].dates
    expect(only({ transitDays: null, etd: '2026-10-20', eta: '2026-10-25' })).toMatchObject({ etd: '2026-10-20', eta: '2026-10-25', transitDays: 5 })
    expect(only({ transitDays: 7, etd: '2026-10-20', eta: '2026-10-25' }).transitDays).toBe(7)
    expect(only({ transitDays: null, etd: '2026-10-25', eta: '2026-10-20' }).transitDays).toBeNull()
    expect(only({ transitDays: null, etd: null, eta: '2026-10-25' }).transitDays).toBeNull()
  })
})

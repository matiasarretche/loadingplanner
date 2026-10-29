'use client'

/**
 * EXPORTAÇÕES EM CURSO — painel diário: indicadores clicáveis (filtros rápidos), busca, filtros, lista
 * ordenável (mais urgentes primeiro) e aba Histórico (finalizadas/canceladas) com período e CSV.
 * No celular a lista vira cartões compactos. Dias restantes, alertas e "próximas" vêm do núcleo
 * @/domain/exportTracking, sempre com o "hoje" do servidor (prop today) para a hidratação não divergir.
 */
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Avatar } from '@/components/Avatar'
import { Icon, IconName } from '@/components/Icons'
import { nf0 } from '@/components/format'
import { EXPORT_STATUS_LABEL, EXPORT_STATUS_SHORT, EXPORT_STATUSES, ExportStatus, fmtDate, isActiveStatus, nextEvent, remainingLabel, todayBR, TRACKING_TZ, trackingSituation, TrackingSituation } from '@/domain/exportTracking'
import { TYPE_INFO } from '@/domain/shipmentType'
import { flagUrl } from '@/lib/countries'
import type { ExportRow } from './types'

type Tab = 'active' | 'history'
/** atalhos do painel (clicar filtra a lista) */
type Quick = 'pending' | 'soonLoad' | 'transit' | 'soonArrive' | 'late' | 'incident' | 'arrivedMonth'
type PeriodBy = 'confirmedAt' | 'ata'
interface Item {
  r: ExportRow
  s: TrackingSituation
}
interface Filters {
  q: string
  customer: string
  country: string
  status: string
  /** id do responsável, 'none' = sem responsável */
  resp: string
  from: string
  to: string
  quick: Quick | ''
}
const EMPTY: Filters = { q: '', customer: '', country: '', status: '', resp: '', from: '', to: '', quick: '' }
interface Sort {
  key: string
  dir: 1 | -1
}
const DEFAULT_SORT: Record<Tab, Sort> = { active: { key: 'remaining', dir: 1 }, history: { key: 'closedAt', dir: -1 } }
/** linhas desenhadas de cada vez ("Mostrar mais") */
const PAGE = 100
const MOBILE_Q = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)'
const LS_PERIOD = 'lp:exp:periodBy'

const PENDING: ExportStatus[] = ['CONFIRMED', 'IN_PRODUCTION', 'LOADING_SCHEDULED']
const ACTIVE_STATUSES = EXPORT_STATUSES.filter(isActiveStatus)
const CLOSED_STATUSES = EXPORT_STATUSES.filter((s) => !isActiveStatus(s))

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

const fmtWhen = new Intl.DateTimeFormat('pt-BR', { timeZone: TRACKING_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const fmtDay = new Intl.DateTimeFormat('pt-BR', { timeZone: TRACKING_TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
/** instante ISO → "13/10/2026 14:03" (São Paulo) */
const when = (iso: string | null) => (iso ? fmtWhen.format(new Date(iso)).replace(',', '') : '—')
/** instante ISO → "13/10/2026" (São Paulo) */
const dayOf = (iso: string | null) => (iso ? fmtDay.format(new Date(iso)) : '—')
/** 'YYYY-MM-DD' → "13/10" (cartões do celular) */
const dm = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '—')
/** busca sem acento e sem maiúsculas */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* sem armazenamento: só não lembra a preferência */
  }
}

function subscribeMobile(cb: () => void) {
  const m = window.matchMedia(MOBILE_Q)
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}
/** celular/tablet: cartões em vez da tabela larga (no servidor e na hidratação: tabela) */
function useMobile() {
  return useSyncExternalStore(subscribeMobile, () => window.matchMedia(MOBILE_Q).matches, () => false)
}

// ---------------------------------------------------------------------------
// Filtros, atalhos e urgência
// ---------------------------------------------------------------------------

function quickTest(q: Quick, { r, s }: Item, month: string): boolean {
  if (q === 'pending') return PENDING.includes(r.status)
  if (q === 'soonLoad') return s.soonToLoad
  if (q === 'transit') return r.status === 'IN_TRANSIT'
  if (q === 'soonArrive') return s.soonToArrive
  if (q === 'late') return s.late
  if (q === 'incident') return Boolean(r.incident)
  return Boolean(r.ata?.startsWith(month))
}

function matches({ r }: Item, f: Filters, tab: Tab, periodBy: PeriodBy): boolean {
  const q = norm(f.q.trim())
  if (q) {
    const hay = norm(`${r.customer} ${r.orderRef ?? ''} ${r.planName} ${r.bookingNumber ?? ''} ${r.blNumber ?? ''} ${r.containerNumber ?? ''} ${r.country} ${r.transportCompany ?? ''} ${r.cfop ?? ''}`)
    // contêiner/booking digitados com espaço ("MSCU 123…") também encontram
    if (!hay.includes(q) && !hay.replace(/\s/g, '').includes(q.replace(/\s/g, ''))) return false
  }
  if (f.customer && r.customer !== f.customer) return false
  if (f.country && r.country !== f.country) return false
  if (f.status && r.status !== f.status) return false
  if (f.resp && (f.resp === 'none' ? r.responsibleUserId != null : String(r.responsibleUserId) !== f.resp)) return false
  if (tab === 'history' && (f.from || f.to)) {
    const d = periodBy === 'ata' ? r.ata : r.confirmedAt
    if (!d || (f.from && d < f.from) || (f.to && d > f.to)) return false
  }
  return true
}

/** ordem "mais urgentes primeiro": alertas (mais dias vencidos antes), depois a data mais próxima (o mesmo evento de "Dias restantes") */
function urgency({ r, s }: Item): number {
  if (s.alerts.length) return -1_000_000 - Math.max(...s.alerts.map((a) => a.days))
  const d = nextEvent(s)?.days
  if (d != null) return d
  return r.delayed || r.incident ? 999_999 : 1_000_000
}

// ---------------------------------------------------------------------------
// Células
// ---------------------------------------------------------------------------

function Flag({ country }: { country: string }) {
  const url = flagUrl(country)
  return (
    <span className="dash-country">
      {url ? <span className="flag" style={{ backgroundImage: `url(${url})` }} aria-hidden /> : <Icon name="globe" size={14} />}
      {country}
    </span>
  )
}

const modeIcon = (r: ExportRow): IconName => {
  const m = TYPE_INFO[r.service].mode
  return m === 'SEA' ? 'ship' : m === 'ROAD' ? 'truck' : m === 'AIR' ? 'plane' : 'box'
}

function Remaining({ s }: { s: TrackingSituation }) {
  const text = remainingLabel(s)
  const cls = s.alerts.length ? 'exp-alert' : s.soonToLoad || s.soonToArrive ? 'exp-soon' : text === '—' ? 'muted' : undefined
  return (
    <span className={cls} title={s.alerts.length ? s.alerts.map((a) => a.text).join('\n') : undefined}>
      {text}
      {s.alerts.length > 1 ? ` (+${s.alerts.length - 1})` : ''}
    </span>
  )
}

function StatusPills({ r, s }: Item) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      <span className={`pill exp-${r.status}`} title={EXPORT_STATUS_LABEL[r.status]}>
        {EXPORT_STATUS_SHORT[r.status]}
      </span>
      {s.late && (
        <span className="pill exp-late" title={s.alerts.length ? s.alerts.map((a) => a.text).join('\n') : 'Marcada como atrasada'}>
          Atrasado
        </span>
      )}
      {r.incident && (
        <span className="pill exp-incident" title={r.incident}>
          Incidência
        </span>
      )}
    </span>
  )
}

/** data prevista com a real embaixo ("real 14/10/2026") */
function DateCell({ planned, actual, actualLabel }: { planned: string | null; actual: string | null; actualLabel: string }) {
  return (
    <span className="dash-date" style={{ display: 'inline-flex', flexDirection: 'column' }}>
      <span className={planned ? undefined : 'muted'}>{fmtDate(planned)}</span>
      {actual && (
        <small style={{ color: 'var(--ok)' }}>
          {actualLabel} {fmtDate(actual)}
        </small>
      )}
    </span>
  )
}

function OrderCell({ r }: { r: ExportRow }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {r.responsibleName && <Avatar avatar={r.responsibleAvatar} name={r.responsibleName} size={20} title={`Responsável: ${r.responsibleName}`} />}
      <span style={{ display: 'inline-flex', flexDirection: 'column', minWidth: 0 }}>
        <Link href={`/exportacoes/${r.id}`} className="dash-plan">
          {r.orderRef ?? r.planName}
        </Link>
        <small className="muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[r.planName, r.cfop && `CFOP ${r.cfop}`, r.paymentTerms && `Condição de pagamento: ${r.paymentTerms}`].filter(Boolean).join('\n')}>
          {r.orderRef ? `${r.planName} · ` : ''}
          {TYPE_INFO[r.service].short} · {r.incoterm}
          {r.cfop ? ` · CFOP ${r.cfop}` : ''}
        </small>
        {r.transportCompany && (
          <small className="muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`Transportadora: ${r.transportCompany}`}>
            <Icon name="truck" size={12} /> {r.transportCompany}
          </small>
        )}
      </span>
    </span>
  )
}

function ContainerCell({ r }: { r: ExportRow }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
      {r.containerNumber ? (
        <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'nowrap' }}>{r.containerNumber}</span>
      ) : (
        <span className="muted" title="Nº do contêiner/placa ainda não informado — equipamento da carga aprovada">
          {r.equipment ?? '—'}
        </span>
      )}
      {r.unitIndex != null && r.unitCount > 1 && (
        <small className="muted" style={{ whiteSpace: 'nowrap' }}>
          unidade {r.unitIndex}/{r.unitCount}
        </small>
      )}
    </span>
  )
}

function Updated({ r }: { r: ExportRow }) {
  return (
    <span className="dash-date" style={{ display: 'inline-flex', flexDirection: 'column' }}>
      <span>{when(r.updatedAt)}</span>
      <small className="muted">{r.updatedByName ?? '—'}</small>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Colunas (tabela, ordenação e CSV)
// ---------------------------------------------------------------------------

interface Col {
  key: string
  label: string
  num?: boolean
  /** primeiro clique ordena do maior para o menor (datas recentes primeiro) */
  desc?: boolean
  /** null = sempre no fim */
  sort?: (x: Item) => string | number | null
  cell: (x: Item) => ReactNode
  csv: (x: Item) => string | number
}

const statusCsv = ({ r, s }: Item) => [EXPORT_STATUS_LABEL[r.status], s.late ? 'Atrasado' : '', r.incident ? `Incidência: ${r.incident}` : ''].filter(Boolean).join(' · ')

const COMMON_HEAD: Col[] = [
  { key: 'order', label: 'Pedido', sort: ({ r }) => norm(r.orderRef ?? r.planName), cell: ({ r }) => <OrderCell r={r} />, csv: ({ r }) => r.orderRef ?? '' },
  { key: 'customer', label: 'Cliente', sort: ({ r }) => norm(r.customer), cell: ({ r }) => r.customer, csv: ({ r }) => r.customer },
  { key: 'country', label: 'País', sort: ({ r }) => norm(r.country), cell: ({ r }) => <Flag country={r.country} />, csv: ({ r }) => r.country },
  {
    key: 'container',
    label: 'Contêiner',
    sort: ({ r }) => r.containerNumber ?? null,
    cell: ({ r }) => <ContainerCell r={r} />,
    csv: ({ r }) => `${r.containerNumber ?? r.equipment ?? ''}${r.unitIndex != null && r.unitCount > 1 ? ` (unidade ${r.unitIndex}/${r.unitCount})` : ''}`,
  },
  { key: 'status', label: 'Status', sort: ({ r }) => EXPORT_STATUSES.indexOf(r.status), cell: (x) => <StatusPills {...x} />, csv: statusCsv },
]
const UPDATED: Col = { key: 'updated', label: 'Última atualização', desc: true, sort: ({ r }) => r.updatedAt, cell: ({ r }) => <Updated r={r} />, csv: ({ r }) => `${when(r.updatedAt)}${r.updatedByName ? ` · ${r.updatedByName}` : ''}` }

const ACTIVE_COLS: Col[] = [
  ...COMMON_HEAD,
  {
    key: 'loading',
    label: 'Carregamento previsto',
    sort: ({ r }) => r.plannedLoadingDate,
    cell: ({ r }) => <DateCell planned={r.plannedLoadingDate} actual={r.actualLoadingDate} actualLabel="real" />,
    csv: ({ r }) => (r.plannedLoadingDate ? fmtDate(r.plannedLoadingDate) : ''),
  },
  { key: 'etd', label: 'ETD', sort: ({ r }) => r.etd, cell: ({ r }) => <DateCell planned={r.etd} actual={r.atd} actualLabel="saiu" />, csv: ({ r }) => (r.etd ? fmtDate(r.etd) : '') },
  {
    key: 'transit',
    label: 'Trânsito (dias)',
    num: true,
    sort: ({ r, s }) => r.transitDays ?? s.transit,
    cell: ({ r, s }) => {
      const t = r.transitDays ?? s.transit
      return t == null ? <span className="muted">—</span> : nf0.format(t)
    },
    csv: ({ r, s }) => r.transitDays ?? s.transit ?? '',
  },
  { key: 'eta', label: 'ETA', sort: ({ r }) => r.eta, cell: ({ r }) => <DateCell planned={r.eta} actual={r.ata} actualLabel="chegou" />, csv: ({ r }) => (r.eta ? fmtDate(r.eta) : '') },
  { key: 'remaining', label: 'Dias restantes', sort: urgency, cell: ({ s }) => <Remaining s={s} />, csv: ({ s }) => remainingLabel(s) },
  UPDATED,
]

const HISTORY_COLS: Col[] = [
  ...COMMON_HEAD,
  { key: 'confirmedAt', label: 'Confirmação', desc: true, sort: ({ r }) => r.confirmedAt, cell: ({ r }) => <span className="dash-date">{fmtDate(r.confirmedAt)}</span>, csv: ({ r }) => fmtDate(r.confirmedAt) },
  { key: 'atd', label: 'Saída real (ATD)', desc: true, sort: ({ r }) => r.atd, cell: ({ r }) => <span className={`dash-date${r.atd ? '' : ' muted'}`}>{fmtDate(r.atd)}</span>, csv: ({ r }) => (r.atd ? fmtDate(r.atd) : '') },
  { key: 'ata', label: 'Chegada real (ATA)', desc: true, sort: ({ r }) => r.ata, cell: ({ r }) => <span className={`dash-date${r.ata ? '' : ' muted'}`}>{fmtDate(r.ata)}</span>, csv: ({ r }) => (r.ata ? fmtDate(r.ata) : '') },
  { key: 'closedAt', label: 'Encerrada em', desc: true, sort: ({ r }) => r.closedAt, cell: ({ r }) => <span className="dash-date">{dayOf(r.closedAt)}</span>, csv: ({ r }) => (r.closedAt ? dayOf(r.closedAt) : '') },
  UPDATED,
]

/** colunas só do CSV (ajudam no Excel; na tela ficam no detalhe) */
const CSV_EXTRA: { label: string; csv: (x: Item) => string | number }[] = [
  { label: 'Carga', csv: ({ r }) => r.planName },
  { label: 'Tipo', csv: ({ r }) => TYPE_INFO[r.service].short },
  { label: 'Incoterm', csv: ({ r }) => r.incoterm },
  { label: 'CFOP', csv: ({ r }) => r.cfop ?? '' },
  { label: 'Transportadora (ERP)', csv: ({ r }) => r.transportCompany ?? '' },
  { label: 'Condição de pagamento', csv: ({ r }) => r.paymentTerms ?? '' },
  { label: 'Booking', csv: ({ r }) => r.bookingNumber ?? '' },
  { label: 'BL', csv: ({ r }) => r.blNumber ?? '' },
  { label: 'Lacre', csv: ({ r }) => r.sealNumber ?? '' },
  { label: 'Navio / veículo', csv: ({ r }) => [r.vessel, r.voyage].filter(Boolean).join(' / ') },
  { label: 'Armador / transportadora', csv: ({ r }) => r.carrier ?? '' },
  { label: 'Responsável', csv: ({ r }) => r.responsibleName ?? '' },
  { label: 'Pagamento recebido', csv: ({ r }) => (r.paymentReceivedAt ? fmtDate(r.paymentReceivedAt) : '') },
]

function sortItems(list: Item[], cols: Col[], sort: Sort): Item[] {
  const c = cols.find((x) => x.key === sort.key)
  if (!c?.sort) return list
  const g = c.sort
  return [...list].sort((a, b) => {
    const x = g(a)
    const y = g(b)
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
    const d = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, 'pt-BR') : Number(x) - Number(y)
    return d * sort.dir
  })
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

type Tone = 'crit' | 'warn' | 'info' | 'ok'

export function ExportsClient({ active, history, today, initialTab }: { active: ExportRow[]; history: ExportRow[]; today: string; initialTab: Tab }) {
  const router = useRouter()
  const mobile = useMobile()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [f, setF] = useState<Filters>(EMPTY)
  const [sorts, setSorts] = useState<Record<Tab, Sort>>(DEFAULT_SORT)
  const [periodBy, setPeriodBy] = useState<PeriodBy>('confirmedAt')
  const [limit, setLimit] = useState(PAGE)

  // preferência do navegador: base do período no histórico
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- leitura única do localStorage após a hidratação
    if (read(LS_PERIOD) === 'ata') setPeriodBy('ata')
  }, [])

  const month = today.slice(0, 7)
  const monthName = useMemo(() => new Date(`${today}T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' }), [today])
  const aItems = useMemo(() => active.map((r) => ({ r, s: trackingSituation(r, today) })), [active, today])
  const hItems = useMemo(() => history.map((r) => ({ r, s: trackingSituation(r, today) })), [history, today])

  const cols = tab === 'active' ? ACTIVE_COLS : HISTORY_COLS
  const sort = sorts[tab]
  const source = useMemo(() => (tab === 'history' ? hItems : f.quick === 'arrivedMonth' ? [...aItems, ...hItems] : aItems), [tab, f.quick, aItems, hItems])
  const tabRows = tab === 'history' ? hItems : aItems

  const filtered = useMemo(
    () => source.filter((x) => matches(x, f, tab, periodBy) && (tab === 'history' || !f.quick || quickTest(f.quick, x, month))),
    [source, f, tab, periodBy, month],
  )
  const sorted = useMemo(() => sortItems(filtered, cols, sort), [filtered, cols, sort])
  const shown = sorted.slice(0, limit)

  // indicadores: contagens com os demais filtros (sem o próprio atalho); "Chegadas este mês" inclui o histórico
  const baseActive = useMemo(() => aItems.filter((x) => matches(x, f, 'active', periodBy)), [aItems, f, periodBy])
  const baseClosed = useMemo(() => hItems.filter((x) => matches(x, f, 'active', periodBy)), [hItems, f, periodBy])
  const count = (q: Quick | '') => (q === '' ? baseActive.length : q === 'arrivedMonth' ? [...baseActive, ...baseClosed].filter((x) => quickTest(q, x, month)).length : baseActive.filter((x) => quickTest(q, x, month)).length)

  // opções das duas abas juntas: o filtro escolhido continua válido ao trocar de aba
  const allRows = useMemo(() => [...active, ...history], [active, history])
  const customers = useMemo(() => [...new Set(allRows.map((r) => r.customer))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [allRows])
  const countries = useMemo(() => [...new Set(allRows.map((r) => r.country))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [allRows])
  const responsibles = useMemo(() => {
    const m = new Map<number, string>()
    for (const r of allRows) if (r.responsibleUserId != null) m.set(r.responsibleUserId, r.responsibleName ?? `#${r.responsibleUserId}`)
    const list = [...m].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')).map(([id, name]) => ({ value: String(id), label: name }))
    return allRows.some((r) => r.responsibleUserId == null) ? [...list, { value: 'none', label: 'Sem responsável' }] : list
  }, [allRows])

  const set = (k: keyof Filters, v: string) => {
    setF((x) => ({ ...x, [k]: v }))
    setLimit(PAGE)
  }
  const anyFilter = Object.values(f).some(Boolean)
  const sortDefault = sort.key === DEFAULT_SORT[tab].key && sort.dir === DEFAULT_SORT[tab].dir
  const setSort = (s: Sort) => setSorts((x) => ({ ...x, [tab]: s }))

  function switchTab(t: Tab) {
    if (t === tab) return
    setTab(t)
    // status e atalho valem só numa aba; busca, cliente, país e responsável continuam
    setF((x) => ({ ...x, status: '', quick: '' }))
    setLimit(PAGE)
    try {
      window.history.replaceState(null, '', t === 'history' ? '?aba=historico' : window.location.pathname)
    } catch {
      /* só não atualiza o endereço */
    }
  }

  function exportCsv() {
    const esc = (v: string | number) => {
      const s = typeof v === 'number' ? String(v).replace('.', ',') : v
      return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const head = [...cols.map((c) => c.label), ...CSV_EXTRA.map((c) => c.label)]
    const lines = [head, ...sorted.map((x) => [...cols.map((c) => c.csv(x)), ...CSV_EXTRA.map((c) => c.csv(x))])].map((l) => l.map(esc).join(';'))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    a.download = `exportacoes-${todayBR()}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }

  const cards: { q: Quick | ''; icon: IconName; label: string; sub: string; zero?: string; tone: Tone }[] = [
    { q: '', icon: 'box', label: 'Ativas', sub: 'operações em curso', zero: 'nenhuma em curso', tone: 'ok' },
    { q: 'pending', icon: 'calendar', label: 'Pendentes de carga', sub: 'confirmadas, em produção ou programadas', tone: 'info' },
    { q: 'soonLoad', icon: 'truck', label: 'Próximas a carregar', sub: 'carregamento previsto chegando', tone: 'warn' },
    { q: 'transit', icon: 'ship', label: 'Em trânsito', sub: 'a caminho do destino', tone: 'info' },
    { q: 'soonArrive', icon: 'globe', label: 'Próximas a chegar', sub: 'ETA chegando', tone: 'warn' },
    { q: 'late', icon: 'alert', label: 'Atrasadas', sub: 'data vencida ou marcadas', zero: 'tudo em dia', tone: 'crit' },
    { q: 'incident', icon: 'review', label: 'Com incidência', sub: 'incidência registrada', zero: 'nenhuma aberta', tone: 'crit' },
    { q: 'arrivedMonth', icon: 'check', label: 'Chegadas este mês', sub: `chegada real em ${monthName} (inclui finalizadas)`, tone: 'ok' },
  ]
  const quickLabel = cards.find((c) => c.q && c.q === f.quick)?.label

  if (!active.length && !history.length)
    return (
      <div className="dash">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <h1>Exportações em curso</h1>
        </div>
        <section className="dash-list" style={{ padding: '28px 20px', textAlign: 'center' }}>
          <Icon name="ship" size={36} style={{ color: 'var(--brand)' }} />
          <h2 style={{ margin: '8px 0 6px', fontSize: 18 }}>Nenhuma exportação em curso ainda</h2>
          <p className="muted" style={{ margin: '0 auto', maxWidth: 560 }}>
            As cargas aparecem aqui quando o pedido do cliente é confirmado: abra uma carga de exportação <strong>aprovada</strong> e use <strong>“Confirmar pedido”</strong>. A partir daí a equipe acompanha
            produção, carregamento, embarque e chegada nesta tela.
          </p>
          <Link className="btn" href="/" style={{ marginTop: 14 }}>
            Ir para as cargas
          </Link>
        </section>
      </div>
    )

  return (
    <div className="dash">
      <div className="page-head" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
        <h1>Exportações em curso</h1>
        <div className="dash-seg" role="tablist" aria-label="Exportações">
          {(['active', 'history'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => switchTab(t)}>
              {t === 'active' ? 'Em curso' : 'Histórico'} <small className="muted">{t === 'active' ? active.length : history.length}</small>
            </button>
          ))}
        </div>
      </div>

      {tab === 'active' && (
        <section className="dash-track" aria-label="Indicadores" style={{ gridTemplateColumns: mobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))', gap: mobile ? 8 : 10 }}>
          {cards.map((c) => {
            const n = count(c.q)
            const on = f.quick === c.q
            return (
              <button
                key={c.q || 'all'}
                className={`dash-track-card tone-${c.tone} ${on ? 'on' : ''} ${n ? '' : 'zero'}`}
                style={mobile ? { padding: '8px 10px', gap: 8 } : undefined}
                aria-pressed={on}
                onClick={() => {
                  setF((x) => ({ ...x, quick: c.q === '' || on ? '' : c.q }))
                  setLimit(PAGE)
                }}
                title={c.q === '' ? 'Mostrar todas as operações em curso' : on ? 'Clique para mostrar todas' : `${c.sub} — clique para filtrar a lista`}
              >
                {!mobile && (
                  <span className="dash-track-icon">
                    <Icon name={c.icon} size={20} />
                  </span>
                )}
                <span className="dash-track-body">
                  <span className="dash-track-label">{c.label}</span>
                  {!mobile && <span className="dash-track-sub">{n ? c.sub : c.zero ?? c.sub}</span>}
                </span>
                <span className="dash-track-n">{n}</span>
              </button>
            )
          })}
        </section>
      )}

      <section className="dash-filters">
        <label className="dash-search">
          <Icon name="search" size={17} />
          <input value={f.q} onChange={(e) => set('q', e.target.value)} placeholder="Buscar cliente, proforma, booking, BL, contêiner, carga…" aria-label="Buscar" />
        </label>
        <FilterSelect icon="list" label="Cliente" value={f.customer} onChange={(v) => set('customer', v)} options={customers.map((c) => ({ value: c, label: c }))} />
        <FilterSelect icon="globe" label="País" value={f.country} onChange={(v) => set('country', v)} options={countries.map((c) => ({ value: c, label: c }))} />
        <FilterSelect icon="status" label="Status" value={f.status} onChange={(v) => set('status', v)} options={(tab === 'active' ? ACTIVE_STATUSES : CLOSED_STATUSES).map((s) => ({ value: s, label: EXPORT_STATUS_LABEL[s] }))} />
        <FilterSelect icon="review" label="Responsável" value={f.resp} onChange={(v) => set('resp', v)} options={responsibles} />
        {tab === 'history' && (
          <div className={`dash-filter dash-period ${f.from || f.to ? 'on' : ''}`}>
            <Icon name="calendar" size={17} />
            <div>
              <small>
                Período por{' '}
                <select
                  value={periodBy}
                  onChange={(e) => {
                    const v = e.target.value === 'ata' ? 'ata' : 'confirmedAt'
                    setPeriodBy(v)
                    write(LS_PERIOD, v)
                    setLimit(PAGE)
                  }}
                  aria-label="Data usada no período"
                  style={{ display: 'inline', width: 'auto', fontSize: 10, padding: 0 }}
                >
                  <option value="confirmedAt">confirmação</option>
                  <option value="ata">chegada real</option>
                </select>
              </small>
              <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="De" />
                <span className="muted">a</span>
                <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="Até" />
              </div>
            </div>
          </div>
        )}
        <button
          className="dash-clear"
          onClick={() => {
            setF(EMPTY)
            setLimit(PAGE)
          }}
          disabled={!anyFilter}
        >
          <Icon name="filter" size={16} /> Limpar filtros
        </button>
      </section>

      <section className="dash-list">
        <div className="dash-list-head">
          <div className="dash-list-title">
            <Icon name={tab === 'active' ? 'ship' : 'list'} size={18} /> {tab === 'active' ? quickLabel ?? 'Operações em curso' : 'Histórico (finalizadas e canceladas)'}
            <small className="muted">{filtered.length !== tabRows.length || f.quick ? `${filtered.length} de ${tab === 'active' && f.quick === 'arrivedMonth' ? source.length : tabRows.length}` : `${tabRows.length}`}</small>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {mobile && (
              <div className="row" style={{ gap: 6, fontSize: 13, flexWrap: 'nowrap' }}>
                <span className="muted">Ordem</span>
                <select
                  aria-label="Ordenar por"
                  value={sort.key}
                  onChange={(e) => {
                    const c = cols.find((x) => x.key === e.target.value)
                    if (c) setSort({ key: c.key, dir: c.desc ? -1 : 1 })
                  }}
                >
                  {cols
                    .filter((c) => c.sort)
                    .map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.key === 'remaining' ? 'Mais urgentes' : c.label}
                      </option>
                    ))}
                </select>
                <button className="small" onClick={() => setSort({ key: sort.key, dir: sort.dir === 1 ? -1 : 1 })} aria-label="Inverter a ordem">
                  {sort.dir === 1 ? '▲' : '▼'}
                </button>
              </div>
            )}
            {!mobile && !sortDefault && (
              <button className="small" onClick={() => setSort(DEFAULT_SORT[tab])} title="Voltar à ordem padrão">
                ↺ {tab === 'active' ? 'Mais urgentes primeiro' : 'Encerradas recentes primeiro'}
              </button>
            )}
            <button onClick={exportCsv} disabled={!sorted.length} title="CSV das linhas filtradas (abre no Excel)">
              <Icon name="download" size={16} /> Exportar
            </button>
          </div>
        </div>

        {mobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10 }}>
            {shown.map((x) => (
              <OpCard key={x.r.id} x={x} history={tab === 'history'} />
            ))}
            {!shown.length && <Empty tab={tab} hasRows={tabRows.length > 0} />}
          </div>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      className={`${c.num ? 'num' : ''} ${c.sort ? 'sortable' : ''}`}
                      style={c.num ? { textAlign: 'right' } : undefined}
                      aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                      onClick={() => c.sort && setSort(sort.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.desc ? -1 : 1 })}
                    >
                      {c.label}
                      {c.sort && <span className={`sort ${sort.key === c.key ? 'on' : ''}`}>{sort.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr
                    key={x.r.id}
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                      // o link do pedido já navega (e abre em nova aba com Ctrl/⌘)
                      if ((e.target as HTMLElement).closest('a')) return
                      router.push(`/exportacoes/${x.r.id}`)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) router.push(`/exportacoes/${x.r.id}`)
                    }}
                  >
                    {cols.map((c) => (
                      <td key={c.key} className={c.num ? 'num' : ''} style={c.num ? { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } : undefined}>
                        {c.cell(x)}
                      </td>
                    ))}
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={cols.length} style={{ padding: 0 }}>
                      <Empty tab={tab} hasRows={tabRows.length > 0} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {sorted.length > shown.length && (
          <div className="dash-pager" style={{ justifyContent: 'center' }}>
            <span className="muted">
              Mostrando {shown.length} de {sorted.length}
            </span>
            <button className="small" onClick={() => setLimit((n) => n + PAGE)}>
              Mostrar mais
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function Empty({ tab, hasRows }: { tab: Tab; hasRows: boolean }) {
  return (
    <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
      {hasRows
        ? 'Nenhuma operação com esses filtros.'
        : tab === 'active'
          ? 'Nenhuma exportação em curso agora. Use “Confirmar pedido” numa carga de exportação aprovada para começar o seguimento.'
          : 'Nenhuma operação finalizada ou cancelada ainda.'}
    </div>
  )
}

function FilterSelect({ icon, label, value, onChange, options }: { icon: IconName; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className={`dash-filter ${value ? 'on' : ''}`}>
      <Icon name={icon} size={17} />
      <div>
        <small>{label}</small>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Todos</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </label>
  )
}

/** cartão compacto do celular (toque abre o seguimento) */
function OpCard({ x, history }: { x: Item; history: boolean }) {
  const { r, s } = x
  const done = (d: string | null) => (d ? ' ✓' : '')
  return (
    <Link href={`/exportacoes/${r.id}`} className="dash-card">
      <div className="dash-card-top">
        <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.orderRef ?? r.planName}</strong>
        {r.unitIndex != null && r.unitCount > 1 && (
          <span className="dash-chip" title="Unidade do pedido">
            {r.unitIndex}/{r.unitCount}
          </span>
        )}
        <span className="spacer" />
        <span className={`pill exp-${r.status}`}>{EXPORT_STATUS_SHORT[r.status]}</span>
      </div>
      <div className="dash-card-meta">
        {r.customer} · <Flag country={r.country} />
      </div>
      <div className="dash-card-meta">
        <Icon name={modeIcon(r)} size={14} />
        {r.containerNumber ? <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', color: 'var(--text)' }}>{r.containerNumber}</span> : <span>{r.equipment ?? TYPE_INFO[r.service].short}</span>}
        {r.bookingNumber ? <span>· Booking {r.bookingNumber}</span> : null}
      </div>
      <div className="dash-card-nums" style={{ flexWrap: 'wrap' }}>
        {history ? (
          <>
            <span>Conf. {dm(r.confirmedAt)}</span>
            <span>Saída {dm(r.atd)}</span>
            <span>Chegada {dm(r.ata)}</span>
          </>
        ) : (
          <>
            <span title={r.actualLoadingDate ? 'Carregamento real' : 'Carregamento previsto'}>
              Carreg. {dm(r.actualLoadingDate ?? r.plannedLoadingDate)}
              {done(r.actualLoadingDate)}
            </span>
            <span title={r.atd ? 'Saída real' : 'ETD'}>
              {r.atd ? 'Saída' : 'ETD'} {dm(r.atd ?? r.etd)}
              {done(r.atd)}
            </span>
            <span title={r.ata ? 'Chegada real' : 'ETA'}>
              {r.ata ? 'Chegada' : 'ETA'} {dm(r.ata ?? r.eta)}
              {done(r.ata)}
            </span>
          </>
        )}
      </div>
      {!history && (s.late || r.incident || remainingLabel(s) !== '—') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6, fontSize: 13 }}>
          <Remaining s={s} />
          {s.late && <span className="pill exp-late">Atrasado</span>}
          {r.incident && <span className="pill exp-incident">Incidência</span>}
        </div>
      )}
      <div className="dash-card-foot muted">
        {r.responsibleName && <Avatar avatar={r.responsibleAvatar} name={r.responsibleName} size={16} />}
        atualizado {when(r.updatedAt)}
        {r.updatedByName ? ` · ${r.updatedByName}` : ''}
      </div>
    </Link>
  )
}

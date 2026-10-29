'use client'

import type { ShipmentService } from '@/domain/shipmentType'
import { EXPORT_STATUS_LABEL, EXPORT_STATUS_SHORT, todayBR, type ExportStatus } from '@/domain/exportTracking'

/**
 * Página principal — Cargas de exportação: faixa de marca, indicadores (do conjunto filtrado, com
 * comparação ao período anterior quando há período escolhido), atalho do Assistente IA, filtros,
 * lista com colunas personalizáveis / ordenação / paginação / exportação CSV e vista em tablero por status.
 */
import { ATTACH_ACCEPT, ATTACH_HINT, fileIcon, MAX_ATTACH, pastedImages, setPendingIntake, shrinkImage } from '@/components/intake/attach'
import { DictationButton } from '@/components/DictationButton'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { orderRefLabel } from '@/lib/orderRef'
import { deletePlanAction, newVersionAction, submitForReviewAction } from '@/app/cargas/actions'
import { Icon, IconName } from '@/components/Icons'
import { dayBR, dt, nf0, nf1 } from '@/components/format'
import { flagUrl } from '@/lib/countries'
import { Area, AREA_LABEL } from '@/lib/areas'
import { AvatarRef } from '@/lib/avatar'
import { Avatar } from '@/components/Avatar'

export interface DashRow {
  id: number
  name: string
  customer: string
  country: string
  orderRef: string | null
  /** transportadora da carga ("Nome · cód. 12", transportCompanyLabel) */
  transportCompany: string | null
  incoterm: string
  /** CFOP do pedido ("7.101"); null = não informado ou usuário sem acesso a preços (Expedição) */
  cfop: string | null
  /** condição de pagamento em português (paymentTermsText); null = não informada ou usuário sem acesso a preços */
  paymentTerms: string | null
  /** tipo de envio */
  mode: ShipmentService
  equipment: string
  versionId: number
  version: number
  status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'SUPERSEDED'
  approvedVersion: number | null
  pallets: number
  packages: number
  units: number
  netKg: number
  grossKg: number
  payloadPct: number | null
  cbm: number
  volumePct: number
  floorPct: number
  critical: number
  warnings: number
  /** área do pedido (Exportação / Mercado Interno) */
  area: Area
  createdAt: string
  /** nome de quem criou (informativo: não restringe permissão) */
  createdBy: string
  createdById: number | null
  /** avatar de quem criou (emoji, URL da foto ou null = iniciais) */
  createdByAvatar: AvatarRef
  updatedAt: string
  /** quem fez a última alteração (versão atual) */
  updatedBy: string
  /** rascunho/revisão sem alteração há vários dias */
  stale: boolean
  /** em aberto e com ocupação baixa (dá para completar) */
  lowOccupancy: boolean
  /** pedido com várias unidades: posição desta (1, 2…) */
  unitIndex: number | null
  unitCount: number
  /** Exportações em curso: operação de seguimento (pedido confirmado); null = não confirmado ou sem acesso ao módulo */
  exportOpId: number | null
  /** etapa atual do seguimento (null = não confirmado) */
  exportStatus: ExportStatus | null
}

const STATUS: Record<DashRow['status'], string> = { DRAFT: 'Rascunho', IN_REVIEW: 'Em revisão', APPROVED: 'Aprovado', SUPERSEDED: 'Substituído' }
/** envios sem equipamento: sem barra de ocupação */
const NO_EQ = new Set<string>(['LCL', 'ROAD_LTL', 'AIR_LOOSE', 'PALLETS_ONLY', 'COURIER'])
const MODE: Record<DashRow['mode'], { label: string; icon: IconName }> = {
  FCL: { label: 'Contêiner (FCL)', icon: 'ship' },
  ROAD: { label: 'Caminhão', icon: 'truck' },
  AIR_ULD: { label: 'Aéreo ULD', icon: 'plane' },
  LCL: { label: 'LCL consolidado', icon: 'ship' },
  ROAD_LTL: { label: 'Caminhão consolidado', icon: 'truck' },
  AIR_LOOSE: { label: 'Aéreo carga solta', icon: 'plane' },
  PALLETS_ONLY: { label: 'Só paletes', icon: 'box' },
  COURIER: { label: 'Courier', icon: 'volume' },
}
/** pedido confirmado: a carga está em Exportações em curso e não pode ser excluída */
const DELETE_BLOCKED = 'Pedido confirmado: a carga está em Exportações em curso. Para excluí-la, desfaça a confirmação no seguimento (possível enquanto o status for “Pedido confirmado”).'
const pctFmt = (v: number | null) => (v == null ? '—' : `${nf1.format(v)}%`)
const m3Fmt = (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} m³`

/** etapa do seguimento da exportação (pedido confirmado); link = abre o seguimento (não usar dentro de outro link) */
function ExportPill({ r, link }: { r: DashRow; link?: boolean }) {
  if (!r.exportStatus || r.exportOpId == null) return null
  const cls = `pill exp-${r.exportStatus}`
  const title = `Exportação: ${EXPORT_STATUS_LABEL[r.exportStatus]}`
  return link ? (
    <Link href={`/exportacoes/${r.exportOpId}`} className={cls} title={`${title} — abrir o seguimento`} style={{ textDecoration: 'none' }}>
      {EXPORT_STATUS_SHORT[r.exportStatus]}
    </Link>
  ) : (
    <span className={cls} title={title}>
      {EXPORT_STATUS_SHORT[r.exportStatus]}
    </span>
  )
}

function Flag({ country }: { country: string }) {
  const url = flagUrl(country)
  return (
    <span className="dash-country">
      {url ? <span className="flag" style={{ backgroundImage: `url(${url})` }} aria-hidden /> : <Icon name="globe" size={14} />}
      {country}
    </span>
  )
}

interface Col {
  key: string
  label: string
  num?: boolean
  default: boolean
  sort?: (r: DashRow) => string | number
  cell: (r: DashRow) => ReactNode
  csv: (r: DashRow) => string | number
}

const COLS: Col[] = [
  {
    key: 'name',
    label: 'Plano',
    default: true,
    sort: (r) => r.name.toLowerCase(),
    cell: (r) => (
      <span>
        <Link href={`/cargas/${r.id}`} className="dash-plan">
          {r.name}
        </Link>
        {r.unitIndex && <span className="dash-chip" title="Pedido em várias unidades">{r.unitIndex}/{r.unitCount}</span>}
      </span>
    ),
    csv: (r) => r.name,
  },
  { key: 'customer', label: 'Cliente', default: true, sort: (r) => r.customer.toLowerCase(), cell: (r) => r.customer, csv: (r) => r.customer },
  { key: 'country', label: 'País', default: true, sort: (r) => r.country.toLowerCase(), cell: (r) => <Flag country={r.country} />, csv: (r) => r.country },
  { key: 'orderRef', label: 'Proforma / pedido', default: true, sort: (r) => r.orderRef ?? '', cell: (r) => r.orderRef ?? '—', csv: (r) => r.orderRef ?? '' },
  { key: 'transportCompany', label: 'Transportadora', default: false, sort: (r) => (r.transportCompany ?? '').toLowerCase(), cell: (r) => r.transportCompany ?? '—', csv: (r) => r.transportCompany ?? '' },
  { key: 'cfop', label: 'CFOP', default: false, sort: (r) => r.cfop ?? '', cell: (r) => r.cfop ?? '—', csv: (r) => r.cfop ?? '' },
  {
    key: 'paymentTerms',
    label: 'Condição de pagamento',
    default: false,
    sort: (r) => (r.paymentTerms ?? '').toLowerCase(),
    cell: (r) =>
      r.paymentTerms ? (
        <span title={r.paymentTerms} style={{ display: 'inline-block', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
          {r.paymentTerms}
        </span>
      ) : (
        '—'
      ),
    csv: (r) => r.paymentTerms ?? '',
  },
  {
    key: 'alerts',
    label: 'Alertas',
    default: true,
    sort: (r) => r.critical * 1000 + r.warnings,
    cell: (r) => (
      <span className="dash-alerts">
        {r.critical > 0 && <span className="pill crit">{r.critical} crít.</span>}
        {r.warnings > 0 && <span className="pill warn">{r.warnings}</span>}
        {!r.critical && !r.warnings && <span className="muted">—</span>}
      </span>
    ),
    csv: (r) => `${r.critical} crít. / ${r.warnings} atenção`,
  },
  {
    key: 'status',
    label: 'Status',
    default: true,
    sort: (r) => r.status,
    cell: (r) => (
      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className={`pill st-${r.status}`}>{STATUS[r.status]}</span>
        <ExportPill r={r} link />
      </span>
    ),
    csv: (r) => STATUS[r.status],
  },
  { key: 'area', label: 'Área', default: true, sort: (r) => r.area, cell: (r) => <span className={`pill area-${r.area}`}>{AREA_LABEL[r.area]}</span>, csv: (r) => AREA_LABEL[r.area] },
  { key: 'createdBy', label: 'Criado por', default: true, sort: (r) => r.createdBy.toLowerCase(), cell: (r) => (
      <span className="dash-user">
        <Avatar avatar={r.createdByAvatar} name={r.createdBy} size={22} /> {r.createdBy}
      </span>
    ),
    csv: (r) => r.createdBy,
  },
  { key: 'createdAt', label: 'Criado em', default: false, sort: (r) => r.createdAt, cell: (r) => <span className="dash-date">{dt(r.createdAt)}</span>, csv: (r) => dt(r.createdAt) },
  { key: 'updatedBy', label: 'Modificado por', default: false, sort: (r) => r.updatedBy.toLowerCase(), cell: (r) => <span className="dash-user">{r.updatedBy}</span>, csv: (r) => r.updatedBy },
  {
    key: 'updatedAt',
    label: 'Atualizado',
    default: true,
    sort: (r) => r.updatedAt,
    cell: (r) => (
      <span className="dash-date" title={`por ${r.updatedBy}`}>
        {dt(r.updatedAt)}
      </span>
    ),
    csv: (r) => dt(r.updatedAt),
  },
]

/** colunas comerciais/fiscais: só para quem vê preços (os dados nem chegam para a Expedição) */
const COMMERCIAL_COLS = new Set(['cfop', 'paymentTerms'])

const LS_COLS = 'lp:dash:cols:v2' // v2: colunas Área / Criado por
const LS_VIEW = 'lp:dash:view'
const LS_PER = 'lp:dash:per'
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

interface Filters {
  q: string
  country: string
  incoterm: string
  mode: string
  status: string
  area: string
  from: string
  to: string
  /** atalho do painel de acompanhamento */
  quick: Quick | ''
}
const EMPTY: Filters = { q: '', country: '', incoterm: '', mode: '', status: '', area: '', from: '', to: '', quick: '' }

/** Painel de acompanhamento: o que precisa de ação (clicar filtra a lista). */
type Quick = 'critical' | 'review' | 'stale' | 'low' | 'mine'
const isOpen = (r: DashRow) => r.status === 'DRAFT' || r.status === 'IN_REVIEW'
const quickTest = (q: Quick, r: DashRow, meId: number): boolean =>
  q === 'critical' ? r.critical > 0 && isOpen(r) : q === 'review' ? r.status === 'IN_REVIEW' : q === 'stale' ? r.stale : q === 'low' ? r.lowOccupancy : r.createdById === meId && isOpen(r)

function applyFilters(rows: DashRow[], f: Filters, meId: number) {
  const q = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (q && !`${r.name} ${r.customer} ${r.country} ${r.orderRef ?? ''} ${r.transportCompany ?? ''} ${r.cfop ?? ''} ${r.paymentTerms ?? ''} ${r.equipment} ${r.createdBy}`.toLowerCase().includes(q)) return false
    if (f.country && r.country !== f.country) return false
    if (f.incoterm && r.incoterm !== f.incoterm) return false
    if (f.mode && r.mode !== f.mode) return false
    if (f.status && r.status !== f.status) return false
    if (f.area && r.area !== f.area) return false
    if (f.quick && !quickTest(f.quick, r, meId)) return false
    // período pelo dia da atualização em São Paulo (o mesmo dia que a lista mostra)
    if (f.from || f.to) {
      const day = dayBR(r.updatedAt)
      if (f.from && day < f.from) return false
      if (f.to && day > f.to) return false
    }
    return true
  })
}

export function DashboardClient({
  rows,
  me,
  canEdit,
  canApprove,
  canViewPrices,
  permissionError,
}: {
  rows: DashRow[]
  me: { id: number; areas: Area[] }
  canEdit: boolean
  canApprove: boolean
  /** colunas CFOP e Condição de pagamento (dados comerciais/fiscais) */
  canViewPrices: boolean
  permissionError: boolean
}) {
  const router = useRouter()
  const [f, setF] = useState<Filters>(EMPTY)
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'updatedAt', dir: -1 })
  const [page, setPage] = useState(1)
  const [per, setPer] = useState(10)
  const [view, setView] = useState<'list' | 'board'>('list')
  const [cols, setCols] = useState<string[]>(COLS.filter((c) => c.default).map((c) => c.key))
  const [colsOpen, setColsOpen] = useState(false)
  const [menu, setMenu] = useState<number | null>(null)
  const [ai, setAi] = useState('')

  // preferências do usuário (navegador): colunas, vista e linhas por página
  useEffect(() => {
    const c = read(LS_COLS)
    const v = read(LS_VIEW)
    const p = Number(read(LS_PER))
    /* eslint-disable react-hooks/set-state-in-effect -- leitura única do localStorage após a hidratação */
    if (c) setCols(c.split(',').filter((k) => COLS.some((x) => x.key === k)))
    if (v === 'board' || v === 'list') setView(v)
    // celular sem preferência salva: o tablero (cartões) cabe melhor que a tabela
    else if (window.matchMedia?.('(max-width: 760px), (pointer: coarse) and (max-height: 500px)').matches) setView('board')
    if ([10, 25, 50, 100].includes(p)) setPer(p)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])
  // fecha menus ao clicar fora
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.dash-pop, .dash-pop-btn')) {
        setMenu(null)
        setColsOpen(false)
      }
    }
    document.addEventListener('click', fn)
    return () => document.removeEventListener('click', fn)
  }, [])

  const filtered = useMemo(() => applyFilters(rows, f, me.id), [rows, f, me.id])
  const sorted = useMemo(() => {
    const c = COLS.find((x) => x.key === sort.key)
    if (!c?.sort) return filtered
    const g = c.sort
    return [...filtered].sort((a, b) => {
      const x = g(a), y = g(b)
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
    })
  }, [filtered, sort])
  const pages = Math.max(1, Math.ceil(sorted.length / per))
  const cur = Math.min(page, pages)
  const pageRows = sorted.slice((cur - 1) * per, cur * per)

  // painel de acompanhamento: contagens com os demais filtros (sem o próprio atalho)
  const base = useMemo(() => applyFilters(rows, { ...f, quick: '' }, me.id), [rows, f, me.id])
  const count = (q: Quick) => base.filter((r) => quickTest(q, r, me.id)).length

  const countries = useMemo(() => [...new Set(rows.map((r) => r.country))].sort((a, b) => a.localeCompare(b, 'pt-BR')), [rows])
  const incoterms = useMemo(() => [...new Set(rows.map((r) => r.incoterm))].sort(), [rows])
  const allowed = (c: Col) => canViewPrices || !COMMERCIAL_COLS.has(c.key)
  const visible = COLS.filter((c) => cols.includes(c.key) && (c.key !== 'area' || me.areas.length > 1) && allowed(c))
  const active = Object.values(f).some(Boolean)
  const set = (k: keyof Filters, v: string) => {
    setF((x) => ({ ...x, [k]: v }))
    setPage(1)
  }

  function exportCsv() {
    const esc = (v: string | number) => {
      const s = typeof v === 'number' ? String(v).replace('.', ',') : v
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [visible.map((c) => c.label), ...sorted.map((r) => visible.map((c) => c.csv(r)))].map((l) => l.map(esc).join(';'))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }))
    a.download = `cargas-${todayBR()}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }

  // anexos do pedido do cliente (fotos, PDF, Word, Excel…): seguem para a interpretação do pedido
  const [aiFiles, setAiFiles] = useState<File[]>([])
  const aiFileRef = useRef<HTMLInputElement>(null)
  const addAiFiles = async (list: File[]) => {
    const arr = await Promise.all(list.map(shrinkImage))
    setAiFiles((x) => [...x, ...arr].slice(0, MAX_ATTACH))
  }

  function startAi() {
    const t = ai.trim()
    if (aiFiles.length) {
      setPendingIntake({ text: t, files: aiFiles })
      router.push('/cargas/nova?entrada=pedido')
      return
    }
    if (!t) return
    try {
      sessionStorage.setItem('lp:aiPrompt', t)
    } catch {
      /* sem armazenamento: o texto vai na URL */
    }
    router.push(`/cargas/nova?ia=1`)
  }

  const cards: { q: Quick; icon: IconName; label: string; sub: string; tone: 'crit' | 'warn' | 'info' | 'ok' }[] = [
    { q: 'critical', icon: 'alert', label: 'Com alertas críticos', sub: 'em aberto, não podem ser aprovadas', tone: 'crit' },
    { q: 'mine', icon: 'box', label: 'Minhas em aberto', sub: 'criadas por você, ainda não aprovadas', tone: 'ok' },
  ]
  const multiArea = me.areas.length > 1
  const title = multiArea ? 'Cargas' : me.areas[0] === 'DOMESTIC' ? 'Cargas de mercado interno' : 'Cargas de exportação'

  return (
    <div className="dash" ref={rootRef}>
      <section className="dash-hero">
        <div className="dash-hero-text">
          <div className="dash-hero-icon">
            <Icon name="box" size={30} />
          </div>
          <div>
            <h1>{title}</h1>
            <p>{multiArea ? 'Exportação e mercado interno — acompanhe todas as cargas em um só lugar.' : 'Gerencie e acompanhe todas as cargas em um só lugar.'}</p>
          </div>
        </div>
        <Image className="dash-hero-logo" src="/brand/pacifil-brasil-branco.png" alt="" width={220} height={109} aria-hidden />
        {canEdit && (
          <Link className="btn dash-new" href="/cargas/nova">
            <Icon name="plus" size={18} /> {me.areas.length === 1 && me.areas[0] === 'DOMESTIC' ? 'Nova carga' : multiArea ? 'Nova carga' : 'Nova exportação'}
          </Link>
        )}
      </section>
      {permissionError && <div className="alert error">Você não tem permissão para acessar aquela página.</div>}

      {canEdit && (
        <form
          className="dash-ai"
          onSubmit={(e) => {
            e.preventDefault()
            startAi()
          }}
        >
          <Icon name="sparkle" size={20} />
          <input
            ref={aiFileRef}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = e.target.files ? [...e.target.files] : []
              e.target.value = ''
              if (fl.length) void addAiFiles(fl)
            }}
          />
          <input
            value={ai}
            onChange={(e) => setAi(e.target.value)}
            onPaste={(e) => {
              const imgs = pastedImages(e)
              if (imgs.length) {
                e.preventDefault()
                void addAiFiles(imgs)
              }
            }}
            placeholder="Descreva a carga (“40 HC 100% Hidrosilo 10.000 L para Uruguay”) ou anexe 📎 o pedido do cliente (foto, PDF, Word, Excel…)" maxLength={2000}
          />
          <button type="button" onClick={() => aiFileRef.current?.click()} title={`Anexar o pedido do cliente — ${ATTACH_HINT}. Também dá para colar uma captura (Ctrl+V).`}>
            📎
          </button>
          <DictationButton value={ai} onChange={setAi} />
          <button className="primary" disabled={!ai.trim() && !aiFiles.length}>
            {aiFiles.length ? 'Interpretar pedido' : 'Criar com IA'}
          </button>
          <Link className="btn" href="/cargas/nova?entrada=pedido" title="Anexe a ordem de compra, foto, PDF ou planilha do cliente: a IA interpreta, você confere e a carga é montada">
            📎 Pedido do cliente
          </Link>
        </form>
      )}
      {canEdit && aiFiles.length > 0 && (
        <ul className="intake-files" style={{ marginTop: -6, marginBottom: 12 }}>
          {aiFiles.map((fl, k) => (
            <li key={`${fl.name}-${k}`}>
              {fileIcon(fl)} {fl.name}
              <button type="button" className="small" onClick={() => setAiFiles((x) => x.filter((_, j) => j !== k))} title="Remover anexo">
                ✕
              </button>
            </li>
          ))}
          <li style={{ border: 'none', background: 'none' }}>
            <small className="muted">o assistente lê os anexos, identifica os produtos no catálogo e mostra um resumo para você conferir</small>
          </li>
        </ul>
      )}

      <section className="dash-track" aria-label="Acompanhamento">
        {cards.map((c) => {
          const n = count(c.q)
          const on = f.quick === c.q
          return (
            <button
              key={c.q}
              className={`dash-track-card tone-${c.tone} ${on ? 'on' : ''} ${n ? '' : 'zero'}`}
              onClick={() => (setF((x) => ({ ...x, quick: on ? '' : c.q })), setPage(1))}
              title={on ? 'Clique para mostrar todas' : 'Clique para filtrar a lista'}
            >
              <span className="dash-track-icon">
                <Icon name={c.icon} size={20} />
              </span>
              <span className="dash-track-body">
                <span className="dash-track-label">{c.label}</span>
                <span className="dash-track-sub">{n ? c.sub : 'tudo em dia'}</span>
              </span>
              <span className="dash-track-n">{n}</span>
            </button>
          )
        })}
      </section>

      <section className="dash-filters">
        <label className="dash-search">
          <Icon name="search" size={17} />
          <input value={f.q} onChange={(e) => set('q', e.target.value)} placeholder="Buscar por plano, cliente, país, pedido…" />
        </label>
        <FilterSelect icon="globe" label="País" value={f.country} onChange={(v) => set('country', v)} options={countries.map((c) => ({ value: c, label: c }))} />
        <FilterSelect icon="ship" label="Incoterm" value={f.incoterm} onChange={(v) => set('incoterm', v)} options={incoterms.map((c) => ({ value: c, label: c }))} />
        <FilterSelect
          icon="truck"
          label="Tipo"
          value={f.mode}
          onChange={(v) => set('mode', v)}
          options={(Object.keys(MODE) as DashRow['mode'][]).map((k) => ({ value: k, label: MODE[k].label }))}
        />
        {multiArea && <FilterSelect icon="globe" label="Área" value={f.area} onChange={(v) => set('area', v)} options={me.areas.map((a) => ({ value: a, label: AREA_LABEL[a] }))} />}
        <FilterSelect icon="status" label="Status" value={f.status} onChange={(v) => set('status', v)} options={(Object.keys(STATUS) as DashRow['status'][]).map((k) => ({ value: k, label: STATUS[k] }))} />
        <div className="dash-filter dash-period">
          <Icon name="calendar" size={17} />
          <div>
            <small>Período (atualização)</small>
            <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
              <input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="De" />
              <span className="muted">a</span>
              <input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="Até" />
            </div>
          </div>
        </div>
        <button className="dash-clear" onClick={() => (setF(EMPTY), setPage(1))} disabled={!active}>
          <Icon name="filter" size={16} /> Limpar filtros
        </button>
      </section>

      <section className="dash-list">
        <div className="dash-list-head">
          <div className="dash-list-title">
            <Icon name="box" size={18} /> {view === 'list' ? 'Lista de cargas' : 'Tablero por status'}
            <small className="muted">{filtered.length !== rows.length ? `${filtered.length} de ${rows.length}` : `${rows.length}`}</small>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div className="dash-seg" role="group" aria-label="Vista">
              {(['list', 'board'] as const).map((v) => (
                <button
                  key={v}
                  className={view === v ? 'on' : ''}
                  onClick={() => {
                    setView(v)
                    write(LS_VIEW, v)
                  }}
                >
                  <Icon name={v === 'list' ? 'list' : 'board'} size={16} /> {v === 'list' ? 'Lista' : 'Tablero'}
                </button>
              ))}
            </div>
            <button onClick={exportCsv} disabled={!sorted.length} title="CSV com as colunas visíveis (abre no Excel)">
              <Icon name="download" size={16} /> Exportar
            </button>
            {view === 'list' && (
              <div className="dash-pop-wrap">
                <button className="dash-pop-btn" onClick={() => setColsOpen((o) => !o)}>
                  <Icon name="columns" size={16} /> Personalizar colunas
                </button>
                {colsOpen && (
                  <div className="dash-pop" style={{ right: 0, width: 220 }}>
                    {COLS.filter(allowed).map((c) => (
                      <label key={c.key} className="check">
                        <input
                          type="checkbox"
                          checked={cols.includes(c.key)}
                          disabled={c.key === 'name'}
                          onChange={(e) => {
                            const next = e.target.checked ? COLS.filter((x) => x.key === c.key || cols.includes(x.key)).map((x) => x.key) : cols.filter((k) => k !== c.key)
                            setCols(next)
                            write(LS_COLS, next.join(','))
                          }}
                        />
                        {c.label}
                      </label>
                    ))}
                    <button
                      className="small"
                      style={{ marginTop: 6 }}
                      onClick={() => {
                        const d = COLS.filter((c) => c.default).map((c) => c.key)
                        setCols(d)
                        write(LS_COLS, d.join(','))
                      }}
                    >
                      Restaurar padrão
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {view === 'list' ? (
          <>
            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    {visible.map((c) => (
                      <th
                        key={c.key}
                        className={`${c.num ? 'num' : ''} ${c.sort ? 'sortable' : ''}`}
                        onClick={() => c.sort && setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : c.num || c.key === 'updatedAt' ? -1 : 1 }))}
                      >
                        {c.label}
                        {c.sort && <span className={`sort ${sort.key === c.key ? 'on' : ''}`}>{sort.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>}
                      </th>
                    ))}
                    <th className="act">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr key={r.id} onDoubleClick={() => router.push(`/cargas/${r.id}`)}>
                      {visible.map((c) => (
                        <td key={c.key} className={c.num ? 'num' : ''}>
                          {c.cell(r)}
                        </td>
                      ))}
                      <td className="act">
                        <RowMenu r={r} open={menu === r.id} onToggle={() => setMenu((x) => (x === r.id ? null : r.id))} canEdit={canEdit} canApprove={canApprove} />
                      </td>
                    </tr>
                  ))}
                  {!pageRows.length && (
                    <tr>
                      <td colSpan={visible.length + 1} className="muted" style={{ padding: 24, textAlign: 'center' }}>
                        {rows.length ? 'Nenhuma carga com esses filtros.' : 'Nenhuma carga ainda. Comece em “Nova exportação”.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="dash-pager">
              <span className="muted">
                Mostrando {sorted.length ? (cur - 1) * per + 1 : 0}–{Math.min(cur * per, sorted.length)} de {sorted.length} carga(s)
              </span>
              <span className="spacer" />
              <span className="muted">Linhas por página</span>
              <select
                value={per}
                onChange={(e) => {
                  setPer(Number(e.target.value))
                  write(LS_PER, e.target.value)
                  setPage(1)
                }}
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <button className="small" disabled={cur <= 1} onClick={() => setPage(1)} aria-label="Primeira">
                «
              </button>
              <button className="small" disabled={cur <= 1} onClick={() => setPage(cur - 1)} aria-label="Anterior">
                ‹
              </button>
              {pagesAround(cur, pages).map((p, i) =>
                p === 0 ? (
                  <span key={`g${i}`} className="muted">
                    …
                  </span>
                ) : (
                  <button key={p} className={`small ${p === cur ? 'active' : ''}`} onClick={() => setPage(p)}>
                    {p}
                  </button>
                ),
              )}
              <button className="small" disabled={cur >= pages} onClick={() => setPage(cur + 1)} aria-label="Próxima">
                ›
              </button>
              <button className="small" disabled={cur >= pages} onClick={() => setPage(pages)} aria-label="Última">
                »
              </button>
            </div>
          </>
        ) : (
          <Board rows={sorted} />
        )}
      </section>
    </div>
  )
}

function pagesAround(cur: number, total: number): number[] {
  const set = new Set([1, total, cur - 1, cur, cur + 1].filter((p) => p >= 1 && p <= total))
  const list = [...set].sort((a, b) => a - b)
  const out: number[] = []
  list.forEach((p, i) => {
    if (i && p - list[i - 1] > 1) out.push(0)
    out.push(p)
  })
  return out
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

function RowMenu({ r, open, onToggle, canEdit, canApprove }: { r: DashRow; open: boolean; onToggle: () => void; canEdit: boolean; canApprove: boolean }) {
  const [del, setDel] = useState(false)
  return (
    <div className="dash-pop-wrap">
      {del && <DeletePlanDialog r={r} onClose={() => setDel(false)} />}
      <button className="dash-pop-btn icon-btn" onClick={onToggle} aria-label={`Ações de ${r.name}`}>
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div className="dash-pop dash-menu" style={{ right: 0 }}>
          <Link href={`/cargas/${r.id}`}>Abrir no editor 3D</Link>
          {r.exportOpId != null && <Link href={`/exportacoes/${r.exportOpId}`}>Ver seguimento</Link>}
          <Link href={`/cargas/${r.id}/resumo?v=${r.version}`}>Resumo / impressão</Link>
          <a href={`/cargas/${r.id}/csv?v=${r.version}`}>Packing list (CSV)</a>
          {canEdit && (
            <form action={newVersionAction.bind(null, r.versionId)}>
              <button>Nova versão a partir da V{r.version}</button>
            </form>
          )}
          {canEdit && r.status === 'DRAFT' && (
            <form action={submitForReviewAction.bind(null, r.versionId)}>
              <button>Enviar para revisão</button>
            </form>
          )}
          {canApprove && r.status === 'IN_REVIEW' && <Link href={`/cargas/${r.id}?v=${r.version}`}>Revisar e aprovar…</Link>}
          {canEdit && (r.status !== 'APPROVED' || canApprove) &&
            (r.exportOpId != null ? (
              // pedido confirmado: o servidor recusa a exclusão; o title fica no contêiner (botão desabilitado não mostra dica em todos os navegadores)
              <div title={DELETE_BLOCKED}>
                <button className="dash-menu-danger" disabled>
                  Excluir carga… <small>(pedido confirmado)</small>
                </button>
              </div>
            ) : (
              <button className="dash-menu-danger" onClick={() => (onToggle(), setDel(true))}>
                Excluir carga…
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

/** Exclusão de carga: uma confirmação (aviso do que será apagado) e exclui. */
function DeletePlanDialog({ r, onClose }: { r: DashRow; onClose: () => void }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirm() {
    setBusy(true)
    setError(null)
    const res = await deletePlanAction(r.id).catch(() => ({ ok: false as const, error: 'Falha de comunicação com o servidor.' }))
    setBusy(false)
    if (!res.ok) return setError(res.error)
    onClose()
    router.refresh()
  }
  return (
    <div className="overlay-full" style={{ display: 'grid', placeItems: 'center', background: 'rgba(13,43,34,.55)', zIndex: 1000 }} onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="panel" style={{ width: 'min(520px, 94vw)', textAlign: 'left' }}>
        <h3 style={{ marginTop: 0, color: 'var(--crit)' }}>Excluir carga</h3>
        <p style={{ margin: '0 0 8px' }}>
          <strong>{r.name}</strong>
          <br />
          <small className="muted">
            {r.customer}
            {r.orderRef ? ` · ${orderRefLabel(r.orderRef, r.area)}` : ''} · {STATUS[r.status]}
            {r.unitCount > 1 ? ` · unidade ${r.unitIndex} de ${r.unitCount} do pedido (as outras continuam)` : ''}
          </small>
        </p>
        <div className="alert warn" style={{ margin: '0 0 10px' }}>
          Serão apagadas <strong>todas as versões</strong> desta carga (composição 3D, histórico e conversas do assistente).{r.status === 'APPROVED' && ' Esta carga está APROVADA.'} <strong>Esta ação não pode ser desfeita.</strong>
        </div>
        {error && <div className="alert error">{error}</div>}
        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Excluindo…' : 'Sim, excluir'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Board({ rows }: { rows: DashRow[] }) {
  const lanes: DashRow['status'][] = ['DRAFT', 'IN_REVIEW', 'APPROVED', ...(rows.some((r) => r.status === 'SUPERSEDED') ? (['SUPERSEDED'] as const) : [])]
  return (
    <div className="dash-board">
      {lanes.map((st) => {
        const items = rows.filter((r) => r.status === st)
        return (
          <div key={st} className={`dash-lane lane-${st}`}>
            <div className="dash-lane-head">
              <span className={`pill st-${st}`}>{STATUS[st]}</span>
              <span className="muted">{items.length}</span>
            </div>
            {items.map((r) => {
              const occ = Math.max(r.volumePct, r.payloadPct ?? 0)
              return (
                <Link key={r.id} href={`/cargas/${r.id}`} className="dash-card">
                  <div className="dash-card-top">
                    <strong>{r.name}</strong>
                    {r.unitIndex && <span className="dash-chip">{r.unitIndex}/{r.unitCount}</span>}
                    <span className="spacer" />
                    <ExportPill r={r} />
                    {r.critical > 0 && <span className="pill crit">{r.critical} crít.</span>}
                  </div>
                  <div className="dash-card-meta">
                    {r.customer} · <Flag country={r.country} />
                  </div>
                  <div className="dash-card-meta">
                    <Icon name={MODE[r.mode].icon} size={14} /> {r.equipment} · {r.incoterm} · V{r.version}
                    {r.orderRef ? ` · ${orderRefLabel(r.orderRef, r.area)}` : ''}
                  </div>
                  <div className="dash-card-nums">
                    <span>{nf0.format(r.pallets)} pal.</span>
                    <span>{nf0.format(r.grossKg)} kg</span>
                    <span>{m3Fmt(r.cbm)}</span>
                  </div>
                  {!NO_EQ.has(r.mode) && (
                    <div className="dash-bar" title={`Ocupação: volume ${pctFmt(r.volumePct)} · payload ${pctFmt(r.payloadPct)}`}>
                      <div style={{ width: `${Math.min(100, occ)}%` }} className={occ > 100 ? 'over' : ''} />
                    </div>
                  )}
                  <div className="dash-card-foot muted">
                    <Avatar avatar={r.createdByAvatar} name={r.createdBy} size={16} /> {r.createdBy} · atualizado {dt(r.updatedAt)}
                  </div>
                </Link>
              )
            })}
            {!items.length && <div className="muted dash-empty">Nenhuma carga</div>}
          </div>
        )
      })}
    </div>
  )
}

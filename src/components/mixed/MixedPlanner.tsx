'use client'

/**
 * Pedido → PALETES MISTOS: o usuário informa as quantidades; o motor determinístico
 * (optimizeMixedPallets) monta os paletes. Depois é possível editar (3D por palete, mover / tirar /
 * colocar caixas), sempre com recálculo de peso, altura, ocupação, alertas e pendências do pedido.
 */
import { COURIER_DIVISOR_DEFAULT, courierLayout, courierPlan } from '@/domain/courier'
import { CourierView } from './CourierView'
import type { CaptureFn } from '../three/Scene3D'
import { DictationButton } from '@/components/DictationButton'
import { useMemo, useRef, useState } from 'react'
import { PalletEditor } from '@/components/editor/PalletEditor'
import {
  addBoxesToMixed,
  evaluateMixedPlan,
  maxBoxesPerPallet,
  moveBoxesBetween,
  optimizeMixedPallets,
  OrderLine,
  removeBoxesFromMixed,
  TRANSPORT_LABEL,
  TransportMode,
  transportMaxHeight,
} from '@/domain/mixedPallets'
import { distinctSkuColors } from '@/domain/colors'
import { companionLines, completePalletCompanions } from '@/domain/companions'
import { describeKitBoxes, kitBoxLabel, kitBoxLines, kitFamilyOf, kitOrderLines, packKeyOf, packKits } from '@/domain/kitBoxes'
import { resolveLogistics } from '@/domain/logisticsRules'
import type { PackSnapshot, PalletDoc, PalletTypeSnapshot, SpaceSnapshot } from '@/domain/types'
import { dayBR, kg, m3, mm, nf0 } from '../format'
import { parseOrderAction, recordPlannerQuoteAction } from '@/app/cargas/planner-actions'
import { defaultPdfLang, PDF_LANGS, PDF_LOGO_PATH, PdfLang } from '@/lib/pdf/i18n'
import { PdfPreview } from '@/components/pdf/PdfPreview'
import { pdfText } from '@/lib/pdf/i18n'
import { flagPng } from '@/lib/pdf/flags'
import type { ParsedOrder } from '@/lib/ai/orderParser'
import type { PricingPayload } from '@/domain/exportPricing'
import { mixedOrderValue, MixedValuePanel } from './MixedValue'
import { CountryInput } from '@/components/CountryInput'

const packKey = (p: PackSnapshot) => packKeyOf(p)
const DEFAULT_MANUAL_H: Record<TransportMode, number> = { FCL: 0, ROAD: 0, AIR: 1600, LCL: 2000, PALLETS_ONLY: 2000, COURIER: 0 }

/** uma cor por produto no plano inteiro (sem repetir entre SKUs), igual no 3D, nos cartões e no PDF */
function recolor(ds: PalletDoc[]): PalletDoc[] {
  const map = distinctSkuColors(ds.flatMap((d) => Object.values(d.packs)))
  return ds.map((d) => ({ ...d, packs: Object.fromEntries(Object.entries(d.packs).map(([k, pk]) => [k, { ...pk, color: map.get(pk.sku) ?? pk.color }])) }))
}

export interface MixedPlannerProps {
  /** nome do usuário logado (rodapé discreto dos PDFs) */
  generatedBy?: string
  catalog: PackSnapshot[]
  palletTypes: PalletTypeSnapshot[]
  /** palete padrão por embalagem (pvID → palletTypeId) */
  stdPallet: Record<string, number>
  defaultMode: TransportMode
  /** equipamento atual (FCL/rodoviário: altura útil e porta) */
  space?: SpaceSnapshot | null
  profileHeightMm?: number | null
  /** coloca os paletes no equipamento da carga; devolve a mensagem do resultado */
  onApply?: (pallets: PalletDoc[], mode: TransportMode, maxHeightMm: number) => string
  /** envio sem equipamento: modalidade fixa (a do tipo de envio) e "Aplicar ao envio" substitui o conteúdo */
  lockMode?: boolean
  /** courier: grava as caixas do pedido no envio */
  onApplyCourier?: (order: OrderLine[], divisor: number) => string
  /** pedido já gravado no envio (reabrir o planejador começa por ele) */
  initialLines?: { sku: string; units: number }[]
  onClose?: () => void
  /** país de destino do envio (regras logísticas) */
  destination?: string | null
  /** preços de exportação (painel de valor e PDF); ausente = sem valor */
  pricing?: PricingPayload | null
}

export function MixedPlanner(p: MixedPlannerProps) {
  /** fullPallets = pedido em paletes completos: as unidades são calculadas com a altura/palete atuais */
  const [lines, setLines] = useState<{ key: string; units: number; fullPallets?: number }[]>(() =>
    (p.initialLines ?? []).flatMap((l) => {
      const c = p.catalog.find((x) => x.sku.toUpperCase() === l.sku.toUpperCase())
      return c && l.units > 0 ? [{ key: packKey(c), units: l.units }] : []
    }),
  )
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<TransportMode>(p.defaultMode)
  const [manualH, setManualH] = useState<number>(p.lockMode && p.space?.kind === 'NONE' ? p.space.inner.h : DEFAULT_MANUAL_H[p.defaultMode] || 0)
  const [autoTypes, setAutoTypes] = useState(true)
  const [typeIds, setTypeIds] = useState<number[]>([])
  const [maxKg, setMaxKg] = useState<number | ''>('')
  const [docs, setDocs] = useState<PalletDoc[] | null>(null)
  const [planOrder, setPlanOrder] = useState<OrderLine[]>([])
  const [planInfo, setPlanInfo] = useState<{ strategy: string; evaluated: number; unplaced: { sku: string; boxes: number; reason: string }[]; notes?: string[] } | null>(null)
  const [destination, setDestination] = useState(p.destination ?? '')
  const [editing, setEditing] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ type: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const [reference, setReference] = useState('')
  const [pdfBusy, setPdfBusy] = useState(false)
  /** idioma do PDF; null = sugerido pelo país de destino */
  const [pdfLang, setPdfLang] = useState<PdfLang | null>(null)
  const effLang = pdfLang ?? defaultPdfLang(destination)
  /** courier: divisor do peso volumétrico (cm³/kg) */
  const [divisor, setDivisor] = useState(p.space?.courierDivisor ?? COURIER_DIVISOR_DEFAULT)
  /** courier: caixas do mesmo produto empilhadas no desenho (senão lado a lado) */
  const [stackCourier, setStackCourier] = useState(false)
  const courierCapture = useRef<CaptureFn | null>(null)
  /** venda via agente (comissão incluída no preço; só interno) */
  const [agentId, setAgentId] = useState<number | null>(null)
  /** Incoterm da cotação (CIF soma o recargo por kg) */
  const [incoterm, setIncoterm] = useState('FOB')
  const [mv, setMv] = useState<{ from: number; sku: string; qty: number; to: number | 'new' | 'out' }>({ from: 0, sku: '', qty: 1, to: 'out' })

  const byKey = useMemo(() => new Map(p.catalog.map((c) => [packKey(c), c])), [p.catalog])
  const typeById = useMemo(() => new Map(p.palletTypes.map((t) => [t.palletTypeId, t])), [p.palletTypes])

  const containerH = mode === 'FCL' || mode === 'ROAD' ? transportMaxHeight(mode, p.space ?? null, null, p.profileHeightMm) : null
  /** envio sem equipamento (ex.: caminhão consolidado): a altura vem do envio, não de um veículo */
  const noEqSpace = p.space?.kind === 'NONE'
  const maxH = transportMaxHeight(mode, mode === 'FCL' || mode === 'ROAD' ? p.space ?? null : null, manualH || null, p.profileHeightMm) ?? 0

  // acompanhantes obrigatórios (ex.: 1 kit por Hydroforce): entram no pedido automaticamente, em kits
  // (caixa individual do catálogo); o motor monta as caixas de 26 / meia caixa por palete
  const kitLinesFor = (base: OrderLine[]) =>
    companionLines(base).flatMap((c) => {
      const pack = p.catalog.find((k) => k.sku.toUpperCase() === c.sku.toUpperCase())
      return pack ? [{ packId: packKey(pack), pack, boxes: Math.ceil(c.kits / Math.max(1, pack.unitsPerPackage)), kits: c.kits, for: c.for }] : []
    })
  const withKits = (base: OrderLine[]): OrderLine[] => {
    const kits = kitLinesFor(base)
    return [
      ...base.map((o) => {
        const a = kits.find((x) => x.packId === o.packId)
        return a ? { ...o, boxes: Math.max(o.boxes, a.boxes) } : o
      }),
      ...kits.filter((a) => !base.some((o) => o.packId === a.packId)).map(({ packId, pack, boxes }) => ({ packId, pack, boxes })),
    ]
  }
  const toOrder = (ls: { key: string; units: number }[]): OrderLine[] =>
    ls
      .filter((l) => l.units > 0 && byKey.has(l.key))
      .map((l) => {
        const pack = byKey.get(l.key)!
        return { packId: l.key, pack, boxes: Math.ceil(l.units / Math.max(1, pack.unitsPerPackage)) }
      })
  // regra logística central (modalidade + destino) define o palete padrão; o palete do produto fica como reserva
  // (tipos dependem só de QUAIS produtos há no pedido, não das quantidades)
  // valor do pedido (preços de exportação): unidades pedidas, com os acompanhantes
  // categoria comercial do país (preços de exportação), para mostrar ao lado do país
  const categoryOf = p.pricing
    ? (code: string) => {
        const id = p.pricing!.countryCategory.find(([c]) => c === code)?.[1]
        const cat = p.pricing!.categories.find((c) => c.id === id && c.active)
        return cat ? cat.name : null
      }
    : undefined
  const typeOrder = withKits(toOrder(lines.map((l) => ({ ...l, units: Math.max(1, l.units) }))))
  const logisticsMode = mode === 'FCL' || mode === 'LCL' ? 'SEA' : mode === 'ROAD' ? 'ROAD' : mode === 'AIR' ? 'AIR' : null
  const rules = logisticsMode ? resolveLogistics({ mode: logisticsMode, destination }) : null
  const ruleTypeIds = (rules?.palletTypeCodes ?? []).map((c) => p.palletTypes.find((t) => t.code === c)?.palletTypeId).filter((x): x is number => x != null)
  const stdTypeIds = [...new Set(typeOrder.map((o) => p.stdPallet[o.packId]).filter((x): x is number => x != null))]
  const autoTypeIds = ruleTypeIds.length ? ruleTypeIds : stdTypeIds
  const usedTypeKey = (autoTypes ? autoTypeIds : typeIds).join(',')
  const fallbackKey = autoTypes && ruleTypeIds.length ? stdTypeIds.join(',') : ''
  const usedTypes = useMemo(() => (usedTypeKey ? usedTypeKey.split(',').map(Number) : []).map((id) => typeById.get(id)).filter((t): t is PalletTypeSnapshot => Boolean(t)), [usedTypeKey, typeById])
  const fallbackTypes = useMemo(() => (fallbackKey ? fallbackKey.split(',').map(Number) : []).map((id) => typeById.get(id)).filter((t): t is PalletTypeSnapshot => Boolean(t)), [fallbackKey, typeById])

  // "N paletes completos": caixas por palete com a altura / tipos / peso ATUAIS, contando os acompanhantes
  const fullKeys = lines.filter((l) => l.fullPallets).map((l) => l.key).join(',')
  const perPallet = useMemo(() => {
    const m = new Map<string, number>()
    if (!maxH || !usedTypes.length) return m
    for (const key of fullKeys ? fullKeys.split(',') : []) {
      const pack = byKey.get(key)
      if (pack) m.set(key, maxBoxesPerPallet(pack, (b) => withKits([{ packId: key, pack, boxes: b }]), { palletTypes: usedTypes, fallbackPalletTypes: fallbackTypes, maxHeightMm: maxH, maxLoadKg: maxKg === '' ? null : maxKg }))
    }
    return m
    // withKits/byKey derivam do catálogo (estável)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKeys, maxH, usedTypes, fallbackTypes, maxKg, byKey])
  const effLines = lines.map((l) => (l.fullPallets ? { ...l, units: l.fullPallets * (perPallet.get(l.key) ?? 0) * Math.max(1, byKey.get(l.key)?.unitsPerPackage ?? 1) } : l))
  const baseOrder = toOrder(effLines)
  const autoLines = kitLinesFor(baseOrder)
  const order: OrderLine[] = withKits(baseOrder)
  // VALOR (preços de exportação) sobre o pedido EFETIVO (inclui "N paletes completos" e acompanhantes)
  const priced = p.pricing && order.length ? mixedOrderValue(p.pricing, order, destination, agentId, incoterm) : null
  // paletes: o PDF usa o pedido OTIMIZADO (o mesmo dos paletes); pedido mudou depois → aviso para otimizar de novo
  const orderSig = (os: OrderLine[]) => os.map((o) => `${o.packId}:${o.boxes}`).sort().join(',')
  const planStale = mode !== 'COURIER' && docs != null && orderSig(order) !== orderSig(planOrder)
  const pricedPlan = p.pricing && planOrder.length ? mixedOrderValue(p.pricing, planOrder, destination, agentId, incoterm) : null
  // courier/paqueteria: sem palete — cada caixa do pedido (com acompanhantes) é um volume; kits nas
  // caixas da regra (26 / meia caixa / individuais) para o pedido inteiro
  const courierOrder: OrderLine[] =
    mode === 'COURIER' ? order.flatMap((o) => (kitFamilyOf(o.pack.sku) ? kitOrderLines(o.pack, o.packId, o.boxes * Math.max(1, o.pack.unitsPerPackage)) : [o])) : order
  const courier = mode === 'COURIER' ? courierPlan(courierOrder, divisor) : null
  const courierKey = mode === 'COURIER' ? `${courierOrder.map((o) => `${o.packId}:${o.boxes}`).join(',')}|${stackCourier}` : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recalcula só quando muda o pedido (chave) ou o modo de empilhar
  const cLayout = useMemo(() => (mode === 'COURIER' ? courierLayout(courierOrder, { stack: stackCourier }) : null), [courierKey])

  const plan = useMemo(() => (docs ? evaluateMixedPlan(docs, planOrder, { maxHeightMm: maxH, palletTypes: usedTypes }, { unplaced: planInfo?.unplaced, strategy: planInfo?.strategy, evaluated: planInfo?.evaluated, notes: planInfo?.notes }) : null), [docs, planOrder, maxH, usedTypes, planInfo])
  const pending = plan ? plan.check.filter((c) => c.placed < c.requested) : []

  function run() {
    setMsg(null)
    if (!order.length) return setMsg({ type: 'warn', text: 'Informe as quantidades do pedido.' })
    if (!maxH) return setMsg({ type: 'warn', text: 'Informe a altura máxima do palete para esta modalidade.' })
    if (!usedTypes.length) return setMsg({ type: 'warn', text: 'Nenhum tipo de palete: cadastre o palete padrão dos produtos ou escolha os tipos manualmente.' })
    const r = optimizeMixedPallets(order, { palletTypes: usedTypes, fallbackPalletTypes: fallbackTypes, maxHeightMm: maxH, maxLoadKg: maxKg === '' ? null : maxKg })
    setDocs(recolor(r.pallets.map((x) => x.doc)))
    setPlanOrder(order)
    setPlanInfo({ strategy: r.strategy, evaluated: r.evaluated, unplaced: r.unplaced, notes: r.notes })
    setMsg(r.ok ? { type: 'ok', text: `${r.totals.pallets} palete(s) · ${r.positions} posição(ões) de piso · todas as quantidades conferem.` } : { type: 'warn', text: 'Otimização concluída com pendências — veja a conferência.' })
  }

  /** aplica uma alteração manual e recalcula */
  function edit(next: PalletDoc[], text?: string) {
    setDocs(recolor(next.filter((d) => d.items.length)))
    setPlanInfo((i) => (i ? { ...i, strategy: 'otimizado + edição manual', unplaced: [] } : i))
    if (text) setMsg({ type: 'ok', text })
  }

  function doMove() {
    if (!docs) return
    const from = docs[mv.from]
    if (!from || !mv.sku) return
    if (mv.to === 'out') {
      const r = removeBoxesFromMixed(from, mv.sku, mv.qty)
      edit(docs.map((d, i) => (i === mv.from ? r.doc : d)), `${r.removed.length} caixa(s) ${mv.sku} retiradas (ficam pendentes no pedido).`)
      return
    }
    const to: PalletDoc = mv.to === 'new' ? { ...from, name: 'novo', items: [], packs: {} } : docs[mv.to]
    const r = moveBoxesBetween(from, to, mv.sku, mv.qty, maxH)
    const next = docs.map((d, i) => (i === mv.from ? r.from : i === mv.to ? r.to : d))
    if (mv.to === 'new' && r.moved) next.push(r.to)
    edit(next, r.moved < mv.qty ? `Movidas ${r.moved} de ${mv.qty} caixa(s): o destino não tem mais espaço apoiado/altura/peso.` : `${r.moved} caixa(s) ${mv.sku} movidas.`)
  }

  function placePending(target: number | 'auto') {
    if (!docs || !plan) return
    let next = [...docs]
    let placed = 0
    const left: OrderLine[] = []
    // acompanhantes (kits): completados por cima dos paletes do produto principal, abaixo
    const kitSkus = new Set(planOrder.flatMap((o) => (o.pack.companions ?? []).map((c) => c.sku)))
    for (const c of pending) {
      if (kitSkus.has(c.sku)) continue
      const ol = planOrder.find((o) => o.pack.sku === c.sku)
      if (!ol) continue
      let need = c.requested - c.placed
      const targets = target === 'auto' ? next.map((_, i) => i) : [target]
      for (const ti of targets) {
        if (!need) break
        const r = addBoxesToMixed(next[ti], ol.packId, ol.pack, need, maxH)
        next[ti] = r.doc
        need -= r.added
        placed += r.added
      }
      if (need && target === 'auto') left.push({ ...ol, boxes: need })
    }
    // o que não coube nos paletes existentes: novos paletes otimizados
    if (left.length) {
      const r = optimizeMixedPallets(left, { palletTypes: usedTypes, fallbackPalletTypes: fallbackTypes, maxHeightMm: maxH, maxLoadKg: maxKg === '' ? null : maxKg })
      next = [...next, ...r.pallets.map((x) => x.doc)]
      placed += r.totals.boxes
    }
    // kits faltantes: reembalados pela regra (26 / meia caixa / individuais) no palete do produto
    let kitsPlaced = 0
    const findKit = (sku: string) => {
      const ol = planOrder.find((o) => o.pack.sku === sku)
      return ol ? { packId: ol.packId, pack: ol.pack } : null
    }
    next = next.map((d, i) => {
      if (target !== 'auto' && i !== target) return d
      const r = completePalletCompanions(d, findKit, maxH)
      kitsPlaced += r.added.reduce((s, a) => s + a.placed, 0)
      return r.doc
    })
    edit(next, `${placed} caixa(s)${kitsPlaced ? ` e ${kitsPlaced} kit(s)` : ''} pendente(s) colocada(s).`)
  }

  /** PDF do plano (gerado no navegador): resumo, conferência e vistas de cada palete */
  /** PDF gerado aguardando a prévia (baixar, imprimir, e-mail, WhatsApp) */
  const [pdfPreview, setPdfPreview] = useState<{ blob: Blob; name: string; courier: boolean } | null>(null)

  /** PDF com preço → registra em Cotações emitidas (o servidor recalcula); falha não impede o PDF */
  const recordQuote = (origin: 'mixed' | 'courier', v: ReturnType<typeof mixedOrderValue> | null) => {
    if (!v || v.totalUsd == null) return
    void recordPlannerQuoteAction({ origin, reference: reference.trim() || null, destination, agentId, incoterm, lang: effLang, lines: v.lines.map((l) => ({ sku: l.sku, units: l.units })) }).catch(() => null)
  }

  async function exportPdf() {
    if (!plan && !courier) return
    setPdfBusy(true)
    try {
      const flag = await flagPng(destination)
      if (courier) {
        const { buildCourierPdf } = await import('@/lib/pdf/courierPdf')
        const logo = await fetch(PDF_LOGO_PATH).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null)
        // vistas do 3D da tela (perspectiva dos dois lados); sem WebGL o PDF sai só com as tabelas
        let images: Uint8Array[] = []
        try {
          images = (courierCapture.current?.(['iso-front', 'iso-rear'], { width: 1400, height: 900 }) ?? []).map((u) => Uint8Array.from(atob(u.split(',')[1] ?? ''), (c) => c.charCodeAt(0)))
        } catch {
          images = []
        }
        const bytes = await buildCourierPdf(courier, { reference: reference.trim() || undefined, destination: destination.trim() || undefined, generatedAt: new Date(), lang: effLang, logo, images, stacked: stackCourier, flag, value: priced?.pdf ?? null, generatedBy: p.generatedBy ?? null })
        const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
        const ref = reference.trim().replace(/[^\w.-]+/g, '_')
        recordQuote('courier', priced)
        setPdfPreview({ blob, courier: true, name: `${effLang === 'en' ? 'package-list' : effLang === 'es' ? 'lista-de-bultos' : 'lista-de-volumes'}${ref ? '-' + ref : ''}-${dayBR(new Date())}.pdf` })
        setMsg(images.length ? { type: 'ok', text: 'Lista de volumes gerada com as vistas 3D.' } : { type: 'warn', text: 'Lista de volumes gerada SEM as vistas 3D (o 3D ainda não estava pronto na tela). Aguarde a visualização aparecer e gere de novo.' })
        return
      }
      if (!plan) return
      const { buildMixedPdf } = await import('@/lib/pdf/mixedPdf')
      const logo = await fetch(PDF_LOGO_PATH).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? new Uint8Array(b) : null)).catch(() => null)
      const bytes = await buildMixedPdf(plan, { reference: reference.trim() || undefined, mode, maxHeightMm: maxH, generatedAt: new Date(), lang: effLang, logo, destination: destination.trim() || undefined, flag, value: pricedPlan?.pdf ?? null, generatedBy: p.generatedBy ?? null })
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
      const ref = reference.trim().replace(/[^\w.-]+/g, '_')
      recordQuote('mixed', pricedPlan)
      setPdfPreview({ blob, courier: false, name: `${effLang === 'en' ? 'mixed-pallets' : effLang === 'es' ? 'pallets-mixtos' : 'paletes-mistos'}${ref ? '-' + ref : ''}-${dayBR(new Date())}.pdf` })
    } catch {
      setMsg({ type: 'error', text: 'Não foi possível gerar o PDF.' })
    } finally {
      setPdfBusy(false)
    }
  }

  const filtered = p.catalog.filter((c) => !filter || `${c.sku} ${c.name}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 60)
  const editingDoc = editing != null && docs ? docs[editing] : null

  return (
    <div className="mixed">
      {editingDoc && (
        <div className="overlay-full">
          <PalletEditor
            key={`${editing}-${editingDoc.items.length}`}
            initial={editingDoc}
            catalog={p.catalog}
            readOnly={false}
            heading={`Palete ${editing! + 1} do plano`}
            saveLabel="Aplicar ao plano"
            maxHeightMm={maxH}
            onClose={() => setEditing(null)}
            save={async (d) => {
              edit(docs!.map((x, i) => (i === editing ? d : x)), `Palete ${editing! + 1} atualizado.`)
              return { ok: true }
            }}
          />
        </div>
      )}
      <div className="page-head">
        <h1>Pedido → paletes mistos</h1>
        {p.onClose && <button onClick={p.onClose}>Fechar</button>}
      </div>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      {pdfPreview && (
        <PdfPreview
          blob={pdfPreview.blob}
          fileName={pdfPreview.name}
          lang={effLang}
          subject={`${pdfPreview.courier ? pdfText(effLang).courierDocTitle : pdfText(effLang).mixedDocTitle}${reference.trim() ? ` — ${reference.trim()}` : ""}`}
          docLabel={
            (pdfPreview.courier
              ? { pt: 'a lista de volumes para coleta', es: 'la lista de bultos para la recolección', en: 'the package list for pickup' }
              : { pt: 'o plano de paletes', es: 'el plan de pallets', en: 'the pallet plan' })[effLang] + (reference.trim() ? ` (${reference.trim()})` : '')
          }
          onClose={() => setPdfPreview(null)}
        />
      )}

      <div className="mixed-grid">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>1 · Pedido</h3>
          <OrderAssistant
            onOrder={(o) => {
              // linhas: a quantidade informada substitui a do mesmo produto; os demais produtos ficam
              const bySku = new Map(p.catalog.map((c) => [c.sku.toUpperCase(), c]))
              const missing: string[] = []
              const found: { key: string; units: number; fullPallets?: number }[] = [
                ...o.lines.flatMap((l) => {
                  const c = bySku.get(l.sku.toUpperCase())
                  if (!c) missing.push(l.sku)
                  return c ? [{ key: packKey(c), units: l.units }] : []
                }),
                // paletes completos: as unidades saem do motor com a altura/palete desta tela (inclui acompanhantes)
                ...(o.fullPallets ?? []).flatMap((l) => {
                  const c = bySku.get(l.sku.toUpperCase())
                  if (!c) missing.push(l.sku)
                  return c ? [{ key: packKey(c), units: 0, fullPallets: l.pallets }] : []
                }),
              ]
              setLines((ls) => [...ls.filter((x) => !found.some((f) => f.key === x.key)), ...found])
              // modalidade travada (tipo de envio da carga): a IA não a troca
              if (!p.lockMode && o.mode && o.mode !== mode) {
                setMode(o.mode)
                setManualH(DEFAULT_MANUAL_H[o.mode] || 0)
              }
              if (o.maxHeightMm) setManualH(o.maxHeightMm)
              if (o.destination) setDestination(o.destination)
              setDocs(null)
              return missing.length ? `Sem embalagem cadastrada (não adicionados): ${missing.join(', ')}.` : null
            }}
          />
          <input placeholder="Buscar produto (código ou descrição)…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
          {filter && (
            <div className="list-select" style={{ maxHeight: 180 }}>
              {filtered.map((c) => (
                <button
                  key={packKey(c)}
                  onClick={() => {
                    setLines((ls) => (ls.some((l) => l.key === packKey(c)) ? ls : [...ls, { key: packKey(c), units: 1 }]))
                    setFilter('')
                  }}
                >
                  <span className="swatch" style={{ background: c.color }} />
                  <span>
                    <strong>{c.sku}</strong> {c.name}
                    <br />
                    <small>
                      caixa {c.dims.l}×{c.dims.w}×{c.dims.h} mm · {kg(c.grossKg)} · {c.unitsPerPackage} un./caixa
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
          <table className="data compact" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Produto</th>
                <th className="num">Unidades</th>
                <th className="num">Caixas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {effLines.map((l) => {
                const c = byKey.get(l.key)
                return (
                  <tr key={l.key}>
                    <td>
                      <span className="swatch" style={{ background: c?.color }} />
                      <strong>{c?.sku}</strong> <small className="muted">{c?.name}</small>
                    </td>
                    <td className="num">
                      <input type="number" min={0} value={l.units} style={{ width: 80 }} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { key: x.key, units: Math.max(0, Math.floor(Number(e.target.value) || 0)) } : x)))} />
                      {l.fullPallets ? (
                        <div className="muted" style={{ fontSize: 11 }} title="Calculado com a altura máxima, o tipo de palete e o peso atuais, contando os acompanhantes por cima (ex.: KIT-HF em caixas de 26 kits / meia caixa). Editar o número desfaz o vínculo.">
                          {l.fullPallets} palete(s) completo(s){perPallet.get(l.key) ? ` · ${nf0.format((perPallet.get(l.key) ?? 0) * Math.max(1, c?.unitsPerPackage ?? 1))} un./palete` : ' · não cabe'}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{c ? nf0.format(Math.ceil(l.units / Math.max(1, c.unitsPerPackage))) : '—'}</td>
                    <td>
                      <button className="small" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
              {autoLines.map((a) => (
                <tr key={`auto-${a.packId}`} style={{ background: '#f4f8f6' }}>
                  <td>
                    <span className="swatch" style={{ background: a.pack.color }} />
                    <strong>{a.pack.sku}</strong> <small className="muted">{a.pack.name} · automático (1 por {a.for.join(', ')})</small>
                  </td>
                  <td className="num">{nf0.format(a.kits)}</td>
                  {kitFamilyOf(a.pack.sku) ? (
                    // caixas de 26 / meia caixa / individuais: por palete na montagem (courier: o pedido inteiro)
                    <td className="num" title={mode === 'COURIER' ? describeKitBoxes(kitBoxLines(courierOrder.filter((o) => o.pack.sku === a.pack.sku).flatMap((o) => Array<PackSnapshot>(o.boxes).fill(o.pack)))) : 'Caixa 79583 (26 kits), meia caixa (até 13) e individuais: definidas por palete na montagem'}>
                      {mode === 'COURIER' ? nf0.format(packKits(a.kits, a.pack.sku).length) : 'por palete'}
                    </td>
                  ) : (
                    <td className="num">{nf0.format(a.boxes)}</td>
                  )}
                  <td />
                </tr>
              ))}
              {!lines.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    Busque e adicione os produtos do pedido.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h3 style={{ marginTop: 0 }}>2 · Transporte e paletes</h3>
          <label className="field">
            Modalidade
            <select
              value={mode}
              disabled={p.lockMode}
              title={p.lockMode ? 'Definida pelo tipo de envio da carga' : undefined}
              onChange={(e) => {
                const m = e.target.value as TransportMode
                setMode(m)
                setManualH(DEFAULT_MANUAL_H[m] || 0)
              }}
            >
              {(Object.keys(TRANSPORT_LABEL) as TransportMode[]).map((m) => (
                <option key={m} value={m}>
                  {TRANSPORT_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            País de destino
            <CountryInput value={destination} onChange={setDestination} categoryOf={categoryOf} />
          </label>
          {rules && rules.applied.length > 0 && (
            <small className="muted" style={{ display: 'block', marginBottom: 6 }}>
              Regras logísticas: {rules.applied.map((a) => a.description).join(' · ')}
            </small>
          )}
          {mode === 'COURIER' ? (
            <CourierOptions divisor={divisor} setDivisor={setDivisor} />
          ) : (
          <>
          <label className="field">
            Altura máxima do palete carregado (mm){containerH ? ` — ${noEqSpace ? 'envio' : 'equipamento'}: ${nf0.format(containerH)}` : ''}
            <input type="number" min={0} value={manualH || ''} placeholder={containerH ? `automático (${nf0.format(containerH)})` : 'informe (depende do operador)'} onChange={(e) => setManualH(Math.max(0, Number(e.target.value) || 0))} />
          </label>
          <small className="muted" style={{ display: 'block' }}>
            {mode === 'FCL' || mode === 'ROAD'
              ? noEqSpace
                ? 'Limitada pela altura máxima do envio (painel "Envio sem equipamento"). Um valor menor aqui também é respeitado.'
                : 'Usa a menor entre altura interna e altura da porta do equipamento (e o limite dos perfis). Um valor menor aqui também é respeitado.'
              : 'Aéreo / LCL / só paletes: altura definida pelo operador logístico.'}{' '}
            Altura usada: <strong>{maxH ? mm(maxH) : '—'}</strong> (tabuleiro + caixas).
          </small>
          <label className="field" style={{ marginTop: 6 }}>
            Peso máx. por palete (kg, opcional)
            <input type="number" min={0} value={maxKg} placeholder="capacidade cadastrada do palete" onChange={(e) => setMaxKg(e.target.value === '' ? '' : Math.max(0, Number(e.target.value)))} />
          </label>
          <label className="check" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={autoTypes} onChange={(e) => setAutoTypes(e.target.checked)} /> Tipos de palete automáticos (regra logística; senão, padrão de cada produto)
          </label>
          {autoTypes ? (
            <small className="muted">
              {usedTypes.map((t) => `${t.code} ${t.dims.l}×${t.dims.w}`).join(' · ') || 'adicione produtos'}
              {fallbackTypes.length > 0 && ` · reserva (caixas que não cabem): ${fallbackTypes.map((t) => t.code).join(', ')}`}
            </small>
          ) : (
            p.palletTypes.map((t) => (
              <label key={t.palletTypeId} className="check">
                <input type="checkbox" checked={typeIds.includes(t.palletTypeId)} onChange={(e) => setTypeIds((ids) => (e.target.checked ? [...ids, t.palletTypeId] : ids.filter((x) => x !== t.palletTypeId)))} /> {t.code}{' '}
                <small className="muted">
                  {t.dims.l}×{t.dims.w}×{t.dims.h} mm
                </small>
              </label>
            ))
          )}
          <button className="primary" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} onClick={run}>
            ⚙ Otimizar paletes mistos
          </button>
          </>
          )}
        </div>
      </div>

      {courier && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
            <span>
              <strong>{nf0.format(courier.totals.pieces)}</strong> volume(s) — caixas soltas, sem palete
            </span>
            <span>
              Peso real <strong>{kg(courier.totals.grossKg)}</strong>
            </span>
            <span title={`C × L × A (cm) ÷ ${divisor}`}>
              Volumétrico <strong>{kg(courier.totals.volKg)}</strong>
            </span>
            <span title="Soma, por volume, do maior entre o peso real e o volumétrico (a transportadora confirma)">
              Taxável estimado <strong>{kg(courier.totals.chargeableKg)}</strong>
            </span>
            <span>{m3(courier.totals.cbm)}</span>
            <span className="spacer" />
            <input placeholder="Pedido / referência (para o PDF)" value={reference} onChange={(e) => setReference(e.target.value)} style={{ width: 210 }} />
            <select value={effLang} onChange={(e) => setPdfLang(e.target.value as PdfLang)} title="Idioma do PDF (sugerido pelo país de destino)" style={{ fontSize: 12 }}>
              {PDF_LANGS.map((l) => (
                <option key={l.value} value={l.value}>
                  PDF: {l.label}
                </option>
              ))}
            </select>
            {p.onApplyCourier && (
              <button className="primary" disabled={!courier.totals.pieces} onClick={() => setMsg({ type: 'ok', text: p.onApplyCourier!(courierOrder, divisor) })} title="Grava estes volumes no envio (substitui o conteúdo atual)">
                Aplicar ao envio →
              </button>
            )}
            <button onClick={() => void exportPdf()} disabled={pdfBusy || !courier.totals.pieces} title="Prévia do PDF; depois baixar, imprimir, enviar por e-mail ou WhatsApp">
              {pdfBusy ? 'Gerando PDF…' : '📄 Lista de volumes (PDF)'}
            </button>
          </div>
          {courier.rows.length > 0 ? (
            <table className="data compact" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Produto</th>
                  <th className="num">Volumes</th>
                  <th className="num">Unidades</th>
                  <th className="num">Medidas por caixa (cm)</th>
                  <th className="num">Peso real / caixa</th>
                  <th className="num">Volumétrico / caixa</th>
                  <th className="num">Peso real total</th>
                </tr>
              </thead>
              <tbody>
                {courier.rows.map((r, i) => (
                  <tr key={`${r.sku}-${i}`}>
                    <td>
                      <strong>{r.sku}</strong> <small className="muted">{r.kitBox ? `${r.name} — ${kitBoxLabel(r.kitBox)}` : r.name}</small>
                    </td>
                    <td className="num">{nf0.format(r.boxes)}</td>
                    <td className="num">{nf0.format(r.units)}</td>
                    <td className="num">
                      {Math.round(r.dimsMm.l / 10)} × {Math.round(r.dimsMm.w / 10)} × {Math.round(r.dimsMm.h / 10)}
                    </td>
                    <td className="num">{kg(r.grossKgEach)}</td>
                    <td className="num">{kg(r.volKgEach)}</td>
                    <td className="num">{kg(r.grossKg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Adicione os produtos do pedido.</p>
          )}
          {cLayout && cLayout.boxes.length > 0 && (
            <>
              <div className="row" style={{ marginTop: 8, gap: 12, alignItems: 'center' }}>
                <strong style={{ fontSize: 13 }}>Visualização 3D</strong>
                <label className="check" style={{ margin: 0 }}>
                  <input type="radio" checked={!stackCourier} onChange={() => setStackCourier(false)} /> lado a lado
                </label>
                <label className="check" style={{ margin: 0 }}>
                  <input type="radio" checked={stackCourier} onChange={() => setStackCourier(true)} /> empilhadas (mesmo produto, até 1,5 m)
                </label>
                {cLayout.hidden > 0 && <small className="muted">{cLayout.hidden} volume(s) além dos 300 primeiros não desenhados</small>}
              </div>
              <CourierView layout={cLayout} onCaptureReady={(fn) => (courierCapture.current = fn)} />
            </>
          )}
          <small className="muted" style={{ display: 'block', marginTop: 6 }}>
            O PDF leva estas vistas 3D (perspectiva dos dois lados), com os volumes numerados como na lista. Cada caixa vai como um volume (lado a lado ou empilhadas); acompanhantes obrigatórios já incluídos (KIT-HF em caixas de 26 kits, meia caixa até 13 e individuais). O PDF traz a lista de volumes um a um e o endereço de coleta na fábrica, para o cliente agendar com DHL, FedEx, UPS…
          </small>
        </div>
      )}

      {p.pricing && priced && <MixedValuePanel payload={p.pricing} value={priced} destination={destination} agentId={agentId} onAgent={setAgentId} incoterm={incoterm} onIncoterm={setIncoterm} stale={planStale} />}

      {mode !== 'COURIER' && plan && docs && (
        <>
          <div className="panel" style={{ marginTop: 12 }}>
            <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
              <span>
                <strong>{plan.totals.pallets}</strong> paletes
              </span>
              <span>
                <strong>{plan.positions}</strong> posições de piso
              </span>
              <span>
                Bruto <strong>{kg(plan.totals.grossKg)}</strong>
              </span>
              <span>
                <span title="Soma das medidas externas (C × L × A) de cada palete montado — base para cotar o frete">
                  Cubagem total <strong>{m3(plan.totals.cbm)}</strong> <small className="muted">(soma dos {plan.totals.pallets} paletes)</small>
                </span>
              </span>
              <span>
                {nf0.format(plan.totals.boxes)} caixas · {nf0.format(plan.totals.units)} unidades
              </span>
              <span className={`badge ${plan.ok ? 'ok' : 'WARNING'}`}>{plan.ok ? '✓ pedido conferido, sem alertas críticos' : 'verificar pendências/alertas'}</span>
              <span className="spacer" />
              <input placeholder="Pedido / referência (para o PDF)" value={reference} onChange={(e) => setReference(e.target.value)} style={{ width: 210 }} />
              <select value={effLang} onChange={(e) => setPdfLang(e.target.value as PdfLang)} title="Idioma do PDF (sugerido pelo país de destino)" style={{ fontSize: 12 }}>
                {PDF_LANGS.map((l) => (
                  <option key={l.value} value={l.value}>
                    PDF: {l.label}
                  </option>
                ))}
              </select>
              <button onClick={() => void exportPdf()} disabled={pdfBusy || !plan.totals.pallets} title="Prévia do PDF; depois baixar, imprimir, enviar por e-mail ou WhatsApp">
                {pdfBusy ? 'Gerando PDF…' : '📄 PDF'}
              </button>
              {p.onApply && (mode !== 'PALLETS_ONLY' || p.lockMode) && (
                <button
                  className="primary"
                  disabled={!plan.totals.pallets}
                  onClick={() => setMsg({ type: 'ok', text: p.onApply!(plan.pallets.map((x) => x.doc), mode, maxH) })}
                  title={p.lockMode ? 'Grava estes paletes no envio (substitui o conteúdo atual)' : 'Coloca os paletes no equipamento da carga (piso, empilhamento e distribuição de peso)'}
                >
                  {p.lockMode ? 'Aplicar ao envio →' : 'Colocar na carga →'}
                </button>
              )}
            </div>
            <small className="muted">
              Critério: quantidades exatas → posições de piso (palete duplo = 2) → nº de paletes → volume vazio → alturas parelhas. {plan.strategy}
              {plan.evaluated ? ` · ${plan.evaluated} alternativas avaliadas` : ''}
            </small>
            <table className="data compact" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Produto</th>
                  <th className="num" title="Caixas do pedido; acompanhantes (ex.: KIT-HF) em kits">Pedido (cx)</th>
                  <th className="num">Nos paletes</th>
                  <th className="num">Pendente</th>
                </tr>
              </thead>
              <tbody>
                {plan.check.map((c) => (
                  <tr key={c.sku} style={c.ok ? undefined : { background: '#fff7e0' }}>
                    <td>
                      <strong>{c.sku}</strong> <small className="muted">{c.name}</small>
                    </td>
                    <td className="num">{nf0.format(c.requested)}</td>
                    <td className="num">{nf0.format(c.placed)}</td>
                    <td className="num">{c.placed === c.requested ? '✓' : c.placed < c.requested ? nf0.format(c.requested - c.placed) : `excede ${nf0.format(c.placed - c.requested)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {plan.notes.length > 0 && (
              <div className="alert" style={{ marginTop: 6, fontSize: 12 }}>
                {plan.notes.map((n) => (
                  <div key={n}>ℹ {n}</div>
                ))}
              </div>
            )}
            {plan.unplaced.length > 0 && (
              <div className="alert warn" style={{ marginTop: 6 }}>
                Não colocado: {plan.unplaced.map((u) => `${u.boxes} × ${u.sku} (${u.reason})`).join(' · ')}
              </div>
            )}
            {pending.length > 0 && (
              <button style={{ marginTop: 6 }} onClick={() => placePending('auto')}>
                Colocar pendentes (nos paletes com espaço; o resto em paletes novos)
              </button>
            )}
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h3 style={{ marginTop: 0 }}>Edição: mover / retirar caixas</h3>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
              <label className="field">
                Do palete
                <select value={mv.from} onChange={(e) => setMv({ ...mv, from: Number(e.target.value), sku: '' })}>
                  {plan.pallets.map((x, i) => (
                    <option key={i} value={i}>
                      Palete {i + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Produto
                <select value={mv.sku} onChange={(e) => setMv({ ...mv, sku: e.target.value })}>
                  <option value="">—</option>
                  {(plan.pallets[mv.from]?.lines ?? []).map((l) => (
                    <option key={l.sku} value={l.sku}>
                      {l.sku} ({l.boxes})
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ width: 80 }}>
                Qtd.
                <input type="number" min={1} value={mv.qty} onChange={(e) => setMv({ ...mv, qty: Math.max(1, Number(e.target.value) || 1) })} />
              </label>
              <label className="field">
                Para
                <select value={String(mv.to)} onChange={(e) => setMv({ ...mv, to: e.target.value === 'out' || e.target.value === 'new' ? e.target.value : Number(e.target.value) })}>
                  <option value="out">retirar (fica pendente)</option>
                  {plan.pallets.map((x, i) =>
                    i === mv.from ? null : (
                      <option key={i} value={i}>
                        Palete {i + 1}
                      </option>
                    ),
                  )}
                  <option value="new">novo palete (mesmo tipo)</option>
                </select>
              </label>
              <button className="primary" disabled={!mv.sku} onClick={doMove}>
                Aplicar
              </button>
            </div>
            <small className="muted">As caixas saem sempre de cima e entram na posição livre mais baixa, 100% apoiadas e dentro da altura máxima. Para mudar posição/orientação de uma caixa ou de uma camada, abra o palete em 3D.</small>
          </div>

          <div className="mixed-cards">
            {plan.pallets.map((x, i) => {
              const crit = x.issues.filter((s) => s.severity === 'CRITICAL')
              return (
                <div key={i} className={`panel mixed-card ${crit.length ? 'bad' : ''}`}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>PALETE {i + 1}</strong>
                    <small className="muted">
                      {x.doc.palletType.code} · {x.doc.palletType.dims.l}×{x.doc.palletType.dims.w}
                    </small>
                  </div>
                  {x.lines.map((l) => (
                    <div key={l.sku} className="mixed-line" title={kitFamilyOf(l.sku) ? describeKitBoxes(kitBoxLines(x.doc.items.map((it) => x.doc.packs[it.packId]).filter((k) => k?.sku === l.sku))) : undefined}>
                      <span className="swatch" style={{ background: x.doc.packs[Object.keys(x.doc.packs).find((k) => x.doc.packs[k].sku === l.sku)!]?.color }} />
                      <span>{l.sku}</span>
                      {/* kits: unidades (kits) e caixas (26 / meia caixa / individuais) */}
                      <strong>{kitFamilyOf(l.sku) ? `${nf0.format(l.units)} kits · ${nf0.format(l.boxes)} cx` : `${nf0.format(l.boxes)} un.`}</strong>
                    </div>
                  ))}
                  <div className="mixed-kpis">
                    <span>
                      Peso <strong>{kg(x.grossKg)}</strong>
                    </span>
                    <span>
                      Altura <strong>{(x.heightMm / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m</strong>
                    </span>
                    <span>
                      Ocupação <strong>{nf0.format(x.volumeUtilPct)}%</strong>
                    </span>
                    <span title="Medidas externas do palete montado (C × L × A) e cubagem para cotação de frete">
                      Medidas{' '}
                      <strong>
                        {Math.round(x.outerMm.l / 10)} × {Math.round(x.outerMm.w / 10)} × {Math.round(x.outerMm.h / 10)} cm
                      </strong>{' '}
                      · <strong>{x.cbm.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} m³</strong>
                    </span>
                  </div>
                  {crit.length > 0 && <div className="alert error" style={{ margin: '4px 0' }}>{crit.map((c) => c.message).join(' · ')}</div>}
                  <div className="row" style={{ gap: 6 }}>
                    <button className="small primary" onClick={() => setEditing(i)}>
                      Ver / editar 3D
                    </button>
                    <button className="small" onClick={() => edit(docs.filter((_, k) => k !== i), `Palete ${i + 1} excluído: as caixas ficaram pendentes.`)}>
                      Excluir palete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Assistente IA do pedido: o usuário escreve o pedido inteiro ("30 hidrosilos de 10 mil, 50 silo bolsas
 * 9×60, aéreo para Chile") e a IA identifica os produtos pelo catálogo e preenche as linhas. Quem monta
 * os paletes continua sendo o motor (botão "Otimizar"), depois da revisão das linhas.
 */
function OrderAssistant({ onOrder }: { onOrder: (o: ParsedOrder) => string | null }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  async function send() {
    const m = text.trim()
    if (!m || busy) return
    setBusy(true)
    setReply(null)
    try {
      const r = await parseOrderAction(m)
      if (!r.ok) {
        setReply({ type: 'error', text: r.error })
        return
      }
      const warn = r.order.lines.length || r.order.fullPallets?.length || r.order.mode || r.order.destination || r.order.maxHeightMm ? onOrder(r.order) : null
      setReply({ type: 'ok', text: [r.order.text, warn].filter(Boolean).join('\n') })
      if (r.order.lines.length) setText('')
    } catch {
      setReply({ type: 'error', text: 'Falha de comunicação com o servidor.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ border: '1px solid #9fd8c0', background: '#f6fbf8', borderRadius: 8, padding: 8, marginBottom: 8 }}>
      <label className="field" style={{ margin: 0 }}>
        <span>
          <strong>✨ Assistente IA</strong> <small className="muted">escreva o pedido inteiro; a IA identifica os produtos e preenche as linhas</small>
        </span>
        <textarea
          rows={2}
          value={text}
          maxLength={4000}
          placeholder="Ex.: 20 hidrosilos de 10.000 L, 10 de 20.000 L e 50 silo bolsas 9×60 ProBag — aéreo para Chile, altura 1,6 m"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
      </label>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="primary small" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? 'Interpretando…' : 'Preencher pedido'}
        </button>
        <DictationButton value={text} onChange={setText} disabled={busy} size="small" />
        <small className="muted">Revise as linhas e clique em “Otimizar paletes mistos”.</small>
      </div>
      {reply && (
        <div className={reply.type === 'error' ? 'alert error' : 'muted'} style={{ marginTop: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {reply.text}
        </div>
      )}
    </div>
  )
}

/** Courier: só o divisor do peso volumétrico (sem palete, altura nem equipamento). */
function CourierOptions({ divisor, setDivisor }: { divisor: number; setDivisor: (n: number) => void }) {
  return (
    <>
      <label className="field">
        Divisor do peso volumétrico (cm³/kg)
        <input type="number" min={1000} step={100} value={divisor} onChange={(e) => setDivisor(Math.max(1, Number(e.target.value) || 5000))} />
      </label>
      <small className="muted" style={{ display: 'block' }}>
        Sem palete e sem contêiner/caminhão: cada caixa é um volume. Peso volumétrico = C × L × A (cm) ÷ divisor — 5000 é o usual no courier expresso internacional (confirme com a DHL/FedEx do cliente; alguns contratos usam 6000). A lista aparece abaixo, já com os acompanhantes obrigatórios (KIT-HF em caixas de 26 kits, meia caixa até 13 e individuais).
      </small>
    </>
  )
}

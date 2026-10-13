'use client'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { AABB, ORIENTATION_LABEL, Orientation, orientDims, Vec3 } from '@/domain/geometry'
import { distinctOrientations, naturalOrientations, nextFlip, nextYaw, reorientPosition } from '@/domain/orientation'
import { editPalletItems, itemToSpace, localObstacles, palletLocalBounds, spaceDeltaToLocal, spaceToItemPos } from '@/domain/palletEdit'
import { loadGeometries, palletParts, roadAxles, validateLoad, shortUnitLabel } from '@/domain/load'
import { adaptRoad, AXLE_COLOR, AxlePanel, RoadOptions } from './AxlePanel'
import { brandLabelFor } from '@/domain/brandLabels'
import { newPhysicalCriticals } from '@/domain/issues'
import { isOutsideSpace } from '@/domain/staging'
import { itemBox, palletEnvelope, palletSummary } from '@/domain/pallet'
import { dropZ, findFreePosition, placementProblem, restZ } from '@/domain/placement'
import { boxObstacles, placeLooseBoxes } from '@/domain/autoload'
import { placeMixedPalletsInLoad } from '@/domain/mixedLoad'
import { addBoxesToMixed } from '@/domain/mixedPallets'
import { groupsOfDoc, planNotes, splitIntoUnits } from '@/domain/multiUnit'
import { MultiUnitPanel } from './MultiUnitPanel'
import { defaultPdfLang, PDF_LANGS, PdfLang } from '@/lib/pdf/i18n'
import { PdfPreview } from '@/components/pdf/PdfPreview'
import { pdfText } from '@/lib/pdf/i18n'
import type { TransportMode } from '@/domain/mixedPallets'
import { MixedPlanner } from '../mixed/MixedPlanner'
import { balanceWeight, BalanceResult } from '@/domain/balance'
import { evaluateQuadrants, footprintFractions, Quadrant, QUADRANTS, quadrantShares } from '@/domain/quadrants'
import { distinctSkuColors } from '@/domain/colors'
import { stackable } from '@/domain/policy'
import { addMissingCompanions, companionStatus, palletHeightLimit } from '@/domain/companions'
import { kitFamilyOf, packKeyOf } from '@/domain/kitBoxes'
import { KitPalletFit, kitPalletForHeight } from '@/domain/kitPallet'
import { LogisticsResolution, RULE_LIMIT_PROFILE_ID, withRuleLimit } from '@/domain/logisticsRules'
import type { LimitSnapshot, LoadDoc, LoadUnit, PackSnapshot, PalletDoc, PalletItem, PalletTypeSnapshot, SpaceSnapshot } from '@/domain/types'
import { kg, m3, mm, nf0, nf1, pct } from '../format'
import type { CaptureFn, OrbitRecorder, SceneBody, ViewPreset } from '../three/Scene3D'
import { exportExpeditionPdf } from './expeditionExport'
import { Video360, VideoInfo } from './Video360'
import { SpreadPanel } from './SpreadPanel'
import { WeightBalance } from './WeightBalance'
import { AssistantPanel } from './AssistantPanel'
import { createDocStore, newId } from './docStore'
import { palletBoxCounts, removeBoxesFromPallet } from '@/domain/partial'
import { palletTareBySku } from '@/domain/weights'
import { VEHICLE_LENGTH_LIMITS, withVehicleLength } from '@/domain/vehicleLength'
import { COURIER_STACK_H, TYPE_INFO, withNoneWorkArea } from '@/domain/shipmentType'
import { acquireEditLockAction, releaseEditLockAction } from '@/app/cargas/actions'
import { docOrderLines, fitNone, noneMetrics } from '@/domain/noEquipment'
import { IssuesList, Kpi, NumberInput, SNAP_OPTIONS, UnsavedBanner, useBeforeUnload, useEditorKeys, useUnsavedGuard, ViewButtons } from './ui'

const Scene3D = dynamic(() => import('../three/Scene3D').then((m) => m.Scene3D), { ssr: false, loading: () => <div className="hint">Carregando 3D…</div> })

export interface CompositionOption {
  key: string
  id: number
  name: string
  doc: PalletDoc
}

interface Props {
  initial: LoadDoc
  compositions: CompositionOption[]
  catalog: PackSnapshot[]
  spaces: SpaceSnapshot[]
  profiles: LimitSnapshot[]
  editable: boolean
  title: React.ReactNode
  /** versão em rascunho onde o Assistente IA pode propor composições */
  assistantVersionId?: number
  /** atalho "Criar com IA" da página principal: executa o texto guardado assim que o editor abre */
  assistantAutoRun?: boolean
  save: (doc: LoadDoc, changelog: string, expectedUpdatedAt?: string) => Promise<{ ok?: boolean; error?: string; critical?: number; updatedAt?: string }>
  /** carimbo da versão quando a tela foi aberta (controle de concorrência) */
  versionUpdatedAt?: string
  /** endpoint do PDF do pedido (versão salva) */
  pdfUrl?: string
  /** dados para o otimizador de paletes mistos (pedido → paletes → carga) */
  mixed?: { palletTypes: PalletTypeSnapshot[]; stdPallet: Record<string, number>; defaultMode: TransportMode; destination?: string | null; lockMode?: boolean; autoOpen?: boolean }
  /** regras logísticas resolvidas para a modalidade/destino do envio */
  logistics?: LogisticsResolution | null
  /** grava um pedido dividido em várias unidades (todas ou nenhuma) */
  saveMulti?: (docs: LoadDoc[], changelog: string, expectedUpdatedAt?: string) => Promise<{ ok?: boolean; error?: string; planIds?: number[]; updatedAt?: string }>
  /** cadastros para a distribuição por eixo (cavalos, implementos/chassis, limites por país) */
  road?: RoadOptions
  /** dados da carga para a tarja do vídeo 360° (cliente, pedido, destino) */
  videoInfo?: VideoInfo
  /** área do envio (exportação × mercado interno) */
  area?: string | null
  /** PDF de expedição (instrução de carregamento, sem preços): versão, status, modalidade, transportadora */
  expedition?: { version: number; status: string; mode: string | null; transportCompany: string | null }
  /** nome do usuário logado: rodapé discreto dos PDFs gerados aqui (expedição, mistos, courier) */
  userName?: string
  /** fotos do carregamento anexadas (podem ir no PDF do pedido) */
  photoCount?: number
  /** carga (bloqueio de edição: um usuário por vez) */
  planId?: number
  /** celular: ações da página (ex.: aprovar) na barra fixa de baixo, junto dos PDFs */
  mobileActions?: React.ReactNode
}

// caixas coletivas de kits (26 / meia caixa) têm chave própria (domain/kitBoxes)
const packKey = (p: PackSnapshot) => packKeyOf(p)

/**
 * Mensagem de erro da rota do PDF do pedido: o texto pt-BR da própria rota (texto puro ou JSON { error },
 * ex.: 413 "PDF grande demais…", 403 sem permissão). Corte da plataforma (Vercel: corpo grande demais ou
 * tempo esgotado, resposta em inglês/HTML) → texto claro pelo status. `photos`: o pedido incluía as fotos.
 */
async function pdfErrorText(res: Response, photos: boolean): Promise<string> {
  const raw = (await res.text().catch(() => '')).trim()
  let msg = raw
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as { error?: unknown }
      msg = typeof j.error === 'string' ? j.error.trim() : ''
    } catch {
      /* não era JSON: fica o texto */
    }
  }
  const platform = !msg || msg.startsWith('<') || msg.length > 400 || /FUNCTION_|DEPLOYMENT_|An error occurred|Request Entity Too Large|Payload Too Large|Gateway Time-?out|Internal Server Error/i.test(msg)
  if (!platform) return /PDF/.test(msg) ? msg : `Não foi possível gerar o PDF: ${msg}`
  if (res.status === 413) return `PDF grande demais para gerar pelo servidor (limite da plataforma).${photos ? ' Desmarque “com fotos” e gere de novo.' : ' Tente de novo; se repetir, avise o administrador.'}`
  if (res.status === 504) return `A geração do PDF demorou demais e foi interrompida.${photos ? ' Tente de novo ou desmarque “com fotos”.' : ' Tente de novo em instantes.'}`
  return `Não foi possível gerar o PDF (erro ${res.status}).`
}

export function LoadEditor({ initial, compositions, catalog, spaces, profiles, editable: canEdit, title, save, assistantVersionId, versionUpdatedAt, pdfUrl, mixed, logistics, saveMulti, assistantAutoRun, road: roadOpts, videoInfo, area, expedition, photoCount = 0, planId, mobileActions, userName }: Props) {
  // BLOQUEIO DE EDIÇÃO: pega ao abrir, renova a cada minuto, libera ao sair; outro usuário editando = só leitura
  const [lockedBy, setLockedBy] = useState<string | null>(null)
  useEffect(() => {
    if (!canEdit || !planId) return
    let alive = true
    const take = () =>
      acquireEditLockAction(planId)
        .then((r) => alive && setLockedBy(r.ok ? null : r.by))
        .catch(() => null)
    void take()
    const t = setInterval(take, 60_000)
    return () => {
      alive = false
      clearInterval(t)
      void releaseEditLockAction(planId).catch(() => null)
    }
  }, [canEdit, planId])
  /** PDF do pedido com as fotos do carregamento (anexo no fim) */
  const [withPhotos, setWithPhotos] = useState(true)
  const captureRef = useRef<CaptureFn | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  /** idioma do PDF; null = sugerido pelo país de destino do envio */
  const [pdfLang, setPdfLang] = useState<PdfLang | null>(null)
  const effPdfLang = pdfLang ?? defaultPdfLang(mixed?.destination ?? logistics?.context.destination)
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(versionUpdatedAt)
  const [store] = useState(() => createDocStore<LoadDoc>(withNoneWorkArea(initial), withNoneWorkArea))
  const doc = useStore(store, (s) => s.doc)
  const saved = useStore(store, (s) => s.saved)
  const selection = useStore(store, (s) => s.selection)
  const canUndo = useStore(store, (s) => s.past.length > 0)
  const canRedo = useStore(store, (s) => s.future.length > 0)
  const { apply, applyTransient, checkpoint, revertTo, undo, redo, select, markSaved } = store.getState()

  const [view, setView] = useState<ViewPreset>('persp')
  const [viewNonce, setViewNonce] = useState(0)
  const [showWalls, setShowWalls] = useState(true)
  const [showRoof, setShowRoof] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [snapMm, setSnap] = useState(10)
  const [tab, setTab] = useState<'pallet' | 'package' | 'empty'>('pallet')
  // palete vazio: tipos de palete ativos (padrão: o da regra logística do envio, ex.: PCF-1150 no marítimo)
  const palletTypes = mixed?.palletTypes ?? []
  const [emptyType, setEmptyType] = useState<number | null>(() => {
    const rule = logistics?.palletTypeCodes?.[0]
    return (rule ? palletTypes.find((t) => t.code === rule) : undefined)?.palletTypeId ?? palletTypes[0]?.palletTypeId ?? null
  })
  const [addComp, setAddComp] = useState(compositions[0]?.key ?? '')
  // REF de Hydroforce com kits mais alta que esta carga (só 40' HC / rodoviário): o maior palete que cabe,
  // calculado pelo motor (domain/kitPallet) uma vez por montagem e altura
  const kitFits = useRef(new Map<string, KitPalletFit | null>())
  const compForLoad = (c: CompositionOption, limitMm: number): { key: string; doc: PalletDoc; fit: KitPalletFit | null } => {
    const k = `${c.key}|${Math.round(limitMm)}`
    if (!kitFits.current.has(k)) kitFits.current.set(k, kitPalletForHeight(c.doc, limitMm))
    const fit = kitFits.current.get(k) ?? null
    return fit ? { key: `${c.key}:h${Math.round(limitMm)}`, doc: fit.pallet, fit } : { key: c.key, doc: c.doc, fit: null }
  }
  const [addPack, setAddPack] = useState(catalog[0] ? packKey(catalog[0]) : '')
  const [addYaw, setAddYaw] = useState(false)
  const [addOrient, setAddOrient] = useState<Orientation | 'AUTO'>('AUTO')
  const [onTopOnly, setOnTopOnly] = useState(false)
  const [spreadOpt, setSpreadOpt] = useState(false)
  const [showQuadrants, setShowQuadrants] = useState(false)
  const [showPrint, setShowPrint] = useState(true)
  /** carga antes da última distribuição (para "Desfazer distribuição") */
  const [distUndo, setDistUndo] = useState<LoadDoc | null>(null)
  // envio sem equipamento recém-criado: abre direto o planejador de paletes mistos / volumes
  const [showMixed, setShowMixed] = useState(Boolean(mixed?.autoOpen && canEdit && initial.units.length === 0))
  // palete aberto para editar as caixas (duplo clique) e a caixa selecionada nele
  const [inner, setInner] = useState<string | null>(null)
  const [innerSel, setInnerSel] = useState<string | null>(null)
  const [addQty, setAddQty] = useState(1)
  const [allowStack, setAllowStack] = useState(true)
  const [filter, setFilter] = useState('')
  const [changelog, setChangelog] = useState('')
  const [msg, setMsg] = useState<{ type: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  // estado simples (não transition): o 3D re-renderiza continuamente e uma transition poderia não concluir
  const [saving, setSaving] = useState(false)

  // proposta do Assistente IA em pré-visualização: mostrada no 3D/indicadores; edição manual pausada
  const [preview, setPreview] = useState<LoadDoc | null>(null)
  // pedido dividido em várias unidades (IA ou paletes mistos que não couberam): todas na proposta
  const [multi, setMulti] = useState<{ docs: LoadDoc[]; notes: string[]; view: number } | null>(null)
  const [multiBusy, setMultiBusy] = useState(false)
  const editable = canEdit && !preview && !lockedBy
  const shown = preview ?? doc
  const readOnly = !editable
  const router = useRouter()
  // compara conteúdo (não referência): ações sem efeito ou desfazer até o salvo não marcam alteração
  const dirty = useMemo(() => doc !== saved && JSON.stringify(doc) !== JSON.stringify(saved), [doc, saved])
  useBeforeUnload(dirty)
  const rootRef = useRef<HTMLDivElement>(null)

  const { issues, summary } = useMemo(() => validateLoad(shown), [shown])
  // tara dos paletes repartida pelos produtos (peso bruto por produto = c/ embalagem + parte da tara)
  const tareBySku = useMemo(() => palletTareBySku(shown), [shown])
  const quad = useMemo(() => evaluateQuadrants(quadrantShares(shown)), [shown])
  // rodoviário: carga por conjunto de eixos (recalculada a cada movimento, inclusive durante o arrasto)
  const axleRes = useMemo(() => roadAxles(shown), [shown])
  const axleMarks = useMemo(
    () => axleRes?.groups.flatMap((g) => g.axleXs.map((x, i) => ({ x, color: AXLE_COLOR[g.status], label: i === Math.floor((g.axleXs.length - 1) / 2) ? `${g.label}: ${nf0.format(g.kg)} kg${g.pct != null ? ` (${nf0.format(g.pct)}%)` : ''}` : undefined }))) ?? null,
    [axleRes],
  )
  const companions = useMemo(() => companionStatus(shown), [shown])
  const quadKg = useMemo(() => Object.fromEntries(QUADRANTS.map((q) => [q, (quad.shares.pct[q] * quad.shares.totalKg) / 100])) as Record<Quadrant, number>, [quad])
  const geoms = useMemo(() => loadGeometries(shown), [shown])
  // zona de trabalho (fora do equipamento): pendentes de ubicação — marcados à parte, não como erro de posição
  const staged = useMemo(() => new Set(issues.filter((i) => i.code === 'OUTSIDE_LOAD').flatMap((i) => i.refs)), [issues])
  const invalid = useMemo(() => new Set(issues.filter((i) => i.severity === 'CRITICAL' && i.code !== 'OUTSIDE_LOAD').flatMap((i) => i.refs)), [issues])
  const S = shown.space.inner
  /** envio SEM equipamento (LCL, aéreo solto, só paletes, courier): piso virtual */
  const isNone = shown.space.kind === 'NONE'
  /** o que a tela mostra: no envio sem equipamento, o piso do tamanho do conteúdo */
  const shownView = useMemo(() => (isNone ? fitNone(shown) : shown), [isNone, shown])
  const SV = shownView.space.inner
  const noneM = useMemo(() => (isNone ? noneMetrics(shown) : null), [isNone, shown])
  const lo: Vec3 = { x: 0, y: 0, z: 0 }
  const hi: Vec3 = { x: S.l, y: S.w, z: Math.min(S.h, summary.limits.heightMm.value ?? S.h) }

  // uma cor por produto na carga (sem repetir entre SKUs diferentes) — usada no 3D e na legenda
  const colorOf = useMemo(() => {
    const used = shown.units.flatMap((u) => (u.kind === 'PALLET' ? Object.values(shown.pallets[u.palletKey]?.packs ?? {}) : shown.packs[u.packId] ? [shown.packs[u.packId]] : []))
    return distinctSkuColors(used)
  }, [shown])
  // modo "dentro do palete" (duplo clique): as caixas do palete viram selecionáveis; o resto fica translúcido
  const innerUnit = inner ? (shown.units.find((u) => u.id === inner && u.kind === 'PALLET') as Extract<LoadUnit, { kind: 'PALLET' }> | undefined) : undefined
  const innerPallet = innerUnit ? shown.pallets[innerUnit.palletKey] : undefined
  const innerItem = innerPallet && innerSel ? innerPallet.items.find((i) => i.id === innerSel) : undefined
  const innerBodies: SceneBody[] =
    innerUnit && innerPallet
      ? [
          { id: `deck:${innerUnit.id}`, ...palletParts(innerPallet, innerUnit)[0].box, color: '#b48a5a', locked: true },
          ...innerPallet.items.flatMap((it) => {
            const k = innerPallet.packs[it.packId]
            if (!k) return []
            const w = itemToSpace(innerPallet, innerUnit, it)
            return [{ id: `item:${it.id}`, min: w.min, size: w.size, color: colorOf.get(k.sku) ?? k.color, print: k.sku, brand: brandLabelFor(k) ?? undefined, selected: innerSel === it.id, locked: it.locked || readOnly }]
          }),
        ]
      : []
  const bodies: SceneBody[] = geoms.flatMap((g): SceneBody[] => {
    const u = g.unit
    if (innerUnit && u.id === innerUnit.id) return innerBodies
    let parts: SceneBody['parts']
    let color = '#999'
    let print: string | undefined
    let brand: SceneBody['brand']
    if (u.kind === 'PALLET') {
      const p = shown.pallets[u.palletKey]
      parts = palletParts(p, u).map((x) => {
        const k = x.packId ? p.packs[x.packId] : undefined
        return { min: x.box.min, size: x.box.size, color: k ? colorOf.get(k.sku) ?? k.color : '#b48a5a', print: k?.sku, brand: k ? brandLabelFor(k) ?? undefined : undefined }
      })
    } else {
      const k = shown.packs[u.packId]
      color = k ? colorOf.get(k.sku) ?? k.color : '#999'
      print = k?.sku
      brand = k ? brandLabelFor(k) ?? undefined : undefined
    }
    return [
      {
        id: u.id,
        min: g.box.min,
        size: g.box.size,
        parts,
        color,
        print,
        brand,
        dim: Boolean(innerUnit),
        label: `${staged.has(u.id) ? 'FORA DA CARGA · ' : ''}${shortUnitLabel(u, shown.units.indexOf(u))}${u.kind === 'PACKAGE' && !u.label ? ` · ${shown.packs[u.packId]?.sku ?? ''}` : ''}`,
        selected: selection.includes(u.id),
        invalid: invalid.has(u.id),
        staged: staged.has(u.id),
        locked: u.locked,
      },
    ]
  })

  const boxOf = (d: LoadDoc, u: LoadUnit): AABB | null => {
    if (u.kind === 'PALLET') {
      const p = d.pallets[u.palletKey]
      if (!p) return null
      const e = palletEnvelope(p).size
      return { min: u.pos, size: u.yaw ? { x: e.y, y: e.x, z: e.z } : e }
    }
    const k = d.packs[u.packId]
    return k ? { min: u.pos, size: orientDims(k.dims, u.orientation) } : null
  }
  const stackableOf = (d: LoadDoc, u: LoadUnit) => stackable(u.kind === 'PALLET' ? d.pallets[u.palletKey]?.stackable : d.packs[u.packId]?.stackable)
  const obstaclesOf = (d: LoadDoc, except = new Set<string>()) =>
    d.units.filter((u) => !except.has(u.id)).flatMap((u) => {
      const b = boxOf(d, u)
      return b ? [{ box: b, stackable: stackableOf(d, u) }] : []
    })

  function addUnits() {
    // palete VAZIO do tipo escolhido (personalizado): cada um tem a própria montagem; as caixas entram depois, dentro dele
    if (tab === 'empty') {
      const pt = palletTypes.find((t) => t.palletTypeId === emptyType)
      if (!pt) return
      const ids: string[] = []
      apply((d0) => {
        const units = [...d0.units]
        const pallets = { ...d0.pallets }
        const size: Vec3 = addYaw ? { x: pt.dims.w, y: pt.dims.l, z: pt.dims.h } : { x: pt.dims.l, y: pt.dims.w, z: pt.dims.h }
        for (let n = 0; n < addQty; n++) {
          const pos = findFreePosition(obstaclesOf({ ...d0, pallets, units }), size, { lo, hi, allowStacking: allowStack, minSupportPct: summary.limits.thresholds.minSupportPct })
          if (!pos) break
          const key = newId('custom')
          pallets[key] = { name: `Palete personalizado · ${pt.code}`, palletType: pt, packs: {}, items: [], stackable: true, maxTopKg: null, accessoriesKg: 0 }
          const id = newId('u')
          units.push({ id, kind: 'PALLET', palletKey: key, pos, yaw: addYaw, locked: false })
          ids.push(id)
        }
        return ids.length ? { ...d0, pallets, units } : d0
      })
      if (!ids.length) {
        setMsg({ type: 'warn', text: 'Sem posição livre para o palete dentro do espaço/limites.' })
        return
      }
      // entra no palete (o último inserido) para adicionar as caixas
      select([])
      setInner(ids[ids.length - 1])
      setInnerSel(null)
      setFilter('')
      setMsg({ type: 'ok', text: `${ids.length} palete(s) vazio(s) ${pt.code} inserido(s). Escolha o produto à esquerda e adicione as caixas; Esc ou "Sair do palete" volta à carga.` })
      return
    }
    // volumes soltos: motor de caixas (piso e topo dos paletes, orientações permitidas, payload)
    if (tab === 'package') {
      const k = catalog.find((x) => packKey(x) === addPack)
      if (!k) return
      const r = placeLooseBoxes(doc, packKey(k), k, addQty, { orientations: addOrient === 'AUTO' ? undefined : [addOrient], onTopOnly })
      if (r.placed) apply(() => r.doc)
      const why = r.stopReason === 'payload' ? 'limite de payload atingido' : r.stopReason === 'door' ? 'a caixa não passa pela porta/altura nessa orientação' : 'sem posição livre (piso e topo dos paletes)'
      const onTop = r.doc.units.filter((u) => r.unitIds.includes(u.id) && u.pos.z > 0).length
      setMsg(
        r.placed < addQty
          ? { type: 'warn', text: `Adicionadas ${r.placed} de ${addQty} caixas: ${why}.` }
          : { type: 'ok', text: `${r.placed} caixa(s) adicionada(s)${onTop ? ` (${onTop} por cima de paletes/caixas)` : ''}.` },
      )
      return
    }
    let placed = 0
    const c0 = compositions.find((x) => x.key === addComp)
    // REF com kits mais alta que a carga (porta do 20'/40' Dry): entra o maior palete que cabe, com aviso
    const c = c0 ? compForLoad(c0, palletHeightLimit(doc)) : null
    apply((d0) => {
      let d = d0
      if (!c) return d0
      if (!d.pallets[c.key]) d = { ...d, pallets: { ...d.pallets, [c.key]: c.doc } }
      const e = palletEnvelope(c.doc).size
      const size: Vec3 = addYaw ? { x: e.y, y: e.x, z: e.z } : e
      const make = (pos: Vec3): LoadUnit => ({ id: newId('u'), kind: 'PALLET', palletKey: c.key, pos, yaw: addYaw, locked: false })
      const units = [...d.units]
      for (let n = 0; n < addQty; n++) {
        const p = findFreePosition(obstaclesOf({ ...d, units }), size, { lo, hi, allowStacking: allowStack, minSupportPct: summary.limits.thresholds.minSupportPct })
        if (!p) break
        units.push(make(p))
        placed++
      }
      return placed ? { ...d, units } : d0
    })
    const adapted = c?.fit ? `${c.fit.sku}: ${c.fit.note}.` : ''
    setMsg(
      placed < addQty
        ? { type: 'warn', text: `Adicionados ${placed} de ${addQty}: sem posição livre dentro do espaço/limites.${adapted ? ` ${adapted}` : ''}` }
        : adapted
          ? { type: 'warn', text: `${placed} palete(s) adicionado(s). ${adapted}` }
          : null,
    )
  }

  const selUnits = doc.units.filter((u) => selection.includes(u.id))
  const sel = selUnits.length === 1 ? selUnits[0] : null
  const updateSel = (fn: (u: LoadUnit) => LoadUnit) => apply((d) => ({ ...d, units: d.units.map((u) => (selection.includes(u.id) && !u.locked ? fn(u) : u)) }))

  /**
   * Girar (R) / tombar (T) volumes soltos com a lógica comum (domain/orientation): orientação física
   * nova, centro mantido, apoio e checagem de colisão/limites. Paletes só giram em z.
   */
  function reorientSel(kind: 'flip' | 'yaw' | Orientation) {
    let blocked = 0, noRoom = 0, done = 0
    apply((d) => {
      const units = [...d.units]
      for (const id of selection) {
        const idx = units.findIndex((x) => x.id === id)
        const u = units[idx]
        if (!u || u.locked) continue
        if (u.kind === 'PALLET') {
          if (kind === 'yaw') {
            units[idx] = { ...u, yaw: !u.yaw }
            done++
          }
          continue
        }
        const k = d.packs[u.packId]
        if (!k) continue
        const o = kind === 'flip' ? nextFlip(u.orientation, k.dims, k.allowedOrientations) : kind === 'yaw' ? nextYaw(u.orientation, k.dims, k.allowedOrientations) : kind
        if (!o || o === u.orientation) {
          blocked++
          continue
        }
        const old = boxOf(d, u)
        if (!old) continue
        const pos = reorientPosition(old, orientDims(k.dims, o), obstaclesOf({ ...d, units }, new Set([id])), { lo, hi }, summary.limits.thresholds.minSupportPct)
        if (!pos) {
          noRoom++
          continue
        }
        units[idx] = { ...u, orientation: o, pos }
        done++
      }
      return done ? { ...d, units } : d
    })
    if (blocked) setMsg({ type: 'warn', text: 'Sem outra orientação possível: o cadastro do produto restringe (ex.: "manter em pé") ou as faces são iguais.' })
    else if (noRoom) setMsg({ type: 'warn', text: `${noRoom} volume(s) sem espaço livre na nova orientação.` })
  }
  const rotateSel = () => reorientSel('yaw')
  /** Tomba volumes soltos selecionados (paletes não tombam). */
  const flipSel = () => reorientSel('flip')
  function duplicateSel() {
    if (!selUnits.length) return
    const ids: string[] = []
    apply((d) => {
      const units = [...d.units]
      for (const u of selUnits) {
        const b = boxOf(d, u)
        if (!b) continue
        const p = findFreePosition(obstaclesOf({ ...d, units }), b.size, { lo, hi, allowStacking: allowStack, minSupportPct: summary.limits.thresholds.minSupportPct })
        if (!p) continue
        const id = newId('u')
        ids.push(id)
        units.push({ ...u, id, pos: p, locked: false, label: undefined })
      }
      return { ...d, units }
    })
    if (ids.length) select(ids)
    else setMsg({ type: 'warn', text: 'Sem espaço livre para duplicar.' })
  }
  function settleSel() {
    updateSel((u) => {
      const b = boxOf(doc, u)
      if (!b) return u
      // caixas assentam nas superfícies reais (caixas do topo dos paletes); paletes, no envelope
      const others = { ...doc, units: doc.units.filter((x) => x.id !== u.id) }
      const obs = u.kind === 'PACKAGE' ? boxObstacles(others) : obstaclesOf(doc, new Set([u.id]))
      return { ...u, pos: { ...u.pos, z: dropZ(obs, b, 0) } }
    })
  }
  // ---- arrasto no 3D: superfícies de apoio e validação ao soltar (volta à última posição válida)
  const dragFrom = useRef<LoadDoc | null>(null)
  /** Obstáculos para mover `u`: caixas soltas usam as superfícies reais (caixas no topo dos paletes); paletes, os envelopes. */
  const moveObstacles = (d: LoadDoc, u: LoadUnit) => (u.kind === 'PACKAGE' ? boxObstacles({ ...d, units: d.units.filter((x) => x.id !== u.id) }) : obstaclesOf(d, new Set([u.id])))
  function movedProblem(d: LoadDoc, id: string): string | null {
    const minSupportPct = summary.limits.thresholds.minSupportPct
    if (id.startsWith('item:')) {
      const unit = d.units.find((x) => x.id === inner)
      const p = unit?.kind === 'PALLET' ? d.pallets[unit.palletKey] : undefined
      const it = p?.items.find((i) => i.id === id.slice(5))
      if (!p || !it) return null
      const { lo: l, hi: h } = palletLocalBounds(p, palletHeightLimit(d))
      return placementProblem(localObstacles(p, it.id), itemBox(p, it), { lo: l, hi: h, minSupportPct })
    }
    const u = d.units.find((x) => x.id === id)
    const b = u && boxOf(d, u)
    if (!u || !b) return null
    // zona de trabalho: totalmente fora do equipamento fica onde foi solto (só não pode colidir nem flutuar)
    if (isOutsideSpace(d, b)) {
      const far = 1e7
      const why = placementProblem(moveObstacles(d, u), b, { lo: { x: -far, y: -far, z: 0 }, hi: { x: far, y: far, z: hi.z }, minSupportPct })
      return why ? `fora da carga: ${why}` : null
    }
    return placementProblem(moveObstacles(d, u), b, { lo, hi, minSupportPct })
  }
  function endDragCheck(id: string) {
    const before = dragFrom.current
    dragFrom.current = null
    if (!before) return
    const now = store.getState().doc
    if (now === before) return
    const why = movedProblem(now, id) ?? newPhysicalCriticals(validateLoad(before).issues, validateLoad(now).issues)[0]?.message ?? null
    if (!why) return
    revertTo(before)
    setMsg({ type: 'warn', text: `Posição inválida: ${why}. O volume voltou à última posição válida.` })
  }
  /** Zona de trabalho: devolve a unidade ao primeiro lugar livre dentro do equipamento. */
  function relocateStaged(id: string) {
    let ok = false
    apply((d) => {
      const u = d.units.find((x) => x.id === id)
      const b = u && boxOf(d, u)
      if (!u || !b) return d
      const inside = d.units.filter((x) => x.id !== id && !staged.has(x.id))
      const p = findFreePosition(obstaclesOf({ ...d, units: inside }), b.size, { lo, hi, allowStacking: allowStack, minSupportPct: summary.limits.thresholds.minSupportPct })
      if (!p) return d
      ok = true
      return { ...d, units: d.units.map((x) => (x.id === id ? { ...x, pos: p } : x)) }
    })
    setMsg(ok ? { type: 'ok', text: 'Unidade recolocada dentro do equipamento.' } : { type: 'warn', text: 'Sem lugar livre dentro do equipamento para esta unidade (espaço, altura ou apoio). Libere espaço ou retire-a.' })
  }
  function removeStaged(id: string, label: string) {
    if (!confirm(`Retirar ${label} da carga?\n\nA unidade deixa de fazer parte desta composição (dá para desfazer com Ctrl+Z antes de salvar).`)) return
    apply((d) => ({ ...d, units: d.units.filter((u) => u.id !== id) }))
    select([])
  }
  function removeSel() {
    apply((d) => ({ ...d, units: d.units.filter((u) => !selection.includes(u.id) || u.locked) }))
    select([])
  }
  // ---- edição das caixas dentro de um palete (lógica em domain/palletEdit e domain/orientation)
  function enterPallet(unitId: string) {
    const u = doc.units.find((x) => x.id === unitId)
    if (!u || u.kind !== 'PALLET') return
    select([])
    setInner(unitId)
    setInnerSel(null)
    setMsg({ type: 'ok', text: 'Editando as caixas do palete: clique numa caixa. Esc ou "Sair do palete" volta ao palete inteiro.' })
  }
  /** Coloca caixas no palete aberto: melhor posição livre, 100% apoiada, dentro do palete e da altura útil do equipamento. */
  function innerAdd() {
    const k = catalog.find((x) => packKey(x) === addPack)
    if (!k || !inner) return
    let added = 0
    apply((d) =>
      editPalletItems(d, inner, (p) => {
        const r = addBoxesToMixed(p, packKey(k), k, addQty, palletHeightLimit(d))
        added = r.added
        return r.added ? r.doc : null
      }),
    )
    setMsg(
      added < addQty
        ? { type: 'warn', text: `Adicionadas ${added} de ${addQty} caixa(s) ${k.sku}: sem mais espaço apoiado no palete, altura útil (${nf0.format(palletHeightLimit(doc))} mm) ou capacidade do palete.` }
        : { type: 'ok', text: `${added} caixa(s) ${k.sku} adicionada(s) ao palete. Mova com as setas coloridas ou arrastando.` },
    )
  }
  function exitPallet() {
    setInner(null)
    setInnerSel(null)
    setMsg(null)
  }
  /** Altera a caixa selecionada (o palete ganha cópia própria se for compartilhado). */
  function innerEdit(fn: (p: PalletDoc, it: PalletItem) => PalletDoc | null, transient = false) {
    if (!inner || !innerSel) return
    const op = (d: LoadDoc) =>
      editPalletItems(d, inner, (p) => {
        const it = p.items.find((i) => i.id === innerSel)
        return it && !it.locked ? fn(p, it) : null
      })
    if (transient) applyTransient(op)
    else apply(op)
  }
  const innerMove = (dx: number, dy: number, dz: number) => {
    if (!innerUnit) return
    const l = spaceDeltaToLocal(innerUnit, { x: dx, y: dy, z: dz })
    innerEdit((p, it) => ({ ...p, items: p.items.map((i) => (i.id === it.id ? { ...i, pos: { x: i.pos.x + l.x, y: i.pos.y + l.y, z: Math.max(0, i.pos.z + l.z) } } : i)) }))
  }
  function innerReorient(kind: 'flip' | 'yaw' | Orientation) {
    let note = ''
    innerEdit((p, it) => {
      const k = p.packs[it.packId]
      const o = kind === 'flip' ? nextFlip(it.orientation, k.dims, k.allowedOrientations) : kind === 'yaw' ? nextYaw(it.orientation, k.dims, k.allowedOrientations) : kind
      if (!o || o === it.orientation) {
        note = 'Sem outra orientação possível (restrição do produto ou faces iguais).'
        return null
      }
      const pos = reorientPosition(itemBox(p, it), orientDims(k.dims, o), localObstacles(p, it.id), palletLocalBounds(p, palletHeightLimit(doc)), summary.limits.thresholds.minSupportPct)
      if (!pos) {
        note = 'Sem espaço no palete para a caixa nessa orientação.'
        return null
      }
      return { ...p, items: p.items.map((i) => (i.id === it.id ? { ...i, orientation: o, pos } : i)) }
    })
    if (note) setMsg({ type: 'warn', text: note })
  }
  function innerRemove() {
    innerEdit((p, it) => ({ ...p, name: p.name.endsWith('(parcial)') ? p.name : `${p.name} (parcial)`, items: p.items.filter((i) => i.id !== it.id) }))
    setInnerSel(null)
  }

  const handlers = inner
    ? {
        step: snapMm,
        enabled: editable,
        move: innerMove,
        rotate: () => innerReorient('yaw'),
        flip: () => innerReorient('flip'),
        remove: innerRemove,
        duplicate: () => {},
        escape: exitPallet,
        undo,
        redo,
      }
    : {
        step: snapMm,
        enabled: editable,
        move: (dx: number, dy: number, dz: number) => updateSel((u) => ({ ...u, pos: { x: u.pos.x + dx, y: u.pos.y + dy, z: Math.max(0, u.pos.z + dz) } })),
        rotate: rotateSel,
        flip: flipSel,
        remove: removeSel,
        duplicate: duplicateSel,
        undo,
        redo,
      }
  useEditorKeys(handlers)

  async function doSave(): Promise<boolean> {
    setSaving(true)
    try {
      const r = await save(doc, changelog, expectedUpdatedAt)
      if (r.updatedAt) setExpectedUpdatedAt(r.updatedAt)
      if (r.ok) {
        markSaved(doc)
        setChangelog('')
        router.refresh() // atualiza a tabela de versões; o editor mantém estado (key estável)
        setMsg({
          type: r.critical ? 'warn' : 'ok',
          text: staged.size
            ? `Rascunho salvo com ${staged.size} unidade(s) FORA DA CARGA (pendentes de ubicação): a composição não está finalizada — reposicione ou retire antes de enviar para revisão/aprovar.`
            : r.critical
              ? `Versão salva com ${r.critical} alerta(s) crítico(s) — não poderá ser aprovada assim.`
              : 'Versão salva.',
        })
        return true
      } else setMsg({ type: 'error', text: r.error ?? 'Erro ao salvar.' })
      return false
    } catch {
      setMsg({ type: 'error', text: 'Falha de comunicação com o servidor.' })
      return false
    } finally {
      setSaving(false)
    }
  }
  const guard = useUnsavedGuard(dirty, rootRef, () => doSave())

  // vídeo 360°: gravador do 3D (Scene3D) e modal de gravação/prévia
  const recorderRef = useRef<OrbitRecorder | null>(null)
  const onRecorderReady = useCallback((fn: OrbitRecorder) => {
    recorderRef.current = fn
  }, [])
  const [video360, setVideo360] = useState(false)

  const onCaptureReady = useCallback((fn: CaptureFn) => {
    captureRef.current = fn
  }, [])

  /** Captura 2 vistas do 3D e pede ao servidor o PDF da versão salva. */
  /** PDF gerado aguardando a prévia (baixar, imprimir, e-mail, WhatsApp) */
  const [pdfPreview, setPdfPreview] = useState<{ blob: Blob; name: string; expedition?: boolean } | null>(null)

  /**
   * PDF de EXPEDIÇÃO (para quem monta a carga; sem preços): planta e vista lateral em vetor, 9 vistas
   * 3D e a sequência de carregamento passo a passo, e a lista de carregamento. Gerado no navegador.
   */
  /** antes de capturar o 3D: sai de "dentro do palete", limpa a seleção e espera a cena redesenhar */
  async function prepareCapture() {
    if (inner) exitPallet()
    if (selection.length) select([])
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  }

  async function generateExpeditionPdf() {
    if (!expedition) return
    setPdfBusy(true)
    try {
      await prepareCapture()
      const r = await exportExpeditionPdf({
        doc: shown,
        view: shownView,
        capture: captureRef.current,
        info: { planName: videoInfo?.name ?? shown.space.code, version: expedition.version, status: expedition.status, customer: videoInfo?.customer, orderRef: videoInfo?.orderRef, destination: videoInfo?.destination, mode: expedition.mode, transportCompany: expedition.transportCompany, generatedBy: userName },
      })
      setPdfPreview({ blob: r.blob, name: r.name, expedition: true })
      if (!r.withViews) setMsg({ type: 'warn', text: 'PDF de expedição gerado sem as vistas 3D (o 3D não estava visível). A planta, a vista lateral e a lista estão no PDF.' })
    } catch {
      setMsg({ type: 'error', text: 'Não foi possível gerar o PDF de expedição.' })
    } finally {
      setPdfBusy(false)
    }
  }

  async function generatePdf() {
    if (!pdfUrl) return
    setPdfBusy(true)
    try {
      await prepareCapture()
      let images: string[] = []
      try {
        images = captureRef.current?.(['iso-front', 'iso-rear']) ?? []
      } catch {
        images = [] // sem WebGL disponível: o PDF sai sem imagens
      }
      const photos = photoCount > 0 && withPhotos
      const res = await fetch(`${pdfUrl}${pdfUrl.includes('?') ? '&' : '?'}lang=${effPdfLang}${photos ? '&fotos=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images }) })
      if (!res.ok) {
        setMsg({ type: 'error', text: await pdfErrorText(res, photos) })
        return
      }
      const blob = await res.blob()
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'pedido.pdf'
      setPdfPreview({ blob, name })
      // o PDF registrou uma cotação emitida: atualiza o painel "Cotações emitidas" da página
      router.refresh()
      if (!images.length) setMsg({ type: 'warn', text: 'PDF gerado sem as vistas 3D (o 3D não estava disponível).' })
    } catch {
      setMsg({ type: 'error', text: 'Não foi possível gerar o PDF.' })
    } finally {
      setPdfBusy(false)
    }
  }

  /**
   * Distribui o peso por quadrantes (motor determinístico; só muda posições, nunca produtos/quantidades).
   * Resultado em % do peso total. Desfazível pelo botão "Desfazer distribuição".
   */
  function distributeWeight() {
    const r: BalanceResult = balanceWeight(doc, { spread: spreadOpt })
    const q = r.after.quadrants.shares
    const line = `NE ${nf1.format(q.pct.NE)}% · NO ${nf1.format(q.pct.NO)}% · SE ${nf1.format(q.pct.SE)}% · SO ${nf1.format(q.pct.SO)}% — NORTE/FRENTE ${nf1.format(q.northPct)}% · SUL/TRASEIRA ${nf1.format(q.southPct)}%.`
    if (r.doc === doc) {
      setMsg(
        r.meetsRules
          ? { type: 'ok', text: `A distribuição atual já cumpre as regras: ${line}` }
          : { type: 'warn', text: `${r.reason ?? 'Não foi possível alcançar a distribuição de peso requerida com a composição atual.'} Distribuição atual: ${line}` },
      )
      return
    }
    setDistUndo(doc)
    apply(() => r.doc)
    setShowQuadrants(true)
    setMsg(
      r.meetsRules
        ? { type: 'ok', text: `Peso distribuído: ${line}` }
        : {
            type: 'warn',
            text: `${r.reason ?? 'Não foi possível alcançar a distribuição de peso requerida com a composição atual.'} Melhor alternativa aplicada: ${line}${!spreadOpt ? ' Dica: marque "Usar o espaço até a traseira" (desloca o bloco travado; calço na frente).' : ''}`,
          },
    )
  }
  /**
   * Coloca os paletes mistos otimizados no equipamento (mais pesados e maiores primeiro; piso e
   * empilhamento pelo motor) e depois aplica a distribuição de peso por quadrantes.
   */
  function applyMixedPallets(pallets: PalletDoc[]): { ok: boolean; text: string } {
    const stamp = newId('mx')
    // envio sem equipamento: os paletes do planejador SUBSTITUEM o conteúdo. A altura máxima do envio
    // (definida na criação / no painel) não muda aqui: palete mais alto que ela gera alerta crítico.
    let base: LoadDoc = isNone ? { ...doc, units: [], pallets: {}, packs: {} } : doc
    if (isNone && doc.units.length && !window.confirm('Substituir o conteúdo atual do envio pelos paletes do planejador?')) return { ok: false, text: 'Nada foi alterado.' }
    // com equipamento: paletes mistos colocados antes → substituir (em vez de duplicar)?
    const prevMixed = isNone ? [] : doc.units.filter((u) => u.kind === 'PALLET' && /^mx/.test(u.palletKey) && !u.locked)
    if (prevMixed.length && window.confirm(`Já há ${prevMixed.length} palete(s) misto(s) do planejador nesta carga. Substituí-los pelos novos? (Cancelar = adicionar junto)`)) {
      const drop = new Set(prevMixed.map((u) => u.id))
      base = { ...doc, units: doc.units.filter((u) => !drop.has(u.id)) }
    }
    const r = placeMixedPalletsInLoad(base, pallets, stamp)
    // não coube tudo: propõe o pedido em várias unidades (1ª cheia, remanente na última) em vez de deixar paletes de fora
    if (r.failed.length && saveMulti && !isNone) {
      const cur = groupsOfDoc(doc)
      const extra = pallets.map((p, i) => ({ key: `${stamp}_${i + 1}`, pallet: { ...p, name: `Misto ${i + 1} · ${[...new Set(Object.values(p.packs).map((k) => k.sku))].join('+')}` }, count: 1 }))
      const plan = splitIntoUnits(doc, [...cur.pallets, ...extra], cur.loose, { alternatives: spaces })
      if (plan.units.length > 1) {
        openMulti(plan.units.map((u) => u.doc), planNotes(plan))
        return { ok: true, text: `Não cabe tudo num ${doc.space.code}: proposta com ${plan.units.length} unidades (a 1ª cheia, o remanente na última). Revise e aplique.` }
      }
    }
    if (!r.placed) return { ok: false, text: 'Nenhum palete coube no equipamento (espaço, porta, altura ou payload).' }
    apply(() => r.doc)
    return {
      ok: !r.failed.length,
      text:
        `${r.placed} palete(s) misto(s) colocado(s) na carga` +
        (r.failed.length ? ` · não couberam: ${r.failed.map((n) => `Palete ${n}`).join(', ')}` : '') +
        (r.balanced ? '. Peso distribuído por quadrantes.' : '.') +
        ' Revise e salve a versão.',
    }
  }
  function openMulti(docs: LoadDoc[], notes: string[]) {
    setMulti({ docs, notes, view: 0 })
    setPreview(docs[0])
    select([])
    exitPallet()
  }
  function closeMulti() {
    setMulti(null)
    setPreview(null)
  }
  /** Grava todas as unidades juntas (servidor, transação única); se falhar, nada muda aqui nem no banco. */
  async function applyMulti() {
    if (!multi || !saveMulti) return
    setMultiBusy(true)
    try {
      const r = await saveMulti(multi.docs, changelog, expectedUpdatedAt)
      if (!r.ok) {
        setMsg({ type: 'error', text: r.error ?? 'Não foi possível gravar as unidades. Nada foi alterado.' })
        return
      }
      const first = multi.docs[0]
      apply(() => first)
      markSaved(first)
      if (r.updatedAt) setExpectedUpdatedAt(r.updatedAt)
      setChangelog('')
      closeMulti()
      router.refresh()
      setMsg({ type: 'ok', text: `Pedido dividido e salvo em ${multi.docs.length} unidades. Use as abas acima do editor para abrir cada uma.` })
    } catch {
      setMsg({ type: 'error', text: 'Falha de comunicação com o servidor. Nada foi alterado.' })
    } finally {
      setMultiBusy(false)
    }
  }
  /**
   * Regra de produto: completa os acompanhantes faltantes (ex.: 1 kit por Hydroforce) POR CIMA do palete do
   * produto principal; kits Hydroforce reembalados em caixas de 26 / meia caixa / individuais (domain/kitBoxes).
   */
  function addCompanions() {
    const r = addMissingCompanions(doc, (sku) => {
      const k = catalog.find((c) => c.sku.toUpperCase() === sku.toUpperCase())
      return k ? { packId: packKey(k), pack: k } : null
    })
    if (r.doc !== doc) apply(() => r.doc)
    const short = r.added.filter((a) => a.missing > 0)
    setMsg(
      short.length
        ? { type: 'warn', text: `Acompanhantes: ${r.added.map((a) => `${a.placed} ${a.sku}`).join(', ')} colocados; faltam ${short.map((a) => `${a.missing} ${a.sku} (${a.reason})`).join(', ')}.` }
        : { type: 'ok', text: `Acompanhantes colocados por cima dos paletes do produto: ${r.added.map((a) => `${a.placed} ${a.sku}`).join(', ')}.` },
    )
  }

  function undoDistribution() {
    if (!distUndo) return
    const prev = distUndo
    apply(() => prev)
    setDistUndo(null)
    setMsg({ type: 'ok', text: 'Distribuição desfeita: posições anteriores restauradas.' })
  }

  const L = summary.limits
  const maxBin = Math.max(1, ...summary.longitudinal.map((b) => b.kg))
  const floorLimit = shown.space.floorLoadKgPerM
  const selGeom = sel ? geoms.find((g) => g.unit.id === sel.id) : null
  const packsFiltered = catalog.filter((c) => !filter || `${c.sku} ${c.name}`.toLowerCase().includes(filter.toLowerCase()))
  const compsFiltered = compositions.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()))
  const addPackSnap = catalog.find((x) => packKey(x) === addPack)

  return (
    <div ref={rootRef}>
      {guard.modal}
      {showMixed && mixed && (
        <div className="overlay-full">
          <MixedPlanner
            generatedBy={userName}
            catalog={catalog}
            palletTypes={mixed.palletTypes}
            stdPallet={mixed.stdPallet}
            defaultMode={mixed.defaultMode}
            destination={mixed.destination}
            space={shown.space}
            profileHeightMm={summary.limits.heightMm.value}
            lockMode={mixed.lockMode}
            initialLines={isNone ? docOrderLines(doc).filter((l) => !l.pack.sku.startsWith('KIT-')).map((l) => ({ sku: l.pack.sku, units: l.boxes * l.pack.unitsPerPackage })) : undefined}
            onClose={() => setShowMixed(false)}
            onApply={(pallets) => {
              const m = applyMixedPallets(pallets)
              setShowMixed(false)
              setMsg({ type: m.ok ? 'ok' : 'warn', text: m.text })
              return m.text
            }}
            onApplyCourier={
              isNone && shown.space.service === 'COURIER'
                ? (order, divisor) => {
                    if (doc.units.length && !window.confirm('Substituir os volumes atuais do envio?')) return 'Nada foi alterado.'
                    // courier: cada caixa vira um volume no piso (pilhas até a altura do desenho)
                    // altura do desenho: 1,5 m ou a maior medida das caixas (nenhuma caixa fica de fora)
                    const tall = Math.max(COURIER_STACK_H, ...order.map((o) => Math.max(o.pack.dims.l, o.pack.dims.w, o.pack.dims.h)))
                    let d: LoadDoc = { ...doc, units: [], pallets: {}, packs: {}, space: { ...doc.space, courierDivisor: divisor, inner: { ...doc.space.inner, h: tall }, door: { ...doc.space.door, h: tall } } }
                    let placed = 0
                    let wanted = 0
                    for (const o of order) {
                      wanted += o.boxes
                      const r = placeLooseBoxes(d, o.packId, o.pack, o.boxes, {})
                      d = r.doc
                      placed += r.placed
                    }
                    apply(() => d)
                    setShowMixed(false)
                    const text = placed < wanted ? `${placed} de ${wanted} volumes colocados (limite do desenho). Revise e salve.` : `${placed} volume(s) gravados no envio. Salve a versão.`
                    setMsg({ type: placed < wanted ? 'warn' : 'ok', text })
                    return text
                  }
                : undefined
            }
          />
        </div>
      )}
      <UnsavedBanner dirty={dirty} />
      {lockedBy && (
        <div className="alert warn">
          🔒 <strong>{lockedBy}</strong> está editando esta carga agora. Você vê em modo leitura; a edição libera quando ele sair (ou após 3 minutos sem atividade).
        </div>
      )}
      <div className="page-head">
        <h1>{title}</h1>
        {dirty && <span className="badge WARNING">● Alterações não salvas</span>}
        {pdfUrl && (
          <select value={effPdfLang} onChange={(e) => setPdfLang(e.target.value as PdfLang)} title="Idioma do PDF (sugerido pelo país de destino)" style={{ fontSize: 12 }}>
            {PDF_LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                PDF: {l.label}
              </option>
            ))}
          </select>
        )}
        {pdfUrl && (
          <button
            onClick={() => void generatePdf()}
            disabled={pdfBusy || dirty || Boolean(preview)}
            title={dirty || preview ? 'Salve (ou descarte a proposta) antes: o PDF usa a versão salva' : 'Resumo do pedido em PDF com 2 vistas 3D — prévia, depois baixar, imprimir, enviar por e-mail ou WhatsApp'}
          >
            {pdfBusy ? 'Gerando PDF…' : '📄 PDF do pedido'}
          </button>
        )}
        {pdfUrl && photoCount > 0 && (
          <label className="check" title="Anexa as fotos do carregamento no fim do PDF do pedido" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} /> com fotos ({photoCount})
          </label>
        )}
        {expedition && (
          <button
            onClick={() => void generateExpeditionPdf()}
            disabled={pdfBusy || dirty || Boolean(preview) || (!summary.pallets && !summary.looseUnits)}
            title={dirty || preview ? 'Salve (ou descarte a proposta) antes: o PDF usa a versão salva' : 'Instrução de carregamento para a expedição (SEM preços): planta, vista lateral, vistas 3D, sequência passo a passo e lista de carregamento'}
          >
            📋 PDF Expedição
          </button>
        )}
        {pdfPreview && (
          <PdfPreview
            blob={pdfPreview.blob}
            fileName={pdfPreview.name}
            lang={pdfPreview.expedition ? 'pt' : effPdfLang}
            subject={pdfPreview.expedition ? `Expedição — ${videoInfo?.orderRef ?? videoInfo?.name ?? ''}` : pdfText(effPdfLang).mailSubject(videoInfo?.orderRef ?? videoInfo?.name ?? '')}
            docLabel={pdfPreview.expedition ? `a instrução de carregamento${videoInfo?.orderRef ? ` ${videoInfo.orderRef}` : ''}` : { pt: 'o resumo do pedido', es: 'el resumen del pedido', en: 'the order summary' }[effPdfLang] + (videoInfo?.orderRef ? ` ${videoInfo.orderRef}` : '')}
            onClose={() => setPdfPreview(null)}
          />
        )}
        <button
          onClick={() => setVideo360(true)}
          disabled={!summary.pallets && !summary.looseUnits}
          title="Gera um vídeo MP4 com a câmera girando 360° em volta da carga (logo e dados da carga), para enviar ao cliente"
        >
          🎥 Gravar 360°
        </button>
        {video360 && (
          <Video360
            recorder={() => recorderRef.current}
            geoms={geoms.filter((g) => !staged.has(g.unit.id))}
            labelOf={(g) => (g.unit.kind === 'PALLET' ? g.unit.label ?? `P${shown.units.indexOf(g.unit) + 1}` : null)}
            packsOf={(g) => {
              const u = g.unit
              if (u.kind !== 'PALLET') return shown.packs[u.packId] ? [shown.packs[u.packId]] : []
              const p = shown.pallets[u.palletKey]
              return p ? p.items.map((it) => p.packs[it.packId]).filter(Boolean) : []
            }}
            info={videoInfo ?? { name: typeof title === 'string' ? title : shown.space.code }}
            equipment={shown.space.code}
            totals={{ pallets: summary.pallets, looseBoxes: summary.looseUnits, grossKg: summary.payloadKg }}
            lang={effPdfLang}
            onClose={() => setVideo360(false)}
          />
        )}
        {editable && (
          <>
            <input className="changelog-input" placeholder="O que mudou? (changelog)" value={changelog} onChange={(e) => setChangelog(e.target.value)} style={{ width: 240 }} />
            <button className="primary" onClick={doSave} disabled={saving || !dirty}>
              {saving ? 'Salvando…' : 'Salvar versão'}
            </button>
          </>
        )}
      </div>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      {canEdit && assistantVersionId != null && (
        <AssistantPanel
          versionId={assistantVersionId}
          autoRun={assistantAutoRun}
          baseDoc={multi ? doc : shown}
          preview={multi ? null : preview}
          onPreview={(d) => {
            setMulti(null)
            setPreview(d)
            select([])
          }}
          onMulti={openMulti}
          onApply={(d) => apply(() => d)}
          catalog={catalog}
          area={area}
        />
      )}
      {multi && (
        <MultiUnitPanel
          docs={multi.docs}
          notes={multi.notes}
          view={multi.view}
          busy={multiBusy}
          canSave={canEdit && Boolean(saveMulti)}
          onView={(i) => {
            setMulti({ ...multi, view: i })
            setPreview(multi.docs[i])
          }}
          onApply={applyMulti}
          onCancel={closeMulti}
        />
      )}
      {preview && <div className="alert warn">{multi ? `Mostrando no 3D a unidade ${multi.view + 1} de ${multi.docs.length} da PROPOSTA.` : 'Mostrando uma PROPOSTA no 3D.'} Aplique ou cancele para voltar a editar manualmente.</div>}
      <div className="editor">
        <div className="side">
          {staged.size > 0 && (
            <div className="panel" style={{ borderColor: '#f28c00', background: '#fff7ec' }}>
              <h3 style={{ marginTop: 0, color: '#b35f00' }}>Fora da carga ({staged.size})</h3>
              <small className="muted" style={{ display: 'block', marginBottom: 6 }}>
                Pendentes de ubicação na zona de trabalho: não contam no peso nem na ocupação. Para enviar para revisão ou aprovar, reposicione dentro do equipamento ou retire.
              </small>
              {shown.units
                .filter((u) => staged.has(u.id))
                .map((u) => {
                  const label = `${shortUnitLabel(u, shown.units.indexOf(u))} · ${u.kind === 'PALLET' ? shown.pallets[u.palletKey]?.name ?? '' : shown.packs[u.packId]?.sku ?? 'volume'}`
                  return (
                    <div key={u.id} className="row" style={{ gap: 4, marginBottom: 4, fontSize: 12 }}>
                      <button className={`small ${selection.includes(u.id) ? 'active' : ''}`} onClick={() => select([u.id])} title="Selecionar no 3D" style={{ flex: 1, justifyContent: 'flex-start' }}>
                        {label}
                      </button>
                      {editable && (
                        <>
                          <button className="small" onClick={() => relocateStaged(u.id)} title="Primeiro lugar livre dentro do equipamento">
                            Recolocar
                          </button>
                          <button className="small danger" onClick={() => removeStaged(u.id, label)}>
                            Retirar
                          </button>
                        </>
                      )}
                    </div>
                  )
                })}
            </div>
          )}
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>{isNone ? `Envio sem equipamento — ${TYPE_INFO[shown.space.service ?? 'PALLETS_ONLY'].label}` : 'Equipamento e limites'}</h3>
            {isNone && noneM && (
              <>
                <table className="data compact">
                  <tbody>
                    {shown.space.service !== 'COURIER' && (
                      <tr>
                        <td>Altura máx. do palete carregado</td>
                        <td className="num">
                          <NumberInput
                            value={shown.space.inner.h}
                            step={10}
                            disabled={readOnly}
                            onCommit={(v) => {
                              if (v < 300 || v > 4000) {
                                setMsg({ type: 'warn', text: 'Altura entre 300 e 4.000 mm.' })
                                return false
                              }
                              apply((d) => ({ ...d, space: { ...d.space, inner: { ...d.space.inner, h: v }, door: { ...d.space.door, h: v }, maxLoadHeightMm: v } }))
                            }}
                          />
                        </td>
                      </tr>
                    )}
                    {shown.space.service === 'COURIER' && (
                      <tr>
                        <td>Divisor volumétrico</td>
                        <td className="num">
                          <NumberInput
                            value={shown.space.courierDivisor ?? 5000}
                            step={100}
                            disabled={readOnly}
                            onCommit={(v) => {
                              if (v < 1000 || v > 10000) {
                                setMsg({ type: 'warn', text: 'Divisor entre 1.000 e 10.000.' })
                                return false
                              }
                              apply((d) => ({ ...d, space: { ...d.space, courierDivisor: v } }))
                            }}
                          />
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td>{shown.space.service === 'COURIER' ? 'Volumes (caixas)' : 'Paletes · caixas'}</td>
                      <td className="num">{shown.space.service === 'COURIER' ? nf0.format(noneM.boxes) : `${nf0.format(noneM.pallets)} · ${nf0.format(noneM.boxes)}`}</td>
                    </tr>
                    <tr>
                      <td>Peso bruto · líquido</td>
                      <td className="num">
                        {kg(noneM.grossKg)} · {kg(noneM.netKg)}
                      </td>
                    </tr>
                    <tr>
                      <td>Volume</td>
                      <td className="num">{noneM.cbm.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} m³</td>
                    </tr>
                    {noneM.courier && (
                      <tr>
                        <td>Peso volumétrico (÷ {nf0.format(noneM.courier.divisor)})</td>
                        <td className="num">{kg(noneM.courier.volKg)}</td>
                      </tr>
                    )}
                    {noneM.chargeableKg != null && (
                      <tr>
                        <td>
                          <strong>Peso taxável (estimativa)</strong>
                        </td>
                        <td className="num">
                          <strong>{kg(noneM.chargeableKg)}</strong>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <small className="muted">O tipo de envio não muda depois de criado. Para contêiner/caminhão, crie uma carga nova em Nova carga.</small>
              </>
            )}
            {!isNone && <label className="field">
              Equipamento
              <select
                value={`${shown.space.kind}:${shown.space.typeId}`}
                disabled={readOnly}
                onChange={(e) => {
                  const s = spaces.find((x) => `${x.kind}:${x.typeId}` === e.target.value)
                  if (s) apply((d) => ({ ...d, space: s, road: roadOpts ? adaptRoad(d.road, s, roadOpts) : d.road }))
                }}
              >
                {spaces.map((s) => (
                  <option key={`${s.kind}:${s.typeId}`} value={`${s.kind}:${s.typeId}`}>
                    {s.kind === 'CONTAINER' ? '🚢' : '🚚'} {s.code} — {s.name}
                  </option>
                ))}
              </select>
            </label>}
            {shown.space.kind === 'VEHICLE' && (
              <label className="field" title="Comprimento útil real do caminhão desta carga (varia de um caminhão para outro). Não altera o cadastro do veículo.">
                Comprimento útil do caminhão (mm)
                <NumberInput
                  value={shown.space.inner.l}
                  step={10}
                  disabled={readOnly}
                  onCommit={(v) => {
                    if (v < VEHICLE_LENGTH_LIMITS.min || v > VEHICLE_LENGTH_LIMITS.max) {
                      setMsg({ type: 'warn', text: `Comprimento entre ${nf0.format(VEHICLE_LENGTH_LIMITS.min)} e ${nf0.format(VEHICLE_LENGTH_LIMITS.max)} mm.` })
                      return false
                    }
                    apply((d) => withVehicleLength(d, v))
                  }}
                />
                {shown.space.baseInnerL != null ? (
                  <small className="muted">
                    informado nesta carga · cadastro {nf0.format(shown.space.baseInnerL)} mm{' '}
                    {!readOnly && (
                      <button className="link" type="button" onClick={() => apply((d) => withVehicleLength(d, d.space.baseInnerL ?? d.space.inner.l))}>
                        restaurar
                      </button>
                    )}
                  </small>
                ) : (
                  <small className="muted">o do cadastro; digite o real do caminhão se for diferente</small>
                )}
              </label>
            )}
            <small className="muted">
              Interno {S.l}×{S.w}×{S.h} · porta {shown.space.door.w}×{shown.space.door.h} · tara {kg(shown.space.tareKg)}
              {shown.space.verification !== 'VERIFIED' && ' · ⚠ referência não verificada'}
            </small>
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 12 }}>Perfis de restrição aplicados</div>
              {profiles.map((p) => (
                <label key={p.profileId} className="check">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={shown.limits.some((l) => l.profileId === p.profileId)}
                    onChange={(e) =>
                      apply((d) => ({ ...d, limits: e.target.checked ? [...d.limits.filter((l) => l.profileId !== p.profileId), p] : d.limits.filter((l) => l.profileId !== p.profileId) }))
                    }
                  />
                  {p.name} <small className="muted">({p.scope})</small>
                </label>
              ))}
            </div>
            {companions.some((c) => c.missing > 0 || c.misplaced > 0) && (
              <div className="alert warn" style={{ marginTop: 8, fontSize: 12 }}>
                <strong>Acompanhantes obrigatórios</strong>
                {companions
                  .filter((c) => c.missing > 0 || c.misplaced > 0)
                  .map((c) => (
                    <div key={c.sku}>
                      {c.missing > 0 && (
                        <div>
                          • Faltam {nf0.format(c.missing)} {c.sku} nos paletes de {c.for.join(', ')} ({c.required} exigido(s); {c.present} no lugar)
                          {c.looseParents > 0 && ` — ${c.looseParents} caixa(s) do produto estão soltas: o ${c.sku} só pode ir sobre um palete com o produto`}
                        </div>
                      )}
                      {c.misplaced > 0 && <div>• {nf0.format(c.misplaced)} {c.sku} fora do lugar (solto ou em palete sem o produto): retire-os ou mova para o palete do produto</div>}
                    </div>
                  ))}
                {!readOnly && companions.some((c) => c.missing > 0) && (
                  <button className="small" style={{ marginTop: 4 }} onClick={addCompanions}>
                    Colocar por cima dos paletes do produto
                  </button>
                )}
              </div>
            )}
            {!isNone && logistics && logistics.applied.length > 0 && <LogisticsBox res={logistics} doc={shown} readOnly={readOnly} onApply={() => apply((d) => ({ ...d, limits: withRuleLimit(d.limits, logistics) }))} />}
            {!isNone && <table className="data compact" style={{ marginTop: 8 }}>
              <tbody>
                <tr>
                  <td>Payload efetivo</td>
                  <td className="num">{kg(L.payloadKg.value)}</td>
                </tr>
                <tr>
                  <td colSpan={2}>
                    <small className="muted">{L.payloadKg.source}</small>
                  </td>
                </tr>
                <tr>
                  <td>Bruto máx. efetivo</td>
                  <td className="num">{kg(L.grossKg.value)}</td>
                </tr>
                <tr>
                  <td>Altura máx.</td>
                  <td className="num">{mm(L.heightMm.value)}</td>
                </tr>
              </tbody>
            </table>}
          </div>
          {shown.units.length > 0 && !isNone && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Distribuição de peso</h3>
              <WeightBalance e={quad} kgs={quadKg} />
              <label className="check" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={showQuadrants} onChange={(e) => setShowQuadrants(e.target.checked)} /> Mostrar quadrantes no 3D
              </label>
              {editable && shown.units.some((u) => u.kind === 'PALLET') && (
                <>
                  <button className="primary" onClick={distributeWeight} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} title="Reorganiza a posição dos paletes (mesmos produtos e quantidades): o mais uniforme possível, com 1–2 p.p. a mais na traseira">
                    ⚖ Distribuir peso
                  </button>
                  {distUndo && (
                    <button onClick={undoDistribution} style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}>
                      ↶ Desfazer distribuição
                    </button>
                  )}
                  <label className="check" style={{ marginTop: 6 }} title="Usa o espaço livre até a traseira (exige calços/airbags). Só com tudo no piso e nada travado.">
                    <input type="checkbox" checked={spreadOpt} onChange={(e) => setSpreadOpt(e.target.checked)} /> Usar o espaço até a traseira (bloco travado; vãos entre paletes só se necessário)
                  </label>
                  <small className="muted" style={{ display: 'block', marginTop: 6 }}>
                    Só muda a posição dos paletes no piso, não travados e sem nada em cima; produtos e quantidades não mudam. Caixas soltas entram no cálculo pelo peso real.
                  </small>
                </>
              )}
              {/* fora do "editable": continua aberto enquanto a alternativa escolhida está em prévia no 3D */}
              {canEdit && !multi && !inner && doc.units.some((u) => u.kind === 'PALLET') && (
                <SpreadPanel
                  doc={doc}
                  onPreview={(d) => {
                    setPreview(d)
                    select([])
                  }}
                  onApply={(d) => {
                    setPreview(null)
                    apply(() => d)
                    setMsg({ type: 'ok', text: `Carga redistribuída em ${d.units.filter((u) => u.kind === 'PALLET').length} paletes (mesmos produtos e quantidades). Salve a versão para gravar.` })
                  }}
                />
              )}
            </div>
          )}
          {!isNone && (roadOpts || shown.road) && (
            <AxlePanel doc={shown} opts={roadOpts ?? { tractors: [], carriers: [], profiles: [] }} result={axleRes} readOnly={readOnly} onChange={(r) => apply((d) => ({ ...d, road: r }))} />
          )}
          {editable && inner && innerPallet && (
            <div className="panel" style={{ borderColor: 'var(--brand)' }}>
              <h3 style={{ marginTop: 0 }}>Caixas neste palete</h3>
              {(() => {
                const ps = palletSummary(innerPallet)
                const lim = palletHeightLimit(shown)
                return (
                  <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                    {innerPallet.palletType.code} · {nf0.format(ps.packages)} caixa(s) · {kg(ps.grossKg)} · altura {nf0.format(ps.totalHeightMm)} / {nf0.format(lim)} mm
                  </div>
                )
              })()}
              <input placeholder="Filtrar produto…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
              <div className="list-select">
                {packsFiltered.map((c) => (
                  <button key={packKey(c)} className={addPack === packKey(c) ? 'sel' : ''} onClick={() => setAddPack(packKey(c))}>
                    <span className="swatch" style={{ background: c.color }} />
                    <span>
                      <strong>{c.sku}</strong> v{c.version}
                      <br />
                      <small>
                        {c.dims.l}×{c.dims.w}×{c.dims.h} · {kg(c.grossKg)}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <label className="field" style={{ width: 90 }}>
                  Quantidade
                  <input type="number" min={1} max={500} value={addQty} onChange={(e) => setAddQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
                </label>
                <button className="primary" style={{ alignSelf: 'flex-end' }} onClick={innerAdd}>
                  Adicionar ao palete
                </button>
              </div>
              <small className="muted">Na orientação natural (maior face apoiada), na posição livre mais baixa e 100% apoiada. Depois: clique numa caixa para mover (setas X/Y/Z), girar, tombar ou retirar.</small>
            </div>
          )}
          {editable && !inner && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Adicionar</h3>
              {mixed && (
                <button className="primary" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }} onClick={() => setShowMixed(true)} title="Informe o pedido; o motor monta paletes mistos e coloca na carga">
                  📦 Pedido → paletes mistos
                </button>
              )}
              <div className="row" style={{ marginBottom: 6 }}>
                <button className={`small ${tab === 'pallet' ? 'active' : ''}`} onClick={() => setTab('pallet')}>
                  Paletes montados
                </button>
                <button className={`small ${tab === 'package' ? 'active' : ''}`} onClick={() => setTab('package')}>
                  Volumes soltos
                </button>
                {palletTypes.length > 0 && (
                  <button className={`small ${tab === 'empty' ? 'active' : ''}`} onClick={() => setTab('empty')} title="Insere um palete vazio para montar à mão, caixa por caixa">
                    Palete vazio
                  </button>
                )}
              </div>
              <input placeholder="Filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
              <div className="list-select">
                {tab === 'empty'
                  ? palletTypes
                      .filter((t) => !filter || `${t.code} ${t.name}`.toLowerCase().includes(filter.toLowerCase()))
                      .map((t) => (
                        <button key={t.palletTypeId} className={emptyType === t.palletTypeId ? 'sel' : ''} onClick={() => setEmptyType(t.palletTypeId)}>
                          <span>
                            <strong>{t.code}</strong> {t.name !== t.code ? <small className="muted">{t.name}</small> : null}
                            <br />
                            <small>
                              {t.dims.l}×{t.dims.w}×{t.dims.h} mm · tara {kg(t.tareKg)}
                              {t.dynamicMaxKg ? ` · até ${kg(t.dynamicMaxKg)}` : ''}
                            </small>
                          </span>
                        </button>
                      ))
                  : tab === 'pallet'
                  ? compsFiltered.map((c) => {
                      const s = palletSummary(c.doc)
                      // mais alta que esta carga (ex.: REF de Hydroforce com kits num 20'/40' Dry): avisa; ao
                      // adicionar, entra o maior palete que cabe
                      const tooHigh = s.totalHeightMm > palletHeightLimit(doc) + 0.5
                      const withKits = Object.values(c.doc.packs).some((k) => (k.companions ?? []).some((x) => kitFamilyOf(x.sku)))
                      return (
                        <button key={c.key} className={addComp === c.key ? 'sel' : ''} onClick={() => setAddComp(c.key)}>
                          <span>
                            <strong>{c.name}</strong>
                            <br />
                            <small>
                              {c.doc.palletType.code} · {nf0.format(s.envelope.size.x)}×{nf0.format(s.envelope.size.y)}×{nf0.format(s.totalHeightMm)} · {kg(s.grossKg)}
                            </small>
                            {tooHigh && (
                              <>
                                <br />
                                <small style={{ color: 'var(--warn)' }} title={withKits ? 'Ao adicionar, o palete de Hydroforce com kits entra com o maior número de unidades que cabe na altura desta carga.' : undefined}>
                                  {withKits ? `só 40' HC / rodoviário — nesta carga (máx. ${nf0.format(palletHeightLimit(doc))} mm) entra o maior que cabe` : `mais alto que esta carga (máx. ${nf0.format(palletHeightLimit(doc))} mm)`}
                                </small>
                              </>
                            )}
                          </span>
                        </button>
                      )
                    })
                  : packsFiltered.map((c) => (
                      <button key={packKey(c)} className={addPack === packKey(c) ? 'sel' : ''} onClick={() => setAddPack(packKey(c))}>
                        <span className="swatch" style={{ background: c.color }} />
                        <span>
                          <strong>{c.sku}</strong> v{c.version}
                          <br />
                          <small>
                            {c.dims.l}×{c.dims.w}×{c.dims.h} · {kg(c.grossKg)}
                          </small>
                        </span>
                      </button>
                    ))}
                {tab === 'pallet' && compsFiltered.length === 0 && <small>Nenhum palete padrão para este filtro (são gerados automaticamente pelo catálogo logístico).</small>}
              </div>
              <div className="grid" style={{ gap: 8, marginTop: 8 }}>
                {tab !== 'package' ? (
                  <label className="check">
                    <input type="checkbox" checked={addYaw} onChange={(e) => setAddYaw(e.target.checked)} /> Girado 90° (comprimento na largura)
                  </label>
                ) : (
                  <label className="field">
                    Orientação
                    <select value={addOrient} onChange={(e) => setAddOrient(e.target.value as Orientation | 'AUTO')}>
                      <option value="AUTO">Natural (apoiada na maior face)</option>
                      {(addPackSnap?.allowedOrientations ?? ['LWH']).map((o) => (
                        <option key={o} value={o}>
                          {ORIENTATION_LABEL[o]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {tab !== 'package' ? (
                  <label className="check">
                    <input type="checkbox" checked={allowStack} onChange={(e) => setAllowStack(e.target.checked)} /> Empilhar quando o piso estiver cheio (todos os paletes aceitam, se houver altura)
                  </label>
                ) : (
                  <label className="check" title="As caixas vão para o piso livre e, quando não houver, para cima dos paletes (se o produto de baixo for empilhável)">
                    <input type="checkbox" checked={onTopOnly} onChange={(e) => setOnTopOnly(e.target.checked)} /> Só por cima dos paletes/caixas
                  </label>
                )}
                <div className="row">
                  <label className="field" style={{ width: 90 }}>
                    Quantidade
                    <input type="number" min={1} max={500} value={addQty} onChange={(e) => setAddQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
                  </label>
                  <button className="primary" style={{ alignSelf: 'flex-end' }} onClick={addUnits}>
                    Adicionar
                  </button>
                </div>
                <small>{tab === 'empty' ? 'Insere o palete vazio na próxima posição livre e abre o palete para você colocar as caixas.' : 'Coloca na próxima posição livre a partir da frente (x=0) em direção à traseira.'}</small>
              </div>
            </div>
          )}
        </div>

        <div className="canvas-wrap">
          <div className="toolbar">
            <ViewButtons view={view} setView={(v) => { setView(v); setViewNonce((n) => n + 1) }} views={['persp', 'top', 'side', 'front', 'rear']} />
            <button className={`small ${showWalls ? 'active' : ''}`} onClick={() => setShowWalls((s) => !s)}>
              Paredes
            </button>
            <button className={`small ${showRoof ? 'active' : ''}`} onClick={() => setShowRoof((s) => !s)}>
              Teto
            </button>
            <button className={`small ${showLabels ? 'active' : ''}`} onClick={() => setShowLabels((s) => !s)}>
              Etiquetas
            </button>
            <button className={`small ${showPrint ? 'active' : ''}`} onClick={() => setShowPrint((s) => !s)} title="Mostra o código do produto impresso nas caixas">
              Impressão
            </button>
            <select value={snapMm} onChange={(e) => setSnap(Number(e.target.value))} style={{ fontSize: 12, padding: '2px 4px' }}>
              {SNAP_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  Passo {s} mm
                </option>
              ))}
            </select>
            <span className="spacer" />
            {editable && (
              <>
                <button className="small" onClick={undo} disabled={!canUndo}>
                  ↶ Desfazer
                </button>
                <button className="small" onClick={redo} disabled={!canRedo}>
                  ↷ Refazer
                </button>
              </>
            )}
          </div>
          <Scene3D
            bounds={{ kind: 'container', size: { x: SV.l, y: SV.w, z: SV.h }, door: isNone ? undefined : shown.space.door }}
            bodies={bodies}
            view={view}
            viewNonce={viewNonce}
            showWalls={showWalls && !isNone}
            showRoof={showRoof}
            showLabels={showLabels}
            snapMm={snapMm}
            cg={isNone ? null : summary.cg}
            quadrants={showQuadrants ? quadKg : null}
            axles={axleMarks}
            showPrint={showPrint}
            onSelect={(id, add) => {
              if (inner) {
                setInnerSel(id?.startsWith('item:') ? id.slice(5) : null)
                return
              }
              select(id == null ? [] : add ? (selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]) : [id])
            }}
            onDoubleClick={(id) => {
              if (inner) {
                if (id.startsWith('deck:')) exitPallet()
                return
              }
              if (!preview) enterPallet(id)
            }}
            gizmo={editable}
            onDragStart={() => {
              if (!editable) return
              checkpoint()
              dragFrom.current = store.getState().doc
            }}
            onDragEnd={endDragCheck}
            onCaptureReady={onCaptureReady}
            onRecorderReady={onRecorderReady}
            onMove={(id, min, how) => {
              if (!editable) return
              if (inner && id.startsWith('item:') && innerUnit) {
                // caixa dentro do palete: espaço da carga → posição local; no plano, assenta na superfície de baixo
                innerEdit((p, it) => {
                  const size = orientDims(p.packs[it.packId].dims, it.orientation)
                  const local = spaceToItemPos(p, innerUnit, min, size)
                  const z = how === 'plane' ? restZ(localObstacles(p, it.id), { min: local, size }, 0) : Math.max(0, local.z)
                  return { ...p, items: p.items.map((i) => (i.id === it.id ? { ...i, pos: { x: local.x, y: local.y, z } } : i)) }
                }, true)
                return
              }
              applyTransient((d) => ({
                ...d,
                units: d.units.map((u) => {
                  if (u.id !== id || u.locked) return u
                  const b = boxOf(d, u)
                  if (!b) return u
                  const z = how === 'plane' ? restZ(moveObstacles(d, u), { min, size: b.size }, 0) : Math.max(0, min.z)
                  return { ...u, pos: { ...min, z } }
                }),
              }))
            }}
          />
          {msg && msg.type !== 'ok' && (
            <div className={`canvas-msg alert ${msg.type}`} onClick={() => setMsg(null)} title="Clique para fechar">
              {msg.text}
            </div>
          )}
          {inner && (
            <div className="inner-bar">
              <strong>Dentro do palete {innerUnit ? `P${shown.units.findIndex((u) => u.id === innerUnit.id) + 1}` : ''}</strong>
              {innerPallet && (
                <span className="muted">
                  {' '}
                  · {nf0.format(palletSummary(innerPallet).packages)} caixa(s) · {kg(palletSummary(innerPallet).grossKg)} · altura {nf0.format(palletSummary(innerPallet).totalHeightMm)} mm
                </span>
              )}
              <span className="muted"> · clique numa caixa · setas movem · R gira · T tomba · Del retira</span>
              <button className="small primary" onClick={exitPallet}>
                ↩ Sair do palete (Esc)
              </button>
            </div>
          )}
          {!inner && sel && selGeom && <UnitCard doc={shown} g={selGeom} colorOf={colorOf} onClose={() => select([])} />}
          {inner && innerItem && innerPallet && (
            <div className="unit-card">
              <div className="unit-card-head">
                <strong>
                  <span className="swatch" style={{ background: colorOf.get(innerPallet.packs[innerItem.packId].sku) }} />
                  {innerPallet.packs[innerItem.packId].sku}
                </strong>
                <button className="small" onClick={() => setInnerSel(null)} aria-label="Fechar">
                  ×
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11 }}>
                {innerPallet.packs[innerItem.packId].name}
              </div>
              {(() => {
                const k = innerPallet.packs[innerItem.packId]
                const d = orientDims(k.dims, innerItem.orientation)
                return (
                  <div style={{ fontSize: 12, margin: '4px 0' }}>
                    {d.x} × {d.y} × {d.z} mm (x × y × altura) · {kg(k.grossKg)} · altura no palete {nf0.format(innerItem.pos.z)} mm
                  </div>
                )
              })()}
              {editable && (
                <>
                  <label className="field">
                    Orientação
                    <select value={innerItem.orientation} onChange={(e) => innerReorient(e.target.value as Orientation)}>
                      {[...new Set([innerItem.orientation, ...naturalOrientations(innerPallet.packs[innerItem.packId].dims, innerPallet.packs[innerItem.packId].allowedOrientations)])].map((o) => {
                        const d = orientDims(innerPallet.packs[innerItem.packId].dims, o)
                        return (
                          <option key={o} value={o}>
                            {ORIENTATION_LABEL[o]} — {d.x}×{d.y}×{d.z} mm
                          </option>
                        )
                      })}
                    </select>
                  </label>
                  <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    <button className="small" onClick={() => innerReorient('yaw')}>
                      ⟳ Girar
                    </button>
                    <button className="small" onClick={() => innerReorient('flip')}>
                      ⤾ Tombar
                    </button>
                    <button className="small danger" onClick={innerRemove}>
                      Retirar caixa
                    </button>
                  </div>
                  <small className="muted">Arraste no 3D ou use as setas/PgUp/PgDn para mover. O palete fica com montagem própria (os paletes iguais não mudam).</small>
                </>
              )}
            </div>
          )}
          <ColorLegend doc={shown} colorOf={colorOf} />
          <div className="hint hint-touch">
            Um dedo gira · dois dedos aproximam e deslocam · toque numa caixa seleciona{editable ? '; toque de novo nela e arraste para mover' : ''}
          </div>
          <div className="hint hint-mouse">
            <strong>Câmera:</strong> esq. gira · dir., roda pressionada ou Shift+esq. desloca · roda: zoom no cursor · ⌖ Centralizar<br />
            NORTE/FRENTE (cabine) em x=0, SUL/TRASEIRA em x={nf0.format(S.l)}, OESTE = lado do motorista, LESTE = acompanhante · arraste (assenta na superfície de baixo) ou use as setas coloridas X/Y/Z (azul = altura) · teclas setas/PgUp/PgDn ({snapMm} mm; Shift ×10) · R gira · T tomba · Ctrl+D duplica · Del apaga · duplo clique num palete: editar as caixas
          </div>
        </div>

        <div className="side">
          {sel && selGeom && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>{selGeom.label}</h3>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                {nf0.format(selGeom.box.size.x)} × {nf0.format(selGeom.box.size.y)} × {nf0.format(selGeom.box.size.z)} mm · {kg(selGeom.grossKg)}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>Posição do canto (mm) — x (comprimento) / y (largura) / z (altura)</div>
              <div className="xyz">
                {(['x', 'y', 'z'] as const).map((a) => (
                  <NumberInput
                    key={a}
                    value={sel.pos[a]}
                    disabled={readOnly || sel.locked}
                    onCommit={(v) => apply((d) => ({ ...d, units: d.units.map((u) => (u.id === sel.id ? { ...u, pos: { ...u.pos, [a]: a === 'z' ? Math.max(0, v) : v } } : u)) }))}
                  />
                ))}
              </div>
              {sel.kind === 'PACKAGE' && (
                <label className="field" style={{ marginTop: 6 }}>
                  Orientação
                  <select
                    value={sel.orientation}
                    disabled={readOnly || sel.locked}
                    onChange={(e) => reorientSel(e.target.value as Orientation)}
                  >
                    {doc.packs[sel.packId] &&
                      [...new Set([sel.orientation, ...distinctOrientations(doc.packs[sel.packId].dims, doc.packs[sel.packId].allowedOrientations)])].map((o) => {
                        const d = orientDims(doc.packs[sel.packId].dims, o)
                        return (
                          <option key={o} value={o}>
                            {ORIENTATION_LABEL[o]} — {d.x}×{d.y}×{d.z} mm
                          </option>
                        )
                      })}
                  </select>
                </label>
              )}
              <label className="field" style={{ marginTop: 6 }}>
                Etiqueta
                <input
                  key={sel.id}
                  defaultValue={sel.label ?? ''}
                  disabled={readOnly}
                  placeholder="Ex.: P1, Cliente A…"
                  onBlur={(e) => e.target.value !== (sel.label ?? '') && apply((d) => ({ ...d, units: d.units.map((u) => (u.id === sel.id ? { ...u, label: e.target.value.trim() || undefined } : u)) }))}
                />
              </label>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {selGeom.bySku.map((l) => `${l.sku}: ${l.packages} vol. / ${l.units} un.`).join(' · ')}
              </div>
              {sel.kind === 'PALLET' && shown.pallets[sel.palletKey] && (
                <RemoveBoxes
                  pallet={shown.pallets[sel.palletKey]}
                  disabled={readOnly || sel.locked}
                  onRemove={(n, sku) => {
                    const r = removeBoxesFromPallet(doc, sel.id, n, sku || undefined)
                    if (r.error) setMsg({ type: 'warn', text: r.error })
                    else {
                      apply(() => r.doc)
                      setMsg({ type: 'ok', text: `${r.removed} caixa(s) retirada(s); o palete ficou com ${r.remaining}.` })
                    }
                  }}
                />
              )}
            </div>
          )}
          {selUnits.length > 1 && <div className="panel">{selUnits.length} unidades selecionadas</div>}
          {editable && selUnits.length > 0 && (
            <div className="row">
              <button className="small" onClick={rotateSel}>
                ⟳ Girar 90°
              </button>
              {selUnits.some((u) => u.kind === 'PACKAGE') && (
                <button className="small" onClick={flipSel} title="Tombar: outra face na vertical (tecla T)">
                  ⤾ Tombar
                </button>
              )}
              <button className="small" onClick={duplicateSel}>
                Duplicar
              </button>
              <button className="small" onClick={settleSel}>
                Assentar
              </button>
              <button className="small" onClick={() => apply((d) => ({ ...d, units: d.units.map((u) => (selection.includes(u.id) ? { ...u, locked: !u.locked } : u)) }))}>
                {selUnits.every((u) => u.locked) ? 'Desbloquear' : 'Bloquear'}
              </button>
              <button className="small danger" onClick={removeSel}>
                Excluir
              </button>
            </div>
          )}
          <div className="panel">
            <div className="kpis">
              <Kpi
                k="Peso bruto (c/ paletes)"
                v={kg(summary.payloadKg)}
                s={L.payloadKg.value ? `de ${kg(L.payloadKg.value)}` : 'sem limite informado'}
                meter={summary.payloadPct}
                level={summary.payloadPct != null && summary.payloadPct > 100 ? 'CRITICAL' : undefined}
              />
              <Kpi
                k="Peso c/ equipamento"
                v={kg(summary.grossKg)}
                s={`tara do equipamento ${kg(summary.equipmentTareKg)} (fora do limite da carga)`}
                level={L.grossKg.value != null && summary.grossKg > L.grossKg.value ? 'CRITICAL' : undefined}
              />
              <Kpi k="Peso líquido" v={kg(summary.netKg)} s={`c/ embalagem ${kg(summary.bySku.reduce((t, l) => t + l.grossKg, 0))} · tara paletes ${kg(summary.palletTareKg)}`} />
              <Kpi k="Paletes / volumes" v={`${summary.pallets} / ${summary.packages}`} s={`${nf0.format(summary.units)} unidades · ${summary.looseUnits} soltos`} />
              <Kpi k="CBM (bultos)" v={m3(summary.cbmUnits)} s={`interno ${m3(summary.innerCbm)}`} />
              {summary.chargeableKg != null && (
                <Kpi
                  k="Peso taxável (aéreo)"
                  v={kg(summary.chargeableKg)}
                  s={`real ${kg(summary.payloadKg)} · volumétrico ${kg(summary.volumetricKg)} (1 m³ = 166,67 kg)`}
                />
              )}
              <Kpi k="Ocupação volume" v={pct(summary.volumeUtilPct)} meter={summary.volumeUtilPct} />
              <Kpi k="Ocupação piso" v={pct(summary.floorUtilPct)} meter={summary.floorUtilPct} />
              <Kpi k="Comprimento usado" v={mm(summary.usedLengthMm)} s={`livre ${mm(summary.freeLengthMm)}`} />
              <Kpi
                k="CG longitudinal"
                v={summary.cgLongDevPct == null ? '—' : `${summary.cgLongDevPct > 0 ? '+' : ''}${pct(summary.cgLongDevPct)}`}
                s={summary.cg ? `x = ${mm(summary.cg.x)} (centro ${mm(S.l / 2)})` : undefined}
                level={summary.cgLongDevPct != null && Math.abs(summary.cgLongDevPct) > L.thresholds.cgLongTolPct ? 'WARNING' : undefined}
              />
              <Kpi
                k="CG lateral"
                v={summary.cgLatDevPct == null ? '—' : `${summary.cgLatDevPct > 0 ? '+' : ''}${pct(summary.cgLatDevPct)}`}
                s={summary.cg ? `altura CG ${mm(summary.cg.z)}` : undefined}
                level={summary.cgLatDevPct != null && Math.abs(summary.cgLatDevPct) > L.thresholds.cgLatTolPct ? 'WARNING' : undefined}
              />
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 11 }}>Distribuição longitudinal (kg por metro; frente → traseira)</div>
              <div className="chart-bars">
                {summary.longitudinal.map((b) => (
                  <div
                    key={b.fromMm}
                    className={floorLimit && b.kg / ((b.toMm - b.fromMm) / 1000) > floorLimit ? 'over' : ''}
                    style={{ height: `${(b.kg / maxBin) * 100}%` }}
                    title={`${nf0.format(b.fromMm / 1000)}–${nf0.format(b.toMm / 1000)} m: ${kg(b.kg)}`}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="panel">
            <IssuesList issues={issues} onPick={(refs) => select(refs)} />
          </div>
          {geoms.length > 0 && (
            <details className="panel">
              <summary>
                <strong>Unidades ({geoms.length})</strong>
              </summary>
              <div className="list-select" style={{ maxHeight: 220, marginTop: 6 }}>
                {geoms.map((g) => (
                  <button
                    key={g.unit.id}
                    className={selection.includes(g.unit.id) ? 'sel' : ''}
                    onClick={(e) => select(e.shiftKey ? [...selection, g.unit.id] : [g.unit.id])}
                    style={invalid.has(g.unit.id) ? { color: 'var(--crit)' } : undefined}
                  >
                    {g.unit.locked ? '🔒 ' : ''}
                    {g.label} · x {g.box.min.x} y {g.box.min.y} z {g.box.min.z}
                  </button>
                ))}
              </div>
            </details>
          )}
          {summary.bySku.length > 0 && (
            <div className="panel">
              <table className="data compact">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="num">Vol.</th>
                    <th className="num">Un.</th>
                    <th className="num" title="Peso líquido: só o produto">Líq.</th>
                    <th className="num" title="Peso líquido com embalagem: produto + caixa">c/ emb.</th>
                    <th className="num" title="Peso bruto: produto + caixa + tara dos paletes (repartida pelos produtos de cada palete)">Bruto</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.bySku.map((l) => (
                    <tr key={l.sku}>
                      <td>{l.sku}</td>
                      <td className="num">{l.packages}</td>
                      <td className="num">{nf0.format(l.units)}</td>
                      <td className="num">{kg(l.netKg)}</td>
                      <td className="num">{kg(l.grossKg)}</td>
                      <td className="num">{kg(l.grossKg + (tareBySku.get(l.sku) ?? 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {/* celular: PDFs e aprovação sempre à mão (barra fixa embaixo) */}
      {(pdfUrl || expedition || mobileActions || editable) && (
        <div className="mobile-actions no-print">
          {pdfUrl && (
            <button onClick={() => void generatePdf()} disabled={pdfBusy || dirty || Boolean(preview)}>
              {pdfBusy ? 'Gerando…' : '📄 Pedido'}
            </button>
          )}
          {expedition && (
            <button onClick={() => void generateExpeditionPdf()} disabled={pdfBusy || dirty || Boolean(preview) || (!summary.pallets && !summary.looseUnits)}>
              📋 Expedição
            </button>
          )}
          {editable && dirty && (
            <button className="primary" onClick={doSave} disabled={saving}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
          )}
          {!dirty && mobileActions}
        </div>
      )}
    </div>
  )
}

/** Retirar caixas de um palete colocado (o palete vira parcial; os iguais não mudam). */
function RemoveBoxes({ pallet, disabled, onRemove }: { pallet: PalletDoc; disabled: boolean; onRemove: (n: number, sku: string) => void }) {
  const c = palletBoxCounts(pallet)
  const skus = [...new Set(Object.values(pallet.packs).map((p) => p.sku))]
  const [n, setN] = useState(1)
  const [sku, setSku] = useState('')
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div style={{ fontSize: 13 }}>
        Caixas no palete: <strong>{c.boxes}</strong> de {c.fullBoxes} {c.partial && <span className="badge WARNING">parcial</span>}
      </div>
      {!disabled && c.boxes > 0 && (
        <div className="row" style={{ marginTop: 6 }}>
          <input type="number" min={1} max={c.boxes} value={n} onChange={(e) => setN(Math.max(1, Math.min(c.boxes, Number(e.target.value) || 1)))} style={{ width: 64 }} onKeyDown={(e) => e.stopPropagation()} />
          {skus.length > 1 && (
            <select value={sku} onChange={(e) => setSku(e.target.value)}>
              <option value="">qualquer SKU</option>
              {skus.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          )}
          <button className="small" onClick={() => onRemove(n, sku)} title="Retira as caixas de cima primeiro">
            Retirar caixa(s)
          </button>
        </div>
      )}
    </div>
  )
}

/** Resumo do palete/volume clicado no 3D: produtos, caixas, unidades e kg daquela unidade. */
function UnitCard({ doc, g, colorOf, onClose }: { doc: LoadDoc; g: ReturnType<typeof loadGeometries>[number]; colorOf: Map<string, string>; onClose: () => void }) {
  const u = g.unit
  const L = doc.space.inner.l, W = doc.space.inner.w
  const f = footprintFractions(g.box, L, W)
  const where = QUADRANTS.filter((q) => f[q] > 0.005)
    .sort((a, b) => f[b] - f[a])
    .map((q) => (f[q] > 0.995 ? q : `${q} ${nf0.format(f[q] * 100)}%`))
    .join(' · ')
  const p = u.kind === 'PALLET' ? doc.pallets[u.palletKey] : null
  const counts = p ? palletBoxCounts(p) : null
  return (
    <div className="unit-card">
      <div className="unit-card-head">
        <strong>{g.label}</strong>
        <button className="small" onClick={onClose} aria-label="Fechar">
          ×
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {p ? `${p.name} · ${p.palletType.code}` : 'Volume solto'}
        {counts?.partial && ` · PARCIAL ${counts.boxes} de ${counts.fullBoxes} caixas`}
        {u.pos.z > 0 && ' · empilhado'}
      </div>
      <table className="data compact" style={{ marginTop: 4 }}>
        <thead>
          <tr>
            <th>Produto</th>
            <th className="num">Cx</th>
            <th className="num">Un.</th>
            <th className="num" title="Peso líquido com embalagem (produto + caixa)">c/ emb.</th>
          </tr>
        </thead>
        <tbody>
          {g.bySku.map((l) => (
            <tr key={l.sku}>
              <td title={l.name}>
                <span className="swatch" style={{ background: colorOf.get(l.sku) }} />
                {l.sku}
              </td>
              <td className="num">{nf0.format(l.packages)}</td>
              <td className="num">{nf0.format(l.units)}</td>
              <td className="num">{kg(l.grossKg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="unit-card-kgs">
        <span>Líquido <strong>{kg(g.netKg)}</strong></span>
        {p && <span>Tara palete <strong>{kg(g.tareKg)}</strong></span>}
        <span>Bruto <strong>{kg(g.grossKg)}</strong></span>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {nf0.format(g.box.size.x)} × {nf0.format(g.box.size.y)} × {nf0.format(g.box.size.z)} mm · quadrante {where || '—'}
      </div>
    </div>
  )
}

/** Legenda: cor = produto (só os produtos presentes na carga). */
function ColorLegend({ doc, colorOf }: { doc: LoadDoc; colorOf: Map<string, string> }) {
  const names = new Map<string, string>()
  for (const u of doc.units) {
    const packs = u.kind === 'PALLET' ? Object.values(doc.pallets[u.palletKey]?.packs ?? {}) : doc.packs[u.packId] ? [doc.packs[u.packId]] : []
    for (const k of packs) names.set(k.sku, k.name)
  }
  if (!names.size) return null
  return (
    <div className="color-legend">
      {[...names.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([sku, name]) => (
          <div key={sku} title={name}>
            <span className="swatch" style={{ background: colorOf.get(sku) }} />
            <strong>{sku}</strong> <span className="muted">{name}</span>
          </div>
        ))}
    </div>
  )
}

/** Regras logísticas do envio (configuração central): palete padrão e peso bruto máximo da carga. */
function LogisticsBox({ res, doc, readOnly, onApply }: { res: LogisticsResolution; doc: LoadDoc; readOnly: boolean; onApply: () => void }) {
  const current = doc.limits.find((l) => l.profileId === RULE_LIMIT_PROFILE_ID)?.maxPayloadKg ?? null
  const missing = res.maxCargoKg != null && current !== res.maxCargoKg
  return (
    <div className={`alert ${missing ? 'warn' : 'ok'}`} style={{ marginTop: 8, fontSize: 12 }}>
      <strong>Regras logísticas</strong>
      {res.applied.map((a) => (
        <div key={a.id}>• {a.description}</div>
      ))}
      {missing && (
        <div style={{ marginTop: 4 }}>
          Esta carga {current == null ? 'ainda não tem' : `tem ${kg(current)} como`} limite da regra.{' '}
          {!readOnly && (
            <button className="small" onClick={onApply}>
              Aplicar limite de {kg(res.maxCargoKg)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

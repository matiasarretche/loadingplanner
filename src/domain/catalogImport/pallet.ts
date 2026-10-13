/**
 * Palete da embalagem planejada (decisão 16): nos produtos que já existem (com equivalente), o palete do
 * CATÁLOGO prevalece — tipo e unidades por palete (regra do projeto: a regra logística PCF-1150 não pode
 * baixar unidades por palete nem caixas por camada do padrão). Nos novos, o da tabela de caixas, com o
 * MAIOR número quando a tabela dá duas opções ("20 ou 26" → 26).
 *
 * O palete do catálogo só vale se ainda SERVE para a caixa planejada: com a caixa nova, no mesmo tipo de
 * palete, pelo menos as mesmas caixas por camada que a caixa antiga dava, e a pilha até a altura das
 * montagens de referência (porta do 20'/40' Dry). Senão vale o da tabela de caixas (uma caixa de 1000×600
 * no PCF-1150 com as 8 un. da caixa de 1140×570 viraria uma "torre" de 1 por camada × 8 camadas, 4 m).
 * A mesma conferência vale com a mesma caixa: a embalagem gravada pode já estar errada (reimportação).
 */
import { bestLayer } from '@/domain/autopallet'
import type { Orientation } from '@/domain/geometry'
import { REFERENCE_PALLET_MAX_HEIGHT_MM } from '@/domain/logisticsRules'
import type { PackSnapshot, PalletTypeSnapshot } from '@/domain/types'
import type { BoxAssignment } from './assignBox'
import type { ImportDecisions } from './decisions'
import type { BoxModel, CurrentVariant, PalletTypeRef } from './types'

export interface PlannedPallet {
  palletTypeCode: string | null
  unitsPerPallet: number | null
  palletSource: 'CATALOG' | 'SHEET'
  palletNote: string | null
  /** altura estimada do palete padrão (tabuleiro + camadas × altura da caixa); null sem palete */
  palletHeightMm: number | null
  /** o palete do catálogo não servia para a caixa e foi trocado pelo da tabela */
  catalogPalletReplaced: boolean
  /** o palete final passa da altura das montagens de referência (sem alternativa na tabela) */
  tooTall: boolean
}

/** excesso aceito sobre o palete para ganhar volumes por camada (o mesmo das montagens de referência) */
const TOLERANCE_MM = 25
/** altura do tabuleiro quando o cadastro do palete não informa */
const DEFAULT_PALLET_HEIGHT_MM = 150
const ALL: Orientation[] = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL']
const dimsKey = (l: number, w: number, h: number) => `${Math.max(l, w)}x${Math.min(l, w)}x${h}`
const mm = (x: number) => Math.round(x).toLocaleString('pt-BR')

export interface StackInfo {
  /** caixas por camada (0 = a caixa não cabe no palete nem com a tolerância) */
  perLayer: number
  layers: number
  heightMm: number
}

/** Camadas do palete padrão: caixas por camada (mesmo cálculo das montagens de referência), camadas e altura. */
export function palletStack(pt: PalletTypeRef, box: { lengthMm: number; widthMm: number; heightMm: number }, units: number): StackInfo {
  const pallet: PalletTypeSnapshot = {
    palletTypeId: pt.id,
    code: pt.code,
    name: pt.code,
    dims: { l: pt.lengthMm, w: pt.widthMm, h: pt.heightMm ?? DEFAULT_PALLET_HEIGHT_MM },
    tareKg: 0,
    staticMaxKg: null,
    dynamicMaxKg: null,
    maxLoadKg: null,
    overhangAllowed: pt.overhangAllowed ?? false,
    overhangMaxMm: pt.overhangMaxMm ?? 0,
    verification: 'ESTIMATED',
  }
  const pack: PackSnapshot = {
    packagingVersionId: 0,
    version: 1,
    sku: '',
    name: '',
    packageType: 'Caixa',
    dims: { l: Math.max(box.lengthMm, box.widthMm), w: Math.min(box.lengthMm, box.widthMm), h: box.heightMm },
    netKg: 0,
    grossKg: 0,
    unitsPerPackage: 1,
    allowedOrientations: ALL,
    stackable: true,
    maxStackLayers: null,
    maxStackKg: null,
    fragile: false,
    verification: 'ESTIMATED',
    color: '#000000',
  }
  // bestLayer devolve uma camada "forçada" (excede o palete) quando nada cabe: essa não conta
  const over = (pallet.overhangAllowed ? 2 * pallet.overhangMaxMm : 0) + TOLERANCE_MM
  const fits = (l: { slots: unknown[]; sizeX: number; sizeY: number }) => l.slots.length > 0 && l.sizeX <= pallet.dims.l + over && l.sizeY <= pallet.dims.w + over
  const perLayer = Math.max(0, ...[bestLayer(pallet, pack), bestLayer(pallet, pack, TOLERANCE_MM)].filter(fits).map((l) => l.slots.length))
  if (!perLayer) return { perLayer: 0, layers: 0, heightMm: Infinity }
  const layers = Math.ceil(units / perLayer)
  return { perLayer, layers, heightMm: pallet.dims.h + layers * box.heightMm }
}

/** altura para guardar (null: sem palete ou a caixa não cabe) */
const hOf = (s: StackInfo | null) => (s && Number.isFinite(s.heightMm) ? s.heightMm : null)
const stackTxt = (s: StackInfo) => (s.perLayer ? `${s.perLayer} por camada × ${s.layers} camada(s) = ${mm(s.heightMm)} mm` : 'a caixa não cabe no palete')

export function plannedPallet(a: Extract<BoxAssignment, { status: 'ASSIGNED' }>, cur: CurrentVariant | null, d: ImportDecisions, palletTypes: PalletTypeRef[] = []): PlannedPallet {
  const geo = (code: string | null) => (code ? (palletTypes.find((p) => p.code === code) ?? null) : null)
  const maxH = REFERENCE_PALLET_MAX_HEIGHT_MM
  const pk = cur?.pack ?? null
  if (a.source === 'CURRENT_CATALOG') {
    const pt = geo(a.pack.palletTypeCode)
    const st = pt && a.pack.unitsPerPallet ? palletStack(pt, a.pack, a.pack.unitsPerPallet) : null
    const tooTall = !!st && st.heightMm > maxH
    return {
      palletTypeCode: a.pack.palletTypeCode,
      unitsPerPallet: a.pack.unitsPerPallet,
      palletSource: 'CATALOG',
      palletNote: `palete do catálogo (${a.fromSku})${tooTall ? `; ${stackTxt(st!)}: passa de ${mm(maxH)} mm` : ''}`,
      palletHeightMm: hOf(st),
      catalogPalletReplaced: false,
      tooTall,
    }
  }
  const box: BoxModel = a.box
  const sameBox = !!pk && dimsKey(pk.lengthMm, pk.widthMm, pk.heightMm) === dimsKey(box.lengthMm, box.widthMm, box.heightMm)
  const catalogOk = !!pk && pk.palletTypeCode != null && pk.unitsPerPallet != null && pk.unitsPerPallet > 0
  // palete da tabela de caixas para esta caixa
  const sheetPt = geo(box.palletTypeCode)
  const sheetSt = sheetPt && box.boxesPerPallet ? palletStack(sheetPt, box, box.boxesPerPallet) : null
  const sheetNotes = (): string[] => {
    const notes: string[] = []
    if (box.palletText && !box.palletTypeCode) notes.push(`palete "${box.palletText}" da tabela não existe no programa`)
    if (box.boxesPerPalletText && /\D\d/.test(box.boxesPerPalletText.trim())) notes.push(`tabela: "${box.boxesPerPalletText}" → ${box.boxesPerPallet}`)
    if (box.palletText === '2,00X1,20' && box.palletTypeCode) notes.push(`palete "2,00×1,20" da tabela = ${box.palletTypeCode} (decisão de 13/10/2026)`)
    if (sheetSt && sheetSt.heightMm > maxH) notes.push(`${stackTxt(sheetSt)}: passa de ${mm(maxH)} mm`)
    return notes
  }

  if (catalogOk && (d.palletPrevalence === 'CATALOG_ALWAYS' || sameBox)) {
    const upp = pk!.unitsPerPallet!
    const pt = geo(pk!.palletTypeCode)
    const nw = pt ? palletStack(pt, box, upp) : null
    const old = pt && !sameBox ? palletStack(pt, pk!, upp) : null
    const fewerPerLayer = !!nw && !!old && nw.perLayer < old.perLayer
    const tooTall = !!nw && nw.heightMm > maxH
    const catTxt = `${cur!.sku}: ${pk!.palletTypeCode} × ${upp}`
    if (!fewerPerLayer && !tooTall) {
      const notes: string[] = [`palete do catálogo (${catTxt})`]
      if (!sameBox) notes.push(`a caixa muda para ${box.code}; o palete do catálogo é mantido (${nw ? stackTxt(nw) : 'tipo de palete sem medidas'})`)
      const sheetDiffers = (box.palletTypeCode && box.palletTypeCode !== pk!.palletTypeCode) || (box.boxesPerPallet != null && box.boxesPerPallet !== upp)
      if (sheetDiffers) notes.push(`tabela de caixas: ${box.boxesPerPalletText ?? '—'} em ${box.palletText ?? '—'}`)
      return { palletTypeCode: pk!.palletTypeCode, unitsPerPallet: upp, palletSource: 'CATALOG', palletNote: notes.join('; '), palletHeightMm: hOf(nw), catalogPalletReplaced: false, tooTall: false }
    }
    const why = !nw!.perLayer
      ? `a caixa não cabe no palete ${pk!.palletTypeCode}`
      : [fewerPerLayer ? `${old!.perLayer} → ${nw!.perLayer} por camada` : null, tooTall ? `${stackTxt(nw!)}, passa de ${mm(maxH)} mm` : null].filter(Boolean).join('; ')
    const what = sameBox ? `com a caixa ${box.code}` : `com a caixa nova ${box.code}`
    const sheetServes = !!box.palletTypeCode && !!box.boxesPerPallet && (!sheetSt || sheetSt.heightMm <= maxH)
    if (sheetServes) {
      const notes = [`o palete do catálogo (${catTxt}) não serve ${what} (${why}): usado o da tabela de caixas (${box.palletTypeCode} × ${box.boxesPerPallet}${sheetSt ? `, ${stackTxt(sheetSt)}` : ''})`, ...sheetNotes()]
      return { palletTypeCode: box.palletTypeCode, unitsPerPallet: box.boxesPerPallet, palletSource: 'SHEET', palletNote: notes.join('; '), palletHeightMm: hOf(sheetSt), catalogPalletReplaced: true, tooTall: false }
    }
    return {
      palletTypeCode: pk!.palletTypeCode,
      unitsPerPallet: upp,
      palletSource: 'CATALOG',
      palletNote: `palete do catálogo (${catTxt}) mantido, mas não serve ${what} (${why}) e a tabela de caixas não tem alternativa — confira no Catálogo`,
      palletHeightMm: hOf(nw),
      catalogPalletReplaced: false,
      tooTall: true,
    }
  }
  const notes = sheetNotes()
  return {
    palletTypeCode: box.palletTypeCode,
    unitsPerPallet: box.boxesPerPallet,
    palletSource: 'SHEET',
    palletNote: notes.length ? notes.join('; ') : null,
    palletHeightMm: hOf(sheetSt),
    catalogPalletReplaced: false,
    tooTall: !!sheetSt && sheetSt.heightMm > maxH,
  }
}

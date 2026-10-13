import { effectiveCarrier } from './vehicleLength'
import { AxleResult, axleIssues, axleLoads } from './axles'
import { Body } from './bodies'
import { physicalChecks } from './checks'
import { AABB, cbm, center, maxCorner, orientDims, overlap1, unionArea, Vec3, within } from './geometry'
import { fmt, Issue } from './issues'
import { palletEnvelope, palletSummary, SkuLine, validatePallet, verLabel } from './pallet'
import { companionStatus } from './companions'
import { stackable } from './policy'
import { isOutsideSpace } from './staging'
import { DEFAULT_QUADRANT_RULES, quadrantShares } from './quadrants'
import { DEFAULT_THRESHOLDS, LoadDoc, LoadUnit, PalletDoc, Thresholds } from './types'

// ---------------------------------------------------------------------------
// Transformação local do palete → espaço de carga (yaw = giro de 90° anti-horário em Z)
// ---------------------------------------------------------------------------

export interface PalletPlacement {
  /** posição do grupo (origem local do palete) no espaço de carga */
  groupPos: Vec3
  rotZ: number
}

export function palletPlacement(p: PalletDoc, unit: { pos: Vec3; yaw: boolean }): PalletPlacement {
  const e = palletEnvelope(p)
  if (!unit.yaw) {
    return { groupPos: { x: unit.pos.x - e.min.x, y: unit.pos.y - e.min.y, z: unit.pos.z - e.min.z }, rotZ: 0 }
  }
  return {
    groupPos: { x: unit.pos.x + e.min.y + e.size.y, y: unit.pos.y - e.min.x, z: unit.pos.z - e.min.z },
    rotZ: Math.PI / 2,
  }
}

export function palletLocalToSpace(pl: PalletPlacement, p: Vec3): Vec3 {
  if (pl.rotZ === 0) return { x: pl.groupPos.x + p.x, y: pl.groupPos.y + p.y, z: pl.groupPos.z + p.z }
  return { x: pl.groupPos.x - p.y, y: pl.groupPos.y + p.x, z: pl.groupPos.z + p.z }
}

/** AABB local do palete → AABB no espaço de carga (giros de 90° mantêm caixas alinhadas aos eixos). */
export function palletBoxToSpace(pl: PalletPlacement, b: AABB): AABB {
  const a = palletLocalToSpace(pl, b.min)
  const c = palletLocalToSpace(pl, maxCorner(b))
  const min = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), z: Math.min(a.z, c.z) }
  return { min, size: { x: Math.abs(c.x - a.x), y: Math.abs(c.y - a.y), z: Math.abs(c.z - a.z) } }
}

/** Partes desenháveis de um palete na carga: tabuleiro + volumes, já no espaço de carga. */
export function palletParts(p: PalletDoc, unit: { pos: Vec3; yaw: boolean }): { box: AABB; packId: string | null }[] {
  const pl = palletPlacement(p, unit)
  const P = p.palletType.dims
  const out: { box: AABB; packId: string | null }[] = [
    { box: palletBoxToSpace(pl, { min: { x: 0, y: 0, z: 0 }, size: { x: P.l, y: P.w, z: Math.max(P.h, 1) } }), packId: null },
  ]
  for (const it of p.items) {
    const pack = p.packs[it.packId]
    if (!pack) continue
    const size = orientDims(pack.dims, it.orientation)
    out.push({ box: palletBoxToSpace(pl, { min: { x: it.pos.x, y: it.pos.y, z: it.pos.z + P.h }, size }), packId: it.packId })
  }
  return out
}

// ---------------------------------------------------------------------------
// Geometria de cada unidade
// ---------------------------------------------------------------------------

export interface UnitGeometry {
  unit: LoadUnit
  label: string
  box: AABB
  grossKg: number
  netKg: number
  tareKg: number
  cg: Vec3
  stackable: boolean
  maxTopKg: number | null
  maxStackLayers: number | null
  stackKey: string
  bySku: SkuLine[]
  packages: number
  verification: string[]
}

/**
 * Rótulo curto da unidade, o mesmo no 3D, nas listas e nos PDFs: P5 = palete, V7 = volume solto; o
 * número é a posição no plano (igual a "Palete 5"/"Volume 7" dos alertas). Rótulo editado prevalece.
 */
export function shortUnitLabel(u: LoadUnit, idx: number): string {
  if (u.label) return u.label
  return `${u.kind === 'PALLET' ? 'P' : 'V'}${idx + 1}`
}

export function unitLabel(u: LoadUnit, idx: number, doc: LoadDoc): string {
  if (u.label) return u.label
  if (u.kind === 'PALLET') return `Palete ${idx + 1} (${doc.pallets[u.palletKey]?.name ?? '?'})`
  return `Volume ${idx + 1} (${doc.packs[u.packId]?.sku ?? '?'})`
}

export function unitGeometry(doc: LoadDoc, u: LoadUnit, idx: number): UnitGeometry | null {
  if (u.kind === 'PALLET') {
    const p = doc.pallets[u.palletKey]
    if (!p) return null
    const s = palletSummary(p)
    const e = s.envelope
    const size = u.yaw ? { x: e.size.y, y: e.size.x, z: e.size.z } : { ...e.size }
    const pl = palletPlacement(p, u)
    return {
      unit: u,
      label: unitLabel(u, idx, doc),
      box: { min: { ...u.pos }, size },
      grossKg: s.grossKg,
      netKg: s.netKg,
      tareKg: s.tareKg,
      cg: palletLocalToSpace(pl, s.cg),
      stackable: stackable(p.stackable),
      maxTopKg: p.maxTopKg,
      maxStackLayers: null,
      stackKey: `P:${u.palletKey}`,
      bySku: s.bySku,
      packages: s.packages,
      verification: [p.palletType.verification, ...Object.values(p.packs).map((k) => k.verification)],
    }
  }
  const pack = doc.packs[u.packId]
  if (!pack) return null
  const box = { min: { ...u.pos }, size: orientDims(pack.dims, u.orientation) }
  return {
    unit: u,
    label: unitLabel(u, idx, doc),
    box,
    grossKg: pack.grossKg,
    netKg: pack.netKg,
    tareKg: 0,
    cg: center(box),
    stackable: stackable(pack.stackable),
    maxTopKg: pack.maxStackKg,
    maxStackLayers: pack.maxStackLayers,
    stackKey: `K:${pack.sku}`,
    bySku: [{ sku: pack.sku, name: pack.name, packages: 1, units: pack.unitsPerPackage, netKg: pack.netKg, grossKg: pack.grossKg }],
    packages: 1,
    verification: [pack.verification],
  }
}

// ---------------------------------------------------------------------------
// Limites efetivos: MIN(físico do equipamento, transportador, legal/rota, operacional)
// ---------------------------------------------------------------------------

export interface EffectiveLimit {
  value: number | null
  source: string
}

export interface EffectiveLimits {
  payloadKg: EffectiveLimit
  grossKg: EffectiveLimit
  heightMm: EffectiveLimit
  thresholds: Thresholds
}

function minLimit(cands: { value: number | null; source: string }[]): EffectiveLimit {
  const valid = cands.filter((c): c is { value: number; source: string } => c.value != null && c.value > 0)
  if (!valid.length) return { value: null, source: 'não informado' }
  return valid.reduce((a, b) => (b.value < a.value ? b : a))
}

export function effectiveLimits(doc: LoadDoc): EffectiveLimits {
  const s = doc.space
  const eq = `Equipamento ${s.code}`
  // Um gross máximo também limita o payload: payload ≤ gross − tara
  const payloadCands = [
    { value: s.maxPayloadKg, source: eq },
    { value: s.maxGrossKg != null ? s.maxGrossKg - s.tareKg : null, source: `${eq} (bruto − tara)` },
    ...doc.limits.flatMap((l) => [
      { value: l.maxPayloadKg, source: l.name },
      { value: l.maxGrossKg != null ? l.maxGrossKg - s.tareKg : null, source: `${l.name} (bruto − tara)` },
    ]),
  ]
  const grossCands = [{ value: s.maxGrossKg, source: eq }, ...doc.limits.map((l) => ({ value: l.maxGrossKg, source: l.name }))]
  const heightCands = [{ value: s.inner.h, source: `${eq} (altura interna)` }, ...doc.limits.map((l) => ({ value: l.maxHeightMm, source: l.name }))]

  const pick = (k: keyof Thresholds, strictest: 'max' | 'min') => {
    const vals = doc.limits.map((l) => l[k as keyof typeof l] as number | null).filter((v): v is number => v != null)
    if (!vals.length) return DEFAULT_THRESHOLDS[k]
    return strictest === 'max' ? Math.max(...vals) : Math.min(...vals)
  }
  return {
    payloadKg: minLimit(payloadCands),
    grossKg: minLimit(grossCands),
    heightMm: minLimit(heightCands),
    thresholds: {
      minSupportPct: pick('minSupportPct', 'max'),
      cgLongTolPct: pick('cgLongTolPct', 'min'),
      cgLatTolPct: pick('cgLatTolPct', 'min'),
      lowUtilPct: pick('lowUtilPct', 'max'),
      collisionTolMm: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Resumo da carga
// ---------------------------------------------------------------------------

export interface LoadSummary {
  pallets: number
  looseUnits: number
  packages: number
  units: number
  netKg: number
  palletTareKg: number
  payloadKg: number
  equipmentTareKg: number
  grossKg: number
  limits: EffectiveLimits
  payloadPct: number | null
  cbmUnits: number
  innerCbm: number
  volumeUtilPct: number
  floorUtilPct: number
  usedLengthMm: number
  freeLengthMm: number
  cg: Vec3 | null
  /** desvio do CG em relação ao centro (% do comprimento/largura; + = lado da porta / direita) */
  cgLongDevPct: number | null
  cgLatDevPct: number | null
  /** distribuição longitudinal em faixas de 1 m */
  longitudinal: { fromMm: number; toMm: number; kg: number }[]
  bySku: SkuLine[]
  /** AÉREO: peso volumétrico (m³ × 166,67 kg — divisor IATA 6.000 cm³/kg) e peso taxável = maior entre real e volumétrico */
  volumetricKg: number | null
  chargeableKg: number | null
}

export function loadGeometries(doc: LoadDoc): UnitGeometry[] {
  return doc.units.map((u, i) => unitGeometry(doc, u, i)).filter((g): g is UnitGeometry => g != null)
}

export function loadSummary(doc: LoadDoc, allGeoms = loadGeometries(doc)): LoadSummary {
  // unidades na zona de trabalho (fora do equipamento) não contam como carregadas
  const geoms = allGeoms.filter((g) => !isOutsideSpace(doc, g.box))
  const S = doc.space.inner
  const limits = effectiveLimits(doc)
  const sku = new Map<string, SkuLine>()
  let payload = 0, net = 0, tare = 0, vol = 0, pk = 0
  let mx = 0, my = 0, mz = 0, usedL = 0
  const floor: { x0: number; y0: number; x1: number; y1: number }[] = []
  for (const g of geoms) {
    payload += g.grossKg
    net += g.netKg
    tare += g.tareKg
    pk += g.packages
    vol += g.box.size.x * g.box.size.y * g.box.size.z
    mx += g.cg.x * g.grossKg
    my += g.cg.y * g.grossKg
    mz += g.cg.z * g.grossKg
    const M = maxCorner(g.box)
    usedL = Math.max(usedL, M.x)
    if (g.box.min.z === 0) floor.push({ x0: g.box.min.x, y0: g.box.min.y, x1: M.x, y1: M.y })
    for (const l of g.bySku) {
      const cur = sku.get(l.sku) ?? { ...l, packages: 0, units: 0, netKg: 0, grossKg: 0 }
      cur.packages += l.packages
      cur.units += l.units
      cur.netKg += l.netKg
      cur.grossKg += l.grossKg
      sku.set(l.sku, cur)
    }
  }
  const cg = payload > 0 ? { x: mx / payload, y: my / payload, z: mz / payload } : null
  const bins: { fromMm: number; toMm: number; kg: number }[] = []
  for (let x = 0; x < S.l; x += 1000) bins.push({ fromMm: x, toMm: Math.min(S.l, x + 1000), kg: 0 })
  for (const g of geoms) {
    // massa distribuída uniformemente ao longo do comprimento da unidade
    const x0 = g.box.min.x, x1 = x0 + g.box.size.x
    if (x1 <= x0) continue
    for (const b of bins) b.kg += (g.grossKg * overlap1(x0, x1, b.fromMm, b.toMm)) / (x1 - x0)
  }
  const innerVol = S.l * S.w * S.h
  const lines = [...sku.values()].sort((a, b) => a.sku.localeCompare(b.sku))
  return {
    pallets: geoms.filter((g) => g.unit.kind === 'PALLET').length,
    looseUnits: geoms.filter((g) => g.unit.kind === 'PACKAGE').length,
    packages: pk,
    units: lines.reduce((s, l) => s + l.units, 0),
    netKg: net,
    palletTareKg: tare,
    payloadKg: payload,
    equipmentTareKg: doc.space.tareKg,
    grossKg: payload + doc.space.tareKg,
    limits,
    payloadPct: limits.payloadKg.value ? (payload / limits.payloadKg.value) * 100 : null,
    cbmUnits: vol / 1e9,
    innerCbm: cbm(S),
    volumeUtilPct: innerVol > 0 ? (vol / innerVol) * 100 : 0,
    floorUtilPct: (unionArea(floor) / (S.l * S.w)) * 100,
    usedLengthMm: usedL,
    freeLengthMm: Math.max(0, S.l - usedL),
    cg,
    cgLongDevPct: cg ? ((cg.x - S.l / 2) / S.l) * 100 : null,
    cgLatDevPct: cg ? ((cg.y - S.w / 2) / S.w) * 100 : null,
    longitudinal: bins,
    bySku: lines,
    volumetricKg: doc.space.transport === 'AIR' ? (vol / 1e9) * AIR_KG_PER_M3 : null,
    chargeableKg: doc.space.transport === 'AIR' ? Math.max(payload, (vol / 1e9) * AIR_KG_PER_M3) : null,
  }
}

/** Divisor IATA 6.000 cm³/kg → 166,67 kg por m³ */
export const AIR_KG_PER_M3 = 1e6 / 6000

// ---------------------------------------------------------------------------
// Modelo físico detalhado: cada palete vira tabuleiro + caixas (superfícies reais)
// ---------------------------------------------------------------------------

/**
 * Corpos físicos da carga para colisão/apoio/peso:
 * - volume solto = 1 corpo;
 * - palete = tabuleiro (carrega todo o peso do palete) + uma parte por caixa (sem peso próprio;
 *   a carga que recebem desce para o tabuleiro). Assim caixas soltas podem apoiar-se no topo real
 *   de paletes (inclusive parciais) e paletes empilhados distribuem peso pelas caixas de baixo.
 */
export function loadBodies(doc: LoadDoc, geoms: UnitGeometry[] = loadGeometries(doc)): Body[] {
  const out: Body[] = []
  for (const g of geoms) {
    const u = g.unit
    if (u.kind === 'PACKAGE') {
      out.push({ id: u.id, label: g.label, box: g.box, kg: g.grossKg, stackable: g.stackable, maxTopKg: g.maxTopKg, maxStackLayers: g.maxStackLayers, stackKey: g.stackKey, role: 'box' })
      continue
    }
    const p = doc.pallets[u.palletKey]
    const parts = palletParts(p, u)
    const baseId = `${u.id}#base`
    parts.forEach((part, k) => {
      if (part.packId == null) {
        out.push({
          id: baseId, label: g.label, box: part.box, kg: g.grossKg, stackable: stackable(p.stackable), maxTopKg: p.maxTopKg, group: u.id, groupLabel: g.label,
          role: 'pallet-base', palletStackable: stackable(p.stackable),
        })
      } else {
        const pack = p.packs[part.packId]
        out.push({
          id: `${u.id}#${k}`,
          label: `${g.label} › ${pack.sku}`,
          box: part.box,
          kg: 0,
          stackable: stackable(pack.stackable),
          maxTopKg: pack.maxStackKg,
          group: u.id,
          groupLabel: g.label,
          checkSupport: false,
          transferTo: baseId,
          role: 'pallet-item',
          palletStackable: stackable(p.stackable),
          stackKey: `K:${pack.sku}`,
        })
      }
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Validação da carga
// ---------------------------------------------------------------------------

/** Rodoviário: cargas por conjunto de eixos (só o que está dentro do equipamento). Null sem combinação definida. */
export function roadAxles(doc: LoadDoc, allGeoms = loadGeometries(doc)): AxleResult | null {
  if (!doc.road || !roadMatchesSpace(doc)) return null
  const masses = allGeoms.filter((g) => !isOutsideSpace(doc, g.box)).map((g) => ({ kg: g.grossKg, x: g.cg.x }))
  // comprimento do caminhão informado na carga: o implemento acompanha (eixos traseiros do semirreboque)
  return axleLoads(doc, { ...doc.road, carrier: effectiveCarrier(doc, doc.road.carrier) }, masses)
}

/** A combinação rodoviária corresponde ao equipamento (mesmo veículo; chassi só com contêiner)? */
export function roadMatchesSpace(doc: LoadDoc): boolean {
  const r = doc.road
  if (!r) return true
  if (doc.space.kind === 'VEHICLE') return r.carrier.kind !== 'CHASSIS' && r.carrier.id === doc.space.typeId
  return r.carrier.kind === 'CHASSIS' && doc.space.transport !== 'AIR'
}

export function validateLoad(doc: LoadDoc): { issues: Issue[]; summary: LoadSummary } {
  const issues: Issue[] = []
  const S = doc.space
  const allGeoms = loadGeometries(doc)
  const summary = loadSummary(doc, allGeoms)
  // zona de trabalho: fora do equipamento = pendente de ubicação (um alerta só; não entra nas demais verificações)
  const staged = allGeoms.filter((g) => isOutsideSpace(doc, g.box))
  const geoms = staged.length ? allGeoms.filter((g) => !staged.includes(g)) : allGeoms
  const L = summary.limits
  const th = L.thresholds

  doc.units.forEach((u, i) => {
    if (!geoms.find((g) => g.unit.id === u.id)) {
      issues.push({ code: 'MISSING_REFERENCE', severity: 'CRITICAL', message: `${unitLabel(u, i, doc)} sem referência de palete/embalagem.`, refs: [u.id] })
    }
  })
  if (staged.length)
    issues.push({
      code: 'OUTSIDE_LOAD',
      severity: 'CRITICAL',
      message: `${staged.length} unidade(s) fora da carga, pendente(s) de ubicação (${staged.map((g) => g.label).join(', ')}): reposicione dentro do equipamento ou retire antes de enviar para revisão/aprovar.`,
      refs: staged.map((g) => g.unit.id),
    })
  if (geoms.length === 0) issues.push({ code: 'EMPTY', severity: 'INFO', message: 'Carga vazia.', refs: [] })
  const axles = roadAxles(doc, allGeoms)
  if (axles && doc.road) issues.push(...axleIssues(doc.road, axles))
  else if (doc.road)
    issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: `Carga por eixo desatualizada: a combinação (${doc.road.carrier.code}) não corresponde ao equipamento ${doc.space.code}. Recalcule no painel “Carga por eixo”.`, refs: [] })

  const hi = { x: S.inner.l, y: S.inner.w, z: S.inner.h }
  const lo = { x: 0, y: 0, z: 0 }
  for (const g of geoms) {
    if (!within(g.box, lo, hi)) {
      const M = maxCorner(g.box)
      const parts: string[] = []
      if (g.box.min.x < 0 || M.x > hi.x) parts.push('comprimento')
      if (g.box.min.y < 0 || M.y > hi.y) parts.push('largura/paredes')
      if (g.box.min.z < 0) parts.push('abaixo do piso')
      if (M.z > hi.z) parts.push('teto')
      issues.push({ code: 'OUT_OF_BOUNDS', severity: 'CRITICAL', message: `${g.label} fora do espaço interno (${parts.join(', ')}).`, refs: [g.unit.id] })
    }
    // Porta: seção transversal (largura × altura) do volume como está orientado
    const w = g.box.size.y, h = g.box.size.z
    if (w > S.door.w || h > S.door.h) {
      const rotFits = g.box.size.x <= S.door.w && h <= S.door.h
      issues.push({
        code: 'DOOR_FIT',
        severity: 'CRITICAL',
        message:
          `${g.label} não passa pela porta: ${fmt.mm(w)} × ${fmt.mm(h)} vs porta ${fmt.mm(S.door.w)} × ${fmt.mm(S.door.h)}.` +
          (rotFits ? ' Passaria girado 90° (verifique se é possível manobrar dentro).' : ''),
        refs: [g.unit.id],
      })
    }
    const top = maxCorner(g.box).z
    // envio sem equipamento (paletes): a altura máxima definida na criação é o limite (não há parede)
    if (S.kind === 'NONE' && S.service !== 'COURIER' && top > S.inner.h + 1) {
      issues.push({
        code: 'HEIGHT_LIMIT',
        severity: 'CRITICAL',
        message: `${g.label} com ${fmt.mm(top)} de altura excede a altura máxima do palete carregado definida para o envio (${fmt.mm(S.inner.h)}).`,
        refs: [g.unit.id],
      })
    } else if (L.heightMm.value != null && L.heightMm.value < S.inner.h && top > L.heightMm.value) {
      issues.push({
        code: 'HEIGHT_LIMIT',
        severity: 'CRITICAL',
        message: `${g.label} com topo a ${fmt.mm(top)} excede a altura máxima ${fmt.mm(L.heightMm.value)} (${L.heightMm.source}).`,
        refs: [g.unit.id],
      })
    }
    if (g.unit.kind === 'PACKAGE') {
      const pack = doc.packs[g.unit.packId]
      if (!pack.allowedOrientations.includes(g.unit.orientation)) {
        issues.push({ code: 'ORIENTATION', severity: 'CRITICAL', message: `${g.label} em orientação não permitida (${g.unit.orientation}).`, refs: [g.unit.id] })
      }
    }
  }

  issues.push(...physicalChecks(loadBodies(doc, geoms), { floorZ: 0, collisionTolMm: th.collisionTolMm, minSupportPct: th.minSupportPct }).issues)

  // Pesos
  if (L.payloadKg.value != null && summary.payloadKg > L.payloadKg.value + 1e-6) {
    issues.push({
      code: 'PAYLOAD_EXCEEDED',
      severity: 'CRITICAL',
      message: `Payload ${fmt.kg(summary.payloadKg)} excede o limite efetivo ${fmt.kg(L.payloadKg.value)} (${L.payloadKg.source}).`,
      refs: [],
      value: summary.payloadKg,
      limit: L.payloadKg.value,
    })
  }
  if (L.grossKg.value != null && summary.grossKg > L.grossKg.value + 1e-6) {
    issues.push({
      code: 'GROSS_EXCEEDED',
      severity: 'CRITICAL',
      message: `Peso bruto total ${fmt.kg(summary.grossKg)} excede ${fmt.kg(L.grossKg.value)} (${L.grossKg.source}).`,
      refs: [],
      value: summary.grossKg,
      limit: L.grossKg.value,
    })
  }
  if (L.payloadKg.value == null) {
    issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: 'Nenhum limite de payload informado para o equipamento/perfis.', refs: [] })
  }

  // Balanceamento
  if (summary.cg && summary.cgLongDevPct != null && Math.abs(summary.cgLongDevPct) > th.cgLongTolPct) {
    issues.push({
      code: 'CG_LONGITUDINAL',
      severity: 'WARNING',
      message: `Centro de massa deslocado ${fmt.pct(Math.abs(summary.cgLongDevPct))} do centro ${summary.cgLongDevPct > 0 ? 'para a porta (sul)' : 'para o motorista (norte)'} (tolerância ${fmt.pct(th.cgLongTolPct)}).`,
      refs: [],
      value: summary.cgLongDevPct,
      limit: th.cgLongTolPct,
    })
  }
  if (summary.cg && summary.cgLatDevPct != null && Math.abs(summary.cgLatDevPct) > th.cgLatTolPct) {
    issues.push({
      code: 'CG_LATERAL',
      severity: 'WARNING',
      message: `Desbalanceamento lateral de ${fmt.pct(Math.abs(summary.cgLatDevPct))} para o ${summary.cgLatDevPct > 0 ? 'leste (direita, olhando para o motorista)' : 'oeste (esquerda, olhando para o motorista)'} (tolerância ${fmt.pct(th.cgLatTolPct)}).`,
      refs: [],
      value: summary.cgLatDevPct,
      limit: th.cgLatTolPct,
    })
  }
  // Acompanhantes obrigatórios (ex.: 1 kit por Hydroforce)
  // regra: o acompanhante viaja sempre por cima do palete que contém o produto principal
  for (const c of companionStatus(doc)) {
    if (c.missing)
      issues.push({
        code: 'COMPANION_MISSING',
        severity: 'WARNING',
        message:
          `Faltam ${c.missing} ${c.sku} nos paletes de ${c.for.join(', ')} (${c.required} exigido(s), ${c.present} no lugar)` +
          (c.looseParents ? `; ${c.looseParents} caixa(s) do produto principal estão soltas — o ${c.sku} só pode ir por cima de um palete com o produto.` : '.'),
        refs: [],
        value: c.present,
        limit: c.required,
      })
    if (c.misplaced)
      issues.push({
        code: 'COMPANION_MISPLACED',
        severity: 'WARNING',
        message: `${c.misplaced} ${c.sku} fora do lugar (solto(s) ou em palete sem ${c.for.join(', ') || 'o produto principal'}): deve ir por cima do palete do produto principal.`,
        refs: [],
        value: c.misplaced,
      })
  }
  // Distribuição frente × trás: o mais uniforme possível, com 1–2 p.p. a mais na metade traseira
  // (sobre os eixos traseiros); nunca mais peso na frente. Critério operacional — não é limite legal.
  if (summary.grossKg > 0) {
    const qs = quadrantShares(doc)
    const R = DEFAULT_QUADRANT_RULES
    if (qs.totalKg > 0 && qs.southPct < R.rearMinPct - 1e-9) {
      issues.push({
        code: 'WEIGHT_FRONT',
        severity: 'WARNING',
        message: `Mais peso na metade da FRENTE (motorista): ${fmt.pct(qs.northPct)} na frente × ${fmt.pct(qs.southPct)} atrás. Recomendado: metade traseira ${fmt.pct(R.rearIdealMinPct)}–${fmt.pct(R.rearMaxPct)}. Use “Distribuir peso”.`,
        refs: [],
        value: qs.southPct,
        limit: R.rearMinPct,
      })
    } else if (qs.totalKg > 0 && qs.southPct > R.rearWarnPct + 1e-9) {
      issues.push({
        code: 'QUADRANT_SOUTH',
        severity: 'WARNING',
        message: `Peso concentrado na metade TRASEIRA (porta): ${fmt.pct(qs.southPct)} atrás × ${fmt.pct(qs.northPct)} na frente. Recomendado: no máximo ${fmt.pct(R.rearMaxPct)} atrás. Use “Distribuir peso”.`,
        refs: [],
        value: qs.southPct,
        limit: R.rearMaxPct,
      })
    }
  }
  if (S.floorLoadKgPerM != null) {
    for (const b of summary.longitudinal) {
      const perM = b.kg / ((b.toMm - b.fromMm) / 1000)
      if (perM > S.floorLoadKgPerM) {
        issues.push({
          code: 'FLOOR_LOAD',
          severity: 'WARNING',
          message: `Concentração de ${fmt.kg(perM)}/m entre ${fmt.mm(b.fromMm)} e ${fmt.mm(b.toMm)} (máx. ${fmt.kg(S.floorLoadKgPerM)}/m).`,
          refs: [],
          value: perM,
          limit: S.floorLoadKgPerM,
        })
      }
    }
  }
  if (geoms.length > 0 && summary.volumeUtilPct < th.lowUtilPct) {
    issues.push({ code: 'LOW_UTILIZATION', severity: 'INFO', message: `Ocupação de volume baixa: ${fmt.pct(summary.volumeUtilPct)}.`, refs: [], value: summary.volumeUtilPct, limit: th.lowUtilPct })
  }

  // Paletes usados (validação interna de cada montagem)
  const usedPallets = new Set(doc.units.filter((u) => u.kind === 'PALLET').map((u) => (u as { palletKey: string }).palletKey))
  for (const key of usedPallets) {
    const p = doc.pallets[key]
    if (!p) continue
    const refs = doc.units.filter((u) => u.kind === 'PALLET' && u.palletKey === key).map((u) => u.id)
    for (const iss of validatePallet(p, th, `Montagem "${p.name}": `)) {
      if (iss.code === 'EMPTY') continue
      issues.push({ ...iss, refs })
    }
  }
  // Pacotes soltos e equipamento com dados não verificados
  if (S.verification !== 'VERIFIED') {
    issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: `Equipamento ${S.code} com dados ${verLabel(S.verification)} — confirmar com a naviera/transportador.`, refs: [] })
  }
  const loosePacks = new Set(doc.units.filter((u) => u.kind === 'PACKAGE').map((u) => (u as { packId: string }).packId))
  for (const k of loosePacks) {
    const pack = doc.packs[k]
    if (pack && pack.netKg <= 0) {
      issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: `Embalagem ${pack.sku} v${pack.version} sem peso líquido do produto — peso bruto = só a tara da embalagem.`, refs: [] })
    }
    if (pack && pack.verification !== 'VERIFIED') {
      issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: `Embalagem ${pack.sku} v${pack.version} com dados ${verLabel(pack.verification)}.`, refs: [] })
    }
  }
  // envio SEM equipamento (piso virtual): não há paredes, porta, payload, CG nem quadrantes a verificar
  const out = S.kind === 'NONE' ? issues.filter((i) => !NONE_SKIP.has(i.code) && !(i.code === 'UNVERIFIED_DATA' && /payload/.test(i.message))) : issues
  return { issues: dedupe(out), summary }
}

const NONE_SKIP = new Set(['OUTSIDE_LOAD', 'OUT_OF_BOUNDS', 'DOOR_FIT', 'CG_LONGITUDINAL', 'CG_LATERAL', 'WEIGHT_FRONT', 'QUADRANT_SOUTH', 'FLOOR_LOAD', 'LOW_UTILIZATION'])

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>()
  return issues.filter((i) => {
    const k = `${i.code}|${i.message}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

import { Body } from './bodies'
import { physicalChecks } from './checks'
import { AABB, cbm, center, maxCorner, orientDims, unionArea, Vec3, volumeMm3 } from './geometry'
import { fmt, Issue } from './issues'
import { stackable } from './policy'
import { DEFAULT_THRESHOLDS, PackSnapshot, PalletDoc, PalletItem, Thresholds } from './types'

/** AABB do item em coordenadas locais do palete (z a partir do topo do tabuleiro). */
export function itemBox(doc: PalletDoc, item: PalletItem): AABB {
  const pack = doc.packs[item.packId]
  return { min: { ...item.pos }, size: orientDims(pack.dims, item.orientation) }
}

export function itemLabel(doc: PalletDoc, item: PalletItem, idx?: number): string {
  const pack = doc.packs[item.packId]
  return `${pack?.sku ?? '?'}${idx != null ? ` #${idx + 1}` : ''}`
}

/** Limite de carga efetivo do palete = MIN(dinâmica, estática, peso máx. de carga). */
export function palletMaxLoadKg(doc: PalletDoc): number | null {
  const t = doc.palletType
  const vals = [t.dynamicMaxKg, t.staticMaxKg, t.maxLoadKg].filter((v): v is number => v != null && v > 0)
  return vals.length ? Math.min(...vals) : null
}

/**
 * Envelope do palete montado em coordenadas locais (origem = canto da base do palete, z=0 no chão).
 * Inclui overhang: pode começar em x/y negativos.
 */
export function palletEnvelope(doc: PalletDoc): AABB {
  const P = doc.palletType.dims
  let x0 = 0, y0 = 0, x1 = P.l, y1 = P.w, z1 = P.h
  for (const it of doc.items) {
    const b = itemBox(doc, it)
    const M = maxCorner(b)
    x0 = Math.min(x0, b.min.x)
    y0 = Math.min(y0, b.min.y)
    x1 = Math.max(x1, M.x)
    y1 = Math.max(y1, M.y)
    z1 = Math.max(z1, P.h + M.z)
  }
  return { min: { x: x0, y: y0, z: 0 }, size: { x: x1 - x0, y: y1 - y0, z: z1 } }
}

export interface SkuLine {
  sku: string
  name: string
  packages: number
  units: number
  netKg: number
  grossKg: number
}

function addSku(map: Map<string, SkuLine>, pack: PackSnapshot, count: number) {
  const cur = map.get(pack.sku) ?? { sku: pack.sku, name: pack.name, packages: 0, units: 0, netKg: 0, grossKg: 0 }
  cur.packages += count
  cur.units += count * pack.unitsPerPackage
  cur.netKg += count * pack.netKg
  cur.grossKg += count * pack.grossKg
  map.set(pack.sku, cur)
}

export interface PalletSummary {
  packages: number
  units: number
  netKg: number
  /** Soma do bruto dos volumes (produto + embalagem). */
  productsGrossKg: number
  tareKg: number
  accessoriesKg: number
  /** gross_pallet = produtos + embalagens + palete + acessórios */
  grossKg: number
  totalHeightMm: number
  envelope: AABB
  cbmEnvelope: number
  cbmPackages: number
  /** % da área do palete coberta pela 1ª camada */
  surfaceUtilPct: number
  /** volume dos volumes / (área do palete × altura da carga): mede vazios */
  volumeUtilPct: number | null
  maxLoadKg: number | null
  capacityPct: number | null
  /** Centro de massa local (origem da base do palete) */
  cg: Vec3
  bySku: SkuLine[]
}

export function palletSummary(doc: PalletDoc): PalletSummary {
  const P = doc.palletType.dims
  const sku = new Map<string, SkuLine>()
  let net = 0, gross = 0, vol = 0
  let mx = 0, my = 0, mz = 0
  const bottom: { x0: number; y0: number; x1: number; y1: number }[] = []
  for (const it of doc.items) {
    const pack = doc.packs[it.packId]
    if (!pack) continue
    const b = itemBox(doc, it)
    net += pack.netKg
    gross += pack.grossKg
    vol += volumeMm3(b.size)
    const c = center(b)
    mx += c.x * pack.grossKg
    my += c.y * pack.grossKg
    mz += (c.z + P.h) * pack.grossKg
    addSku(sku, pack, 1)
    if (b.min.z === 0) {
      const M = maxCorner(b)
      bottom.push({ x0: Math.max(0, b.min.x), y0: Math.max(0, b.min.y), x1: Math.min(P.l, M.x), y1: Math.min(P.w, M.y) })
    }
  }
  const tare = doc.palletType.tareKg
  const acc = doc.accessoriesKg ?? 0
  const total = gross + tare + acc
  // tara e acessórios no centro do palete
  mx += (P.l / 2) * (tare + acc)
  my += (P.w / 2) * (tare + acc)
  mz += (P.h / 2) * tare + P.h * acc
  const maxLoad = palletMaxLoadKg(doc)
  const env = palletEnvelope(doc)
  // altura máxima não é do palete: é definida pelo equipamento (contêiner/caminhão) na carga
  const loadH = env.size.z - P.h
  const lineCount = [...sku.values()]
  return {
    packages: doc.items.length,
    units: lineCount.reduce((s, l) => s + l.units, 0),
    netKg: net,
    productsGrossKg: gross,
    tareKg: tare,
    accessoriesKg: acc,
    grossKg: total,
    totalHeightMm: env.size.z,
    envelope: env,
    cbmEnvelope: cbm(env.size),
    cbmPackages: vol / 1e9,
    surfaceUtilPct: (unionArea(bottom) / (P.l * P.w)) * 100,
    volumeUtilPct: loadH > 0 ? (vol / (P.l * P.w * loadH)) * 100 : null,
    maxLoadKg: maxLoad,
    capacityPct: maxLoad ? ((gross + acc) / maxLoad) * 100 : null,
    cg: total > 0 ? { x: mx / total, y: my / total, z: mz / total } : { x: P.l / 2, y: P.w / 2, z: 0 },
    bySku: lineCount.sort((a, b) => a.sku.localeCompare(b.sku)),
  }
}

export function palletBodies(doc: PalletDoc): Body[] {
  return doc.items.map((it, i) => {
    const pack = doc.packs[it.packId]
    return {
      id: it.id,
      label: itemLabel(doc, it, i),
      box: itemBox(doc, it),
      kg: pack?.grossKg ?? 0,
      stackable: stackable(pack?.stackable),
      maxTopKg: pack?.maxStackKg ?? null,
      maxStackLayers: pack?.maxStackLayers ?? null,
      stackKey: pack?.sku,
    }
  })
}

export function validatePallet(doc: PalletDoc, thresholds: Thresholds = DEFAULT_THRESHOLDS, prefix = ''): Issue[] {
  const p = prefix
  const issues: Issue[] = []
  const t = doc.palletType
  const P = t.dims

  for (const it of doc.items) {
    if (!doc.packs[it.packId]) {
      issues.push({ code: 'MISSING_REFERENCE', severity: 'CRITICAL', message: `${p}Item sem embalagem de referência.`, refs: [it.id] })
    }
  }
  const valid = doc.items.filter((it) => doc.packs[it.packId])
  const vdoc = { ...doc, items: valid }
  if (valid.length === 0) {
    issues.push({ code: 'EMPTY', severity: 'INFO', message: `${p}Palete vazio.`, refs: [] })
  }

  // Orientação
  valid.forEach((it, i) => {
    const pack = doc.packs[it.packId]
    if (!pack.allowedOrientations.includes(it.orientation)) {
      issues.push({
        code: 'ORIENTATION',
        severity: 'CRITICAL',
        message: `${p}${itemLabel(doc, it, i)} em orientação não permitida (${it.orientation}).`,
        refs: [it.id],
      })
    }
  })

  // Overhang e piso do palete
  const oh = t.overhangAllowed ? t.overhangMaxMm : 0
  valid.forEach((it, i) => {
    const b = itemBox(doc, it)
    const M = maxCorner(b)
    if (b.min.z < 0) {
      issues.push({ code: 'OUT_OF_BOUNDS', severity: 'CRITICAL', message: `${p}${itemLabel(doc, it, i)} abaixo do tabuleiro do palete.`, refs: [it.id] })
    }
    const over = Math.max(-b.min.x, -b.min.y, M.x - P.l, M.y - P.w, 0)
    if (over > oh) {
      issues.push({
        code: 'OVERHANG',
        severity: 'CRITICAL',
        message: t.overhangAllowed
          ? `${p}${itemLabel(doc, it, i)} excede o palete em ${fmt.mm(over)} (máx. ${fmt.mm(oh)}).`
          : `${p}${itemLabel(doc, it, i)} excede o palete em ${fmt.mm(over)} (overhang não permitido).`,
        refs: [it.id],
        value: over,
        limit: oh,
      })
    } else if (over > 0) {
      issues.push({ code: 'OVERHANG', severity: 'INFO', message: `${p}${itemLabel(doc, it, i)} com overhang de ${fmt.mm(over)} (dentro do permitido).`, refs: [it.id], value: over, limit: oh })
    }
  })

  // Físico: colisões, apoio, empilhamento
  issues.push(
    ...physicalChecks(palletBodies(vdoc), {
      floorZ: 0,
      collisionTolMm: thresholds.collisionTolMm,
      minSupportPct: thresholds.minSupportPct,
      prefix: p,
    }).issues,
  )

  // Capacidade e altura
  const s = palletSummary(vdoc)
  if (s.maxLoadKg != null && s.productsGrossKg + s.accessoriesKg > s.maxLoadKg + 1e-6) {
    issues.push({
      code: 'PALLET_CAPACITY',
      severity: 'CRITICAL',
      message: `${p}Carga do palete ${fmt.kg(s.productsGrossKg + s.accessoriesKg)} excede a capacidade ${fmt.kg(s.maxLoadKg)} (${t.code}).`,
      refs: [],
      value: s.productsGrossKg + s.accessoriesKg,
      limit: s.maxLoadKg,
    })
  }
  // Qualidade de dados
  if (P.h <= 0 || t.tareKg <= 0) {
    issues.push({
      code: 'UNVERIFIED_DATA',
      severity: 'WARNING',
      message: `${p}Palete ${t.code} sem ${[P.h <= 0 && 'altura', t.tareKg <= 0 && 'tara'].filter(Boolean).join(' e ')} cadastrada — altura/peso calculados ficam subestimados.`,
      refs: [],
    })
  }
  if (palletMaxLoadKg(doc) == null) {
    issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: `${p}Palete ${t.code} sem capacidade de carga cadastrada.`, refs: [] })
  }
  if (t.verification !== 'VERIFIED') {
    issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: `${p}Palete ${t.code} com dados ${verLabel(t.verification)}.`, refs: [] })
  }
  const seen = new Set<string>()
  for (const it of valid) {
    const pack = doc.packs[it.packId]
    if (pack.netKg <= 0 && !seen.has(`net:${it.packId}`)) {
      seen.add(`net:${it.packId}`)
      issues.push({ code: 'UNVERIFIED_DATA', severity: 'WARNING', message: `${p}Embalagem ${pack.sku} v${pack.version} sem peso líquido do produto — peso bruto = só a tara da embalagem.`, refs: [] })
    }
    if (pack.verification !== 'VERIFIED' && !seen.has(it.packId)) {
      seen.add(it.packId)
      issues.push({
        code: 'UNVERIFIED_DATA',
        severity: 'WARNING',
        message: `${p}Embalagem ${pack.sku} v${pack.version} com dados ${verLabel(pack.verification)}.`,
        refs: [],
      })
    }
  }
  return issues
}

export function verLabel(v: string) {
  return v === 'ESTIMATED' ? 'estimados' : v === 'UNVERIFIED' ? 'não verificados' : 'verificados'
}

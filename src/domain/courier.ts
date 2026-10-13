/**
 * COURIER / PAQUETERIA (DHL, FedEx, UPS…): sem palete e sem equipamento — cada caixa é um volume.
 * Lista de volumes para o cliente agendar a coleta: medidas, peso real e peso volumétrico por caixa.
 *
 * Peso volumétrico = C × L × A (cm) ÷ divisor. 5000 é o divisor usual do courier expresso
 * internacional; é editável porque varia por transportadora/contrato. O peso taxável e os
 * arredondamentos finais são sempre da transportadora (aqui só estimativa).
 */
import type { KitBoxLine } from './kitBoxes'
import type { OrderLine } from './mixedPallets'
import type { PackShape } from './packShape'

export const COURIER_DIVISOR_DEFAULT = 5000

export interface CourierRow {
  sku: string
  /** nome do produto (sem o tipo de caixa: cada saída o escreve no seu idioma) */
  name: string
  /** caixa coletiva de kits (ex.: caixa 79583 com 26 kits): pdfText(lang).kitBox / kitBoxLabel */
  kitBox?: Pick<KitBoxLine, 'kind' | 'code' | 'kits'>
  /** nº de caixas (= volumes) deste produto */
  boxes: number
  units: number
  /** medidas de UMA caixa (mm) */
  dimsMm: { l: number; w: number; h: number }
  grossKgEach: number
  volKgEach: number
  grossKg: number
  volKg: number
  cbm: number
}

export interface CourierPlan {
  rows: CourierRow[]
  divisor: number
  totals: { pieces: number; units: number; grossKg: number; volKg: number; cbm: number; chargeableKg: number }
}

/** Peso volumétrico de uma caixa (medidas em mm). */
export function volumetricKg(d: { l: number; w: number; h: number }, divisor = COURIER_DIVISOR_DEFAULT): number {
  return (d.l / 10) * (d.w / 10) * (d.h / 10) / divisor
}

export function courierPlan(order: OrderLine[], divisor = COURIER_DIVISOR_DEFAULT): CourierPlan {
  const div = divisor > 0 ? divisor : COURIER_DIVISOR_DEFAULT
  const rows: CourierRow[] = order
    .filter((o) => o.boxes > 0)
    .map((o) => {
      const d = o.pack.dims
      const volEach = volumetricKg(d, div)
      return {
        sku: o.pack.sku,
        name: o.pack.name,
        // caixa coletiva de kits: o tipo da caixa vai junto (texto no idioma de cada saída)
        ...(o.pack.kitBox ? { kitBox: { kind: o.pack.kitBox.kind, code: o.pack.kitBox.code, kits: o.pack.kitBox.kits } } : {}),
        boxes: o.boxes,
        units: o.boxes * o.pack.unitsPerPackage,
        dimsMm: { l: d.l, w: d.w, h: d.h },
        grossKgEach: o.pack.grossKg,
        volKgEach: volEach,
        grossKg: o.pack.grossKg * o.boxes,
        volKg: volEach * o.boxes,
        cbm: ((d.l * d.w * d.h) / 1e9) * o.boxes,
      }
    })
  const sum = (f: (r: CourierRow) => number) => rows.reduce((t, r) => t + f(r), 0)
  // estimativa: por volume vale o maior entre real e volumétrico (regra geral do courier expresso)
  const chargeableKg = rows.reduce((t, r) => t + Math.max(r.grossKgEach, r.volKgEach) * r.boxes, 0)
  return {
    rows,
    divisor: div,
    totals: { pieces: sum((r) => r.boxes), units: sum((r) => r.units), grossKg: sum((r) => r.grossKg), volKg: sum((r) => r.volKg), cbm: sum((r) => r.cbm), chargeableKg },
  }
}

// ---------------------------------------------------------------------------
// Acomodo para visualização (3D na tela e imagens no PDF)
// ---------------------------------------------------------------------------

export interface CourierBox {
  /** nº do volume (1..N), igual à lista do PDF */
  n: number
  sku: string
  name: string
  color: string
  /** formato do volume para o 3D (lona/filme em rolo); ausente = caixa comum — ver domain/packShape */
  shape?: PackShape
  min: { x: number; y: number; z: number }
  size: { x: number; y: number; z: number }
}

export interface CourierLayout {
  boxes: CourierBox[]
  /** envelope do conjunto (mm) */
  size: { x: number; y: number; z: number }
  /** volumes não desenhados (acima do limite de desenho) */
  hidden: number
}

const GAP = 80

/**
 * Volumes no chão para a coleta: lado a lado (stack=false) ou em pilhas do MESMO produto até
 * `maxStackMm` de altura (respeita o máx. de camadas da embalagem). Colunas em fileiras (prateleiras)
 * para um conjunto aproximadamente quadrado. Só visualização: a transportadora decide como carrega.
 */
export function courierLayout(order: OrderLine[], o: { stack?: boolean; maxStackMm?: number; maxBoxes?: number } = {}): CourierLayout {
  const maxBoxes = o.maxBoxes ?? 300
  const maxH = o.maxStackMm ?? 1500
  // colunas: [pack, nº de caixas na coluna]
  const cols: { pack: OrderLine['pack']; count: number; first: number }[] = []
  let n = 0
  let hidden = 0
  for (const line of order) {
    const d = line.pack.dims
    let left = line.boxes
    const per = o.stack && line.pack.stackable !== false ? Math.max(1, Math.min(Math.floor(maxH / Math.max(1, d.h)), line.pack.maxStackLayers ?? Infinity)) : 1
    while (left > 0) {
      const c = Math.min(per, left)
      if (n + c > maxBoxes) {
        hidden += left
        break
      }
      cols.push({ pack: line.pack, count: c, first: n + 1 })
      n += c
      left -= c
    }
  }
  // fileiras: largura alvo ≈ raiz da área total (conjunto quase quadrado), nunca menor que a maior caixa
  const area = cols.reduce((t, c) => t + (c.pack.dims.l + GAP) * (c.pack.dims.w + GAP), 0)
  // poucas caixas: uma fileira só até 2,4 m (fica mais claro "lado a lado")
  const rowMax = Math.max(Math.sqrt(area) * 1.15, 2400, ...cols.map((c) => c.pack.dims.l))
  const boxes: CourierBox[] = []
  let x = 0, y = 0, rowDepth = 0, maxX = 0, maxZ = 0
  for (const c of cols) {
    const d = c.pack.dims
    if (x > 0 && x + d.l > rowMax) {
      x = 0
      y += rowDepth + GAP
      rowDepth = 0
    }
    for (let k = 0; k < c.count; k++) {
      boxes.push({ n: c.first + k, sku: c.pack.sku, name: c.pack.name, color: c.pack.color, ...(c.pack.shape ? { shape: c.pack.shape } : {}), min: { x, y, z: k * d.h }, size: { x: d.l, y: d.w, z: d.h } })
    }
    maxZ = Math.max(maxZ, c.count * d.h)
    maxX = Math.max(maxX, x + d.l)
    rowDepth = Math.max(rowDepth, d.w)
    x += d.l + GAP
  }
  return { boxes, size: { x: Math.max(1, maxX), y: Math.max(1, y + rowDepth), z: Math.max(1, maxZ) }, hidden }
}

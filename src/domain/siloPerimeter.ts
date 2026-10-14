/**
 * PESO LÍQUIDO DO SILO-BOLSA PELO PERÍMETRO REAL (definido com o Matías em 14/10/2026).
 *
 * A Pacifil fabrica o silo-bolsa com um perímetro REAL um pouco maior que o matemático (π × diâmetro), por causa
 * do uso no campo: 6 pés = 5,75 m, 9 pés = 8,70 m, 10 pés = 9,65 m. O perímetro real é cadastrado por diâmetro na
 * família Silo-bolsa ("Editar família"); o peso líquido de TODOS os silo-bolsas desse diâmetro (todas as marcas) é
 *
 *     perímetro real (m) × comprimento (m) × espessura (µm) × 10⁻⁶ × 932 kg/m³
 *
 * com a densidade do polietileno que a Pacifil usa em todos os produtos: 0,932 g/cm³. Diâmetro sem perímetro real
 * cadastrado → vale o peso da planilha da fábrica. Sem dependências: a tela, o servidor e a importação usam daqui.
 */

/** densidade do polietileno (kg/m³) — 0,932 g/cm³, a mesma para todos os produtos Pacifil */
export const PE_DENSITY_KG_M3 = 932

const FT_M = 0.3048

export interface SiloPerimeter {
  diameterFt: number
  perimeterM: number
}

/** chave do diâmetro com 2 casas (o banco guarda numeric(6,2)): 11.5 → "11.50" */
export const diameterKey = (dFt: number) => dFt.toFixed(2)

/** perímetro matemático π × diâmetro (m) */
export const theoreticalPerimeterM = (dFt: number) => Math.PI * dFt * FT_M

/** perímetro com as 3 casas do banco (numeric(8,3)): o cálculo usa o valor gravado — a prévia da tela também */
export const roundPerimeterM = (x: number) => Math.round(x * 1000) / 1000

/** faixa aceita para o perímetro real em relação ao matemático (π × diâmetro): pega erro de digitação (87 em vez de 8,70) */
export const PERIMETER_FACTOR_RANGE = { min: 0.95, max: 1.2 } as const

const fmt = (x: number, min = 0, max = 3) => x.toLocaleString('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max })

/**
 * problema de uma linha da tabela (diâmetro em pés, perímetro em m), ou null se estiver ok — a MESMA validação no
 * servidor e na tela (que valida o perímetro já arredondado com roundPerimeterM, como o servidor grava)
 */
export function perimeterRowError(diameterFt: number, perimeterM: number): string | null {
  if (!(Number.isFinite(diameterFt) && diameterFt > 0 && diameterFt <= 100)) return 'Diâmetro em pés maior que zero (ex.: 9 ou 11,5)'
  if (!(Number.isFinite(perimeterM) && perimeterM > 0)) return 'Perímetro em metros maior que zero (ex.: 8,70)'
  const t = theoreticalPerimeterM(diameterFt)
  if (perimeterM < t * PERIMETER_FACTOR_RANGE.min || perimeterM > t * PERIMETER_FACTOR_RANGE.max)
    return `Fora do esperado para ${fmt(diameterFt, 0, 2)} pés (π × diâmetro = ${fmt(t, 2, 2)} m)`
  return null
}

/** perímetro real cadastrado para o diâmetro (tolerância de 0,01 pé), ou null */
export function perimeterFor(table: readonly SiloPerimeter[], dFt: number | null | undefined): number | null {
  if (dFt == null || !Number.isFinite(dFt)) return null
  const hit = table.find((r) => Math.abs(r.diameterFt - dFt) < 0.01)
  return hit && hit.perimeterM > 0 ? hit.perimeterM : null
}

/** comprimento para o cálculo: em metros; o silo-bolsa vendido em pés usa pés × 0,3048 */
export function calcLengthM(v: { lengthM: number | null | undefined; lengthFt?: number | null | undefined }): number | null {
  if (v.lengthM != null && v.lengthM > 0) return v.lengthM
  if (v.lengthFt != null && v.lengthFt > 0) return v.lengthFt * FT_M
  return null
}

const r2 = (x: number) => Math.round(x * 100) / 100

/** peso líquido calculado (kg, 2 casas — como a planilha da fábrica); null se faltar algum dado */
export function siloBagNetKg(o: { perimeterM: number | null; lengthM: number | null; thicknessUm: number | null | undefined }): number | null {
  if (!o.perimeterM || !o.lengthM || !o.thicknessUm || o.perimeterM <= 0 || o.lengthM <= 0 || o.thicknessUm <= 0) return null
  return r2(o.perimeterM * o.lengthM * o.thicknessUm * 1e-6 * PE_DENSITY_KG_M3)
}

/** texto da fórmula para observações e dicas: "8,70 m × 60 m × 240 µm × 0,932 g/cm³" */
export function siloBagFormulaText(o: { perimeterM: number; lengthM: number; thicknessUm: number }): string {
  const n = (x: number, min = 0, max = 3) => x.toLocaleString('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max })
  return `${n(o.perimeterM, 2)} m × ${n(o.lengthM, 0, 2)} m × ${o.thicknessUm} µm × ${n(PE_DENSITY_KG_M3 / 1000, 3)} g/cm³`
}

/**
 * o peso cadastrado é o calculado? Igual nas 3 casas do banco (numeric(12,3)) — a MESMA definição do recálculo
 * (decideRecalc → 'same'), do selo da tabela e do formulário: 116,763 com cálculo 116,76 NÃO é o calculado
 */
export const isCalculatedNet = (netKg: number | null | undefined, calc: number | null) => netKg != null && calc != null && Math.abs(netKg - calc) < 0.0005

// ---------------------------------------------------------------- recálculo (regra única: servidor e prévia da tela)
const r3 = (x: number) => Math.round(x * 1000) / 1000
const kgTxt = (x: number) => `${fmt(x, 2, 3)} kg`

/**
 * Embalagem que o recálculo não altera — regra e texto ÚNICOS (recálculo no servidor, prévia e selo "≠ cálculo" da
 * tela): várias unidades por caixa, sem peso c/ embalagem, sem peso líquido (sem a tara não dá para manter o
 * c/ embalagem) ou c/ embalagem menor que o líquido. null = pode recalcular.
 */
export function packRecalcBlocker(pack: { unitsPerPackage: number; netKg: number; grossKg: number | null }): string | null {
  if (pack.unitsPerPackage > 1) return `Embalagem com ${pack.unitsPerPackage} unidades por caixa — confira o peso manualmente.`
  if (pack.grossKg == null || !(pack.grossKg > 0)) return 'Peso c/ embalagem não cadastrado — sem a tara da caixa não dá para recalcular.'
  if (!(pack.netKg > 0)) return 'Peso líquido não cadastrado — sem a tara da caixa (c/ embalagem − líquido) não dá para recalcular; corrija a embalagem no produto.'
  if (pack.grossKg < pack.netKg) return `Peso c/ embalagem (${kgTxt(pack.grossKg)}) menor que o líquido (${kgTxt(pack.netKg)}) — corrija a embalagem.`
  return null
}

/** dados do produto usados no recálculo */
export interface RecalcVariant {
  sku: string
  name: string
  diameterFt: number | null
  lengthM: number | null
  lengthFt: number | null
  thicknessUm: number | null
}

/** embalagem vigente (só o que o recálculo usa) */
export interface RecalcPack {
  version: number
  netKg: number
  grossKg: number | null
  unitsPerPackage: number
}

/** o que fazer com um produto no recálculo */
export type RecalcDecision =
  /** diâmetro sem perímetro real: vale o peso da planilha da fábrica (não mexe nem lista) */
  | { kind: 'none' }
  | { kind: 'skip'; perimeterM: number; reason: string }
  | { kind: 'same'; perimeterM: number }
  | { kind: 'change'; perimeterM: number; lengthM: number; thicknessUm: number; netKg: number; grossKg: number }

/** decisão pura do recálculo de um produto (sem banco) — ver applySiloBagPerimeters */
export function decideRecalc(table: readonly SiloPerimeter[], v: RecalcVariant, pack: RecalcPack | null): RecalcDecision {
  const perimeterM = perimeterFor(table, v.diameterFt)
  if (perimeterM == null) return { kind: 'none' }
  if (!pack) return { kind: 'skip', perimeterM, reason: 'Sem embalagem cadastrada — cadastre a caixa para gravar o peso calculado.' }
  const lengthM = calcLengthM(v)
  const calc = siloBagNetKg({ perimeterM, lengthM, thicknessUm: v.thicknessUm })
  if (calc == null || lengthM == null || v.thicknessUm == null) {
    const missing = [!(v.thicknessUm != null && v.thicknessUm > 0) && 'a espessura (µm)', lengthM == null && 'o comprimento (m ou pés)'].filter(Boolean).join(' e ')
    return { kind: 'skip', perimeterM, reason: `Falta ${missing || 'medida'} para calcular o peso.` }
  }
  const blocker = packRecalcBlocker(pack)
  if (blocker) return { kind: 'skip', perimeterM, reason: blocker }
  const gross = pack.grossKg! // packRecalcBlocker garante c/ embalagem > 0
  const tare = gross - pack.netKg
  const grossKg = r3(calc + tare)
  if (isCalculatedNet(pack.netKg, calc) && r3(gross) === grossKg) return { kind: 'same', perimeterM }
  return { kind: 'change', perimeterM, lengthM, thicknessUm: v.thicknessUm, netKg: calc, grossKg }
}

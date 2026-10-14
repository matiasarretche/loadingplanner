/**
 * Pesos (decisão 7): líquido oficial; bruto oficial quando plausível, senão líquido + tara da caixa
 * atribuída. Também o critério de "dados ruins" usado para escolher entre códigos repetidos.
 */
import type { OfficialProduct } from './classify'
import type { ImportDecisions } from './decisions'
import { round } from './parseProduct'

const kg = (x: number) => String(round(x, 3)).replace('.', ',')

/** Tara oficial (bruto − líquido) ou null. */
export function officialTare(p: Pick<OfficialProduct, 'netKg' | 'grossKg'>): number | null {
  return p.netKg != null && p.grossKg != null ? round(p.grossKg - p.netKg, 3) : null
}

/**
 * Motivo para NÃO usar o bruto oficial (null = plausível). Com `boxTareKg`, a tara oficial menor que a
 * tara da caixa atribuída também desqualifica o bruto.
 */
export function grossProblem(p: Pick<OfficialProduct, 'netKg' | 'grossKg' | 'unitsPerPack'>, d: ImportDecisions, boxTareKg?: number | null): string | null {
  const n = p.netKg
  const g = p.grossKg
  if (n == null) return 'sem peso líquido'
  if (g == null) return 'sem peso bruto'
  const tare = round(g - n, 3)
  if (g === 1 && n > 1) return 'peso bruto = 1 (provisório)'
  if (g < n) return `bruto ${kg(g)} kg menor que o líquido ${kg(n)} kg`
  if (g === n) return 'bruto igual ao líquido (tara 0)'
  if (g > d.grossRule.absurdFactor * n && tare > d.grossRule.absurdMinTareKg) return `bruto ${kg(g)} kg absurdo para ${kg(n)} kg de líquido`
  if (!p.unitsPerPack && tare > Math.max(d.grossRule.maxTareKg, d.grossRule.maxTarePct * n)) return `tara ${kg(tare)} kg alta demais para ${kg(n)} kg de líquido`
  if (boxTareKg != null && tare < boxTareKg - d.tareMatchTolKg) return `tara oficial ${kg(tare)} kg menor que a da caixa (${kg(boxTareKg)} kg)`
  return null
}

/** Dados ruins (decisão 10): EAN inválido ou peso inutilizável. Vazio = dados bons. */
export function badDataReasons(p: OfficialProduct, d: ImportDecisions): string[] {
  const out: string[] = []
  if (p.eanStatus === 'INVALID') out.push('EAN inválido')
  if (p.netKg == null || p.netKg <= 0) out.push('sem peso líquido')
  else {
    const g = grossProblem(p, d)
    if (g) out.push(g)
  }
  return out
}

export interface PlannedWeights {
  netKg: number
  grossKg: number
  grossSource: 'OFFICIAL' | 'NET_PLUS_BOX_TARE'
  grossNote: string | null
}

/**
 * Pesos da embalagem planejada, dada a tara da caixa atribuída. Com `calcNetKg` (silo-bolsa pelo perímetro real):
 * grava o líquido calculado e bruto = calculado + a MESMA tara (bruto − líquido) que a regra dá com os pesos da
 * planilha — a escolha do bruto (oficial ou líquido + caixa) continua sendo decidida pela planilha.
 */
export function plannedWeights(p: OfficialProduct, boxTareKg: number, d: ImportDecisions, calcNetKg?: number | null): PlannedWeights {
  const net = round(p.netKg ?? 0, 3)
  const problem = grossProblem(p, d, boxTareKg)
  const official = !problem && p.grossKg != null
  const gross = official ? round(p.grossKg!, 3) : round(net + boxTareKg, 3)
  const unused = p.grossKg != null ? `bruto oficial ${kg(p.grossKg)} kg não usado: ${problem}` : 'planilha sem bruto'
  if (calcNetKg != null) {
    const tare = round(gross - net, 3)
    const calc = round(calcNetKg, 3)
    const calcGross = round(calc + tare, 3)
    return {
      netKg: calc,
      grossKg: calcGross,
      grossSource: official ? 'OFFICIAL' : 'NET_PLUS_BOX_TARE',
      grossNote: official
        ? `bruto = líquido pelo perímetro real + tara oficial (${kg(calc)} + ${kg(tare)} = ${kg(calcGross)} kg; planilha: líquido ${kg(net)} kg, bruto ${kg(gross)} kg)`
        : `bruto = líquido pelo perímetro real + tara da caixa (${kg(calc)} + ${kg(tare)} = ${kg(calcGross)} kg); ${unused}`,
    }
  }
  if (official) return { netKg: net, grossKg: gross, grossSource: 'OFFICIAL', grossNote: null }
  return {
    netKg: net,
    grossKg: gross,
    grossSource: 'NET_PLUS_BOX_TARE',
    grossNote: `bruto = líquido + tara da caixa (${kg(net)} + ${kg(boxTareKg)} = ${kg(gross)} kg); ${unused}`,
  }
}

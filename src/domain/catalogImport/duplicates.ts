/**
 * Descrições repetidas (decisão 10): mesma família + medida + espessura + marca com códigos diferentes.
 * Fica SÓ UM — o código mais recente (número maior); se ele tem dados ruins (EAN inválido ou peso
 * inutilizável), o seguinte. Os outros não entram (aba "Repetidos descartados" da prévia).
 *
 * "Mesma descrição" é comparada pelo que a planilha DIZ, já lido (medida, espessura em µm, marca, linha,
 * capacidade, válvulas, unidades, acabamento, cor), e não pelo texto: "600MIC" = "600 MICRAS",
 * "09PESX75M" = "9PESX75M", "225MIC" = "8.86MIL", "10MILL" = "10MIL", "BIGSAFE 4MX50M" = "BIGSAFE 4X50".
 * O GRUPO da planilha entra na chave: as lonas do grupo "SILO PLAS/RESERV BPF" e os "BPF 8X50…" do grupo
 * SILO PLASTICO/RESERV têm o mesmo peso e medida, mas são produtos diferentes (formato aberto × tubular).
 * Exceção: lona cadastrada no grupo de silo-bolsa (SBG, medida em m × m — erro de cadastro) compara com o grupo
 * de lonas que cai na mesma linha (19771 SBG "8MX100M 120MIC" = 17367 do grupo BPF, as duas Lona padrão).
 */
import type { OfficialProduct } from './classify'
import type { ImportDecisions } from './decisions'
import type { Discarded } from './types'
import { badDataReasons } from './weights'

/** código para "o mais recente": produto fora da planilha (SKU não numérico) perde para qualquer código da fábrica */
const codeNum = (c: string) => (/^\d+$/.test(c) ? Number(c) : -1)
const squash = (s: string | null) => (s ?? '').toUpperCase().replace(/\s+/g, '')
const normGroup = (g: string) => g.toUpperCase().replace(/\s+/g, ' ').trim()
const groupKey = (p: OfficialProduct) => normGroup(p.group)
const NOT_GROUPS = new Set(['namedBpfPrefix', 'otherPlain', 'multilayer'])

/**
 * Grupo da chave: o da planilha; a lona do grupo SBG usa o único grupo de lonas que cai na mesma linha. O silo-bolsa
 * compara entre os grupos (SBG × SILO PLASTICO/RESERV): lá ele só aparece com a sigla de espessura (BPT / BBT / BPM),
 * que fica fora da comparação — "BPT 9PESX60M 240 MICRAS" = "9PESX60M 240MIC" (Matías, 14/10/2026).
 */
function keyGroup(p: OfficialProduct, d: ImportDecisions): string {
  const g = groupKey(p)
  if (p.kind === 'SILO_BAG') return 'SILO-BOLSA'
  if (p.kind !== 'TARP' || !/SBG$/.test(g)) return g
  const homes = Object.entries(d.tarpGroupLine).filter(([k, line]) => !NOT_GROUPS.has(k) && line === p.lineKey)
  return homes.length === 1 ? normGroup(homes[0][0]) : g
}

/** Medidas e características lidas (sem o grupo): o mesmo produto escrito de outro jeito dá a mesma chave. */
function specKey(p: OfficialProduct): string {
  return [p.kind, p.lineKey, p.subLine, p.diameterFt, p.widthM, p.lengthM, p.lengthFt, p.widthCm, p.lengthCm, p.thicknessUm, p.brand, p.capacityL, p.unitsPerPack, p.valves, p.tags.join('/'), p.color].join('|')
}

/** Texto cru da descrição (grupo | medida | espessura | marca), sem espaços. */
const rawKey = (p: OfficialProduct) => [groupKey(p), squash(p.measure), squash(p.thicknessText), p.brand].join(' | ')

/**
 * Chave da descrição: grupo da planilha + o que foi lido da medida/espessura/marca. Sem medida nem espessura
 * lidas (nada a comparar), vale o texto cru.
 */
export function dedupeKey(p: OfficialProduct, d: ImportDecisions): string {
  const read = p.diameterFt != null || p.widthM != null || p.lengthM != null || p.widthCm != null || p.thicknessUm != null
  return read ? `${keyGroup(p, d)} | ${specKey(p)}` : `texto | ${rawKey(p)}`
}

export const describe = (p: OfficialProduct) => [p.group, p.measure, p.thicknessText ?? '', p.brandRaw ?? ''].join(' | ')

export interface DedupeResult {
  kept: OfficialProduct[]
  discarded: Discarded[]
  /** grupos com mais de um código */
  groups: number
  /** códigos mantidos sem alternativa boa (todos do grupo têm dados ruins) */
  keptWithBadData: string[]
  /** códigos mantidos que não são o maior do grupo (o maior tinha dados ruins) */
  keptNotHighest: { kept: string; skipped: string[] }[]
}

export function dedupe(products: OfficialProduct[], d: ImportDecisions): DedupeResult {
  const byKey = new Map<string, OfficialProduct[]>()
  for (const p of products) {
    const k = dedupeKey(p, d)
    const list = byKey.get(k)
    if (list) list.push(p)
    else byKey.set(k, [p])
  }
  const keep = new Set<OfficialProduct>()
  const discarded: Discarded[] = []
  const keptWithBadData: string[] = []
  const keptNotHighest: { kept: string; skipped: string[] }[] = []
  let groups = 0
  for (const list of byKey.values()) {
    if (list.length === 1) {
      keep.add(list[0])
      continue
    }
    groups++
    const sorted = [...list].sort((a, b) => codeNum(b.code) - codeNum(a.code))
    const bad = new Map(sorted.map((p) => [p, badDataReasons(p, d)]))
    const good = sorted.find((p) => bad.get(p)!.length === 0)
    const chosen = good ?? sorted[0]
    keep.add(chosen)
    if (!good) keptWithBadData.push(chosen.code)
    const skippedHigher = sorted.slice(0, sorted.indexOf(chosen))
    if (skippedHigher.length) keptNotHighest.push({ kept: chosen.code, skipped: skippedHigher.map((p) => p.code) })
    for (const p of sorted) {
      if (p === chosen) continue
      const why = bad.get(p)!
      const higher = codeNum(p.code) > codeNum(chosen.code)
      const txt = (x: OfficialProduct) => `${x.measure} ${x.thicknessText ?? ''}`.trim()
      const tierCode = (x: OfficialProduct) => d.siloBagThicknessCodes.some((c) => new RegExp(`^\\s*${c}\\b`, 'i').test(x.measure))
      const spelling =
        p.kind === 'SILO_BAG' && (tierCode(p) || tierCode(chosen))
          ? ` — o mesmo silo-bolsa com/sem a sigla de espessura da fábrica ("${txt(p)}" × "${txt(chosen)}")`
          : groupKey(p) !== groupKey(chosen)
            ? ` — a mesma lona em outro grupo da planilha ("${p.group}" × "${chosen.group}")`
            : rawKey(p) !== rawKey(chosen)
              ? ` — o mesmo produto escrito de outro jeito ("${txt(p)}" × "${txt(chosen)}")`
              : ''
      discarded.push({
        code: p.code,
        row: p.row,
        keptCode: chosen.code,
        description: describe(p),
        reason: higher
          ? `descrição repetida: código mais recente, mas com dados ruins (${why.join('; ')}); mantido o ${chosen.code}${spelling}`
          : `descrição repetida: mantido o código mais recente${good ? ' com dados bons' : ''} (${chosen.code})${spelling}`,
      })
    }
  }
  const kept = products.filter((p) => keep.has(p))
  discarded.sort((a, b) => a.row - b.row)
  return { kept, discarded, groups, keptWithBadData, keptNotHighest }
}

/**
 * Produtos MANTIDOS separados que ficam com a mesma medida, espessura e marca (depois de completar a
 * capacidade): grupos diferentes da planilha (formatos diferentes) ou uma linha que só traz a largura do
 * filme aberto ("4,3MX25M") e outra a capacidade ("2,15MX25M 20.000L"). Não são juntados — só um aviso.
 */
export function sameSizeDifferentText(products: OfficialProduct[]): string[][] {
  const by = new Map<string, OfficialProduct[]>()
  for (const p of products) {
    const k = specKey(p)
    const list = by.get(k)
    if (list) list.push(p)
    else by.set(k, [p])
  }
  return [...by.values()].filter((l) => l.length > 1).map((l) => l.map((p) => p.code))
}

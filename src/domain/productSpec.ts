/**
 * Especificação resumida do produto para consulta rápida (página do catálogo, IA, documentos),
 * montada a partir dos atributos técnicos (attrs) cadastrados/importados.
 *  - Hidrosilo / capacidade → "10.000 L"
 *  - Silo-bolsa (diâmetro em pés) → "9 pés × 60 m · 210 µm"  (ou "× 300 pés (~91 m)")
 *  - Lona (largura × comprimento) → "12 × 50 m · 120 µm"
 * Detalhes técnicos (diâmetro em m, perímetro…) ficam em `technicalDetails` (dica/ficha), não na tabela.
 */
type Attrs = Record<string, unknown>

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)
const fmt = (v: number, d = 2) => v.toLocaleString('pt-BR', { maximumFractionDigits: d })

/** `thicknessUm` = campo próprio de espessura (µm); `attrs.espessura_um` só como legado. */
export function productSpec(attrs: Attrs | null | undefined, thicknessUm?: number | null): string {
  const a = attrs ?? {}
  const cap = n(a.capacidade_l)
  if (cap) return `${fmt(cap, 0)} L`
  const um = thicknessUm ?? n(a.espessura_um)
  const micr = um ? ` · ${fmt(um, 0)} µm` : ''
  const diaFt = n(a.diametro_ft)
  const lenM = n(a.comprimento_m)
  const lenFt = n(a.comprimento_ft)
  if (diaFt) {
    const len = lenFt ? `${fmt(lenFt, 0)} pés${lenM ? ` (~${fmt(lenM, 0)} m)` : ''}` : lenM ? `${fmt(lenM, 1)} m` : ''
    return `${fmt(diaFt, 1)} pés${len ? ` × ${len}` : ''}${micr}`
  }
  const wid = n(a.largura_m)
  if (wid && lenM) return `${fmt(wid, 2)} × ${fmt(lenM, 1)} m${micr}`
  if (lenM) return `${fmt(lenM, 1)} m${micr}`
  return um ? `${fmt(um, 0)} µm` : ''
}

const LABELS: [string, string, string][] = [
  ['capacidade_l', 'Capacidade', 'L'],
  ['diametro_ft', 'Diâmetro', 'pés'],
  ['diametro_m', 'Diâmetro', 'm'],
  ['largura_m', 'Largura', 'm'],
  ['comprimento_m', 'Comprimento', 'm'],
  ['comprimento_ft', 'Comprimento', 'pés'],
  ['perimetro_m', 'Perímetro', 'm'],
  ['espessura_um', 'Espessura', 'µm'],
]

/** Lista dos dados técnicos para dica/ficha ("Diâmetro: 2,743 m · Perímetro: 8,7 m …"). */
export function technicalDetails(attrs: Attrs | null | undefined, thicknessUm?: number | null): string {
  const a: Attrs = { ...(attrs ?? {}), ...(thicknessUm != null ? { espessura_um: thicknessUm } : {}) }
  const out = LABELS.flatMap(([k, label, unit]) => {
    const v = n(a[k])
    return v == null ? [] : [`${label}: ${fmt(v, 3)} ${unit}`]
  })
  if (a.silo_bolsa === 1 || a.silo_bolsa === '1') out.push('Silo-bolsa: sim')
  return out.join(' · ')
}

/** Campos próprios do produto (medidas e espessura); null = não informado. */
export interface TechnicalColumns {
  thicknessUm?: number | null
  diameterFt?: number | null
  widthM?: number | null
  lengthM?: number | null
  lengthFt?: number | null
}

/**
 * Atributos técnicos completos = atributos livres + campos próprios (os campos próprios mandam).
 * Base única para especificação, ordem dos produtos e busca da IA.
 */
export function technicalAttrs(attrs: Attrs | null | undefined, c: TechnicalColumns): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(attrs ?? {}) }
  if (c.thicknessUm != null) out.espessura_um = c.thicknessUm
  if (c.diameterFt != null) out.diametro_ft = c.diameterFt
  if (c.widthM != null) out.largura_m = c.widthM
  if (c.lengthM != null) out.comprimento_m = c.lengthM
  if (c.lengthFt != null) out.comprimento_ft = c.lengthFt
  return out
}

/** Separa as medidas/espessura (campos próprios) do restante dos atributos — para importações. */
export function splitTechnical(attrs: Record<string, string | number | null>): { attrs: Record<string, string | number | null>; columns: TechnicalColumns } {
  const { espessura_um, diametro_ft, largura_m, comprimento_m, comprimento_ft, ...rest } = attrs
  return { attrs: rest, columns: { thicknessUm: n(espessura_um), diameterFt: n(diametro_ft), widthM: n(largura_m), lengthM: n(comprimento_m), lengthFt: n(comprimento_ft) } }
}

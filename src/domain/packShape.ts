/**
 * FORMATO do volume (só desenho 3D): lonas e filmes vão em ROLO dentro da caixa (nas pontas aparece o rolo e o
 * cone onde a lona é enrolada). Vem do catálogo (product_variant.attrs.formato = 'rolo', gravado pela importação
 * do catálogo oficial), não do código: os códigos oficiais são numéricos e não dizem o tipo de produto.
 * Snapshots sem `shape` (cargas antigas, ou salvas antes de o campo existir): vale o prefixo legado do SKU (LS-…)
 * ou o nome do produto ("Lona …", "Filme …").
 */
export type PackShape = 'ROLL'

/** Formato pelo atributo do catálogo (`formato: rolo`); sem atributo → null (caixa comum). */
export function shapeFromAttrs(attrs: Record<string, unknown> | null | undefined): PackShape | null {
  const f = attrs?.formato
  return typeof f === 'string' && f.trim().toLowerCase() === 'rolo' ? 'ROLL' : null
}

/** O volume é um rolo? (snapshot novo: `shape`; sem ele: SKU de lona LS-… ou nome "Lona …" / "Filme …") */
export function isRollPack(p?: { sku?: string | null; name?: string | null; shape?: PackShape | null } | null): boolean {
  if (!p) return false
  return p.shape === 'ROLL' || /^LS-/i.test(p.sku ?? '') || /^\s*(lona|filme)\b/i.test(p.name ?? '')
}

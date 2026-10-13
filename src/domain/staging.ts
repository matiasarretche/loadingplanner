/**
 * ZONA DE TRABALHO FORA DO EQUIPAMENTO (edição manual no 3D).
 *
 * Um palete/volume deixado TOTALMENTE fora do espaço interno (ex.: para trocar dois paletes de lugar)
 * fica onde foi solto: não volta sozinho e não é apagado. Enquanto estiver fora ele é "pendente de
 * ubicação": não conta como carregado (peso, CG, quadrantes, ocupação, PDF/packing list) e gera um
 * alerta crítico único, que impede enviar para revisão/aprovar até ser reposicionado ou retirado.
 */
import type { AABB } from './geometry'
import type { LoadDoc } from './types'

/** Corpo sem nenhuma sobreposição de piso com o espaço interno (1 mm de tolerância). */
export function isOutsideSpace(doc: LoadDoc, box: AABB): boolean {
  if (doc.space.kind === 'NONE') return false
  const { l, w } = doc.space.inner
  const t = 1
  return box.min.x + box.size.x <= t || box.min.x >= l - t || box.min.y + box.size.y <= t || box.min.y >= w - t
}

/** Ids das unidades fora do equipamento (recebe as caixas já calculadas para não recalcular a geometria). */
export function stagedIds(doc: LoadDoc, boxes: { id: string; box: AABB }[]): Set<string> {
  return new Set(boxes.filter((b) => isOutsideSpace(doc, b.box)).map((b) => b.id))
}

/** A carga sem as unidades da zona de trabalho (o que de fato está carregado). */
export function withoutStaged(doc: LoadDoc, staged: Set<string>): LoadDoc {
  return staged.size ? { ...doc, units: doc.units.filter((u) => !staged.has(u.id)) } : doc
}

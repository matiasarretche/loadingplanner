/**
 * Colunas das MEDIDAS DO PRODUTO (campos próprios) conforme a família, iguais em todas as telas
 * (catálogo logístico, produtos, ficha do produto). Campo exigido pela família e vazio → vermelho.
 *  - Silo-bolsa: diâmetro (pés) · comprimento (m ou pés) · espessura (µm)
 *  - Lona, Animal Comfort, Hidrosilo, Hydroforce: largura (m) · comprimento (m) · espessura (µm)
 */
import { productKind, requiredFields, TechField } from '@/domain/productOrder'

export interface TechValues {
  thicknessUm?: number | null
  diameterFt?: number | null
  widthM?: number | null
  lengthM?: number | null
  lengthFt?: number | null
}

const fmt = (v: number, d = 2) => v.toLocaleString('pt-BR', { maximumFractionDigits: d })

/** Colunas mostradas para a família (o que não se aplica não aparece). */
export function techColumns(familyName?: string | null): { field: TechField; title: string }[] {
  const kind = productKind(familyName)
  const req = requiredFields(familyName)
  if (kind === 'silo') return [{ field: 'diameterFt', title: 'Diâmetro (pés)' }, { field: 'length', title: 'Comprimento' }, { field: 'thicknessUm', title: 'Espessura (µm)' }]
  if (kind === 'lona' || kind === 'hidro' || kind === 'animal') return [{ field: 'widthM', title: 'Largura (m)' }, { field: 'length', title: 'Comprimento (m)' }, { field: 'thicknessUm', title: 'Espessura (µm)' }]
  return req.includes('thicknessUm') ? [{ field: 'thicknessUm', title: 'Espessura (µm)' }] : []
}

function value(field: TechField, v: TechValues): string | null {
  switch (field) {
    case 'diameterFt':
      return v.diameterFt != null ? fmt(v.diameterFt) : null
    case 'widthM':
      return v.widthM != null ? fmt(v.widthM, 3) : null
    case 'thicknessUm':
      return v.thicknessUm != null ? fmt(v.thicknessUm, 0) : null
    case 'length':
      if (v.lengthFt != null) return `${fmt(v.lengthFt, 0)} pés${v.lengthM != null ? ` (${fmt(v.lengthM, 1)} m)` : ''}`
      return v.lengthM != null ? `${fmt(v.lengthM, 1)} m` : null
  }
}

const RED = { background: 'var(--crit-bg)', color: 'var(--crit)', fontWeight: 600 } as const

export function TechHeaders({ familyName }: { familyName?: string | null }) {
  return (
    <>
      {techColumns(familyName).map((c) => (
        <th key={c.field} className="num">
          {c.title}
        </th>
      ))}
    </>
  )
}

export function TechCells({ familyName, v }: { familyName?: string | null; v: TechValues }) {
  const req = requiredFields(familyName)
  return (
    <>
      {techColumns(familyName).map((c) => {
        const val = value(c.field, v)
        const missing = val == null && req.includes(c.field)
        return (
          <td key={c.field} className="num" style={missing ? RED : { whiteSpace: 'nowrap' }} title={missing ? 'Dado não informado: complete o cadastro' : undefined}>
            {val ?? (missing ? 'falta' : '—')}
          </td>
        )
      })}
    </>
  )
}

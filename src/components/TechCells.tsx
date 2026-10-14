/**
 * Colunas das MEDIDAS DO PRODUTO (campos próprios) conforme a família, iguais em todas as telas
 * (catálogo logístico, produtos, ficha do produto). Campo exigido pela família e vazio → vermelho.
 *  - Silo-bolsa: diâmetro (pés) · perímetro real (m, só leitura) · comprimento (m ou pés) · espessura (µm)
 *  - Lona, Animal Comfort, Hidrosilo, Hydroforce: largura (m) · comprimento (m) · espessura (µm)
 */
import { productKind, requiredFields, TechField } from '@/domain/productOrder'
import { theoreticalPerimeterM } from '@/domain/siloPerimeter'

export interface TechValues {
  thicknessUm?: number | null
  diameterFt?: number | null
  widthM?: number | null
  lengthM?: number | null
  lengthFt?: number | null
  /** perímetro real do diâmetro (Editar família → Silo-bolsa); null = não definido (vale o peso da planilha) */
  perimeterM?: number | null
}

/** coluna mostrada: campo do produto ou o perímetro real (só leitura, nunca exigido) */
type TechColumn = TechField | 'perimeterM'

const fmt = (v: number, d = 2) => v.toLocaleString('pt-BR', { maximumFractionDigits: d })
const fmtPerim = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })

/** Colunas mostradas para a família (o que não se aplica não aparece). */
export function techColumns(familyName?: string | null): { field: TechColumn; title: string }[] {
  const kind = productKind(familyName)
  const req = requiredFields(familyName)
  if (kind === 'silo')
    return [
      { field: 'diameterFt', title: 'Diâmetro (pés)' },
      { field: 'perimeterM', title: 'Perímetro real (m)' },
      { field: 'length', title: 'Comprimento' },
      { field: 'thicknessUm', title: 'Espessura (µm)' },
    ]
  if (kind === 'lona' || kind === 'hidro' || kind === 'animal') return [{ field: 'widthM', title: 'Largura (m)' }, { field: 'length', title: 'Comprimento (m)' }, { field: 'thicknessUm', title: 'Espessura (µm)' }]
  return req.includes('thicknessUm') ? [{ field: 'thicknessUm', title: 'Espessura (µm)' }] : []
}

function value(field: TechColumn, v: TechValues): string | null {
  switch (field) {
    case 'diameterFt':
      return v.diameterFt != null ? fmt(v.diameterFt) : null
    case 'perimeterM':
      return v.perimeterM != null ? fmtPerim(v.perimeterM) : null
    case 'widthM':
      return v.widthM != null ? fmt(v.widthM, 3) : null
    case 'thicknessUm':
      return v.thicknessUm != null ? fmt(v.thicknessUm, 0) : null
    case 'length':
      if (v.lengthFt != null) return `${fmt(v.lengthFt, 0)} pés${v.lengthM != null ? ` (${fmt(v.lengthM, 1)} m)` : ''}`
      return v.lengthM != null ? `${fmt(v.lengthM, 1)} m` : null
  }
}

/** dica do perímetro: real (ou a falta dele) + o matemático π × D, para comparar */
function perimeterTitle(v: TechValues): string | undefined {
  if (v.diameterFt == null) return undefined
  const theo = `Teórico π × D = ${theoreticalPerimeterM(v.diameterFt).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} m`
  return v.perimeterM != null
    ? `Perímetro real de fabricação (Editar família): o peso líquido é calculado com ele\n${theo}`
    : `Sem perímetro real definido para este diâmetro: vale o peso da planilha\n${theo}`
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
        if (c.field === 'perimeterM')
          return (
            <td key={c.field} className="num" style={{ whiteSpace: 'nowrap' }} title={perimeterTitle(v)}>
              {val ?? <span className="muted">—</span>}
            </td>
          )
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

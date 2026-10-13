import type { StoredSummary } from '@/db/schema'
import { countBySeverity } from '@/domain/issues'
import { validateLoad } from '@/domain/load'
import type { LoadDoc } from '@/domain/types'

/** Validação + resumo gravados junto com cada versão da carga. */
export function evaluateDoc(doc: LoadDoc) {
  const { issues, summary } = validateLoad(doc)
  const c = countBySeverity(issues)
  const stored: StoredSummary = {
    pallets: summary.pallets,
    packages: summary.packages,
    units: summary.units,
    netKg: summary.netKg,
    payloadKg: summary.payloadKg,
    grossKg: summary.grossKg,
    payloadPct: summary.payloadPct,
    cbmUnits: summary.cbmUnits,
    volumeUtilPct: summary.volumeUtilPct,
    floorUtilPct: summary.floorUtilPct,
  }
  return { issues, stored, critical: c.CRITICAL, warning: c.WARNING }
}

/** Versões de embalagem usadas no documento (ficam travadas contra edição). */
export function packagingIds(doc: LoadDoc) {
  return [...Object.values(doc.packs), ...Object.values(doc.pallets).flatMap((p) => Object.values(p.packs))].map((p) => p.packagingVersionId)
}

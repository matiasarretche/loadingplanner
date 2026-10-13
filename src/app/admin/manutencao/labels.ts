import type { CatalogImportStatus } from '@/domain/catalogImport/types'

/** situação da importação do catálogo: texto e classe do selo (.badge) */
export const IMPORT_STATUS: Record<CatalogImportStatus, { label: string; badge: string }> = {
  PREVIEW: { label: 'Prévia', badge: 'INFO' },
  APPLIED: { label: 'Aplicada', badge: 'ok' },
  SYNCING: { label: 'Aplicada · montagens atualizando', badge: 'WARNING' },
  SYNCED: { label: 'Aplicada', badge: 'ok' },
  SYNC_FAILED: { label: 'Aplicada · falha nas montagens', badge: 'CRITICAL' },
  DISCARDED: { label: 'Descartada', badge: 'DRAFT' },
  SUPERSEDED: { label: 'Substituída', badge: 'SUPERSEDED' },
}

/** "1,2 MB" / "850 KB" */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
  return `${Math.max(1, Math.round(n / 1024)).toLocaleString('pt-BR')} KB`
}

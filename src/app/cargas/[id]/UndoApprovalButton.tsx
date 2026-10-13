'use client'

import { SubmitButton } from '@/components/SubmitButton'
import { undoApprovalAction } from '../actions'

/**
 * "Desfazer aprovação" na página da carga: a última versão aprovada volta para rascunho (o servidor confere
 * de novo: última versão, aprovada, sem seguimento de exportação). Pede confirmação com os efeitos.
 */
export function UndoApprovalButton({ versionId, version, restoreVersion, className = 'small danger' }: { versionId: number; version: number; restoreVersion: number | null; className?: string }) {
  const restore = restoreVersion != null ? `\n\nA V${restoreVersion}, aprovada antes, volta a ser a versão aprovada desta carga.` : ''
  return (
    <form
      action={undoApprovalAction.bind(null, versionId)}
      onSubmit={(e) => {
        if (!confirm(`Desfazer a aprovação da V${version}?\n\nA versão volta para Rascunho (editável) e os preços deixam de estar congelados; cotações já emitidas continuam no histórico.${restore}`)) e.preventDefault()
      }}
    >
      <SubmitButton className={className} pendingText="Desfazendo…" title={`A V${version} volta para rascunho (editável)${restoreVersion != null ? ` e a V${restoreVersion} volta a ser a aprovada` : ''}`}>
        Desfazer aprovação
      </SubmitButton>
    </form>
  )
}

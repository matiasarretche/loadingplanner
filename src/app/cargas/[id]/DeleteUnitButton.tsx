'use client'

import { deleteUnitAction } from '../actions'

/** Exclui uma unidade (contêiner/veículo) de um pedido com várias; pede confirmação. */
export function DeleteUnitButton({ planId, label }: { planId: number; label: string }) {
  return (
    <form
      action={deleteUnitAction.bind(null, planId)}
      onSubmit={(e) => {
        if (!confirm(`Excluir ${label} deste pedido?\n\nA carga e todas as suas versões em rascunho serão apagadas. As outras unidades do pedido não mudam.`)) e.preventDefault()
      }}
    >
      <button className="small danger" title="Só é possível enquanto todas as versões desta unidade estão em rascunho">
        Excluir {label}
      </button>
    </form>
  )
}

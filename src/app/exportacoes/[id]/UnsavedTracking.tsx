'use client'

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * Alterações NÃO SALVAS do formulário do Seguimento, visíveis para o botão do resumo para o cliente (irmão do
 * formulário na página): o PDF usa os dados salvos, então o diálogo pede para salvar antes.
 */
interface Unsaved {
  /** campos alterados e não salvos (chaves de TrackingValues) */
  changed: readonly string[]
  setChanged: (keys: readonly string[]) => void
}

const Ctx = createContext<Unsaved | null>(null)

export function UnsavedTrackingProvider({ children }: { children: ReactNode }) {
  const [changed, setChanged] = useState<readonly string[]>([])
  const value = useMemo(() => ({ changed, setChanged }), [changed])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** null fora do provider (o formulário e o botão funcionam sem ele, só sem o aviso) */
export const useUnsavedTracking = () => useContext(Ctx)

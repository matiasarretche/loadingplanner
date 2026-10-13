'use client'

import { createStore } from 'zustand/vanilla'

/** Store de documento com desfazer/refazer e seleção (um por editor aberto). */
export interface DocState<T> {
  doc: T
  saved: T
  past: T[]
  future: T[]
  selection: string[]
  /** Atualização normal: entra no histórico. */
  apply: (fn: (d: T) => T) => void
  /** Atualização transitória (arrasto): não entra no histórico; chamar `checkpoint` antes. */
  applyTransient: (fn: (d: T) => T) => void
  checkpoint: () => void
  /** Cancela um arrasto: volta a `prev` e descarta o checkpoint feito no início (se for ele). */
  revertTo: (prev: T) => void
  undo: () => void
  redo: () => void
  select: (ids: string[]) => void
  markSaved: (d?: T) => void
}

const LIMIT = 200

/** normalize: ajuste aplicado a todo documento novo (ex.: piso de trabalho do envio sem equipamento) */
export function createDocStore<T>(initial: T, normalize: (d: T) => T = (d) => d) {
  return createStore<DocState<T>>((set, get) => ({
    doc: initial,
    saved: initial,
    past: [],
    future: [],
    selection: [],
    apply: (fn) => {
      const { doc, past } = get()
      const next = normalize(fn(doc))
      if (next === doc) return
      set({ doc: next, past: [...past, doc].slice(-LIMIT), future: [] })
    },
    applyTransient: (fn) => set({ doc: normalize(fn(get().doc)) }),
    checkpoint: () => {
      const { doc, past } = get()
      set({ past: [...past, doc].slice(-LIMIT), future: [] })
    },
    revertTo: (prev) => {
      const { past } = get()
      set({ doc: prev, past: past[past.length - 1] === prev ? past.slice(0, -1) : past })
    },
    undo: () => {
      const { doc, past, future } = get()
      if (!past.length) return
      set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future] })
    },
    redo: () => {
      const { doc, past, future } = get()
      if (!future.length) return
      set({ doc: future[0], past: [...past, doc], future: future.slice(1) })
    },
    select: (ids) => set({ selection: ids }),
    markSaved: (d) => set({ saved: d ?? get().doc }),
  }))
}

export function newId(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

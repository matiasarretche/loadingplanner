/**
 * Instruções manuais sobre UM palete da carga ("do palete 5 retire 2 caixas", "agregue 1 caixa ao
 * palete 3"). A instrução do usuário vale sobre o padrão do catálogo: o palete passa a ter montagem
 * própria e NADA o completa de volta até o padrão depois. Só se aplica se for fisicamente possível
 * (apoio, altura, espaço, peso do palete e payload da carga); senão nada muda e o motivo é informado.
 */
import { palletHeightLimit } from './companions'
import { newPhysicalCriticals } from './issues'
import { validateLoad } from './load'
import { addBoxesToMixed } from './mixedPallets'
import type { LoadDoc, LoadUnit, PackSnapshot, PalletDoc } from './types'

type PalletUnit = Extract<LoadUnit, { kind: 'PALLET' }>

/**
 * Palete pelo número que o usuário vê no 3D ("P5", "5"): a etiqueta do palete, ou a posição na carga
 * (P1 = primeira unidade), a mesma numeração das etiquetas do editor.
 */
export function palletByNumber(doc: LoadDoc, ref: string): PalletUnit | null {
  const m = /^p?\s*(\d+)$/i.exec(ref.trim())
  if (!m) return null
  const n = Number(m[1])
  const byLabel = doc.units.find((u) => u.kind === 'PALLET' && u.label?.trim().toUpperCase() === `P${n}`)
  if (byLabel) return byLabel as PalletUnit
  const u = doc.units[n - 1]
  return u?.kind === 'PALLET' ? u : null
}

/** Rótulo exibido do palete (o mesmo das etiquetas do 3D). */
export const palletLabel = (doc: LoadDoc, u: LoadUnit) => u.label ?? `P${doc.units.indexOf(u) + 1}`

/** Montagem própria do palete (cópia), para mudar só este palete e não os iguais a ele. */
function ownCopy(doc: LoadDoc, u: PalletUnit, p: PalletDoc): { key: string; pallet: PalletDoc } {
  const baseKey = p.baseKey ?? u.palletKey
  return { key: `${baseKey}~${u.id}`, pallet: { ...p, baseKey, fullBoxes: p.fullBoxes ?? p.items.length } }
}

export interface AddBoxesResult {
  doc: LoadDoc
  added: number
  boxesOnPallet: number
  error?: string
}

/** Agrega `count` caixas de `packId` ao palete (onde houver apoio total e altura); valida a carga inteira. */
export function addBoxesToPallet(doc: LoadDoc, unitId: string, packId: string, pack: PackSnapshot, count: number): AddBoxesResult {
  const u = doc.units.find((x) => x.id === unitId)
  if (!u || u.kind !== 'PALLET') return { doc, added: 0, boxesOnPallet: 0, error: 'Unidade não é um palete.' }
  if (u.locked) return { doc, added: 0, boxesOnPallet: 0, error: 'Palete travado.' }
  const p = doc.pallets[u.palletKey]
  if (!p) return { doc, added: 0, boxesOnPallet: 0, error: 'Montagem do palete não encontrada.' }
  const own = ownCopy(doc, u, p)
  const r = addBoxesToMixed(own.pallet, packId, pack, Math.max(0, Math.floor(count)), palletHeightLimit(doc))
  if (!r.added) return { doc, added: 0, boxesOnPallet: p.items.length, error: 'Não cabe mais nenhuma caixa neste palete (sem apoio total por cima, altura máxima do equipamento ou capacidade de peso do palete).' }
  const name = /\(alterado\)$/.test(p.name) ? p.name : `${p.name.replace(/ \(parcial\)$/, '')} (alterado)`
  const units = doc.units.map((x) => (x.id === u.id ? { ...u, palletKey: own.key } : x))
  const used = new Set(units.flatMap((x) => (x.kind === 'PALLET' ? [x.palletKey] : [])))
  const pallets = Object.fromEntries(Object.entries({ ...doc.pallets, [own.key]: { ...r.doc, name } }).filter(([k]) => used.has(k)))
  const next: LoadDoc = { ...doc, units, pallets }
  // o palete mais alto/pesado não pode colidir, passar da altura/porta, nem estourar o payload
  const before = validateLoad(doc).issues
  const after = validateLoad(next).issues
  const created = newPhysicalCriticals(before, after)
  const payloadNow = after.find((i) => i.code === 'PAYLOAD_EXCEEDED' && i.severity === 'CRITICAL')
  const payloadBefore = before.some((i) => i.code === 'PAYLOAD_EXCEEDED' && i.severity === 'CRITICAL')
  if (created.length || (payloadNow && !payloadBefore))
    return { doc, added: 0, boxesOnPallet: p.items.length, error: `Não foi aplicado: ${(created[0] ?? payloadNow)!.message}` }
  return { doc: next, added: r.added, boxesOnPallet: r.doc.items.length, ...(r.added < count ? { error: `Só couberam ${r.added} de ${count} caixa(s) (apoio, altura ou peso do palete).` } : {}) }
}

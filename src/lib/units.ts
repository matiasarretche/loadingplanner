import type { SpaceSnapshot } from '@/domain/types'

/** Nome da unidade de transporte de um pedido: "Contêiner", "Veículo" ou "ULD". */
export function unitNoun(space: Pick<SpaceSnapshot, 'kind' | 'transport'>): string {
  return space.kind === 'VEHICLE' ? 'Veículo' : space.transport === 'AIR' ? 'ULD' : 'Contêiner'
}

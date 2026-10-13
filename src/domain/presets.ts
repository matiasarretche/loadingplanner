/**
 * Presets de REFERÊNCIA usados no seed inicial do banco. Não são regras universais:
 * no sistema tudo é editável e versionado. Confirmar unidade/naviera para cargas críticas.
 */
import type { Verification } from './types'

export interface ContainerPreset {
  code: string
  name: string
  inner: { l: number; w: number; h: number }
  door: { w: number; h: number }
  volumeM3: number
  tareKg: number
  maxPayloadKg: number
  maxGrossKg: number
  source: string
  verification: Verification
}

export const CONTAINER_PRESETS: ContainerPreset[] = [
  { code: '20GP', name: "20' Dry Standard", inner: { l: 5900, w: 2352, h: 2395 }, door: { w: 2340, h: 2292 }, volumeM3: 33.2, tareKg: 2350, maxPayloadKg: 28130, maxGrossKg: 30480, source: 'Especificação Pacifil v0.1 (referência)', verification: 'ESTIMATED' },
  { code: '40GP', name: "40' Dry Standard", inner: { l: 12032, w: 2352, h: 2395 }, door: { w: 2340, h: 2292 }, volumeM3: 67.7, tareKg: 3750, maxPayloadKg: 28750, maxGrossKg: 32500, source: 'Especificação Pacifil v0.1 (referência)', verification: 'ESTIMATED' },
  { code: '40HC', name: "40' High Cube", inner: { l: 12032, w: 2350, h: 2700 }, door: { w: 2340, h: 2597 }, volumeM3: 76.3, tareKg: 3900, maxPayloadKg: 28600, maxGrossKg: 32500, source: 'Especificação Pacifil v0.1 (referência)', verification: 'ESTIMATED' },
]

export interface PalletPreset {
  code: string
  name: string
  l: number
  w: number
  h: number | null
  tareKg: number | null
  staticMaxKg: number | null
  dynamicMaxKg: number | null
  material: string
  fourWay: boolean
  notes: string
  verification: Verification
}

export const PALLET_PRESETS: PalletPreset[] = [
  { code: 'PBR-1', name: 'PBR 1,00 × 1,20', l: 1000, w: 1200, h: 137, tareKg: 27, staticMaxKg: null, dynamicMaxKg: 1200, material: 'Madeira', fourWay: true, notes: 'Capacidade ref. 1200 kg distribuída; tara ref. ~27 kg.', verification: 'ESTIMATED' },
  { code: 'PCF-1150', name: 'Pallet exportação 1,15 × 1,15', l: 1150, w: 1150, h: null, tareKg: null, staticMaxKg: null, dynamicMaxKg: null, material: 'Madeira', fourWay: true, notes: 'Completar tara/altura/capacidade.', verification: 'UNVERIFIED' },
  { code: 'PCF-1100x1300', name: 'Pallet exportação 1,10 × 1,30', l: 1100, w: 1300, h: null, tareKg: null, staticMaxKg: null, dynamicMaxKg: null, material: 'Madeira', fourWay: true, notes: 'Completar tara/altura/capacidade.', verification: 'UNVERIFIED' },
]

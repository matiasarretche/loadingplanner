/** Construtores de dados para testes e exemplos. */
import { CONTAINER_PRESETS } from './presets'
import { LoadDoc, PackSnapshot, PalletDoc, PalletTypeSnapshot, SpaceSnapshot } from './types'

export function pack(p: Partial<PackSnapshot> = {}): PackSnapshot {
  return {
    packagingVersionId: 1,
    version: 1,
    sku: 'TEST-BOX',
    name: 'Caixa teste',
    packageType: 'Caixa',
    dims: { l: 500, w: 400, h: 300 },
    netKg: 18,
    grossKg: 20,
    unitsPerPackage: 1,
    allowedOrientations: ['LWH', 'WLH'],
    stackable: true,
    maxStackLayers: null,
    maxStackKg: null,
    fragile: false,
    verification: 'VERIFIED',
    color: '#3b82f6',
    ...p,
  }
}

export function palletType(p: Partial<PalletTypeSnapshot> = {}): PalletTypeSnapshot {
  return {
    palletTypeId: 1,
    code: 'PBR-1',
    name: 'PBR-1',
    dims: { l: 1000, w: 1200, h: 137 },
    tareKg: 27,
    staticMaxKg: null,
    dynamicMaxKg: 1200,
    maxLoadKg: null,
    overhangAllowed: false,
    overhangMaxMm: 0,
    verification: 'VERIFIED',
    ...p,
  }
}

export function palletDoc(p: Partial<PalletDoc> = {}): PalletDoc {
  return {
    name: 'Montagem teste',
    palletType: palletType(),
    packs: { a: pack() },
    items: [],
    stackable: false,
    maxTopKg: null,
    accessoriesKg: 0,
    ...p,
  }
}

export function container(code: '20GP' | '40GP' | '40HC', over: Partial<SpaceSnapshot> = {}): SpaceSnapshot {
  const c = CONTAINER_PRESETS.find((x) => x.code === code)!
  return {
    kind: 'CONTAINER',
    typeId: 1,
    code: c.code,
    name: c.name,
    inner: c.inner,
    door: c.door,
    tareKg: c.tareKg,
    maxPayloadKg: c.maxPayloadKg,
    maxGrossKg: c.maxGrossKg,
    floorLoadKgPerM: null,
    source: c.source,
    verification: 'VERIFIED',
    ...over,
  }
}

export function loadDoc(p: Partial<LoadDoc> = {}): LoadDoc {
  return { space: container('40HC'), limits: [], packs: {}, pallets: {}, units: [], ...p }
}

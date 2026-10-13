import { Field, VERIFICATION_OPTIONS } from './resources'

export const PRODUCT_FIELDS = (families: { value: string; label: string }[]): Field[] => [
  { name: 'familyId', label: 'Família', type: 'select', required: true, options: families },
  { name: 'name', label: 'Nome do produto', type: 'text', required: true },
  { name: 'active', label: 'Ativo', type: 'bool' },
  { name: 'notes', label: 'Observações', type: 'textarea' },
]

export const VARIANT_FIELDS: Field[] = [
  { name: 'sku', label: 'SKU', type: 'text', required: true },
  { name: 'name', label: 'Descrição', type: 'text', required: true },
  { name: 'diameterFt', label: 'Diâmetro', type: 'decimal', unit: 'pés', help: 'Silo-bolsa: diâmetro em pés (ex.: 9).', highlightEmpty: 'Diâmetro não informado — complete este dado' },
  { name: 'widthM', label: 'Largura', type: 'decimal', unit: 'm', help: 'Lona, Animal Comfort, Hidrosilo, Hydroforce.', highlightEmpty: 'Largura não informada — complete este dado' },
  { name: 'lengthM', label: 'Comprimento', type: 'decimal', unit: 'm', highlightEmpty: 'Comprimento não informado — complete este dado (m ou pés)' },
  { name: 'lengthFt', label: 'Comprimento', type: 'decimal', unit: 'pés', help: 'Só para silo-bolsas vendidas em pés (ex.: 300).' },
  { name: 'thicknessUm', label: 'Espessura', type: 'int', unit: 'µm', help: 'Espessura do filme em micrômetros (ex.: 220).', highlightEmpty: 'Espessura não informada — complete este dado' },
  {
    name: 'attrs',
    label: 'Atributos técnicos',
    type: 'textarea',
    help: 'Um por linha, "chave: valor". Ex.: capacidade_l: 20000 / diametro_m: 2,743 (diâmetro, largura, comprimento e espessura têm campos próprios)',
  },
  { name: 'active', label: 'Ativo', type: 'bool' },
  { name: 'notes', label: 'Observações', type: 'textarea' },
]

export const PACKAGING_FIELDS = (pallets: { value: string; label: string }[]): Field[] => [
  { name: 'validFrom', label: 'Válida desde', type: 'date', required: true, group: 'Vigência' },
  { name: 'validTo', label: 'Válida até', type: 'date', group: 'Vigência' },
  { name: 'packageType', label: 'Tipo de volume', type: 'text', required: true, help: 'Caixa, rolo, fardo, bobina…', group: 'Volume' },
  { name: 'lengthMm', label: 'Comprimento (L)', type: 'int', unit: 'mm', required: true, group: 'Volume' },
  { name: 'widthMm', label: 'Largura (W)', type: 'int', unit: 'mm', required: true, group: 'Volume' },
  { name: 'heightMm', label: 'Altura (H)', type: 'int', unit: 'mm', required: true, group: 'Volume' },
  { name: 'netKg', label: 'Peso líquido', type: 'decimal', unit: 'kg', required: true, group: 'Volume' },
  { name: 'grossKg', label: 'Peso c/ embalagem (produto + caixa)', type: 'decimal', unit: 'kg', required: true, help: 'Produto + embalagem.', group: 'Volume' },
  { name: 'unitsPerPackage', label: 'Unidades por volume', type: 'int', required: true, group: 'Volume' },
  { name: 'allowedOrientations', label: 'Orientações permitidas', type: 'orientations', group: 'Manuseio', help: 'Orientação exigida = marcar só a(s) permitida(s).' },
  { name: 'stackable', label: 'Empilhável', type: 'bool', group: 'Manuseio' },
  { name: 'maxStackLayers', label: 'Máx. camadas empilhadas', type: 'int', group: 'Manuseio' },
  { name: 'maxStackWeightKg', label: 'Peso máx. por cima', type: 'decimal', unit: 'kg', group: 'Manuseio' },
  { name: 'fragile', label: 'Frágil', type: 'bool', group: 'Manuseio' },
  { name: 'orientationRequired', label: 'Orientação obrigatória', type: 'bool', group: 'Manuseio' },
  { name: 'palletTypeId', label: 'Palete padrão', type: 'select', options: pallets, group: 'Paletização de referência' },
  { name: 'packagesPerLayer', label: 'Volumes por camada', type: 'int', group: 'Paletização de referência' },
  { name: 'layersPerPallet', label: 'Camadas por palete', type: 'int', group: 'Paletização de referência' },
  { name: 'unitsPerPallet', label: 'Unidades por palete', type: 'int', group: 'Paletização de referência' },
  { name: 'verification', label: 'Status dos dados', type: 'select', options: VERIFICATION_OPTIONS, required: true, group: 'Qualidade de dados' },
  { name: 'verifiedAt', label: 'Data de verificação', type: 'date', group: 'Qualidade de dados' },
  { name: 'verifiedBy', label: 'Verificado por', type: 'text', group: 'Qualidade de dados' },
  { name: 'photoUrl', label: 'URL da foto', type: 'text', group: 'Qualidade de dados' },
  { name: 'notes', label: 'Observações', type: 'textarea', group: 'Qualidade de dados' },
]

export function parseAttrs(text: string | null | undefined): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {}
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^:=]+?)\s*[:=]\s*(.*?)\s*$/)
    if (!m) continue
    const v = m[2]
    out[m[1]] = v === '' ? null : /^-?\d+([.,]\d+)?$/.test(v) ? Number(v.replace(',', '.')) : v
  }
  return out
}

export function formatAttrs(a: Record<string, unknown> | null | undefined): string {
  return Object.entries(a ?? {})
    .map(([k, v]) => `${k}: ${v ?? ''}`)
    .join('\n')
}

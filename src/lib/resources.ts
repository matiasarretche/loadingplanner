import * as schema from '@/db/schema'
import { canonicalCountry } from './countries'
import { ORIENTATIONS } from '@/domain/geometry'

/** Definição declarativa dos cadastros simples (lista + formulário genéricos). */
export type FieldType = 'text' | 'textarea' | 'int' | 'decimal' | 'bool' | 'select' | 'date' | 'orientations' | 'country' | 'email'

export interface Field {
  name: string
  label: string
  type: FieldType
  required?: boolean
  unit?: string
  options?: { value: string; label: string }[]
  help?: string
  /** mostrar na listagem */
  list?: boolean
  group?: string
  /** para selects dinâmicos */
  optionsFrom?: 'constraintProfiles' | 'agents'
  /** campo vazio fica destacado em vermelho com esta mensagem (dado que falta completar) */
  highlightEmpty?: string
}

export const VERIFICATION_OPTIONS = [
  { value: 'VERIFIED', label: 'Verificado' },
  { value: 'ESTIMATED', label: 'Estimado / referência' },
  { value: 'UNVERIFIED', label: 'Não verificado' },
]

const AXLE_GROUP_OPTIONS = [
  { value: 'STEER', label: 'Eixo simples, 2 pneus (direcional)' },
  { value: 'SINGLE_DUAL', label: 'Eixo simples, 4 pneus (rodado duplo)' },
  { value: 'TANDEM2', label: 'Tandem duplo (2 eixos)' },
  { value: 'TANDEM3', label: 'Tandem triplo (3 eixos)' },
]
const AX = 'Eixos (distribuição de peso)'

const common: Field[] = [
  { name: 'verification', label: 'Status dos dados', type: 'select', options: VERIFICATION_OPTIONS, required: true, list: true, group: 'Qualidade de dados' },
  { name: 'source', label: 'Fonte', type: 'text', group: 'Qualidade de dados' },
  { name: 'active', label: 'Ativo', type: 'bool', list: true, group: 'Qualidade de dados' },
  { name: 'notes', label: 'Observações', type: 'textarea', group: 'Qualidade de dados' },
]

export const RESOURCES = {
  paletes: {
    title: 'Tipos de palete',
    singular: 'tipo de palete',
    table: schema.palletTypes,
    orderBy: 'code',
    fields: [
      { name: 'code', label: 'Código', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'name', label: 'Nome', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'material', label: 'Material', type: 'text', group: 'Identificação' },
      { name: 'lengthMm', label: 'Comprimento', type: 'int', unit: 'mm', required: true, list: true, group: 'Dimensões' },
      { name: 'widthMm', label: 'Largura', type: 'int', unit: 'mm', required: true, list: true, group: 'Dimensões' },
      { name: 'heightMm', label: 'Altura do palete', type: 'int', unit: 'mm', list: true, group: 'Dimensões' },
      { name: 'tareKg', label: 'Tara', type: 'decimal', unit: 'kg', list: true, group: 'Pesos' },
      { name: 'dynamicMaxKg', label: 'Carga máx. dinâmica', type: 'decimal', unit: 'kg', list: true, group: 'Pesos' },
      { name: 'staticMaxKg', label: 'Carga máx. estática', type: 'decimal', unit: 'kg', group: 'Pesos' },
      { name: 'maxLoadKg', label: 'Peso máx. de carga (operacional)', type: 'decimal', unit: 'kg', help: 'O limite efetivo é o menor entre dinâmica, estática e este.', group: 'Pesos' },
      { name: 'fourWay', label: '4 entradas', type: 'bool', group: 'Características' },
      { name: 'ispm15', label: 'ISPM-15', type: 'bool', group: 'Características' },
      { name: 'stackable', label: 'Empilhável', type: 'bool', group: 'Características' },
      { name: 'overhangAllowed', label: 'Overhang permitido', type: 'bool', group: 'Características' },
      { name: 'overhangMaxMm', label: 'Overhang máximo', type: 'int', unit: 'mm', group: 'Características' },
      ...common,
    ] as Field[],
  },
  conteineres: {
    title: 'Contêineres e ULD aéreas',
    singular: 'contêiner / ULD',
    table: schema.containerTypes,
    orderBy: 'code',
    fields: [
      { name: 'code', label: 'Código', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'name', label: 'Nome', type: 'text', required: true, list: true, group: 'Identificação' },
      {
        name: 'transportMode', label: 'Modal', type: 'select', required: true, list: true, group: 'Identificação',
        options: [
          { value: 'SEA', label: 'Marítimo (contêiner)' },
          { value: 'AIR', label: 'Aéreo (ULD: pallet/contêiner aéreo)' },
        ],
      },
      { name: 'carrier', label: 'Naviera / companhia aérea', type: 'text', list: true, group: 'Identificação' },
      { name: 'innerLengthMm', label: 'Comprimento interno', type: 'int', unit: 'mm', required: true, list: true, group: 'Interno' },
      { name: 'innerWidthMm', label: 'Largura interna', type: 'int', unit: 'mm', required: true, list: true, group: 'Interno' },
      { name: 'innerHeightMm', label: 'Altura interna', type: 'int', unit: 'mm', required: true, list: true, group: 'Interno' },
      { name: 'volumeM3', label: 'Volume', type: 'decimal', unit: 'm³', group: 'Interno' },
      { name: 'doorWidthMm', label: 'Largura da porta', type: 'int', unit: 'mm', required: true, group: 'Porta' },
      { name: 'doorHeightMm', label: 'Altura da porta', type: 'int', unit: 'mm', required: true, group: 'Porta' },
      { name: 'extLengthMm', label: 'Comprimento externo', type: 'int', unit: 'mm', group: 'Externo' },
      { name: 'extWidthMm', label: 'Largura externa', type: 'int', unit: 'mm', group: 'Externo' },
      { name: 'extHeightMm', label: 'Altura externa', type: 'int', unit: 'mm', group: 'Externo' },
      { name: 'tareKg', label: 'Tara', type: 'decimal', unit: 'kg', required: true, list: true, group: 'Pesos' },
      { name: 'maxPayloadKg', label: 'Payload máximo', type: 'decimal', unit: 'kg', list: true, group: 'Pesos' },
      { name: 'maxGrossKg', label: 'Peso bruto máximo', type: 'decimal', unit: 'kg', list: true, group: 'Pesos' },
      { name: 'floorLoadKgPerM', label: 'Carga de piso', type: 'decimal', unit: 'kg/m', help: 'Opcional. Usado no alerta de concentração de peso.', group: 'Pesos' },
      { name: 'validFrom', label: 'Vigência desde', type: 'date', group: 'Qualidade de dados' },
      { name: 'validTo', label: 'Vigência até', type: 'date', group: 'Qualidade de dados' },
      ...common,
    ] as Field[],
  },
  veiculos: {
    title: 'Veículos rodoviários',
    singular: 'veículo',
    table: schema.vehicleTypes,
    orderBy: 'code',
    fields: [
      { name: 'code', label: 'Código', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'name', label: 'Nome', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'kind', label: 'Tipo', type: 'text', list: true, group: 'Identificação' },
      { name: 'country', label: 'País', type: 'country', list: true, group: 'Identificação' },
      { name: 'carrier', label: 'Transportador', type: 'text', list: true, group: 'Identificação' },
      { name: 'innerLengthMm', label: 'Comprimento interno', type: 'int', unit: 'mm', required: true, list: true, group: 'Interno' },
      { name: 'innerWidthMm', label: 'Largura interna', type: 'int', unit: 'mm', required: true, list: true, group: 'Interno' },
      { name: 'innerHeightMm', label: 'Altura interna', type: 'int', unit: 'mm', required: true, list: true, group: 'Interno' },
      { name: 'doorWidthMm', label: 'Largura da porta', type: 'int', unit: 'mm', required: true, group: 'Porta' },
      { name: 'doorHeightMm', label: 'Altura da porta', type: 'int', unit: 'mm', required: true, group: 'Porta' },
      { name: 'tareKg', label: 'Tara', type: 'decimal', unit: 'kg', required: true, group: 'Pesos' },
      { name: 'maxPayloadKg', label: 'Payload máximo', type: 'decimal', unit: 'kg', list: true, group: 'Pesos' },
      { name: 'maxGrossKg', label: 'PBT máximo', type: 'decimal', unit: 'kg', group: 'Pesos' },
      { name: 'floorLoadKgPerM', label: 'Carga de piso', type: 'decimal', unit: 'kg/m', group: 'Pesos' },
      { name: 'legalProfileId', label: 'Perfil legal padrão', type: 'select', optionsFrom: 'constraintProfiles', group: 'Pesos' },
      {
        name: 'carrierKind', label: 'Tipo para a distribuição por eixo', type: 'select', list: true, group: AX,
        help: 'Medidas a partir da FRENTE do implemento/carroceria, para trás. Sem estes dados a carga não mostra a carga por eixo. O chassi porta-contêiner não aparece como espaço de carga.',
        options: [
          { value: 'SEMITRAILER', label: 'Semirreboque (puxado por cavalo)' },
          { value: 'RIGID', label: 'Caminhão rígido' },
          { value: 'CHASSIS', label: 'Chassi porta-contêiner' },
        ],
      },
      { name: 'lengthMm', label: 'Comprimento total do implemento', type: 'int', unit: 'mm', group: AX },
      { name: 'kingpinMm', label: 'Pino-rei atrás da frente (semirreboque/chassi)', type: 'int', unit: 'mm', group: AX },
      { name: 'frontAxleAheadMm', label: 'Eixo dianteiro à frente da carroceria (rígido)', type: 'int', unit: 'mm', group: AX },
      { name: 'axleGroup', label: 'Conjunto de eixos (traseiro)', type: 'select', options: AXLE_GROUP_OPTIONS, group: AX },
      { name: 'axleGroupCenterMm', label: 'Centro do conjunto atrás da frente', type: 'int', unit: 'mm', group: AX },
      { name: 'axleSpacingMm', label: 'Distância entre eixos do conjunto', type: 'int', unit: 'mm', group: AX },
      { name: 'cargoStartMm', label: 'Início do espaço de carga atrás da frente', type: 'int', unit: 'mm', group: AX },
      { name: 'tareCgMm', label: 'CG da tara atrás da frente', type: 'int', unit: 'mm', help: 'Vazio = meio do comprimento.', group: AX },
      { name: 'techGroupKg', label: 'Capacidade técnica do conjunto traseiro', type: 'decimal', unit: 'kg', help: 'Opcional (fabricante). O limite usado é o menor entre o legal e o técnico.', group: AX },
      { name: 'techFrontKg', label: 'Capacidade técnica do eixo dianteiro (rígido)', type: 'decimal', unit: 'kg', group: AX },
      ...common,
    ] as Field[],
  },
  cavalos: {
    title: 'Cavalos mecânicos',
    singular: 'cavalo mecânico',
    table: schema.roadTractors,
    orderBy: 'code',
    fields: [
      { name: 'code', label: 'Código', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'name', label: 'Nome', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'country', label: 'País', type: 'country', list: true, group: 'Identificação' },
      { name: 'wheelbaseMm', label: 'Eixo dianteiro → centro do conjunto traseiro', type: 'int', unit: 'mm', required: true, list: true, group: 'Geometria', help: 'Em tandem: entre-eixos da ficha + metade da distância entre os eixos traseiros.' },
      { name: 'fifthWheelAheadMm', label: '5ª roda à frente do centro traseiro', type: 'int', unit: 'mm', required: true, list: true, group: 'Geometria' },
      { name: 'rearGroup', label: 'Conjunto traseiro', type: 'select', options: AXLE_GROUP_OPTIONS.filter((o) => o.value === 'SINGLE_DUAL' || o.value === 'TANDEM2'), required: true, list: true, group: 'Geometria' },
      { name: 'rearSpacingMm', label: 'Distância entre eixos traseiros', type: 'int', unit: 'mm', required: true, group: 'Geometria', help: '0 para eixo simples.' },
      { name: 'tareFrontKg', label: 'Tara no eixo dianteiro', type: 'decimal', unit: 'kg', required: true, group: 'Pesos' },
      { name: 'tareRearKg', label: 'Tara no(s) eixo(s) traseiro(s)', type: 'decimal', unit: 'kg', required: true, group: 'Pesos' },
      { name: 'techFrontKg', label: 'Capacidade técnica dianteira', type: 'decimal', unit: 'kg', group: 'Pesos', help: 'Opcional. O limite usado é o menor entre o legal e o técnico.' },
      { name: 'techRearKg', label: 'Capacidade técnica traseira', type: 'decimal', unit: 'kg', group: 'Pesos' },
      ...common,
    ] as Field[],
  },
  'limites-eixo': {
    title: 'Limites de peso por eixo (países)',
    singular: 'perfil de limites por eixo',
    table: schema.axleLimitProfiles,
    orderBy: 'code',
    fields: [
      { name: 'code', label: 'Código', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'name', label: 'Nome', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'country', label: 'País', type: 'country', list: true, group: 'Identificação' },
      { name: 'steerKg', label: 'Eixo simples, 2 pneus (direcional)', type: 'decimal', unit: 'kg', list: true, group: 'Limites por conjunto' },
      { name: 'singleDualKg', label: 'Eixo simples, 4 pneus', type: 'decimal', unit: 'kg', list: true, group: 'Limites por conjunto' },
      { name: 'tandem2Kg', label: 'Tandem duplo', type: 'decimal', unit: 'kg', list: true, group: 'Limites por conjunto' },
      { name: 'tandem3Kg', label: 'Tandem triplo', type: 'decimal', unit: 'kg', list: true, group: 'Limites por conjunto' },
      { name: 'maxGrossKg', label: 'PBTC máximo da combinação', type: 'decimal', unit: 'kg', list: true, group: 'Limites por conjunto' },
      { name: 'warnPct', label: 'Alertar a partir de', type: 'decimal', unit: '% do limite', required: true, group: 'Alertas', help: 'Critério interno (não é norma).' },
      { name: 'axleTolPct', label: 'Tolerância de fiscalização por eixo', type: 'decimal', unit: '%', group: 'Alertas', help: 'Só informativa: não se soma ao limite no carregamento.' },
      { name: 'grossTolPct', label: 'Tolerância de fiscalização do PBTC', type: 'decimal', unit: '%', group: 'Alertas' },
      { name: 'validFrom', label: 'Vigência desde', type: 'date', group: 'Qualidade de dados' },
      ...common,
    ] as Field[],
  },
  perfis: {
    title: 'Perfis de restrição',
    singular: 'perfil de restrição',
    table: schema.constraintProfiles,
    orderBy: 'name',
    fields: [
      { name: 'name', label: 'Nome', type: 'text', required: true, list: true, group: 'Identificação' },
      {
        name: 'scope', label: 'Escopo', type: 'select', required: true, list: true, group: 'Identificação',
        options: [
          { value: 'CARRIER', label: 'Transportador / naviera' },
          { value: 'LEGAL', label: 'Legal' },
          { value: 'ROUTE', label: 'Rota' },
          { value: 'OPERATIONAL', label: 'Operacional' },
        ],
      },
      { name: 'country', label: 'País', type: 'country', list: true, group: 'Identificação' },
      { name: 'carrier', label: 'Transportador', type: 'text', group: 'Identificação' },
      { name: 'maxPayloadKg', label: 'Payload máximo', type: 'decimal', unit: 'kg', list: true, group: 'Limites' },
      { name: 'maxGrossKg', label: 'Peso bruto máximo', type: 'decimal', unit: 'kg', list: true, group: 'Limites' },
      { name: 'maxHeightMm', label: 'Altura máxima da carga', type: 'int', unit: 'mm', group: 'Limites' },
      { name: 'minSupportPct', label: 'Apoio mínimo da base', type: 'decimal', unit: '%', group: 'Tolerâncias de validação' },
      { name: 'cgLongTolPct', label: 'Tolerância CG longitudinal', type: 'decimal', unit: '%', group: 'Tolerâncias de validação' },
      { name: 'cgLatTolPct', label: 'Tolerância CG lateral', type: 'decimal', unit: '%', group: 'Tolerâncias de validação' },
      { name: 'lowUtilPct', label: 'Alerta de ocupação baixa abaixo de', type: 'decimal', unit: '%', group: 'Tolerâncias de validação' },
      { name: 'validFrom', label: 'Vigência desde', type: 'date', group: 'Qualidade de dados' },
      { name: 'validTo', label: 'Vigência até', type: 'date', group: 'Qualidade de dados' },
      { name: 'source', label: 'Fonte', type: 'text', group: 'Qualidade de dados' },
      { name: 'active', label: 'Ativo', type: 'bool', list: true, group: 'Qualidade de dados' },
      { name: 'notes', label: 'Observações', type: 'textarea', group: 'Qualidade de dados' },
    ] as Field[],
  },
  clientes: {
    title: 'Clientes',
    singular: 'cliente',
    table: schema.customers,
    orderBy: 'name',
    fields: [
      { name: 'code', label: 'Código ERP', type: 'text', list: true, group: 'Identificação', help: 'Código do cliente no ERP da fábrica. Único; vazio nos clientes criados pela tela.' },
      { name: 'name', label: 'Razão social', type: 'text', required: true, list: true, group: 'Identificação' },
      { name: 'taxId', label: 'ID fiscal', type: 'text', group: 'Identificação', help: 'RUT, CUIT, NIT, RUC, EIN, VAT…' },
      { name: 'address', label: 'Rua e número', type: 'text', group: 'Endereço', help: 'Uma linha. Ao criar uma carga, o endereço completo (rua, complemento, bairro, código postal, cidade e estado) é sugerido.' },
      { name: 'addressComplement', label: 'Complemento', type: 'text', group: 'Endereço', help: 'Sala, andar, loja, depósito… (se já estiver na rua, não repita).' },
      { name: 'district', label: 'Bairro', type: 'text', group: 'Endereço' },
      { name: 'postalCode', label: 'Código postal', type: 'text', group: 'Endereço' },
      { name: 'city', label: 'Cidade', type: 'text', list: true, group: 'Endereço' },
      { name: 'state', label: 'Estado / Província', type: 'text', group: 'Endereço' },
      { name: 'country', label: 'País', type: 'country', list: true, group: 'Endereço' },
      // pessoa com quem se fala (ex.: empresa e o dono/contato cadastrados como dois clientes no mesmo endereço)
      { name: 'contactName', label: 'Nome do contato', type: 'text', group: 'Contato', help: 'Pessoa com quem se fala neste cliente.' },
      { name: 'contactEmail', label: 'E-mail', type: 'email', group: 'Contato', help: 'Um ou mais, separados por ponto e vírgula (;).' },
      { name: 'contactPhone', label: 'Telefone / WhatsApp', type: 'text', group: 'Contato', help: 'Com código do país (ex.: +598 99 123 456).' },
      { name: 'agentId', label: 'Agente (vendas com comissão)', type: 'select', optionsFrom: 'agents', group: 'Comercial', help: 'Se o cliente compra via agente, a cotização já inclui a comissão do agente.' },
      { name: 'active', label: 'Ativo', type: 'bool', list: true, group: 'Comercial' },
      { name: 'notes', label: 'Observações', type: 'textarea', group: 'Comercial' },
    ] as Field[],
  },
  transportadoras: {
    title: 'Transportadoras',
    singular: 'transportadora',
    table: schema.transportCompanies,
    orderBy: 'code',
    /** códigos do ERP são números: 1, 2, 10, 100 (não 1, 10, 100, 2) */
    numericOrder: true,
    fields: [
      {
        name: 'code',
        label: 'Código ERP',
        type: 'text',
        required: true,
        list: true,
        help: 'Código da transportadora no ERP. Único; é o vínculo com o ERP: não altere. O mesmo nome com códigos diferentes = filiais.',
      },
      { name: 'name', label: 'Empresa', type: 'text', required: true, list: true },
      { name: 'contact', label: 'Contato', type: 'text', list: true },
      { name: 'phone', label: 'Telefone', type: 'text', list: true },
      { name: 'email', label: 'E-mail', type: 'email', list: true, help: 'Um ou mais, separados por ponto e vírgula (;).' },
      { name: 'active', label: 'Ativa', type: 'bool', list: true },
      { name: 'notes', label: 'Observações', type: 'textarea', help: 'Ex.: filial / cidade, quando o nome se repete com outro código.' },
    ] as Field[],
  },
  agentes: {
    title: 'Agentes',
    singular: 'agente',
    table: schema.agents,
    orderBy: 'name',
    fields: [
      { name: 'name', label: 'Nome', type: 'text', required: true, list: true },
      { name: 'country', label: 'País / mercado', type: 'country', list: true },
      { name: 'email', label: 'E-mail', type: 'text', list: true },
      { name: 'phone', label: 'Telefone / WhatsApp', type: 'text' },
      { name: 'active', label: 'Ativo', type: 'bool', list: true },
      { name: 'notes', label: 'Observações', type: 'textarea' },
    ] as Field[],
  },
} as const

export type ResourceKey = keyof typeof RESOURCES

export function isResourceKey(k: string): k is ResourceKey {
  return k in RESOURCES
}

/** um único endereço de e-mail, sem espaços (nome@dominio.ext) */
export function isEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>.]{2,}$/.test(s)
}

/**
 * Campo de e-mail com um ou mais endereços, separados por ";" ou "," (e "/" ou espaço dos cadastros antigos,
 * ex.: "a@x.com / b@y.com"): os endereços e os pedaços que não são e-mail.
 */
export function splitEmails(s: string): { emails: string[]; invalid: string[] } {
  const emails = s.split(/[\s;,/]+/).filter(Boolean)
  return { emails, invalid: emails.filter((e) => !isEmail(e)) }
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/**
 * Lista do cadastro: ordem (códigos do ERP em ordem NUMÉRICA quando o recurso pede) e busca simples
 * (sem acento nem maiúsculas) nas colunas da lista + observações. Pura (testável).
 */
export function listRows<T extends Record<string, unknown>>(rows: T[], o: { fields: readonly Field[]; orderBy: string; numericOrder?: boolean; q?: string | null }): T[] {
  const words = fold(o.q ?? '').split(/\s+/).filter(Boolean)
  const keys = [...o.fields.filter((f) => f.list && f.type !== 'bool').map((f) => f.name), 'notes']
  const hit = (r: T) => {
    if (!words.length) return true
    const hay = fold(keys.map((k) => (r[k] == null ? '' : String(r[k]))).join(' '))
    return words.every((w) => hay.includes(w))
  }
  const out = rows.filter(hit)
  if (o.numericOrder) {
    const k = o.orderBy
    out.sort((a, b) => String(a[k] ?? '').localeCompare(String(b[k] ?? ''), 'pt-BR', { numeric: true }))
  }
  return out
}

/** Converte FormData → objeto tipado conforme os campos, com mensagens em português. */
export function parseFields(fields: Field[], fd: FormData): { data: Record<string, unknown>; errors: Record<string, string> } {
  const data: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const f of fields) {
    const raw = fd.get(f.name)
    const str = typeof raw === 'string' ? raw.trim() : ''
    if (f.type === 'bool') {
      data[f.name] = raw === 'on' || raw === 'true'
      continue
    }
    if (f.type === 'orientations') {
      const sel = ORIENTATIONS.filter((o) => fd.get(`${f.name}_${o}`) === 'on')
      if (sel.length === 0) errors[f.name] = 'Selecione pelo menos uma orientação'
      data[f.name] = sel
      continue
    }
    if (str === '') {
      if (f.required) errors[f.name] = 'Obrigatório'
      data[f.name] = null
      continue
    }
    if (f.type === 'country') {
      const c = canonicalCountry(str)
      if (!c) errors[f.name] = 'País não reconhecido: escolha da lista'
      else data[f.name] = c
    } else if (f.type === 'int') {
      // Sem separador de milhar: evita que "137.5" vire 1375 silenciosamente.
      if (!/^\d+$/.test(str)) errors[f.name] = 'Informe um número inteiro, sem pontos (mm)'
      else data[f.name] = Number(str)
    } else if (f.type === 'decimal') {
      // Aceita vírgula ou ponto como decimal; rejeita separador de milhar ambíguo (ex.: 1.200,5)
      const n = /^\d+([.,]\d+)?$/.test(str) ? Number(str.replace(',', '.')) : NaN
      if (!Number.isFinite(n)) errors[f.name] = 'Informe um número (ex.: 1200 ou 27,5)'
      else if (n < 0) errors[f.name] = 'Não pode ser negativo'
      else data[f.name] = n
    } else if (f.type === 'select') {
      if (f.optionsFrom) {
        const n = Number(str)
        data[f.name] = Number.isInteger(n) ? n : null
      } else if (f.options && !f.options.some((o) => o.value === str)) errors[f.name] = 'Opção inválida'
      else data[f.name] = str
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) errors[f.name] = 'Data inválida'
      else data[f.name] = str
    } else if (f.type === 'email') {
      // um ou mais endereços, cada um validado; grava no formato "a@x.com; b@y.com"
      const { emails, invalid } = splitEmails(str)
      if (!emails.length || invalid.length) errors[f.name] = `E-mail inválido${invalid.length ? `: ${invalid.map((e) => `“${e}”`).join(', ')}` : ''} (ex.: nome@empresa.com; outro@empresa.com)`
      else data[f.name] = emails.join('; ')
    } else data[f.name] = str
  }
  return { data, errors }
}

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL'

export type IssueCode =
  | 'COLLISION'
  | 'OUT_OF_BOUNDS'
  /** na zona de trabalho fora do equipamento (pendente de ubicação) */
  | 'OUTSIDE_LOAD'
  | 'DOOR_FIT'
  | 'HEIGHT_LIMIT'
  | 'PAYLOAD_EXCEEDED'
  | 'GROSS_EXCEEDED'
  | 'PALLET_CAPACITY'
  | 'OVERHANG'
  | 'UNSUPPORTED'
  | 'STACK_NOT_ALLOWED'
  | 'STACK_WEIGHT'
  | 'STACK_LAYERS'
  | 'ORIENTATION'
  | 'CG_LONGITUDINAL'
  | 'CG_LATERAL'
  /** metade traseira (porta) acima do recomendado */
  | 'QUADRANT_SOUTH'
  /** mais peso na metade da frente (motorista) que na traseira */
  | 'WEIGHT_FRONT'
  | 'COMPANION_MISSING'
  | 'COMPANION_MISPLACED'
  | 'FLOOR_LOAD'
  /** rodoviário: conjunto de eixos acima do limite (legal/técnico) */
  | 'AXLE_OVERLOAD'
  | 'AXLE_NEAR_LIMIT'
  /** rodoviário: PBTC da combinação acima do limite */
  | 'AXLE_GROSS'
  | 'LOW_UTILIZATION'
  | 'UNVERIFIED_DATA'
  | 'EMPTY'
  | 'MISSING_REFERENCE'

export interface Issue {
  code: IssueCode
  severity: Severity
  message: string
  /** ids dos corpos envolvidos (itens do palete ou unidades da carga) */
  refs: string[]
  value?: number
  limit?: number
}

/** Problemas físicos de posição (o que um arrasto manual não pode criar). */
export const PHYSICAL_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>(['COLLISION', 'OUT_OF_BOUNDS', 'HEIGHT_LIMIT', 'UNSUPPORTED', 'STACK_NOT_ALLOWED', 'STACK_WEIGHT', 'STACK_LAYERS', 'OVERHANG', 'DOOR_FIT'])

/** Alertas críticos físicos que existem em `after` e não existiam em `before` (mesmo código e corpos). */
export function newPhysicalCriticals(before: Issue[], after: Issue[]): Issue[] {
  const key = (i: Issue) => `${i.code}|${[...i.refs].sort().join(',')}`
  const phys = (i: Issue) => i.severity === 'CRITICAL' && PHYSICAL_CODES.has(i.code)
  const had = new Set(before.filter(phys).map(key))
  return after.filter((i) => phys(i) && !had.has(key(i)))
}

export const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 }

export const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: 'Crítico',
  WARNING: 'Atenção',
  INFO: 'Info',
}

export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

export function countBySeverity(issues: Issue[]): Record<Severity, number> {
  const c: Record<Severity, number> = { CRITICAL: 0, WARNING: 0, INFO: 0 }
  for (const i of issues) c[i.severity]++
  return c
}

export const fmt = {
  kg: (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg`,
  mm: (v: number) => `${Math.round(v).toLocaleString('pt-BR')} mm`,
  pct: (v: number) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`,
  m3: (v: number) => `${v.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} m³`,
}

import { Body, canSupport, computeStackDepth, computeSupport, computeTopLoads, findCollisions } from './bodies'
import { fmt, Issue } from './issues'

export interface PhysicalCheckOptions {
  floorZ: number
  collisionTolMm: number
  minSupportPct: number
  /** Prefixo nas mensagens, ex.: "Palete P3: " */
  prefix?: string
}

/**
 * Colisões, apoio, empilhamento e peso sobre cada corpo.
 * Partes de um mesmo grupo (palete) são relatadas uma vez, pela unidade.
 */
export function physicalChecks(bodies: Body[], o: PhysicalCheckOptions) {
  const p = o.prefix ?? ''
  const issues: Issue[] = []
  const byId = new Map(bodies.map((b) => [b.id, b]))
  const grp = (b: Body) => b.group ?? b.id
  const name = (b: Body) => b.groupLabel ?? b.label
  const seen = new Set<string>()
  const first = (key: string) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  for (const [a, b] of findCollisions(bodies, o.collisionTolMm)) {
    const A = byId.get(a)!
    const B = byId.get(b)!
    if (!first(`col|${[grp(A), grp(B)].sort().join('|')}`)) continue
    issues.push({ code: 'COLLISION', severity: 'CRITICAL', message: `${p}Colisão entre ${name(A)} e ${name(B)}.`, refs: [grp(A), grp(B)] })
  }

  const support = computeSupport(bodies, o.floorZ)
  for (const b of bodies) {
    const s = support.get(b.id)
    if (!s || s.onFloor) continue
    if (s.supporters.length === 0) {
      issues.push({ code: 'UNSUPPORTED', severity: 'CRITICAL', message: `${p}${name(b)} está flutuando (sem apoio).`, refs: [grp(b)], value: 0 })
    } else if (s.supportedPct < o.minSupportPct) {
      issues.push({
        code: 'UNSUPPORTED',
        severity: 'CRITICAL',
        message: `${p}${name(b)} tem só ${fmt.pct(s.supportedPct)} da base apoiada (mín. ${fmt.pct(o.minSupportPct)}).`,
        refs: [grp(b)],
        value: s.supportedPct,
        limit: o.minSupportPct,
      })
    }
    for (const sup of s.supporters) {
      const under = byId.get(sup.id)!
      if (canSupport(under, b) || !first(`stk|${grp(b)}|${grp(under)}`)) continue
      const why = b.role === 'pallet-base' ? 'que não aceita outro palete por cima' : 'que não é empilhável'
      issues.push({ code: 'STACK_NOT_ALLOWED', severity: 'CRITICAL', message: `${p}${name(b)} está sobre ${under.label}, ${why}.`, refs: [grp(b), grp(under)] })
    }
  }

  const topLoads = computeTopLoads(bodies, support)
  for (const b of bodies) {
    const kg = topLoads.get(b.id) ?? 0
    if (b.maxTopKg != null && kg > b.maxTopKg + 1e-6) {
      issues.push({
        code: 'STACK_WEIGHT',
        severity: 'CRITICAL',
        message: `${p}${b.label} suporta ${fmt.kg(kg)} por cima (máx. ${fmt.kg(b.maxTopKg)}).`,
        refs: [grp(b)],
        value: kg,
        limit: b.maxTopKg,
      })
    }
  }

  const depth = computeStackDepth(bodies, support)
  for (const b of bodies) {
    const d = depth.get(b.id) ?? 1
    if (b.maxStackLayers != null && d > b.maxStackLayers) {
      issues.push({
        code: 'STACK_LAYERS',
        severity: 'CRITICAL',
        message: `${p}${b.label} está na camada ${d} (máx. ${b.maxStackLayers} camadas).`,
        refs: [grp(b)],
        value: d,
        limit: b.maxStackLayers,
      })
    }
  }

  return { issues, support, topLoads }
}

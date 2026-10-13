import { describe, expect, it } from 'vitest'
import { ORIENTATIONS, orientDims } from './geometry'
import { autoOrientations, defaultOrientation, distinctOrientations, nextFlip, nextYaw, policyOf, reorientPosition } from './orientation'

const box = { l: 600, w: 500, h: 130 }

describe('orientações (lógica única: edição manual e motor)', () => {
  it('6 permutações distintas; dimensões iguais geram equivalentes', () => {
    expect(distinctOrientations(box)).toHaveLength(6)
    expect(distinctOrientations({ l: 500, w: 500, h: 130 })).toHaveLength(3)
    expect(distinctOrientations({ l: 400, w: 400, h: 400 })).toHaveLength(1)
  })
  it('tombar percorre as faces na vertical (H → W → L → H) e volta', () => {
    const a = nextFlip('LWH', box, ORIENTATIONS)!
    expect(orientDims(box, a).z).toBe(500) // de lado: W na vertical
    const b = nextFlip(a, box, ORIENTATIONS)!
    expect(orientDims(box, b).z).toBe(600) // de topo: L na vertical
    const c = nextFlip(b, box, ORIENTATIONS)!
    expect(orientDims(box, c).z).toBe(130) // em pé de novo
  })
  it('respeita a política do produto ("manter em pé" bloqueia tombar)', () => {
    expect(nextFlip('LWH', box, ['LWH', 'WLH'])).toBeNull()
    expect(policyOf(['LWH', 'WLH'])).toBe('UPRIGHT')
    expect(policyOf([...ORIENTATIONS])).toBe('ANY')
    expect(policyOf(['LWH', 'LHW'])).toBe('CUSTOM')
  })
  it('girar em base quadrada não muda nada', () => {
    expect(nextYaw('LWH', { l: 500, w: 500, h: 130 }, ORIENTATIONS)).toBeNull()
    expect(nextYaw('LWH', box, ORIENTATIONS)).toBe('WLH')
  })
  it('ao tombar, mantém o centro, apoia no piso e fica dentro dos limites', () => {
    const old = { min: { x: 100, y: 100, z: 0 }, size: orientDims(box, 'LWH') }
    const ns = orientDims(box, 'LHW') // 600 × 130 × 500
    const p = reorientPosition(old, ns, [], { lo: { x: 0, y: 0, z: 0 }, hi: { x: 1150, y: 1150, z: 2000 } })!
    expect(p.z).toBe(0)
    expect(p.x + ns.x / 2).toBe(100 + 300)
    expect(p.y + ns.y / 2).toBe(100 + 250)
  })
  it('se colidir na nova orientação, procura o lugar livre mais próximo', () => {
    const old = { min: { x: 0, y: 0, z: 0 }, size: orientDims(box, 'LWH') }
    const block = { min: { x: 0, y: 500, z: 0 }, size: { x: 100, y: 100, z: 2000 } }
    const ns = orientDims(box, 'WLH') // 500 × 600: no centro invadiria o bloco
    const p = reorientPosition(old, ns, [{ box: block, stackable: false }], { lo: { x: 0, y: 0, z: 0 }, hi: { x: 1150, y: 1150, z: 2000 } })
    expect(p).not.toBeNull()
    const overlap = Math.min(p!.x + ns.x, 100) - Math.max(p!.x, 0) > 0 && Math.min(p!.y + ns.y, 600) - Math.max(p!.y, 500) > 0
    expect(overlap).toBe(false)
  })
  it('motor automático só usa orientações estáveis (caixa de 2,25 m não fica de pé no lado de 38 cm)', () => {
    const hs = { l: 2250, w: 380, h: 310 }
    const auto = autoOrientations(hs, [...ORIENTATIONS])
    for (const o of auto) {
      const d = orientDims(hs, o)
      expect(d.z).toBeLessThanOrEqual(2 * Math.min(d.x, d.y))
    }
    expect(auto[0][2]).toBe('H') // em pé (como cadastrado) primeiro
  })
})

describe('orientação natural (padrão inicial)', () => {
  it('apoia na maior face: Hidrosilo 2.000 L (600×500×130) e 5.000 L (1140×570×110) deitados', () => {
    expect(orientDims({ l: 600, w: 500, h: 130 }, defaultOrientation({ l: 600, w: 500, h: 130 }, [...ORIENTATIONS])).z).toBe(130)
    expect(orientDims({ l: 1140, w: 570, h: 110 }, defaultOrientation({ l: 1140, w: 570, h: 110 }, [...ORIENTATIONS])).z).toBe(110)
    // caixa cadastrada "em pé" mais alta que larga: a natural é deitada
    expect(orientDims({ l: 300, w: 200, h: 1000 }, defaultOrientation({ l: 300, w: 200, h: 1000 }, [...ORIENTATIONS])).z).toBe(200)
  })
  it('restrição do produto prevalece', () => {
    expect(defaultOrientation({ l: 300, w: 200, h: 1000 }, ['LWH', 'WLH'])).toBe('LWH')
  })
})

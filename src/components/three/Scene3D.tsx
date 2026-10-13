'use client'

import { Edges, Line, OrbitControls } from '@react-three/drei'
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { ComponentRef, ReactNode, RefObject, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { Vec3 } from '@/domain/geometry'

// Convenção do sistema: Z para cima. Precisa valer antes de criar câmeras/controles.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

export interface SubBox {
  min: Vec3
  size: Vec3
  color: string
  opacity?: number
  /** texto impresso nas 4 faces laterais (ex.: SKU) */
  print?: string
  /** adesivo da marca numa face lateral (imagem + tamanho real), complementar ao texto */
  brand?: BrandArt
}

/** arte do adesivo de marca (ver domain/brandLabels) */
export interface BrandArt {
  src: string
  wMm: number
  hMm: number
}

export interface SceneBody {
  id: string
  min: Vec3
  size: Vec3
  /** Se houver `parts`, o corpo é desenhado por elas e o envelope só como contorno. */
  parts?: SubBox[]
  color: string
  /** impressão nas faces (volume solto) */
  print?: string
  /** adesivo da marca (volume solto) */
  brand?: BrandArt
  /** só contexto (translúcido, sem cliques): usado ao editar o interior de um palete */
  dim?: boolean
  label?: string
  selected?: boolean
  invalid?: boolean
  locked?: boolean
  /** na zona de trabalho fora do equipamento (pendente de ubicação): translúcido com contorno laranja */
  staged?: boolean
}

export type ViewPreset = 'persp' | 'top' | 'side' | 'front' | 'rear'

export interface SceneBounds {
  kind: 'container' | 'pallet'
  size: Vec3
  door?: { w: number; h: number }
  /** Tabuleiro do palete (editor de palete) */
  deck?: { size: Vec3; color: string }
  /** Contorno do limite de altura / overhang (editor de palete) */
  limitBox?: { min: Vec3; size: Vec3 }
}

interface Props {
  bounds: SceneBounds
  bodies: SceneBody[]
  view: ViewPreset
  viewNonce: number
  showWalls: boolean
  showRoof: boolean
  showLabels: boolean
  snapMm: number
  cg?: Vec3 | null
  /** z do "piso" onde os corpos são arrastados (0 para contêiner; altura do tabuleiro no palete) */
  floorOffsetZ?: number
  onSelect: (id: string | null, additive: boolean) => void
  /**
   * Arrasto: 'plane' = corpo arrastado no plano horizontal (o editor decide a altura de repouso);
   * 'axis' = seta do manipulador (só o eixo da seta muda, inclusive a altura).
   */
  onMove: (id: string, min: Vec3, how: 'plane' | 'axis') => void
  /** mostra as setas X/Y/Z no corpo selecionado (edição habilitada) */
  gizmo?: boolean
  onDragStart?: (id: string) => void
  onDragEnd?: (id: string) => void
  /** sobreposição dos quadrantes (NE/NO/SE/SO) com os kg em cada um */
  quadrants?: Record<'NE' | 'NO' | 'SE' | 'SO', number> | null
  /** rodoviário: eixos sob o piso (x no referencial da carga), cor pelo estado do conjunto e rótulo com o peso */
  axles?: AxleMark[] | null
  /** mostra a impressão (SKU) nas caixas */
  showPrint?: boolean
  /** duplo clique num corpo (ex.: entrar no palete para editar as caixas) */
  onDoubleClick?: (id: string) => void
  /** recebe a função de captura de imagens (PDF) quando o 3D está pronto */
  onCaptureReady?: (capture: CaptureFn) => void
  /** recebe o gravador do giro de 360° (vídeo) quando o 3D está pronto */
  onRecorderReady?: (rec: OrbitRecorder) => void
}

export interface AxleMark {
  x: number
  color: string
  label?: string
}

/**
 * Vistas para PDFs: 3/4 frente (lado oeste) e traseira (lado leste), e as outras duas 3/4, de cima,
 * laterais oeste/leste, pela traseira (sul) e pela frente (norte).
 */
export type CaptureView = 'iso-front' | 'iso-rear' | 'top' | 'iso-front-east' | 'iso-rear-west' | 'side-west' | 'side-east' | 'door' | 'front'
/**
 * `only`: mostra só esses corpos (ids das unidades) — ex.: sequência de carregamento passo a passo; sem o CG,
 * os quadrantes e os eixos (valem para a carga inteira). `overlays: false`: sem o CG e os quadrantes.
 */
export type CaptureFn = (views: CaptureView[], opts?: { width?: number; height?: number; only?: string[]; overlays?: boolean }) => string[]

/** direção da câmera (a partir do centro do espaço) e aproximação de cada vista */
const VIEW_DIR: Record<CaptureView, { dir: [number, number, number]; zoom: number }> = {
  'iso-front': { dir: [-0.35, -1, 0.6], zoom: 0.78 },
  'iso-rear': { dir: [0.45, 1, 1.15], zoom: 0.86 },
  'iso-front-east': { dir: [-0.35, 1, 0.6], zoom: 0.78 },
  'iso-rear-west': { dir: [0.45, -1, 1.15], zoom: 0.86 },
  top: { dir: [0, -0.001, 1], zoom: 0.86 },
  'side-west': { dir: [0, -1, 0.12], zoom: 0.8 },
  'side-east': { dir: [0, 1, 0.12], zoom: 0.8 },
  door: { dir: [1, 0.12, 0.35], zoom: 0.9 },
  front: { dir: [-1, -0.12, 0.45], zoom: 0.9 },
}

/** Roteiro do vídeo, em quadros: entrada das unidades, giro de 360° e giro aproximado. */
export interface RecordPlan {
  width: number
  height: number
  /** entrada: cada passo = ids dos corpos que entram juntos pela porta (na ordem de carregamento) */
  intro: string[][]
  stepFrames: number
  /** pausa depois da entrada */
  holdFrames: number
  orbitFrames: number
  /** aproximação da câmera entre o giro aberto e o aproximado */
  transitionFrames: number
  zoomFrames: number
}
export interface FrameInfo {
  phase: 'intro' | 'hold' | 'orbit' | 'transition' | 'zoom'
  /** passo da entrada (0-based) e progresso 0..1 dentro dele */
  step: number
  stepT: number
  total: number
}
/**
 * Vídeo da carga quadro a quadro (não depende da velocidade da tela): entrada das unidades pela porta,
 * giro de 360° e giro aproximado. Para cada quadro renderiza a cena no tamanho pedido e chama `onFrame`
 * com o canvas WebGL pronto (copiar na hora, ainda no mesmo passo). O 3D da tela fica pausado durante a gravação.
 */
export type OrbitRecorder = (plan: RecordPlan & { onFrame: (i: number, src: HTMLCanvasElement, info: FrameInfo) => Promise<void> | void }) => Promise<void>

/**
 * Etiqueta HTML ancorada num ponto 3D. Fica numa camada DOM comum sobre o canvas e é reposicionada
 * a cada quadro (LabelProjector). Não usa o <Html> do drei, que cria uma raiz React por etiqueta e
 * a desmonta de forma síncrona durante o render ("Attempted to synchronously unmount a root…").
 */
interface Label3D {
  id: string
  pos: [number, number, number]
  text: ReactNode
  className?: string
  color?: string
  z: number
}

const QUAD_FMT = (kg: number) => `${Math.round(kg).toLocaleString('pt-BR')} kg`

function sceneLabels(p: Props): Label3D[] {
  const S = p.bounds.size
  const out: Label3D[] = []
  if (p.bounds.kind === 'container') {
    const door = p.bounds.door
    // Referências fixas (independentes da câmera): NORTE = frente/cabine (x=0), SUL = traseira (x=L),
    // OESTE y=0 = lado do motorista, LESTE y=W = lado do acompanhante
    out.push({ id: 'dir-n', pos: [-80, S.y / 2, S.z + 120], text: '▲ NORTE · FRENTE (cabine)', className: 'dir', z: 30 })
    out.push({ id: 'dir-s', pos: [S.x + 80, S.y / 2, S.z + 120], text: `SUL · TRASEIRA${door ? ` · porta ${door.w} × ${door.h}` : ''}`, className: 'dir', z: 30 })
    out.push({ id: 'dir-o', pos: [S.x / 2, -120, 0], text: 'OESTE · lado do motorista', z: 30 })
    out.push({ id: 'dir-e', pos: [S.x / 2, S.y + 120, 0], text: 'LESTE · lado do acompanhante', z: 30 })
    if (p.quadrants) {
      const q = p.quadrants
      const cells: ['NE' | 'NO' | 'SE' | 'SO', number, number][] = [
        ['NO', S.x / 4, S.y / 4],
        ['NE', S.x / 4, (3 * S.y) / 4],
        ['SO', (3 * S.x) / 4, S.y / 4],
        ['SE', (3 * S.x) / 4, (3 * S.y) / 4],
      ]
      for (const [k, x, y] of cells) out.push({ id: `q-${k}`, pos: [x, y, S.z * 0.02], text: `${k} ${QUAD_FMT(q[k])}`, className: 'quad', z: 20 })
    }
    p.axles?.forEach((a, i) => {
      if (a.label) out.push({ id: `ax-${i}`, pos: [a.x, -260, -WHEEL_R * 2 - 160], text: a.label, className: 'axle', color: a.color, z: 22 })
    })
  }
  if (p.showLabels) {
    for (const b of p.bodies)
      if (b.label && !b.dim) out.push({ id: `b-${b.id}`, pos: [b.min.x + b.size.x / 2, b.min.y + b.size.y / 2, b.min.z + b.size.z + 30], text: `${b.locked ? '🔒 ' : ''}${b.label}`, z: 10 })
    if (p.cg) out.push({ id: 'cg', pos: [p.cg.x, p.cg.y, p.cg.z + Math.max(S.x, S.y) * 0.03], text: 'CG', color: '#d62728', z: 25 })
  }
  return out
}

export function Scene3D(p: Props) {
  const S = p.bounds.size
  const diag = Math.max(S.x, S.y, S.z)
  const labels = sceneLabels(p)
  const labelEls = useRef(new Map<string, HTMLDivElement>())
  return (
    // isolation: os z-index das etiquetas não "vazam" por cima dos painéis do editor (resumo, legenda, barra)
    <div style={{ position: 'relative', width: '100%', height: '100%', isolation: 'isolate' }}>
      <Canvas
        camera={{ fov: 40, near: 10, far: diag * 20, position: [S.x * 1.2, -S.y * 2.2, S.z * 2.2] }}
        onPointerMissed={(e) => e.button === 0 && p.onSelect(null, false)}
        dpr={[1, 2]}
      >
        <color attach="background" args={['#e9eef2']} />
        <ambientLight intensity={0.65} />
        <directionalLight position={[S.x, -S.y * 2, S.z * 4]} intensity={0.9} />
        <directionalLight position={[-S.x, S.y * 2, S.z * 2]} intensity={0.3} />
        <SceneContent {...p} />
        <LabelProjector labels={labels} els={labelEls} />
        {p.onCaptureReady && <CaptureBridge size={S} onReady={p.onCaptureReady} />}
        {p.onRecorderReady && <RecorderBridge size={S} onReady={p.onRecorderReady} />}
      </Canvas>
      <div className="labels3d">
        {labels.map((l) => (
          <div
            key={l.id}
            ref={(el) => {
              if (el) labelEls.current.set(l.id, el)
              else labelEls.current.delete(l.id)
            }}
            className={`tag3d ${l.className ?? ''}`}
            style={{ zIndex: l.z, color: l.color }}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Projeta cada etiqueta para a tela a cada quadro (escrita direta no estilo, sem re-render React). */
function LabelProjector({ labels, els }: { labels: Label3D[]; els: RefObject<Map<string, HTMLDivElement>> }) {
  const v = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    for (const l of labels) {
      const el = els.current.get(l.id)
      if (!el) continue
      v.set(l.pos[0], l.pos[1], l.pos[2]).project(camera)
      if (v.z < -1 || v.z > 1) {
        el.style.visibility = 'hidden'
        continue
      }
      el.style.visibility = 'visible'
      el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -50%)`
    }
  })
  return null
}

type Axis = 'x' | 'y' | 'z'
const AXIS_VEC: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
const AXIS_COLOR: Record<Axis, string> = { x: '#d62728', y: '#2ca02c', z: '#1f6feb' }

/** arrasto preso a UM ponteiro (o dedo que começou): outro dedo (pinça) devolve a caixa e vira zoom */
type Drag =
  | { mode: 'plane'; id: string; z: number; start: THREE.Vector3; startMin: Vec3; pointerId: number }
  | { mode: 'axis'; id: string; axis: Axis; origin: THREE.Vector3; t0: number; startMin: Vec3; pointerId: number }

/** Parâmetro t do ponto da reta (origin + t·axis) mais próximo do raio do mouse; null se quase paralelos. */
function axisParam(ray: THREE.Ray, origin: THREE.Vector3, axis: THREE.Vector3): number | null {
  const w = ray.origin.clone().sub(origin)
  const b = axis.dot(ray.direction)
  const den = 1 - b * b
  if (den < 1e-4) return null
  return (axis.dot(w) - b * ray.direction.dot(w)) / den
}

function SceneContent(p: Props) {
  const S = p.bounds.size
  // eslint-disable-next-line react-hooks/exhaustive-deps -- depende só do tipo e das medidas do espaço
  const sideOf = useMemo(() => outwardSide(p.bounds), [p.bounds.kind, S.x, S.y])
  const diag = Math.max(S.x, S.y, S.z)
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const { camera } = useThree()
  const [drag, setDrag] = useState<Drag | null>(null)
  const center = useMemo(() => new THREE.Vector3(S.x / 2, S.y / 2, S.z / 3), [S.x, S.y, S.z])

  // Vistas predefinidas
  useEffect(() => {
    const d = Math.max(S.x, S.y * 2, S.z * 2)
    const pos: Record<ViewPreset, [number, number, number]> = {
      persp: [S.x * 1.15, -S.y * 2.4, S.z * 2.4],
      top: [S.x / 2, S.y / 2 - 1, d * 1.6],
      side: [S.x / 2, -d * 1.3, S.z / 2],
      front: [S.x + d * 1.1, S.y / 2, S.z / 2],
      rear: [-d * 1.1, S.y / 2, S.z / 2],
    }
    camera.position.set(...pos[p.view])
    camera.up.set(0, 0, 1)
    const target = p.view === 'persp' ? center : new THREE.Vector3(S.x / 2, S.y / 2, p.view === 'top' ? 0 : S.z / 2)
    camera.lookAt(target)
    controls.current?.target.copy(target)
    controls.current?.update()
  }, [p.view, p.viewNonce, S.x, S.y, S.z, camera, center])

  // toque (celular): a seleção acontece ao SOLTAR sem arrastar; deslizar o dedo só gira a vista
  const tap = useRef<{ id: string; x: number; y: number } | null>(null)
  const onDown = (b: SceneBody) => (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    if (drag && e.pointerId !== drag.pointerId) return // outro dedo durante o arrasto: tratado em abortDrag
    // a seta do manipulador tem prioridade mesmo atrás de outras caixas (é desenhada por cima)
    if (e.intersections.some((i) => i.object.userData.gizmo)) return
    e.stopPropagation()
    tap.current = null
    if (e.pointerType === 'touch' && !b.selected) {
      tap.current = { id: b.id, x: e.clientX, y: e.clientY }
      return
    }
    p.onSelect(b.id, e.shiftKey || e.ctrlKey)
    // só arrasta quando dá para editar; no toque, só uma caixa já selecionada (tocada antes) é arrastada
    if (b.locked || !p.gizmo) return
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.min.z)
    const hit = new THREE.Vector3()
    if (!e.ray.intersectPlane(plane, hit)) return
    setDrag({ mode: 'plane', id: b.id, z: b.min.z, start: hit, startMin: { ...b.min }, pointerId: e.pointerId })
    p.onDragStart?.(b.id)
  }
  const onUp = (b: SceneBody) => (e: ThreeEvent<PointerEvent>) => {
    const t = tap.current
    tap.current = null
    if (!t || t.id !== b.id || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 8) return
    e.stopPropagation()
    p.onSelect(b.id, false)
  }
  const onAxisDown = (b: SceneBody, axis: Axis, origin: THREE.Vector3) => (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return
    if (drag && e.pointerId !== drag.pointerId) return
    e.stopPropagation()
    const t0 = axisParam(e.ray, origin, AXIS_VEC[axis])
    if (t0 == null) return
    setDrag({ mode: 'axis', id: b.id, axis, origin, t0, startMin: { ...b.min }, pointerId: e.pointerId })
    p.onDragStart?.(b.id)
  }

  const step = p.snapMm > 1 ? p.snapMm : 1
  const snap = (v: number) => Math.round(v / step) * step
  const onDragMove = (e: ThreeEvent<PointerEvent>) => {
    if (!drag || e.pointerId !== drag.pointerId) return
    e.stopPropagation()
    if (drag.mode === 'plane') {
      const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -drag.z)
      const hit = new THREE.Vector3()
      if (!e.ray.intersectPlane(plane, hit)) return
      p.onMove(drag.id, { x: snap(drag.startMin.x + hit.x - drag.start.x), y: snap(drag.startMin.y + hit.y - drag.start.y), z: drag.startMin.z }, 'plane')
      return
    }
    const t = axisParam(e.ray, drag.origin, AXIS_VEC[drag.axis])
    if (t == null) return
    const m = { ...drag.startMin }
    m[drag.axis] = drag.startMin[drag.axis] + snap(t - drag.t0)
    p.onMove(drag.id, m, 'axis')
  }
  const endDrag = (e?: { pointerId: number }) => {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return
    p.onDragEnd?.(drag.id)
    setDrag(null)
  }
  // 2º dedo (pinça) durante o arrasto: devolve a caixa e passa o gesto para a câmera (zoom)
  const abortDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId === drag.pointerId) return
    p.onMove(drag.id, drag.startMin, 'axis')
    p.onDragEnd?.(drag.id)
    setDrag(null)
    if (controls.current) controls.current.enabled = true
  }
  // soltar fora do canvas (ou o sistema cancelar o toque) também encerra o arrasto (validação no editor)
  useEffect(() => {
    if (!drag) return
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    window.addEventListener('pointerdown', abortDrag, true)
    return () => {
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      window.removeEventListener('pointerdown', abortDrag, true)
    }
  })

  // manipulador: só com um corpo selecionado, editável e não travado
  const selectable = p.gizmo ? p.bodies.filter((b) => b.selected && !b.locked && !b.dim) : []
  const gizmoBody = selectable.length === 1 ? selectable[0] : null

  return (
    <>
      {/* esquerdo gira; direito / roda pressionada / Shift+esquerdo deslocam a vista em paralelo; roda aproxima no cursor */}
      <OrbitControls
        ref={controls}
        makeDefault
        enabled={!drag}
        target={center}
        enableDamping={false}
        screenSpacePanning
        zoomToCursor
        maxDistance={diag * 6}
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN }}
      />
      <Bounds {...p} />
      {p.bodies.map((b) => (
        <Body key={b.id} b={b} onDown={onDown(b)} onUp={onUp(b)} onDouble={() => p.onDoubleClick?.(b.id)} showPrint={p.showPrint ?? false} sideOf={sideOf} />
      ))}
      {gizmoBody && (!drag || drag.id === gizmoBody.id) && <AxisGizmo b={gizmoBody} active={drag?.mode === 'axis' ? drag.axis : null} onAxisDown={onAxisDown} />}
      {p.cg && (
        <group position={[p.cg.x, p.cg.y, p.cg.z]} userData={{ overlay: 'cg' }}>
          <mesh>
            <sphereGeometry args={[Math.max(S.x, S.y) * 0.012, 16, 16]} />
            <meshBasicMaterial color="#d62728" />
          </mesh>
          <Line points={[[0, 0, -p.cg.z], [0, 0, 0]]} color="#d62728" lineWidth={1} dashed dashSize={40} gapSize={30} />
        </group>
      )}
      {drag && (
        // "captura" invisível em volta de tudo: todo raio do mouse a atinge enquanto o arrasto durar
        <mesh position={[S.x / 2, S.y / 2, S.z / 2]} onPointerMove={onDragMove}>
          <sphereGeometry args={[diag * 12, 16, 12]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.BackSide} />
        </mesh>
      )}
    </>
  )
}

/**
 * Manipulador de 3 setas (vermelha = X/comprimento, verde = Y/largura, azul = Z/altura) saindo das
 * faces do corpo selecionado. Desenhado por cima de tudo (sem teste de profundidade) para ser sempre
 * clicável; arrastar uma seta move o corpo só naquele eixo.
 */
function AxisGizmo({ b, active, onAxisDown }: { b: SceneBody; active: Axis | null; onAxisDown: (b: SceneBody, axis: Axis, origin: THREE.Vector3) => (e: ThreeEvent<PointerEvent>) => void }) {
  const [hover, setHover] = useState<Axis | null>(null)
  const L = Math.min(900, Math.max(320, Math.max(b.size.x, b.size.y, b.size.z) * 0.6))
  const c = { x: b.min.x + b.size.x / 2, y: b.min.y + b.size.y / 2, z: b.min.z + b.size.z / 2 }
  const bases: Record<Axis, THREE.Vector3> = {
    x: new THREE.Vector3(b.min.x + b.size.x, c.y, c.z),
    y: new THREE.Vector3(c.x, b.min.y + b.size.y, c.z),
    z: new THREE.Vector3(c.x, c.y, b.min.z + b.size.z),
  }
  // cilindro/cone do three apontam para +Y: rotação para cada eixo
  const rot: Record<Axis, [number, number, number]> = { x: [0, 0, -Math.PI / 2], y: [0, 0, 0], z: [Math.PI / 2, 0, 0] }
  return (
    <>
      {(['x', 'y', 'z'] as Axis[]).map((a) => {
        const lit = active === a || hover === a
        const color = lit ? '#f5b800' : AXIS_COLOR[a]
        const mat = <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
        return (
          <group
            key={a}
            position={bases[a]}
            rotation={rot[a]}
            renderOrder={1000}
            onPointerDown={onAxisDown(b, a, bases[a])}
            onPointerOver={(e) => {
              e.stopPropagation()
              setHover(a)
            }}
            onPointerOut={() => setHover((h) => (h === a ? null : h))}
          >
            <mesh position={[0, L * 0.4, 0]} renderOrder={1000} userData={{ gizmo: true }}>
              <cylinderGeometry args={[L * 0.025, L * 0.025, L * 0.8, 10]} />
              {mat}
            </mesh>
            <mesh position={[0, L * 0.9, 0]} renderOrder={1000} userData={{ gizmo: true }}>
              <coneGeometry args={[L * 0.08, L * 0.2, 16]} />
              {mat}
            </mesh>
            {/* área de pega mais grossa (invisível) */}
            <mesh position={[0, L * 0.5, 0]} userData={{ gizmo: true }}>
              <cylinderGeometry args={[L * 0.1, L * 0.1, L, 8]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} depthTest={false} />
            </mesh>
          </group>
        )
      })}
    </>
  )
}

/** lonas (SKU LS-…) são ROLOS dentro da caixa: nas pontas aparece o rolo e o cone (furo) onde a lona é enrolada */
const isRollSku = (sku?: string) => Boolean(sku && /^LS-/i.test(sku))

function RollEnds({ min, size }: { min: Vec3; size: Vec3 }) {
  // eixo do rolo = o maior lado no plano (a caixa deita no comprimento do rolo)
  const alongX = size.x >= size.y
  const cross = Math.min(alongX ? size.y : size.x, size.z)
  const rRoll = cross * 0.46
  const rCore = cross * 0.17
  const cy = min.y + size.y / 2, cx = min.x + size.x / 2, cz = min.z + size.z / 2
  const ends: [number, number, number][] = alongX ? [[min.x - 1, cy, cz], [min.x + size.x + 1, cy, cz]] : [[cx, min.y - 1, cz], [cx, min.y + size.y + 1, cz]]
  const rot: [number, number, number] = alongX ? [0, Math.PI / 2, 0] : [Math.PI / 2, 0, 0]
  return (
    <>
      {ends.map((p, i) => (
        <group key={i} position={p} rotation={rot}>
          <mesh>
            <ringGeometry args={[rCore, rRoll, 40]} />
            <meshBasicMaterial color="#e8e2d4" side={THREE.DoubleSide} transparent opacity={0.9} />
          </mesh>
          <mesh position={[0, 0, 0.5]}>
            <circleGeometry args={[rCore, 32]} />
            <meshBasicMaterial color="#3b3127" side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </>
  )
}

function Box({ min, size, color, opacity = 1, edge = '#1f2a33', edgeOpacity = 0.55, print, brand, sideOf, roll }: SubBox & { edge?: string; edgeOpacity?: number; sideOf?: SideOf; roll?: boolean }) {
  return (
    <>
      {roll && <RollEnds min={min} size={size} />}
      <mesh position={[min.x + size.x / 2, min.y + size.y / 2, min.z + size.z / 2]}>
        <boxGeometry args={[size.x, size.y, size.z]} />
        <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} roughness={0.8} />
        <Edges color={edge} transparent opacity={edgeOpacity} />
      </mesh>
      {(print || brand) && <BoxPrint min={min} size={size} text={print} brand={brand} side={brand && sideOf ? sideOf(min, size) : 0} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// Impressão na caixa: etiqueta com o SKU nas 4 faces laterais (texturas compartilhadas por texto/proporção)
// ---------------------------------------------------------------------------

const UNIT_PLANE = new THREE.PlaneGeometry(1, 1)
/** cache de UI (só no navegador): uma textura/material por texto e proporção da face */
const PRINT_MATERIALS = new Map<string, THREE.Material>()

function printMaterial(text: string, aspect: number, brandLine = true): THREE.Material {
  const a = Math.min(8, Math.max(0.25, Math.round(aspect * 4) / 4))
  const key = `${text}|${a}|${brandLine}`
  const cached = PRINT_MATERIALS.get(key)
  if (cached) return cached
  const w = 768
  const h = Math.max(96, Math.round(w / a))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const lw = w * 0.78
  const lh = Math.min(h * 0.62, lw * 0.42)
  const x = (w - lw) / 2, y = (h - lh) / 2
  g.fillStyle = 'rgba(255,255,255,0.93)'
  g.strokeStyle = '#1f2a33'
  g.lineWidth = Math.max(2, lh * 0.04)
  g.beginPath()
  g.roundRect(x, y, lw, lh, lh * 0.12)
  g.fill()
  g.stroke()
  g.fillStyle = '#1f2a33'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  let fs = lh * 0.44
  g.font = `bold ${fs}px Arial, sans-serif`
  while (g.measureText(text).width > lw * 0.9 && fs > 8) {
    fs -= 2
    g.font = `bold ${fs}px Arial, sans-serif`
  }
  g.fillText(text, w / 2, y + lh * (brandLine ? 0.42 : 0.5))
  if (brandLine) {
    g.font = `${Math.max(8, lh * 0.2)}px Arial, sans-serif`
    g.fillText('PACIFIL', w / 2, y + lh * 0.8)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const m = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.4, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 })
  PRINT_MATERIALS.set(key, m)
  return m
}

/** Face lateral da caixa: 0 = −y (OESTE), 1 = +x (SUL/traseira), 2 = +y (LESTE), 3 = −x (NORTE/frente). */
type Side = 0 | 1 | 2 | 3
type SideOf = (min: Vec3, size: Vec3) => Side

/**
 * Lado do adesivo voltado para FORA: no contêiner/caminhão, a parede lateral ou a porta mais próxima
 * (nunca a cabine do motorista); no palete / volumes soltos, a borda externa mais próxima do conjunto.
 * Só faces com largura suficiente para o adesivo.
 */
function outwardSide(bounds: SceneBounds): SideOf {
  const S = bounds.size
  return (min, size) => {
    const cx = min.x + size.x / 2, cy = min.y + size.y / 2
    const c: [number, Side][] = [[cy, 0], [S.y - cy, 2], [S.x - cx, 1]]
    if (bounds.kind === 'pallet') c.push([cx, 3])
    c.sort((a, b) => a[0] - b[0])
    const wide = c.find(([, sd]) => (sd === 0 || sd === 2 ? size.x : size.y) >= 200)
    return (wide ?? c[0])[1]
  }
}

/** cache de UI: um material por imagem de adesivo (textura carregada uma vez) */
const BRAND_MATERIALS = new Map<string, THREE.Material>()

function brandMaterial(src: string): THREE.Material {
  const cached = BRAND_MATERIALS.get(src)
  if (cached) return cached
  const tex = new THREE.TextureLoader().load(src)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3 })
  BRAND_MATERIALS.set(src, m)
  return m
}

/** Placa branca do código (abaixo do adesivo): borda escura, texto em negrito centralizado. */
const PLATE_MATERIALS = new Map<string, THREE.Material>()

function plateMaterial(text: string, aspect: number): THREE.Material {
  const a = Math.min(12, Math.max(1, Math.round(aspect * 4) / 4))
  const key = `${text}|${a}`
  const cached = PLATE_MATERIALS.get(key)
  if (cached) return cached
  const w = 1024
  const h = Math.max(64, Math.round(w / a))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const bw = Math.max(4, h * 0.07)
  g.fillStyle = '#f4f5f6'
  g.strokeStyle = '#111'
  g.lineWidth = bw
  g.beginPath()
  g.roundRect(bw / 2, bw / 2, w - bw, h - bw, h * 0.16)
  g.fill()
  g.stroke()
  g.fillStyle = '#111'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  let fs = h * 0.56
  g.font = `bold ${fs}px Arial, sans-serif`
  while (g.measureText(text).width > w * 0.88 && fs > 8) {
    fs -= 2
    g.font = `bold ${fs}px Arial, sans-serif`
  }
  g.fillText(text, w / 2, h / 2 + fs * 0.04)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -3 })
  PLATE_MATERIALS.set(key, m)
  return m
}

/**
 * Face com o adesivo da marca (a voltada para fora, ver outwardSide), como na caixa real: adesivo centralizado (tamanho real,
 * reduzido se não couber) e, logo abaixo, a placa com o código do produto, também centralizada.
 * O conjunto fica centralizado na face.
 */
function brandFace(faceW: number, faceH: number, art: BrandArt, withText: boolean) {
  const plateH = withText ? Math.min(Math.max(faceH * 0.16, 36), 110) : 0
  const gap = withText ? Math.max(6, faceH * 0.03) : 0
  const s = Math.min(1, (faceW * 0.86) / art.wMm, (faceH * 0.9 - plateH - gap) / art.hMm)
  const lw = art.wMm * s, lh = art.hMm * s
  const plateW = Math.min(faceW * 0.9, Math.max(lw, plateH * 4))
  const total = lh + gap + plateH
  return { lw, lh, lz: total / 2 - lh / 2, plate: withText ? { w: plateW, h: plateH, z: -total / 2 + plateH / 2 } : null }
}

function BoxPrint({ min, size, text, brand, side = 0 }: { min: Vec3; size: Vec3; text?: string; brand?: BrandArt; side?: Side }) {
  if (size.z < 60) return null
  // cada face: rotação em z de um plano montado na face -y (u → x, v → z: texto em pé e legível de fora)
  const faces = [
    { rot: 0, w: size.x, d: size.y },
    { rot: Math.PI / 2, w: size.y, d: size.x },
    { rot: Math.PI, w: size.x, d: size.y },
    { rot: -Math.PI / 2, w: size.y, d: size.x },
  ]
  return (
    <group position={[min.x + size.x / 2, min.y + size.y / 2, min.z + size.z / 2]}>
      {faces.map((f, i) => {
        if (f.w < 150) return null
        const bf = i === side && brand && f.w >= 200 ? brandFace(f.w, size.z, brand, Boolean(text)) : null
        return (
          <group key={i} rotation={[0, 0, f.rot]}>
            {bf ? (
              <>
                <mesh geometry={UNIT_PLANE} material={brandMaterial(brand!.src)} position={[0, -f.d / 2 - 1.5, bf.lz]} rotation={[Math.PI / 2, 0, 0]} scale={[bf.lw, bf.lh, 1]} />
                {text && bf.plate && <mesh geometry={UNIT_PLANE} material={plateMaterial(text, bf.plate.w / bf.plate.h)} position={[0, -f.d / 2 - 1.5, bf.plate.z]} rotation={[Math.PI / 2, 0, 0]} scale={[bf.plate.w, bf.plate.h, 1]} />}
              </>
            ) : (
              text && <mesh geometry={UNIT_PLANE} material={printMaterial(text, f.w / size.z, !brand)} position={[0, -f.d / 2 - 1, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[f.w, size.z, 1]} />
            )}
          </group>
        )
      })}
    </group>
  )
}

function Body({ b, onDown, onUp, onDouble, showPrint, sideOf }: { b: SceneBody; onDown: (e: ThreeEvent<PointerEvent>) => void; onUp: (e: ThreeEvent<PointerEvent>) => void; onDouble: () => void; showPrint: boolean; sideOf: SideOf }) {
  const hl = b.invalid ? '#d62728' : b.selected ? '#0b6e4f' : b.staged ? '#f28c00' : null
  // atenuado: só contexto (não recebe cliques; os cliques atravessam até o que está em edição)
  if (b.dim)
    return (
      <group>
        {(b.parts ?? [{ min: b.min, size: b.size, color: b.color }]).map((s, i) => (
          <Box key={i} {...s} opacity={0.15} edgeOpacity={0.15} />
        ))}
      </group>
    )
  return (
    <group
      userData={{ bodyId: b.id }}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onDouble()
      }}
    >
      {b.parts ? (
        b.parts.map((s, i) => <Box key={i} {...s} roll={isRollSku(s.print)} opacity={b.staged ? 0.55 : s.opacity} print={showPrint ? s.print : undefined} brand={showPrint ? s.brand : undefined} sideOf={sideOf} />)
      ) : (
        <Box min={b.min} size={b.size} color={b.color} roll={isRollSku(b.print)} opacity={b.staged ? 0.55 : 1} edge={b.invalid ? '#d62728' : '#1f2a33'} edgeOpacity={b.invalid ? 1 : 0.55} print={showPrint ? b.print : undefined} brand={showPrint ? b.brand : undefined} sideOf={sideOf} />
      )}
      {(hl || b.parts) && (
        <mesh position={[b.min.x + b.size.x / 2, b.min.y + b.size.y / 2, b.min.z + b.size.z / 2]}>
          <boxGeometry args={[b.size.x + 4, b.size.y + 4, b.size.z + 4]} />
          <meshBasicMaterial transparent opacity={hl ? 0.12 : 0} color={hl ?? '#000'} depthWrite={false} />
          {hl && <Edges color={hl} lineWidth={2} />}
        </mesh>
      )}
    </group>
  )
}

function Bounds(p: Props) {
  const { size: S, kind, door, deck, limitBox } = p.bounds
  const wallMat = { color: '#9aa9b5', transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false } as const
  const edges: [number, number, number][][] = [
    [[0, 0, 0], [S.x, 0, 0], [S.x, S.y, 0], [0, S.y, 0], [0, 0, 0]],
    [[0, 0, S.z], [S.x, 0, S.z], [S.x, S.y, S.z], [0, S.y, S.z], [0, 0, S.z]],
    [[0, 0, 0], [0, 0, S.z]],
    [[S.x, 0, 0], [S.x, 0, S.z]],
    [[S.x, S.y, 0], [S.x, S.y, S.z]],
    [[0, S.y, 0], [0, S.y, S.z]],
  ]
  if (kind === 'pallet') {
    return (
      <>
        {deck && <Box min={{ x: 0, y: 0, z: 0 }} size={deck.size} color={deck.color} />}
        {limitBox && <OutlineBox min={limitBox.min} size={limitBox.size} color="#8a97a3" dashed />}
        <gridHelper args={[Math.max(S.x, S.y) * 3, 30, '#b8c3cc', '#d3dbe1']} rotation={[Math.PI / 2, 0, 0]} position={[S.x / 2, S.y / 2, -1]} />
      </>
    )
  }
  const dy0 = door ? (S.y - door.w) / 2 : 0
  return (
    <>
      {/* zona de trabalho em volta do equipamento (paletes fora da carga, pendentes de ubicação) */}
      <gridHelper args={[Math.max(S.x, S.y) * 1.6, 32, '#c3ccd3', '#d9e0e5']} rotation={[Math.PI / 2, 0, 0]} position={[S.x / 2, S.y / 2, -3]} />
      {/* piso */}
      <mesh position={[S.x / 2, S.y / 2, -1]}>
        <planeGeometry args={[S.x, S.y]} />
        <meshStandardMaterial color="#c9b79c" />
      </mesh>
      {p.showWalls && (
        <>
          <mesh position={[S.x / 2, 0, S.z / 2]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[S.x, S.z]} />
            <meshStandardMaterial {...wallMat} />
          </mesh>
          <mesh position={[S.x / 2, S.y, S.z / 2]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[S.x, S.z]} />
            <meshStandardMaterial {...wallMat} />
          </mesh>
          <mesh position={[0, S.y / 2, S.z / 2]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[S.z, S.y]} />
            <meshStandardMaterial {...wallMat} />
          </mesh>
        </>
      )}
      {p.showRoof && (
        <mesh position={[S.x / 2, S.y / 2, S.z]}>
          <planeGeometry args={[S.x, S.y]} />
          <meshStandardMaterial {...wallMat} />
        </mesh>
      )}
      {edges.map((pts, i) => (
        <Line key={i} points={pts} color="#5b6b78" lineWidth={1} />
      ))}
      {door && (
        <Line
          points={[[S.x, dy0, 0], [S.x, dy0, door.h], [S.x, dy0 + door.w, door.h], [S.x, dy0 + door.w, 0]]}
          color="#0b6e4f"
          lineWidth={2.5}
        />
      )}
      {/* rótulos NORTE/SUL/LESTE/OESTE: camada HTML (sceneLabels) */}
      {/* seta da cabine no piso, à frente da parede frontal (aparece também nas imagens do PDF) */}
      <mesh position={[-Math.min(450, S.x * 0.04), S.y / 2, 0]} rotation={[0, 0, Math.PI]}>
        <circleGeometry args={[Math.min(380, S.y * 0.16), 3]} />
        <meshBasicMaterial color="#1f6feb" side={THREE.DoubleSide} />
      </mesh>
      <group userData={{ overlay: 'quadrants' }}>
        <QuadrantOverlay size={S} pct={p.quadrants ?? null} />
      </group>
      {p.axles && p.axles.length > 0 && (
        <group userData={{ overlay: 'axles' }}>
          <Axles size={S} marks={p.axles} />
        </group>
      )}
      {/* régua a cada metro */}
      {Array.from({ length: Math.floor(S.x / 1000) }, (_, i) => (i + 1) * 1000).map((x) => (
        <Line key={x} points={[[x, -40, 0], [x, 0, 0]]} color="#5b6b78" lineWidth={1} />
      ))}
    </>
  )
}

const WHEEL_R = 480

/** Rodoviário: longarina e rodas sob o piso; cada eixo com a cor do estado do seu conjunto (ok/perto/acima). */
function Axles({ size: S, marks }: { size: Vec3; marks: AxleMark[] }) {
  const x0 = Math.min(0, ...marks.map((m) => m.x)) - 700
  const x1 = Math.max(S.x, ...marks.map((m) => m.x)) + 300
  return (
    <>
      <mesh position={[(x0 + x1) / 2, S.y / 2, -170]}>
        <boxGeometry args={[x1 - x0, Math.min(1000, S.y * 0.4), 220]} />
        <meshStandardMaterial color="#4a5560" />
      </mesh>
      {marks.map((m, i) =>
        [WHEEL_R * 0.55, S.y - WHEEL_R * 0.55].map((y) => (
          <mesh key={`${i}-${y}`} position={[m.x, y, -WHEEL_R - 40]}>
            <cylinderGeometry args={[WHEEL_R, WHEEL_R, 300, 28]} />
            <meshStandardMaterial color={m.color} />
          </mesh>
        )),
      )}
    </>
  )
}

/** Linhas N/S (x = L/2) e O/L (y = W/2) no piso; as % de cada quadrante vão na camada HTML (sceneLabels). */
function QuadrantOverlay({ size: S, pct }: { size: Vec3; pct: Record<'NE' | 'NO' | 'SE' | 'SO', number> | null }) {
  const z = 4
  return (
    <>
      <Line visible={Boolean(pct)} points={[[S.x / 2, 0, z], [S.x / 2, S.y, z]]} color="#7c3aed" lineWidth={2.5} dashed dashSize={80} gapSize={50} />
      <Line visible={Boolean(pct)} points={[[0, S.y / 2, z], [S.x, S.y / 2, z]]} color="#7c3aed" lineWidth={2.5} dashed dashSize={80} gapSize={50} />
    </>
  )
}

function OutlineBox({ min, size, color, dashed }: { min: Vec3; size: Vec3; color: string; dashed?: boolean }) {
  const [x0, y0, z0] = [min.x, min.y, min.z]
  const [x1, y1, z1] = [min.x + size.x, min.y + size.y, min.z + size.z]
  const segs: [number, number, number][][] = [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]],
    [[x0, y0, z0], [x0, y0, z1]],
    [[x1, y0, z0], [x1, y0, z1]],
    [[x1, y1, z0], [x1, y1, z1]],
    [[x0, y1, z0], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]],
  ]
  return (
    <>
      {segs.map((pts, i) => (
        <Line key={i} points={pts} color={color} lineWidth={1} dashed={dashed} dashSize={30} gapSize={20} />
      ))}
    </>
  )
}

/**
 * Captura determinística de vistas para documentos: renderiza a cena com câmeras próprias
 * (sem mexer na câmera do usuário) num tamanho fixo e devolve imagens JPEG (data URL).
 */
function CaptureBridge({ size: S, onReady }: { size: Vec3; onReady: (fn: CaptureFn) => void }) {
  const { gl, scene } = useThree()
  useEffect(() => {
    const fn: CaptureFn = (views, opts) => {
      const w = opts?.width ?? 1600
      const h = opts?.height ?? 900
      const prevSize = new THREE.Vector2()
      gl.getSize(prevSize)
      const prevRatio = gl.getPixelRatio()
      gl.setPixelRatio(1)
      gl.setSize(w, h, false)
      const d = Math.max(S.x, S.y * 2, S.z * 2)
      const out: string[] = []
      // esconde durante a captura: setas de mover (gizmo); na sequência de carregamento, os corpos fora do passo
      // e os indicadores da carga inteira (CG, quadrantes, eixos); sem overlays, o CG e os quadrantes
      const hidden: THREE.Object3D[] = []
      const keep = opts?.only ? new Set(opts.only) : null
      const noOverlays = keep != null || opts?.overlays === false
      scene.traverse((o) => {
        const ov = o.userData.overlay
        const drop =
          o.userData.gizmo === true ||
          (keep != null && typeof o.userData.bodyId === 'string' && !keep.has(o.userData.bodyId)) ||
          (noOverlays && (ov === 'cg' || ov === 'quadrants')) ||
          (keep != null && ov === 'axles')
        if (drop && o.visible) {
          o.visible = false
          hidden.push(o)
        }
      })
      for (const v of views) {
        const cam = new THREE.PerspectiveCamera(30, w / h, 10, d * 30)
        cam.up.set(0, 0, 1)
        // enquadra o equipamento inteiro: distância pela esfera envolvente e o menor campo de visão
        const target = new THREE.Vector3(S.x / 2, S.y / 2, S.z / 2)
        const r = 0.5 * Math.sqrt(S.x * S.x + S.y * S.y + S.z * S.z)
        const vfov = THREE.MathUtils.degToRad(cam.fov)
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect)
        // esfera envolvente é conservadora para um contêiner comprido: aproxima ~25%
        const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * VIEW_DIR[v].zoom
        const dir = new THREE.Vector3(...VIEW_DIR[v].dir)
        cam.position.copy(target).add(dir.normalize().multiplyScalar(dist))
        cam.lookAt(target)
        cam.updateProjectionMatrix()
        gl.render(scene, cam)
        out.push(gl.domElement.toDataURL('image/jpeg', 0.88))
      }
      for (const o of hidden) o.visible = true
      gl.setPixelRatio(prevRatio)
      gl.setSize(prevSize.x, prevSize.y, false)
      return out
    }
    onReady(fn)
  }, [gl, scene, S.x, S.y, S.z, onReady])
  return null
}

/**
 * Gravação do giro de 360°: câmera em órbita em volta do centro da carga, elevação ~25°, distância
 * fixa que enquadra o equipamento inteiro; velocidade suave (acelera no início e freia no fim, sem
 * trancos). Renderiza com câmera própria num tamanho fixo e devolve cada quadro ao chamador.
 */
function RecorderBridge({ size: S, onReady }: { size: Vec3; onReady: (rec: OrbitRecorder) => void }) {
  const { gl, scene } = useThree()
  const setFrameloop = useThree((st) => st.setFrameloop)
  useEffect(() => {
    const rec: OrbitRecorder = async ({ width: w, height: h, intro, stepFrames, holdFrames, orbitFrames, transitionFrames, zoomFrames, onFrame }) => {
      const prevSize = new THREE.Vector2()
      gl.getSize(prevSize)
      const prevRatio = gl.getPixelRatio()
      // corpos da cena (grupo de cada unidade) para a animação de entrada
      const groups = new Map<string, THREE.Object3D>()
      scene.traverse((o) => {
        if (typeof o.userData.bodyId === 'string') groups.set(o.userData.bodyId, o)
      })
      const steps = intro.map((ids) => ids.map((id) => groups.get(id)).filter((o): o is THREE.Object3D => Boolean(o))).filter((x) => x.length)
      const moving = steps.flat()
      const startX = new Map(moving.map((o) => [o, new THREE.Box3().setFromObject(o).min.x]))
      // volume ocupado pela carga (alvo do giro aproximado)
      const cargo = new THREE.Box3()
      for (const o of groups.values()) cargo.union(new THREE.Box3().setFromObject(o))
      setFrameloop('never')
      try {
        gl.setPixelRatio(1)
        gl.setSize(w, h, false)
        const target = new THREE.Vector3(S.x / 2, S.y / 2, S.z * 0.38)
        const r = 0.5 * Math.sqrt(S.x * S.x + S.y * S.y + S.z * S.z)
        const cam = new THREE.PerspectiveCamera(32, w / h, 10, r * 40)
        cam.up.set(0, 0, 1)
        const vfov = THREE.MathUtils.degToRad(cam.fov)
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect)
        const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 0.72
        // giro aproximado: centro da carga, a ~metade da distância (os produtos e as etiquetas ficam legíveis)
        const zTarget = cargo.isEmpty() ? target.clone() : new THREE.Vector3((cargo.min.x + cargo.max.x) / 2, S.y / 2, Math.max(0, cargo.max.z) * 0.45)
        const zDist = dist * 0.5
        const elev = THREE.MathUtils.degToRad(25), zElev = THREE.MathUtils.degToRad(18)
        // começa pela vista de 3/4 da PORTA (lado oeste): as unidades entram por ali
        const a0 = Math.atan2(-1, 0.75)
        const ease = (t: number) => t - Math.sin(2 * Math.PI * t) / (2 * Math.PI)
        const smooth = (t: number) => t * t * (3 - 2 * t)
        const shoot = (a: number, d: number, el: number, tg: THREE.Vector3) => {
          cam.position.set(tg.x + Math.cos(a) * Math.cos(el) * d, tg.y + Math.sin(a) * Math.cos(el) * d, tg.z + Math.sin(el) * d)
          cam.lookAt(tg)
          cam.updateProjectionMatrix()
          gl.render(scene, cam)
        }
        const total = steps.length * stepFrames + (steps.length ? holdFrames : 0) + orbitFrames + transitionFrames + zoomFrames
        let i = 0
        // 1) entrada: cada passo desliza de fora da porta até a posição (desaceleração no fim)
        for (const o of moving) o.visible = false
        const slide = (o: THREE.Object3D) => S.x - (startX.get(o) ?? 0) + Math.max(1500, S.x * 0.12)
        for (let s = 0; s < steps.length; s++) {
          for (const o of steps[s]) o.visible = true
          for (let f = 0; f < stepFrames; f++) {
            const t = (f + 1) / stepFrames
            const k = 1 - Math.pow(1 - t, 3)
            for (const o of steps[s]) o.position.x = (1 - k) * slide(o)
            shoot(a0, dist, elev, target)
            await onFrame(i++, gl.domElement, { phase: 'intro', step: s, stepT: t, total })
          }
          for (const o of steps[s]) o.position.x = 0
        }
        if (steps.length)
          for (let f = 0; f < holdFrames; f++) {
            shoot(a0, dist, elev, target)
            await onFrame(i++, gl.domElement, { phase: 'hold', step: steps.length - 1, stepT: (f + 1) / holdFrames, total })
          }
        // 2) giro de 360° aberto
        for (let f = 0; f < orbitFrames; f++) {
          const t = orbitFrames > 1 ? f / (orbitFrames - 1) : 0
          shoot(a0 + 2 * Math.PI * ease(t), dist, elev, target)
          await onFrame(i++, gl.domElement, { phase: 'orbit', step: -1, stepT: t, total })
        }
        // 3) aproximação e giro de 360° perto da carga
        const tg = new THREE.Vector3()
        for (let f = 0; f < transitionFrames; f++) {
          const k = smooth((f + 1) / transitionFrames)
          tg.lerpVectors(target, zTarget, k)
          shoot(a0, dist + (zDist - dist) * k, elev + (zElev - elev) * k, tg)
          await onFrame(i++, gl.domElement, { phase: 'transition', step: -1, stepT: k, total })
        }
        for (let f = 0; f < zoomFrames; f++) {
          const t = zoomFrames > 1 ? f / (zoomFrames - 1) : 0
          shoot(a0 + 2 * Math.PI * ease(t), zDist, zElev, zTarget)
          await onFrame(i++, gl.domElement, { phase: 'zoom', step: -1, stepT: t, total })
        }
      } finally {
        for (const o of moving) {
          o.visible = true
          o.position.x = 0
        }
        gl.setPixelRatio(prevRatio)
        gl.setSize(prevSize.x, prevSize.y, false)
        setFrameloop('always')
      }
    }
    onReady(rec)
  }, [gl, scene, setFrameloop, S.x, S.y, S.z, onReady])
  return null
}

'use client'

import dynamic from 'next/dynamic'
import { useMemo, useState } from 'react'
import type { CourierLayout } from '@/domain/courier'
import { brandLabelFor } from '@/domain/brandLabels'
import { isRollPack } from '@/domain/packShape'
import type { CaptureFn, SceneBody, ViewPreset } from '../three/Scene3D'
import { ViewButtons } from '../editor/ui'

const Scene3D = dynamic(() => import('../three/Scene3D').then((m) => m.Scene3D), { ssr: false, loading: () => <div className="hint">Carregando 3D…</div> })

const noop = () => {}

/** Volumes do envio por courier em 3D (só visualização), numerados como na lista do PDF. */
export function CourierView({ layout, onCaptureReady }: { layout: CourierLayout; onCaptureReady?: (fn: CaptureFn) => void }) {
  const [view, setView] = useState<ViewPreset>('persp')
  const [nonce, setNonce] = useState(0)
  const [labels, setLabels] = useState(true)
  const bodies: SceneBody[] = useMemo(
    () => layout.boxes.map((b) => ({ id: `v${b.n}`, min: b.min, size: b.size, color: b.color, print: `${b.n} · ${b.sku}`, brand: brandLabelFor(b) ?? undefined, roll: isRollPack(b), label: String(b.n) })),
    [layout],
  )
  // um pouco de altura extra para a câmera enquadrar caixas baixas
  const size = { x: layout.size.x, y: layout.size.y, z: Math.max(layout.size.z, 400) }
  return (
    <div className="courier-3d">
      <div className="toolbar">
        <ViewButtons view={view} setView={(v) => (setView(v), setNonce((n) => n + 1))} views={['persp', 'top', 'side']} />
        <button className={`small ${labels ? 'active' : ''}`} onClick={() => setLabels((x) => !x)}>
          Números
        </button>
      </div>
      <Scene3D
        showPrint
        bounds={{ kind: 'pallet', size }}
        bodies={bodies}
        view={view}
        viewNonce={nonce}
        showWalls={false}
        showRoof={false}
        showLabels={labels}
        snapMm={10}
        onSelect={noop}
        onMove={noop}
        onCaptureReady={onCaptureReady}
      />
    </div>
  )
}

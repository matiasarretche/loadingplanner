import type { ExportEvent } from '../types'
import { fmtInstant } from './fmt'

/** quantos registros aparecem abertos; o resto fica em "Ver mais" */
const VISIBLE = 40

/**
 * Histórico do seguimento (linha do tempo, mais recente primeiro): "12/10/2026 14:03 — Pedido confirmado — Matías".
 * Sem usuário: integração (API) ou sistema. Dados recebidos de integração ou calculados levam uma etiqueta.
 */
export function History({ events }: { events: ExportEvent[] }) {
  if (!events.length) return <p className="muted">Nenhum registro ainda.</p>
  const first = events.slice(0, VISIBLE)
  const rest = events.slice(VISIBLE)
  return (
    <>
      <ul className="exp-timeline">
        {first.map((e) => (
          <Item key={e.id} e={e} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer' }} className="muted">
            Ver mais {rest.length} {rest.length === 1 ? 'registro' : 'registros'}
          </summary>
          <ul className="exp-timeline">
            {rest.map((e) => (
              <Item key={e.id} e={e} />
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

function Item({ e }: { e: ExportEvent }) {
  const who = e.userName ?? (e.source === 'API' ? 'Integração' : 'Sistema')
  return (
    <li style={{ flexWrap: 'wrap' }}>
      <span className="when">{fmtInstant(e.at)}</span>
      <span style={{ flex: '1 1 220px', minWidth: 0, overflowWrap: 'anywhere' }}>
        <span className="muted">— </span>
        {e.message}
        {e.source === 'API' && (
          <span className="exp-src api" title="Recebido de integração">
            API
          </span>
        )}
        {e.source === 'CALC' && (
          <span className="exp-src calc" title="Calculado pelo sistema">
            calculado
          </span>
        )}
      </span>
      <span className="who">— {who}</span>
    </li>
  )
}

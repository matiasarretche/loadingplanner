import { todayBR } from '@/domain/exportTracking'
import { requireUser } from '@/lib/auth'
import { canSeeExports, trackingRows } from '@/lib/exportTracking'
import { ExportsClient } from './ExportsClient'

/**
 * EXPORTAÇÕES EM CURSO: painel diário do seguimento das cargas de exportação confirmadas (uma linha por
 * contêiner/caminhão). As duas listas vêm juntas: o histórico (finalizadas/canceladas) também conta em
 * "Chegadas este mês". "Hoje" é calculado aqui (São Paulo) e passado à tela para servidor e navegador concordarem.
 */
export default async function ExportacoesPage({ searchParams }: PageProps<'/exportacoes'>) {
  const u = await requireUser()
  if (!canSeeExports(u))
    return (
      <div className="panel">
        <h1>Exportações em curso</h1>
        <p className="muted">Disponível só para a equipe da área de Exportação.</p>
      </div>
    )
  const sp = await searchParams
  const [active, history] = await Promise.all([trackingRows(u, 'active'), trackingRows(u, 'history')])
  return <ExportsClient active={active} history={history} today={todayBR()} initialTab={sp.aba === 'historico' ? 'history' : 'active'} />
}

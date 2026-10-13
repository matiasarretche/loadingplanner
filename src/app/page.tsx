import { requireUser } from '@/lib/auth'
import { userAreas } from '@/lib/areas'
import { dashboardRows } from '@/lib/dashboard'
import { can } from '@/lib/roles'
import { DashboardClient } from './DashboardClient'

/** Página principal: cargas das áreas do usuário (painel de acompanhamento, filtros, lista/tablero e atalho IA). */
export default async function Dashboard({ searchParams }: PageProps<'/'>) {
  const u = await requireUser()
  const sp = await searchParams
  const all = await dashboardRows(u)
  // Expedição: só cargas aprovadas
  const rows = u.role === 'WAREHOUSE_VIEWER' ? all.filter((r) => r.status === 'APPROVED' || r.approvedVersion != null) : all
  return (
    <DashboardClient
      rows={rows}
      me={{ id: u.id, areas: userAreas(u) }}
      canEdit={can.editPlans(u.role)}
      canApprove={can.approve(u.role)}
      permissionError={sp.erro === 'permissao'}
    />
  )
}

import { canAccessArea, type AreaUser } from './areas'

export type Role = 'ADMIN' | 'EXPORT_MANAGER' | 'EXPORT_ASSISTANT' | 'WAREHOUSE_VIEWER'

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrador principal (tudo, inclusive usuários)',
  EXPORT_MANAGER: 'Administrador secundário (aprova, catálogo, preços, cadastros)',
  EXPORT_ASSISTANT: 'Exportação (cria e edita cargas, PDFs com preço)',
  WAREHOUSE_VIEWER: 'Expedição (só cargas aprovadas, sem preços)',
}

export const ROLES = Object.keys(ROLE_LABEL) as Role[]

/** quem confirma pedidos e preenche o seguimento de exportações (datas, carregado, chegada…) */
const exportTeam = (r: Role) => r === 'ADMIN' || r === 'EXPORT_MANAGER' || r === 'EXPORT_ASSISTANT'

export const can = {
  manageUsers: (r: Role) => r === 'ADMIN',
  editCatalog: (r: Role) => r === 'ADMIN' || r === 'EXPORT_MANAGER',
  editPlans: (r: Role) => r !== 'WAREHOUSE_VIEWER',
  approve: (r: Role) => r === 'ADMIN' || r === 'EXPORT_MANAGER',
  /** preços, comissões, cotações e PDF do pedido (com preço): todos, menos Expedição */
  viewPrices: (r: Role) => r !== 'WAREHOUSE_VIEWER',
  /** fotos do carregamento: quem edita cargas e a Expedição (quem carrega tira as fotos) */
  uploadPhotos: (r: Role) => r === 'ADMIN' || r === 'EXPORT_MANAGER' || r === 'EXPORT_ASSISTANT' || r === 'WAREHOUSE_VIEWER',
  /** Exportações em curso: confirmar o pedido do cliente (cria a operação de seguimento) */
  confirmOrder: exportTeam,
  /** Exportações em curso: editar o seguimento (status, datas, booking, contêiner…) e desfazer a confirmação */
  editTracking: exportTeam,
}

export type Permission = keyof typeof can

/**
 * Módulo "Exportações em curso" (sem dependências de servidor: serve também às telas).
 * Ver: área EXPORTAÇÃO e qualquer papel menos Expedição (WAREHOUSE_VIEWER fica fora até ser decidido).
 * Editar/confirmar: além disso, papel ADMIN, EXPORT_MANAGER ou EXPORT_ASSISTANT (hoje = quem vê).
 */
export const canSeeExports = (u: AreaUser) => canAccessArea(u, 'EXPORT') && u.role !== 'WAREHOUSE_VIEWER'
export const canEditExports = (u: AreaUser) => canSeeExports(u) && can.editTracking(u.role)
export const canConfirmExports = (u: AreaUser) => canSeeExports(u) && can.confirmOrder(u.role)

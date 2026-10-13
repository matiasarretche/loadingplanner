/**
 * ÁREAS DE NEGÓCIO (sem dependências de servidor: usado também nas telas).
 * Cada carga pertence a uma área (pelo pedido/envio); cada usuário trabalha em uma ou mais áreas.
 * Regra: o usuário vê e edita as cargas das SUAS áreas (de qualquer criador); o ADMIN vê todas.
 * O "criado por" é informativo — não restringe permissão. Novas áreas: incluir no enum business_area.
 */
import type { Role } from './roles'

export type Area = 'EXPORT' | 'DOMESTIC'
export const AREAS: Area[] = ['EXPORT', 'DOMESTIC']
export const AREA_LABEL: Record<Area, string> = { EXPORT: 'Exportação', DOMESTIC: 'Mercado Interno' }

export interface AreaUser {
  role: Role
  areas: Area[]
}

/** Áreas visíveis para o usuário (ADMIN: todas). */
export function userAreas(u: AreaUser): Area[] {
  return u.role === 'ADMIN' ? AREAS : AREAS.filter((a) => u.areas.includes(a))
}

export function canAccessArea(u: AreaUser, area: Area): boolean {
  return userAreas(u).includes(area)
}

import { and, asc, eq, isNull, ne, or } from 'drizzle-orm'
import { db, schema } from '@/db'
import type { RoadOptions } from '@/components/editor/AxlePanel'
import { axleProfileSnapshot, carrierSnapshot, tractorSnapshot } from './snapshots'

/**
 * Veículos que servem de ESPAÇO DE CARGA (ativos e que não são chassi porta-contêiner).
 * O chassi só entra na distribuição por eixo das cargas em contêiner.
 */
export const cargoVehicleWhere = () =>
  and(eq(schema.vehicleTypes.active, true), or(isNull(schema.vehicleTypes.carrierKind), ne(schema.vehicleTypes.carrierKind, 'CHASSIS')))

/** Cadastros ativos para a distribuição por eixo (snapshots para o editor). */
export async function roadOptions(): Promise<RoadOptions> {
  const [tractors, vehicles, profiles] = await Promise.all([
    db.select().from(schema.roadTractors).where(eq(schema.roadTractors.active, true)).orderBy(asc(schema.roadTractors.code)),
    db.select().from(schema.vehicleTypes).where(eq(schema.vehicleTypes.active, true)).orderBy(asc(schema.vehicleTypes.code)),
    db.select().from(schema.axleLimitProfiles).where(eq(schema.axleLimitProfiles.active, true)).orderBy(asc(schema.axleLimitProfiles.code)),
  ])
  return {
    tractors: tractors.map(tractorSnapshot),
    carriers: vehicles.map(carrierSnapshot).filter((c) => c != null),
    profiles: profiles.map(axleProfileSnapshot),
  }
}

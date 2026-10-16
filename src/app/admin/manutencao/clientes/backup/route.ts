import { db, schema } from '@/db'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import { buildCustomersBackup, CUSTOMERS_BACKUP_ACTION } from '@/lib/maintenance/customersBackup'
import { routeUser } from '@/lib/routeAuth'
import { CROSS_SITE_ERROR, crossSiteRequest } from '../../sameOrigin'
import { fail } from '../upload'

/**
 * POST /admin/manutencao/clientes/backup — BACKUP (.json.gz) dos clientes atuais: linhas COMPLETAS da
 * tabela customer + os agentes e usuários citados. Só o administrador principal. O sha256 volta no cabeçalho
 * X-Backup-Sha256 e fica na auditoria ('backup_customers') com as quantidades e a impressão digital: a
 * planilha só é aplicada com esse backup (mesmo usuário, até 60 min, nenhum cliente alterado depois).
 */
export async function POST(req: Request) {
  const u = await routeUser('manageUsers', { denied: 'Só o administrador principal pode baixar este backup.' })
  if (u instanceof Response) return u
  if (crossSiteRequest(req)) return fail(403, CROSS_SITE_ERROR)
  try {
    const b = await buildCustomersBackup(u)
    if (b.bytes > BODY_LIMITS.response) return fail(413, `Backup grande demais para baixar (${fmtMB(b.bytes, true)}). A substituição dos clientes continua bloqueada.`)
    await db.insert(schema.auditLog).values({ entity: 'maintenance', entityId: null, action: CUSTOMERS_BACKUP_ACTION, userId: u.id, diff: { sha256: b.sha256, bytes: b.bytes, counts: b.counts, fingerprint: b.fingerprint } })
    return new Response(new Uint8Array(b.gz), {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${b.fileName}"`,
        'Content-Length': String(b.bytes),
        'X-Backup-Sha256': b.sha256,
        'X-Backup-File': b.fileName,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    console.error('[backup dos clientes]', e)
    return fail(500, 'Erro inesperado ao gerar o backup. Nada foi alterado.')
  }
}

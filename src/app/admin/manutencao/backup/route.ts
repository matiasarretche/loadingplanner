import { db, schema } from '@/db'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import { buildLoadsBackup } from '@/lib/maintenance/loadsBackup'
import { routeUser } from '@/lib/routeAuth'
import { CROSS_SITE_ERROR, crossSiteRequest } from '../sameOrigin'

/** leitura de todas as cargas + compactação: folga até o teto da Vercel */
export const maxDuration = 300

/**
 * POST /admin/manutencao/backup — BACKUP (.json.gz) de tudo o que "Excluir todas as cargas e proformas"
 * apaga. Só o administrador principal. O sha256 do arquivo volta no cabeçalho X-Backup-Sha256 e fica na
 * auditoria com as quantidades e a impressão digital do conteúdo: a exclusão só é liberada com esse backup
 * (mesmo usuário, até 60 min, nada alterado depois — nem edições que não mudam as quantidades). Backup maior que o limite de resposta da Vercel → 413 e a exclusão continua bloqueada.
 */
export async function POST(req: Request) {
  const u = await routeUser('manageUsers', { denied: 'Só o administrador principal pode baixar este backup.' })
  if (u instanceof Response) return u
  if (crossSiteRequest(req)) return Response.json({ ok: false, error: CROSS_SITE_ERROR }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  try {
    const b = await buildLoadsBackup(u)
    if (b.bytes > BODY_LIMITS.response)
      return Response.json({ ok: false, error: `Backup grande demais para baixar (${fmtMB(b.bytes, true)}). A exclusão continua bloqueada.` }, { status: 413, headers: { 'Cache-Control': 'no-store' } })
    await db.insert(schema.auditLog).values({ entity: 'maintenance', entityId: null, action: 'backup_loads', userId: u.id, diff: { sha256: b.sha256, bytes: b.bytes, counts: b.counts, fingerprint: b.fingerprint } })
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
    console.error('[backup das cargas]', e)
    return Response.json({ ok: false, error: 'Erro inesperado ao gerar o backup. Nada foi excluído.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

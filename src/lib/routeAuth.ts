import 'server-only'
import { getCurrentUser, type CurrentUser } from './auth'
import { can, type Permission } from './roles'

/**
 * Portão das ROUTE HANDLERS (route.ts): o equivalente de requireUser/assertUser para rotas.
 * Devolve o usuário ou uma Response pronta (401 sem sessão; 403 com senha temporária ou sem permissão).
 *
 *   const u = await routeUser('viewPrices')
 *   if (u instanceof Response) return u
 *
 * Por padrão a resposta é JSON { ok: false, error } (as telas leem `error`); `text: true` para rotas
 * abertas direto no navegador (download, imagem); `denied` troca a mensagem de falta de permissão;
 * `allowPendingPassword` só para o que a própria tela de troca de senha usa (a foto do usuário no menu).
 * Checagens extras da rota (área, acesso à carga) continuam na própria rota.
 */
export async function routeUser(permission?: Permission, o: { text?: boolean; denied?: string; allowPendingPassword?: boolean } = {}): Promise<CurrentUser | Response> {
  const fail = (status: 401 | 403, error: string) => (o.text ? new Response(error, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }) : Response.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } }))
  const u = await getCurrentUser()
  if (!u) return fail(401, 'Sessão expirada. Entre novamente.')
  // senha temporária: nada até trocá-la (como nas páginas e server actions)
  if (u.mustChangePassword && !o.allowPendingPassword) return fail(403, 'Defina uma nova senha antes de continuar (menu Conta › Senha).')
  if (permission && !can[permission](u.role)) return fail(403, o.denied ?? 'Você não tem permissão para esta ação.')
  return u
}

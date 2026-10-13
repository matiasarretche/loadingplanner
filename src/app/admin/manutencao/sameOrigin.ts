/**
 * Rotas da Manutenção só aceitam pedidos da própria plataforma: o navegador manda Sec-Fetch-Site e,
 * vindo de outro site (link ou formulário de fora), a rota recusa antes de fazer qualquer coisa.
 * Sem o cabeçalho (navegador antigo, script) segue a checagem normal da sessão.
 */
export function crossSiteRequest(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site')
  return site != null && site !== 'same-origin'
}

export const CROSS_SITE_ERROR = 'Pedido recusado: abra a página Manutenção da plataforma e tente de novo.'

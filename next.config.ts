import type { NextConfig } from 'next'

// cabeçalhos de segurança aplicados a todas as respostas (páginas, rotas e arquivos de /public)
const securityHeaders = [
  // ninguém pode embutir a plataforma num iframe (clickjacking); a prévia de PDF usa blob:, não é afetada
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // só vale em HTTPS (o navegador ignora em http://127.0.0.1)
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  // câmera (fotos da carga) e microfone (ditado) só para a própria plataforma; localização nunca
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
]

const nextConfig: NextConfig = {
  // permite um segundo servidor de QA (banco de testes) sem conflitar com o .next principal
  // (NUNCA definir NEXT_DIST_DIR na Vercel)
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  // rotas que leem public/brand do disco em tempo de execução (logo e selos nos PDFs gerados no servidor):
  // garante que os PNG entrem no pacote da função na Vercel. As chaves são globs de rota (picomatch),
  // por isso "/cargas/*/pdf" em vez de "/cargas/[id]/pdf" (os colchetes seriam uma classe de caracteres).
  outputFileTracingIncludes: {
    '/cargas/*/pdf': ['./public/brand/**'],
    '/precos-exportacao/lista': ['./public/brand/**'],
    '/exportacoes/*/pdf': ['./public/brand/**'],
  },
  headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // o link de redefinição leva o token na URL: não repassar nem a origem
      { source: '/redefinir-senha', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ]
  },
  // tudo começa em "Nova carga": seções antigas redirecionam (links e favoritos continuam funcionando)
  redirects() {
    return [
      { source: '/paletes-mistos', destination: '/cargas/nova?tipo=PALLETS_ONLY', permanent: false },
      { source: '/cargas/ia', destination: '/cargas/nova?entrada=pedido', permanent: false },
      { source: '/montagens', destination: '/', permanent: false },
      { source: '/produtos', destination: '/catalogo', permanent: false },
      { source: '/produtos/:path*', destination: '/catalogo', permanent: false },
      { source: '/montagens/:path*', destination: '/', permanent: false },
    ]
  },
}

export default nextConfig

import type { Metadata, Viewport } from 'next'
import './globals.css'
import { Nav } from '@/components/Nav'

export const metadata: Metadata = {
  title: 'Pacifil Export Load Planner',
  description: 'Planejamento de paletização e carga para exportação',
}

/** celular: largura do aparelho, conteúdo até as bordas (iPhone) e cor da barra do navegador */
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#0d2b22' }

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="pt-BR">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  )
}

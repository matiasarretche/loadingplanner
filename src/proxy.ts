import { NextRequest, NextResponse } from 'next/server'

// Checagem otimista: sem cookie de sessão → login. A validação real é feita no servidor (lib/auth).
export function proxy(req: NextRequest) {
  const has = req.cookies.has('plp_session')
  if (!has && !req.nextUrl.pathname.startsWith('/login') && !req.nextUrl.pathname.startsWith('/redefinir-senha')) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|webp|svg|ico)$).*)'],
}

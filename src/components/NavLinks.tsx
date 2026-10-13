'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

/**
 * Barra superior: o logo + "Cargas" é UM botão só (a página principal, mais destacado) e depois os
 * demais links, com o item da página atual destacado. No celular os links e o usuário ficam num menu
 * que abre com o botão ☰ (e fecha ao escolher um link).
 */
export function NavLinks({ links, home, user }: { links: { href: string; label: string }[]; home?: React.ReactNode; user?: React.ReactNode }) {
  const path = usePathname()
  const [open, setOpen] = useState(false)
  const isOn = (href: string) => (href === '/' ? path === '/' || path.startsWith('/cargas') : path.startsWith(href))
  return (
    <>
      <Link href="/" className={`brand home${isOn('/') ? ' on' : ''}`} title="Cargas — página principal (Pacifil Load Planner)" onClick={() => setOpen(false)}>
        {home}
        <span>Cargas</span>
      </Link>
      <button type="button" className="topbar-toggle" aria-expanded={open} aria-controls="topbar-menu" aria-label={open ? 'Fechar menu' : 'Abrir menu'} onClick={() => setOpen((o) => !o)}>
        {open ? '✕' : '☰'}
      </button>
      <div
        id="topbar-menu"
        className={`topbar-menu${open ? ' open' : ''}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) setOpen(false)
        }}
      >
        <nav>
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={isOn(l.href) ? 'on' : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        {user}
      </div>
    </>
  )
}

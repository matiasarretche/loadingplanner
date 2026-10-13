/** Avatar redondo: foto, emoji ou iniciais (cor estável pelo nome). Serve em telas de servidor e de cliente. */
import { AvatarRef, initials, nameColor } from '@/lib/avatar'

export function Avatar({ avatar, name, size = 24, title }: { avatar: AvatarRef; name: string; size?: number; title?: string }) {
  const common = { width: size, height: size, borderRadius: '50%', flex: 'none' as const, display: 'inline-grid', placeItems: 'center', overflow: 'hidden' }
  if (avatar && avatar.startsWith('/avatar/'))
    return (
      // eslint-disable-next-line @next/next/no-img-element -- foto pequena servida pela própria aplicação (rota protegida)
      <img src={avatar} alt={name} title={title ?? name} width={size} height={size} style={{ ...common, objectFit: 'cover', background: '#e9eef2' }} />
    )
  if (avatar)
    return (
      <span title={title ?? name} aria-label={name} style={{ ...common, background: '#eef5f1', fontSize: Math.round(size * 0.62), lineHeight: 1 }}>
        {avatar}
      </span>
    )
  return (
    <span title={title ?? name} aria-label={name} style={{ ...common, background: nameColor(name), color: '#fff', fontSize: Math.round(size * 0.42), fontWeight: 700 }}>
      {initials(name)}
    </span>
  )
}

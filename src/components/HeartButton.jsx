// components/HeartButton.jsx — THE favorite control, identical on every surface so the
// heart reads as one concept app-wide. Filled warm red = favorited; hollow faint = not.
// Purely presentational: the caller owns persistence (lib/favorites.js) and state.

const HEART_COLOR = 'var(--color-domain-vascular)' // the warm red already in the palette

export default function HeartButton({ active, onClick, size = 15, style }) {
  return (
    <button
      onClick={onClick}
      title={active ? 'Favorited — click to remove' : 'Mark as a favorite'}
      aria-label={active ? 'Remove from favorites' : 'Mark as a favorite'}
      aria-pressed={!!active}
      className="cursor-pointer flex items-center"
      style={{ padding: 2, border: 0, background: 'transparent', color: active ? HEART_COLOR : 'var(--color-fg-faint)', flex: '0 0 auto', ...style }}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
        <path d="M12 20.3C7.2 16.7 3.5 13.5 3.5 9.8 3.5 7.1 5.6 5 8.1 5c1.5 0 3 .8 3.9 2.1C12.9 5.8 14.4 5 15.9 5c2.5 0 4.6 2.1 4.6 4.8 0 3.7-3.7 6.9-8.5 10.5z" />
      </svg>
    </button>
  )
}

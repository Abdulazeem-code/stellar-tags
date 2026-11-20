// Square-capped, grid-aligned stroke icons drawn on a 24px grid, so they sit
// on the pixel grid next to the dithered artwork. Decorative by default; pass
// `label` when the icon is the only content of its control.
const PATHS = {
  home: 'M4 11 12 4l8 7M6 9.5V20h4v-5h4v5h4V9.5',
  history: 'M4 4v5h5M4.5 9A8 8 0 1 1 4 12M12 8v5l3 2',
  chart: 'M4 20h16M7 20v-6M12 20V8M17 20v-9',
  tag: 'M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9',
  help: 'M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.6V15M12 18v1',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12ZM12 10v4M10 12h4',
  eyeOff: 'M3 3l18 18M10 6.2A10.6 10.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.5 7.6C3.6 9.4 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.2-.9',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  close: 'M5 5l14 14M19 5 5 19',
  menu: 'M4 6h16M4 12h16M4 18h16',
  arrow: 'M4 12h15M13 6l6 6-6 6',
  wallet: 'M3 6h16v12H3zM15 11h4v3h-4zM3 6l12-3v3',
  logout: 'M10 4H4v16h6M15 8l4 4-4 4M19 12H9',
  search: 'M10.5 3a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15ZM16 16l5 5',
  download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  check: 'M4 12l5 5L20 6',
  plus: 'M12 4v16M4 12h16',
  minus: 'M4 12h16',
  send: 'M4 12h14M12 5l7 7-7 7',
  receive: 'M20 12H6M12 19l-7-7 7-7',
  github: 'M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
};

export default function Icon({ name, size = 18, label, className = '', strokeWidth = 2 }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="square"
      strokeLinejoin="miter"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name] || ''} />
    </svg>
  );
}

/** The STELLAR/TAGS pixel star mark. */
export function BrandMark({ size = 22, ink = 'var(--paper)', accent = 'var(--blue)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="5" y="0" width="1" height="11" fill={accent} />
      <rect x="0" y="5" width="11" height="1" fill={accent} />
      <rect x="4" y="4" width="3" height="3" fill={ink} />
      <rect x="2" y="2" width="1" height="1" fill={ink} />
      <rect x="8" y="8" width="1" height="1" fill={ink} />
      <rect x="8" y="2" width="1" height="1" fill={ink} />
      <rect x="2" y="8" width="1" height="1" fill={ink} />
    </svg>
  );
}

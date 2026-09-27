import type { CSSProperties } from 'react';
export function Icon({ name, className, style }: { name: 'back' | 'settings' | 'arrow' | 'external' | 'help' | 'down' | 'close' | 'check' | 'info'; className?: string; style?: CSSProperties }) {
  const paths = {
    back: <path d="m14.5 5-7 7 7 7" />,
    arrow: <><path d="M4 12h15M13 5l7 7-7 7" /></>,
    external: <><path d="M14 4h6v6M20 4 10 14M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
    down: <path d="m6 9 6 6 6-6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 .3c0 1.7-2.5 1.9-2.5 3.7M12 16h.01" /></>,
    check: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M7 12h10" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
    settings: <><path d="m9.3 3-.5 2-1.7 1-2-.6L3 9l1.5 1.4v2L3 14l2.1 3.6 2-.6 1.7 1 .5 2h4.2l.5-2 1.7-1 2 .6L20 14l-1.5-1.6v-2L20 9l-2.3-3.6-2 .6-1.7-1-.5-2z" /><circle cx="11.5" cy="11.5" r="3" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={className} style={style} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p,
});

export const Play = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
  </svg>
);
export const Pause = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6" y="5" width="4" height="14" rx="1.2" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" />
  </svg>
);
export const Mic = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
/** a browser window with a tab: listening to another tab */
export const BrowserTab = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 9h18M7 5v4M12 13.5l2.5 1.5-2.5 1.5z" />
  </svg>
);
export const Upload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </svg>
);
export const Rec = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <circle cx="12" cy="12" r="6" />
  </svg>
);
export const Expand = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
);
export const Sparkle = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3c.5 4.5 2.5 6.5 7 7-4.5.5-6.5 2.5-7 7-.5-4.5-2.5-6.5-7-7 4.5-.5 6.5-2.5 7-7ZM19 15c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5Z" />
  </svg>
);
export const Plus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const X = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const Up = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m6 15 6-6 6 6" />
  </svg>
);
export const Down = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const Eye = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const Shuffle = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </svg>
);
export const Camera = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
export const Code = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
  </svg>
);
export const Arrow = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M5 12h14m0 0-6-6m6 6-6 6" />
  </svg>
);
export const Link = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
  </svg>
);
export const Wave = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 12h2l2-6 3 12 3-9 2 6 2-3h4" />
  </svg>
);
export const Chevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
export const Trash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 7h16M9 7V5h6v2M6.5 7l1 12h9l1-12" />
  </svg>
);
export const Redo = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M20 8h-9a5 5 0 0 0 0 10h3M20 8l-4-4M20 8l-4 4" />
  </svg>
);
/* scene category glyphs for the Scenes list */
export const Cube = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
  </svg>
);
export const Layers = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0" />
  </svg>
);
export const Image = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="m4 17 5-5 4 4 2.5-2.5L20 18" />
    <circle cx="15.5" cy="9" r="1.5" />
  </svg>
);
export const Grid = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M3.5 12h17M12 12v8.5" />
  </svg>
);

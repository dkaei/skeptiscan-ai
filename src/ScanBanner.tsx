import { useEffect, useId, useRef } from 'react';
import { Icon } from './Icon';
import ScanInspection from './ScanInspection';
import { getScanFrame, makeScanTrack, type ScanTrack } from './scanMotion';
import s from './ScanBanner.module.css';

export default function ScanBanner({ reduced, onClick }: { reduced: boolean; onClick: () => void }) {
  const uid = useId().replace(/:/g, '');
  const scene = useRef<SVGSVGElement>(null);
  const card = useRef<SVGGElement>(null);
  const lens = useRef<SVGGElement>(null);
  const zoom = useRef<SVGGElement>(null);
  const inspection = useRef<HTMLSpanElement>(null);
  const findingBadge = useRef<SVGGElement>(null);
  useEffect(() => {
    const svg = scene.current, original = card.current;
    if (!svg || !original || !lens.current || !zoom.current) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const park = { x: 132, y: 163 };
    const names = ['number', 'link', 'action'] as const;
    const nodes = names.map(name => ({
      name,
      text: original.querySelector<SVGTextElement>(`[data-target="${name}"]`)!,
      originalColor: { number: '#5f6b82', link: '#5258a4', action: '#35435b' }[name],
      highlight: original.querySelector<SVGRectElement>(`[data-highlight="${name}"]`)!,
      reveal: svg.querySelector<SVGRectElement>(`[data-reveal="${name}"]`)!,
    }));
    let frame = 0, elapsed = 0, previous = 0, visible = true, disposed = false;
    let tracks: Record<typeof names[number], ScanTrack> | null = null;
    const boxes = new Map<string, DOMRect>();
    let observer: ResizeObserver;

    const paint = () => {
      const still = reduced || media.matches;
      const state = tracks && !still ? getScanFrame(elapsed, tracks, park) : { point: park, target: null, progress: 1, phase: 'idle' };
      const { x, y } = state.point;
      // The cloned card stays in the same world coordinates as the original.
      // Only the lens-local viewport is enlarged around its current centre.
      lens.current?.setAttribute('transform', `translate(${x} ${y})`);
      zoom.current?.setAttribute('transform', `translate(${-x * 1.3} ${-y * 1.3}) scale(1.3)`);
      svg.dataset.phase = still ? 'all' : state.target ?? '';
      const finding = !still && state.phase === 'result' && (state.target === 'number' || state.target === 'link') ? state.target : '';
      const badge = findingBadge.current;
      if (badge) {
        // Retain the outgoing icon during the fade; do not flash an empty badge.
        if (finding) badge.dataset.outcome = finding;
        badge.dataset.visible = String(Boolean(finding));
      }
      // Both pieces of the illustration share one clock. Keep the previous
      // mini-scene mounted while it fades, then select the next reading target.
      const panel = inspection.current;
      if (panel) {
        if (state.target) panel.dataset.check = state.target;
        panel.dataset.phase = state.phase;
        panel.dataset.paused = String(still || document.hidden || !visible);
      }
      nodes.forEach(({ name, text, originalColor, highlight, reveal }) => {
        const box = boxes.get(name);
        if (!box) return;
        const active = still || state.target === name;
        highlight.setAttribute('opacity', active ? '1' : '0');
        // Reveal only as much of the detail as has passed through the glass.
        if (active) {
          reveal.setAttribute('width', String((box.width + 6) * (still ? 1 : state.progress)));
          highlight.setAttribute('fill', finding === name ? '#f7dc97' : '#d9d5f2');
          text.setAttribute('fill', finding === name ? '#6e4c1c' : originalColor);
        } else text.setAttribute('fill', originalColor);
      });
    };
    const measure = () => {
      if (disposed) return;
      const rootMatrix = svg.getCTM(), cardMatrix = original.getCTM();
      if (!rootMatrix || !cardMatrix) return;
      const matrix = rootMatrix.inverse().multiply(cardMatrix);
      tracks = Object.fromEntries(nodes.map(({ name, text, highlight, reveal }) => {
        const box = text.getBBox();
        boxes.set(name, box);
        for (const rect of [highlight, reveal]) {
          rect.setAttribute('x', String(box.x - 3));
          rect.setAttribute('y', String(box.y - 2));
          rect.setAttribute('width', String(box.width + 6));
          rect.setAttribute('height', String(box.height + 4));
        }
        return [name, makeScanTrack(box, matrix, 56, 1.3, 14)];
      })) as Record<typeof names[number], ScanTrack>;
      paint();
    };
    const tick = (time: number) => {
      if (previous) elapsed += time - previous;
      previous = time;
      paint();
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frame); previous = 0;
      measure();
      if (!reduced && !media.matches && !document.hidden && visible) frame = requestAnimationFrame(tick);
    };
    observer = new ResizeObserver(measure);
    observer.observe(svg);
    nodes.forEach(({ text }) => observer.observe(text));
    const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; update(); });
    intersection.observe(svg);
    document.addEventListener('visibilitychange', update);
    media.addEventListener('change', update);
    update();
    void document.fonts.ready.then(measure);
    return () => {
      disposed = true; cancelAnimationFrame(frame); intersection.disconnect(); observer.disconnect();
      if (inspection.current) inspection.current.dataset.paused = 'true';
      document.removeEventListener('visibilitychange', update); media.removeEventListener('change', update);
    };
  }, [reduced]);
  return <div className={s.wrap}>
    <button id="entry-screenshot" className={s.banner} onClick={onClick} aria-label="Upload screenshot">
      <span className={s.title}><span>Upload</span>screenshot</span>
      <Icon name="arrow" className={s.arrow} />
      <ScanInspection ref={inspection} reduced={reduced} data-inspection data-phase="idle" data-paused="true" />
      <svg ref={scene} viewBox="0 0 200 234" className={s.scene} aria-hidden="true">
        <defs>
          <linearGradient id={`${uid}-paper`} x2="1" y2="1"><stop stopColor="#fff" /><stop offset="1" stopColor="#f1f4f9" /></linearGradient>
          <linearGradient id={`${uid}-rim`}><stop stopColor="#9aabd8" /><stop offset=".25" stopColor="#576b9f" /><stop offset=".65" stopColor="#293b65" /><stop offset="1" stopColor="#526b9d" /></linearGradient>
          <linearGradient id={`${uid}-glass`} x2="1" y2="1"><stop stopColor="#ffffff" stopOpacity=".4" /><stop offset=".5" stopColor="#ffffff" stopOpacity="0" /><stop offset="1" stopColor="#c9d9ff" stopOpacity=".17" /></linearGradient>
          <linearGradient id={`${uid}-finding`} x2="0" y2="1"><stop stopColor="#ffedb8" /><stop offset="1" stopColor="#f2ce7b" /></linearGradient>
          <clipPath id={`${uid}-clip`}><circle r="28" /></clipPath>
          <filter id={`${uid}-shadow`} x="-50%" y="-50%" width="200%" height="220%"><feDropShadow dx="3" dy="7" stdDeviation="4" floodColor="#141b3d" floodOpacity=".32" /></filter>
          {(['number', 'link', 'action'] as const).map(name => <clipPath key={name} id={`${uid}-reveal-${name}`} clipPathUnits="userSpaceOnUse"><rect data-reveal={name} /></clipPath>)}
        </defs>
        <rect x="40" y="19" width="125" height="189" rx="14" fill="#a5b0d3" opacity=".35" transform="rotate(-6 104 115)" />
        <g filter={`url(#${uid}-shadow)`}>
          <g ref={card} id={`${uid}-card`} data-scan-card transform="rotate(8 108 118)">
            <rect x="43" y="23" width="126" height="191" rx="13" fill="#8390b4" />
            <rect x="40" y="19" width="126" height="191" rx="13" fill="#d4dceb" />
            <rect x="38" y="16" width="126" height="191" rx="13" fill={`url(#${uid}-paper)`} />
            <path d="m51 31-4 5 4 5" fill="none" stroke="#8290a6" strokeWidth="1.5" />
            <text x="58" y="39" fontSize="11" fontWeight="600" fill="#374157">Messages</text>
            <path d="M47 48h108" stroke="#e0e5ee" />
            <rect data-highlight="number" rx="3" fill="#d9d5f2" opacity="0" clipPath={`url(#${uid}-reveal-number)`} />
            <text data-target="number" x="47" y="64" fontSize="9" fill="#5f6b82">+65 9••• ••28</text>
            <rect x="45" y="74" width="111" height="85" rx="8" fill="#e9edf5" stroke="#dee4ef" />
            <text x="51" y="88" fontSize="8.7" fill="#59667c"><tspan x="51">We couldn’t deliver</tspan><tspan x="51" dy="12">your parcel today.</tspan></text>
            <rect data-highlight="action" rx="3" fill="#d9d5f2" opacity="0" clipPath={`url(#${uid}-reveal-action)`} />
            <text data-target="action" x="51" y="113" fontSize="8.7" fontWeight="600" fill="#35435b">Pay S$1.99</text>
            <text x="51" y="125" fontSize="8.7" fill="#59667c">to book redelivery.</text>
            <rect data-highlight="link" rx="3" fill="#d9d5f2" opacity="0" clipPath={`url(#${uid}-reveal-link)`} />
            <text data-target="link" x="51" y="143" fontSize="8.1" fill="#5258a4">www.parcel.example</text>
            <rect x="45" y="178" width="111" height="19" rx="7" fill="#fafbfe" stroke="#e0e5ee" />
            <text x="53" y="190" fontSize="7.5" fill="#8994a8">Text message</text>
          </g>
        </g>
        <g ref={lens} data-scan-lens transform="translate(132 163)" filter={`url(#${uid}-shadow)`}>
          <g transform="rotate(-40)"><rect x="-6" y="27" width="12" height="36" rx="6" fill="#354975" /><rect x="-6" y="28" width="12" height="6" rx="2" fill="#8399be" /><path d="M-3 55h6M-3 59h6" stroke="#788eaf" strokeWidth=".6" /></g>
          <circle r="34" fill={`url(#${uid}-rim)`} stroke="#c0d0ee" strokeWidth=".7" />
          <g clipPath={`url(#${uid}-clip)`}><circle r="28" fill="#f7f9fc" /><g ref={zoom} data-scan-zoom transform="translate(-171.6 -211.9) scale(1.3)"><use href={`#${uid}-card`} /></g></g>
          <circle r="28" fill={`url(#${uid}-glass)`} stroke="#a2b7d8" strokeWidth="1" />
          <path d="M-20-14a24 24 0 0 1 24-10" fill="none" stroke="#fff" strokeOpacity=".4" strokeWidth="1.8" strokeLinecap="round" />
          <g transform="translate(26 -25)">
            <g ref={findingBadge} className={s.findingBadge} data-scan-finding data-visible="false">
              <circle r="12" fill={`url(#${uid}-finding)`} stroke="#fff1c7" strokeWidth="1" />
              <g className={s.flagSymbol} fill="none" stroke="#805519" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M-4 6V-6m0 0c3-2 5 2 9 0v7c-4 2-6-2-9 0" />
              </g>
              <g className={s.cautionSymbol} fill="none" stroke="#805519" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m-1.2-6-5.5 10a1.4 1.4 0 0 0 1.2 2h11a1.4 1.4 0 0 0 1.2-2l-5.5-10a1.4 1.4 0 0 0-2.4 0Z" />
                <path d="M0-2v3" /><circle cx="0" cy="3.5" r=".65" fill="#805519" stroke="none" />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </button>
  </div>;
}

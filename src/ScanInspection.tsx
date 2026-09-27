import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import s from './ScanInspection.module.css';

function MiniIcon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
}

type ScanInspectionProps = HTMLAttributes<HTMLSpanElement> & { reduced?: boolean };

/** Scripted illustration only. Its parent supplies every phase from the lens clock. */
const ScanInspection = forwardRef<HTMLSpanElement, ScanInspectionProps>(function ScanInspection({ reduced = false, className = '', ...props }, ref) {
  return <span data-phase="idle" data-paused="true" {...props} ref={ref} className={`${s.inspection} ${className}`} data-reduced={reduced ? 'true' : 'false'} aria-hidden="true">
    <span className={`${s.stage} ${s.number}`}>
      <span className={s.database}><MiniIcon><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" /></MiniIcon></span>
      <span className={s.records}><span><b /><i /></span><span><b /><i /></span><span><b /><i /></span></span>
      <span className={s.recordBeam} />
      <span className={s.phone}><MiniIcon><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.79a2 2 0 0 1-.45 2.11L8.08 9.89a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.89.33 1.83.56 2.79.69A2 2 0 0 1 22 16.92Z" /></MiniIcon></span>
      <span className={s.result}><MiniIcon><path d="M4 22V3m0 0c3-2 5 0 8 0s5-2 8 0v12c-3-2-5 0-8 0s-5-2-8 0" /></MiniIcon></span>
    </span>
    <span className={`${s.stage} ${s.domain}`}>
      <span className={s.browser}>
        <span className={s.browserBar}><i /><i /><i /><b /></span>
        <span className={s.orbit} />
        <span className={s.globe}><MiniIcon><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></MiniIcon></span>
      </span>
      <span className={s.result}><MiniIcon><path d="m10.29 3.86-8.48 14.14A2 2 0 0 0 3.52 21h16.96a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" /><path d="M12 9v4m0 4h.01" /></MiniIcon></span>
    </span>
    <span className={`${s.stage} ${s.analysis}`}>
      <span className={s.paper}><i /><i /><i /></span>
      <span className={s.route} />
      <span className={s.core}><MiniIcon><path d="M4 7V4h3m10 0h3v3m0 10v3h-3M7 20H4v-3M7 8h10M7 12h10M7 16h6" /></MiniIcon></span>
      <span className={s.nodes}><i /><i /><i /></span>
    </span>
  </span>;
});

export default ScanInspection;

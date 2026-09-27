export interface ScanPoint { x: number; y: number }
export type ScanTarget = 'number' | 'link' | 'action';
export interface ScanTrack {
  start: ScanPoint;
  end: ScanPoint;
  width: number;
  readableWidth: number;
}
export type ScanTracks = Record<ScanTarget, ScanTrack>;
export interface ScanFrame {
  point: ScanPoint;
  target: ScanTarget | null;
  /** Fraction of the text reached by the right edge of the readable glass. */
  progress: number;
  phase: 'idle' | 'reading' | 'checking' | 'result';
}
export interface ScanBox { x: number; y: number; width: number; height: number }
export interface ScanMatrix { a: number; b: number; c: number; d: number; e: number; f: number }

const CYCLE_MS = 18_000;
const passes: { target: ScanTarget; arrive: number; read: number; finish: number; resolve: number; leave: number }[] = [
  { target: 'number', arrive: 1300, read: 1450, finish: 3000, resolve: 4250, leave: 5250 },
  { target: 'link', arrive: 6250, read: 6400, finish: 8300, resolve: 9550, leave: 10550 },
  { target: 'action', arrive: 11550, read: 11700, finish: 13300, resolve: 14550, leave: 15550 },
];

function ease(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function mix(from: ScanPoint, to: ScanPoint, progress: number): ScanPoint {
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
}

/** Measure in card coordinates, then project each endpoint into scene coordinates once. */
export function makeScanTrack(
  box: ScanBox,
  matrix: ScanMatrix,
  lensInnerDiameter = 56,
  magnification = 1.3,
  padding = 14,
): ScanTrack {
  const width = Math.max(0, box.width);
  const readableWidth = Math.max(0, (lensInnerDiameter - padding) / magnification);
  const centre = { x: box.x + width / 2, y: box.y + box.height / 2 };
  const travel = Math.max(0, (width - readableWidth) / 2);
  const project = (x: number): ScanPoint => ({
    x: matrix.a * x + matrix.c * centre.y + matrix.e,
    y: matrix.b * x + matrix.d * centre.y + matrix.f,
  });
  return { start: project(centre.x - travel), end: project(centre.x + travel), width, readableWidth };
}

/** One quiet 18-second reading cycle. Geometry is supplied from cached layout measurements. */
export function getScanFrame(elapsedMs: number, tracks: ScanTracks, park: ScanPoint): ScanFrame {
  const time = Number.isFinite(elapsedMs) ? ((elapsedMs % CYCLE_MS) + CYCLE_MS) % CYCLE_MS : 0;
  let previous = park;
  let depart = 400;

  for (const pass of passes) {
    const track = tracks[pass.target];
    if (time < pass.arrive) {
      return { point: mix(previous, track.start, ease((time - depart) / (pass.arrive - depart))), target: null, progress: 0, phase: 'idle' };
    }
    if (time <= pass.leave) {
      const progress = ease((time - pass.read) / (pass.finish - pass.read));
      const visibleWidth = Math.min(track.width, track.readableWidth);
      return {
        point: mix(track.start, track.end, progress),
        target: pass.target,
        progress: track.width > 0 ? Math.min(1, (visibleWidth + progress * (track.width - visibleWidth)) / track.width) : 1,
        // Start the side illustration halfway through the left-to-right sweep.
        // Its finding still waits until the full line has been read.
        phase: time < (pass.read + pass.finish) / 2 ? 'reading' : time < pass.resolve ? 'checking' : 'result',
      };
    }
    previous = track.end;
    depart = pass.leave;
  }

  return { point: mix(previous, park, ease((time - depart) / 1200)), target: null, progress: 0, phase: 'idle' };
}

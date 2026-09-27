import { describe, expect, it } from 'vitest';
import { getScanFrame, makeScanTrack, type ScanPoint, type ScanTracks } from '../src/scanMotion';

const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const park = { x: 132, y: 163 };
const tracks: ScanTracks = {
  number: makeScanTrack({ x: 47, y: 54, width: 64, height: 10 }, identity),
  link: makeScanTrack({ x: 51, y: 134, width: 85, height: 10 }, identity),
  action: makeScanTrack({ x: 51, y: 104, width: 46, height: 10 }, identity),
};
const distance = (a: ScanPoint, b: ScanPoint) => Math.hypot(a.x - b.x, a.y - b.y);

describe('scan geometry', () => {
  it('projects reading endpoints through a rotated and translated card exactly once', () => {
    const track = makeScanTrack({ x: 20, y: 40, width: 90, height: 12 }, { a: 0, b: 1, c: -1, d: 0, e: 200, f: 10 });
    expect(track.readableWidth).toBeCloseTo(32.3076923077);
    expect(track.start.x).toBe(154);
    expect(track.end.x).toBe(154);
    expect(track.start.y).toBeCloseTo(46.1538461538);
    expect(track.end.y).toBeCloseTo(103.8461538462);
  });

  it.each([-6, 8, 130])('reads from text-left to text-right after %s-degree rotation', angle => {
    const radians = angle * Math.PI / 180, a = Math.cos(radians), b = Math.sin(radians);
    const track = makeScanTrack({ x: 20, y: 40, width: 90, height: 12 }, { a, b, c: -b, d: a, e: 100, f: -20 });
    const dx = track.end.x - track.start.x, dy = track.end.y - track.start.y;
    expect(dx * a + dy * b).toBeCloseTo(90 - track.readableWidth);
    expect(dx * -b + dy * a).toBeCloseTo(0);
  });

  it('covers both outer text corners at the sweep endpoints with margin inside the round glass', () => {
    const angle = -6 * Math.PI / 180, a = Math.cos(angle), b = Math.sin(angle);
    const matrix = { a, b, c: -b, d: a, e: 32, f: 10 };
    const track = makeScanTrack({ x: 20, y: 40, width: 90, height: 12 }, matrix);
    const project = (x: number, y: number) => ({ x: a * x - b * y + 32, y: b * x + a * y + 10 });
    for (const y of [40, 52]) {
      expect(distance(project(20, y), track.start) * 1.3).toBeLessThan(28);
      expect(distance(project(110, y), track.end) * 1.3).toBeLessThan(28);
    }
    expect(distance(track.start, track.end)).toBeCloseTo(track.width - track.readableWidth);
  });

  it('holds short text at its centre instead of reversing the sweep', () => {
    const track = makeScanTrack({ x: 20, y: 40, width: 20, height: 12 }, identity);
    expect(track.start).toEqual({ x: 30, y: 46 });
    expect(track.end).toEqual(track.start);
    expect(getScanFrame(1450, { ...tracks, number: track }, park).progress).toBe(1);
  });
});

describe('18-second scan motion', () => {
  it.each([
    ['number', 1300, 1450, 3000, 5250],
    ['link', 6250, 6400, 8300, 10550],
    ['action', 11550, 11700, 13300, 15550],
  ] as const)('reads the complete %s line before leaving', (target, arrive, read, finish, leave) => {
    const track = tracks[target];
    const arrival = getScanFrame(arrive, tracks, park);
    expect(arrival.target).toBe(target);
    expect(arrival.point).toEqual(track.start);
    expect(arrival.progress).toBeCloseTo(track.readableWidth / track.width);
    expect(getScanFrame(read, tracks, park)).toEqual(arrival);
    const middle = getScanFrame((read + finish) / 2, tracks, park);
    expect(middle.point.x).toBeCloseTo((track.start.x + track.end.x) / 2);
    expect(middle.progress).toBeCloseTo((track.readableWidth + track.width) / (2 * track.width));
    expect(getScanFrame(finish, tracks, park)).toEqual({ point: track.end, target, progress: 1, phase: 'checking' });
    expect(getScanFrame(leave, tracks, park)).toEqual({ point: track.end, target, progress: 1, phase: 'result' });
    expect(getScanFrame(leave + 1, tracks, park).target).toBeNull();
  });

  it.each([0, 400, 1300, 1450, 3000, 4250, 5250, 6250, 6400, 8300, 9550, 10550, 11550, 11700, 13300, 14550, 15550, 16750, 18000])(
    'has no position jump around the %sms boundary', boundary => {
      const before = getScanFrame(boundary - .001, tracks, park).point;
      const at = getScanFrame(boundary, tracks, park).point;
      const after = getScanFrame(boundary + .001, tracks, park).point;
      expect(distance(before, at)).toBeLessThan(.001);
      expect(distance(at, after)).toBeLessThan(.001);
    },
  );

  it('rests at the same park position before departure and after returning', () => {
    for (const time of [0, 399, 400, 16750, 17500, 17999, 18000]) {
      expect(getScanFrame(time, tracks, park)).toEqual({ point: park, target: null, progress: 0, phase: 'idle' });
    }
  });

  it.each([-1, -18000, -36001, -4500, -12345])('wraps negative elapsed time %s into the same cycle', time => {
    const positive = ((time % 18000) + 18000) % 18000;
    expect(getScanFrame(time, tracks, park)).toEqual(getScanFrame(positive, tracks, park));
  });

  it('keeps highlight progress bounded throughout the cycle', () => {
    for (let time = 0; time <= 18000; time += 13) {
      const frame = getScanFrame(time, tracks, park);
      expect(frame.progress).toBeGreaterThanOrEqual(0);
      expect(frame.progress).toBeLessThanOrEqual(1);
    }
  });

  it.each([
    ['number', 2225, 3000, 4250, 5250],
    ['link', 7350, 8300, 9550, 10550],
    ['action', 12500, 13300, 14550, 15550],
  ] as const)('starts the %s inspection halfway through reading and resolves after full coverage', (target, halfway, finish, resolve, leave) => {
    expect(getScanFrame(halfway - 1, tracks, park)).toMatchObject({ target, phase: 'reading' });
    expect(getScanFrame(halfway, tracks, park)).toMatchObject({ target, phase: 'checking' });
    expect(getScanFrame(halfway, tracks, park).point.x).toBeCloseTo((tracks[target].start.x + tracks[target].end.x) / 2);
    expect(getScanFrame(halfway, tracks, park).progress).toBeLessThan(1);
    expect(getScanFrame(finish, tracks, park)).toMatchObject({ target, phase: 'checking', progress: 1 });
    expect(getScanFrame(resolve - 1, tracks, park)).toMatchObject({ target, phase: 'checking' });
    expect(getScanFrame(resolve, tracks, park)).toMatchObject({ target, phase: 'result' });
    expect(getScanFrame(leave + 1, tracks, park)).toMatchObject({ target: null, phase: 'idle' });
  });
});

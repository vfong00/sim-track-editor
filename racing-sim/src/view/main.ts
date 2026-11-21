import { CarModel, generateTrack, LanePlans, LaneSet, SoloRun, STANDARD_CAR, Track, CAR_LENGTH, CAR_WIDTH, type Vec } from '../core';
import { drawCar, drawTrack, fitView, fmtTime, type View } from './draw';
import { drawSpeedTrace } from './trace';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const traceCanvas = document.getElementById('trace') as HTMLCanvasElement;
const tctx = traceCanvas.getContext('2d')!;
const info = document.getElementById('info')!;
const hud = document.getElementById('hud')!;
const genBtn = document.getElementById('gen') as HTMLButtonElement;
const drawBtn = document.getElementById('draw') as HTMLButtonElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;

const WIDTH = 14;
const model = new CarModel(STANDARD_CAR);
let seed = Number(new URLSearchParams(location.search).get('seed') ?? 7);
let drawing = false;
let clicks: Vec[] = [];

interface Session {
  track: Track;
  lanes: LaneSet;
  plans: LanePlans;
  run: SoloRun;
  view: View;
  /** Wall-clock sim time the viewer is showing. */
  clock: number;
}
let session: Session | null = null;

function resize() {
  const dpr = devicePixelRatio || 1;
  for (const c of [canvas, traceCanvas]) {
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
  }
  if (session) session.view = fitView(session.track.centerline(), canvas.width, canvas.height, 60 * dpr);
}

function setTrack(t: Track, label: string) {
  const lanes = new LaneSet(t);
  const plans = new LanePlans(lanes, model);
  session = { track: t, lanes, plans, run: new SoloRun(lanes, plans, model), view: fitView(t.centerline(), canvas.width, canvas.height, 60 * (devicePixelRatio || 1)), clock: 0 };
  info.textContent = `${label} · ${t.length.toFixed(0)} m · min radius ${t.minRadius().toFixed(0)} m · predicted lap ${fmtTime(plans.lapTime)}`;
  console.info(`[racing-sim] track ${label}: ${t.length.toFixed(0)} m, solver lap ${plans.lapTime.toFixed(3)} s`);
}

function generate() {
  drawing = false;
  drawBtn.classList.remove('on');
  closeBtn.hidden = true;
  setTrack(generateTrack({ seed, width: WIDTH }), `seed ${seed}`);
}

/** Interpolated car pose at the viewer's clock (between two logged ticks). */
function carPose(s: Session): { p: Vec; heading: number; v: number; sPos: number } {
  const f = s.run.frames;
  const dt = s.run.dt;
  const k = Math.max(0, Math.min(f.length - 2, Math.floor(s.clock / dt)));
  const a = f[k], b = f[k + 1];
  const u = Math.max(0, Math.min(1, (s.clock - a.t) / dt));
  const L = s.track.length;
  let ds = b.s - a.s;
  if (ds < -L / 2) ds += L;
  const sPos = (a.s + ds * u) % L;
  const d = a.d + (b.d - a.d) * u;
  const p = s.track.toXY(sPos, d);
  const q = s.track.toXY(sPos + 1, s.lanes.dAt(sPos + 1, 0) + (d - s.lanes.dAt(sPos, 0)));
  return { p, heading: Math.atan2(q.y - p.y, q.x - p.x), v: a.v + (b.v - a.v) * u, sPos };
}

let last = performance.now();
function frame(now: number) {
  const elapsed = Math.max(0, Math.min(0.1, (now - last) / 1000));
  last = now;
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (drawing) {
    ctx.fillStyle = '#7cf';
    for (const p of clicks) {
      ctx.beginPath();
      ctx.arc(p.x * devicePixelRatio, p.y * devicePixelRatio, 4, 0, 7);
      ctx.fill();
    }
  } else if (session) {
    const s = session;
    s.clock += elapsed;
    while (s.run.time < s.clock + s.run.dt) s.run.step();
    drawTrack(ctx, s.track, s.view, s.lanes.line);
    const pose = carPose(s);
    drawCar(ctx, s.view, pose.p, pose.heading, '#ff5a36', CAR_LENGTH, CAR_WIDTH);
    const laps = s.run.laps;
    const best = laps.length ? Math.min(...laps) : NaN;
    const lapNow = Math.max(0, s.clock - laps.reduce((x, y) => x + y, 0));
    hud.innerHTML = `
      <div class="big">${fmtTime(lapNow)}</div>
      <div class="row"><span class="lbl">Lap</span><span>${laps.length + 1}</span></div>
      <div class="row"><span class="lbl">Speed</span><span>${(pose.v * 3.6).toFixed(0)} km/h</span></div>
      <div class="row"><span class="lbl">Last lap</span><span>${laps.length ? fmtTime(laps[laps.length - 1]) : '–'}</span></div>
      <div class="row"><span class="lbl">Best lap</span><span>${fmtTime(best)}</span></div>
      <div class="row"><span class="lbl">Solver lap</span><span>${fmtTime(s.plans.lapTime)}</span></div>`;
    drawSpeedTrace(tctx, traceCanvas.width, traceCanvas.height, s, pose.sPos);
  }
  requestAnimationFrame(frame);
}

genBtn.onclick = () => { seed = Math.floor(Math.random() * 1e6); generate(); };
drawBtn.onclick = () => {
  drawing = !drawing;
  drawBtn.classList.toggle('on', drawing);
  closeBtn.hidden = !drawing;
  clicks = [];
  info.textContent = drawing ? 'Click points around the loop, then "Close loop"' : '';
};
closeBtn.onclick = () => {
  if (clicks.length < 3) { info.textContent = 'Need at least 3 points'; return; }
  const world = clicks.map((p) => ({ x: (p.x - innerWidth / 2) * 2, y: (innerHeight / 2 - p.y) * 2 }));
  drawing = false;
  drawBtn.classList.remove('on');
  closeBtn.hidden = true;
  setTrack(Track.fromControlPoints(world, WIDTH), 'drawn');
};
canvas.addEventListener('click', (e) => {
  if (drawing) clicks.push({ x: e.clientX, y: e.clientY });
});
addEventListener('resize', resize);

resize();
generate();
requestAnimationFrame(frame);

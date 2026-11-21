import { CAR_LENGTH, CAR_WIDTH, generateTrack, LaneSet, makeField, makeRng, Race, Track, type Vec } from '../core';
import { drawCar, drawTrack, fitView, fmtTime, type View } from './draw';
import { drawSpeedTrace } from './trace';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('c');
const ctx = canvas.getContext('2d')!;
const traceCanvas = $<HTMLCanvasElement>('trace');
const tctx = traceCanvas.getContext('2d')!;
const info = $('info'), hud = $('hud'), tower = $('tower'), feed = $('feed');
const drawBtn = $<HTMLButtonElement>('draw'), closeBtn = $<HTMLButtonElement>('close');

const params = new URLSearchParams(location.search);
const WIDTH = 14;
const FIELD = Number(params.get('cars') ?? 12);
const LAPS = Number(params.get('laps') ?? 10);
let trackSeed = Number(params.get('seed') ?? 7);
let raceSeed = Number(params.get('race') ?? 1);
let drawing = false;
let clicks: Vec[] = [];

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
let speed = Number(params.get('speed') ?? 1);
let paused = false;
let follow = params.get('cam') !== 'all';
let followIdx = -1;

interface Session {
  track: Track;
  lanes: LaneSet;
  race: Race;
  overview: View;
  cam: View;
  /** Sim time the viewer is showing (the race is stepped up to this). */
  clock: number;
  label: string;
}
let S: Session | null = null;

function resize() {
  const dpr = devicePixelRatio || 1;
  for (const c of [canvas, traceCanvas]) {
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
  }
  if (S) S.overview = fitView(S.track.centerline(), canvas.width, canvas.height, 50 * dpr);
}

function startRace(track: Track, label: string, lanes?: LaneSet) {
  lanes ??= new LaneSet(track);
  const race = new Race({ track, lanes, entrants: makeField(FIELD, makeRng(raceSeed)), laps: LAPS, seed: raceSeed });
  const overview = fitView(track.centerline(), canvas.width, canvas.height, 50 * (devicePixelRatio || 1));
  S = { track, lanes, race, overview, cam: { ...overview }, clock: 0, label };
  feedKey = '';
  followIdx = 0;
  info.textContent = `${label} · ${track.length.toFixed(0)} m · ${FIELD} cars · ${LAPS} laps · race seed ${raceSeed}`;
  console.info(`[racing-sim] ${label}: ${track.length.toFixed(0)} m, ${FIELD} cars, ${LAPS} laps, race seed ${raceSeed}`);
}

function generate() {
  setDrawing(false);
  startRace(generateTrack({ seed: trackSeed, width: WIDTH }), `track seed ${trackSeed}`);
}

/** Interpolated pose of car i at the viewer clock, read from the state log. */
function pose(s: Session, i: number): { p: Vec; heading: number; v: number; sPos: number; d: number } {
  const { frames, dt } = s.race;
  const k = Math.max(0, Math.min(frames.length - 2, Math.floor(s.clock / dt)));
  const u = Math.max(0, Math.min(1, (s.clock - k * dt) / dt));
  const a = frames[k], b = frames[k + 1];
  const L = s.track.length;
  let ds = b[i * 3] - a[i * 3];
  if (ds < -L / 2) ds += L;
  if (ds > L / 2) ds -= L;
  const sPos = (a[i * 3] + ds * u + L) % L;
  const d = a[i * 3 + 1] + (b[i * 3 + 1] - a[i * 3 + 1]) * u;
  const p = s.track.toXY(sPos, d);
  // Heading from the logged motion (falls back to the track direction when nearly stopped).
  const k0 = Math.max(0, k - 8);
  const q = s.track.toXY(frames[k0][i * 3], frames[k0][i * 3 + 1]);
  const moved = Math.hypot(p.x - q.x, p.y - q.y);
  const tng = s.track.tangentAt(sPos);
  const heading = moved > 0.5 ? Math.atan2(p.y - q.y, p.x - q.x) : Math.atan2(tng.y, tng.x);
  return { p, heading, v: a[i * 3 + 2] + (b[i * 3 + 2] - a[i * 3 + 2]) * u, sPos, d };
}

function gapText(r: Race, i: number, leader: number): string {
  if (i === leader) return r.cars[i].finished ? 'Winner' : 'Leader';
  const c = r.cars[i], l = r.cars[leader];
  const lapsDown = (l.finished ? l.finishLaps : l.crossings) - (c.finished ? c.finishLaps : c.crossings);
  const g = r.gapTo(i, leader);
  if (lapsDown >= 1 && (!isFinite(g) || g > 0)) {
    // Lapped only if the leader is a whole lap ahead in distance, not just across the line.
    const lDist = l.finished ? l.finishLaps * r.track.length : l.st.dist;
    if (lDist - c.st.dist >= r.track.length) return `+${Math.floor((lDist - c.st.dist) / r.track.length)} lap`;
  }
  return isFinite(g) ? `+${g.toFixed(3)}` : '';
}

let towerKey = '';
function renderTower(s: Session, order: number[]) {
  const r = s.race;
  const lap = Math.min(r.laps, r.leaderLap);
  const rows = order.map((i, p) => {
    const c = r.cars[i];
    return `<div class="tr${i === followIdx ? ' sel' : ''}${c.finished ? ' fin' : ''}" data-i="${i}">
      <span class="p">${p + 1}</span><span class="sw" style="background:${c.entrant.color}"></span>
      <span>${c.entrant.driver.name}${craftTag(c.craft.mode, c.finished)}</span><span class="gap">${gapText(r, i, order[0])}</span></div>`;
  }).join('');
  const html = `<div class="hd"><span>${r.leaderFinished ? 'Finished' : `Lap ${lap} / ${r.laps}`}</span><span>${fmtTime(s.clock)}</span></div>${rows}`;
  if (html !== towerKey) {
    tower.innerHTML = html;
    towerKey = html;
  }
}

/** Battle marker for the tower: who is attacking or defending right now. */
function craftTag(mode: string, finished: boolean): string {
  if (finished || mode === 'line') return '';
  return `<span class="tag ${mode}">${mode === 'attack' ? 'ATK' : 'DEF'}</span>`;
}

const FEED_TYPES = new Set(['pass', 'mistake', 'contact']);
const FEED_MAX = 40;
let feedKey = '';
/** Event feed: passes, mistakes and contact up to the viewer clock, newest first. */
function renderFeed(s: Session) {
  const evs = s.race.events.filter((e) => FEED_TYPES.has(e.type) && e.t <= s.clock);
  const key = `${evs.length}`;
  if (key === feedKey) return;
  feedKey = key;
  const rows = evs.slice(-FEED_MAX).reverse().map((e) =>
    `<div class="ev ${e.type}" data-i="${e.cars[0]}"><span class="tm">L${e.lap} ${fmtTime(e.t)}</span><span class="tx">${e.text}</span></div>`).join('');
  feed.innerHTML = `<div class="hd">Race events · ${evs.filter((e) => e.type === 'pass').length} passes</div>${rows || '<div class="ev"><span></span><span class="tm">Nothing yet</span></div>'}`;
}

function renderHud(s: Session, i: number, v: number, pos: number) {
  const c = s.race.cars[i];
  const laps = c.lapTimes;
  const cur = c.finished ? NaN : isFinite(c.lastCross) ? s.clock - c.lastCross : NaN;
  hud.innerHTML = `
    <div class="row"><span style="color:${c.entrant.color};font-weight:600">${c.entrant.driver.name}</span><span>P${pos}</span></div>
    <div class="big">${(v * 3.6).toFixed(0)} km/h</div>
    <div class="row"><span class="lbl">This lap</span><span>${fmtTime(cur)}</span></div>
    <div class="row"><span class="lbl">Last lap</span><span>${laps.length ? fmtTime(laps[laps.length - 1]) : '–'}</span></div>
    <div class="row"><span class="lbl">Best lap</span><span>${laps.length ? fmtTime(Math.min(...laps)) : '–'}</span></div>
    <div class="row"><span class="lbl">Solver lap</span><span>${fmtTime(c.plans.lapTime)}</span></div>
    <div class="row"><span class="lbl">Pace</span><span>${(c.entrant.driver.pace * 100).toFixed(1)}%</span></div>`;
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
  } else if (S) {
    const s = S;
    const r = s.race;
    if (!paused) s.clock += elapsed * speed;
    advanceTo(s, s.clock);
    const n = r.cars.length;
    const poses = Array.from({ length: n }, (_, i) => pose(s, i));
    const k = Math.min(r.orders.length - 1, Math.floor(s.clock / r.dt));
    const order = [...r.orders[k]];

    // Camera: overview, or follow a car at ~4 px/m with smoothing.
    const dpr = devicePixelRatio || 1;
    const a = Math.min(1, elapsed * 5);
    if (follow && followIdx >= 0) {
      // Stay centred on the car at any playback speed; only the zoom eases in.
      const p = poses[followIdx].p;
      const sc = s.cam.scale + (5 * dpr - s.cam.scale) * a;
      s.cam = { scale: sc, ox: canvas.width / 2 - p.x * sc, oy: canvas.height / 2 + p.y * sc };
    } else {
      const t = s.overview;
      s.cam = { scale: s.cam.scale + (t.scale - s.cam.scale) * a, ox: s.cam.ox + (t.ox - s.cam.ox) * a, oy: s.cam.oy + (t.oy - s.cam.oy) * a };
    }

    drawTrack(ctx, s.track, s.cam, s.lanes.line);
    for (let p = n - 1; p >= 0; p--) {
      const i = order[p];
      drawCar(ctx, s.cam, poses[i].p, poses[i].heading, r.cars[i].entrant.color, CAR_LENGTH, CAR_WIDTH, i === followIdx);
    }
    renderTower(s, order);
    renderFeed(s);
    if (followIdx >= 0) {
      const fp = poses[followIdx];
      renderHud(s, followIdx, fp.v, order.indexOf(followIdx) + 1);
      const c = r.cars[followIdx];
      const actual: { s: number; v: number }[] = [];
      const from = isFinite(c.lastCross) && c.lastCross <= s.clock ? Math.ceil(c.lastCross / r.dt) : 0;
      for (let kk = from; kk <= k; kk += 3) actual.push({ s: (r.frames[kk][followIdx * 3] - (from ? 0 : 0)), v: r.frames[kk][followIdx * 3 + 2] });
      // Before the first crossing the car is on the grid behind the line: skip those points.
      const lap = from ? actual : actual.filter((p) => p.s < s.track.length / 2);
      drawSpeedTrace(tctx, traceCanvas.width, traceCanvas.height, c.plans.profiles[s.lanes.zero].v, s.track.length, lap, fp.sPos, c.entrant.color);
    }
  }
  requestAnimationFrame(frame);
}

/** Step the race until it has reached time t (or finished). */
function advanceTo(s: Session, t: number) {
  const r = s.race;
  while (r.t < t + r.dt && !(r.finished && r.t > t)) {
    if (r.finished) {
      s.clock = Math.min(s.clock, r.t);
      break;
    }
    r.step();
  }
}

function setDrawing(on: boolean) {
  drawing = on;
  drawBtn.classList.toggle('on', on);
  closeBtn.hidden = !on;
  clicks = [];
  if (on) info.textContent = 'Click points around the loop, then "Close loop"';
}

function buildControls() {
  const box = $('speeds');
  box.innerHTML = '<button data-v="0">⏸</button>' + SPEEDS.map((v) => `<button data-v="${v}">${v}x</button>`).join('');
  const sync = () => box.querySelectorAll('button').forEach((b) => {
    const v = Number(b.dataset.v);
    b.classList.toggle('on', v === 0 ? paused : !paused && v === speed);
  });
  box.onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const v = Number(b.dataset.v);
    if (v === 0) paused = !paused;
    else { speed = v; paused = false; }
    sync();
  };
  sync();
  const syncCam = () => { $('camAll').classList.toggle('on', !follow); $('camFollow').classList.toggle('on', follow); };
  $('camAll').onclick = () => { follow = false; syncCam(); };
  $('camFollow').onclick = () => { follow = true; syncCam(); };
  syncCam();
  $('skip').onclick = () => { if (S) S.clock += 30; };
  $('restart').onclick = () => { if (S) { raceSeed++; startRace(S.track, S.label, S.lanes); } };
  $('gen').onclick = () => { trackSeed = Math.floor(Math.random() * 1e6); generate(); };
  drawBtn.onclick = () => setDrawing(!drawing);
  closeBtn.onclick = () => {
    if (clicks.length < 3) { info.textContent = 'Need at least 3 points'; return; }
    const world = clicks.map((p) => ({ x: (p.x - innerWidth / 2) * 2, y: (innerHeight / 2 - p.y) * 2 }));
    setDrawing(false);
    startRace(Track.fromControlPoints(world, WIDTH), 'drawn track');
  };
  canvas.addEventListener('click', (e) => { if (drawing) clicks.push({ x: e.clientX, y: e.clientY }); });
  tower.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.tr') as HTMLElement | null;
    if (!row) return;
    followIdx = Number(row.dataset.i);
    follow = true;
    syncCam();
  });
  feed.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.ev') as HTMLElement | null;
    if (!row?.dataset.i) return;
    followIdx = Number(row.dataset.i);
    follow = true;
    syncCam();
  });
  addEventListener('resize', resize);
}

buildControls();
resize();
generate();
requestAnimationFrame(frame);

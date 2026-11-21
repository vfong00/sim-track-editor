/// <reference types="vite/client" />
import {
  buildTrack, CAR_LENGTH, CAR_WIDTH, decodeScenario, encodeScenario, FRAME_STRIDE as F, formatError, LaneSet, parseScenario, Race,
  type Scenario, ScenarioBuildError, scenarioRaceOptions, STATUS, Track, trackKey, type Vec,
} from '../core';
import { ScenarioEditor } from '../editor/scenario-editor';
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
  scenario: Scenario;
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

// ---- scenarios (Phase 6) -------------------------------------------------------------------

/** Example scenarios from racing-sim/scenarios/, by file name. */
const EXAMPLES: Record<string, Scenario> = Object.fromEntries(
  Object.entries(import.meta.glob('../../scenarios/*.json', { eager: true, import: 'default' }))
    .map(([path, s]) => [path.replace(/^.*\/|\.json$/g, ''), s as Scenario]));

/** The page's old URL parameters (?seed, ?race, ?cars, ?laps) as a scenario. */
function urlScenario(): Scenario {
  return {
    version: 1,
    name: 'Random field',
    seed: Number(params.get('race') ?? 1),
    track: { type: 'generated', seed: Number(params.get('seed') ?? 7), width: WIDTH },
    race: { laps: Number(params.get('laps') ?? 10) },
    cars: [{ id: 'standard' }],
    field: { count: Number(params.get('cars') ?? 12), car: 'standard' },
  };
}

/** Built tracks and lane sets by trackKey (rule 5: the key covers every track input). */
const trackCache = new Map<string, { track: Track; lanes: LaneSet }>();

async function decodePng(dataUrl: string): Promise<ImageData> {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, bmp.width, bmp.height);
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

async function trackFor(spec: Scenario['track']): Promise<{ track: Track; lanes: LaneSet }> {
  const key = trackKey(spec);
  let hit = trackCache.get(key);
  if (!hit) {
    const track = buildTrack(spec, spec.type === 'png' ? await decodePng(spec.image) : undefined);
    hit = { track, lanes: new LaneSet(track) };
    trackCache.set(key, hit);
    if (trackCache.size > 6) trackCache.delete(trackCache.keys().next().value!);
  }
  return hit;
}

/** The scenario the address bar's #s= link holds (cleared once another scenario runs). */
let sharedJson = '';

/** Validate, build and start a scenario. Returns false (and shows why) if it can't run. */
async function runScenario(s: Scenario): Promise<boolean> {
  if (location.hash && JSON.stringify(s) !== sharedJson) history.replaceState(null, '', location.pathname + location.search);
  const res = parseScenario(s);
  if (!res.ok) { showErrors(res.errors.map(formatError)); return false; }
  setDrawing(false);
  info.textContent = `Building ${s.name}…`;
  try {
    const { track, lanes } = await trackFor(s.track);
    const race = new Race(scenarioRaceOptions(s, track, lanes));
    const overview = fitView(track.centerline(), canvas.width, canvas.height, 50 * (devicePixelRatio || 1));
    S = { track, lanes, race, scenario: structuredClone(s), overview, cam: { ...overview }, clock: 0, label: s.name };
  } catch (e) {
    showErrors(e instanceof ScenarioBuildError ? e.errors.map(formatError) : [(e as Error).message]);
    return false;
  }
  feedKey = '';
  towerKey = '';
  followIdx = 0;
  editor.set(s);
  const n = S.race.cars.length;
  info.textContent = `${s.name} · ${S.track.length.toFixed(0)} m · ${n} cars · ${s.race.laps} laps · seed ${s.seed}`;
  console.info(`[racing-sim] scenario "${s.name}": ${S.track.length.toFixed(0)} m, ${n} cars, ${s.race.laps} laps, seed ${s.seed}`);
  return true;
}

function showErrors(errs: string[]) {
  info.textContent = `Scenario not run: ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ''}`;
  console.warn('[racing-sim] scenario errors:\n' + errs.join('\n'));
  editorBox.hidden = false;
}

/** Run a modified copy of the current scenario. */
function rerun(change: (s: Scenario) => void) {
  const s = structuredClone(S?.scenario ?? editor.draft);
  change(s);
  void runScenario(s);
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.oncancel = () => resolve(null);
    inp.click();
  });
}

const editorBox = $('editor');
const editor = new ScenarioEditor(editorBox, {
  examples: EXAMPLES,
  run: (s) => void runScenario(s),
  async pickPng() {
    const f = await pickFile('image/png');
    if (!f) return null;
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(f); });
  },
  async share(s) {
    const url = `${location.origin}${location.pathname}${location.search}#${await encodeScenario(s)}`;
    history.replaceState(null, '', url);
    sharedJson = JSON.stringify(s);
    const copied = await navigator.clipboard?.writeText(url).then(() => true, () => false);
    return `Share link (${(url.length / 1000).toFixed(1)} kB) is in the address bar${copied ? ' and copied' : ''}`;
  },
  save(s) {
    download(`${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario'}.json`, JSON.stringify(s, null, 2) + '\n');
  },
  async open() {
    const f = await pickFile('application/json,.json');
    if (!f) return null;
    const text = await f.text();
    try { return JSON.parse(text); } catch { return text; }
  },
}, urlScenario());

/** Interpolated pose of car i at the viewer clock, read from the state log. */
function pose(s: Session, i: number): { p: Vec; heading: number; v: number; sPos: number; d: number; status: number } {
  const { frames, dt } = s.race;
  const k = Math.max(0, Math.min(frames.length - 2, Math.floor(s.clock / dt)));
  const u = Math.max(0, Math.min(1, (s.clock - k * dt) / dt));
  const a = frames[k], b = frames[k + 1];
  const L = s.track.length;
  const o = i * F;
  let ds = b[o] - a[o];
  if (ds < -L / 2) ds += L;
  if (ds > L / 2) ds -= L;
  const sPos = (a[o] + ds * u + L) % L;
  const d = a[o + 1] + (b[o + 1] - a[o + 1]) * u;
  const p = s.track.toXY(sPos, d);
  const status = a[o + 4];
  const tng = s.track.tangentAt(sPos);
  let heading: number;
  if (status >= STATUS.spin) {
    // Spinning, stopped or crashed: the logged yaw relative to the road.
    heading = Math.atan2(tng.y, tng.x) + a[o + 3];
  } else {
    // Heading from the logged motion (falls back to the track direction when nearly stopped).
    const k0 = Math.max(0, k - 8);
    const q = s.track.toXY(frames[k0][o], frames[k0][o + 1]);
    const moved = Math.hypot(p.x - q.x, p.y - q.y);
    heading = moved > 0.5 ? Math.atan2(p.y - q.y, p.x - q.x) : Math.atan2(tng.y, tng.x);
  }
  return { p, heading, v: a[o + 2] + (b[o + 2] - a[o + 2]) * u, sPos, d, status };
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
function renderTower(s: Session, order: number[], status: number[]) {
  const r = s.race;
  const lap = Math.min(r.laps, r.leaderLap);
  const rows = order.map((i, p) => {
    const c = r.cars[i];
    const out = status[i] >= STATUS.crash;
    const tag = out ? '' : incidentTag(status[i]) || craftTag(c.craft.mode, c.finished);
    return `<div class="tr${i === followIdx ? ' sel' : ''}${c.finished ? ' fin' : ''}${out ? ' out' : ''}" data-i="${i}">
      <span class="p">${out ? '' : p + 1}</span><span class="sw" style="background:${c.entrant.color}"></span>
      <span>${c.entrant.driver.name}${tag}</span><span class="gap">${out ? 'DNF' : gapText(r, i, order[0])}</span></div>`;
  }).join('');
  const grip = r.physics.gripLevel;
  const wx = grip === 1 ? '' : `<span class="grip" title="Track grip">${grip < 1 ? 'Wet' : 'Grip'} ${(grip * 100).toFixed(0)}%</span>`;
  const html = `<div class="hd"><span>${r.leaderFinished ? 'Finished' : `Lap ${lap} / ${r.laps}`}</span>${wx}<span>${fmtTime(s.clock)}</span></div>${rows}`;
  if (html !== towerKey) {
    tower.innerHTML = html;
    towerKey = html;
  }
}

/** Incident marker for the tower: off the road, spinning, stopped. */
function incidentTag(status: number): string {
  if (status === STATUS.off) return '<span class="tag off">OFF</span>';
  if (status === STATUS.spin) return '<span class="tag spin">SPIN</span>';
  if (status === STATUS.stopped) return '<span class="tag spin">STOP</span>';
  return '';
}

/** Battle marker for the tower: who is attacking or defending right now. */
function craftTag(mode: string, finished: boolean): string {
  if (finished || mode === 'line') return '';
  return `<span class="tag ${mode}">${mode === 'attack' ? 'ATK' : 'DEF'}</span>`;
}

const FEED_TYPES = new Set(['pass', 'mistake', 'contact', 'off', 'rejoin', 'spin', 'crash', 'retire', 'grip']);
const FEED_MAX = 40;
let feedKey = '';
/**
 * Event feed: passes, mistakes, contact and incidents up to the viewer clock, newest first. An
 * off is shown until its rejoin line ("off at T5, rejoins P9") replaces it.
 */
function renderFeed(s: Session) {
  const all = s.race.events;
  const rejoined = new Set<number>();
  for (const e of all) if (e.type === 'rejoin' && e.t <= s.clock && e.cause !== undefined) rejoined.add(e.cause);
  const evs = all.filter((e, k) => FEED_TYPES.has(e.type) && e.t <= s.clock && !(e.type === 'off' && rejoined.has(k)));
  const key = `${evs.length}/${rejoined.size}`;
  if (key === feedKey) return;
  feedKey = key;
  const rows = evs.slice(-FEED_MAX).reverse().map((e) =>
    `<div class="ev ${e.type}" data-i="${e.cars[0]}"><span class="tm">L${e.lap} ${fmtTime(e.t)}</span><span class="tx">${e.text}</span></div>`).join('');
  const dnf = evs.filter((e) => e.type === 'crash' || e.type === 'retire').length;
  feed.innerHTML = `<div class="hd">Race events · ${evs.filter((e) => e.type === 'pass').length} passes${dnf ? ` · ${dnf} DNF` : ''}</div>${rows || '<div class="ev"><span></span><span class="tm">Nothing yet</span></div>'}`;
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
    <div class="row"><span class="lbl">Pace</span><span>${(c.entrant.driver.pace * 100).toFixed(1)}%</span></div>
    ${c.damage > 0 ? `<div class="row"><span class="lbl">Damage</span><span>−${(c.damage * 100).toFixed(1)}% grip</span></div>` : ''}
    ${c.dnf ? '<div class="row"><span class="lbl">Status</span><span style="color:#ff4d4d">Retired</span></div>' : ''}`;
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
      drawCar(ctx, s.cam, poses[i].p, poses[i].heading, r.cars[i].entrant.color, CAR_LENGTH, CAR_WIDTH, i === followIdx, poses[i].status);
    }
    renderTower(s, order, poses.map((q) => q.status));
    renderFeed(s);
    if (followIdx >= 0) {
      const fp = poses[followIdx];
      renderHud(s, followIdx, fp.v, order.indexOf(followIdx) + 1);
      const c = r.cars[followIdx];
      const actual: { s: number; v: number }[] = [];
      const from = isFinite(c.lastCross) && c.lastCross <= s.clock ? Math.ceil(c.lastCross / r.dt) : 0;
      for (let kk = from; kk <= k; kk += 3) actual.push({ s: r.frames[kk][followIdx * F], v: r.frames[kk][followIdx * F + 2] });
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
  // Replay: the same scenario and seed (an identical race). New seed: the same scenario rerolled.
  $('restart').onclick = () => rerun(() => {});
  $('reseed').onclick = () => rerun((s) => { s.seed = (s.seed + 1) >>> 0; });
  $('gen').onclick = () => rerun((s) => { s.track = { type: 'generated', seed: Math.floor(Math.random() * 1e6), width: s.track.width ?? WIDTH }; });
  $('edit').onclick = () => { editorBox.hidden = !editorBox.hidden; $('edit').classList.toggle('on', !editorBox.hidden); };
  drawBtn.onclick = () => setDrawing(!drawing);
  closeBtn.onclick = () => {
    if (clicks.length < 3) { info.textContent = 'Need at least 3 points'; return; }
    const world = clicks.map((p): [number, number] => [Math.round((p.x - innerWidth / 2) * 20) / 10, Math.round((innerHeight / 2 - p.y) * 20) / 10]);
    setDrawing(false);
    rerun((s) => { s.track = { type: 'drawn', points: world, width: s.track.width ?? WIDTH }; s.events = s.events?.filter((e) => e.lap <= s.race.laps); });
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

/** First scenario: a shared link (#s=...), an example (?scenario=name), else the URL parameters. */
async function initial(): Promise<Scenario> {
  if (location.hash.startsWith('#s=')) {
    const res = await decodeScenario(location.hash);
    if (res.ok) { sharedJson = JSON.stringify(res.scenario); return res.scenario; }
    showErrors(res.errors.map(formatError));
  }
  const ex = params.get('scenario');
  if (ex && EXAMPLES[ex]) return EXAMPLES[ex];
  if (ex) console.warn(`[racing-sim] no example scenario "${ex}" (have: ${Object.keys(EXAMPLES).join(', ')})`);
  return urlScenario();
}

buildControls();
resize();
void initial().then(async (s) => { if (!(await runScenario(s))) editor.set(s); });
requestAnimationFrame(frame);

/// <reference types="vite/client" />
import {
  buildTrack, CAR_LENGTH, CAR_WIDTH, decodeScenario, encodeScenario, FRAME_STRIDE as F, formatError, lanePlansFor, LaneSet, parseScenario,
  qualifyingRun, Race, type Scenario, ScenarioBuildError, scenarioRaceOptions, STATUS, Track, trackKey, type Vec,
} from '../core';
import { ScenarioEditor } from '../editor/scenario-editor';
import { BATTLE_MAX, BATTLE_MIN, BATTLE_NEAR, battleGroup, type CamMode, centred, clampZoom, FOLLOW_SCALE, frame as frameView, zoomAt } from './camera';
import { RaceAt } from './at';
import { drawCar, drawTrack, fitView, fmtTime, type View } from './draw';
import { brakeAt, drawParticles, drawSkidMarks, puffsAt, skidMarksAt, sparksAt } from './effects';
import { type Livery, liveries } from './livery';
import { drawMinimap } from './minimap';
import { statRows } from './stats';
import { drawTimeline, timelineDuration } from './timeline';
import { deltaToBest, nextMode, sectorBoard, sectorCell, type SectorCell, TOWER_HOLD, TOWER_LABEL, TOWER_MODES, TOWER_ROTATE, type TowerMode, fastestLap, towerCell } from './tower';
import { drawSpeedTrace, pedals, type TracePoint } from './trace';
import { raceOver, raceSummary, summaryHtml } from './summary';
import { qualiHtml, qualiSummary } from './quali';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('c');
const ctx = canvas.getContext('2d')!;
const traceCanvas = $<HTMLCanvasElement>('trace');
const tctx = traceCanvas.getContext('2d')!;
const tlCanvas = $<HTMLCanvasElement>('tl');
const tlctx = tlCanvas.getContext('2d')!;
const miniCanvas = $<HTMLCanvasElement>('mini');
const mctx = miniCanvas.getContext('2d')!;
const info = $('info'), hud = $('hud'), tower = $('tower'), feed = $('feed');
const hudLive = $('hud-live'), hudStats = $('hud-stats');
const drawBtn = $<HTMLButtonElement>('draw'), closeBtn = $<HTMLButtonElement>('close');

/** Margin (CSS px) around the track in the overview, so the panels at the sides cover less of it. */
const OVERVIEW_PAD = 90;

const params = new URLSearchParams(location.search);
const WIDTH = 14;
let drawing = false;
let clicks: Vec[] = [];

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
let speed = Number(params.get('speed') ?? 1);
let paused = false;
const camParam = params.get('cam');
let camMode: CamMode = camParam === 'all' ? 'all' : camParam === 'battle' ? 'battle' : 'follow';
/** User zoom on top of the automatic follow and battle framing. */
const zoom = { follow: 1, battle: 1 };
let followIdx = -1;

interface Session {
  track: Track;
  lanes: LaneSet;
  race: Race;
  scenario: Scenario;
  overview: View;
  /** The overview with the user's zoom and pan. */
  allView: View;
  cam: View;
  /** Battle cam: framing centre relative to the followed car (eased), in metres. */
  battleOff: Vec;
  /** Sim time the viewer is showing (the race is computed up to at least this, often further). */
  clock: number;
  /** Furthest time watched so far: the timeline only marks events up to here (no spoilers). */
  watched: number;
  label: string;
  /** The result panel has opened by itself for this race (it opens once, at the flag). */
  resultShown: boolean;
}
let S: Session | null = null;

/** Panels sit below the toolbar, however many lines it wraps to. */
const barObserver = new ResizeObserver(() => {
  document.documentElement.style.setProperty('--bar', `${$('bar').getBoundingClientRect().bottom}px`);
});
barObserver.observe($('bar'));
/** The event feed (bottom right) shrinks so it never runs under the follow panel (top right). */
const hudObserver = new ResizeObserver(() => {
  document.documentElement.style.setProperty('--hud', `${hud.getBoundingClientRect().bottom}px`);
});
hudObserver.observe(hud);

function resize() {
  const dpr = devicePixelRatio || 1;
  for (const c of [canvas, traceCanvas, tlCanvas, miniCanvas]) {
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
  }
  if (S) S.allView = S.overview = fitView(S.track.centerline(), canvas.width, canvas.height, OVERVIEW_PAD * dpr);
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
    const overview = fitView(track.centerline(), canvas.width, canvas.height, OVERVIEW_PAD * (devicePixelRatio || 1));
    S = { track, lanes, race, scenario: structuredClone(s), overview, allView: overview, cam: { ...overview }, battleOff: { x: 0, y: 0 }, clock: 0, watched: 0, label: s.name, resultShown: false };
  } catch (e) {
    showErrors(e instanceof ScenarioBuildError ? e.errors.map(formatError) : [(e as Error).message]);
    return false;
  }
  qualiBack = null;
  $('backRace').hidden = true;
  setQuali(false);
  feedKey = '';
  towerKey = '';
  towerMode = 'gap';
  towerSwitched = performance.now();
  statsKey = '';
  followIdx = 0;
  setResult(false);
  editor.set(s);
  const n = S.race.cars.length;
  info.textContent = `${s.name} · ${S.track.length.toFixed(0)} m · ${n} cars · ${s.race.laps} laps · seed ${s.seed}`;
  console.info(`[racing-sim] scenario "${s.name}": ${S.track.length.toFixed(0)} m, ${n} cars, ${s.race.laps} laps, seed ${s.seed}`);
  return true;
}

function showErrors(errs: string[]) {
  info.textContent = `Scenario not run: ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} more)` : ''}`;
  console.warn('[racing-sim] scenario errors:\n' + errs.join('\n'));
  setEditor(true);
}

/** Show or hide the scenario editor panel (and light its menu item while open). */
function setEditor(open: boolean) {
  editorBox.hidden = !open;
  $('edit').classList.toggle('on', open);
}

const summaryBox = $('summary');
/** Show or hide the result panel. It can only open once the viewer has reached the end of the race. */
function setResult(open: boolean) {
  const s = S;
  const over = !!s && raceOver(s.race, new RaceAt(s.race, s.clock).k);
  if (open && s && over) summaryBox.innerHTML = summaryHtml(s.label, raceSummary(s.race));
  summaryBox.hidden = !(open && over);
  $('result').classList.toggle('on', !summaryBox.hidden);
}

/** Watching a qualifying run: the race session to go back to, and who was followed there. */
let qualiBack: { session: Session; follow: number; cam: CamMode } | null = null;
const qualiBox = $('quali');

/** The race (not a qualifying run being watched). */
const raceSession = () => qualiBack?.session ?? S;

/** Show or hide the qualifying panel (each car's run, from the race's grid). */
function setQuali(open: boolean) {
  const s = raceSession();
  if (open && s) qualiBox.innerHTML = qualiHtml(s.label, qualiSummary(s.race.opts.entrants));
  qualiBox.hidden = !(open && s);
  $('qualiBtn').classList.toggle('on', !qualiBox.hidden);
}

/**
 * Watch entrant i's qualifying run: re-run it from its seed (deterministic, so it is the lap that
 * set the time) and show it as its own session on the same track, until "Back to race".
 */
function watchQuali(i: number) {
  const base = raceSession();
  const e = base?.race.opts.entrants[i];
  if (!base || !e?.quali) return;
  const sc = base.scenario;
  const race = qualifyingRun({ lanes: base.lanes, entrant: e, seed: e.quali.seed, physics: sc.physics, incidents: sc.race.incidents ?? true, incidentRate: sc.race.incidentRate ?? 1, sectors: sc.track.sectors });
  if (!qualiBack) qualiBack = { session: base, follow: followIdx, cam: camMode };
  S = { ...base, race, clock: 0, watched: 0, label: `Qualifying · ${e.driver.name}`, resultShown: true };
  followIdx = 0;
  setCam('follow');
  setQuali(false);
  setResult(false);
  feedKey = '';
  towerKey = '';
  statsKey = '';
  towerMode = 'last';
  $('backRace').hidden = false;
  info.textContent = `Qualifying · ${e.driver.name} · ${e.quali.laps.map((t) => fmtTime(t)).join(' / ') || 'no time'}${e.quali.note ? ` · ${e.quali.note}` : ''}`;
}

/** Leave a qualifying run: the race comes back where it was left. */
function backToRace() {
  if (!qualiBack) return;
  S = qualiBack.session;
  followIdx = qualiBack.follow;
  setCam(qualiBack.cam);
  qualiBack = null;
  $('backRace').hidden = true;
  feedKey = '';
  towerKey = '';
  statsKey = '';
  towerMode = 'gap';
  const sc = S.scenario;
  info.textContent = `${sc.name} · ${S.track.length.toFixed(0)} m · ${S.race.cars.length} cars · ${sc.race.laps} laps · seed ${sc.seed}`;
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
  close: () => setEditor(false),
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

/** What the camera showed last frame, to ease from it when the followed car or mode changes. */
let camFrom: { session: Session | null; follow: number; mode: string } = { session: null, follow: -1, mode: '' };

let towerKey = '';
/** What the tower's time column shows; rotates every TOWER_ROTATE s unless the user picked one recently. */
let towerMode: TowerMode = 'gap';
let towerHeldUntil = 0;
let towerSwitched = performance.now();
function updateTowerMode(now: number, anyLaps: boolean) {
  if (now < towerHeldUntil || now - towerSwitched < TOWER_ROTATE * 1000) return;
  towerMode = nextMode(towerMode);
  // Before anyone has completed a lap, lap times would be an empty column: rotate gap and interval only.
  while (!anyLaps && (towerMode === 'last' || towerMode === 'best')) towerMode = nextMode(towerMode);
  towerSwitched = now;
}
function clickTowerMode() {
  towerMode = nextMode(towerMode);
  towerSwitched = performance.now();
  towerHeldUntil = towerSwitched + TOWER_HOLD * 1000;
}

function renderTower(s: Session, at: RaceAt, order: number[], status: number[]) {
  const r = s.race;
  const lap = at.leaderLap;
  const fastest = towerMode === 'last' || towerMode === 'best' ? fastestLap(at) : Infinity;
  const board = towerMode === 'sectors' ? sectorBoard(at) : null;
  const rows = order.map((i, p) => {
    const c = r.cars[i];
    const out = status[i] >= STATUS.crash;
    const fin = at.finished(i);
    const tag = out ? '' : incidentTag(status[i]) || craftTag(at.mode(i), fin);
    return {
      cls: `tr${i === followIdx ? ' sel' : camMode === 'battle' && battle.includes(i) ? ' bt' : ''}${fin ? ' fin' : ''}${out ? ' out' : ''}`,
      i,
      inner: `<span class="p">${out ? '' : p + 1}</span><span class="sw" style="background:${c.entrant.color}"></span>
      <span class="nm"><span class="n">${c.entrant.driver.name}</span>${tag}</span>${cell(i, p, out)}`,
    };
  });
  function cell(i: number, p: number, out: boolean): string {
    if (out && (towerMode === 'gap' || towerMode === 'interval' || towerMode === 'sectors')) return '<span class="gap">DNF</span>';
    if (board) return `<span class="gap">${sectorChips(sectorCell(board, i))}</span>`;
    const c = towerCell(at, order, p, towerMode, fastest);
    return `<span class="gap${c.purple ? ' purple' : ''}">${c.text}</span>`;
  }
  const held = performance.now() < towerHeldUntil;
  const dots = TOWER_MODES.map((m) => (m === towerMode ? '●' : '○')).join('');
  const modeBtn = `<span class="mode" title="${held ? 'Held (auto-rotates again after 30 s)' : 'Auto-rotating'}: click for ${TOWER_LABEL[nextMode(towerMode)].toLowerCase()}">${TOWER_LABEL[towerMode]}<span class="dots">${dots}</span></span>`;
  const grip = at.gripLevel;
  const wx = grip === 1 ? '' : `<span class="grip" title="Track grip">${grip < 1 ? 'Wet' : 'Grip'} ${(grip * 100).toFixed(0)}%</span>`;
  const sc = scState(r, s.clock);
  const banner = sc ? `<div class="scb">${sc === 'out' ? 'SAFETY CAR' : 'SAFETY CAR IN THIS LAP'}</div>` : '';
  const head = `<div class="hd"><span>${at.leaderFinished ? 'Finished' : `Lap ${lap} / ${r.laps}`}</span>${wx}${modeBtn}</div>${banner}`;
  const key = head + rows.map((x) => x.cls + x.i + x.inner).join('');
  if (key === towerKey) return;
  towerKey = key;
  tower.classList.toggle('sec', towerMode === 'sectors');
  // Patch in place: the row elements stay, so the one under the pointer keeps its hover (replacing
  // the whole tower every frame made it flicker).
  const top = tower.querySelector<HTMLElement>('.top');
  const els = tower.querySelectorAll<HTMLElement>('.tr');
  if (!top || els.length !== rows.length) {
    tower.innerHTML = `<div class="top">${head}</div>${rows.map((x) => `<div class="${x.cls}" data-i="${x.i}">${x.inner}</div>`).join('')}`;
    return;
  }
  const set = (el: HTMLElement, html: string) => {
    if (towerHtml.get(el) !== html) { el.innerHTML = html; towerHtml.set(el, html); }
  };
  set(top, head);
  rows.forEach((x, k) => {
    const el = els[k];
    if (el.className !== x.cls) el.className = x.cls;
    if (el.dataset.i !== String(x.i)) el.dataset.i = String(x.i);
    set(el, x.inner);
  });
}
/** The HTML last written into each tower element (the browser's own serialisation differs). */
const towerHtml = new WeakMap<HTMLElement, string>();

/** The current lap's three sectors as coloured chips, then the latest sector time. */
function sectorChips(c: SectorCell): string {
  const chips = c.colors.map((col, k) => `<i class="sc ${col}" title="S${k + 1} ${Number.isFinite(c.times[k]) ? c.times[k].toFixed(3) : '–'}"></i>`).join('');
  return `<span class="chips">${chips}</span><span class="st ${c.textColor}">${c.text.replace(/^S\d /, '')}</span>`;
}

/** Liveries per race (entrants are fixed for a race, so worked out once). */
const liveryCache = new WeakMap<Race, Livery[]>();
function liveryOf(r: Race): Livery[] {
  let l = liveryCache.get(r);
  if (!l) liveryCache.set(r, (l = liveries(r.opts.entrants)));
  return l;
}

/** Safety car state at the viewer clock, from the event log: out, in (no passing yet), or none. */
function scState(r: Race, t: number): 'out' | 'in' | '' {
  let st: 'out' | 'in' | '' = '';
  for (const e of r.events) {
    if (e.t > t) break;
    if (e.type !== 'safety-car') continue;
    st = e.text.startsWith('Safety car:') ? 'out' : e.text.startsWith('Safety car in') ? 'in' : '';
  }
  return st;
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

const FEED_TYPES = new Set(['pass', 'mistake', 'contact', 'off', 'rejoin', 'spin', 'crash', 'retire', 'cleared', 'grip', 'safety-car']);
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
    `<div class="ev ${e.type}" data-i="${e.cars[0] ?? ''}" data-t="${e.t}" title="Click: watch this moment"><span class="tm">L${e.lap} ${fmtTime(e.t)}</span><span class="tx">${e.text}</span></div>`).join('');
  const dnf = evs.filter((e) => e.type === 'crash' || e.type === 'retire').length;
  feed.innerHTML = `<div class="hd">Race events · ${evs.filter((e) => e.type === 'pass').length} passes${dnf ? ` · ${dnf} DNF` : ''}</div>${rows || '<div class="ev"><span></span><span class="tm">Nothing yet</span></div>'}`;
}

function renderHud(s: Session, at: RaceAt, i: number, v: number, pos: number) {
  const c = s.race.cars[i];
  const laps = at.lapTimes(i);
  const last = at.lastCross(i);
  const cur = at.finished(i) ? NaN : isFinite(last) ? s.clock - last : NaN;
  const damage = at.damage(i);
  hudLive.innerHTML = `
    <div class="row"><span style="color:${c.entrant.color};font-weight:600">${c.entrant.driver.name}</span><span>P${pos}</span></div>
    <div class="big">${(v * 3.6).toFixed(0)} km/h</div>
    <div class="row"><span class="lbl">This lap</span><span>${fmtTime(cur)}${deltaHtml(deltaToBest(at, i))}</span></div>
    ${sectorRow(at, i)}
    <div class="row"><span class="lbl">Last lap</span><span>${laps.length ? fmtTime(laps[laps.length - 1]) : '–'}</span></div>
    <div class="row"><span class="lbl">Best lap</span><span>${laps.length ? fmtTime(Math.min(...laps)) : '–'}</span></div>
    ${idealRows(s, at, i)}
    ${damage > 0 ? `<div class="row"><span class="lbl">Damage</span><span>−${(damage * 100).toFixed(1)}% grip</span></div>` : ''}
    ${at.out(i) ? '<div class="row"><span class="lbl">Status</span><span style="color:#ff4d4d">Retired</span></div>' : ''}`;
  renderStats(s, i);
}

/** Time against the car's best lap at this point of the lap: green ahead, red behind. */
function deltaHtml(d: number): string {
  if (!Number.isFinite(d)) return '';
  return ` <span class="dl ${d <= 0 ? 'ahead' : 'behind'}" title="Against their best lap at this point of the lap">${d <= 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}</span>`;
}

/** The followed car's sectors this lap, coloured as in the tower. */
function sectorRow(at: RaceAt, i: number): string {
  const c = sectorCell(sectorBoard(at), i);
  const cells = c.times.map((t, k) => `<span class="${c.colors[k]}">${Number.isFinite(t) ? t.toFixed(2) : `S${k + 1}`}</span>`).join('');
  return `<div class="row secs"><span class="lbl">Sectors</span><span class="sv">${cells}</span></div>`;
}

/**
 * Clean-air ideal laps: at the limit (a push lap, the driver's speed rating) and, in a race, at
 * race pace (a margin under it, from consistency).
 */
function idealRows(s: Session, at: RaceAt, i: number): string {
  const e = s.race.cars[i].entrant;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const quali = s.race.opts.session === 'qualifying';
  const limit = quali ? at.plans(i).lapTime : lanePlansFor(s.lanes, e.car, e.driver.pace, { ...s.race.physics, gripLevel: at.gripLevel }).plans.lapTime;
  const push = `<div class="row" title="Clean air at the limit, using ${pct(e.driver.pace)} of the car's grip (their speed rating): a qualifying lap"><span class="lbl">Ideal push lap</span><span>${fmtTime(limit)}</span></div>`;
  if (quali) return push;
  const pace = s.race.paceOf(e);
  return `<div class="row" title="Clean air at race pace, using ${pct(pace)} of the car's grip: their limit less a margin that is bigger for a less consistent driver"><span class="lbl">Ideal race lap</span><span>${fmtTime(at.plans(i).lapTime)}</span></div>${push}`;
}

/** Driver ratings and car spec of the followed car, each ranked in the field (only re-rendered when it changes). */
let statsKey = '';
let statsOpen = localStorage.getItem('racing-sim.stats') !== '0';
function renderStats(s: Session, i: number) {
  const key = `${i}/${statsOpen}`;
  if (key === statsKey) return;
  statsKey = key;
  const st = statRows(s.race.cars.map((c) => c.entrant), i);
  const rows = (rs: typeof st.driver) => rs.map((r) =>
    `<div class="sr" title="${r.hint}"><span class="lbl">${r.label}</span><span>${r.value}</span><span class="rk${r.rank.startsWith('1st') ? ' top' : ''}">${r.rank}</span></div>`).join('');
  hudStats.innerHTML = `<div class="st"><div class="tg" title="Show or hide the driver and car stats"><span>Driver &amp; car</span><span>${statsOpen ? '▾' : '▸'}</span></div>
    <div class="prof">${st.profile}</div>
    ${statsOpen ? `<div class="sub">Driver</div>${rows(st.driver)}<div class="sub">Car</div>${rows(st.car)}` : ''}</div>`;
}

let last = performance.now();
function frame(now: number) {
  const elapsed = Math.max(0, Math.min(0.1, (now - last) / 1000));
  last = now;
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (drawing) {
    document.body.classList.remove('mm');
    ctx.fillStyle = '#7cf';
    for (const p of clicks) {
      ctx.beginPath();
      ctx.arc(p.x * devicePixelRatio, p.y * devicePixelRatio, 4, 0, 7);
      ctx.fill();
    }
  } else if (S) {
    const s = S;
    const r = s.race;
    if (!paused && !seeking) s.clock += elapsed * speed;
    advanceTo(s, s.clock);
    computeAhead(s);
    s.watched = Math.max(s.watched, s.clock);
    const at = new RaceAt(r, s.clock);
    const n = r.cars.length;
    const poses = Array.from({ length: n }, (_, i) => pose(s, i));
    const k = Math.min(r.orders.length - 1, Math.floor(s.clock / r.dt));
    const order = [...r.orders[k]];

    // The safety car, from its log (on the racing line).
    let scPose: { p: Vec; heading: number; sPos: number } | null = null;
    const scA = r.scLog[k], scB = r.scLog[Math.min(k + 1, r.scLog.length - 1)];
    if (!Number.isNaN(scA)) {
      const L = s.track.length;
      let ds = Number.isNaN(scB) ? 0 : scB - scA;
      if (ds < -L / 2) ds += L;
      const u = Math.max(0, Math.min(1, (s.clock - k * r.dt) / r.dt));
      const sp = (scA + ds * u + L) % L;
      const tg = s.track.tangentAt(sp);
      scPose = { p: s.track.toXY(sp, s.lanes.lineD(sp)), heading: Math.atan2(tg.y, tg.x), sPos: sp };
    }

    // Camera: overview (zoom and pan), follow one car, or frame its battle. Scale eases.
    const dpr = devicePixelRatio || 1;
    const a = Math.min(1, elapsed * 5);
    const W = canvas.width, H = canvas.height;
    if (camMode !== 'all' && followIdx >= 0) {
      // Stay centred on the car (or its battle) at any playback speed; only the zoom and the
      // battle framing's offset from the car ease.
      const p = poses[followIdx].p;
      // Switching car (or coming from the overview): start from where the camera is and ease
      // the offset to the new car away, instead of jumping.
      if (camFrom.session === s && (camFrom.follow !== followIdx || camFrom.mode === 'all')) {
        s.battleOff = { x: (W / 2 - s.cam.ox) / s.cam.scale - p.x, y: (s.cam.oy - H / 2) / s.cam.scale - p.y };
      }
      let target = FOLLOW_SCALE * dpr * zoom.follow;
      let off = { x: 0, y: 0 };
      if (camMode === 'battle') {
        battle = battleGroup(poses, followIdx, s.track.length, STATUS.crash);
        const pts = battle.map((i) => poses[i].p);
        // The safety car counts as part of the battle for the car right behind it.
        if (scPose) {
          const g = (scPose.sPos - poses[followIdx].sPos + s.track.length) % s.track.length;
          if (g <= BATTLE_NEAR) pts.push(scPose.p);
        }
        const f = frameView(pts, W, H, 90 * dpr, BATTLE_MIN * dpr, BATTLE_MAX * dpr);
        target = f.scale * zoom.battle;
        off = { x: f.c.x - p.x, y: f.c.y - p.y };
      }
      s.battleOff = { x: s.battleOff.x + (off.x - s.battleOff.x) * a, y: s.battleOff.y + (off.y - s.battleOff.y) * a };
      const sc = s.cam.scale + (target - s.cam.scale) * a;
      s.cam = centred({ x: p.x + s.battleOff.x, y: p.y + s.battleOff.y }, sc, W, H);
    } else {
      const t = s.allView;
      s.cam = { scale: s.cam.scale + (t.scale - s.cam.scale) * a, ox: s.cam.ox + (t.ox - s.cam.ox) * a, oy: s.cam.oy + (t.oy - s.cam.oy) * a };
    }

    camFrom = { session: s, follow: followIdx, mode: camMode };
    drawTrack(ctx, s.track, s.cam, s.lanes.line, r.sectorEnds.slice(0, 2), showCurvature);
    drawSkidMarks(ctx, s.cam, skidMarksAt(r, s.clock), s.clock);
    for (let p = n - 1; p >= 0; p--) {
      const i = order[p];
      drawCar(ctx, s.cam, poses[i].p, poses[i].heading, r.cars[i].entrant.color, CAR_LENGTH, CAR_WIDTH, i === followIdx && camMode !== 'all', poses[i].status, liveryOf(r)[i], brakeAt(r, i, s.clock));
    }
    drawParticles(ctx, s.cam, puffsAt(r, s.clock), sparksAt(r, s.clock));
    if (showNames) drawLabels(s, poses, order, dpr);
    if (scPose) {
      const { p, heading } = scPose;
      drawCar(ctx, s.cam, p, heading, '#ffb000', CAR_LENGTH * 1.1, CAR_WIDTH, true, 0);
      const q = { x: s.cam.ox + p.x * s.cam.scale, y: s.cam.oy - p.y * s.cam.scale };
      ctx.font = `600 ${11 * dpr}px system-ui`;
      ctx.fillStyle = '#ffb000';
      ctx.fillText('SC', q.x + 8 * dpr, q.y - 8 * dpr);
    }
    // The result opens by itself once, when the viewer reaches the end of the race; rewinding closes it.
    const over = raceOver(r, at.k);
    if (over && !s.resultShown) { s.resultShown = true; setResult(true); }
    if (!over && !summaryBox.hidden) setResult(false);
    $<HTMLButtonElement>('result').disabled = !over;
    updateTowerMode(now, fastestLap(at) < Infinity);
    renderTower(s, at, order, poses.map((q) => q.status));
    const mini = camMode !== 'all' && followIdx >= 0;
    document.body.classList.toggle('mm', mini);
    if (mini) {
      // Sized here: it has no size while hidden (Overview), when resize() may have run.
      const mw = Math.round(miniCanvas.clientWidth * dpr), mh = Math.round(miniCanvas.clientHeight * dpr);
      if (miniCanvas.width !== mw || miniCanvas.height !== mh) { miniCanvas.width = mw; miniCanvas.height = mh; }
      drawMinimap(mctx, miniCanvas.width, miniCanvas.height, s.track,
        poses.map((q, i) => ({ p: q.p, color: r.cars[i].entrant.color, out: q.status >= STATUS.crash, gone: q.status === STATUS.cleared })),
        followIdx, scPose?.p ?? null, s.cam, W, H, dpr, r.sectorEnds.slice(0, 2));
    }
    renderFeed(s);
    if (followIdx >= 0) {
      const fp = poses[followIdx];
      renderHud(s, at, followIdx, fp.v, order.indexOf(followIdx) + 1);
      const c = r.cars[followIdx];
      const actual: TracePoint[] = [];
      const lastX = at.lastCross(followIdx);
      const from = isFinite(lastX) ? Math.ceil(lastX / r.dt) : 0;
      const o = followIdx * F;
      for (let kk = from; kk <= k; kk += 3) {
        const f = r.frames[kk];
        const p: TracePoint = { s: f[o], v: f[o + 2] };
        if (showInputs) {
          // Acceleration over ±3 ticks of the log's speeds.
          const a0 = Math.max(0, kk - 3), a1 = Math.min(k, kk + 3);
          const acc = a1 > a0 ? (r.frames[a1][o + 2] - r.frames[a0][o + 2]) / ((a1 - a0) * r.dt) : 0;
          Object.assign(p, pedals(c.model, p.v, acc));
        }
        actual.push(p);
      }
      // Before the first crossing the car is on the grid behind the line: skip those points.
      const lap = from ? actual : actual.filter((p) => p.s < s.track.length / 2);
      drawSpeedTrace(tctx, traceCanvas.width, traceCanvas.height, at.plans(followIdx).profiles[s.lanes.zero].v, s.track.length, lap, fp.sPos, c.entrant.color, showInputs);
    }
    drawTimeline(tlctx, tlCanvas.width, tlCanvas.height, r, s.clock, s.watched, devicePixelRatio || 1);
  }
  requestAnimationFrame(frame);
}

/**
 * Compute the race ahead of the viewer in the background (a few ms per frame), so the timeline
 * can be scrubbed forward. The race is deterministic, so computing early changes nothing.
 */
function computeAhead(s: Session) {
  const r = s.race;
  const t0 = performance.now();
  while (!r.finished && r.t < MAX_RACE_TIME && performance.now() - t0 < 6) r.step();
}
const MAX_RACE_TIME = 3600;

/**
 * Name tags over the cars: "P3 Lee". All cars once zoomed in enough to tell them apart, else
 * only the followed one; a tag that would overlap one already drawn is skipped (leaders first).
 */
function drawLabels(s: Session, poses: { p: Vec; status: number }[], order: number[], dpr: number) {
  const all = s.cam.scale >= 1.2 * dpr;
  const ids = order.filter((i) => poses[i].status < STATUS.crash && (all || (i === followIdx && camMode !== 'all')));
  if (followIdx >= 0 && ids.includes(followIdx)) ids.splice(ids.indexOf(followIdx), 1), ids.unshift(followIdx);
  ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const placed: [number, number, number, number][] = [];
  const h = 16 * dpr;
  for (const i of ids) {
    const c = s.race.cars[i];
    const pos = order.indexOf(i) + 1;
    const text = `P${pos} ${c.entrant.driver.name}`;
    const w = ctx.measureText(text).width + 12 * dpr;
    const q = { x: s.cam.ox + poses[i].p.x * s.cam.scale, y: s.cam.oy - poses[i].p.y * s.cam.scale };
    const x = q.x + 9 * dpr, y = q.y - 9 * dpr - h;
    if (x > canvas.width || y > canvas.height || x + w < 0 || y + h < 0) continue;
    if (placed.some(([a, b, cw, ch]) => x < a + cw && a < x + w && y < b + ch && b < y + h)) continue;
    placed.push([x, y, w, h]);
    ctx.fillStyle = i === followIdx ? 'rgba(44,58,78,.92)' : 'rgba(20,22,26,.8)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = c.entrant.color;
    ctx.fillRect(x, y, 3 * dpr, h);
    ctx.fillStyle = '#e8e8e8';
    ctx.fillText(text, x + 7 * dpr, y + h / 2 + 0.5);
  }
  ctx.textBaseline = 'alphabetic';
}

/** Step the race until it has reached time t (or finished). */
function advanceTo(s: Session, t: number) {
  const r = s.race;
  while (r.t < t + r.dt && !(r.finished && r.t > t) && r.t < MAX_RACE_TIME) {
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

/** Show the pause and speed state in the timeline bar. */
function syncPlayback() {
  const pb = $('pause');
  pb.textContent = paused ? '▶' : '⏸';
  pb.classList.toggle('on', paused);
  $<HTMLSelectElement>('speed').value = String(speed);
}

function setRaceMenu(open: boolean) {
  $('raceItems').hidden = !open;
  $('raceBtn').classList.toggle('on', open);
  $('raceBtn').setAttribute('aria-expanded', String(open));
}

function buildControls() {
  const sel = $<HTMLSelectElement>('speed');
  if (!SPEEDS.includes(speed)) speed = 1;
  sel.innerHTML = SPEEDS.map((v) => `<option value="${v}">${v}x</option>`).join('');
  sel.onchange = () => { speed = Number(sel.value); paused = false; syncPlayback(); sel.blur(); };
  $('pause').onclick = () => { paused = !paused; syncPlayback(); };
  const sync = syncPlayback;
  sync();
  // The Race menu: opens on click, closes on a pick, a click elsewhere or Escape.
  $('raceBtn').onclick = () => setRaceMenu($('raceItems').hidden);
  $('raceItems').addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) setRaceMenu(false); });
  addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('#raceMenu')) setRaceMenu(false); });
  $('camAll').onclick = () => setCam('all');
  $('camFollow').onclick = () => setCam('follow');
  $('camBattle').onclick = () => setCam('battle');
  $('zoomIn').onclick = () => zoomBy(1.25);
  $('zoomOut').onclick = () => zoomBy(1 / 1.25);
  syncCam();
  // Wheel: zoom (the overview zooms about the pointer). Drag: pan the overview.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dpr = devicePixelRatio || 1;
    zoomBy(Math.exp(-e.deltaY * 0.0015), e.offsetX * dpr, e.offsetY * dpr);
  }, { passive: false });
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('mousedown', (e) => { if (!drawing && camMode === 'all') drag = { x: e.clientX, y: e.clientY }; });
  addEventListener('mouseup', () => { drag = null; });
  addEventListener('mousemove', (e) => {
    if (!drag || !S) return;
    const dpr = devicePixelRatio || 1;
    S.allView = { ...S.allView, ox: S.allView.ox + (e.clientX - drag.x) * dpr, oy: S.allView.oy + (e.clientY - drag.y) * dpr };
    S.cam = { ...S.allView };
    drag = { x: e.clientX, y: e.clientY };
  });
  // Keys (not while typing in the editor): ↑/↓ the car ahead/behind in the running order,
  // ←/→ back/forward 5 s (with shift 30 s), Home to the start, +/− zoom, 0 reset zoom,
  // o/f/b camera, n names, i throttle and brake on the speed trace, r result (once the race is over), space pause.
  addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    // Escape closes the menu and the scenario panel, even from a field inside the panel.
    if (e.key === 'Escape') { setRaceMenu(false); setEditor(false); setResult(false); setQuali(false); return; }
    if (el.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowUp') stepFollow(-1);
    else if (k === 'ArrowDown') stepFollow(1);
    else if (k === 'ArrowLeft') seek((S?.clock ?? 0) - (e.shiftKey ? 30 : 5));
    else if (k === 'ArrowRight') seek((S?.clock ?? 0) + (e.shiftKey ? 30 : 5));
    else if (k === 'Home') seek(0);
    else if (k === 'n') toggleNames();
    else if (k === 'i') toggleInputs();
    else if (k === 'k') toggleCurvature();
    else if (k === 'r') setResult(summaryBox.hidden);
    else if (k === 'q') setQuali(qualiBox.hidden);
    else if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-' || k === '_') zoomBy(1 / 1.25);
    else if (k === '0') resetZoom();
    else if (k === 'o') setCam('all');
    else if (k === 'f') setCam('follow');
    else if (k === 'b') setCam('battle');
    else if (k === ' ') { paused = !paused; sync(); if (el instanceof HTMLButtonElement) el.blur(); }
    else return;
    e.preventDefault();
  });
  $('skip').onclick = () => { if (S) S.clock += 30; };
  $('names').onclick = () => toggleNames();
  $('names').classList.toggle('on', showNames);
  $('inputs').onclick = () => toggleInputs();
  $('curv').onclick = () => { toggleCurvature(); setRaceMenu(false); };
  $('curv').classList.toggle('on', showCurvature);
  $('inputs').classList.toggle('on', showInputs);
  // Replay: back to the start of the same race (same scenario and seed: identical by design).
  $('restart').onclick = () => seek(0);
  // Timeline: click or drag to seek.
  const seekAt = (e: PointerEvent) => {
    if (!S) return;
    const rect = tlCanvas.getBoundingClientRect();
    seek(((e.clientX - rect.left) / rect.width) * timelineDuration(S.race));
  };
  tlCanvas.addEventListener('pointerdown', (e) => { seeking = true; tlCanvas.setPointerCapture(e.pointerId); seekAt(e); });
  tlCanvas.addEventListener('pointermove', (e) => { if (seeking) seekAt(e); });
  tlCanvas.addEventListener('pointerup', () => { seeking = false; });
  tlCanvas.addEventListener('pointercancel', () => { seeking = false; });
  $('reseed').onclick = () => rerun((s) => { s.seed = (s.seed + 1) >>> 0; });
  $('gen').onclick = () => rerun((s) => { s.track = { type: 'generated', seed: Math.floor(Math.random() * 1e6), width: s.track.width ?? WIDTH }; });
  $('edit').onclick = () => setEditor(editorBox.hidden);
  $('result').onclick = () => setResult(summaryBox.hidden);
  $('qualiBtn').onclick = () => setQuali(qualiBox.hidden);
  $('backRace').onclick = () => backToRace();
  // Qualifying panel: × closes it; Watch plays that run; a row follows that driver in the race.
  qualiBox.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('.x')) { setQuali(false); return; }
    const w = el.closest<HTMLElement>('[data-watch]');
    if (w) { watchQuali(Number(w.dataset.watch)); return; }
    const row = el.closest<HTMLElement>('tr[data-i]');
    if (row && !qualiBack) { followIdx = Number(row.dataset.i); if (camMode === 'all') setCam('follow'); towerKey = ''; statsKey = ''; }
  });
  // Result panel: × closes it; a row follows that driver.
  summaryBox.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('.x')) { setResult(false); return; }
    const row = el.closest<HTMLElement>('tr[data-i]');
    if (row) { followIdx = Number(row.dataset.i); if (camMode === 'all') setCam('follow'); towerKey = ''; statsKey = ''; }
  });
  drawBtn.onclick = () => setDrawing(!drawing);
  closeBtn.onclick = () => {
    if (clicks.length < 3) { info.textContent = 'Need at least 3 points'; return; }
    const world = clicks.map((p): [number, number] => [Math.round((p.x - innerWidth / 2) * 20) / 10, Math.round((innerHeight / 2 - p.y) * 20) / 10]);
    setDrawing(false);
    rerun((s) => { s.track = { type: 'drawn', points: world, width: s.track.width ?? WIDTH }; s.events = s.events?.filter((e) => e.lap <= s.race.laps); });
  };
  canvas.addEventListener('click', (e) => { if (drawing) clicks.push({ x: e.clientX, y: e.clientY }); });
  // Pointerdown, not click: the tower re-renders while the race runs, which can swallow a click.
  tower.addEventListener('pointerdown', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('.mode')) { clickTowerMode(); return; }
    const row = el.closest('.tr') as HTMLElement | null;
    if (!row) return;
    pick(Number(row.dataset.i));
  });
  hudStats.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.tg')) return;
    statsOpen = !statsOpen;
    localStorage.setItem('racing-sim.stats', statsOpen ? '1' : '0');
    if (S && followIdx >= 0) renderStats(S, followIdx);
  });
  feed.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('.ev') as HTMLElement | null;
    if (!row?.dataset.t) return;
    // Watch it again: a few seconds before it happened, following the car involved.
    if (row.dataset.i) pick(Number(row.dataset.i));
    seek(Number(row.dataset.t) - 4);
  });
  addEventListener('resize', resize);
}

/** Dragging on the timeline (the clock is held while seeking). */
let seeking = false;
let showNames = params.get('names') !== '0';
/** Debug view: track edges coloured by curvature instead of edge lines and kerbs (k). */
let showCurvature = params.get('curvature') === '1';
function toggleCurvature() {
  showCurvature = !showCurvature;
  $('curv').classList.toggle('on', showCurvature);
}
/** Throttle and brake on the speed trace (remembered between visits). */
let showInputs = localStorage.getItem('racing-sim.inputs') === '1';
function toggleInputs() {
  showInputs = !showInputs;
  localStorage.setItem('racing-sim.inputs', showInputs ? '1' : '0');
  $('inputs').classList.toggle('on', showInputs);
}

function toggleNames() {
  showNames = !showNames;
  $('names').classList.toggle('on', showNames);
}

/** Jump the viewer to time t, within what has been computed (computing more if needed is left to the background). */
function seek(t: number) {
  if (!S) return;
  const r = S.race;
  S.clock = Math.max(0, Math.min(t, r.t));
  feedKey = '';
}

/** Cars in the current battle-cam frame (for the tower). */
let battle: number[] = [];

function syncCam() {
  $('camAll').classList.toggle('on', camMode === 'all');
  $('camFollow').classList.toggle('on', camMode === 'follow');
  $('camBattle').classList.toggle('on', camMode === 'battle');
}

function setCam(m: CamMode) {
  camMode = m;
  syncCam();
}

/** Follow car i (from the overview, switch to following it). */
function pick(i: number) {
  followIdx = i;
  if (camMode === 'all') setCam('follow');
}

/** Follow the next car behind (+1) or ahead (−1) in the running order, skipping cars out of the race. */
function stepFollow(dir: number) {
  if (!S) return;
  const r = S.race;
  const k = Math.min(r.orders.length - 1, Math.floor(S.clock / r.dt));
  const now = new RaceAt(r, S.clock);
  const order = [...r.orders[k]].filter((i) => !now.out(i) || i === followIdx);
  const pos = Math.max(0, order.indexOf(followIdx));
  pick(order[Math.max(0, Math.min(order.length - 1, pos + dir))]);
}

/** Zoom the current camera by f (about screen point mx, my in the overview). */
function zoomBy(f: number, mx = canvas.width / 2, my = canvas.height / 2) {
  if (camMode === 'all') {
    if (!S) return;
    const z = S.allView.scale * f / S.overview.scale;
    if (z < 0.5 || z > 40) return;
    S.allView = zoomAt(S.allView, f, mx, my);
  } else zoom[camMode] = clampZoom(zoom[camMode] * f);
}

function resetZoom() {
  zoom.follow = zoom.battle = 1;
  if (S) S.allView = S.overview;
}

/** The example the viewer opens on when the URL asks for nothing else. */
const DEFAULT_EXAMPLE = 'f1-spec-silverstone';

/** First scenario: a shared link (#s=...), an example (?scenario=name), the URL parameters, else the default example. */
async function initial(): Promise<Scenario> {
  if (location.hash.startsWith('#s=')) {
    const res = await decodeScenario(location.hash);
    if (res.ok) { sharedJson = JSON.stringify(res.scenario); return res.scenario; }
    showErrors(res.errors.map(formatError));
  }
  const ex = params.get('scenario');
  if (ex && EXAMPLES[ex]) return EXAMPLES[ex];
  if (ex) console.warn(`[racing-sim] no example scenario "${ex}" (have: ${Object.keys(EXAMPLES).join(', ')})`);
  // No URL settings at all: open on a real track rather than a generated one.
  if (![...params.keys()].length && EXAMPLES[DEFAULT_EXAMPLE]) return EXAMPLES[DEFAULT_EXAMPLE];
  return urlScenario();
}

buildControls();
resize();
void initial().then(async (s) => { if (!(await runScenario(s))) editor.set(s); });
requestAnimationFrame(frame);

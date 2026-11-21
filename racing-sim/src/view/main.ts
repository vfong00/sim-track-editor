import { generateTrack, Track, type Vec } from '../core';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const info = document.getElementById('info')!;
const genBtn = document.getElementById('gen') as HTMLButtonElement;
const drawBtn = document.getElementById('draw') as HTMLButtonElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;

const WIDTH = 14;
let track: Track | null = null;
let seed = Number(new URLSearchParams(location.search).get('seed') ?? 7);
let drawing = false;
let clicks: Vec[] = [];

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  render();
}

/** Green (straight) → yellow → red (tight), by |curvature| against a 30 m radius. */
function curvatureColor(k: number): string {
  const t = Math.min(1, Math.abs(k) * 30);
  return `hsl(${120 - 120 * t}, 85%, 50%)`;
}

function fit(points: Vec[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  const pad = 60, dpr = devicePixelRatio || 1;
  const scale = Math.min((canvas.width - pad * 2 * dpr) / (x1 - x0 || 1), (canvas.height - pad * 2 * dpr) / (y1 - y0 || 1));
  return { scale, ox: canvas.width / 2 - ((x0 + x1) / 2) * scale, oy: canvas.height / 2 + ((y0 + y1) / 2) * scale };
}

function render() {
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (drawing) {
    // Click mode: screen-space points (y flipped later when converted to world).
    ctx.fillStyle = '#7cf';
    for (const p of clicks) {
      ctx.beginPath();
      ctx.arc(p.x * devicePixelRatio, p.y * devicePixelRatio, 4, 0, 7);
      ctx.fill();
    }
    return;
  }
  if (!track) return;
  const t = track;
  const { scale, ox, oy } = fit(t.centerline());
  const X = (x: number) => ox + x * scale;
  const Y = (y: number) => oy - y * scale;

  // Road surface, then centerline coloured by curvature.
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#2b2f37';
  ctx.lineWidth = t.width * scale;
  ctx.beginPath();
  for (let i = 0; i <= t.n; i++) ctx[i ? 'lineTo' : 'moveTo'](X(t.xs[i % t.n]), Y(t.ys[i % t.n]));
  ctx.stroke();
  ctx.lineWidth = Math.max(2, t.width * scale * 0.55);
  for (let i = 0; i < t.n; i++) {
    const j = (i + 1) % t.n;
    ctx.strokeStyle = curvatureColor(t.curvature[i]);
    ctx.beginPath();
    ctx.moveTo(X(t.xs[i]), Y(t.ys[i]));
    ctx.lineTo(X(t.xs[j]), Y(t.ys[j]));
    ctx.stroke();
  }
  // Start/finish line.
  const a = t.edge(0, 1), b = t.edge(0, -1);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(X(a.x), Y(a.y));
  ctx.lineTo(X(b.x), Y(b.y));
  ctx.stroke();
}

function setTrack(t: Track, label: string) {
  track = t;
  info.textContent = `${label} · ${t.length.toFixed(0)} m · min radius ${t.minRadius().toFixed(0)} m · clearance ${t.clearance().toFixed(0)} m`;
  render();
}

function generate() {
  drawing = false;
  drawBtn.classList.remove('on');
  closeBtn.hidden = true;
  setTrack(generateTrack({ seed, width: WIDTH }), `seed ${seed}`);
}

genBtn.onclick = () => { seed = Math.floor(Math.random() * 1e6); generate(); };
drawBtn.onclick = () => {
  drawing = !drawing;
  drawBtn.classList.toggle('on', drawing);
  closeBtn.hidden = !drawing;
  clicks = [];
  info.textContent = drawing ? 'Click points around the loop, then "Close loop"' : '';
  render();
};
closeBtn.onclick = () => {
  if (clicks.length < 3) { info.textContent = 'Need at least 3 points'; return; }
  const world = clicks.map((p) => ({ x: p.x - innerWidth / 2, y: innerHeight / 2 - p.y }));
  drawing = false;
  drawBtn.classList.remove('on');
  closeBtn.hidden = true;
  setTrack(Track.fromControlPoints(world, WIDTH), 'drawn');
};
canvas.addEventListener('click', (e) => {
  if (!drawing) return;
  clicks.push({ x: e.clientX, y: e.clientY });
  render();
});
addEventListener('resize', resize);

generate();
resize();

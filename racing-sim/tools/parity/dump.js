// Shared by tools/parity (browser) and Node scripts: exact state dumps for diffing the two engines.
// Shared by parity.html and the Node check: the full state of every car per tick, as hex doubles.
export function tickDump(race, ticks) {
  const lines = [];
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  const hex = (x) => { f64[0] = x; return u32[1].toString(16) + u32[0].toString(16).padStart(8, '0'); };
  for (let k = 0; k < ticks; k++) {
    race.step();
    lines.push(race.cars.map((c) => [c.st.s, c.st.delta, c.st.v, c.st.vDelta].map(hex).join(',')).join(';'));
  }
  return lines;
}

// Setup stages, each as a short fingerprint: the first index where values could differ shows up as a changed hash.
export function setupDump(race, opts) {
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  const hex = (x) => { f64[0] = x; return u32[1].toString(16) + u32[0].toString(16).padStart(8, '0'); };
  const h = (arr) => { let a = 0x811c9dc5; for (const x of arr) { f64[0] = x; a = Math.imul(a ^ u32[0], 16777619) ^ u32[1]; a = Math.imul(a, 16777619); } return (a >>> 0).toString(16); };
  const t = race.lanes.track, L = race.lanes;
  const out = [
    `track.length ${hex(t.length)}`, `track.xs ${h(t.xs)}`, `track.ys ${h(t.ys)}`, `track.curvature ${h(t.curvature)}`, `track.nx ${h(t.nx)}`,
    `line ${h(Array.from({ length: t.n }, (_, i) => L.lineD(i * t.ds)))}`,
    `kappas ${L.kappas.map(h).join(' ')}`,
  ];
  for (const c of race.cars) out.push(`car ${c.entrant.driver.name} grid ${hex(c.entrant.gridTime ?? NaN)} env ${c.plans.envelopes.map(h).join(' ')}`);
  return out;
}

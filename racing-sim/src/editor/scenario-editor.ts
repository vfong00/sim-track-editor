import { formatError, parseScenario, RANGES, type Scenario, type ScenarioError } from '../core';

/**
 * Scenario editor panel (Phase 6): a form over a draft scenario object, kept in sync with a raw
 * JSON view. Edits validate live; "Run" hands a valid scenario to the viewer. The editor never
 * touches a running race (rule 4): it only produces scenarios.
 */
export interface EditorHooks {
  run(s: Scenario): void;
  examples: Record<string, Scenario>;
  /** Called when the user picks "load PNG": returns a data URL, or null if cancelled. */
  pickPng(): Promise<string | null>;
  /** Make a share link; returns a message for the user. */
  share(s: Scenario): Promise<string>;
  save(s: Scenario): void;
  open(): Promise<unknown | null>;
}

type Path = (string | number)[];

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class ScenarioEditor {
  draft: Scenario;
  private errors: ScenarioError[] = [];
  private jsonDirty = false;

  constructor(readonly root: HTMLElement, readonly hooks: EditorHooks, initial: Scenario) {
    this.draft = structuredClone(initial);
    root.addEventListener('input', (e) => this.onInput(e));
    root.addEventListener('change', (e) => this.onChange(e));
    root.addEventListener('click', (e) => this.onClick(e));
    this.render();
  }

  /** Replace the draft (a scenario was loaded or the track changed elsewhere). */
  set(s: Scenario) {
    this.draft = structuredClone(s);
    this.jsonDirty = false;
    this.render();
  }

  // ---- rendering --------------------------------------------------------------------------

  private num(path: Path, value: unknown, range?: readonly [number, number], step = 'any', placeholder = '') {
    const [lo, hi] = range ?? ['', ''];
    return `<input type="number" data-path="${path.join('.')}" data-kind="num" value="${value ?? ''}" min="${lo}" max="${hi}" step="${step}" placeholder="${placeholder}">`;
  }
  private text(path: Path, value: unknown, placeholder = '') {
    return `<input type="text" data-path="${path.join('.')}" data-kind="str" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
  }
  private select(path: Path, value: unknown, options: [string, string][], rerender = false) {
    return `<select data-path="${path.join('.')}" data-kind="sel"${rerender ? ' data-rerender="1"' : ''}>${options.map(([v, l]) =>
      `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  private row(label: string, input: string, hint = '') {
    return `<label class="row"><span>${label}</span>${input}${hint ? `<em>${hint}</em>` : ''}</label>`;
  }

  render() {
    const s = this.draft;
    const carOpts = s.cars.map((c): [string, string] => [c.id, c.id]);
    const t = s.track;
    let track = this.row('Type', this.select(['track', 'type'], t.type, [['generated', 'Generated'], ['drawn', 'Drawn'], ['png', 'PNG image']], true));
    if (t.type === 'generated') {
      track += this.row('Seed', this.num(['track', 'seed'], t.seed, [0, 4294967295], '1'));
      track += this.row('Complexity', this.num(['track', 'complexity'], t.complexity, RANGES.complexity, '0.05', '0.6'));
    } else if (t.type === 'drawn') {
      track += `<div class="note">${t.points.length} points. Use <b>Draw track</b> in the bar to draw a new one.</div>`;
    } else {
      track += `<div class="note">${t.image ? `Image: ${(t.image.length / 1024).toFixed(0)} kB` : 'No image yet'} <button data-act="png">Load PNG…</button></div>`;
      track += this.row('Length (m)', this.num(['track', 'length'], t.length, RANGES.pngLength, '1'));
    }
    track += this.row('Width (m)', this.num(['track', 'width'], t.width, RANGES.width, '0.5', '14'));

    const cars = s.cars.map((c, i) => `<tr>
      <td>${this.text(['cars', i, 'id'], c.id)}</td>
      <td>${this.num(['cars', i, 'topSpeed'], c.topSpeed, RANGES.topSpeed, '1', '85')}</td>
      <td>${this.num(['cars', i, 'accel'], c.accel, RANGES.accel, '0.5', '11')}</td>
      <td>${this.num(['cars', i, 'grip'], c.grip, RANGES.grip, '0.01', '1')}</td>
      <td>${this.num(['cars', i, 'brake'], c.brake, RANGES.brake, '0.01', '1')}</td>
      <td><button class="x" data-act="del" data-path="cars.${i}" title="Remove">✕</button></td></tr>`).join('');

    const drivers = (s.drivers ?? []).map((d, i) => `<tr>
      <td><input type="color" data-path="drivers.${i}.color" data-kind="str" value="${esc(d.color ?? '#cccccc')}"></td>
      <td>${this.text(['drivers', i, 'name'], d.name)}</td>
      <td>${this.select(['drivers', i, 'car'], d.car, carOpts)}</td>
      <td>${this.num(['drivers', i, 'speed'], d.speed, RANGES.rating, '0.05', '0.5')}</td>
      <td>${this.num(['drivers', i, 'consistency'], d.consistency, RANGES.rating, '0.05', '0.85')}</td>
      <td>${this.num(['drivers', i, 'risk'], d.risk, RANGES.rating, '0.05', '0.5')}</td>
      <td><button class="x" data-act="del" data-path="drivers.${i}" title="Remove">✕</button></td></tr>`).join('');

    const names = (s.drivers ?? []).map((d): [string, string] => [d.name, d.name]);
    const events = (s.events ?? []).map((e, i) => `<tr>
      <td>${this.num(['events', i, 'lap'], e.lap, [1, s.race.laps], '1')}</td>
      <td>${this.select(['events', i, 'type'], e.type, [['grip', 'Grip'], ['spin', 'Spin'], ['retire', 'Retire'], ['safety-car', 'Safety car']], true)}</td>
      <td>${e.type === 'grip' ? this.num(['events', i, 'value'], e.value, RANGES.gripLevel, '0.05')
        : e.type === 'safety-car' ? this.num(['events', i, 'laps'], e.laps, RANGES.safetyCarLaps, '1', 'laps')
        : this.select(['events', i, 'driver'], e.driver, names)}</td>
      <td>${this.text(['events', i, 'note'], e.note, 'note')}</td>
      <td><button class="x" data-act="del" data-path="events.${i}" title="Remove">✕</button></td></tr>`).join('');

    const f = s.field;
    const exampleOpts: [string, string][] = [['', 'Examples…'], ...Object.entries(this.hooks.examples).map(([k, v]): [string, string] => [k, v.name])];

    this.root.innerHTML = `
      <div class="ed-top">
        <select data-act="example">${exampleOpts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>
        <button data-act="open">Open…</button><button data-act="save">Save</button><button data-act="share">Share link</button>
      </div>
      <div class="ed-msg" id="ed-msg"></div>
      <section><h4>Scenario</h4>
        ${this.row('Name', this.text(['name'], s.name))}
        ${this.row('Notes', `<textarea data-path="description" data-kind="str" rows="2">${esc(s.description)}</textarea>`)}
        ${this.row('Race seed', this.num(['seed'], s.seed, [0, 4294967295], '1'), 'same seed = same race')}
      </section>
      <section><h4>Race rules</h4>
        ${this.row('Laps', this.num(['race', 'laps'], s.race.laps, RANGES.laps, '1'))}
        ${this.row('Grid', this.select(['race', 'gridOrder'], s.race.gridOrder ?? 'as-listed', [['as-listed', 'As listed'], ['rating', 'Quickest on pole'], ['reverse-rating', 'Reverse (slowest on pole)'], ['random', 'Random (seeded)']]))}
        ${this.row('Incidents', `<input type="checkbox" data-path="race.incidents" data-kind="bool"${s.race.incidents === false ? '' : ' checked'}>`, 'off: road edge is a wall')}
        ${this.row('Incident rate', this.num(['race', 'incidentRate'], s.race.incidentRate, RANGES.incidentRate, '0.1', '1'), '× odds')}
        ${this.row('Safety car', this.select(['race', 'safetyCar'], s.race.safetyCar ?? 'off', [['off', 'Only when scripted'], ['auto', 'Also when a car stops on track']]))}
      </section>
      <section><h4>Track</h4>${track}</section>
      <section><h4>Physics</h4>
        ${this.row('Start grip', this.num(['physics', 'gripLevel'], s.physics?.gripLevel, RANGES.gripLevel, '0.05', '1'), '1 = dry')}
        ${this.row('Slipstream', this.num(['physics', 'slipstream'], s.physics?.slipstream, RANGES.slipstream, '0.01', '0.25'))}
        ${this.row('Dirty air', this.num(['physics', 'dirtyAir'], s.physics?.dirtyAir, RANGES.dirtyAir, '0.01', '0.06'))}
      </section>
      <section><h4>Cars</h4>
        <table><tr><th>id</th><th>top m/s</th><th>accel</th><th>grip</th><th>brake</th><th></th></tr>${cars}</table>
        <button data-act="add-car">+ Car</button>
      </section>
      <section><h4>Drivers <em>speed · consistency · risk, 0–1</em></h4>
        <table><tr><th></th><th>name</th><th>car</th><th>speed</th><th>cons.</th><th>risk</th><th></th></tr>${drivers}</table>
        <button data-act="add-driver">+ Driver</button>
        ${this.row('Generated field', this.num(['field', 'count'], f?.count, RANGES.fieldCount, '1', 'none'), 'extra drivers')}
        ${f ? this.row('Field car', this.select(['field', 'car'], f.car, carOpts)) + this.row('Field spread', this.num(['field', 'spread'], f.spread, [0, 1], '0.1', '1'), '0 = all average') : ''}
      </section>
      <section><h4>Mid-race events <em>when the leader starts the lap</em></h4>
        <table><tr><th>lap</th><th>type</th><th>value</th><th>note</th><th></th></tr>${events}</table>
        <button data-act="add-event">+ Event</button>
        <div class="note">Grip: track grip from then on (1 = dry). Safety car: value = laps it stays out.</div>
      </section>
      <section><h4>JSON</h4>
        <textarea id="ed-json" rows="10" spellcheck="false"></textarea>
        <button data-act="apply-json">Apply JSON</button>
      </section>
      <div class="ed-errors" id="ed-errors"></div>
      <div class="ed-run"><button class="primary" data-act="run">▶ Run scenario</button></div>`;
    this.validate();
  }

  private validate() {
    const res = parseScenario(this.draft);
    this.errors = res.ok ? [] : res.errors;
    const box = this.root.querySelector('#ed-errors')!;
    box.innerHTML = this.errors.length ? `<b>${this.errors.length} problem${this.errors.length > 1 ? 's' : ''}</b>` + this.errors.map((e) => `<div>${esc(formatError(e))}</div>`).join('') : '';
    this.root.querySelectorAll('[data-path]').forEach((el) => el.classList.toggle('bad', this.errors.some((e) => e.path.replace(/\[(\d+)\]/g, '.$1') === (el as HTMLElement).dataset.path)));
    (this.root.querySelector('[data-act="run"]') as HTMLButtonElement).disabled = this.errors.length > 0;
    if (!this.jsonDirty) (this.root.querySelector('#ed-json') as HTMLTextAreaElement).value = jsonView(this.draft);
  }

  message(text: string, kind: 'ok' | 'err' = 'ok') {
    const m = this.root.querySelector('#ed-msg') as HTMLElement;
    m.textContent = text;
    m.className = `ed-msg ${kind}`;
  }

  // ---- editing ----------------------------------------------------------------------------

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.id === 'ed-json') { this.jsonDirty = true; return; }
    const path = el.dataset.path;
    if (!path || el.dataset.act) return;
    const kind = el.dataset.kind;
    let v: unknown;
    if (kind === 'num') v = el.value === '' ? undefined : Number(el.value);
    else if (kind === 'bool') v = el.checked ? undefined : false;
    else v = el.value === '' && path !== 'name' ? undefined : el.value;
    if (path === 'field.count') {
      // Cleared: no generated field. Set for the first time: a field in the first car.
      const had = !!this.draft.field;
      if (v === undefined) delete this.draft.field;
      else this.draft.field = { car: this.draft.cars[0]?.id ?? 'standard', ...this.draft.field, count: v as number };
      if (had !== !!this.draft.field) { this.render(); return; }
      this.validate();
      return;
    }
    this.setPath(path.split('.'), v);
    if (el.dataset.rerender) { this.render(); return; }
    this.validate();
  }

  private onChange(e: Event) {
    const el = e.target as HTMLSelectElement;
    if (el.dataset.act === 'example') {
      const ex = this.hooks.examples[el.value];
      if (ex) { this.set(ex); this.hooks.run(this.draft); }
      return;
    }
    if (el.tagName === 'SELECT' && el.dataset.path) this.onInput(e);
  }

  private setPath(path: string[], v: unknown) {
    const s = this.draft as unknown as Record<string, unknown>;
    if (path[0] === 'track' && path[1] === 'type') {
      const width = this.draft.track.width;
      this.draft.track = v === 'generated' ? { type: 'generated', seed: 7, width }
        : v === 'drawn' ? { type: 'drawn', points: DEFAULT_DRAWN, width }
        : { type: 'png', image: '', length: 4000, width };
      return;
    }
    if (path[0] === 'events' && path[2] === 'type') {
      const i = Number(path[1]);
      const old = this.draft.events![i];
      this.draft.events![i] = v === 'grip' ? { lap: old.lap, type: 'grip', value: 0.8, note: old.note }
        : v === 'safety-car' ? { lap: old.lap, type: 'safety-car', laps: 2, note: old.note }
        : { lap: old.lap, type: v as 'spin' | 'retire', driver: this.draft.drivers?.[0]?.name ?? '', note: old.note };
      return;
    }
    let o: Record<string, unknown> = s;
    for (let k = 0; k < path.length - 1; k++) {
      const key = path[k];
      if (o[key] === undefined) o[key] = {};
      o = o[key] as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    if (v === undefined) delete o[last];
    else o[last] = v;
    // Drop empty optional groups so the JSON stays tidy.
    if (path[0] === 'physics' && this.draft.physics && !Object.keys(this.draft.physics).length) delete this.draft.physics;
  }

  private async onClick(e: Event) {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b?.dataset.act) return;
    const s = this.draft;
    switch (b.dataset.act) {
      case 'run':
        if (!this.errors.length) this.hooks.run(structuredClone(s));
        return;
      case 'del': {
        const [list, i] = b.dataset.path!.split('.');
        const arr = (s as unknown as Record<string, unknown[]>)[list];
        arr.splice(Number(i), 1);
        if (list === 'events' && !arr.length) delete s.events;
        break;
      }
      case 'add-car': s.cars.push({ id: uniq('car', s.cars.map((c) => c.id)) }); break;
      case 'add-driver': (s.drivers ??= []).push({ name: uniq('Driver', s.drivers.map((d) => d.name)), car: s.cars[0]?.id ?? '' }); break;
      case 'add-event': (s.events ??= []).push({ lap: Math.min(2, s.race.laps), type: 'grip', value: 0.8, note: 'rain' }); break;
      case 'png': {
        const url = await this.hooks.pickPng();
        if (url && s.track.type === 'png') s.track.image = url;
        break;
      }
      case 'apply-json': {
        const text = (this.root.querySelector('#ed-json') as HTMLTextAreaElement).value;
        const res = parseScenario(text);
        if (!res.ok) {
          try { this.draft = JSON.parse(text); } catch { /* keep the draft; show the error */ }
          this.jsonDirty = true;
          this.validate();
          this.root.querySelector('#ed-errors')!.innerHTML = `<b>JSON not applied</b>` + res.errors.map((x) => `<div>${esc(formatError(x))}</div>`).join('');
          return;
        }
        this.draft = res.scenario;
        this.jsonDirty = false;
        break;
      }
      case 'save': this.hooks.save(s); return;
      case 'share':
        try {
          this.message(await this.hooks.share(s));
        } catch (err) { this.message((err as Error).message, 'err'); }
        return;
      case 'open': {
        const data = await this.hooks.open();
        if (data === null) return;
        const res = parseScenario(data);
        if (!res.ok) { this.message(`Can't open: ${res.errors.slice(0, 3).map(formatError).join('; ')}${res.errors.length > 3 ? ` (+${res.errors.length - 3} more)` : ''}`, 'err'); return; }
        this.set(res.scenario);
        this.hooks.run(this.draft);
        return;
      }
    }
    this.render();
  }
}

const uniq = (base: string, used: string[]) => {
  for (let k = used.length + 1; ; k++) if (!used.includes(`${base} ${k}`)) return `${base} ${k}`;
};

/** Pretty JSON, with drawn points one pair per line. */
function jsonView(s: Scenario): string {
  return JSON.stringify(s, null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, '[$1, $2]');
}

const DEFAULT_DRAWN: [number, number][] = [[-420, -160], [0, -230], [420, -160], [520, 40], [330, 210], [120, 130], [-90, 230], [-380, 170], [-520, 10]];

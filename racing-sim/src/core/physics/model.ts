import { exp, hypot, log } from '../fmath';
/**
 * The one physics model (design rule 1). The speed planner and the time-stepped integrator both
 * call these functions, so they can never disagree about what the car can do.
 *
 * Point mass with a friction circle:
 *   - grip μ(v) = g·(grip + downforce·v²): downforce adds grip with the square of speed, so a
 *     winged car corners much faster in fast corners and only a little faster in slow ones;
 *   - lateral acceleration a_lat = v²·κ uses up grip, leaving √(μ² − a_lat²) for the tires
 *     to drive or brake with (braking scaled by the car's `brake` factor: a friction ellipse);
 *   - the engine pushes with at most `accel` m/s²;
 *   - aerodynamic drag c·v² (c chosen so that thrust = drag exactly at `topSpeed`) slows the car
 *     when driving and helps it when braking.
 */
export const G = 9.81;

export interface CarSpec {
  id: string;
  /** m/s. With drag on, this is the asymptotic top speed on a long straight. */
  topSpeed: number;
  /** Engine acceleration, m/s² (before drag; capped by tire grip). */
  accel: number;
  /** Tire friction coefficient (multiples of g). */
  grip: number;
  /** Braking strength relative to grip (friction-ellipse longitudinal axis). */
  brake: number;
  /** Extra grip per (m/s)² from aerodynamic downforce, in g (0 = none). */
  downforce?: number;
  /** The preset it was built from, if any (for display; the numbers above are what count). */
  preset?: CarPreset;
  /**
   * How much braking or drive the tyres still give while cornering (phase D, a stand-in for weight
   * distribution and balance): the exponent of the grip limit, (a_long/μ)^p + (a_lat/μ)^p ≤ 1.
   * 2 is the friction ellipse (a balanced car that takes trail braking: MX-5); lower is less grip
   * combined, so braking and turning want doing apart (F1). Default 2.
   */
  trail?: number;
}

/**
 * A driver's way of using the grip (phase D styles), each 0–1:
 * - `braking`: early and smooth (0) to late and hard (1): the share of the braking the plans use.
 * - `line`: U (0) to V (1). A U driver trail-brakes and carries speed, using all the grip the car
 *   gives combined; a V driver brakes straight, turns, then drives out straight, giving up some of
 *   the combined grip for a harder peak on the brakes and the throttle. The fastest line follows.
 * - `throttle`: smooth (0) to aggressive (1): the share of the traction used out of a corner.
 * - `kerbs`: how much kerb the driver's line takes.
 * Each costs mistakes (lock-ups, power slides, running wide); see `racecraft.ts`.
 */
export interface DriverStyle {
  braking: number;
  line: number;
  throttle: number;
  kerbs: number;
}
export const NEUTRAL_STYLE: DriverStyle = { braking: 0.5, line: 0.5, throttle: 0.5, kerbs: 0.5 };

/** How a style uses a car's grip: the limit's exponent, the peak longitudinal share, and the traction share. */
export interface GripUse {
  shape: number;
  peak: number;
  drive: number;
}
export const FULL_USE: GripUse = { shape: 2, peak: 1, drive: 1 };
/** Exponent a V driver (line 1) uses at most; a U driver (line 0) uses the car's own. */
export const V_SHAPE = 1.7;
/** Peak braking and traction: a U driver (line 0) PEAK_U of it, a V driver all of it. */
export const PEAK_U = 0.97;
/** Traction share out of a corner: smooth (throttle 0) DRIVE_SMOOTH, aggressive all of it. */
export const DRIVE_SMOOTH = 0.95;
export function gripUse(spec: CarSpec, style: DriverStyle | undefined): GripUse {
  const car = spec.trail ?? 2;
  if (!style) return { ...FULL_USE, shape: car };
  const want = 2 + (V_SHAPE - 2) * style.line;
  return { shape: Math.min(car, want), peak: PEAK_U + (1 - PEAK_U) * style.line, drive: DRIVE_SMOOTH + (1 - DRIVE_SMOOTH) * style.throttle };
}

export const STANDARD_CAR: CarSpec = { id: 'standard', topSpeed: 85, accel: 11, grip: 1.0, brake: 1.0 };

/**
 * Quick car configurations. Plausible rather than exact (plan: not real-world accurate): each
 * is tuned so its lap of the Yas Marina example lands near what that class does there.
 * Downforce is the extra grip at speed v: downforce·v² g (F1 ≈ +4 g at 250 km/h). The Yas trace
 * corners a little tighter than the real track, so F1 grip is on the high side to match its lap.
 */
export const CAR_PRESETS = {
  civilian: { label: 'Civilian car (Camry-like sedan)', topSpeed: 56, accel: 3.6, grip: 0.85, brake: 0.95, downforce: 0, trail: 2 },
  mx5: { label: 'MX-5 Cup (race car on slicks)', topSpeed: 60, accel: 5.0, grip: 1.35, brake: 1.0, downforce: 0, trail: 2 },
  road: { label: 'Sports car', topSpeed: 83, accel: 8, grip: 1.05, brake: 1.0, downforce: 0, trail: 1.95 },
  gt3: { label: 'GT3', topSpeed: 79, accel: 8.5, grip: 1.35, brake: 1.05, downforce: 1.7e-4, trail: 1.85 },
  lmp: { label: 'LMP (prototype)', topSpeed: 92, accel: 10, grip: 1.55, brake: 1.05, downforce: 4.0e-4, trail: 1.8 },
  f1: { label: 'F1', topSpeed: 96, accel: 14, grip: 2.1, brake: 1.0, downforce: 8.5e-4, trail: 1.7 },
} as const;
export type CarPreset = keyof typeof CAR_PRESETS;
/**
 * Body size per preset, length × width (m), phase C: whether three wide fits into a corner, and
 * how close is alongside, depend on it. A car with no preset is CAR_SIZE_DEFAULT.
 */
export const CAR_SIZES: Record<CarPreset, { length: number; width: number }> = {
  civilian: { length: 4.9, width: 1.84 },
  mx5: { length: 3.9, width: 1.73 },
  road: { length: 4.5, width: 1.85 },
  gt3: { length: 4.7, width: 2.0 },
  lmp: { length: 4.7, width: 2.0 },
  f1: { length: 5.6, width: 2.0 },
};
export const CAR_SIZE_DEFAULT = { length: 4.0, width: 1.8 };
/**
 * How much contact a class tolerates (0–1), phase C: the user's view that some classes race closer
 * and accept bumps (an MX-5 Cup lap 1 always has some), others don't (F1). Drivers keep that much
 * less of the lap-1 following room.
 */
export const CONTACT_TOLERANCE: Record<CarPreset, number> = { civilian: 0.3, mx5: 0.6, road: 0.3, gt3: 0.3, lmp: 0.15, f1: 0 };
export const contactTolerance = (spec: CarSpec) => (spec.preset ? CONTACT_TOLERANCE[spec.preset] : 0.3);
export const carSize = (spec: CarSpec) => (spec.preset ? CAR_SIZES[spec.preset] : CAR_SIZE_DEFAULT);
export const CAR_PRESET_IDS = Object.keys(CAR_PRESETS) as CarPreset[];

export interface PhysicsParams {
  g: number;
  /** Track grip multiplier (weather). */
  gripLevel: number;
  /** Aerodynamic drag on/off (off is only useful for checking textbook formulas). */
  drag: boolean;
  /** Drag reduction when slipstreaming right behind another car (0 = off). Phase 4. */
  slipstream: number;
  /**
   * Dirty air (0 = off; Phase 4, by downforce since the racing-sim tuning pass): the share of
   * downforce a car loses right behind another, fading with distance. Mechanical grip loses
   * DIRTY_MECH of that share too (tyres and balance), so a wingless car still feels a little.
   */
  dirtyAir: number;
}

export const DEFAULT_PHYSICS: PhysicsParams = { g: G, gripLevel: 1, drag: true, slipstream: 0.25, dirtyAir: 0.2 };

/**
 * Mechanical grip lost in dirty air, as a share of the downforce lost (`dirtyAir`). With the
 * default dirtyAir of 0.2 a wingless car loses 2% of its grip right behind another (it used to
 * be 6% for every car, which kept a faster road car too far back to use the tow); an F1 car at
 * 200 km/h (over half its grip from downforce) loses about 13%. (At dirtyAir 0.3, F1 lost
 * about 22% and its DNFs more than doubled.)
 */
export const DIRTY_MECH = 0.1;

/** Per-tick modifiers from traffic (slipstream, dirty air). Planner uses NO_EFFECTS. */
export interface Effects {
  /** Multiplies all grip (pace, run-off, dirty air on the tyres). */
  grip: number;
  drag: number;
  /** Share of downforce left (dirty air); 1 if absent. */
  aero?: number;
}

/**
 * Effects of dirty air with strength `dirtyAir` at `depth` (0 = clean, 1 = right behind) on the
 * mechanical grip, and at `aeroDepth` on the downforce.
 */
export const dirtyEffects = (dirtyAir: number, depth: number, aeroDepth = depth): { grip: number; aero: number } =>
  ({ grip: 1 - DIRTY_MECH * dirtyAir * depth, aero: 1 - dirtyAir * aeroDepth });
export const NO_EFFECTS: Effects = { grip: 1, drag: 1 };

export class CarModel {
  /** Friction limit at a standstill (mechanical grip only), m/s². */
  readonly mu: number;
  /** Downforce grip per (m/s)², m/s² (already times g and the track grip level). */
  readonly aero: number;
  /** Drag coefficient per unit mass, 1/m (a_drag = cd·v²). */
  readonly cd: number;
  readonly physics: PhysicsParams;

  readonly use: GripUse;

  constructor(readonly spec: CarSpec, physics: Partial<PhysicsParams> = {}, use?: GripUse) {
    this.use = use ?? { ...FULL_USE, shape: spec.trail ?? 2 };
    this.physics = { ...DEFAULT_PHYSICS, ...physics };
    this.mu = spec.grip * this.physics.g * this.physics.gripLevel;
    this.aero = (spec.downforce ?? 0) * this.physics.g * this.physics.gripLevel;
    // Thrust on a dry straight is min(engine, tires at top speed); drag balances it exactly there.
    const thrust = Math.min(spec.accel, (spec.grip + (spec.downforce ?? 0) * spec.topSpeed * spec.topSpeed) * this.physics.g);
    this.cd = this.physics.drag ? thrust / (spec.topSpeed * spec.topSpeed) : 0;
  }

  /** Grip limit at speed v (downforce grows with v²), including traffic effects. */
  gripLimit(f: Effects = NO_EFFECTS, v = 0): number {
    return (this.mu + this.aero * (f.aero ?? 1) * v * v) * f.grip;
  }

  /** Tire grip left over for driving/braking at speed v after `alat` of cornering (0 if over the limit). */
  private longitudinalGrip(v: number, alat: number, f: Effects): number {
    const mu = this.gripLimit(f, v);
    const p = this.use.shape;
    if (p === 2) {
      const r = mu * mu - alat * alat;
      return r > 0 ? this.use.peak * Math.sqrt(r) : 0;
    }
    // (a_long/μ)^p + (a_lat/μ)^p ≤ 1, in engine-exact maths (fmath).
    const u = Math.abs(alat) / mu;
    if (!(u < 1)) return 0;
    if (u === 0) return this.use.peak * mu;
    return this.use.peak * mu * exp(log(1 - exp(p * log(u))) / p);
  }

  /**
   * Fastest steady speed on curvature κ: the tires must hold v²κ sideways and still push
   * c·v² against drag, so v²·√(κ² + c²) ≤ μ(v) = μ₀ + a·v². With u = v²: u·(k − a) ≤ μ₀, so
   * u = μ₀ / (k − a), or no grip limit at all when downforce outgrows the corner (k ≤ a).
   * Capped at the top speed.
   */
  cornerSpeed(kappa: number, f: Effects = NO_EFFECTS): number {
    const mu0 = this.mu * f.grip, a = this.aero * (f.aero ?? 1) * f.grip;
    const c = this.cd * f.drag;
    const k = hypot(kappa, c);
    const v = k > a ? Math.sqrt(mu0 / (k - a)) : Infinity;
    return Math.min(v, this.topSpeedWith(f));
  }

  /** Top speed with a drag factor (slipstream raises it). */
  topSpeedWith(f: Effects = NO_EFFECTS): number {
    return this.cd > 0 ? this.spec.topSpeed / Math.sqrt(f.drag) : this.spec.topSpeed;
  }

  /** Net forward acceleration available at speed v while cornering at `alat` (may be negative). */
  maxDrive(v: number, alat: number, f: Effects = NO_EFFECTS): number {
    if (this.cd === 0 && v >= this.spec.topSpeed) return 0;
    return Math.min(this.spec.accel, this.use.drive * this.longitudinalGrip(v, alat, f)) - this.cd * f.drag * v * v;
  }

  /** Net deceleration available at speed v while cornering at `alat` (positive number). */
  maxBrake(v: number, alat: number, f: Effects = NO_EFFECTS): number {
    return this.spec.brake * this.longitudinalGrip(v, alat, f) + this.cd * f.drag * v * v;
  }
}

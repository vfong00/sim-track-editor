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
}

export const STANDARD_CAR: CarSpec = { id: 'standard', topSpeed: 85, accel: 11, grip: 1.0, brake: 1.0 };

/**
 * Quick car configurations. Plausible rather than exact (plan: not real-world accurate): each
 * is tuned so its lap of the Yas Marina example lands near what that class does there.
 * Downforce is the extra grip at speed v: downforce·v² g (F1 ≈ +4 g at 250 km/h). The Yas trace
 * corners a little tighter than the real track, so F1 grip is on the high side to match its lap.
 */
export const CAR_PRESETS = {
  civilian: { label: 'Civilian car (Camry-like sedan)', topSpeed: 56, accel: 3.6, grip: 0.85, brake: 0.95, downforce: 0 },
  mx5: { label: 'MX-5 Cup (race car on slicks)', topSpeed: 60, accel: 5.0, grip: 1.35, brake: 1.0, downforce: 0 },
  road: { label: 'Sports car', topSpeed: 83, accel: 8, grip: 1.05, brake: 1.0, downforce: 0 },
  gt3: { label: 'GT3', topSpeed: 79, accel: 8.5, grip: 1.35, brake: 1.05, downforce: 1.7e-4 },
  lmp: { label: 'LMP (prototype)', topSpeed: 92, accel: 10, grip: 1.55, brake: 1.05, downforce: 4.0e-4 },
  f1: { label: 'F1', topSpeed: 96, accel: 14, grip: 2.1, brake: 1.0, downforce: 8.5e-4 },
} as const;
export type CarPreset = keyof typeof CAR_PRESETS;
export const CAR_PRESET_IDS = Object.keys(CAR_PRESETS) as CarPreset[];

export interface PhysicsParams {
  g: number;
  /** Track grip multiplier (weather). */
  gripLevel: number;
  /** Aerodynamic drag on/off (off is only useful for checking textbook formulas). */
  drag: boolean;
  /** Drag reduction when slipstreaming right behind another car (0 = off). Phase 4. */
  slipstream: number;
  /** Grip loss when following closely through corners (0 = off). Phase 4. */
  dirtyAir: number;
}

export const DEFAULT_PHYSICS: PhysicsParams = { g: G, gripLevel: 1, drag: true, slipstream: 0.25, dirtyAir: 0.06 };

/** Per-tick modifiers from traffic (slipstream, dirty air). Planner uses NO_EFFECTS. */
export interface Effects {
  grip: number;
  drag: number;
}
export const NO_EFFECTS: Effects = { grip: 1, drag: 1 };

export class CarModel {
  /** Friction limit at a standstill (mechanical grip only), m/s². */
  readonly mu: number;
  /** Downforce grip per (m/s)², m/s² (already times g and the track grip level). */
  readonly aero: number;
  /** Drag coefficient per unit mass, 1/m (a_drag = cd·v²). */
  readonly cd: number;
  readonly physics: PhysicsParams;

  constructor(readonly spec: CarSpec, physics: Partial<PhysicsParams> = {}) {
    this.physics = { ...DEFAULT_PHYSICS, ...physics };
    this.mu = spec.grip * this.physics.g * this.physics.gripLevel;
    this.aero = (spec.downforce ?? 0) * this.physics.g * this.physics.gripLevel;
    // Thrust on a dry straight is min(engine, tires at top speed); drag balances it exactly there.
    const thrust = Math.min(spec.accel, (spec.grip + (spec.downforce ?? 0) * spec.topSpeed * spec.topSpeed) * this.physics.g);
    this.cd = this.physics.drag ? thrust / (spec.topSpeed * spec.topSpeed) : 0;
  }

  /** Grip limit at speed v (downforce grows with v²), including traffic effects. */
  gripLimit(f: Effects = NO_EFFECTS, v = 0): number {
    return (this.mu + this.aero * v * v) * f.grip;
  }

  /** Tire grip left over for driving/braking at speed v after `alat` of cornering (0 if over the limit). */
  private longitudinalGrip(v: number, alat: number, f: Effects): number {
    const mu = this.gripLimit(f, v);
    const r = mu * mu - alat * alat;
    return r > 0 ? Math.sqrt(r) : 0;
  }

  /**
   * Fastest steady speed on curvature κ: the tires must hold v²κ sideways and still push
   * c·v² against drag, so v²·√(κ² + c²) ≤ μ(v) = μ₀ + a·v². With u = v²: u·(k − a) ≤ μ₀, so
   * u = μ₀ / (k − a), or no grip limit at all when downforce outgrows the corner (k ≤ a).
   * Capped at the top speed.
   */
  cornerSpeed(kappa: number, f: Effects = NO_EFFECTS): number {
    const mu0 = this.mu * f.grip, a = this.aero * f.grip;
    const c = this.cd * f.drag;
    const k = Math.hypot(kappa, c);
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
    return Math.min(this.spec.accel, this.longitudinalGrip(v, alat, f)) - this.cd * f.drag * v * v;
  }

  /** Net deceleration available at speed v while cornering at `alat` (positive number). */
  maxBrake(v: number, alat: number, f: Effects = NO_EFFECTS): number {
    return this.spec.brake * this.longitudinalGrip(v, alat, f) + this.cd * f.drag * v * v;
  }
}

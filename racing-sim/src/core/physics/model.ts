/**
 * The one physics model (design rule 1). The speed planner and the time-stepped integrator both
 * call these functions, so they can never disagree about what the car can do.
 *
 * Point mass with a friction circle:
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
}

export const STANDARD_CAR: CarSpec = { id: 'standard', topSpeed: 85, accel: 11, grip: 1.0, brake: 1.0 };

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
  /** Friction limit, m/s². */
  readonly mu: number;
  /** Drag coefficient per unit mass, 1/m (a_drag = cd·v²). */
  readonly cd: number;
  readonly physics: PhysicsParams;

  constructor(readonly spec: CarSpec, physics: Partial<PhysicsParams> = {}) {
    this.physics = { ...DEFAULT_PHYSICS, ...physics };
    this.mu = spec.grip * this.physics.g * this.physics.gripLevel;
    // Thrust on a dry straight is min(engine, tires); drag balances it exactly at topSpeed.
    const thrust = Math.min(spec.accel, spec.grip * this.physics.g);
    this.cd = this.physics.drag ? thrust / (spec.topSpeed * spec.topSpeed) : 0;
  }

  /** Grip limit including traffic effects. */
  gripLimit(f: Effects = NO_EFFECTS): number {
    return this.mu * f.grip;
  }

  /** Tire grip left over for driving/braking after `alat` of cornering (0 if over the limit). */
  private longitudinalGrip(alat: number, f: Effects): number {
    const mu = this.mu * f.grip;
    const r = mu * mu - alat * alat;
    return r > 0 ? Math.sqrt(r) : 0;
  }

  /**
   * Fastest steady speed on curvature κ: the tires must hold v²κ sideways and still push
   * c·v² against drag, so v⁴(κ² + c²) ≤ μ². Capped at the top speed.
   */
  cornerSpeed(kappa: number, f: Effects = NO_EFFECTS): number {
    const mu = this.mu * f.grip;
    const c = this.cd * f.drag;
    const k = Math.hypot(kappa, c);
    const v = k > 0 ? Math.sqrt(mu / k) : Infinity;
    return Math.min(v, this.topSpeedWith(f));
  }

  /** Top speed with a drag factor (slipstream raises it). */
  topSpeedWith(f: Effects = NO_EFFECTS): number {
    return this.cd > 0 ? this.spec.topSpeed / Math.sqrt(f.drag) : this.spec.topSpeed;
  }

  /** Net forward acceleration available at speed v while cornering at `alat` (may be negative). */
  maxDrive(v: number, alat: number, f: Effects = NO_EFFECTS): number {
    if (this.cd === 0 && v >= this.spec.topSpeed) return 0;
    return Math.min(this.spec.accel, this.longitudinalGrip(alat, f)) - this.cd * f.drag * v * v;
  }

  /** Net deceleration available at speed v while cornering at `alat` (positive number). */
  maxBrake(v: number, alat: number, f: Effects = NO_EFFECTS): number {
    return this.spec.brake * this.longitudinalGrip(alat, f) + this.cd * f.drag * v * v;
  }
}

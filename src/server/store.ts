import type { EngineState, Measurements } from '../core/engine.ts';
import type { AuditEntry } from '../core/types.ts';
import type { ExperimentDef, ExperimentRow } from './types.ts';

/** Thrown by createExperiment when the id is taken. */
export class DuplicateExperimentError extends Error {
  constructor(id: string) {
    super(`experiment ${id} already exists`);
    this.name = 'DuplicateExperimentError';
  }
}

export interface VisitorRow {
  variantId: string;
  phase: number;
  assignedAt: number;
  convertedAt: number | null;
}

/** What `measure` needs to know to turn stored rows into the numbers the engine reads. */
export interface MeasureSpec {
  /** Every id, the original first. */
  order: string[];
  now: number;
  /** A visitor counts once this long has passed since they were assigned. */
  windowMs: number;
  /** A conversion later than this after the visit counts as a slow one. */
  lagMs: number;
  /** The phase of the fixed test, or null if there has not been one. Only its first `confirmN` visitors per variant count. */
  confirmPhase: number | null;
  confirmN: number;
  /** The phase the engine is in now, so every phase up to it has an entry. */
  phase: number;
}

/** Numbers so far, before any visitor's window has closed. For showing progress; the engine never reads these. */
export interface Progress {
  visitors: number;
  converted: number;
  views: number;
  errors: number;
  /** Average largest contentful paint in ms, or null if none was reported. */
  avgLcpMs: number | null;
}

export interface Health {
  view: boolean;
  error: boolean;
  lcpMs?: number;
}

/**
 * Where visitors and results are kept. Two implementations: in memory (tests, local runs) and Postgres.
 * Both must answer every call the same way; test/store.contract.test.ts runs the same script against both.
 */
export interface Store {
  createExperiment(def: ExperimentDef, state: EngineState, audit: AuditEntry[], now: number): Promise<void>;
  getExperiment(id: string): Promise<ExperimentRow | null>;
  /** Ids of experiments that have not finished. */
  listActive(): Promise<string[]>;
  listAll(): Promise<Array<{ id: string; name: string; stage: string; killed: boolean; createdAt: number }>>;

  /**
   * Stores the visitor with this variant unless they are already stored.
   * Either way it returns what is stored, and whether this call created it.
   */
  upsertVisitor(experimentId: string, visitorId: string, variantId: string, phase: number, now: number): Promise<{ row: VisitorRow; created: boolean }>;
  getVisitor(experimentId: string, visitorId: string): Promise<VisitorRow | null>;
  /** Records the goal once, and only inside the window. Returns whether it was recorded. */
  recordGoal(experimentId: string, visitorId: string, now: number, windowMs: number): Promise<boolean>;
  /** Adds to the health numbers of the variant that was shown. */
  recordHealth(experimentId: string, variantId: string, now: number, h: Health): Promise<void>;

  /** Switches the kill switch. Returns false if it was already in that position. */
  setKilled(experimentId: string, killed: boolean, entry: AuditEntry): Promise<boolean>;

  measure(experimentId: string, spec: MeasureSpec): Promise<Measurements>;
  /** Per variant, everything counted so far. Variants nobody has seen are missing. */
  progress(experimentId: string): Promise<Record<string, Progress>>;

  /** Takes the right to run the tick for a while. Only one caller gets it. */
  claimTick(experimentId: string, token: string, now: number, leaseMs: number): Promise<boolean>;
  /** Saves the new state and audit entries, and gives the right back. False if the lease was lost. */
  saveTick(experimentId: string, token: string, state: EngineState, audit: AuditEntry[], now: number): Promise<boolean>;

  readAudit(experimentId: string, limit?: number): Promise<AuditEntry[]>;
}

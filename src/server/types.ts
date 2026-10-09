import type { Policy, Proposal } from '../safety/policy.ts';
import type { EngineState } from '../core/engine.ts';
import type { Config } from '../core/types.ts';

export const CONTROL_ID = 'original';

/** One change to the page. The same shape the safety check reads. */
export type Change = Proposal;

export interface VariantDef {
  label: string;
  changes: Change[];
}

/** The page where the variants are shown. */
export interface TargetRule {
  path: string;
  /** "exact" (default) matches the path and the path with a trailing slash. "prefix" matches everything below it. */
  match?: 'exact' | 'prefix';
}

/** What counts as a success. */
export type GoalRule = { type: 'click'; selector: string } | { type: 'pageview'; path: string };

/** Everything the owner set when the experiment was made. Never changes afterwards. */
export interface ExperimentDef {
  /** The public key the browser script sends. Not a secret. */
  id: string;
  name: string;
  /** Challenger ids in a fixed order. Stored as a list because the database does not keep key order. */
  order: string[];
  variants: Record<string, VariantDef>;
  target: TargetRule;
  goal: GoalRule;
  /** Sites allowed to call the public endpoints from a browser, like "https://aiqb.example". */
  allowedOrigins: string[];
  policy: Policy;
  config: Config;
}

export interface ExperimentRow {
  def: ExperimentDef;
  state: EngineState;
  killed: boolean;
  createdAt: number;
  tickedAt: number;
}

/** Every id in the order the engine uses: the original first. */
export const fullOrder = (def: ExperimentDef): string[] => [CONTROL_ID, ...def.order];

export const isFinished = (state: EngineState): boolean => state.stage === 'promoted' || state.stage === 'stopped';

// ------------------------------------------------------------------ what goes over the wire

/** The answer to the browser script. */
export interface DecideResponse {
  v: 1;
  /** The variant this visitor sees, or null if they have none on this page (not on the target page and never assigned). */
  variant: string | null;
  /** True when this visitor belongs to the experiment. */
  assigned: boolean;
  /** True when this page is the target page. */
  target: boolean;
  /** Changes to apply now. Empty for the original. */
  changes: Change[];
  /** When true, the script should report views, page health and goals. */
  track: boolean;
  goal: GoalRule | null;
}

export type EventType = 'view' | 'health' | 'goal';

export interface EventBody {
  /** experiment id */
  e: string;
  /** visitor id */
  v: string;
  t: EventType;
  /** page path */
  p: string;
  /** 1 if something on this page failed */
  err?: number;
  /** largest contentful paint, ms */
  lcp?: number;
}

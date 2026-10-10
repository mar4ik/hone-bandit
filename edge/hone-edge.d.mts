export interface EdgeOptions {
  /** Where Hone runs, e.g. https://hone-bandit.vercel.app */
  api: string;
  /** The experiment key, e.g. exp_aiqb_ab_1 */
  experiment: string;
  /** The page the test is about. Default: the request's own path. */
  path?: string;
  /** How long to wait for Hone before sending the page as it is. Default 400. */
  timeoutMs?: number;
  /** How long the answer cookie lives, in hours (the same as agent.js data-remember). Default 6; 0 = no answer cookie. */
  rememberHours?: number;
  /** Return true to leave this request alone (no call, no cookie). */
  skip?: (request: Request, url: URL) => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  newId?: () => string;
}

export interface EdgeAnswer {
  v: number;
  variant: string | null;
  assigned: boolean;
  target: boolean;
  changes: unknown[];
  track: boolean;
  goal: unknown;
}

export interface EdgeResult {
  /** decided · fresh · slow · error · skipped:method · skipped:privacy · skipped:bot · skipped:custom */
  outcome: string;
  id: string | null;
  /** Set-Cookie lines to add to the page response. */
  cookies: string[];
  answer: EdgeAnswer | null | Record<string, any>;
  /** How long the whole thing took, in ms. */
  ms: number;
}

export function decideAtEdge(request: Request, opts: EdgeOptions): Promise<EdgeResult>;
export function parseCookies(header: string | null | undefined): Record<string, string>;
export function cleanPath(p: string | null | undefined): string;

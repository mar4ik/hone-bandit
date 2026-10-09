-- Hone: tables for the decision service.
-- Plain Postgres, no extensions. Safe to run more than once.
-- Every statement ends with a semicolon at the end of a line, and no statement contains one inside a string,
-- because scripts/migrate.ts splits this file on those.

-- One row per experiment. "def" is what the owner set and never changes; "state" is what the engine decided.
-- Only the tick writes "state". Visitors only read it. The kill switch is its own column so pressing it never
-- has to wait for, or fight with, a tick.
CREATE TABLE IF NOT EXISTS experiments (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  def         jsonb NOT NULL,
  state       jsonb NOT NULL,
  killed      boolean NOT NULL DEFAULT false,
  finished    boolean NOT NULL DEFAULT false,
  created_at  bigint NOT NULL,
  ticked_at   bigint NOT NULL DEFAULT 0,
  lease_token text,
  lease_until bigint NOT NULL DEFAULT 0
);

-- One row per visitor per experiment: which variant they were given, and whether they reached the goal.
-- Times are milliseconds since 1970, the same numbers the engine uses.
-- There is no name, address, device or other personal detail here: visitor_id is a random string the browser made up.
CREATE TABLE IF NOT EXISTS visitors (
  experiment_id text NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  visitor_id    text NOT NULL,
  variant_id    text NOT NULL,
  phase         integer NOT NULL,
  assigned_at   bigint NOT NULL,
  converted_at  bigint,
  seq           bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (experiment_id, visitor_id)
);

CREATE INDEX IF NOT EXISTS visitors_by_phase ON visitors (experiment_id, phase, variant_id, seq);

-- Running totals of page health per variant. One small row per variant, updated in place.
CREATE TABLE IF NOT EXISTS health (
  experiment_id text NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  variant_id    text NOT NULL,
  views         bigint NOT NULL DEFAULT 0,
  errors        bigint NOT NULL DEFAULT 0,
  lcp_n         bigint NOT NULL DEFAULT 0,
  lcp_sum       double precision NOT NULL DEFAULT 0,
  lcp_sumsq     double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (experiment_id, variant_id)
);

-- Page views per day (days since 1970), to notice when tracking breaks.
CREATE TABLE IF NOT EXISTS day_views (
  experiment_id text NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  day           integer NOT NULL,
  views         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (experiment_id, day)
);

-- Everything the engine or a person did, with the reason.
CREATE TABLE IF NOT EXISTS audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiments (id) ON DELETE CASCADE,
  at            bigint NOT NULL,
  actor         text NOT NULL,
  action        text NOT NULL,
  variant_id    text,
  reason        text NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_by_experiment ON audit (experiment_id, id);

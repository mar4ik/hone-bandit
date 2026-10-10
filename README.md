# Hone (working name; internal codename: bandit)

An agent that tests and improves any website. It learns from live traffic with a multi-armed bandit (Thompson sampling), shifts visitors toward what works, and confirms every win with a fixed A/B test before keeping it.

- Architecture spec: https://claude.ai/code/artifact/72f2d8d1-9cdd-4027-b1b7-b263a5c32076
- UI mocks (design canvas): https://claude.ai/artifact/UFYHct52KsCfvxuhmCTFkB
- First site it will run on: AIQB (separate project, not in this repo)
- The name "Hone" is a working name. Domain and trademark are not checked yet.

## Status

Stage 1 (core loop, safety layer, simulator) and the web layer are written. The web layer has not run on Vercel yet: see "What is not verified" below.

```
src/core/engine.ts       the decisions: stages, weights, guardrails, kill switch. Plain data in, plain data out
src/core/experiment.ts   the engine plus an in-memory visitor log, for the simulator and tests
src/core/thompson.ts     Thompson sampling, the 1% floor, picking a variant from weights
src/core/stats.ts        two-proportion test, sample size, sample-ratio check
src/safety/policy.ts     the checks every variant passes before it gets traffic
src/sim/                 simulated visitors, with delayed conversions and planted bad variants
src/server/              the decision service (framework-free: Request in, Response out)
src/server/pg-store.ts   Postgres storage; memory-store.ts is the same thing in memory for tests
src/app/api/             thin Next.js route files that call src/server
public/agent.js          the browser script (the one-line tag)
db/001_init.sql          the tables
demo/                    the AIQB hero page with the script injected, served locally
test/                    95 tests
design/                  the UI mocks (source files and previews)
```

Needs Node 22.18 or newer. The engine, the server code and the tests have no dependencies; Node runs the TypeScript directly. Only the Next.js app needs `npm install`.

```
npm test                  86 tests, about 40 seconds. 9 need Postgres or Chromium and skip without them
npm run sim               five scenarios, printed in plain text
npm run demo              the AIQB hero page with the script, on localhost:4000 (in memory, gone when stopped)
```

All 95 tests, with a real Postgres and a real Chromium:

```
scripts/pg-test-server.sh start        # prints the export line for HONE_TEST_DATABASE
export HONE_TEST_CHROME=/path/to/chrome
npm test
```

## How it works on a site

1. The owner creates an experiment with `POST /api/admin/experiments`: the page, the goal, the variants, the policy. Every change in every variant goes through the safety checks before any visitor can see it. See `demo/aiqb-hero.experiment.json` for a full example.
2. The site adds one tag in its `<head>`: `<script src="https://YOUR-APP.vercel.app/agent.js" data-experiment="exp_..."></script>`. Optional: `data-hide="selector,selector"` hides those parts until the answer arrives, so visitors do not see the original flash into a variant, and `data-timeout="2000"` sets how long that wait may last at most (default 700 ms). `data-remember="6"` is how many hours the last answer is kept (default 6; `0` turns it off).
3. For each visitor the script asks `GET /api/decide`, applies the changes, and reports `view`, `health` and `goal` events to `POST /api/event`. If anything fails it shows the original. A visitor who was here before does not wait: the answer the server gave last time is kept in the site's own storage (`hone_ans_<experiment>`, next to the visitor id) and shown at once, while the server is asked again. The server's answer always wins: if it differs (the test ended, the kill switch was pressed) the page switches to it and takes back what the old one had changed. A click on the goal before the server has answered is still reported. A new visitor still waits, up to the time limit.
4. Only the tick changes what the engine has decided. It runs from Vercel Cron and, on a busy site, also from a visitor request when the last tick is more than 5 minutes old. It measures from the stored rows, so a tick that dies half way loses nothing.
5. `POST /api/admin/experiments/:id/kill` sends everyone back to the original at once. It does not wait for the tick.

## Putting it on Vercel

1. Import the repo in Vercel. Framework preset: Next.js.
2. Add Neon from the Vercel Marketplace (Storage tab). It sets `DATABASE_URL`. Pick the region closest to the functions, and to your visitors.
3. Set `ADMIN_TOKEN` (`openssl rand -hex 32`) and `CRON_SECRET` (the same way). See `.env.example`.
4. Create the tables: `vercel env pull .env.local && npm run db:migrate`. Or `psql "$DATABASE_URL" -f db/001_init.sql`. Safe to run again.
5. Create the experiment, then add the tag to the site:

```
curl -X POST https://YOUR-APP.vercel.app/api/admin/experiments \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d @my-experiment.json          # must include "allowedOrigins": ["https://your-site.example"]
```

`vercel.json` runs the tick once a day at 04:00 UTC, the most the free Hobby plan allows. A site with traffic ticks itself every 5 minutes anyway (`HONE_TICK_EVERY_MS`). On a Pro plan change the schedule to `*/5 * * * *`. Vercel's Hobby plan is for personal, non-commercial use; check their current terms before running a client's site on it.

## What is not verified

Everything in `src/server`, `public/agent.js` and the engine has run: in Node, against a real Postgres 16, and in real Chromium (including the real AIQB hero page showing all four versions with events recorded). The Next.js route files were run too, but against **stand-ins** for `next/server` and `@neondatabase/serverless`, because the npm registry is blocked in the build environment. The stand-ins are written from my reading of how those two packages work. So these have **not** been run for real:

- `next dev` and `next build` (route file conventions, the `.ts` import paths under Next's bundler, `after()` running after the response)
- the Neon adapter (`src/server/neon.ts`): that `neon(url).query(text, params)` returns an array of rows, that `bigint` columns come back as strings (the store converts with `Number()`), that parameters passed as JSON text work with `::jsonb`
- Vercel Cron actually calling `/api/cron/tick` with the secret, and function limits (cold start, duration)
- type checking with the pinned versions. The code type-checks clean with TypeScript 6.0.3 and `@types/node` 26 (the versions in this container) with stand-in type declarations for `next`, `react` and the Neon driver. `package.json` asks for TypeScript 5.8 and `@types/node` 22, and Next's own generated route types were not checked.

First run on your machine, in this order: `npm install`, `npm run typecheck`, `npm test`, `npm run build`, then `npm run dev` with a local Postgres or a Neon branch and the curl above. If something fails, it is most likely in the list above.

## Known limits

- **Cold start.** Neon's free compute sleeps after a few minutes idle and can take around a second to wake. The first visitor then waits past the 700 ms limit and sees the original. Nothing breaks; that visitor is just not in the test.
- **Added delay.** `data-hide` can add up to 700 ms to the paint of the hidden parts. Without it, visitors may see the original flash first.
- **Two database round trips per `decide`.** Fine at AIQB scale. A short in-memory cache of the experiment row would halve it.
- **Hot counters.** Health numbers are one row per variant per experiment, so at very high event rates the updates queue behind each other. Sharding the counter would fix it. Not needed below a few hundred events a second.
- **Each tick reads every visitor row** (`O(visitors)`). Fine to a few million. Then settle incrementally.
- **No rate limiting** on the public endpoints. Add Vercel's firewall rules before a public launch.
- **The visitor id is a tracking identifier** stored in the visitor's browser. Decide whether a consent banner is needed for the markets you serve. The script already honours Global Privacy Control and Do Not Track.
- **Fact and honesty checks only read English.** Armenian copy is not checked for invented numbers or claims yet.
- **Slots should be text-only elements.** The script replaces their children; `\n` becomes a line break.

## What the simulator shows

Simulated site: 2,000 visitors a day, 6% baseline conversion, a 7-day goal window. Each result is over many runs with different random seeds.

| Scenario | Result |
| --- | --- |
| One variant truly +30%, one neutral, one worse (60 runs) | The +30% variant shipped in 58 of 60. The other two never shipped. Measured lift in the fixed test averaged near the true 30%. Visitors converted 20% more than if everyone had seen the original, and 16% more than with an even split all along. |
| Nothing is better (100 runs) | The original was replaced once in 100 runs. |
| A good variant plus a buggy one (2.5% errors against 1%) and a slow one (+500 ms) that would convert better (40 runs) | Neither bad variant ever shipped. The slow one was stopped in the canary every time. The buggy one was stopped in the canary in 27 of 40 runs and rolled back later in the other 13. The good variant shipped in 39 of 40. |
| 80% of conversions arrive days after the visit (40 runs) | The bandit is skipped and a fixed A/B runs instead. The +30% variant shipped in 32 of 40. |

A full test takes about 45 simulated days from first canary to a decision.

## Where this differs from the spec

1. **Visitors count only when their window closes.** The spec counted early conversions straight away and treated open windows as pending. That inflates any variant that recently got more traffic, because its early wins are counted and its late losses are not. Now a visit counts, as a win or a loss, only after its 7 days are up. Learning runs about a week behind.
2. **The bandit stage runs at least 7 days.** One lucky day can no longer end it.
3. **The canary needs about 300 visitors per variant, not about 100.** The guardrails need at least 200 page views to judge a variant, so 100 could never catch a buggy one.

## Open problems found while building

- **1% canary is too small for a small site.** At 1% of traffic, 300 visitors per variant takes about 30,000 visitors in total. At 2,000 visitors a day that is 15 days. At AIQB-scale traffic it would never finish. `canaryShare` is a setting, and small sites need 5 to 10%.
- **A third of buggy variants reach real traffic before they are caught** (13 of 40 above), because the canary cannot see a 2.5x error rate with only a few hundred views. They are caught within days, but a higher canary share would catch more of them earlier.
- **Not checked yet:** the screenshot check at every width, and Armenian copy quality.

## Next

1. Run the web layer on Vercel and fix what the "not verified" list turns up.
2. Variant writer with the Claude API, inside the policy, plus a scan step that reads each element's real colors and size.
3. Connect the UI mocks to real data.

# Hone (working name; internal codename: bandit)

An agent that tests and improves any website. It learns from live traffic with a multi-armed bandit (Thompson sampling), shifts visitors toward what works, and confirms every win with a fixed A/B test before keeping it.

- Architecture spec: https://claude.ai/code/artifact/72f2d8d1-9cdd-4027-b1b7-b263a5c32076
- UI mocks (design canvas): https://claude.ai/artifact/UFYHct52KsCfvxuhmCTFkB
- First site it will run on: AIQB (separate project, not in this repo)
- The name "Hone" is a working name. Domain and trademark are not checked yet.

## Status

Stage 1 is done: the core loop, the safety layer and a visitor simulator, all tested. There is no web layer, database, browser SDK or variant writer yet.

```
src/core/experiment.ts   one experiment on one place on a page: stages, weights, guardrails, kill switch
src/core/thompson.ts     Thompson sampling, the 1% floor, picking a variant from weights
src/core/stats.ts        two-proportion test, sample size, sample-ratio check
src/safety/policy.ts     the checks every variant passes before it gets traffic
src/sim/                 simulated visitors, with delayed conversions and planted bad variants
test/                    43 tests
design/                  the UI mocks (source files and previews)
```

Needs Node 22.18 or newer. It has no dependencies; Node runs the TypeScript directly.

```
npm test        # 43 tests, about 25 seconds
npm run sim     # five scenarios, printed in plain text
```

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
- **Not checked yet:** type checking (`npm run typecheck` needs `npm install` first), the screenshot check at every width, and Armenian copy quality.

## Next

1. Web layer on Vercel: Next.js route handlers for the decision service, Postgres, Vercel Cron for the engine tick.
2. Browser script (the one-line tag) with sticky assignment in a first-party cookie.
3. Variant writer with the Claude API, inside the policy.
4. Connect the UI mocks to real data.

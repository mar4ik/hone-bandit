import { CONTROL, defaultWorld, runSim } from './sim.ts';
import type { SimResult, World } from './sim.ts';
import { DAY } from '../core/types.ts';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function describe(r: SimResult): string {
  const e = r.exp;
  const o = e.outcome;
  const stages = e.audit.filter((a) => a.action.startsWith('stage_')).map((a) => `${a.action.slice(6)}@d${Math.round(a.at / DAY)}`);
  const lines = [
    `  path: ${['canary@d0', ...stages].join(' > ')}`,
    `  outcome: ${o ? `${o.kind} (${o.reason})${o.winnerId ? ` winner ${o.winnerId}` : ''}${o.relLift != null ? `, measured lift ${pct(o.relLift)}` : ''}` : 'still running'}`,
    `  variants: ${e.snapshot().variants.map((v) => `${v.id}=${v.status}`).join(', ')}`,
    `  vs showing everyone the original: ${pct(r.expectedConversions / r.controlConversions - 1)} conversions`,
    `  vs an even split all along:       ${pct(r.expectedConversions / r.uniformConversions - 1)} conversions`,
    `  share of the best possible:       ${pct(r.expectedConversions / r.oracleConversions)}`,
  ];
  return lines.join('\n');
}

function scenario(title: string, world: World, seed: number, days: number, cfg = {}, extra: Record<string, unknown> = {}): void {
  const r = runSim(world, { seed, days, cfg, ...extra });
  console.log(`\n${title}\n${describe(r)}`);
}

const base = defaultWorld();
scenario('1. One real winner (v1 +30%), one neutral, one worse', base, 1, 100);
scenario('2. Nothing is better (all equal)', defaultWorld({ variants: { v1: { lift: 0 }, v2: { lift: 0 }, v3: { lift: 0 } } }), 2, 100);
scenario('3. Slow goal: 80% of conversions arrive days later', defaultWorld({ lateShare: 0.8 }), 3, 120);
scenario(
  '4. A good variant, a buggy one (2.4x errors) and a slow one (+400 ms)',
  defaultWorld({ variants: { good: { lift: 0.3 }, buggy: { lift: 0.5, errorRate: 0.024 }, slow: { lift: 0.5, lcpMs: 2200 } } }),
  4,
  100,
);
scenario('5. Kill switch pressed on day 30', base, 5, 60, {}, { killAtDay: 30 });
console.log(`\n(original id: ${CONTROL})`);

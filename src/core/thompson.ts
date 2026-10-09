import { sampleBeta } from './beta.ts';
import type { Rng } from './rng.ts';

/** One variant's belief about its own conversion rate: Beta(alpha, beta). A fresh variant is Beta(1, 1). */
export interface Arm {
  id: string;
  alpha: number;
  beta: number;
}

export type Weights = Record<string, number>;

/** Chance that each arm has the highest true rate, estimated by drawing from every posterior. */
export function probBest(arms: Arm[], rng: Rng, draws = 4000): Weights {
  const wins = new Array<number>(arms.length).fill(0);
  for (let d = 0; d < draws; d++) {
    let best = -1;
    let bestIdx = 0;
    for (let i = 0; i < arms.length; i++) {
      const x = sampleBeta(arms[i].alpha, arms[i].beta, rng);
      if (x > best) {
        best = x;
        bestIdx = i;
      }
    }
    wins[bestIdx]++;
  }
  const out: Weights = {};
  arms.forEach((a, i) => (out[a.id] = wins[i] / draws));
  return out;
}

/** Chance that `arm` has a lower true rate than `control`. */
export function probWorse(control: Arm, arm: Arm, rng: Rng, draws = 4000): number {
  let worse = 0;
  for (let d = 0; d < draws; d++) {
    if (sampleBeta(arm.alpha, arm.beta, rng) < sampleBeta(control.alpha, control.beta, rng)) worse++;
  }
  return worse / draws;
}

/**
 * Mixes the weights with an even split so every arm gets at least `floor`.
 * Result still sums to 1. The floor is capped so it can never ask for more than 100% in total.
 */
export function applyFloor(weights: Weights, floor: number): Weights {
  const ids = Object.keys(weights);
  const k = ids.length;
  if (k === 0) return {};
  const f = Math.min(floor, 1 / k);
  const total = ids.reduce((a, id) => a + weights[id], 0) || 1;
  const out: Weights = {};
  for (const id of ids) out[id] = (1 - k * f) * (weights[id] / total) + f;
  return out;
}

/** Thompson sampling: each arm's share of traffic is its chance of being best, with a floor. */
export function thompsonWeights(arms: Arm[], rng: Rng, floor: number, draws = 4000): Weights {
  return applyFloor(probBest(arms, rng, draws), floor);
}

export function equalWeights(ids: string[]): Weights {
  const out: Weights = {};
  for (const id of ids) out[id] = 1 / ids.length;
  return out;
}

/** Turns a number in [0, 1) into one of the ids, in proportion to the weights. */
export function pickByWeight(u: number, order: string[], weights: Weights): string {
  let cum = 0;
  let last = order[0];
  for (const id of order) {
    const w = weights[id] ?? 0;
    if (w <= 0) continue;
    cum += w;
    last = id;
    if (u < cum) return id;
  }
  return last;
}

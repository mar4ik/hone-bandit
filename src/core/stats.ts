/** Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26). */
export function normCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  const y = 1 - poly * Math.exp((-x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse of the standard normal CDF (Acklam's algorithm). */
export function normInv(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError('p must be between 0 and 1');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface ProportionTest {
  p1: number;
  p2: number;
  z: number;
  /** Two-sided p-value. */
  p: number;
  /** Relative lift of group 2 over group 1 (0.1 = +10%), with a 95% interval. */
  relLift: number | null;
  ci: [number, number] | null;
}

/** Two-proportion z-test. Group 1 is the original, group 2 the challenger. */
export function twoProportionTest(s1: number, n1: number, s2: number, n2: number): ProportionTest {
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const pool = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  let relLift: number | null = null;
  let ci: [number, number] | null = null;
  if (s1 > 0 && s2 > 0) {
    relLift = p2 / p1 - 1;
    const logRatio = Math.log(p2 / p1);
    const seLog = Math.sqrt(1 / s1 - 1 / n1 + 1 / s2 - 1 / n2);
    ci = [Math.exp(logRatio - 1.959964 * seLog) - 1, Math.exp(logRatio + 1.959964 * seLog) - 1];
  }
  return { p1, p2, z, p, relLift, ci };
}

/** Visitors needed in each group to detect a relative lift at the given significance and power. */
export function plannedPerArm(baseline: number, relMde: number, alpha = 0.05, power = 0.8): number {
  const p0 = baseline;
  const p1 = baseline * (1 + relMde);
  const pbar = (p0 + p1) / 2;
  const za = normInv(1 - alpha / 2);
  const zb = normInv(power);
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1));
  return Math.ceil((num * num) / ((p1 - p0) * (p1 - p0)));
}

const CHI2_001 = [10.828, 13.816, 16.266, 18.467, 20.515, 22.458, 24.322, 26.124, 27.877, 29.588];

/** Critical chi-square value for p = 0.001. */
export function chi2Critical001(df: number): number {
  if (df >= 1 && df <= 10) return CHI2_001[df - 1];
  const z = 3.0902;
  const t = 2 / (9 * df);
  return df * Math.pow(1 - t + z * Math.sqrt(t), 3);
}

/**
 * Sample ratio mismatch: true if the number of visitors per variant is too far from the intended split
 * to be chance (p < 0.001). Usually means a tracking or assignment bug.
 */
export function srmFlagged(observed: number[], expected: number[]): boolean {
  let chi2 = 0;
  for (let i = 0; i < observed.length; i++) {
    const d = observed[i] - expected[i];
    chi2 += (d * d) / expected[i];
  }
  return chi2 > chi2Critical001(observed.length - 1);
}

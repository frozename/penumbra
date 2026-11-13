import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureSchema } from '../../../../scripts/system-one-judge-bench.ts';
import { binaryMetrics, percentile } from '../../../../scripts/system-one-judge-metrics.ts';

const root = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2];
if (!path) throw new Error('Pass frozen private fixture JSONL; analysis performs no inference');
const fixtures = readFileSync(path, 'utf8').trim().split('\n').map(line => fixtureSchema.parse(JSON.parse(line)));
const runs = Object.fromEntries(['granite', 'nano', 'edge', 'd1q4', 'granite-constrained'].map(name => {
  const run = JSON.parse(readFileSync(join(root, name + '-reviewed/run.json'), 'utf8'));
  if (run.fixtureSha256 !== createHash('sha256').update(JSON.stringify(fixtures)).digest('hex')) throw new Error('fixture mismatch');
  return [name, new Map(run.rows.filter(row => row.iteration === 0).map(row => [row.caseId, row]))];
}));
const selected = fixtures.filter(f => f.split === 'test' && typeof f.labels.promote === 'boolean');
const samples = (name, rows) => rows.map(f => {
  const row = runs[name].get(f.id);
  return { expected: f.labels.promote, probability: row.error ? null : row.answers.promote?.noul ?? null,
    ...(row.incumbentDecision === undefined ? {} : {decision: row.incumbentDecision}) };
});
const metrics = rows => Object.fromEntries(Object.keys(runs).map(name => [name, binaryMetrics(samples(name, rows))]));
const slices = { all: selected,
  historical: selected.filter(f => f.source.kind === 'historical'),
  sourceGroundedSynthetic: selected.filter(f => f.source.kind === 'synthetic'),
};
const families = [...new Map(selected.map(f => [f.family, selected.filter(x => x.family === f.family)])).values()];
let seed = 0x17d39abc;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const differences = {f1: [], falsePromotionRate: [], falseVetoRate: []};
for (let i = 0; i < 10000; i++) {
  const sample = Array.from({length: families.length}, () => families[Math.floor(random() * families.length)]).flat();
  const base = binaryMetrics(samples('granite', sample));
  const next = binaryMetrics(samples('nano', sample));
  for (const key of Object.keys(differences)) if (base[key] !== null && next[key] !== null) differences[key].push(next[key] - base[key]);
}
const cascade = binaryMetrics(selected.map(f => {
  const n = runs.nano.get(f.id), g = runs.granite.get(f.id);
  const direct = !n.error && n.answers.promote?.noul >= .5;
  const decision = direct ? true : g.error ? null : g.incumbentDecision;
  return {expected: f.labels.promote, probability: decision === null ? null : Number(decision), decision: decision ?? undefined};
}));
cascade.brier = null; cascade.calibrationError = null;
const report = {
  fixtureSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'),
  labelStatus: 'independently-ai-reviewed; common model family, not human adjudication',
  slices: Object.fromEntries(Object.entries(slices).map(([name, rows]) => [name, {cases: rows.length, metrics: metrics(rows)}])),
  pairedFamilyBootstrap: {seed: 'xorshift32:0x17d39abc', repetitions: 10000, families: families.length,
    method: 'Paired resampling of declared source families, percentile95% interval of Nano minus Granite. Wrapper correlations may cross declared historical session families; intervals can be optimistic.',
    intervals: Object.fromEntries(Object.entries(differences).map(([key, values]) => [key, [percentile(values,.025),percentile(values,.975)]]))},
  acceptFirstDevelopmentSimulation: {rule: 'Nano p>=.5 accepts; otherwise unchanged Granite verdict. No negative native veto.', metrics: cascade,
    warning: 'Recipe designed on this development cohort. Not confirmatory, production authority or measured cascade latency. Composite calibration is undefined; per-leg estimates must stay separate.'},
  calibrationCaveat: 'Granite probability is a self-reported chosen-answer confidence proxy, not native probability. Brier/ECE are diagnostics of that proxy; do not infer equivalent probability semantics.',
};
writeFileSync(join(root,'reviewed-quality-analysis.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({slices:Object.fromEntries(Object.entries(slices).map(([key,rows])=>[key,rows.length])),intervals:report.pairedFamilyBootstrap.intervals,cascade:cascade}));

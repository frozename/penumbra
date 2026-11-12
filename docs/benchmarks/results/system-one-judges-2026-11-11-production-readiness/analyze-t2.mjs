import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureSchema } from '../../../../scripts/system-one-judge-bench.ts';
import { binaryMetrics } from '../../../../scripts/system-one-judge-metrics.ts';

const root = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error('Pass private frozen T2 fixture JSONL; no inference');
const fixtures = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line => fixtureSchema.parse(JSON.parse(line)));
const sha = createHash('sha256').update(JSON.stringify(fixtures)).digest('hex');
const runs = Object.fromEntries(['granite', 'nano', 'd1q4'].map(name => {
  const run = JSON.parse(readFileSync(join(root,'t2-' + name + '/run.json'),'utf8'));
  if (sha !== run.fixtureSha256) throw new Error('fixture mismatch');
  return [name,new Map(run.rows.filter(row=>row.iteration===0).map(row=>[row.caseId,row]))];
}));
const known = fixtures.filter(f=>typeof f.labels.promote==='boolean');
const samples = (name, rows) => rows.map(f=>{
  const row=runs[name].get(f.id);
  return {expected:f.labels.promote, probability:row.error?null:row.answers.promote?.noul??null,
    ...(row.incumbentDecision===undefined?{}:{decision:row.incumbentDecision})};
});
const hardMetrics = (rows, predict) => {
  const result=binaryMetrics(rows.map(f=>{const decision=predict(f);return {expected:f.labels.promote,probability:decision===null?null:Number(decision),decision:decision??undefined}}));
  result.brier=null;result.calibrationError=null;
  return result;
};
const acceptFirst = f => {
  const n=runs.nano.get(f.id),g=runs.granite.get(f.id);
  if (!n.error&&n.answers.promote?.noul>=.5)return true;
  return g.error?null:g.incumbentDecision??null;
};
const metrics = rows => ({
  ...Object.fromEntries(Object.keys(runs).map(name=>[name,binaryMetrics(samples(name,rows))])),
  nanoAcceptFirst:hardMetrics(rows,acceptFirst),
  alwaysAccept:hardMetrics(rows,()=>true),alwaysReject:hardMetrics(rows,()=>false),
});
const slices={all:known,withoutEmbeddedHistoricalEvaluationClaims:known.filter(f=>!f.tags.includes('embedded-historical-evaluation-claims')),
  embeddedHistoricalEvaluationClaims:known.filter(f=>f.tags.includes('embedded-historical-evaluation-claims')),
  ...Object.fromEntries(['verified','contradicted','insufficient'].map(status=>['factualSupport_'+status,known.filter(f=>f.reviewProvenance.factualSupport===status)])),
};
const report={fixtureSha256:sha,selectedInputs:fixtures.length,labeled:known.length,uncertainExcluded:fixtures.length-known.length,
  labelStatus:'Independent blind AI source checks plus distinct AI adjudication; common base model family, not human labels',
  domain:'Complete historical T2 bodies under promotion durability rubric, not current truncated P1 inputs',
  recipes:'Nano direct .5 and Nano accept-first .5 locked before candidate inference; d1 Q4 default .5 additional comparison, no tuning on this cohort',
  slices:Object.fromEntries(Object.entries(slices).map(([name,rows])=>[name,{cases:rows.length,metrics:metrics(rows)}])),
  negativeSampleSize:known.filter(f=>!f.labels.promote).length,
  negativeConfidenceWarning:'Even0/14 false promotions has a one-sided95% binomial upper bound19.3%, before family/label error. Cannot certify a2% rate.',
  cascade:'Offline replay of locked recipe, not executed co-resident cascade. Brier/ECE intentionally undefined; original native probability and Granite confidence remain separate. The recipe can only retain or add incumbent false promotions.',
  downstream:'Source review is an offline utility signal, not observed downstream improvement over time. Durability does not certify factual truth.',
};
writeFileSync(join(root,'t2-confirmatory-analysis.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({selected:report.selectedInputs,labeled:known.length,metrics:report.slices.all.metrics}));

import {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {CONTROL_PLANE_INDEX_SQL} from '../../../../packages/core/src/db/control-plane-indexes.ts';
process.umask(0o077);
const args=process.argv.slice(2),apply=args[0]==='--apply',inspect=args[0]==='--inspect';
const output=args[args.indexOf('--out')+1];
if((!apply&&!inspect)||!args.includes('--out')||existsSync(output))throw new Error('Explicit inspect/apply and fresh report required');
const sql=apply?CONTROL_PLANE_INDEX_SQL[Number(args[1])]:undefined;
if(apply&&!sql)throw new Error('Unknown approved index');
Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
const replica=args.includes('--replica')?args[args.indexOf('--replica')+1]:undefined;
if(replica&&(!replica.startsWith('/Volumes/AI-DATA/maestro/bench/system-one-judges-20261113-rewriter-validation/')||!replica.endsWith('.sqlite')))throw new Error('Invalid private metadata replica');
if(!replica&&!args.includes('--live'))throw new Error('Explicit --live required');
const db=new Database(replica??'/Users/aimastermind/.penumbra/db.sqlite',{readonly:!apply,readwrite:apply,create:false});
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const metadata=()=>db.query("SELECT value FROM db_meta WHERE key='schema_version'").get();
const originalMeta=metadata();
const initialChanges=db.query('SELECT total_changes() AS n').get() as {n:number};
db.run('PRAGMA busy_timeout=100');
const names=CONTROL_PLANE_INDEX_SQL.map(s=>s.match(/EXISTS (\w+)/)![1]);
const definitions=()=>db.query('SELECT name,sql FROM sqlite_master WHERE type=\'index\' AND name IN('+names.map(()=>'?').join(',')+')').all(...names);
const normalize=(s:string)=>s.replace('IF NOT EXISTS ','').replace(/\s+/g,'').toLowerCase();
for(const row of definitions() as {name:string,sql:string}[]){
 if(normalize(row.sql)!==normalize(CONTROL_PLANE_INDEX_SQL[names.indexOf(row.name)]))throw new Error('Existing index definition mismatch: '+row.name);
}
const report:any={at:new Date().toISOString(),mode:apply?'apply-one-index':'read-only-inspection',sqlite:db.query('SELECT sqlite_version() AS version').get(),originalMeta,sourceSha256:sha(readFileSync(new URL('../../../../packages/core/src/db/control-plane-indexes.ts',import.meta.url),'utf8')),before:definitions()};
if(apply){
 const at=performance.now();db.run('BEGIN IMMEDIATE');
 try{db.run(sql!);db.run('COMMIT');}catch(error){db.run('ROLLBACK');throw error;}
 report.index=names[Number(args[1])];report.ddlMs=performance.now()-at;
}else{
 const base='/Volumes/AI-DATA/maestro/bench/system-one-judges-20261111/production-readiness/deployment/4fe01decbb52/source';
 const core=readFileSync(base+'/packages/core/src/writers/t2.ts','utf8');
 const cycle=readFileSync(base+'/packages/daemon/src/dreaming/cycle.ts','utf8');
 const start=core.indexOf('`SELECT rollup_id FROM t1_rollups'),end=core.indexOf('`',start+1);
 const eligible=core.slice(start+1,end);
 const a=cycle.indexOf('`UPDATE t1_rollups SET claimed_at = ?, claimed_by_cycle = ?'),b=cycle.indexOf('`',a+1);
 let claim=cycle.slice(a+1,b);claim=claim.slice(claim.indexOf('SELECT rollup_id, project_id'),claim.indexOf('\n            )'));
 const patterns=JSON.parse(cycle.match(/export const EPHEMERA_PROMPT_LIKE_PATTERNS = (\[[\s\S]*?\]) as const/)![1].replace(/,\s*\]/g,']'));
 const users=JSON.parse(cycle.match(/export const KNOWN_LONG_LIVED_DISPATCHER_USER_IDS = (\[[^;]*\]);/)![1]);
 claim=claim.replace('${EPHEMERA_PROMPT_NOT_LIKE_CLAUSE}',patterns.map(()=>'first_prompt_excerpt NOT LIKE ?').join(' AND ')).replace('${longLivedFilter}',users.length?`AND (user_id IS NULL OR user_id NOT IN (${users.map(()=>'?').join(',')}))`:'');
 const now=Date.now(),cutoff=new Date(now-24*3600000).toISOString();
 report.queries=[];
 for(const [name,text,params]of[
  ['eligibility',eligible,[cutoff,cutoff,5,5]],
  ['claim-candidates-select-only',claim,[now,...patterns,...users,2]],
  ['queued-p4-count',"SELECT COUNT(*)AS n FROM dream_actions WHERE phase='P4'AND status='queued'",[]],
  ['activity-max',"SELECT MAX(ts)AS ts FROM dispatch_events WHERE kind IN('dispatch.end','long_lived.tick.end')",[]],
 ] as const){
  const q=db.prepare(text);const planner=db.prepare('EXPLAIN QUERY PLAN '+text);const plan=planner.all(...params);planner.finalize();
  const times:number[]=[];let rows:any[]=[];
  for(let i=0;i<3;i++){const t=performance.now();rows=q.all(...params);times.push(performance.now()-t);}q.finalize();
  report.queries.push({name,sqlSha256:sha(text),plan,ms:times,rowCount:rows.length,resultSha256:sha(JSON.stringify(rows))});
 }
}
report.after=definitions();
report.indexFootprints=names.map(name=>({name,...(db.query('SELECT COUNT(*) AS pages,COALESCE(SUM(pgsize),0) AS bytes FROM dbstat WHERE name=?').get(name)as object)}));
report.metadataUnchanged=JSON.stringify(metadata())===JSON.stringify(originalMeta);
const finalChanges=db.query('SELECT total_changes()AS n').get() as {n:number};report.rowChanges=finalChanges.n-initialChanges.n;
if(!report.metadataUnchanged||report.rowChanges!==0)throw new Error('Unexpected data/metadata change');
db.close();writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({mode:report.mode,index:report.index,ddlMs:report.ddlMs,metadataUnchanged:report.metadataUnchanged,rowChanges:report.rowChanges}));

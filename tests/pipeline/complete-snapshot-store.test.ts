import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1CompleteStore,type Job} from '../../workers/pipeline/src/financial-data/store.ts';
import {claimJob} from '../../workers/pipeline/src/financial-data/queue.ts';
import {readCompletePublication} from '../../workers/pipeline/src/financial-data/publication.ts';
import {completeOrclFixture} from '../fixtures/complete-orcl-flow.ts';
function database(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../../workers/pipeline/migrations/0013_complete_financial_snapshots.sql',import.meta.url),'utf8'));
 function prepare(sql:string){let args:unknown[]=[];return {bind(...values:unknown[]){args=values;return this;},async run(){const result=sqlite.prepare(sql).run(...args as never[]);return {meta:{changes:Number(result.changes)}};},async first(){return sqlite.prepare(sql).get(...args as never[])??null;},async all(){return {results:sqlite.prepare(sql).all(...args as never[])};}};}
 const db={prepare,async batch(statements:ReturnType<typeof prepare>[]){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}} as unknown as D1Database;
 const create=(generation:number):Job=>{const id=`test:${generation}`,lease=`lease:${generation}`,now=new Date().toISOString();sqlite.prepare("INSERT INTO financial_collection_jobs(job_id,cik,ticker,generation,status,lease_token,lease_until,next_attempt_at,updated_at) VALUES(?,?,?,?,'running',?,?,?,?)").run(id,'0001341439','ORCL',generation,lease,new Date(Date.now()+120000).toISOString(),now,now);return {id,cik:'0001341439',ticker:'ORCL',generation,lease,cursor:'{}',attempt:1};};
 return {sqlite,db,create};
}
test('real SQLite: staged single quarters remain invisible and complete publication is atomic',async()=>{
 const {sqlite,db,create}=database();try{const job=create(1),store=new D1CompleteStore(db);await store.stage(job,completeOrclFixture.quarters[0]);assert.equal((await readCompletePublication(db,job.cik)).flow,null);await assert.rejects(store.publish(job,{...completeOrclFixture,quarters:[completeOrclFixture.quarters[0]]}));assert.equal(await store.publish(job,completeOrclFixture),true);assert.equal((await readCompletePublication(db,job.cik)).status,'ready');assert.equal(sqlite.prepare('SELECT count(*) n FROM financial_complete_versions').get()!.n,1);}finally{sqlite.close();}
});
test('real SQLite: stale generations and expired leases cannot overwrite a complete snapshot',async()=>{
 const {sqlite,db,create}=database();try{const store=new D1CompleteStore(db),old=create(1),current=create(2);assert.equal(await store.publish(current,completeOrclFixture),true);assert.equal(await store.publish(old,completeOrclFixture),false);assert.equal(sqlite.prepare('SELECT generation FROM financial_complete_current').get()!.generation,2);const expired=create(3);sqlite.prepare('UPDATE financial_collection_jobs SET lease_until=? WHERE job_id=?').run('2000-01-01T00:00:00Z',expired.id);await store.stage(expired,completeOrclFixture.quarters[0]);assert.equal((await store.staged(expired)).length,0);assert.equal(await store.publish(expired,completeOrclFixture),false);assert.equal(sqlite.prepare('SELECT generation FROM financial_complete_current').get()!.generation,2);}finally{sqlite.close();}
});
test('real SQLite: more than three normal batches continue and failed refresh keeps the old version',async()=>{
 const {sqlite,db,create}=database();try{const store=new D1CompleteStore(db),old=create(1);await store.publish(old,completeOrclFixture);let job=create(2);for(let index=0;index<6;index++){await store.defer(job,['PREPARING'],JSON.stringify({index}));job=(await claimJob(db))!;assert.ok(job);assert.equal(job.attempt,1);}await store.defer({...job,attempt:3},['SOURCE_TEMPORARILY_UNAVAILABLE'],job.cursor);const publication=await readCompletePublication(db,job.cik);assert.equal(publication.status,'ready');assert.equal(publication.outdated,true);assert.equal(publication.flow!.ticker,'ORCL');assert.equal(sqlite.prepare('SELECT generation FROM financial_complete_current').get()!.generation,1);}finally{sqlite.close();}
});

test('crashed exhausted jobs terminate instead of remaining permanently running',async()=>{
 const {sqlite,db,create}=database();try{const job=create(1);sqlite.prepare("UPDATE financial_collection_jobs SET attempt=3,lease_until='2000-01-01T00:00:00Z' WHERE job_id=?").run(job.id);assert.equal(await claimJob(db),null);assert.equal(sqlite.prepare('SELECT status FROM financial_collection_jobs').get()!.status,'unavailable');}finally{sqlite.close();}
});

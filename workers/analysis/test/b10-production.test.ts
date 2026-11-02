import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import type {PublicBusinessFlow} from '../../../shared/analysis-contract/business-flow.ts';
import type {RevenueHistory, RevenueHistoryQuarter} from '../../../shared/analysis-contract/revenue-history.ts';
import {historyQuarterFrom} from '../../../shared/analysis-runtime/financial-data/history.ts';
import {publicFlowSchema} from '../../../shared/analysis-runtime/financial-data/schema.ts';
import {rebuildPublication, republishStoredFinancials} from '../src/financial-data/republish.ts';
import {historyKey} from '../src/financial-data/history.ts';
import {readCompletePublication} from '../src/financial-data/publication.ts';
import {FinancialMaintenanceStore} from '../src/admin/financial-maintenance-store.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/b10-production/${name}`, import.meta.url), 'utf8');
const now = new Date('2026-11-02T00:00:00Z'), cik = '0000019617';
const damagedVersion = 'reread:728aac1c-damaged';

test('production JPM republish preserves the entire verified quarter when history is total-only',()=>{
  const flow: PublicBusinessFlow = JSON.parse(fixture('jpm-publication.json'));
  const h: RevenueHistory = JSON.parse(fixture('jpm-history.json'));
  assert.equal(flow.quarters[0].segments.length,4);
  assert.equal(h.quarters[0].segments[0].id,'reported-company-total');
  for (const quarter of [h.quarters[0],{...h.quarters[0],revenue:'1',segments:[{id:'unverified-total',name:'Total',value:'1'}]}]) {
    const rebuilt = rebuildPublication(flow,[quarter],now.toISOString());
    assert.deepEqual(rebuilt.quarters,publicFlowSchema.parse(flow).quarters);
    assert.equal(rebuilt.fetchedAt,now.toISOString());
  }
});

test('republish still accepts a valid split or an explicit single reportable segment',()=>{
  const flow: PublicBusinessFlow = JSON.parse(fixture('jpm-publication.json'));
  const h: RevenueHistoryQuarter = JSON.parse(fixture('jpm-history.json')).quarters[0];
  const single = {...h,segmentDisclosure:'single_reportable_segment' as const};
  const result = rebuildPublication(flow,[single],now.toISOString());
  assert.equal(result.quarters[0].segmentDisclosure,'single_reportable_segment');
  assert.equal(result.quarters[0].segments.length,1);
  const split = historyQuarterFrom(flow.quarters[0],h.source)!;
  const rebuilt = rebuildPublication(flow,[split],now.toISOString());
  assert.deepEqual(rebuilt.quarters[0].segments.map(s=>s.revenue!.value),flow.quarters[0].segments.map(s=>s.revenue!.value));
});

// Execute the publication SQL and its transaction against SQLite, never production D1.
async function publicationFixture(t: {after(fn:()=>void):void}, withBase = true) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  for (const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8').replace(/--> statement-breakpoint/g,''));
  }
  const statement = (sql:string,args:unknown[]=[]) => ({
    bind:(...values:unknown[])=>statement(sql,values),
    first:async()=>sqlite.prepare(sql).get(...args as never[])??null,
    all:async()=>({results:sqlite.prepare(sql).all(...args as never[])}),
    run:async()=>({success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args as never[]).changes)}}),
  });
  const db = {prepare:statement,batch:async(items:Array<{run():Promise<unknown>}>)=>{
    sqlite.exec('BEGIN');
    try {const results=[];for (const item of items) results.push(await item.run());sqlite.exec('COMMIT');return results;}
    catch (error) {sqlite.exec('ROLLBACK');throw error;}
  }} as unknown as D1Database;
  const base: PublicBusinessFlow = JSON.parse(fixture('jpm-publication.json'));
  const damaged: PublicBusinessFlow = JSON.parse(fixture('jpm-damaged-publication.json'));
  const insert = async(id:string,generation:number,flow:PublicBusinessFlow,issuer=cik) => {
    await db.prepare('INSERT INTO financial_complete_versions(version_id,cik,ticker,generation,payload_json,published_at) VALUES(?,?,?,?,?,?)')
      .bind(id,issuer,flow.ticker,generation,JSON.stringify(flow),new Date(now.getTime()+generation).toISOString()).run();
  };
  if (withBase) {
    // A distinguishable older version ensures we select the newest eligible generation.
    await insert('pipeline:older',1,{...base,quarters:base.quarters.map(q=>({...q,label:'Older publication'}))});
    await insert('pipeline:latest',2,base);
  }
  await insert(damagedVersion,3,damaged);
  await insert('reread:later',4,damaged);
  await insert('pipeline:other-issuer',5,{...base,ticker:'OTHER'},'0000000001');
  await db.prepare('INSERT INTO financial_complete_current(cik,version_id,generation) VALUES(?,?,?)').bind(cik,damagedVersion,3).run();
  await db.prepare('INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?)').bind(historyKey(cik),fixture('jpm-history.json'),now.toISOString()).run();
  const store = new FinancialMaintenanceStore(db);
  await store.create({requestId:'recover-publication',ticker:'JPM',action:'reread',accessionNumber:'0001628280-26-065582'},now);
  const task = (await store.claim(now))!;
  const target = {ticker:'JPM',cik,taskId:task.task_id,leaseToken:task.lease_token!};
  return {db,base,damaged,target};
}

test('republish restores the four verified JPM September segments from the newest pipeline version when current is a damaged reread',async t=>{
  const {db,base,damaged,target} = await publicationFixture(t);
  assert.equal(damaged.quarters[0].segments[0].id,'reported-company-total');
  const before = (await db.prepare('SELECT * FROM financial_complete_versions ORDER BY version_id').all()).results;
  const version = await republishStoredFinancials(db,target,now);
  const published = await readCompletePublication(db,cik);
  assert.equal(published.status,'ready');
  assert.deepEqual(published.flow!.quarters,publicFlowSchema.parse(base).quarters);
  const restored = published.flow!.quarters.find(q=>q.periodEnd==='2026-09-30')!;
  assert.deepEqual(restored.segments.map(s=>[s.name,s.revenue!.value]),[
    ['Consumer & Community Banking','21171000000'],
    ['Commercial & Investment Bank','22734000000'],
    ['Asset & Wealth Management','6909000000'],
    ['Corporate','93000000'],
  ]);
  assert.equal((await db.prepare('SELECT version_id FROM financial_complete_current WHERE cik=?').bind(cik).first())!.version_id,version);
  assert.deepEqual((await db.prepare('SELECT * FROM financial_complete_versions WHERE version_id<>? ORDER BY version_id').bind(version).all()).results,before);
  assert.deepEqual((await db.prepare('SELECT resource FROM publication_revisions WHERE ticker=? ORDER BY resource').bind('JPM').all()).results.map(r=>r.resource),['capital','company','fundamentals']);
  assert.equal((await db.prepare('SELECT count(*) n FROM pipeline_outbox').first())!.n,0);
  assert.equal(await republishStoredFinancials(db,target,now),version);
  assert.equal((await db.prepare('SELECT count(*) n FROM financial_complete_versions').first())!.n,before.length+1);
});

test('republish falls back to current when the issuer has no pipeline version',async t=>{
  const {db,damaged,target} = await publicationFixture(t,false);
  await republishStoredFinancials(db,target,now);
  assert.deepEqual((await readCompletePublication(db,cik)).flow!.quarters,publicFlowSchema.parse(damaged).quarters);
});

test('republish fences against the current reread version even when using a different pipeline base',async t=>{
  const {db,target} = await publicationFixture(t);
  const before = (await db.prepare('SELECT * FROM financial_complete_versions ORDER BY version_id').all()).results;
  const racingDb = {...db,batch:async(items:D1PreparedStatement[])=>{
    // A concurrent publication moves current after our reads, before the atomic write.
    await db.prepare('UPDATE financial_complete_current SET version_id=?,generation=4 WHERE cik=?').bind('reread:later',cik).run();
    return db.batch(items);
  }} as D1Database;
  await assert.rejects(republishStoredFinancials(racingDb,target,now),/REPUBLICATION_LEASE_OR_VERSION_CHANGED/);
  assert.equal((await db.prepare('SELECT version_id FROM financial_complete_current WHERE cik=?').bind(cik).first())!.version_id,'reread:later');
  assert.deepEqual((await db.prepare('SELECT * FROM financial_complete_versions ORDER BY version_id').all()).results,before);
  assert.equal((await db.prepare('SELECT count(*) n FROM publication_revisions').first())!.n,0);
});


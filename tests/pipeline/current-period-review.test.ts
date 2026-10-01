import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reviewedCurrentPair,priorPresentationOnly} from '../../workers/pipeline/src/financial-data/period-review.ts';
import type {Fact,DocumentSource} from '../../workers/pipeline/src/financial-data/parser.ts';
import {checkCompleteFlow} from '../../shared/analysis-runtime/financial-data/completeness.ts';
const issuers=JSON.parse(readFileSync(new URL('./fixtures/current-period-review-facts.json',import.meta.url),'utf8')) as Array<{ticker:string;expected:string;facts:Fact[];documents:Array<{source:DocumentSource;eligible:boolean;sha256:string}>}>;
test('five current SEC issuers reconcile original cumulative versions including annual Q4 and signed losses',()=>{
 for(const issuer of issuers){const reviewed=reviewedCurrentPair(issuer.facts,issuer.expected,issuer.documents);assert.equal(reviewed.reviewed,true,issuer.ticker);assert.deepEqual(checkCompleteFlow({schemaVersion:'business-flow.v1',ticker:issuer.ticker,fetchedAt:'2026-10-01',quarters:reviewed.quarters}),{complete:true,reasons:[]});assert.equal(reviewed.quarters[0].periodEnd,issuer.expected);assert.ok(issuer.documents.every(d=>d.sha256.length===64));
  if(issuer.ticker==='MSFT'){const q=reviewed.quarters[0];assert.equal(q.figures.net!.value,'35766000000');assert.equal(q.figures.net!.basis,'derived');assert.deepEqual(q.figures.net!.lineage!.map(l=>[l.periodStart,l.periodEnd]),[['2025-07-01','2026-06-30'],['2025-07-01','2026-03-31']]);}
  if(issuer.ticker==='ADSK')assert.equal(reviewed.quarters[0].segments.length,5);
  if(issuer.ticker==='BRK.B'){assert.equal(reviewed.quarters[0].segments.length,7);assert.equal(reviewed.quarters[0].figures.net!.value,'25772000000');assert.equal(reviewed.quarters[0].figures.gross,undefined);}
  if(issuer.ticker==='NET')assert.equal(reviewed.quarters[0].figures.net!.value,'-169981000');
 }
});
test('prior presentation review fails on inconsistent cumulative versions and on genuine unreviewed restatements',()=>{
 const issuer=structuredClone(issuers.find(i=>i.ticker==='AAPL')!);for(const f of issuer.facts)if(f.start<'2026-03-29'&&f.end==='2026-06-27'&&f.tag.endsWith(':NetIncomeLoss')&&!Object.keys(f.dimensions).length)f.value+=100000000;assert.equal(reviewedCurrentPair(issuer.facts,issuer.expected,issuer.documents).reviewed,false);
 const original=issuers[0];assert.equal(reviewedCurrentPair(original.facts,original.expected,original.documents.map(d=>({...d,eligible:false}))).reviewed,false);
 assert.equal(priorPresentationOnly('Previously reported income statements were restated due to an accounting error.'),false);
 assert.equal(priorPresentationOnly('Certain prior period amounts in the condensed consolidated financial statements and accompanying notes have been reclassified to conform to the current period&#8217;s presentation.'),true);
});

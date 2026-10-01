import {readFileSync} from 'node:fs';
import {parseSecBusinessFlow} from '../../workers/pipeline/src/sec/business-flow-parser.ts';
import {parseSecEarningsRelease} from '../../workers/pipeline/src/sec/business-flow-release.ts';
import {buildPublishedBusinessQuarter} from '../../workers/pipeline/src/sec/business-flow-refresh.ts';
import type {PublicBusinessFlow} from '../../shared/analysis-contract/business-flow.ts';
const current=buildPublishedBusinessQuarter(parseSecBusinessFlow(readFileSync(new URL('../pipeline/fixtures/orcl-2026-q1-sec-xbrl.html',import.meta.url),'utf8'),{sourceUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526389274/orcl-20260831.htm',accession:'0001193125-26-389274',periodEnd:'2026-08-31'})[0],'2026-09-11')!;
const previous=buildPublishedBusinessQuarter(parseSecEarningsRelease(readFileSync(new URL('../pipeline/fixtures/orcl-2026-q4-sec-exhibit-tables.html',import.meta.url),'utf8'),{sourceUrl:'https://www.sec.gov/Archives/edgar/data/1341439/000119312526265848/orcl-ex99_1.htm',accession:'0001193125-26-265848'})[0],'2026-06-10')!;
const flow:PublicBusinessFlow={schemaVersion:'business-flow.v1',ticker:'ORCL',fetchedAt:'2026-10-01',quarters:[current,previous]};
export {flow as completeOrclFixture,current,previous};

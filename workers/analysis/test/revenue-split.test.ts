import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRevenueStructure, type RevenueStructure } from "../src/financial-data/calculation.ts";
import { extractVerifiedCurrentQuarters, type Fact } from "../src/financial-data/parser.ts";

const source = { url: "https://www.sec.gov/Archives/edgar/data/1/a-new/doc.htm", accession: "a-new", filedAt: "2026-07-31", cik: "0000000001", industry: "standard" as const };
const fact = (tag: string, value: number, dimensions: Record<string, string> = {}, tables?: string[]): Fact =>
  ({ source, precision: -6, tag, value: value * 1e6, currency: "USD", start: "2026-04-01", end: "2026-06-30", context: `c-${tag}-${Object.values(dimensions).join("-")}`, dimensions, ...(tables ? { tables } : {}) });
const segment = (tag: string, member: string, value: number, tables?: string[], axis = "us-gaap:StatementBusinessSegmentsAxis") => fact(tag, value, { [axis]: member }, tables);
const split = (facts: Fact[], revenueStructure: RevenueStructure | null) => extractVerifiedCurrentQuarters({ ...source, revenueStructure }, facts).quarters[0];

// Alphabet's 10-Q for the quarter ended June 30, 2026 (millions): its segment note declares
// Revenues = RevenueFromContractWithCustomer + RevenueNotFromContractWithCustomer, the segments reporting the first.
const role = "http://www.google.com/role/RevenuesRevenuebySegmentDetails";
const alphabetMeta = { instance: { "goog-20260630.htm": { report: {}, tag: {
  "us-gaap_Revenues": { calculation: { [role]: { root: true } }, presentation: [role] },
  "us-gaap_RevenueFromContractWithCustomerExcludingAssessedTax": { calculation: { [role]: { parentTag: "us-gaap_Revenues", weight: 1, order: 1 } }, presentation: [role] },
  "us-gaap_RevenueNotFromContractWithCustomer": { calculation: { [role]: { parentTag: "us-gaap_Revenues", weight: 1, order: 2 } }, presentation: [role], lang: { "en-us": { role: { terseLabel: "Hedging gains (losses)", label: "Revenue Not from Contract with Customer" } } } },
  "goog_GoogleServicesMember": { presentation: [role, "http://www.google.com/role/Other"] },
  "goog_GoogleCloudMember": { presentation: [role] },
} } } };
const alphabet = (hedging: number | null) => {
  const tables = ["RevenuesRevenuebySegmentDetails"];
  return [fact("us-gaap:Revenues", 119796),
    segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "goog:GoogleServicesMember", 94540, tables),
    segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "goog:GoogleCloudMember", 24768, tables),
    segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:AllOtherSegmentsMember", 382, tables),
    ...(hedging == null ? [] : [fact("us-gaap:RevenueNotFromContractWithCustomer", hedging)])];
};

test("the revenue structure keeps the summations under a revenue total and the revenue tables each member is shown in", () => {
  const structure = parseRevenueStructure(alphabetMeta)!;
  assert.deepEqual(structure.arcs.map(a => [a.parent, a.child, a.weight]).sort(), [["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", 1], ["us-gaap:Revenues", "us-gaap:RevenueNotFromContractWithCustomer", 1]]);
  assert.equal(structure.labels["us-gaap:RevenueNotFromContractWithCustomer"], "Hedging gains (losses)");
  // A role that shows no revenue total is not a revenue table.
  assert.deepEqual(structure.members["goog:GoogleServicesMember"], ["RevenuesRevenuebySegmentDetails"]);
  assert.equal(parseRevenueStructure({ instance: { x: { report: {}, tag: {} } } }), null);
});

test("segments reach consolidated revenue through the line the filing's revenue calculation adds beside them", () => {
  const q = split(alphabet(106), parseRevenueStructure(alphabetMeta));
  assert.deepEqual(q.segments.map(s => [s.id, Number(s.revenue.value) / 1e6]), [["goog:GoogleServicesMember", 94540], ["goog:GoogleCloudMember", 24768], ["us-gaap:AllOtherSegmentsMember", 382]]);
  assert.deepEqual(q.revenueAdjustments?.map(a => [a.id, a.name, Number(a.amount.value) / 1e6, a.amount.lineage?.[0].concept]), [["RevenueNotFromContractWithCustomer", "Hedging gains (losses)", 106, "us-gaap:RevenueNotFromContractWithCustomer"]]);
  assert.match(q.segments[0].disclosure, /reconciling items/);
});

test("without the reconciling fact, or without the filing's calculation, the split does not balance and is not shown", () => {
  assert.equal(split(alphabet(null), parseRevenueStructure(alphabetMeta)).segments[0].id, "reported-company-total");
  assert.equal(split(alphabet(106), null).segments[0].id, "reported-company-total");
  // A reconciling fact that does not close the gap exactly is not accepted.
  assert.equal(split(alphabet(105), parseRevenueStructure(alphabetMeta)).segments[0].id, "reported-company-total");
});

test("a line the calculation subtracts enters with its sign", () => {
  const structure: RevenueStructure = { arcs: [{ role: "r", parent: "us-gaap:Revenues", child: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", weight: 1 }, { role: "r", parent: "us-gaap:Revenues", child: "x:SalesIncentives", weight: -1 }], labels: { "x:SalesIncentives": "Sales incentives" }, members: {} };
  const q = split([fact("us-gaap:Revenues", 90), segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "x:AMember", 60), segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "x:BMember", 40), fact("x:SalesIncentives", 10)], structure);
  assert.deepEqual(q.revenueAdjustments?.map(a => [a.name, Number(a.amount.value) / 1e6, a.amount.basis]), [["Sales incentives", -10, "derived"]]);
});

test("a bank's managed-basis segments reach reported revenue with its corporate line and reconciling items", () => {
  const consolidation = (member: string, value: number) => fact("us-gaap:Revenues", value, { "srt:ConsolidationItemsAxis": member });
  const q = split([fact("us-gaap:Revenues", 57347), segment("us-gaap:Revenues", "x:ConsumerMember", 20272), segment("us-gaap:Revenues", "x:CommercialMember", 24853), segment("us-gaap:Revenues", "x:WealthMember", 6851),
    consolidation("us-gaap:CorporateNonSegmentMember", 6046), consolidation("us-gaap:MaterialReconcilingItemsMember", -675)], null);
  assert.deepEqual(q.segments.map(s => [s.id, Number(s.revenue.value) / 1e6]), [["x:ConsumerMember", 20272], ["x:CommercialMember", 24853], ["x:WealthMember", 6851], ["corporate", 6046]]);
  assert.deepEqual(q.revenueAdjustments?.map(a => [a.id, a.name, Number(a.amount.value) / 1e6]), [["reconciling-items", "Reconciling items", -675]]);
});

test("one axis shown in two tables is two splits; of two balanced splits the more detailed is taken, with no list of members", () => {
  const product = (member: string, value: number, table: string) => segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", member, value, [table], "srt:ProductOrServiceAxis");
  // Autodesk, quarter ended July 31, 2026: subscription and other on the statement, product families in the revenue note.
  const q = split([fact("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", 2046),
    product("us-gaap:SubscriptionAndCirculationMember", 1952, "Statement"), product("us-gaap:ProductAndServiceOtherMember", 94, "Statement"),
    product("adsk:ArchitectureEngineeringConstructionAndOperationsMember", 1029, "ContractRevenue"), product("adsk:AutoCADandAutoCADLTFamilyMember", 500, "ContractRevenue"),
    product("adsk:ManufacturingMember", 385, "ContractRevenue"), product("adsk:MediaAndEntertainmentMember", 92, "ContractRevenue"), product("srt:OtherMember", 40, "ContractRevenue")], null);
  assert.deepEqual(q.segments.map(s => s.id), ["adsk:ArchitectureEngineeringConstructionAndOperationsMember", "adsk:AutoCADandAutoCADLTFamilyMember", "adsk:ManufacturingMember", "adsk:MediaAndEntertainmentMember", "srt:OtherMember"]);
  assert.equal(q.revenueAdjustments, undefined);
});

// Meta's 10-Q for the quarter ended June 30, 2026 (millions): Advertising and Other revenue are tagged on the product
// axis and the Family of Apps segment together.
const product = (member: string, segmentMember: string, value: number) => fact("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", value, { "srt:ProductOrServiceAxis": member, "us-gaap:StatementBusinessSegmentsAxis": segmentMember });
const meta = (other: number) => [fact("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", 60801),
  segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "meta:FamilyOfAppsMember", 60370),
  segment("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "meta:RealityLabsMember", 431),
  product("us-gaap:AdvertisingMember", "meta:FamilyOfAppsMember", 59363), product("us-gaap:ServiceOtherMember", "meta:FamilyOfAppsMember", other)]
  .map(f => ({ ...f, memberLabels: { "us-gaap:AdvertisingMember": "Advertising", "us-gaap:ServiceOtherMember": "Other revenue", "meta:FamilyOfAppsMember": "Family of Apps", "meta:RealityLabsMember": "Reality Labs" } }));

test("a segment splits into the product lines the filing tags on both axes when they add up to it", () => {
  const q = split(meta(1007), null);
  assert.deepEqual(q.segments.map(s => [s.name, Number(s.revenue.value) / 1e6]), [["Family of Apps", 60370], ["Reality Labs", 431]]);
  assert.deepEqual(q.segments[0].children?.map(c => [c.id, c.name, Number(c.revenue.value) / 1e6]), [["meta:FamilyOfAppsMember|us-gaap:AdvertisingMember", "Advertising", 59363], ["meta:FamilyOfAppsMember|us-gaap:ServiceOtherMember", "Other revenue", 1007]]);
  assert.equal(q.segments[1].children, undefined);
  // Lines that do not add up to the segment are not shown as its parts.
  assert.equal(split(meta(1006), null).segments[0].children, undefined);
});

// TTM Technologies' 10-Q for the quarter ended June 29, 2026 (millions): the segment note eliminates 0.301 against the
// segments' gross Revenues and prints "—" against their revenue from external customers, which adds up to the total.
const ttm = (externalElimination: number) => {
  const contract = "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", elimination = { "srt:ConsolidationItemsAxis": "us-gaap:IntersegmentEliminationMember" };
  return [fact("us-gaap:Revenues", 1004.054), fact(contract, 1004.054),
    segment(contract, "ttmi:AerospaceAndDefenseMember", 382.631), segment(contract, "ttmi:CommercialMember", 621.423),
    fact(contract, externalElimination, elimination), fact("us-gaap:Revenues", -0.301, elimination)];
};

test("each revenue concept keeps its own eliminations, and a split balances with those of its concept", () => {
  const q = split(ttm(0), null);
  assert.deepEqual(q.segments.map(s => [s.id, Number(s.revenue.value)]), [["ttmi:AerospaceAndDefenseMember", 382631000], ["ttmi:CommercialMember", 621423000]]);
  assert.deepEqual(q.revenueAdjustments?.map(a => [a.id, Number(a.amount.value), a.amount.lineage?.[0].concept]), [["intersegment-eliminations", 0, "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"]]);
});

test("eliminations that disagree within one concept are a conflict", () => {
  const facts = [...ttm(0), fact("us-gaap:Revenues", -0.302, { "srt:ConsolidationItemsAxis": "us-gaap:IntersegmentEliminationMember" })];
  facts[facts.length - 1] = { ...facts[facts.length - 1], context: "c-revenues-elimination-2" };
  const result = extractVerifiedCurrentQuarters({ ...source, revenueStructure: null }, facts);
  assert.deepEqual(result.quarters, []);
  assert.ok(result.issues.includes("CONFLICTING_REVENUE_ELIMINATIONS"));
});

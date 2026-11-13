import { z } from "zod";
import type { MaterialIndexedBlock, MaterialRef, MaterialSnapshot, MaterialSource } from "../../../../shared/analysis-contract/filing-material.ts";
import type { LibraryTable } from "../../../../shared/analysis-contract/filing-library.ts";
import { decodeEntities, descendants, nodeText, parseMarkup, type Element } from "../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import { parseMaterialHtml } from "../../../../shared/analysis-runtime/filing-material.ts";
import type { AnalysisEnv } from "../operations.ts";
import { materialDigest } from "../filing-material/store.ts";

const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;
const recordSchema = z.record(z.string(), jsonSchema);
const inventorySchema = z.object({ facts: z.array(recordSchema), contexts: z.array(recordSchema), units: z.array(recordSchema), footnotes: z.array(recordSchema), relationships: z.array(recordSchema) }).catchall(jsonSchema);
type Inventory = z.infer<typeof inventorySchema>;
type Binding = { entry: string; documentId: string; title: string; path: string[] };
type CorpusEntry =
  | { id: string; kind: "paragraph" | "image"; text: string }
  | { id: string; kind: "table"; title: string; table: LibraryTable }
  | { id: string; kind: "inline-xbrl"; data: Json }
  | { id: string; kind: "residual"; text: string | Json };
export type SemanticCorpus = {
  filings: Array<{ ref: MaterialRef; filing: MaterialSnapshot["filing"] }>;
  documents: Array<{ id: string; filename: string; type: string; url: string; material: MaterialRef }>;
  entries: CorpusEntry[];
  bindings: Record<string, Binding>;
  technical: Array<{ id: string; filename: string; sha256: string; reason: string }>;
};
export type SemanticEvidence = { materials: MaterialRef[]; corpus: SemanticCorpus; aliases: Record<string, string> };

const object = (value: Json | undefined): Record<string, Json> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const string = (value: Json | undefined): string | null => typeof value === "string" ? value : null;
const plain = (value: string) => value.replace(/\s+/g, " ").trim();
const unfence = (text: string) => text.replace(/^(`{3,})[^\n]*\n([\s\S]*)\n\1\s*$/, "$2");
const stable = (value: Json): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function representedInventoryMarkup(value: Record<string, Json>): boolean {
  if (typeof value.rawHtml !== "string" || Array.isArray(value.issues) && value.issues.length) return false;
  const parsed = parseMarkup(value.rawHtml);
  if (parsed.issues.length) return false;
  const fields: Record<string, string[]> = Object.hasOwn(value, "entity") && Object.hasOwn(value, "period") && Object.hasOwn(value, "dimensions")
    ? { context: ["id"], entity: [], identifier: ["scheme"], segment: [], scenario: [], period: [], instant: [], startdate: [], enddate: [], forever: [], explicitmember: ["dimension"], typedmember: ["dimension"] }
    : Object.hasOwn(value, "numerator") && Object.hasOwn(value, "denominator")
      ? { unit: ["id"], measure: [], divide: [], unitnumerator: [], unitdenominator: [] }
      : value.kind === "explicit" && Object.hasOwn(value, "axis") && Object.hasOwn(value, "member") && Object.hasOwn(value, "value") ? { explicitmember: ["dimension"] } : {};
  return !!Object.keys(fields).length && parsed.nodes.every(node => {
    let parent = node.parent;
    while (parent) { if (parent.local === "typedmember") return true; parent = parent.parent; }
    return Object.hasOwn(fields, node.local) && Object.keys(node.attributes).every(key => fields[node.local]!.includes(key));
  });
}

function semanticValue(value: Json): Json {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (value !== null && typeof value === "object") {
    const representedMarkup = representedInventoryMarkup(value);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["locator", "continuations"].includes(key) && !(key === "rawHtml" && representedMarkup)).map(([key, child]) => [key,
      key === "rawHtml" && typeof child === "string" ? { semanticMarkup: parseMarkup(child).root.children.flatMap((node): Json[] => typeof node === "string" ? node.trim() ? [decodeEntities(node)] : [] : [markupValue(node)]) } : semanticValue(child)]));
  }
  return value;
}

function compactInventory(inventory: Inventory, blockId: string, aliases: Record<string, string>): Json {
  const dictionaries: Record<string, Json[]> = { qnames: [], contexts: [], units: [], entities: [], periods: [], text: [] };
  const indices = new Map<string, number>();
  const intern = (kind: string, value: Json): number => {
    const key = `${kind}:${stable(value)}`, found = indices.get(key);
    if (found !== undefined) return found;
    const at = dictionaries[kind]!.length;
    dictionaries[kind]!.push(value); indices.set(key, at); return at;
  };
  const reference = (kind: string, value: Json): Json => intern(kind, value);
  const compact = (value: Json): Json => {
    if (typeof value === "string" && value.length > 100) return { text: intern("text", value) };
    if (Array.isArray(value)) return value.map(compact);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)]));
    return value;
  };
  const contextValue = (value: Json): Json => {
    const context = object(semanticValue(value));
    if (!context) return value;
    return Object.fromEntries(Object.entries(context).filter(([key]) => key !== "id").map(([key, item]) => [key,
      key === "entity" && item !== null ? reference("entities", item) : key === "period" ? reference("periods", item) : key === "dimensions" && Array.isArray(item) ? item.map(dimension => {
        const fields = object(dimension);
        return fields ? Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, ["axis", "member"].includes(name) && field !== null ? reference("qnames", field) : field])) : dimension;
      }) : compact(item)]));
  };
  const unitValue = (value: Json): Json => {
    const unit = object(semanticValue(value));
    return unit ? Object.fromEntries(Object.entries(unit).filter(([key]) => key !== "id").map(([key, item]) => [key,
      ["numerator", "denominator"].includes(key) && Array.isArray(item) ? item.map(measure => reference("qnames", measure)) : compact(item)])) : value;
  };
  const contexts = inventory.contexts.map(value => {
    const context = contextValue(value);
    if (typeof value.id === "string") aliases[`${blockId}:context:${value.id}`] = `${blockId}:contexts:${intern("contexts", context)}`;
    return intern("contexts", context);
  });
  const units = inventory.units.map(value => {
    const unit = unitValue(value);
    if (typeof value.id === "string") aliases[`${blockId}:unit:${value.id}`] = `${blockId}:units:${intern("units", unit)}`;
    return intern("units", unit);
  });
  const facts = inventory.facts.map((value, index) => {
    const fact = object(semanticValue(value))!;
    const id = string(fact.id);
    if (id) aliases[id] = `${blockId}:facts:${index}`;
    const attributes = object(fact.attributes);
    if (attributes) {
      if (typeof attributes.id === "string") aliases[`${blockId}:element:${attributes.id}`] = `${blockId}:facts:${index}`;
      fact.attributes = Object.fromEntries(Object.entries(attributes).filter(([key, child]) => {
        if (key === "id") return false;
        const represented = key === "name" ? object(fact.concept)?.name : key === "format" ? object(fact.format)?.name : fact[key];
        return represented === undefined || stable(child) !== stable(represented);
      }));
    }
    return Object.fromEntries(Object.entries(fact).filter(([key]) => key !== "id").map(([key, child]) => [key,
      key === "concept" ? reference("qnames", child) : key === "context" && child !== null ? reference("contexts", contextValue(child)) : key === "unit" && child !== null ? reference("units", unitValue(child)) : key === "format" && child !== null ? reference("qnames", child) : compact(child)]));
  });
  const columns = [...new Set(facts.flatMap(fact => Object.keys(fact)))];
  const defaults = Object.fromEntries(columns.filter(key => facts.length && facts.every(fact => stable(fact[key] ?? null) === stable(facts[0]![key] ?? null))).map(key => [key, facts[0]![key] ?? null]));
  const varying = columns.filter(key => !Object.hasOwn(defaults, key));
  return { ...Object.fromEntries(Object.entries(inventory).filter(([key]) => !["facts", "contexts", "units", "footnotes", "relationships"].includes(key)).map(([key, value]) => [key, semanticValue(value)])),
    dictionaries, columnDictionaries: { concept: "qnames", context: "contexts", unit: "units", format: "qnames" }, nestedDictionaries: { contexts: { entity: "entities", period: "periods", dimensions: { axis: "qnames", member: "qnames" } }, units: { numerator: "qnames", denominator: "qnames" } }, textReference: "An object {text: integer} references dictionaries.text. Fact attributes already represented by named fields are omitted; element ids remain in source aliases.", contexts, units, facts: { defaults, columns: varying, rows: facts.map(fact => varying.map(key => fact[key] ?? null)) },
    footnotes: inventory.footnotes.map(semanticValue), relationships: inventory.relationships.map(semanticValue) };
}

const keysWithin = (value: Json | undefined, keys: string[]): boolean => {
  const record = object(value);
  return !!record && Object.keys(record).every(key => keys.includes(key));
};
function taxonomyViewer(value: Json): boolean {
  const root = object(value), instances = object(root?.instance), references = object(root?.std_ref);
  const stringList = (item: Json | undefined) => Array.isArray(item) && item.every(entry => typeof entry === "string");
  const numberMap = (item: Json | undefined) => { const fields = object(item); return !!fields && Object.values(fields).every(entry => typeof entry === "number"); };
  const anchors = (item: Json | undefined) => item === null || keysWithin(item, ["contextRef", "name", "unitRef", "xsiNil", "lang", "decimals", "ancestors", "reportCount", "baseRef", "first", "unique"]);
  if (!root || root.version !== "2.2" || !keysWithin(root, ["version", "instance", "std_ref"]) || !instances || !references) return false;
  if (!Object.values(references).every(item => keysWithin(item, ["Clause", "Footnote", "Name", "Number", "Paragraph", "Publisher", "Section", "Sentence", "SubTopic", "Subclause", "Subparagraph", "Subsection", "Topic", "URI", "role"]) && Object.values(object(item)!).every(field => typeof field === "string"))) return false;
  return Object.values(instances).every(item => {
    const instance = object(item), tags = object(instance?.tag), reports = object(instance?.report), dts = object(instance?.dts);
    return !!instance && keysWithin(instance, ["nsprefix", "nsuri", "dts", "keyStandard", "keyCustom", "axisStandard", "axisCustom", "memberStandard", "memberCustom", "hidden", "contextCount", "entityCount", "segmentCount", "elementCount", "unitCount", "baseTaxonomies", "report", "tag"])
      && numberMap(instance.hidden) && numberMap(instance.baseTaxonomies)
      && !!dts && keysWithin(dts, ["inline", "schema", "calculationLink", "definitionLink", "labelLink", "presentationLink"]) && Object.values(dts).every(entry => keysWithin(entry, ["local", "remote"]) && Object.values(object(entry)!).every(stringList))
      && !!tags && Object.values(tags).every(tag => {
        const fields = object(tag), languages = object(fields?.lang), calculation = object(fields?.calculation);
        return !!fields && keysWithin(fields, ["auth_ref", "calculation", "crdr", "lang", "localname", "nsuri", "presentation", "xbrltype"])
          && (fields.auth_ref === undefined || stringList(fields.auth_ref)) && (fields.presentation === undefined || stringList(fields.presentation))
          && (fields.calculation === undefined || !!calculation && Object.values(calculation).every(entry => keysWithin(entry, ["parentTag", "weight", "order", "root"])))
          && !!languages && Object.values(languages).every(language => {
            const roles = object(object(language)?.role);
            return keysWithin(language, ["role"]) && !!roles && Object.values(roles).every(entry => typeof entry === "string");
          });
      })
      && !!reports && Object.values(reports).every(report => {
        const fields = object(report);
        return !!fields && keysWithin(fields, ["firstAnchor", "groupType", "isDefault", "longName", "menuCat", "order", "role", "shortName", "subGroupType", "uniqueAnchor"])
          && (fields.firstAnchor === undefined || anchors(fields.firstAnchor)) && (fields.uniqueAnchor === undefined || anchors(fields.uniqueAnchor));
      });
  });
}
function technicalCode(source: MaterialSource, text: string): string | null {
  if (/\.(?:js|mjs|css|map)$/i.test(source.filename)) return "Executable viewer code or presentation stylesheet; no filing business text.";
  if (/\.xsd$/i.test(source.filename) && /<(?:[\w.-]+:)?schema\b/.test(text)) return "XBRL taxonomy schema declarations; instance business facts are retained separately.";
  if (/\.xml$/i.test(source.filename) && /<(?:[\w.-]+:)?linkbase\b/.test(text) && /http:\/\/www\.xbrl\.org\/2003\/linkbase/.test(text)) return "XBRL taxonomy linkbase declarations; instance business facts are retained separately.";
  if (source.filename.toLowerCase() === "metalinks.json" && taxonomyViewer(jsonSchema.parse(JSON.parse(text)))) return "Recognized SEC MetaLinks 2.2 taxonomy labels, authoritative references, roles and viewer navigation; its schema contains no instance fact values.";
  return null;
}

const qname = (name: string, node: Element): Json => ({ name, namespaceUri: node.namespaces[name.includes(":") ? name.split(":")[0]! : ""] ?? null });
const child = (node: Element, local: string) => descendants(node).find(item => item.local === local);
const childText = (node: Element, local: string) => { const found = child(node, local); return found ? nodeText(found).trim() : null; };
const comparisonValue = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(comparisonValue);
  const record = object(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, key === "name" && typeof child === "string" && Object.hasOwn(record, "namespaceUri") ? child.slice(child.indexOf(":") + 1) : comparisonValue(child)]));
};
const withoutId = (value: Json): Json => {
  const record = object(comparisonValue(semanticValue(value)));
  return record ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "id").map(([key, child]) => [key, key === "dimensions" && Array.isArray(child) ? [...child].sort((a, b) => stable(a).localeCompare(stable(b))) : child])) : value;
};

function xmlContext(node: Element): Json {
  const identifier = child(node, "identifier"), instant = childText(node, "instant");
  return { entity: identifier ? { identifier: nodeText(identifier).trim(), scheme: identifier.attributes.scheme ?? null } : null,
    period: { kind: instant ? "instant" : child(node, "forever") ? "forever" : child(node, "startdate") ? "duration" : "unknown", start: childText(node, "startdate"), end: instant ?? childText(node, "enddate") },
    dimensions: descendants(node).filter(item => ["explicitmember", "typedmember"].includes(item.local)).map(item => ({ kind: item.local === "explicitmember" ? "explicit" : "typed", axis: qname(item.attributes.dimension ?? "", item), member: item.local === "explicitmember" ? qname(nodeText(item).trim(), item) : null, value: nodeText(item).trim() })).sort((a, b) => stable(a).localeCompare(stable(b))), issues: [] };
}

function xmlUnit(node: Element): Json {
  const measures = (parent: Element) => descendants(parent).filter(item => item.local === "measure").map(item => qname(nodeText(item).trim(), item));
  const numerator = child(node, "unitnumerator"), denominator = child(node, "unitdenominator");
  return { numerator: measures(numerator ?? node), denominator: denominator ? measures(denominator) : [], issues: [] };
}

function markupValue(node: Element): Json {
  const contents = (item: Element | string): Json[] => {
    if (typeof item !== "string") return [markupValue(item)];
    if (!item.trim()) return [];
    const text = decodeEntities(item);
    if (!/<\/?[A-Za-z][^>]*>/.test(text)) return [text];
    const html = parseMarkup(text);
    const businessNode = (element: Element): Json[] => {
      const children = element.children.flatMap((entry): Json[] => typeof entry === "string" ? entry.trim() ? [decodeEntities(entry)] : [] : businessNode(entry));
      const attributes = Object.fromEntries(Object.entries(element.rawAttributes).filter(([key]) => !["style", "class", "id"].includes(key.toLowerCase())));
      if (["span", "font"].includes(element.local) && !Object.keys(attributes).length) return children;
      return [{ name: element.name, attributes, children }];
    };
    return [{ embeddedHtml: html.root.children.flatMap((entry): Json[] => typeof entry === "string" ? entry.trim() ? [decodeEntities(entry)] : [] : businessNode(entry)), parserIssues: html.issues.map(issue => ({ ...issue })) }];
  };
  return { name: node.name, namespaceUri: node.namespaceUri, attributes: node.rawAttributes, children: node.children.flatMap(contents) };
}

function instanceResidual(text: string, snapshot: MaterialSnapshot, source: MaterialSource, inventories: Array<{ id: string; data: Inventory }>, blockId: string, aliases: Record<string, string>): Json | null {
  const markup = parseMarkup(text), root = markup.root.children.find(item => typeof item !== "string" && item.local === "xbrl");
  if (!root || typeof root === "string" || root.namespaceUri !== "http://www.xbrl.org/2003/instance") return null;
  const contexts = new Map<string, Json>(), units = new Map<string, Json>();
  const tableSemantics = new Set(snapshot.tables.map(table => stable(jsonSchema.parse(table.table))));
  const embeddedTablesRetained = (html: string) => {
    if (/<(?:img|image)\b/i.test(html)) return false;
    if (!/<table\b/i.test(html)) return true;
    const parsed = parseMaterialHtml(snapshot.filing, source, html);
    return parsed.tables.length > 0 && parsed.coverage.sourceTables === parsed.coverage.retainedTables && !parsed.coverage.issues.length
      && parsed.tables.every(table => tableSemantics.has(stable(jsonSchema.parse(table.table))));
  };
  const knownContexts = new Map<string, string>(), knownUnits = new Map<string, string>();
  const knownFacts = new Map<string, string>();
  const decimalText = (value: string) => {
    const text = plain(value);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return text;
    const negative = text.startsWith("-"), [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
    const digits = (whole || "0").replace(/^0+(?=\d)/, ""), tail = fraction.replace(/0+$/, "");
    const number = `${digits}${tail ? `.${tail}` : ""}`;
    return negative && number !== "0" ? `-${number}` : number;
  };
  const factKey = (concept: Json, context: Json | null, unit: Json | null, value: string | null, nil: boolean, decimals: Json, precision: Json, language: Json) => stable([comparisonValue(concept), context, unit, value === null ? null : decimalText(value), nil, decimals, precision, language]);
  for (const inventory of inventories) {
    inventory.data.contexts.forEach((value, index) => knownContexts.set(stable(withoutId(value)), aliases[`${inventory.id}:context:${string(value.id)}`] ?? `${aliases[inventory.id] ?? inventory.id}:contexts:${index}`));
    inventory.data.units.forEach((value, index) => knownUnits.set(stable(withoutId(value)), aliases[`${inventory.id}:unit:${string(value.id)}`] ?? `${aliases[inventory.id] ?? inventory.id}:units:${index}`));
    inventory.data.facts.forEach((fact, index) => {
      const value = fact.nil === true ? null : string(fact.numericValue) ?? string(fact.normalizedValue) ?? string(fact.rawValue);
      const key = factKey(fact.concept ?? null, fact.context ? withoutId(fact.context) : null, fact.unit ? withoutId(fact.unit) : null, value, fact.nil === true, fact.decimals ?? null, fact.precision ?? null, fact.language ?? null);
      knownFacts.set(key, aliases[string(fact.id) ?? ""] ?? `${aliases[inventory.id] ?? inventory.id}:facts:${index}`);
    });
  }
  const residual: Json[] = [], matched: Record<string, string> = {};
  for (const node of root.children) {
    if (typeof node === "string") { if (node.trim()) residual.push(node); continue; }
    if (node.local === "context" && node.namespaceUri === root.namespaceUri) {
      const value = comparisonValue(xmlContext(node)), id = node.attributes.id ?? String(node.start);
      contexts.set(id, value);
      const contextShape = descendants(node).every(item => {
        const allowed: Record<string, string[]> = { entity: [], identifier: ["scheme"], segment: [], scenario: [], period: [], instant: [], startdate: [], enddate: [], forever: [], explicitmember: ["dimension"] };
        return Object.hasOwn(allowed, item.local) && Object.keys(item.attributes).every(key => allowed[item.local]!.includes(key));
      }) && Object.keys(node.attributes).every(key => key === "id");
      const target = contextShape ? knownContexts.get(stable(value)) : null;
      if (target) { matched[id] = target; aliases[`${blockId}:context:${id}`] = target; } else residual.push(markupValue(node));
    } else if (node.local === "unit" && node.namespaceUri === root.namespaceUri) {
      const value = comparisonValue(xmlUnit(node)), id = node.attributes.id ?? String(node.start);
      units.set(id, value);
      const unitShape = descendants(node).every(item => ["measure", "divide", "unitnumerator", "unitdenominator"].includes(item.local) && !Object.keys(item.attributes).length) && Object.keys(node.attributes).every(key => key === "id");
      const target = unitShape ? knownUnits.get(stable(value)) : null;
      if (target) { matched[id] = target; aliases[`${blockId}:unit:${id}`] = target; } else residual.push(markupValue(node));
    }
  }
  for (const node of root.children) {
    if (typeof node === "string" || ["context", "unit"].includes(node.local) && node.namespaceUri === root.namespaceUri) continue;
    const contextId = node.attributes.contextref;
    const allowedAttributes = new Set(["contextref", "unitref", "decimals", "precision", "id", "xsi:nil", "xml:lang"]);
    if (contextId && contexts.has(contextId) && matched[contextId] && node.children.every(item => typeof item === "string") && Object.keys(node.attributes).every(key => allowedAttributes.has(key))) {
      const raw = nodeText(node), decoded = decodeEntities(raw);
      const value = /<\/?[A-Za-z][^>]*>/.test(decoded) ? nodeText(parseMarkup(decoded).root, { blocks: true }) : decoded;
      const unit = node.attributes.unitref ? units.get(node.attributes.unitref) : null;
      const key = factKey(qname(node.name, node), contexts.get(contextId)!, unit ?? null, node.attributes["xsi:nil"] === "true" || node.attributes["xsi:nil"] === "1" ? null : value, node.attributes["xsi:nil"] === "true" || node.attributes["xsi:nil"] === "1", node.attributes.decimals ?? null, node.attributes.precision ?? null, node.attributes["xml:lang"] ?? root.attributes["xml:lang"] ?? null);
      const target = knownFacts.get(key);
      if (target && embeddedTablesRetained(decoded)) { const id = node.attributes.id ?? String(node.start); matched[id] = target; aliases[`${blockId}:fact:${id}`] = target; continue; }
    }
    residual.push(markupValue(node));
  }
  return { kind: "normalized-xbrl-instance", attributes: root.rawAttributes, matched, residual, parserIssues: markup.issues.map(item => ({ ...item })) };
}

/** Full business material from frozen snapshots. Layout and duplicate archive copies do not repeat their semantics. */
export async function semanticEvidence(env: Pick<AnalysisEnv, "SEC_FILINGS">, snapshots: MaterialSnapshot[]): Promise<SemanticEvidence> {
  const corpus: SemanticCorpus = { filings: [], documents: [], entries: [], bindings: {}, technical: [] }, aliases: Record<string, string> = {};
  const entries = new Map<string, string>();
  const add = (entry: CorpusEntry, block: Pick<MaterialIndexedBlock, "id" | "documentId" | "title" | "path">) => {
    const { id: _id, ...content } = entry; void _id;
    const key = stable(jsonSchema.parse(content)), existing = entries.get(key), canonical = existing ?? entry.id;
    if (!existing) { corpus.entries.push(entry); entries.set(key, canonical); }
    aliases[block.id] = canonical;
    if (existing && entry.id !== canonical) for (const [source, target] of Object.entries(aliases)) if (target.startsWith(`${entry.id}:`)) aliases[source] = `${canonical}${target.slice(entry.id.length)}`;
    corpus.bindings[block.id] = { entry: canonical, documentId: block.documentId, title: block.title, path: block.path };
  };
  for (const snapshot of snapshots) {
    corpus.filings.push({ ref: snapshot.ref, filing: snapshot.filing });
    corpus.documents.push(...snapshot.documents.map(source => ({ id: source.id, filename: source.filename, type: source.type, url: source.url, material: snapshot.ref })));
    const textOf = async (block: MaterialIndexedBlock) => {
      if (block.storage === "inline") return block.text;
      if (!block.range || block.range.offset + block.range.length > snapshot.markdown.bytes) throw new Error(`SEMANTIC_BLOCK_INCOMPLETE:${block.id}`);
      const object = await env.SEC_FILINGS.get(snapshot.markdown.key, { range: { offset: block.range.offset, length: block.range.length } });
      if (!object) throw new Error(`SEMANTIC_BLOCK_MISSING:${block.id}`);
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== block.range.length || await materialDigest(bytes) !== block.range.sha256) throw new Error(`SEMANTIC_BLOCK_CHANGED:${block.id}`);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    };
    const sources = new Map(snapshot.documents.map(source => [source.id, source]));
    const tables = new Map(snapshot.tables.map(table => [table.tableId, table]));
    const inventories: Array<{ id: string; data: Inventory }> = [];
    for (const block of snapshot.blocks.filter(item => item.title === "Inline XBRL facts, contexts, units and footnotes" && item.kind === "code")) {
      const data = inventorySchema.parse(JSON.parse(unfence(await textOf(block))));
      inventories.push({ id: block.id, data });
      add({ id: block.id, kind: "inline-xbrl", data: compactInventory(data, block.id, aliases) }, block);
    }
    for (const block of snapshot.blocks) {
      if (inventories.some(item => item.id === block.id)) continue;
      if (block.kind === "table") {
        const table = tables.get(block.tableId ?? block.id);
        if (!table) throw new Error(`SEMANTIC_TABLE_MISSING:${block.id}`);
        add({ id: block.id, kind: "table", title: table.title, table: table.table }, block);
      } else if (block.kind === "paragraph" || block.kind === "image") add({ id: block.id, kind: block.kind, text: await textOf(block) }, block);
      else {
        const text = unfence(await textOf(block)), source = sources.get(block.documentId);
        if (!source) throw new Error(`SEMANTIC_DOCUMENT_MISSING:${block.documentId}`);
        const technical = technicalCode(source, text);
        if (technical) { corpus.technical.push({ id: block.id, filename: source.filename, sha256: source.sha256, reason: technical }); continue; }
        const instance = instanceResidual(text, snapshot, source, inventories, block.id, aliases);
        if (instance) add({ id: block.id, kind: "residual", text: instance }, block);
        else if (/^\s*[[{]/.test(text)) add({ id: block.id, kind: "residual", text: jsonSchema.parse(JSON.parse(text)) }, block);
        else add({ id: block.id, kind: "residual", text }, block);
      }
    }
    for (const table of snapshot.tables) if (!corpus.bindings[table.tableId]) add({ id: table.tableId, kind: "table", title: table.title, table: table.table }, { id: table.tableId, documentId: table.documentId, title: table.title, path: [] });
    for (const duplicate of snapshot.coverage.duplicates) {
      const target = aliases[duplicate.target];
      if (!target) throw new Error(`SEMANTIC_ALIAS_MISSING:${duplicate.blockId}:${duplicate.target}`);
      aliases[duplicate.blockId] = target;
    }
  }
  return { materials: snapshots.map(snapshot => snapshot.ref), corpus, aliases };
}

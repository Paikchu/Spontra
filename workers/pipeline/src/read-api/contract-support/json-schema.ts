/**
 * A small JSON Schema (2020-12 subset) validator.
 *
 * The repository has no schema-validation dependency and hand-rolls its validation everywhere
 * else (`lib/company-analysis/contracts.ts`, `lib/sec-analysis.ts`), so the contract tests get a
 * validator in the same shape rather than a new runtime dependency. It supports exactly the
 * keywords `lib/analysis-contract/schema.ts` uses — anything unsupported would be silently
 * ignored, so `assertSupportedSchema` refuses a schema that reaches for one.
 */
export type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: JsonSchemaType | JsonSchemaType[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
  title?: string;
  examples?: unknown[];
};

type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

const SUPPORTED_KEYWORDS = new Set([
  "$ref", "$defs", "$id", "$schema", "type", "enum", "const", "properties", "required",
  "additionalProperties", "items", "minItems", "maxItems", "minimum", "maximum", "minLength",
  "maxLength", "pattern", "anyOf", "oneOf", "description", "title", "examples",
]);

export type ValidationError = { path: string; message: string };

/** Throws unless every subschema uses only keywords this validator actually enforces. */
export function assertSupportedSchema(schema: JsonSchema, path = "$"): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new Error(`${path}: unsupported JSON Schema keyword "${key}"`);
  }
  for (const [name, child] of Object.entries(schema.$defs ?? {})) assertSupportedSchema(child, `${path}.$defs.${name}`);
  for (const [name, child] of Object.entries(schema.properties ?? {})) assertSupportedSchema(child, `${path}.properties.${name}`);
  if (schema.items) assertSupportedSchema(schema.items, `${path}.items`);
  if (typeof schema.additionalProperties === "object") assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  schema.anyOf?.forEach((child, index) => assertSupportedSchema(child, `${path}.anyOf[${index}]`));
  schema.oneOf?.forEach((child, index) => assertSupportedSchema(child, `${path}.oneOf[${index}]`));
}

function validate(schema: JsonSchema, value: unknown, path: string, root: JsonSchema): ValidationError[] {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) return [{ path, message: `unresolvable $ref ${schema.$ref}` }];
    return validate(resolved, value, path, root);
  }

  const errors: ValidationError[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      errors.push({ path, message: `expected ${types.join(" | ")}, received ${describe(value)}` });
      // A wrong type makes every other keyword meaningless noise, so stop at the first one.
      return errors;
    }
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}, received ${JSON.stringify(value)}` });
  }
  if (typeof value === "string") errors.push(...validateString(schema, value, path));
  if (typeof value === "number") errors.push(...validateNumber(schema, value, path));
  if (Array.isArray(value)) errors.push(...validateArray(schema, value, path, root));
  else if (isRecord(value)) errors.push(...validateObject(schema, value, path, root));

  for (const branch of ["anyOf", "oneOf"] as const) {
    const alternatives = schema[branch];
    if (!alternatives) continue;
    const matched = alternatives.filter((alternative) => validate(alternative, value, path, root).length === 0);
    if (branch === "anyOf" && matched.length === 0) errors.push({ path, message: "matched none of anyOf" });
    if (branch === "oneOf" && matched.length !== 1) errors.push({ path, message: `matched ${matched.length} of oneOf, expected 1` });
  }
  return errors;
}

function validateString(schema: JsonSchema, value: string, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push({ path, message: `longer than maxLength ${schema.maxLength}` });
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errors.push({ path, message: `does not match ${schema.pattern}` });
  }
  return errors;
}

function validateNumber(schema: JsonSchema, value: number, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `below minimum ${schema.minimum}` });
  if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `above maximum ${schema.maximum}` });
  return errors;
}

function validateArray(schema: JsonSchema, value: unknown[], path: string, root: JsonSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `fewer than minItems ${schema.minItems}` });
  if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `more than maxItems ${schema.maxItems}` });
  if (schema.items) {
    value.forEach((item, index) => errors.push(...validate(schema.items!, item, `${path}[${index}]`, root)));
  }
  return errors;
}

function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string, root: JsonSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of schema.required ?? []) {
    if (!(key in value)) errors.push({ path: `${path}.${key}`, message: "required property is missing" });
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (key in value) errors.push(...validate(child, value[key], `${path}.${key}`, root));
  }
  if (schema.additionalProperties !== undefined && schema.properties) {
    const known = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: "additional property is not allowed" });
      else if (typeof schema.additionalProperties === "object") {
        errors.push(...validate(schema.additionalProperties, value[key], `${path}.${key}`, root));
      }
    }
  }
  return errors;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  return match ? root.$defs?.[match[1]!] ?? null : null;
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

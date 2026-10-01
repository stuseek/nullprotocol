const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });
const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
// Keywords Ajv implements, plus core and annotation keywords it accepts without a rule.
const KEYWORDS = new Set([
  ...Object.keys(ajv.RULES.all),
  '$id',
  '$schema',
  '$defs',
  'definitions',
  'title',
  'description',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
  'contentMediaType',
  'contentEncoding'
]);
// Keywords that mark an object as JSON Schema rather than a set of fields. The
// top level keeps the set it always had, so `{ type: 'string' }` there is still
// a field named "type"; a nested field is JSON Schema when it names its type.
const TOP_LEVEL_MARKS = new Set([
  '$schema',
  '$ref',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'oneOf'
]);
const FIELD_MARKS = new Set(['type', '$ref', 'anyOf', 'oneOf']);

const isPlainObject = value => value && typeof value === 'object' && !Array.isArray(value);

function typeSchema(name) {
  if (name === 'any') return {};
  if (name.endsWith('[]')) return { type: 'array', items: typeSchema(name.slice(0, -2)) };
  if (!TYPE_NAMES.has(name)) throw new Error(`Unsupported schema type: ${name}`);
  return { type: name };
}

// Reads an extraction schema, at the top level or as a field's object:
// 1. An object made only of JSON Schema keywords, including at least one marking
//    keyword, that Ajv accepts as a schema, is JSON Schema.
// 2. Otherwise, when every value is a field descriptor (a type name such as
//    'string', 'number[]' or 'any', or an object read by these same rules), it is
//    shorthand and every key is a required field. Fields may therefore be named
//    type, items, required or properties.
// 3. Otherwise, an object Ajv accepts as a schema that uses at least one JSON
//    Schema keyword is JSON Schema with extra keywords (for example "x-label").
// Anything else is invalid. The one ambiguity is an object of keywords alone,
// such as a field `{ type: 'string' }`, which rule 1 reads as JSON Schema; to
// name a single field "type", write that object as JSON Schema.
function readSchema(value, marks) {
  const keys = Object.keys(value);
  if (
    keys.some(key => marks.has(key)) &&
    keys.every(key => KEYWORDS.has(key)) &&
    ajv.validateSchema(value)
  ) {
    return value;
  }
  try {
    return readShorthand(value);
  } catch (error) {
    if (keys.some(key => KEYWORDS.has(key)) && ajv.validateSchema(value)) return value;
    throw error;
  }
}

function readShorthand(value) {
  const properties = {};
  for (const [name, descriptor] of Object.entries(value)) {
    if (typeof descriptor === 'string') properties[name] = typeSchema(descriptor);
    else if (isPlainObject(descriptor)) properties[name] = readSchema(descriptor, FIELD_MARKS);
    else throw new Error('Schema fields must be a type name or a JSON Schema object');
  }
  return { type: 'object', properties, required: Object.keys(value) };
}

function toJsonSchema(schema) {
  if (!isPlainObject(schema)) throw new Error('Extraction schema must be an object');
  return readSchema(schema, TOP_LEVEL_MARKS);
}

// Compiled validators, least recently used first, and which cached schema holds
// each $id. Ajv registers a schema under its $id, so the cache keeps at most one
// schema per $id: a new schema with the same $id replaces the old one. Removing
// a schema from Ajv on eviction then never drops another schema's $id, and
// Ajv's own cache stays as bounded as this one.
const MAX_VALIDATORS = 100;
const validators = new Map();
const idOwners = new Map();

function evict(key) {
  const entry = validators.get(key);
  validators.delete(key);
  if (entry.schema.$id) idOwners.delete(entry.schema.$id);
  ajv.removeSchema(entry.schema);
}

// The validator for an extraction schema; throws for an invalid schema, before any model call.
function validatorFor(schema) {
  const jsonSchema = toJsonSchema(schema);
  const key = JSON.stringify(jsonSchema);
  const cached = validators.get(key);
  if (cached) {
    validators.delete(key);
    validators.set(key, cached);
    return cached.validate;
  }
  const owner = jsonSchema.$id && idOwners.get(jsonSchema.$id);
  if (owner) evict(owner);
  const validate = ajv.compile(jsonSchema);
  if (validators.size >= MAX_VALIDATORS) evict(validators.keys().next().value);
  validators.set(key, { schema: jsonSchema, validate });
  if (jsonSchema.$id) idOwners.set(jsonSchema.$id, key);
  return validate;
}

function validateExtraction(data, schema) {
  const validator = validatorFor(schema);
  const isValid = validator(data);
  return {
    isValid,
    issues: isValid
      ? []
      : validator.errors.map(error => `${error.instancePath || '/'} ${error.message}`)
  };
}

module.exports = { toJsonSchema, validatorFor, validateExtraction };

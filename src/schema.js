const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map();
const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);

function toPropertySchema(descriptor) {
  if (typeof descriptor === 'string') {
    if (descriptor === 'any') return {};
    if (descriptor.endsWith('[]')) {
      return { type: 'array', items: toPropertySchema(descriptor.slice(0, -2)) };
    }
    if (!TYPE_NAMES.has(descriptor)) {
      throw new Error(`Unsupported schema type: ${descriptor}`);
    }
    return { type: descriptor };
  }

  if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)) {
    if (descriptor.type || descriptor.$ref || descriptor.anyOf || descriptor.oneOf)
      return descriptor;
    return toJsonSchema(descriptor);
  }

  throw new Error('Schema fields must be a type name or a JSON Schema object');
}

function toJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('Extraction schema must be an object');
  }
  if (
    schema.$schema ||
    schema.$ref ||
    schema.properties ||
    schema.required ||
    schema.additionalProperties !== undefined ||
    schema.items ||
    schema.anyOf ||
    schema.oneOf
  ) {
    return schema;
  }

  const properties = {};
  for (const [name, descriptor] of Object.entries(schema)) {
    properties[name] = toPropertySchema(descriptor);
  }
  return { type: 'object', properties, required: Object.keys(properties) };
}

function validateExtraction(data, schema) {
  const jsonSchema = toJsonSchema(schema);
  const cacheKey = JSON.stringify(jsonSchema);
  let validator = validators.get(cacheKey);
  if (!validator) {
    validator = ajv.compile(jsonSchema);
    if (validators.size >= 100) validators.clear();
    validators.set(cacheKey, validator);
  }
  const isValid = validator(data);
  return {
    isValid,
    issues: isValid
      ? []
      : validator.errors.map(error => `${error.instancePath || '/'} ${error.message}`)
  };
}

module.exports = { toJsonSchema, validateExtraction };

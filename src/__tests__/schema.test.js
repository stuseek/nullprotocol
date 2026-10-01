describe('extraction schemas', () => {
  const { toJsonSchema, validateExtraction } = require('../schema');

  test('shorthand fields may be named like JSON Schema keywords', () => {
    expect(
      validateExtraction(
        { vendor: 'Acme', items: ['desk'] },
        { vendor: 'string', items: 'string[]' }
      ).isValid
    ).toBe(true);
    expect(
      validateExtraction({ required: true, name: 'x' }, { required: 'boolean', name: 'string' })
        .isValid
    ).toBe(true);
    const nested = { address: { street: 'string', type: 'string' } };
    expect(validateExtraction({ address: { street: 'Main', type: 'home' } }, nested).isValid).toBe(
      true
    );
    expect(validateExtraction({ address: 'garbage' }, nested).isValid).toBe(false);
    expect(
      validateExtraction(
        { meta: { properties: 'p', kind: 'k' } },
        { meta: { properties: 'string', kind: 'string' } }
      ).isValid
    ).toBe(true);
  });

  test('JSON Schema and shorthand stay compatible on valid input', () => {
    const raw = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    };
    expect(toJsonSchema(raw)).toBe(raw);
    expect(toJsonSchema({ tags: { type: 'array', items: { type: 'string' } } })).toEqual({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags']
    });
    // A top-level field named "type" stays a field, as before.
    expect(toJsonSchema({ type: 'string' })).toEqual({
      type: 'object',
      properties: { type: { type: 'string' } },
      required: ['type']
    });
    // JSON Schema with an extra keyword is still JSON Schema.
    const labelled = { type: 'object', 'x-label': 'Order', properties: { id: { type: 'string' } } };
    expect(toJsonSchema(labelled)).toBe(labelled);
  });

  test('an invalid schema is rejected', () => {
    expect(() => toJsonSchema({ vendor: 'strng' })).toThrow('Unsupported schema type: strng');
    expect(() => toJsonSchema({ total: 42 })).toThrow('Schema fields must be');
    expect(() => toJsonSchema('string')).toThrow('Extraction schema must be an object');
  });
});

describe('the validator cache', () => {
  test('evicting a replaced schema keeps the $id of the schema that replaced it', () => {
    jest.isolateModules(() => {
      const { validatorFor } = require('../schema');
      const id = 'https://example.test/order';
      const object = idType => ({
        $id: id,
        type: 'object',
        properties: { id: { type: idType } },
        required: ['id']
      });
      validatorFor(object('string'));
      validatorFor(object('number'));
      for (let index = 0; index < 99; index++) validatorFor({ [`f${index}`]: 'string' });
      const byRef = validatorFor({ $ref: id });
      expect(byRef({ id: 5 })).toBe(true);
      expect(byRef({ id: 'a' })).toBe(false);
    });
  });

  test('stays bounded in Ajv, and a schema with $id still compiles after eviction', () => {
    jest.isolateModules(() => {
      const IsolatedAjv = require('ajv');
      const removeSchema = jest.spyOn(IsolatedAjv.prototype, 'removeSchema');
      try {
        const { validateExtraction } = require('../schema');
        const withId = {
          $id: 'https://example.test/order',
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        };
        expect(validateExtraction({ id: 'a' }, withId).isValid).toBe(true);
        for (let index = 0; index < 150; index++) {
          validateExtraction({ [`f${index}`]: 'x' }, { [`f${index}`]: 'string' });
        }
        // The $id schema was evicted; validating it again must not throw.
        expect(validateExtraction({ id: 'b' }, withId).isValid).toBe(true);
        // A different schema with the same $id replaces it instead of throwing.
        const sameId = { ...withId, required: [] };
        expect(validateExtraction({}, sameId).isValid).toBe(true);
        const instance = removeSchema.mock.contexts[0];
        expect(instance).toBeDefined();
        expect(instance._cache.size).toBeLessThanOrEqual(110);
      } finally {
        removeSchema.mockRestore();
      }
    });
  });
});

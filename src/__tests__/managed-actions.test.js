const { ManagedActionRegistry } = require('../managed-actions');
const { actionContractHash } = require('../managed-canonical');

const definition = {
  name: 'getOrder',
  description: 'Read an order',
  input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  output: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
  effect: 'read',
  handler: async () => ({ status: 'shipped' })
};

test('advertises the same contract hash as the API and validates both sides', () => {
  const registry = new ManagedActionRegistry([definition]);
  const hash = actionContractHash({
    name: definition.name,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    effect: definition.effect
  });
  expect(registry.manifest()).toEqual([{ name: 'getOrder', contractHash: hash }]);
  const action = registry.get('getOrder', hash);
  expect(action.validateInput({ id: '123' })).toBe(true);
  expect(action.validateInput({ id: 123 })).toBe(false);
  expect(action.validateOutput({ status: 'shipped' })).toBe(true);
  expect(action.validateOutput({ status: 123 })).toBe(false);
  expect(registry.get('getOrder', '0'.repeat(64))).toBeNull();
});

test('rejects invalid definitions before an executor advertises them', () => {
  expect(() => new ManagedActionRegistry([{ ...definition, handler: undefined }])).toThrow(
    'handler'
  );
  expect(
    () => new ManagedActionRegistry([{ ...definition, input: { type: 'nonexistent' } }])
  ).toThrow('JSON Schema');
  expect(() => new ManagedActionRegistry([{ ...definition, hidden: true }])).toThrow(
    'Unknown action definition'
  );
  expect(() => new ManagedActionRegistry([definition, definition])).toThrow('Duplicate');
});

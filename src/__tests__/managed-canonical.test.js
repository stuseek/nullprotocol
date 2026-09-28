const { createHash } = require('crypto');
const { canonicalJson, hashJson, actionContractHash } = require('../managed-canonical');

// Exact vectors from nullprotocol-api/test/canonical.test.js.
const apiVectors = [
  {
    value: { b: 1, a: [3, { d: null, c: 'x' }], e: undefined },
    json: '{"a":[3,{"c":"x","d":null}],"b":1}',
    sha256: 'b4a92c330fc01410911e683d5d03404eb28981a6e1d67f9cb1ae63ddc3d19947'
  },
  {
    value: { é: 1, Z: 2, a: 3, '😀': 4, ﬀ: 5 },
    json: '{"Z":2,"a":3,"é":1,"😀":4,"ﬀ":5}',
    sha256: 'dcbeb77d4a83fa006480021ae3f7118e05d2d918a0f0b8ce1406de9040bf30e1'
  },
  {
    value: {
      name: 'getOrder',
      description: 'Read one authorized order',
      input: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      output: { type: 'object' },
      effect: 'read'
    },
    json: '{"description":"Read one authorized order","effect":"read","input":{"properties":{"orderId":{"type":"string"}},"required":["orderId"],"type":"object"},"name":"getOrder","output":{"type":"object"}}',
    sha256: 'c3f8f89155dec56c677844e289560ecff5e84f26fc9bdfe5546f673e40770365'
  },
  {
    value: [1.5, -0, 1e21, 'line\nbreak'],
    json: '[1.5,0,1e+21,"line\\nbreak"]',
    sha256: 'c3668533ed6a03163d4cfa6aa168fea1e26631ec9af7b5198067166dfe12c3fd'
  }
];

test('matches the API canonical JSON and SHA-256 vectors exactly', () => {
  for (const vector of apiVectors) {
    expect(canonicalJson(vector.value)).toBe(vector.json);
    expect(hashJson(vector.value)).toBe(vector.sha256);
  }
  expect(actionContractHash(apiVectors[2].value)).toBe(apiVectors[2].sha256);
});

test('rejects non-finite numbers and unsupported JSON values', () => {
  expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
  expect(() => canonicalJson({ a: Infinity })).toThrow(TypeError);
  expect(() => canonicalJson(1n)).toThrow(TypeError);
});

test('recursively sorts object keys but preserves array order and JSON values', () => {
  const first = { z: 1, a: { y: [3, { b: true, a: 'x' }], x: null } };
  const second = { a: { x: null, y: [3, { a: 'x', b: true }] }, z: 1 };
  const expected = '{"a":{"x":null,"y":[3,{"a":"x","b":true}]},"z":1}';
  expect(canonicalJson(first)).toBe(expected);
  expect(canonicalJson(second)).toBe(expected);
  expect(hashJson(first)).toBe(createHash('sha256').update(expected).digest('hex'));
});

test('omits absent optional action fields and hashes the authoritative contract', () => {
  const action = {
    name: 'getOrder',
    description: 'Read one order',
    input: { type: 'object', properties: { orderId: { type: 'string' } } },
    output: { type: 'object', properties: { status: { type: 'string' } } },
    effect: 'read'
  };
  const expected = hashJson(action);
  expect(actionContractHash(action)).toBe(expected);
  expect(actionContractHash({ ...action, timeoutMs: undefined })).toBe(expected);
  expect(actionContractHash({ ...action, timeoutMs: 1000 })).not.toBe(expected);
});

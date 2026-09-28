const { createHash } = require('crypto');

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function actionContractHash(action) {
  const contract = {
    name: action.name,
    description: action.description,
    input: action.input,
    output: action.output,
    effect: action.effect
  };
  if (action.timeoutMs !== undefined && action.timeoutMs !== null) {
    contract.timeoutMs = action.timeoutMs;
  }
  if (action.maxResultBytes !== undefined && action.maxResultBytes !== null) {
    contract.maxResultBytes = action.maxResultBytes;
  }
  return hashJson(contract);
}

module.exports = { canonicalJson, hashJson, actionContractHash };

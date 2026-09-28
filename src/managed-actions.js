const Ajv = require('ajv');
const { actionContractHash } = require('./managed-canonical');

const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function positiveLimit(value, max, name) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
}

class ManagedActionRegistry {
  constructor(definitions = []) {
    if (!Array.isArray(definitions) || definitions.length > 64) {
      throw new Error('actions must be an array of at most 64 definitions');
    }
    const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false });
    this.byContract = new Map();
    for (const definition of definitions) {
      if (!definition || typeof definition !== 'object') {
        throw new Error('Invalid action definition');
      }
      const allowed = new Set([
        'name',
        'description',
        'input',
        'output',
        'effect',
        'timeoutMs',
        'maxResultBytes',
        'handler',
        'guard'
      ]);
      if (Object.keys(definition).some(key => !allowed.has(key))) {
        throw new Error('Unknown action definition field');
      }
      const { handler, guard, ...rawContract } = definition;
      if (typeof handler !== 'function' || (guard !== undefined && typeof guard !== 'function')) {
        throw new Error('Action handler and optional guard must be functions');
      }
      if (
        !ACTION_NAME.test(rawContract.name || '') ||
        typeof rawContract.description !== 'string' ||
        !rawContract.description.trim() ||
        rawContract.description.trim().length > 1000 ||
        !['read', 'write'].includes(rawContract.effect) ||
        !rawContract.input ||
        typeof rawContract.input !== 'object' ||
        Array.isArray(rawContract.input) ||
        !rawContract.output ||
        typeof rawContract.output !== 'object' ||
        Array.isArray(rawContract.output)
      ) {
        throw new Error('Invalid action contract');
      }
      positiveLimit(rawContract.timeoutMs, 600000, 'timeoutMs');
      positiveLimit(rawContract.maxResultBytes, 65536, 'maxResultBytes');
      const contract = {
        name: rawContract.name,
        description: rawContract.description.trim(),
        input: rawContract.input,
        output: rawContract.output,
        effect: rawContract.effect,
        ...(rawContract.timeoutMs === undefined ? {} : { timeoutMs: rawContract.timeoutMs }),
        ...(rawContract.maxResultBytes === undefined
          ? {}
          : { maxResultBytes: rawContract.maxResultBytes })
      };
      let validateInput;
      let validateOutput;
      try {
        validateInput = ajv.compile(contract.input);
        validateOutput = ajv.compile(contract.output);
      } catch {
        throw new Error(`Invalid JSON Schema for action ${contract.name}`);
      }
      const contractHash = actionContractHash(contract);
      const key = `${contract.name}:${contractHash}`;
      if (this.byContract.has(key)) throw new Error(`Duplicate action contract: ${contract.name}`);
      this.byContract.set(key, {
        contract,
        contractHash,
        handler,
        guard,
        validateInput,
        validateOutput
      });
    }
  }

  manifest() {
    return [...this.byContract.values()].map(({ contract, contractHash }) => ({
      name: contract.name,
      contractHash
    }));
  }

  get(name, contractHash) {
    return this.byContract.get(`${name}:${contractHash}`) || null;
  }
}

function defineAction(definition) {
  new ManagedActionRegistry([definition]);
  const { handler, guard, ...contract } = definition;
  const snapshot = JSON.parse(JSON.stringify(contract));
  const freeze = value => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  freeze(snapshot);
  return Object.freeze({ ...snapshot, handler, ...(guard ? { guard } : {}) });
}

module.exports = { ManagedActionRegistry, defineAction };

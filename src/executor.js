// Registers actions and runs the one a decision names.

class ConfirmationRequiredError extends Error {
  constructor(action) {
    super(`Action "${action}" requires explicit confirmation`);
    this.name = 'ConfirmationRequiredError';
    this.action = action;
  }
}

class ActionExecutor {
  constructor() {
    this.registry = new Map();
  }

  register(name, handler, metadata = {}) {
    if (typeof handler !== 'function') {
      throw new Error(`Handler for action "${name}" must be a function`);
    }

    if (this.registry.has(name)) {
      throw new Error(`Action ${name} already registered`);
    }

    this.registry.set(name, {
      name,
      handler,
      description: metadata.description || `Execute ${name}`,
      parameters: metadata.parameters || {},
      examples: metadata.examples || [],
      requiresConfirmation: metadata.requiresConfirmation || false,
      validate: metadata.validate || (() => true)
    });

    return this;
  }

  getAvailableActions() {
    const actions = [];

    for (const [name, config] of this.registry) {
      actions.push({
        action: name,
        description: config.description,
        parameters: config.parameters,
        examples: config.examples
      });
    }

    return actions;
  }

  async execute(decision, options = {}) {
    if (!decision || !decision.action) {
      throw new Error('Invalid decision: missing action');
    }

    const action = this.registry.get(decision.action);

    if (!action) {
      throw new Error(`Unknown action: ${decision.action}`);
    }

    // Validate parameters
    if (!(await action.validate(decision.parameters || {}))) {
      throw new Error(`Invalid parameters for action: ${decision.action}`);
    }

    // Confirmation must come from the caller, never from the model's decision.
    if (action.requiresConfirmation) {
      if (
        typeof options.confirm !== 'function' ||
        !(await options.confirm(decision.action, decision.parameters || {}))
      ) {
        throw new ConfirmationRequiredError(decision.action);
      }
    }

    try {
      // Execute the action
      const result = await action.handler(decision.parameters || {});

      return {
        success: true,
        action: decision.action,
        result
      };
    } catch (error) {
      return {
        success: false,
        action: decision.action,
        error: error.message
      };
    }
  }

  unregister(name) {
    return this.registry.delete(name);
  }

  clear() {
    this.registry.clear();
  }

  list() {
    const actions = [];
    for (const [name, config] of this.registry) {
      actions.push({
        name,
        description: config.description
      });
    }
    return actions;
  }
}

module.exports = { ActionExecutor, ConfirmationRequiredError };

const { ActionExecutor } = require('../executor');

describe('ActionExecutor', () => {
  let executor;

  beforeEach(() => {
    executor = new ActionExecutor();
  });

  describe('register', () => {
    test('should register action handler', () => {
      const handler = jest.fn();

      executor.register('testAction', handler, {
        description: 'Test action'
      });

      expect(executor.registry.has('testAction')).toBe(true);
      const registered = executor.registry.get('testAction');
      expect(registered.handler).toBe(handler);
      expect(registered.description).toBe('Test action');
    });

    test('should throw on duplicate registration', () => {
      executor.register('testAction', jest.fn());

      expect(() => {
        executor.register('testAction', jest.fn());
      }).toThrow('Action testAction already registered');
    });
  });

  describe('execute', () => {
    test('should execute registered action', async () => {
      const handler = jest.fn().mockResolvedValue({ success: true });
      executor.register('testAction', handler);

      const result = await executor.execute({
        action: 'testAction',
        parameters: { param1: 'value1' }
      });

      expect(handler).toHaveBeenCalledWith({ param1: 'value1' });
      expect(result.success).toBe(true);
    });

    test('should throw for unregistered action', async () => {
      await expect(executor.execute({ action: 'unknownAction' })).rejects.toThrow(
        'Unknown action: unknownAction'
      );
    });

    test('should handle action execution errors gracefully', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('Action failed'));
      executor.register('testAction', handler);

      const result = await executor.execute({ action: 'testAction' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Action failed');
    });

    test('should pass empty object when no parameters', async () => {
      const handler = jest.fn().mockResolvedValue({ success: true });
      executor.register('testAction', handler);

      await executor.execute({ action: 'testAction' });

      expect(handler).toHaveBeenCalledWith({});
    });
  });

  describe('list', () => {
    test('should list all registered actions', () => {
      executor.register('action1', jest.fn(), { description: 'First action' });
      executor.register('action2', jest.fn(), { description: 'Second action' });

      const actions = executor.list();

      expect(actions).toHaveLength(2);
      expect(actions[0]).toEqual({
        name: 'action1',
        description: 'First action'
      });
      expect(actions[1]).toEqual({
        name: 'action2',
        description: 'Second action'
      });
    });

    test('should return empty array when no actions', () => {
      const actions = executor.list();

      expect(actions).toEqual([]);
    });
  });

  describe('unregister', () => {
    test('should remove registered action', () => {
      executor.register('testAction', jest.fn());

      const result = executor.unregister('testAction');

      expect(result).toBe(true);
      expect(executor.registry.has('testAction')).toBe(false);
    });

    test('should return false for non-existent action', () => {
      const result = executor.unregister('unknownAction');

      expect(result).toBe(false);
    });
  });

  describe('clear', () => {
    test('should remove all actions', () => {
      executor.register('action1', jest.fn());
      executor.register('action2', jest.fn());

      executor.clear();

      expect(executor.registry.size).toBe(0);
    });
  });
});

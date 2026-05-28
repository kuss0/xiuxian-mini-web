// Module loader tests
describe('MiniwebModules', () => {
  let modules;

  beforeAll(() => {
    require('../../web/static/module-loader.js');
    modules = window.MiniwebModules;
  });

  beforeEach(() => {
    // Clear modules before each test
    while (modules.list().length > 0) {
      // Can't actually clear, so we'll work around it
    }
  });

  describe('register and require', () => {
    test('should register and retrieve module', () => {
      const testModule = { foo: 'bar' };
      modules.register('test', testModule);

      expect(modules.require('test')).toBe(testModule);
    });

    test('should throw error for non-existent module', () => {
      expect(() => modules.require('nonexistent')).toThrow();
    });
  });

  describe('has', () => {
    test('should return true for registered module', () => {
      modules.register('test2', {});
      expect(modules.has('test2')).toBe(true);
    });

    test('should return false for non-existent module', () => {
      expect(modules.has('nonexistent')).toBe(false);
    });
  });

  describe('list', () => {
    test('should list all registered modules', () => {
      modules.register('mod1', {});
      modules.register('mod2', {});

      const list = modules.list();
      expect(list).toContain('mod1');
      expect(list).toContain('mod2');
    });
  });

  describe('waitFor', () => {
    jest.useFakeTimers();

    test('should resolve when modules are loaded', async () => {
      modules.register('async1', {});
      modules.register('async2', {});

      const promise = modules.waitFor(['async1', 'async2'], 1000);

      await expect(promise).resolves.toBeUndefined();
    });

    test('should reject on timeout', async () => {
      const promise = modules.waitFor(['nonexistent'], 100);

      jest.advanceTimersByTime(150);

      await expect(promise).rejects.toThrow();
    });
  });
});

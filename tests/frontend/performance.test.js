// Performance utilities tests
describe('MiniwebPerformance', () => {
  let performance;

  beforeAll(() => {
    require('../../web/static/utils/performance.js');
    performance = window.MiniwebPerformance;
  });

  describe('debounce', () => {
    jest.useFakeTimers();

    test('should debounce function calls', () => {
      const fn = jest.fn();
      const debounced = performance.debounce(fn, 100);

      debounced();
      debounced();
      debounced();

      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('should pass arguments to debounced function', () => {
      const fn = jest.fn();
      const debounced = performance.debounce(fn, 100);

      debounced('arg1', 'arg2');

      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
    });
  });

  describe('throttle', () => {
    jest.useFakeTimers();

    test('should throttle function calls', () => {
      const fn = jest.fn();
      const throttled = performance.throttle(fn, 100);

      throttled();
      throttled();
      throttled();

      expect(fn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(100);
      throttled();

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('measurePerformance', () => {
    test('should measure function execution time', async () => {
      const fn = () => {
        let sum = 0;
        for (let i = 0; i < 1000; i++) {
          sum += i;
        }
        return sum;
      };

      const result = await performance.measurePerformance('test', fn);

      expect(result).toBeGreaterThan(0);
      expect(typeof result).toBe('number');
    });
  });
});

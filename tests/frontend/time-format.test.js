describe('Miniweb time formatting', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    require('../../web/static/ui/format.js');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('formats UTC ISO timestamps in Asia/Shanghai', () => {
    const fmt = window.MiniwebFormat;
    expect(fmt.DISPLAY_TIME_ZONE).toBe('Asia/Shanghai');
    expect(fmt.formatDisplayClockTime('2026-06-07T14:36:49+00:00')).toBe('22:36');
    expect(fmt.formatDisplayMonthDayTime('2026-06-07T14:36:49+00:00')).toBe('06-07 22:36');
    expect(fmt.formatDisplayDateTime('2026-06-07T14:36:49+00:00')).toBe('2026-06-07 22:36');
  });

  test('display day index uses Shanghai calendar days', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-07T14:00:00+00:00'));
    const fmt = window.MiniwebFormat;
    const today = fmt.displayDayIndex('2026-06-07T14:36:49+00:00');
    const yesterday = fmt.displayDayIndex('2026-06-06T15:30:00+00:00');
    expect(fmt.formatDisplayClockTime('2026-06-07T14:36:49+00:00')).toBe('22:36');
    expect(fmt.displayDayIndex(new Date())).toBe(today);
    expect(today - yesterday).toBe(1);
  });
});

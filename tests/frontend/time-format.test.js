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

  test('chat stream uses Shanghai clock and day labels', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-07T14:00:00+00:00'));
    require('../../web/static/views/chat_stream.js');
    const view = window.MiniwebViews.chatStream;
    expect(view.formatChatTime('2026-06-07T14:36:49+00:00')).toBe('22:36');
    expect(view.formatDayLabel('2026-06-07T14:36:49+00:00')).toBe('今天');
    expect(view.formatDayLabel('2026-06-06T15:30:00+00:00')).toBe('昨天');
  });
});

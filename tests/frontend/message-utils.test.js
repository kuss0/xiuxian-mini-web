// Message utilities tests
describe('MiniwebMessageUtils', () => {
  let messageUtils;

  beforeAll(() => {
    // Load the module
    require('../../web/static/utils/message-utils.js');
    messageUtils = window.MiniwebMessageUtils;
  });

  describe('messageTimeValue', () => {
    test('should return timestamp for valid date', () => {
      const message = { time: '2026-05-28T10:00:00Z' };
      const timestamp = messageUtils.messageTimeValue(message);
      expect(timestamp).toBeGreaterThan(0);
      expect(typeof timestamp).toBe('number');
    });

    test('should return 0 for invalid date', () => {
      const message = { time: 'invalid' };
      expect(messageUtils.messageTimeValue(message)).toBe(0);
    });

    test('should return 0 for missing time', () => {
      const message = {};
      expect(messageUtils.messageTimeValue(message)).toBe(0);
    });
  });

  describe('numericMessageField', () => {
    test('should return numeric value', () => {
      const message = { msg_id: 123 };
      expect(messageUtils.numericMessageField(message, 'msg_id')).toBe(123);
    });

    test('should return 0 for non-numeric value', () => {
      const message = { msg_id: 'abc' };
      expect(messageUtils.numericMessageField(message, 'msg_id')).toBe(0);
    });

    test('should return 0 for missing field', () => {
      const message = {};
      expect(messageUtils.numericMessageField(message, 'msg_id')).toBe(0);
    });
  });

  describe('compareMessagesByRecency', () => {
    test('should sort by time descending', () => {
      const a = { time: '2026-05-28T10:00:00Z', msg_id: 1 };
      const b = { time: '2026-05-28T11:00:00Z', msg_id: 2 };
      expect(messageUtils.compareMessagesByRecency(a, b)).toBeGreaterThan(0);
      expect(messageUtils.compareMessagesByRecency(b, a)).toBeLessThan(0);
    });

    test('should sort by msg_id if time is same', () => {
      const a = { time: '2026-05-28T10:00:00Z', msg_id: 1 };
      const b = { time: '2026-05-28T10:00:00Z', msg_id: 2 };
      expect(messageUtils.compareMessagesByRecency(a, b)).toBeGreaterThan(0);
    });
  });

  describe('sortMessagesByRecency', () => {
    test('should sort messages by recency', () => {
      const messages = [
        { id: 1, time: '2026-05-28T10:00:00Z' },
        { id: 2, time: '2026-05-28T12:00:00Z' },
        { id: 3, time: '2026-05-28T11:00:00Z' },
      ];
      const sorted = messageUtils.sortMessagesByRecency(messages);
      expect(sorted[0].id).toBe(2);
      expect(sorted[1].id).toBe(3);
      expect(sorted[2].id).toBe(1);
    });

    test('should handle empty array', () => {
      expect(messageUtils.sortMessagesByRecency([])).toEqual([]);
    });
  });

  describe('mergeMessagesById', () => {
    test('should merge and deduplicate messages', () => {
      const existing = [
        { id: 1, time: '2026-05-28T10:00:00Z', text: 'old' },
        { id: 2, time: '2026-05-28T11:00:00Z', text: 'keep' },
      ];
      const incoming = [
        { id: 1, time: '2026-05-28T10:00:00Z', text: 'new' },
        { id: 3, time: '2026-05-28T12:00:00Z', text: 'add' },
      ];
      const merged = messageUtils.mergeMessagesById(existing, incoming);

      expect(merged).toHaveLength(3);
      expect(merged.find(m => m.id === 1).text).toBe('new');
      expect(merged.find(m => m.id === 2).text).toBe('keep');
      expect(merged.find(m => m.id === 3).text).toBe('add');
    });

    test('should handle empty arrays', () => {
      expect(messageUtils.mergeMessagesById([], [])).toEqual([]);
    });
  });
});

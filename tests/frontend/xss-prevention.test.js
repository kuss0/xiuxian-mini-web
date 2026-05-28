// XSS 防护测试
// 测试 escapeHtml 和 safe-dom 工具

describe('XSS Prevention', () => {
  describe('escapeHtml', () => {
    const { escapeHtml } = window.MiniwebFormat || {};

    test('should escape HTML entities', () => {
      expect(escapeHtml('<script>alert("XSS")</script>'))
        .toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    test('should escape single quotes', () => {
      expect(escapeHtml("It's a test"))
        .toBe('It&#x27;s a test');
    });

    test('should escape ampersands', () => {
      expect(escapeHtml('Tom & Jerry'))
        .toBe('Tom &amp; Jerry');
    });

    test('should handle empty string', () => {
      expect(escapeHtml('')).toBe('');
    });

    test('should handle null/undefined', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });

    test('should escape multiple entities', () => {
      expect(escapeHtml('<div class="test">Hello & "World"</div>'))
        .toBe('&lt;div class=&quot;test&quot;&gt;Hello &amp; &quot;World&quot;&lt;/div&gt;');
    });
  });

  describe('Safe DOM utilities', () => {
    const { setText, setHtml, setTrustedHtml } = window.MiniwebSafeDom || {};
    let container;

    beforeEach(() => {
      container = document.createElement('div');
    });

    test('setText should set text content safely', () => {
      setText(container, '<script>alert("XSS")</script>');
      expect(container.textContent).toBe('<script>alert("XSS")</script>');
      expect(container.innerHTML).toBe('&lt;script&gt;alert("XSS")&lt;/script&gt;');
    });

    test('setHtml should escape HTML', () => {
      setHtml(container, '<script>alert("XSS")</script>');
      expect(container.innerHTML).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    test('setTrustedHtml should not escape', () => {
      setTrustedHtml(container, '<strong>Bold</strong>');
      expect(container.innerHTML).toBe('<strong>Bold</strong>');
    });

    test('setText should handle null', () => {
      setText(container, null);
      expect(container.textContent).toBe('');
    });
  });

  describe('Real-world XSS scenarios', () => {
    test('should prevent XSS in message title', () => {
      const maliciousTitle = '<img src=x onerror=alert("XSS")>';
      const escaped = escapeHtml(maliciousTitle);
      expect(escaped).not.toContain('<img');
      expect(escaped).toContain('&lt;img');
    });

    test('should prevent XSS in user input', () => {
      const maliciousInput = '"><script>alert(document.cookie)</script>';
      const escaped = escapeHtml(maliciousInput);
      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;script&gt;');
    });

    test('should prevent XSS in error messages', () => {
      const maliciousError = 'Error: <iframe src="evil.com"></iframe>';
      const escaped = escapeHtml(maliciousError);
      expect(escaped).not.toContain('<iframe');
      expect(escaped).toContain('&lt;iframe');
    });
  });
});

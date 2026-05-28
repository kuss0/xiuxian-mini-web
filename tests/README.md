# 前端测试

本项目包含完整的前端测试套件，包括单元测试和 E2E 测试。

## 测试框架

- **Jest**: 单元测试
- **Playwright**: E2E 测试
- **Testing Library**: DOM 测试工具

## 安装依赖

```bash
# 安装 Node.js 依赖
npm install

# 安装 Playwright 浏览器
npx playwright install
```

## 运行测试

### 单元测试

```bash
# 运行所有单元测试
npm test

# 监听模式（开发时使用）
npm run test:watch

# 生成覆盖率报告
npm run test:coverage
```

### E2E 测试

```bash
# 运行所有 E2E 测试
npm run test:e2e

# 使用 UI 模式运行
npm run test:e2e:ui
```

## 测试文件

### 单元测试

- `tests/frontend/xss-prevention.test.js` - XSS 防护测试
- `tests/frontend/performance.test.js` - 性能工具测试
- `tests/frontend/message-utils.test.js` - 消息工具测试
- `tests/frontend/module-loader.test.js` - 模块加载器测试

### E2E 测试

- `tests/e2e/app.spec.js` - 应用端到端测试

## 测试覆盖率

目标覆盖率：
- 语句覆盖率: 70%
- 分支覆盖率: 60%
- 函数覆盖率: 70%
- 行覆盖率: 70%

## 持续集成

测试可以在 CI/CD 流水线中运行：

```bash
# CI 环境
CI=true npm test
CI=true npm run test:e2e
```

## 编写新测试

### 单元测试示例

```javascript
describe('MyModule', () => {
  test('should do something', () => {
    expect(myFunction()).toBe(expected);
  });
});
```

### E2E 测试示例

```javascript
test('should load page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
});
```

## 调试测试

```bash
# Jest 调试
node --inspect-brk node_modules/.bin/jest --runInBand

# Playwright 调试
npx playwright test --debug
```

## 注意事项

1. 运行 E2E 测试前确保服务已启动
2. 单元测试使用 jsdom 环境模拟浏览器
3. E2E 测试会自动启动服务器
4. 测试覆盖率报告在 `coverage/` 目录

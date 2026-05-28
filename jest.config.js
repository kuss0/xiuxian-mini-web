module.exports = {
  testEnvironment: 'jsdom',
  testMatch: [
    '**/tests/frontend/**/*.test.js'
  ],
  collectCoverageFrom: [
    'web/static/**/*.js',
    '!web/static/app.js',
    '!web/static/views/**/*.js',
    '!web/static/performance-patch.js'
  ],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 60,
      functions: 70,
      lines: 70
    }
  },
  setupFilesAfterEnv: ['<rootDir>/tests/frontend/setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/web/static/$1'
  }
};

'use strict';

module.exports = {
  testDir: './tests',
  testMatch: '**/*.spec.js',
  globalSetup: require.resolve('./tests/global-setup.js'),
  globalTeardown: require.resolve('./tests/global-teardown.js'),
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    headless: true,
  },
};

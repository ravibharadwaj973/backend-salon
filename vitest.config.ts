import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/salon_os_test',
      // Two different hosts on purpose: the app and the API are not the same
      // server, and a tracked link built on the wrong one asks the customer to
      // sign in to read their own invoice.
      PUBLIC_APP_URL: 'https://app.example.test',
      PUBLIC_API_URL: 'https://api.example.test',
      JWT_ACCESS_SECRET: 'test-access-secret-value',
      JWT_REFRESH_SECRET: 'test-refresh-secret-value',
    },
  },
});

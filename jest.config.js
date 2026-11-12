/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup.ts"],
  // Tipe diperiksa terpisah lewat `npm run typecheck`; di sini cukup transpile supaya test cepat.
  transform: { "^.+\\.ts$": ["ts-jest", { diagnostics: false }] },
  clearMocks: true,
};

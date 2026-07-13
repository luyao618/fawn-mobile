export default {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  testMatch: ["<rootDir>/tests/app/**/*.test.[tj]s?(x)"],
  clearMocks: true,
  moduleNameMapper: {
    "^@for-mobile/fault-controller$": "<rootDir>/src/testing/FaultController.production.ts",
  },
};

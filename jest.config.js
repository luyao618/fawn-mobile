export default {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  testMatch: ["<rootDir>/tests/app/**/*.test.[tj]s?(x)"],
  clearMocks: true,
};

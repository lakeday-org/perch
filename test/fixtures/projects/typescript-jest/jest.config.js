/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/types.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/src/generated/'],
  coverageReporters: ['lcov', 'text-summary'],
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: 'reports',
      outputName: 'junit.xml',
      addFileAttribute: 'true',
      ancestorSeparator: ' > ',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
    }],
  ],
};

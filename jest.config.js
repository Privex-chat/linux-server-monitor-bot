module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  moduleDirectories: ['node_modules', '<rootDir>'],
  // Set root to project root so relative requires work
  rootDir: '.',
  // Map test requires to src
  moduleNameMapper: {
    '^../utils/(.*)$': '<rootDir>/src/utils/$1',
    '^../../config$': '<rootDir>/config',
  },
};

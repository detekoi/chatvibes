# ChatVibes TTS Test Suite

Comprehensive test suite for the ChatVibes TTS bot, including unit tests, integration tests, and test utilities.

## Table of Contents

- [Setup](#setup)
- [Running Tests](#running-tests)
- [Test Structure](#test-structure)
- [Writing Tests](#writing-tests)
- [Test Coverage](#test-coverage)
- [CI/CD Integration](#cicd-integration)

## Setup

### Prerequisites

- Node.js >= 18.0.0
- Jest testing framework (already included in devDependencies)

### Installation

Tests are automatically available after running:

```bash
npm install
```

## Running Tests

### Run All Tests

```bash
npm test
```

### Run Specific Test File

```bash
npm test -- allowViewerPreferences.test.js
```

### Run Tests in Watch Mode

```bash
npm test -- --watch
```

### Run Tests with Coverage

```bash
npm test -- --coverage
```

### Run Integration Tests Only

```bash
npm test -- tests/integration/
```

### Run Unit Tests Only

```bash
npm test -- tests/unit/
```

## Test Structure

```
tests/
├── README.md                           # This file
├── setup.js                            # Global test setup
├── helpers/                            # Test utilities and helpers
│   ├── mockFirestore.js               # Firestore mocking utilities
│   └── testData.js                    # Test data fixtures
├── integration/                        # Integration tests
│   └── allowViewerPreferences.test.js # Tests for viewer preferences feature
└── unit/                              # Unit tests
    └── ttsState.test.js               # Tests for ttsState module
```

## Test Categories

### Integration Tests (`tests/integration/`)

Integration tests verify that multiple components work together correctly. They test:

- Feature workflows end-to-end
- Component interactions
- Data flow through the system

**Example: allowViewerPreferences.test.js**

Tests the complete viewer preferences feature including:
- Applying user-specific voice settings
- Falling back to channel defaults
- Respecting the allowViewerPreferences toggle
- Global vs. channel-specific preferences

### Unit Tests (`tests/unit/`)

Unit tests verify individual modules and functions in isolation. They test:

- Function behavior
- Edge cases
- Error handling
- State management

**Example: ttsState.test.js**

Tests the ttsState module including:
- Config retrieval and caching
- User preference management
- Firestore interactions

## Writing Tests

### Test File Naming

- Integration tests: `tests/integration/<feature>.test.js`
- Unit tests: `tests/unit/<module>.test.js`
- Test files must end with `.test.js` or `.spec.js`

### Basic Test Template

```javascript
import { jest } from '@jest/globals';
import { createMockFirestore } from '../helpers/mockFirestore.js';

describe('Feature Name', () => {
  let mockDb;
  let moduleToTest;

  beforeEach(async () => {
    jest.resetModules();
    mockDb = createMockFirestore();

    // Mock dependencies
    jest.unstable_mockModule('@google-cloud/firestore', () => ({
      Firestore: jest.fn(() => mockDb)
    }));

    // Import module after mocking
    moduleToTest = await import('../../src/path/to/module.js');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('specific functionality', () => {
    test('should do something specific', async () => {
      // Arrange
      const input = 'test data';

      // Act
      const result = await moduleToTest.someFunction(input);

      // Assert
      expect(result).toBe('expected output');
    });
  });
});
```

### Using Mock Firestore

The `mockFirestore.js` helper provides a complete mock of Firestore operations:

```javascript
import { createMockFirestore, FieldValue } from '../helpers/mockFirestore.js';

const mockDb = createMockFirestore();

// Set up test data
const channelDoc = mockDb.collection('ttsChannelConfigs').doc('testchannel');
await channelDoc.set({
  engineEnabled: true,
  voiceId: 'Friendly_Person'
});

// Read data
const snapshot = await channelDoc.get();
const data = snapshot.data();
```

### Using Test Data

Pre-defined test data fixtures are available in `testData.js`:

```javascript
import {
  TEST_CHANNEL,
  TEST_USER,
  mockChannelConfig,
  mockUserPreferences,
  mockChatMessage
} from '../helpers/testData.js';

// Use in your tests
await channelDoc.set(mockChannelConfig);
```

## Test Coverage

### Viewing Coverage Reports

After running tests with coverage, open the HTML report:

```bash
npm test -- --coverage
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
start coverage/index.html  # Windows
```

### Coverage Goals

- **Unit tests**: Aim for 80%+ coverage
- **Integration tests**: Focus on critical user flows
- **Overall**: Maintain 70%+ coverage

## Best Practices

### 1. Test Behavior, Not Implementation

✅ **Good**: Test what the function does
```javascript
test('should use channel default when viewer preferences disabled', async () => {
  const result = await enqueue(channel, message);
  expect(result.voiceId).toBe('Friendly_Person');
});
```

❌ **Bad**: Test internal implementation details
```javascript
test('should call getUserVoicePreference exactly once', async () => {
  await enqueue(channel, message);
  expect(getUserVoicePreference).toHaveBeenCalledTimes(1);
});
```

### 2. Use Descriptive Test Names

Test names should clearly describe what is being tested:

```javascript
// Good
test('should ignore user voice preferences when allowViewerPreferences is false', ...)

// Bad
test('test viewer prefs', ...)
```

### 3. Follow Arrange-Act-Assert Pattern

```javascript
test('example test', async () => {
  // Arrange: Set up test data
  const input = 'test';
  await setupMockData();

  // Act: Execute the function
  const result = await functionUnderTest(input);

  // Assert: Verify the result
  expect(result).toBe('expected');
});
```

### 4. Keep Tests Independent

Each test should be able to run in isolation:

```javascript
beforeEach(async () => {
  // Reset state before each test
  jest.resetModules();
  mockDb = createMockFirestore();
});
```

### 5. Test Edge Cases

Don't just test the happy path:

```javascript
describe('getUserPreferences', () => {
  test('should return preferences when they exist', ...);
  test('should return empty object when user not found', ...);
  test('should handle null values gracefully', ...);
  test('should handle malformed data', ...);
});
```

## Debugging Tests

### Run a Single Test

```bash
npm test -- --testNamePattern="should use channel default"
```

### Enable Verbose Output

```bash
npm test -- --verbose
```

### Debug with Node Inspector

```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

Then open `chrome://inspect` in Chrome.

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test -- --coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

## Adding New Tests

### For a New Feature

1. Create test data fixtures in `tests/helpers/testData.js`
2. Write integration test in `tests/integration/<feature>.test.js`
3. Write unit tests for new modules in `tests/unit/<module>.test.js`
4. Run tests and verify coverage
5. Update this README if needed

### For a Bug Fix

1. Write a failing test that reproduces the bug
2. Fix the bug
3. Verify the test now passes
4. Add regression test to prevent future issues

## Troubleshooting

### "Cannot find module" Errors

Make sure you're using ES modules syntax and `.js` extensions:

```javascript
// Correct
import { something } from './path/to/module.js';

// Incorrect
import { something } from './path/to/module';
```

### Mock Not Working

Ensure mocks are set up before importing the module:

```javascript
// Correct order
jest.unstable_mockModule('...', () => ({ ... }));
const module = await import('...');

// Incorrect order
const module = await import('...');
jest.unstable_mockModule('...', () => ({ ... }));
```

### Tests Timing Out

Increase timeout for slow tests:

```javascript
test('slow operation', async () => {
  // ...
}, 15000); // 15 second timeout
```

## Contributing

When contributing tests:

1. Follow the existing patterns and structure
2. Ensure all tests pass before committing
3. Maintain or improve code coverage
4. Add comments for complex test scenarios
5. Update documentation for new test utilities

## Resources

- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Jest ES Modules](https://jestjs.io/docs/ecmascript-modules)
- [Testing Best Practices](https://testingjavascript.com/)

## Support

For questions or issues with tests:

1. Check this README first
2. Review existing test files for examples
3. Open an issue on GitHub with the `testing` label
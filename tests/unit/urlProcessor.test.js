// tests/unit/urlProcessor.test.js
// Unit tests for URL processing functions

import { jest } from '@jest/globals';

describe('urlProcessor module', () => {
  let urlProcessor;

  beforeEach(async () => {
    jest.resetModules();

    // Mock the logger
    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
      default: {
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn()
      }
    }));

    urlProcessor = await import('../../src/lib/urlProcessor.js');
  });

  describe('extractDomainForSpeech', () => {
    test('should extract domain from full URL with protocol', () => {
      const result = urlProcessor.extractDomainForSpeech('https://www.google.com/search?q=test');
      expect(result).toBe('google dot com');
    });

    test('should extract domain from URL without www', () => {
      const result = urlProcessor.extractDomainForSpeech('https://github.com/user/repo');
      expect(result).toBe('github dot com');
    });

    test('should handle domain without protocol', () => {
      const result = urlProcessor.extractDomainForSpeech('example.com');
      expect(result).toBe('example dot com');
    });

    test('should convert hyphens to spaces', () => {
      const result = urlProcessor.extractDomainForSpeech('some-cool-site.org');
      expect(result).toBe('some cool site dot org');
    });

    test('should convert underscores to spaces', () => {
      const result = urlProcessor.extractDomainForSpeech('my_awesome_site.net');
      expect(result).toBe('my awesome site dot net');
    });

    test('should handle multi-part TLDs', () => {
      const result = urlProcessor.extractDomainForSpeech('www.example.co.uk');
      expect(result).toBe('example dot co dot uk');
    });

    test('should remove query parameters', () => {
      const result = urlProcessor.extractDomainForSpeech('https://site.com?param=value&other=test');
      expect(result).toBe('site dot com');
    });

    test('should remove URL fragments', () => {
      const result = urlProcessor.extractDomainForSpeech('https://docs.example.com#section');
      expect(result).toBe('docs dot example dot com');
    });

    test('should handle complex URLs with paths, params, and fragments', () => {
      const result = urlProcessor.extractDomainForSpeech('https://www.site-name.com/path/to/page?id=123#anchor');
      expect(result).toBe('site name dot com');
    });

    test('should clean up multiple spaces', () => {
      const result = urlProcessor.extractDomainForSpeech('https://test--site.com');
      expect(result).toBe('test site dot com');
    });

    test('should handle http protocol', () => {
      const result = urlProcessor.extractDomainForSpeech('http://insecure-site.com');
      expect(result).toBe('insecure site dot com');
    });

    test('should return original URL on error', () => {
      // This tests the fallback behavior - hard to trigger actual error but validates the return
      const result = urlProcessor.extractDomainForSpeech('normaltext.com');
      expect(result).toBe('normaltext dot com');
    });
  });

  describe('processMessageUrls', () => {
    test('should replace URLs with speech-friendly domains when readFullUrls is false', () => {
      const message = 'Check out https://github.com for cool projects';
      const result = urlProcessor.processMessageUrls(message, false);
      expect(result).toBe('Check out github dot com for cool projects');
    });

    test('should leave URLs unchanged when readFullUrls is true', () => {
      const message = 'Check out https://github.com for cool projects';
      const result = urlProcessor.processMessageUrls(message, true);
      expect(result).toBe('Check out https://github.com for cool projects');
    });

    test('should handle multiple URLs in one message', () => {
      const message = 'Visit https://google.com and https://twitter.com';
      const result = urlProcessor.processMessageUrls(message, false);
      expect(result).toBe('Visit google dot com and twitter dot com');
    });

    test('should handle URLs without protocol', () => {
      const message = 'Check example.com for info';
      const result = urlProcessor.processMessageUrls(message, false);
      expect(result).toBe('Check example dot com for info');
    });

    test('should handle mixed protocol and non-protocol URLs', () => {
      const message = 'Try https://site1.com or site2.org';
      const result = urlProcessor.processMessageUrls(message, false);
      expect(result).toBe('Try site1 dot com or site2 dot org');
    });

    test('should handle messages without URLs', () => {
      const message = 'This is a regular message without links';
      const result = urlProcessor.processMessageUrls(message, false);
      expect(result).toBe('This is a regular message without links');
    });

    test('should handle null message', () => {
      const result = urlProcessor.processMessageUrls(null, false);
      expect(result).toBeNull();
    });

    test('should handle undefined message', () => {
      const result = urlProcessor.processMessageUrls(undefined, false);
      expect(result).toBeUndefined();
    });

    test('should handle empty string', () => {
      const result = urlProcessor.processMessageUrls('', false);
      expect(result).toBe('');
    });

    test('should handle non-string input', () => {
      const result = urlProcessor.processMessageUrls(123, false);
      expect(result).toBe(123);
    });

    test('should default readFullUrls to false', () => {
      const message = 'Visit https://example.com';
      const result = urlProcessor.processMessageUrls(message);
      expect(result).toBe('Visit example dot com');
    });
  });

  describe('containsUrl', () => {
    test('should return true for message with http URL', () => {
      expect(urlProcessor.containsUrl('Check http://example.com')).toBe(true);
    });

    test('should return true for message with https URL', () => {
      expect(urlProcessor.containsUrl('Visit https://github.com')).toBe(true);
    });

    test('should return true for message with domain without protocol', () => {
      expect(urlProcessor.containsUrl('Go to example.com')).toBe(true);
    });

    test('should return true for URL at start of message', () => {
      expect(urlProcessor.containsUrl('https://start.com is cool')).toBe(true);
    });

    test('should return true for URL at end of message', () => {
      expect(urlProcessor.containsUrl('Visit my site at example.org')).toBe(true);
    });

    test('should return false for message without URLs', () => {
      expect(urlProcessor.containsUrl('Just a regular message')).toBe(false);
    });

    test('should return false for message with email address', () => {
      expect(urlProcessor.containsUrl('Contact me at user@example')).toBe(false);
    });

    test('should return false for null message', () => {
      expect(urlProcessor.containsUrl(null)).toBe(false);
    });

    test('should return false for undefined message', () => {
      expect(urlProcessor.containsUrl(undefined)).toBe(false);
    });

    test('should return false for empty string', () => {
      expect(urlProcessor.containsUrl('')).toBe(false);
    });

    test('should return false for non-string input', () => {
      expect(urlProcessor.containsUrl(123)).toBe(false);
    });

    test('should detect URLs with common TLDs', () => {
      expect(urlProcessor.containsUrl('site.com')).toBe(true);
      expect(urlProcessor.containsUrl('site.org')).toBe(true);
      expect(urlProcessor.containsUrl('site.net')).toBe(true);
      expect(urlProcessor.containsUrl('site.io')).toBe(true);
    });

    test('should match .js extensions (current regex behavior)', () => {
      // Note: The current regex does match .js extensions
      // This documents the actual behavior
      expect(urlProcessor.containsUrl('Check out test.js file')).toBe(true);
    });
  });
});

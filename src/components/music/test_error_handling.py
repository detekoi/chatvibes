#!/usr/bin/env python3
# test_error_handling.py - Quick test for the new error categorization
import sys
import json

# Test the error categorization function from the bridge
test_errors = [
    "Service is temporarily unavailable. Please try again later. (E004)",
    "Prompt was rejected because it contains artist names",
    "Rate limit exceeded for this API key",
    "Request timed out after 60 seconds",
    "Invalid API token provided",
    "Content violates safety policy",
    "Some unknown error occurred"
]

# Simulate the categorizeError function logic
def categorize_error(raw_error, error_type):
    error_lower = raw_error.lower()
    
    if 'service is temporarily unavailable' in error_lower or '(E004)' in raw_error:
        return {
            'type': 'service_unavailable',
            'userMessage': 'The music generation service is temporarily unavailable. Please try again in a few minutes.',
            'logMessage': f'Service unavailable error: {raw_error}'
        }
    
    if 'prompt was rejected' in error_lower and 'artist names' in error_lower:
        return {
            'type': 'artist_names_rejected',
            'userMessage': 'Prompt was rejected. Please do not include specific artist names in your prompt.',
            'logMessage': f'Prompt rejected for artist names: {raw_error}'
        }
    
    if 'rate limit' in error_lower or 'quota exceeded' in error_lower:
        return {
            'type': 'rate_limited',
            'userMessage': 'Rate limit exceeded. Please wait a moment before trying again.',
            'logMessage': f'Rate limit error: {raw_error}'
        }
    
    if 'timeout' in error_lower or 'timed out' in error_lower:
        return {
            'type': 'timeout',
            'userMessage': 'Music generation timed out. Please try again with a simpler prompt.',
            'logMessage': f'Timeout error: {raw_error}'
        }
    
    if 'invalid' in error_lower and 'token' in error_lower:
        return {
            'type': 'auth_error',
            'userMessage': 'Authentication error. Please contact the bot administrator.',
            'logMessage': f'Auth error: {raw_error}'
        }
    
    if 'content policy' in error_lower or 'safety' in error_lower:
        return {
            'type': 'content_policy',
            'userMessage': 'Your prompt was rejected for safety reasons. Please try a different prompt.',
            'logMessage': f'Content policy violation: {raw_error}'
        }
    
    return {
        'type': 'unknown_error',
        'userMessage': 'An unexpected error occurred. Please try again later.',
        'logMessage': f'Unknown error ({error_type}): {raw_error}'
    }

print("Testing error categorization:")
print("=" * 50)

for i, error in enumerate(test_errors, 1):
    result = categorize_error(error, "TestError")
    print(f"{i}. Input: {error}")
    print(f"   Type: {result['type']}")
    print(f"   User: {result['userMessage']}")
    print(f"   Log:  {result['logMessage']}")
    print()

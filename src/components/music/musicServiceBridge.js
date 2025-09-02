// src/components/music/musicServiceBridge.js
import { PythonShell } from 'python-shell';
import logger from '../../lib/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Error categorization and user-friendly messages
function categorizeError(rawError, errorType) {
    const errorLower = rawError.toLowerCase();
    
    // Check for specific error patterns
    if (errorLower.includes('service is temporarily unavailable') || rawError.includes('(E004)')) {
        return {
            type: 'service_unavailable',
            userMessage: 'The music generation service is temporarily unavailable. Please try again in a few minutes.',
            logMessage: `Service unavailable error: ${rawError}`
        };
    }
    
    if (errorLower.includes('prompt was rejected') && errorLower.includes('artist names')) {
        return {
            type: 'artist_names_rejected',
            userMessage: 'Prompt was rejected. Please do not include specific artist names in your prompt.',
            logMessage: `Prompt rejected for artist names: ${rawError}`
        };
    }
    
    if (errorLower.includes('rate limit') || errorLower.includes('quota exceeded')) {
        return {
            type: 'rate_limited',
            userMessage: 'Rate limit exceeded. Please wait a moment before trying again.',
            logMessage: `Rate limit error: ${rawError}`
        };
    }
    
    if (errorLower.includes('timeout') || errorLower.includes('timed out')) {
        return {
            type: 'timeout',
            userMessage: 'Music generation timed out. Please try again with a simpler prompt.',
            logMessage: `Timeout error: ${rawError}`
        };
    }
    
    if (errorLower.includes('invalid') && errorLower.includes('token')) {
        return {
            type: 'auth_error',
            userMessage: 'Authentication error. Please contact the bot administrator.',
            logMessage: `Auth error: ${rawError}`
        };
    }
    
    if (errorLower.includes('content policy') || errorLower.includes('safety')) {
        return {
            type: 'content_policy',
            userMessage: 'Your prompt was rejected for safety reasons. Please try a different prompt.',
            logMessage: `Content policy violation: ${rawError}`
        };
    }
    
    // Generic error
    return {
        type: 'unknown_error',
        userMessage: 'An unexpected error occurred. Please try again later.',
        logMessage: `Unknown error (${errorType}): ${rawError}`
    };
}

export async function generateMusic(prompt, options = {}) {
    const { negativePrompt, seed } = options;
    // Keep reasonable timeout - if generation happens in <45s, 60s should be plenty
    const PYTHON_TIMEOUT_MS = 60000; // 60 seconds

    const pythonArgs = {
        prompt,
        ...(negativePrompt && { negative_prompt: negativePrompt }),
        ...(seed && { seed })
    };

    return new Promise((resolve) => {
        const pythonScript = path.join(__dirname, 'musicService.py');
        
        let shell = null;
        let hasTimedOut = false;
        
        const timeoutId = setTimeout(() => {
            hasTimedOut = true;
            logger.error(`[MusicBridge] Python script execution timed out after ${PYTHON_TIMEOUT_MS / 1000}s for prompt: "${prompt.substring(0,50)}..."`);
            
            if (shell && shell.childProcess && !shell.childProcess.killed) {
                try {
                    shell.kill('SIGTERM'); 
                    logger.info('[MusicBridge] Sent SIGTERM to hanging Python script.');
                    
                    // Force kill after 5 seconds if still running
                    setTimeout(() => {
                        if (shell && shell.childProcess && !shell.childProcess.killed) {
                            try {
                                shell.kill('SIGKILL');
                                logger.warn('[MusicBridge] Force killed Python script with SIGKILL.');
                            } catch (killError) {
                                logger.error({ err: killError }, '[MusicBridge] Error attempting to force kill Python script.');
                            }
                        }
                    }, 5000);
                    
                } catch (killError) {
                    logger.error({ err: killError }, '[MusicBridge] Error attempting to kill Python script.');
                }
            }
            
            // Return categorized timeout error
            const errorInfo = categorizeError('Python script execution timed out for music generation.', 'TimeoutError');
            resolve({
                success: false,
                error: errorInfo.type,
                message: errorInfo.userMessage
            });
        }, PYTHON_TIMEOUT_MS);

        const shellOptions = {
            mode: 'json', 
            pythonPath: process.env.PYTHON_PATH || 'python3',
            args: [JSON.stringify(pythonArgs)],
            env: { 
                'REPLICATE_API_TOKEN': process.env.REPLICATE_API_TOKEN,
                'PATH': process.env.PATH 
            }
        };
        
        logger.debug({options: shellOptions, script: pythonScript }, '[MusicBridge] Running PythonShell with options.');

        shell = new PythonShell(pythonScript, shellOptions);
        
        let results = [];
        let hasResult = false;
        
        // Handle stdout (JSON results)
        shell.on('message', function (message) {
            logger.debug({ message, prompt: prompt.substring(0,50) }, '[MusicBridge] Received message from Python script');
            results.push(message);
            hasResult = true;
        });
        
        // Handle stderr (debug/progress messages)
        shell.on('stderr', function (data) {
            try {
                const debugInfo = JSON.parse(data.toString());
                logger.debug({ debugInfo, prompt: prompt.substring(0,50) }, '[MusicBridge] Python script debug info');
            } catch (e) {
                // Not JSON, just log as string
                logger.debug({ stderr: data.toString(), prompt: prompt.substring(0,50) }, '[MusicBridge] Python script stderr');
            }
        });

        shell.end(function (err) {
            clearTimeout(timeoutId);
            
            // Don't process results if we already timed out
            if (hasTimedOut) {
                logger.debug('[MusicBridge] Script completed after timeout - ignoring results');
                return;
            }

            if (err) {
                logger.error({ err, prompt: prompt.substring(0,50) }, 'Python music service error from shell');
                
                // Categorize the shell error
                const errorInfo = categorizeError(err.message, 'ShellError');
                logger.error(errorInfo.logMessage);
                
                resolve({
                    success: false,
                    error: errorInfo.type,
                    message: errorInfo.userMessage
                });
                return;
            }

            // Check if we got any results
            if (!hasResult || !results || results.length === 0) {
                logger.error({results, hasResult, prompt: prompt.substring(0,50)}, 'No results from Python music service script.');
                
                const errorInfo = categorizeError('No response from music service script.', 'NoResponseError');
                resolve({
                    success: false,
                    error: errorInfo.type,
                    message: errorInfo.userMessage
                });
                return;
            }

            try {
                // Get the last result (should be the final output)
                const result = results[results.length - 1]; 
                
                if (typeof result !== 'object' || result === null) {
                    logger.error({ parsedResult: result, type: typeof result, allResults: results, prompt: prompt.substring(0,50) }, 'Python service response was not a valid object after mode:json processing.');
                    
                    const errorInfo = categorizeError('Invalid response format from music service.', 'InvalidResponseError');
                    resolve({
                        success: false,
                        error: errorInfo.type,
                        message: errorInfo.userMessage
                    });
                    return;
                }
                
                // Check if Python script returned an error
                if (!result.success) {
                    const rawError = result.raw_error || 'Unknown error';
                    const errorType = result.error_type || 'UnknownError';
                    
                    // Categorize the error from Python
                    const errorInfo = categorizeError(rawError, errorType);
                    logger.error(`[MusicBridge] ${errorInfo.logMessage}`);
                    
                    resolve({
                        success: false,
                        error: errorInfo.type,
                        message: errorInfo.userMessage
                    });
                    return;
                }
                
                // Success case
                logger.debug({ result, totalResults: results.length, prompt: prompt.substring(0,50) }, 'Received successful result from Python music service');
                resolve(result);
                
            } catch (parseErr) {
                logger.error({ parseErr, results, prompt: prompt.substring(0,50) }, 'Failed to process/parse Python service response');
                
                const errorInfo = categorizeError('Invalid response from music service.', 'ParseError');
                resolve({
                    success: false,
                    error: errorInfo.type,
                    message: errorInfo.userMessage
                });
            }
        });
    });
}
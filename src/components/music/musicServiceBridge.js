// src/components/music/musicServiceBridge.js
import { PythonShell } from 'python-shell';
import logger from '../../lib/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generateMusic(prompt, options = {}) {
    const { negativePrompt, seed } = options;
    // Keep reasonable timeout - if generation happens in <45s, 90s should be plenty
    const PYTHON_TIMEOUT_MS = 90000; // 90 seconds

    const pythonArgs = {
        prompt,
        ...(negativePrompt && { negative_prompt: negativePrompt }),
        ...(seed && { seed })
    };

    return new Promise((resolve, reject) => {
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
            reject(new Error(`Python script execution timed out for music generation.`));
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
                reject(new Error(`Music service error: ${err.message}`));
                return;
            }

            // Check if we got any results
            if (!hasResult || !results || results.length === 0) {
                logger.error({results, hasResult, prompt: prompt.substring(0,50)}, 'No results from Python music service script.');
                reject(new Error('No response from music service script.'));
                return;
            }

            try {
                // Get the last result (should be the final output)
                const result = results[results.length - 1]; 
                
                if (typeof result !== 'object' || result === null) {
                    logger.error({ parsedResult: result, type: typeof result, allResults: results, prompt: prompt.substring(0,50) }, 'Python service response was not a valid object after mode:json processing.');
                    reject(new Error('Invalid response format from music service (expected object).'));
                    return;
                }
                
                logger.debug({ result, totalResults: results.length, prompt: prompt.substring(0,50) }, 'Received result from Python music service');
                resolve(result);
                
            } catch (parseErr) {
                logger.error({ parseErr, results, prompt: prompt.substring(0,50) }, 'Failed to process/parse Python service response');
                reject(new Error('Invalid response from music service (unexpected error during processing).'));
            }
        });
    });
}
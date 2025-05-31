// src/components/music/musicServiceBridge.js
import { PythonShell } from 'python-shell';
import logger from '../../lib/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generateMusic(prompt, options = {}) {
    const { negativePrompt, seed } = options;
    // Let's increase the timeout slightly as a test, e.g., to 75 seconds
    const PYTHON_TIMEOUT_MS = 75000; // Increased from 45000

    const pythonArgs = {
        prompt,
        ...(negativePrompt && { negative_prompt: negativePrompt }),
        ...(seed && { seed })
    };

    return new Promise((resolve, reject) => {
        const pythonScript = path.join(__dirname, 'musicService.py');
        
        let shell = null;
        const timeoutId = setTimeout(() => {
            logger.error(`[MusicBridge] Python script execution timed out after ${PYTHON_TIMEOUT_MS / 1000}s for prompt: "${prompt.substring(0,50)}..."`);
            if (shell && shell.childProcess && !shell.childProcess.killed) {
                try {
                    shell.kill('SIGTERM'); 
                    logger.info('[MusicBridge] Sent SIGTERM to hanging Python script.');
                } catch (killError) {
                    logger.error({ err: killError }, '[MusicBridge] Error attempting to kill Python script.');
                }
            }
            reject(new Error(`Python script execution timed out for music generation.`));
        }, PYTHON_TIMEOUT_MS);

        const shellOptions = {
            mode: 'json', 
            pythonPath: process.env.PYTHON_PATH || 'python3', // Consider using python3 explicitly
            args: [JSON.stringify(pythonArgs)],
            env: { 
                'REPLICATE_API_TOKEN': process.env.REPLICATE_API_TOKEN,
                'PATH': process.env.PATH 
            }
        };
        
        logger.debug({options: shellOptions, script: pythonScript }, '[MusicBridge] Running PythonShell with options.');

        shell = PythonShell.run(pythonScript, shellOptions, (err, results) => {
            clearTimeout(timeoutId); 

            if (err) {
                logger.error({ err, prompt: prompt.substring(0,50) }, 'Python music service error from shell');
                reject(new Error(`Music service error: ${err.message}`));
                return;
            }

            // Log raw results for inspection
            logger.debug({ rawResults: results, prompt: prompt.substring(0,50) }, 'Raw results from Python music service script.');

            if (!results || results.length === 0) {
                logger.error({results, prompt: prompt.substring(0,50)}, 'No results from Python music service script.');
                reject(new Error('No response from music service script.'));
                return;
            }

            try {
                // When mode is 'json', results should be an array of parsed JSON objects.
                // The Python script is designed to print a single JSON object.
                const result = results[0]; 
                if (typeof result !== 'object' || result === null) {
                    logger.error({ parsedResult: result, type: typeof result, prompt: prompt.substring(0,50) }, 'Python service response was not a valid object after mode:json processing.');
                    reject(new Error('Invalid response format from music service (expected object).'));
                    return;
                }
                logger.debug({ result, prompt: prompt.substring(0,50) }, 'Received result from Python music service');
                resolve(result);
            } catch (parseErr) { // This catch might be redundant if results[0] is already an object
                logger.error({ parseErr, results, prompt: prompt.substring(0,50) }, 'Failed to process/parse Python service response');
                reject(new Error('Invalid response from music service (unexpected error during processing).'));
            }
        });
    });
}
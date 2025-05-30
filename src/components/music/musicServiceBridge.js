// src/components/music/musicServiceBridge.js
import { PythonShell } from 'python-shell';
import logger from '../../lib/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function generateMusic(prompt, options = {}) {
    const { negativePrompt, seed } = options;
    const PYTHON_TIMEOUT_MS = 45000; // 45 seconds timeout for the python script

    const pythonArgs = {
        prompt,
        ...(negativePrompt && { negative_prompt: negativePrompt }),
        ...(seed && { seed })
    };

    return new Promise((resolve, reject) => {
        const pythonScript = path.join(__dirname, 'musicService.py');
        
        let shell = null; // To store the PythonShell instance for potential killing
        const timeoutId = setTimeout(() => {
            logger.error(`[MusicBridge] Python script execution timed out after ${PYTHON_TIMEOUT_MS / 1000}s for prompt: "${prompt.substring(0,50)}..."`);
            if (shell && shell.childProcess && !shell.childProcess.killed) {
                try {
                    shell.kill('SIGTERM'); // Attempt to kill the python process
                    logger.info('[MusicBridge] Sent SIGTERM to hanging Python script.');
                } catch (killError) {
                    logger.error({ err: killError }, '[MusicBridge] Error attempting to kill Python script.');
                }
            }
            reject(new Error(`Python script execution timed out for music generation.`));
        }, PYTHON_TIMEOUT_MS);

        const shellOptions = {
            mode: 'json', // Ensures stdout is treated as JSON lines
            pythonPath: process.env.PYTHON_PATH || 'python', // Or specify your python path
            args: [JSON.stringify(pythonArgs)],
            env: { // Pass only necessary environment variables
                'REPLICATE_API_TOKEN': process.env.REPLICATE_API_TOKEN,
                'PATH': process.env.PATH // Important for finding python and its dependencies if in a virtualenv
            }
        };
        
        logger.debug({options: shellOptions, script: pythonScript }, '[MusicBridge] Running PythonShell with options.');

        shell = PythonShell.run(pythonScript, shellOptions, (err, results) => {
            clearTimeout(timeoutId); // Important: clear the timeout once the script finishes or errors

            if (err) {
                logger.error({ err, prompt: prompt.substring(0,50) }, 'Python music service error');
                reject(new Error(`Music service error: ${err.message}`));
                return;
            }

            if (!results || results.length === 0) {
                logger.error({results, prompt: prompt.substring(0,50)}, 'No results from Python music service script.');
                reject(new Error('No response from music service script.'));
                return;
            }

            try {
                // PythonShell in 'json' mode should already parse JSON objects from stdout lines.
                // If results[0] is already an object, no need to JSON.parse(results[0]).
                // If it's a string that needs parsing, then JSON.parse(results[0]) is correct.
                // Assuming the python script prints a single JSON line.
                const result = (typeof results[0] === 'string') ? JSON.parse(results[0]) : results[0];
                logger.debug({ result, prompt: prompt.substring(0,50) }, 'Received result from Python music service');
                resolve(result);
            } catch (parseErr) {
                logger.error({ parseErr, results, prompt: prompt.substring(0,50) }, 'Failed to parse Python service response');
                reject(new Error('Invalid response from music service'));
            }
        });
    });
}

import fs from 'fs';

import { T302_SUPPORTED_VOICE_IDS } from '../src/components/tts/voiceMigration.js';

// Mock fetch for the script if not available (Node 18+ has it)
// We will use the fetchVoiceListFromSchema logic but adapted here to avoid imports if possible, 
// or just re-implement the fetch since it's simple.

const WAVESPEED_SCHEMA_URL = 'https://wavespeed.ai/center/default/api/v1/model_schema/minimax/speech-02-turbo';

async function getWavespeedVoices() {
    try {
        console.log('Fetching Wavespeed (02) schema...');
        const response = await fetch(WAVESPEED_SCHEMA_URL);
        if (!response.ok) throw new Error(`Failed to fetch schema: ${response.status}`);
        const data = await response.json();
        const voices = data?.data?.components?.schemas?.Input?.properties?.voice_id?.['x-enum'];
        if (!Array.isArray(voices)) throw new Error('Invalid schema format');
        return new Set(voices);
    } catch (error) {
        console.error('Error fetching Wavespeed voices:', error);
        process.exit(1);
    }
}

async function main() {
    const wavespeedVoices = await getWavespeedVoices(); // Set of 02 voices
    const t302Voices = new Set(T302_SUPPORTED_VOICE_IDS); // Set of 2.6 voices

    const both = [];
    const only02 = [];
    const only26 = [];

    // Check 02 voices
    for (const voice of wavespeedVoices) {
        if (t302Voices.has(voice)) {
            both.push(voice);
        } else {
            only02.push(voice);
        }
    }

    // Check 2.6 voices (to find ones not in 02)
    for (const voice of t302Voices) {
        if (!wavespeedVoices.has(voice)) {
            only26.push(voice);
        }
    }

    // Sort lists
    both.sort();
    only02.sort();
    only26.sort();

    const output = `# Voice Availability Report

## Summary
- **Total Unique Voices**: ${new Set([...wavespeedVoices, ...t302Voices]).size}
- **Available on Both (02 & 2.6)**: ${both.length}
- **Only on Wavespeed (02)**: ${only02.length}
- **Only on 302.ai (2.6)**: ${only26.length}

## Voices on Both Models (02 & 2.6)
${both.map(v => `- ${v}`).join('\n')}

## Voices Only on Wavespeed (speech-02-turbo)
${only02.map(v => `- ${v}`).join('\n')}

## Voices Only on 302.ai (speech-2.6-turbo)
${only26.map(v => `- ${v}`).join('\n')}
`;

    fs.writeFileSync('VOICE_AVAILABILITY.md', output);
    console.log('Report saved to VOICE_AVAILABILITY.md');
}

main();

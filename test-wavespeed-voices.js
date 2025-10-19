/**
 * Test script for Wavespeed voice fetching
 * Run with: node test-wavespeed-voices.js
 */

import {
    getAllVoices,
    getVoicesByLanguage,
    fetchVoiceListFromSchema,
    compareWithSchema,
    WAVESPEED_VOICE_IDS
} from './src/components/tts/wavespeedVoices.js';

console.log('=== Wavespeed Voice List Test ===\n');

console.log(`1. Hardcoded voice count: ${WAVESPEED_VOICE_IDS.length}`);
console.log(`   First 5 voices: ${WAVESPEED_VOICE_IDS.slice(0, 5).join(', ')}\n`);

const allVoices = getAllVoices();
console.log(`2. getAllVoices() returned ${allVoices.length} voices`);
console.log(`   Sample voice object:`, allVoices[0], '\n');

const voicesByLang = getVoicesByLanguage();
const languages = Object.keys(voicesByLang);
console.log(`3. getVoicesByLanguage() returned ${languages.length} languages`);
console.log(`   Languages: ${languages.slice(0, 10).join(', ')}...\n`);

console.log('4. Fetching voice list from Wavespeed schema API...');
try {
    const schemaVoices = await fetchVoiceListFromSchema();
    console.log(`   ✓ Successfully fetched ${schemaVoices.length} voices from schema`);
    console.log(`   First 5 from schema: ${schemaVoices.slice(0, 5).join(', ')}\n`);

    console.log('5. Comparing hardcoded list with schema...');
    const comparison = await compareWithSchema();
    console.log(`   Hardcoded: ${comparison.hardcodedCount} voices`);
    console.log(`   Schema:    ${comparison.schemaCount} voices`);
    console.log(`   Unchanged: ${comparison.unchanged} voices`);
    console.log(`   Added:     ${comparison.added.length} voices`);
    console.log(`   Removed:   ${comparison.removed.length} voices`);
    console.log(`   Needs update: ${comparison.needsUpdate ? 'YES' : 'NO'}\n`);

    if (comparison.needsUpdate) {
        if (comparison.added.length > 0) {
            console.log(`   New voices in schema:`);
            comparison.added.forEach(v => console.log(`     + ${v}`));
        }
        if (comparison.removed.length > 0) {
            console.log(`   Voices removed from schema:`);
            comparison.removed.forEach(v => console.log(`     - ${v}`));
        }
    }

    console.log('\n✅ All tests completed successfully!');
} catch (error) {
    console.error(`\n❌ Test failed:`, error.message);
    process.exit(1);
}

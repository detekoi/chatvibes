import { getSystemVoiceList } from './src/components/tts/ttsService.js';

(async () => {
  const voices = await getSystemVoiceList();
  console.log(voices.length, 'voices loaded');
  // Optionally, print a few voices:
  console.log(voices.slice(0, 5));
})();

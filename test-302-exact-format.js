// Test 302.ai API with exact format from docs
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const T302_API_KEY = process.env.T302_API_KEY;
const T302_ENDPOINT = 'https://api.302.ai/minimaxi/v1/t2a_v2';

if (!T302_API_KEY) {
  console.error('❌ T302_API_KEY is not set');
  process.exit(1);
}

console.log('Testing 302.ai API with exact format from docs...');
console.log('Endpoint:', T302_ENDPOINT);
console.log('API Key:', T302_API_KEY.substring(0, 15) + '...');
console.log('');

// Exact format from 302.ai documentation
const exactFormatRequest = {
  "model": "speech-2.6-turbo",
  "text": "Testing 302.ai API with exact documentation format",
  "stream": false,
  "voice_setting": {
    "voice_id": "English_PlayfulGirl",
    "speed": 1,
    "vol": 1,
    "pitch": 0,
    "emotion": "neutral"
  },
  "audio_setting": {
    "sample_rate": 32000,
    "bitrate": 128000,
    "format": "mp3",
    "channel": 1
  },
  "subtitle_enable": false
};

console.log('Request (exact format from docs):');
console.log(JSON.stringify(exactFormatRequest, null, 2));
console.log('');

async function testExactFormat() {
  const startTime = Date.now();
  try {
    console.log('Sending request...');

    const response = await axios({
      method: 'POST',
      url: T302_ENDPOINT,
      headers: {
        'Authorization': `Bearer ${T302_API_KEY}`,
        'Content-Type': 'application/json'
      },
      data: exactFormatRequest,
      timeout: 10000 // 10 second timeout for faster testing
    });

    const duration = Date.now() - startTime;
    console.log(`✅ Success! Request took ${duration}ms`);
    console.log('');
    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));

  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ Error after ${duration}ms`);
    console.log('');

    if (error.code === 'ECONNABORTED') {
      console.log('Request timed out after 10 seconds');
    } else if (error.response) {
      console.log('HTTP Status:', error.response.status);
      console.log('Response data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.log('No response received from server');
      console.log('Error code:', error.code);
      console.log('Error message:', error.message);
    } else {
      console.log('Error:', error.message);
    }

    process.exit(1);
  }
}

testExactFormat();

// Test script for 302.ai API
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const T302_API_KEY = process.env.T302_API_KEY;
const T302_ENDPOINT = process.env.T302_API_ENDPOINT || 'https://api.302.ai/minimaxi/v1/t2a_v2';

if (!T302_API_KEY) {
  console.error('❌ T302_API_KEY is not set in .env file');
  process.exit(1);
}

console.log('Testing 302.ai API...');
console.log('Endpoint:', T302_ENDPOINT);
console.log('API Key:', T302_API_KEY.substring(0, 15) + '...');
console.log('');

const testRequest = {
  model: 'speech-2.6-turbo',
  text: 'Testing 302.ai API connection',
  stream: false,
  voice_setting: {
    voice_id: 'English_PlayfulGirl',
    speed: 1.0,
    vol: 1.0,
    pitch: 0,
    emotion: 'neutral',
    text_normalization: false,
  },
  audio_setting: {
    sample_rate: 32000,
    bitrate: 128000,
    format: 'mp3',
    channel: 1,
  },
  language_boost: 'auto',
  output_format: 'url'
};

console.log('Request payload:', JSON.stringify(testRequest, null, 2));
console.log('');

const T302_TIMEOUT_MS = 30000;

async function testAPI() {
  const startTime = Date.now();
  try {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timed out after 30 seconds')), T302_TIMEOUT_MS);
    });

    console.log('Sending request...');

    const response = await Promise.race([
      axios({
        method: 'POST',
        url: T302_ENDPOINT,
        headers: {
          'Authorization': `Bearer ${T302_API_KEY}`,
          'Content-Type': 'application/json'
        },
        data: testRequest,
        timeout: T302_TIMEOUT_MS
      }),
      timeoutPromise
    ]);

    const duration = Date.now() - startTime;
    console.log(`✅ Success! Request took ${duration}ms`);
    console.log('');
    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));

    // Check for audio URL
    if (response.data?.data?.url) {
      console.log('');
      console.log('✅ Audio URL received:', response.data.data.url);
    } else if (response.data?.url) {
      console.log('');
      console.log('✅ Audio URL received:', response.data.url);
    } else {
      console.log('');
      console.log('⚠️ Unexpected response format - no audio URL found');
    }

  } catch (error) {
    const duration = Date.now() - startTime;
    console.log(`❌ Error after ${duration}ms`);
    console.log('');

    if (error.response) {
      console.log('HTTP Status:', error.response.status);
      console.log('Response headers:', error.response.headers);
      console.log('Response data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.log('No response received from server');
      console.log('Error message:', error.message);
      console.log('Error code:', error.code);
    } else {
      console.log('Error:', error.message);
    }

    process.exit(1);
  }
}

testAPI();

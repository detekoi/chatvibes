import { jest } from '@jest/globals';

// Mock axios before importing modules that use it
jest.unstable_mockModule('axios', () => ({
    default: jest.fn()
}));

// Dynamic imports to ensure mock is applied
const { default: axios } = await import('axios');
const { getProviderForVoice } = await import('../src/components/tts/voiceMigration.js');
const { generateSpeech } = await import('../src/components/tts/ttsService.js');

describe('TTS Migration', () => {
    describe('getProviderForVoice', () => {
        it('should return 302 for supported voices', () => {
            expect(getProviderForVoice('English_expressive_narrator')).toBe('302');
            expect(getProviderForVoice('Chinese (Mandarin)_Reliable_Executive')).toBe('302');
        });

        it('should return wavespeed for unsupported voices', () => {
            expect(getProviderForVoice('Wise_Woman')).toBe('wavespeed'); // Legacy voice
            expect(getProviderForVoice('Unknown_Voice')).toBe('wavespeed');
        });
    });

    describe('generateSpeech', () => {
        beforeEach(() => {
            jest.clearAllMocks();
            // Mock config
            process.env.WAVESPEED_API_KEY = 'test-wavespeed-key';
            process.env['302_KEY'] = 'test-302-key';
        });

        it('should call 302.ai endpoint for supported voice', async () => {
            axios.mockResolvedValue({
                data: {
                    data: {
                        url: 'https://302.ai/audio.mp3'
                    }
                }
            });

            const url = await generateSpeech('Hello', 'English_expressive_narrator');

            expect(url).toBe('https://302.ai/audio.mp3');
            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining('302.ai'),
                data: expect.objectContaining({
                    model: 'speech-2.6-turbo',
                    voice_setting: expect.objectContaining({
                        voice_id: 'English_expressive_narrator'
                    })
                })
            }));
        });

        it('should call Wavespeed endpoint for legacy voice', async () => {
            axios.mockResolvedValue({
                data: {
                    data: {
                        outputs: ['https://wavespeed.ai/audio.mp3'],
                        status: 'completed'
                    }
                }
            });

            const url = await generateSpeech('Hello', 'Wise_Woman');

            expect(url).toBe('https://wavespeed.ai/audio.mp3');
            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining('wavespeed.ai'),
                data: expect.objectContaining({
                    voice_id: 'Wise_Woman'
                })
            }));
        });
    });
});

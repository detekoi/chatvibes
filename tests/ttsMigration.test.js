import { jest } from '@jest/globals';

// Mock axios before importing modules that use it
jest.unstable_mockModule('axios', () => ({
    default: jest.fn()
}));

// Dynamic imports to ensure mock is applied
const { default: axios } = await import('axios');
const { getProviderForVoice } = await import('../src/components/tts/voiceMigration.js');
const { generateSpeech } = await import('../src/components/tts/ttsService.js');

// A minimal but real MP3 head: ID3 tag followed by a frame sync, hex-encoded the way
// MiniMax returns it under output_format 'hex'. The payload lives in data.audio for
// both output formats — there is no data.url field on this API.
const MP3_BYTES = [0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0xfb, 0x90, 0x00];
const MP3_HEX = Buffer.from(MP3_BYTES).toString('hex');
const hex302Response = (hex = MP3_HEX) => ({
    data: {
        data: { audio: hex, status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' }
    }
});
const expectedBuffer = { kind: 'buffer', data: Buffer.from(MP3_BYTES), mime: 'audio/mpeg' };

describe('TTS Migration', () => {
    describe('getProviderForVoice', () => {
        it('should return 302 for supported voices', () => {
            expect(getProviderForVoice('English_expressive_narrator')).toBe('302');
            expect(getProviderForVoice('Cantonese_ProfessionalHost (F)')).toBe('302');
            expect(getProviderForVoice('Cantonese_ProfessionalHost（F)')).toBe('302'); // Full-width parenthesis
            expect(getProviderForVoice('Chinese (Mandarin)_Reliable_Executive')).toBe('302');
        });

        it('should return 302 for all voices including previously wavespeed-only', () => {
            expect(getProviderForVoice('Wise_Woman')).toBe('302'); // Previously wavespeed-only
            expect(getProviderForVoice('Young_Knight')).toBe('302'); // Previously wavespeed-only
            expect(getProviderForVoice('Unknown_Voice')).toBe('302'); // All voices default to 302
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
            axios.mockResolvedValue(hex302Response());

            const audio = await generateSpeech('Hello', 'English_expressive_narrator');

            expect(audio).toEqual(expectedBuffer);
            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining('302.ai'),
                data: expect.objectContaining({
                    model: 'speech-2.8-turbo',
                    voice_setting: expect.objectContaining({
                        voice_id: 'English_expressive_narrator'
                    })
                })
            }));
        });

        it('should request hex output so the audio arrives inline', async () => {
            axios.mockResolvedValue(hex302Response());

            await generateSpeech('Hello', 'English_expressive_narrator');

            expect(axios.mock.calls[0][0].data.output_format).toBe('hex');
        });

        it('should return a URL when the caller asks for one', async () => {
            // A channel with an outdated browser source cannot take inline bytes, so
            // the same data.audio field carries a link instead. Nothing in the shape
            // distinguishes the two — only the output_format we asked for does.
            axios.mockResolvedValue({
                data: {
                    data: { audio: 'https://302.ai/audio-alt.mp3', status: 2 },
                    base_resp: { status_code: 0, status_msg: 'success' }
                }
            });

            const audio = await generateSpeech('Hello', 'English_expressive_narrator', { preferUrlOutput: true });

            expect(audio).toEqual({ kind: 'url', url: 'https://302.ai/audio-alt.mp3' });
            expect(axios.mock.calls[0][0].data.output_format).toBe('url');
        });

        it('should scale the request timeout with the text length', async () => {
            axios.mockResolvedValue(hex302Response());

            await generateSpeech('Hi', 'English_expressive_narrator');
            const shortTimeout = axios.mock.calls[0][0].timeout;

            jest.clearAllMocks();
            axios.mockResolvedValue(hex302Response());
            await generateSpeech('x'.repeat(500), 'English_expressive_narrator');
            const longTimeout = axios.mock.calls[0][0].timeout;

            // A max-length Twitch message measured up to 6241ms, so it must be allowed
            // more than the old flat 5000ms; a two-character one must be allowed less.
            expect(shortTimeout).toBeLessThan(5000);
            expect(longTimeout).toBeGreaterThan(6241);
            expect(longTimeout).toBeLessThanOrEqual(8000);
        });

        it('should treat a non-zero base_resp code as a failure and fall back', async () => {
            // MiniMax reports failures as HTTP 200 with a non-zero base_resp code,
            // so the body has to be inspected rather than trusting the status.
            axios
                .mockResolvedValueOnce({
                    data: {
                        base_resp: { status_code: 1002, status_msg: 'rate limit exceeded' }
                    }
                })
                .mockResolvedValueOnce({
                    data: { data: { status: 'completed', outputs: ['https://wavespeed.ai/fallback.mp3'] } }
                });

            const audio = await generateSpeech('Hello', 'English_expressive_narrator');

            expect(audio).toEqual({ kind: 'url', url: 'https://wavespeed.ai/fallback.mp3' });
            expect(axios).toHaveBeenCalledTimes(2);
        });

        it('should send text_normalization inside voice_setting when englishNormalization is on', async () => {
            axios.mockResolvedValue({
                ...hex302Response()
            });

            await generateSpeech('I paid $1,299', 'English_expressive_narrator', { englishNormalization: true });

            const payload = axios.mock.calls[0][0].data;
            expect(payload.voice_setting.text_normalization).toBe(true);
        });

        it('should call 302.ai endpoint for previously wavespeed-only voice', async () => {
            axios.mockResolvedValue(hex302Response());

            const audio = await generateSpeech('Hello', 'Wise_Woman');

            expect(audio).toEqual(expectedBuffer);
            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining('302.ai'),
                data: expect.objectContaining({
                    model: 'speech-2.8-turbo',
                    voice_setting: expect.objectContaining({
                        voice_id: 'Wise_Woman'
                    })
                })
            }));
        });

        it('should pass language boost through to 302.ai for all voices', async () => {
            axios.mockResolvedValue(hex302Response());

            // 'Bulgarian' is supported by 302.ai
            await generateSpeech('Hello', 'Wise_Woman', { languageBoost: 'Bulgarian' });

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining('302.ai'),
                data: expect.objectContaining({
                    language_boost: 'Bulgarian'
                })
            }));
        });

        it('should allow supported language boost for 302.ai', async () => {
            axios.mockResolvedValue(hex302Response());

            // 'Bulgarian' is supported by 302
            await generateSpeech('Hello', 'English_expressive_narrator', { languageBoost: 'Bulgarian' });

            expect(axios).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining('302.ai'),
                data: expect.objectContaining({
                    language_boost: 'Bulgarian'
                })
            }));
        });

        it('should fallback to Wavespeed if 302.ai fails', async () => {
            // First call (302.ai) fails
            axios.mockRejectedValueOnce(new Error('302.ai API request timed out'));

            // Second call (Wavespeed) succeeds
            axios.mockResolvedValueOnce({
                data: {
                    data: {
                        outputs: ['https://wavespeed.ai/audio-fallback.mp3'],
                        status: 'completed'
                    }
                }
            });

            const audio = await generateSpeech('Hello', 'English_expressive_narrator');

            expect(audio).toEqual({ kind: 'url', url: 'https://wavespeed.ai/audio-fallback.mp3' });
            expect(axios).toHaveBeenCalledTimes(2);
            // First call to 302
            expect(axios).toHaveBeenNthCalledWith(1, expect.objectContaining({
                url: expect.stringContaining('302.ai')
            }));
            // Second call to Wavespeed
            expect(axios).toHaveBeenNthCalledWith(2, expect.objectContaining({
                url: expect.stringContaining('wavespeed.ai')
            }));
        });

        it('should sanitize parameters when falling back to Wavespeed', async () => {
            // First call (302.ai) fails
            axios.mockRejectedValueOnce(new Error('302.ai API error'));

            // Second call (Wavespeed) succeeds
            axios.mockResolvedValueOnce({
                data: {
                    data: {
                        outputs: ['https://wavespeed.ai/fallback-sanitized.mp3'],
                        status: 'completed'
                    }
                }
            });

            // Use parameters supported by 302 but NOT Wavespeed
            const audio = await generateSpeech('Hello', 'English_expressive_narrator', {
                languageBoost: 'Bulgarian', // Unsupported by Wavespeed
                emotion: 'fluent'           // Unsupported by Wavespeed
            });

            expect(audio).toEqual({ kind: 'url', url: 'https://wavespeed.ai/fallback-sanitized.mp3' });

            // Verify Wavespeed call used sanitized parameters
            const wavespeedCallData = axios.mock.calls[1][0].data;
            expect(wavespeedCallData.language_boost).toBe('auto'); // Sanitized from 'Bulgarian'
            expect(wavespeedCallData.emotion).toBeUndefined();     // 'fluent' stripped for legacy provider
        });
    });
});

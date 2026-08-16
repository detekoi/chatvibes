import { jest } from '@jest/globals';

// Mock axios before importing modules that use it
jest.unstable_mockModule('axios', () => ({
    default: jest.fn()
}));

// Dynamic imports to ensure mock is applied
const { default: axios } = await import('axios');
const { getProviderForVoice } = await import('../src/components/tts/voiceMigration.js');
const { generateSpeech, _resetT302Circuit } = await import('../src/components/tts/ttsService.js');

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
            // Breaker state is module-level and would otherwise leak between cases.
            _resetT302Circuit();
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

        describe('request timeout', () => {
            const budgetFor = async text => {
                jest.clearAllMocks();
                axios.mockResolvedValue(hex302Response());
                await generateSpeech(text, 'English_expressive_narrator');
                return axios.mock.calls[0][0].timeout;
            };

            it('gives an interjection the budget of the sound it produces, not its 8 characters', async () => {
                // The regression that timed out 15% of live traffic. Measured against
                // the API, one interjection is ~1.0s of audio while a plain character
                // is ~0.064s — so counting "(groans)" as 8 characters under-budgets it
                // by more than an order of magnitude.
                const fiveTags = await budgetFor('(groans) (groans) (groans) (groans) (groans)');
                const samePlainLength = await budgetFor('x'.repeat(44));

                expect(fiveTags).toBeGreaterThan(samePlainLength);
                // The old formula gave this exact message 2896ms; it needs far more.
                expect(fiveTags).toBeGreaterThan(2896);
            });

            it('only counts tags the model actually renders as sound', async () => {
                // Arbitrary parenthetical text is spoken, not turned into a sound
                // effect, so it must not earn the per-interjection budget.
                const real = await budgetFor('(groans) (groans) (groans)');
                const notATag = await budgetFor('(wobbles) (wobbles) (wobbles)');

                expect(real).toBeGreaterThan(notATag);
            });

            it('scales with the audio a long message will produce', async () => {
                expect(await budgetFor('x'.repeat(500)))
                    .toBeGreaterThan(await budgetFor('x'.repeat(50)));
            });

            it('clears the slowest duration observed for each shape', async () => {
                // Under-shooting these fails healthy requests, which is the whole bug.
                expect(await budgetFor('(chuckle)')).toBeGreaterThan(2355);
                expect(await budgetFor(Array(12).fill('(groans)').join(' '))).toBeGreaterThan(3599);
                expect(await budgetFor('x'.repeat(400))).toBeGreaterThan(4082);
                expect(await budgetFor('x'.repeat(500))).toBeGreaterThan(6241);
            });

            it('stays within fixed bounds for degenerate input', async () => {
                expect(await budgetFor('')).toBeGreaterThanOrEqual(4500);
                expect(await budgetFor(Array(60).fill('(groans)').join(' '))).toBeLessThanOrEqual(8000);
            });
        });

        describe('302.ai circuit breaker', () => {
            // Without this, a provider outage means every message pays the full 8s
            // timeout before reaching the fallback it was always going to need.
            const wavespeedOk = { data: { data: { status: 'completed', outputs: ['https://wavespeed.ai/fb.mp3'] } } };
            const timeout = () => Object.assign(new Error('302.ai API request timed out'), { code: 'ECONNABORTED' });

            /** Drive n failing messages through, each falling back to Wavespeed. */
            async function failTimes(n) {
                for (let i = 0; i < n; i++) {
                    axios.mockReset();
                    axios.mockRejectedValueOnce(timeout()).mockResolvedValueOnce(wavespeedOk);
                    await generateSpeech(`msg ${i}`, 'English_expressive_narrator');
                }
            }

            it('keeps trying 302 while failures are below the threshold', async () => {
                await failTimes(2);

                axios.mockReset();
                axios.mockRejectedValueOnce(timeout()).mockResolvedValueOnce(wavespeedOk);
                await generateSpeech('next', 'English_expressive_narrator');

                expect(axios.mock.calls[0][0].url).toContain('302.ai');
            });

            it('skips 302 entirely once the failure threshold is reached', async () => {
                await failTimes(3);

                axios.mockReset();
                axios.mockResolvedValueOnce(wavespeedOk);
                const audio = await generateSpeech('after outage', 'English_expressive_narrator');

                // One call, straight to Wavespeed — no 8s of dead time on the way.
                expect(axios).toHaveBeenCalledTimes(1);
                expect(axios.mock.calls[0][0].url).toContain('wavespeed');
                expect(audio).toEqual({ kind: 'url', url: 'https://wavespeed.ai/fb.mp3' });
            });

            it('resets as soon as 302 answers again', async () => {
                await failTimes(2); // below threshold, breaker still closed

                axios.mockReset();
                axios.mockResolvedValueOnce(hex302Response());
                await generateSpeech('recovered', 'English_expressive_narrator');

                // A success clears the streak, so the next two failures must not trip it.
                await failTimes(2);
                axios.mockReset();
                axios.mockRejectedValueOnce(timeout()).mockResolvedValueOnce(wavespeedOk);
                await generateSpeech('still trying', 'English_expressive_narrator');

                expect(axios.mock.calls[0][0].url).toContain('302.ai');
            });

            it('does not count an aborted request against the breaker', async () => {
                // !tts stop aborts in-flight generation. That says nothing about
                // provider health, and letting it trip the breaker would push a
                // channel onto the slower provider for a minute after a few stops.
                for (let i = 0; i < 5; i++) {
                    axios.mockReset();
                    axios.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                    await expect(generateSpeech(`m${i}`, 'English_expressive_narrator')).rejects.toThrow();
                }

                axios.mockReset();
                axios.mockResolvedValueOnce(hex302Response());
                await generateSpeech('after aborts', 'English_expressive_narrator');

                expect(axios.mock.calls[0][0].url).toContain('302.ai');
            });
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

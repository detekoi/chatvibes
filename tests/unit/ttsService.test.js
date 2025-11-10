// tests/unit/ttsService.test.js
// Unit tests for TTS service API integration

import { jest } from '@jest/globals';

describe('ttsService module', () => {
  let ttsService;
  let mockAxios;
  let mockLogger;
  let mockConfig;
  let mockWavespeedVoices;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();

    // Mock axios
    mockAxios = jest.fn();
    mockAxios.get = jest.fn();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockConfig = {
      tts: {
        wavespeedApiKey: 'test_api_key',
        wavespeedEndpoint: 'https://api.wavespeed.ai/v1/generate',
        defaultVoiceId: 'Default_Voice',
        defaultEmotion: 'neutral',
        defaultLanguageBoost: 'auto'
      }
    };

    mockWavespeedVoices = {
      getAllVoices: jest.fn().mockReturnValue([
        { id: 'Voice_1', name: 'Voice 1', language: 'English', type: 'Pre-trained' },
        { id: 'Voice_2', name: 'Voice 2', language: 'Spanish', type: 'Pre-trained' }
      ]),
      getVoicesByLanguage: jest.fn().mockReturnValue({
        'English': [{ id: 'Voice_1', name: 'Voice 1' }],
        'Spanish': [{ id: 'Voice_2', name: 'Voice 2' }]
      })
    };

    // Mock modules
    jest.unstable_mockModule('axios', () => ({
      default: mockAxios
    }));

    jest.unstable_mockModule('../../src/lib/logger.js', () => ({
      default: mockLogger
    }));

    jest.unstable_mockModule('../../src/config/index.js', () => ({
      default: mockConfig
    }));

    jest.unstable_mockModule('../../src/components/tts/ttsConstants.js', () => ({
      TTS_SPEED_DEFAULT: 1.0,
      TTS_PITCH_DEFAULT: 0
    }));

    jest.unstable_mockModule('../../src/components/tts/wavespeedVoices.js', () => mockWavespeedVoices);

    ttsService = await import('../../src/components/tts/ttsService.js');
  });

  describe('generateSpeech', () => {
    test('should generate speech successfully with default options', async () => {
      const audioUrl = 'https://wavespeed.ai/audio/test123.mp3';

      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          id: 'test123',
          outputs: [audioUrl]
        }
      });

      const result = await ttsService.generateSpeech('Hello world', 'Test_Voice');

      expect(result).toBe(audioUrl);
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: mockConfig.tts.wavespeedEndpoint,
          headers: expect.objectContaining({
            'Authorization': 'Bearer test_api_key',
            'Content-Type': 'application/json'
          }),
          data: expect.objectContaining({
            text: 'Hello world',
            voice_id: 'Test_Voice'
          })
        })
      );
    });

    test('should use provided options for speech generation', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice', {
        speed: 1.5,
        pitch: 2,
        emotion: 'happy',
        volume: 0.8,
        languageBoost: 'English'
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            speed: 1.5,
            pitch: 2,
            emotion: 'happy',
            volume: 0.8,
            language_boost: 'English'
          })
        })
      );
    });

    test('should map "auto" emotion to "neutral"', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice', {
        emotion: 'auto'
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            emotion: 'neutral'
          })
        })
      );
    });

    test('should map "Automatic" language boost to "auto"', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice', {
        languageBoost: 'Automatic'
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            language_boost: 'auto'
          })
        })
      );
    });

    test('should map "None" language boost to "auto"', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice', {
        languageBoost: 'None'
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            language_boost: 'auto'
          })
        })
      );
    });

    test('should handle channel option correctly for mono', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice', {
        channel: 'mono'
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel: '1'
          })
        })
      );
    });

    test('should handle channel option correctly for stereo', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice', {
        channel: 'stereo'
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            channel: '2'
          })
        })
      );
    });

    test('should enable sync mode for lowest latency', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice');

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            enable_sync_mode: true
          })
        })
      );
    });

    test('should handle API response with data wrapper', async () => {
      mockAxios.mockResolvedValue({
        data: {
          data: {
            status: 'completed',
            outputs: ['https://audio.url']
          }
        }
      });

      const result = await ttsService.generateSpeech('Test', 'Voice');

      expect(result).toBe('https://audio.url');
    });

    test('should throw error when API returns failed status', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'failed',
          error: 'Voice not found'
        }
      });

      await expect(
        ttsService.generateSpeech('Test', 'Invalid_Voice')
      ).rejects.toThrow('TTS generation failed: Voice not found');
    });

    test('should provide specific error for voice access denied', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'failed',
          error: "you don't have access to this voice_id"
        }
      });

      await expect(
        ttsService.generateSpeech('Test', 'Premium_Voice')
      ).rejects.toThrow('Voice access denied');
    });

    test('should provide specific error for invalid voice ID', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'failed',
          error: 'Invalid voice_id specified'
        }
      });

      await expect(
        ttsService.generateSpeech('Test', 'Bad_Voice')
      ).rejects.toThrow('Invalid voice');
    });

    test('should throw error for unexpected response format', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'pending'
        }
      });

      await expect(
        ttsService.generateSpeech('Test', 'Voice')
      ).rejects.toThrow('unexpected response format');
    });

    test('should throw error when outputs are missing', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: []
        }
      });

      await expect(
        ttsService.generateSpeech('Test', 'Voice')
      ).rejects.toThrow('unexpected response format');
    });

    test('should handle network errors', async () => {
      mockAxios.mockRejectedValue(new Error('Network error'));

      await expect(
        ttsService.generateSpeech('Test', 'Voice')
      ).rejects.toThrow('Failed to generate speech');

      expect(mockLogger.error).toHaveBeenCalled();
    });

    test('should handle API errors with specific messages', async () => {
      mockAxios.mockRejectedValue({
        response: {
          data: {
            message: 'Rate limit exceeded'
          }
        }
      });

      await expect(
        ttsService.generateSpeech('Test', 'Voice')
      ).rejects.toThrow('TTS generation failed: Rate limit exceeded');
    });

    test('should handle voice access denied in error response', async () => {
      mockAxios.mockRejectedValue({
        response: {
          data: {
            message: "you don't have access to this voice_id Premium_Voice"
          }
        }
      });

      await expect(
        ttsService.generateSpeech('Test', 'Premium_Voice')
      ).rejects.toThrow('Voice access denied');
    });

    test('should support abort signal', async () => {
      const controller = new AbortController();

      mockAxios.mockImplementation(async (config) => {
        controller.abort();
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        throw error;
      });

      await expect(
        ttsService.generateSpeech('Test', 'Voice', {
          signal: controller.signal
        })
      ).rejects.toThrow('AbortError');
    });

    test('should handle abort during API call', async () => {
      const controller = new AbortController();

      mockAxios.mockImplementation(async (config) => {
        // Simulate abort during request
        setTimeout(() => controller.abort(), 10);
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              data: {
                status: 'completed',
                outputs: ['https://audio.url']
              }
            });
          }, 100);
        });
      });

      await expect(
        ttsService.generateSpeech('Test', 'Voice', {
          signal: controller.signal
        })
      ).rejects.toThrow();
    });

    test('should handle axios CanceledError', async () => {
      const error = new Error('Request canceled');
      error.name = 'CanceledError';
      mockAxios.mockRejectedValue(error);

      await expect(
        ttsService.generateSpeech('Test', 'Voice')
      ).rejects.toThrow('CanceledError');
    });

    test('should use default voice ID from config if not provided', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test');

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            voice_id: 'Default_Voice'
          })
        })
      );
    });

    test('should include english_normalization option', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice', {
        englishNormalization: true
      });

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            english_normalization: true
          })
        })
      );
    });

    test('should default english_normalization to false', async () => {
      mockAxios.mockResolvedValue({
        data: {
          status: 'completed',
          outputs: ['https://audio.url']
        }
      });

      await ttsService.generateSpeech('Test', 'Voice');

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            english_normalization: false
          })
        })
      );
    });
  });

  describe('getAvailableVoices', () => {
    test('should return hardcoded voice list on first call', async () => {
      const voices = await ttsService.getAvailableVoices();

      expect(voices).toHaveLength(2);
      expect(voices[0].id).toBe('Voice_1');
      expect(mockWavespeedVoices.getAllVoices).toHaveBeenCalled();
    });

    test('should return cached voice list on subsequent calls', async () => {
      await ttsService.getAvailableVoices();
      mockWavespeedVoices.getAllVoices.mockClear();

      await ttsService.getAvailableVoices();

      expect(mockWavespeedVoices.getAllVoices).not.toHaveBeenCalled();
    });

    test('should attempt to fetch from schema API with forceRefresh', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          input_schema: {
            properties: {
              voice_id: {
                'x-enum': ['Voice_1', 'Voice_2', 'Voice_3']
              }
            }
          }
        }
      });

      const voices = await ttsService.getAvailableVoices(true);

      expect(mockAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('model_schema'),
        expect.any(Object)
      );
    });

    test('should fallback to hardcoded list if schema fetch fails', async () => {
      mockAxios.get.mockRejectedValue(new Error('Network error'));

      const voices = await ttsService.getAvailableVoices(true);

      expect(voices).toHaveLength(2);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    test('should map schema voice IDs to voice objects', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          input_schema: {
            properties: {
              voice_id: {
                'x-enum': ['Voice_1']
              }
            }
          }
        }
      });

      const voices = await ttsService.getAvailableVoices(true);

      expect(voices[0]).toHaveProperty('id');
      expect(voices[0]).toHaveProperty('name');
      expect(voices[0]).toHaveProperty('language');
    });

    test('should create voice objects for unknown voices from schema', async () => {
      mockWavespeedVoices.getAllVoices.mockReturnValue([
        { id: 'Voice_1', name: 'Voice 1', language: 'English', type: 'Pre-trained' }
      ]);

      mockAxios.get.mockResolvedValue({
        data: {
          input_schema: {
            properties: {
              voice_id: {
                'x-enum': ['New_Voice']
              }
            }
          }
        }
      });

      const voices = await ttsService.getAvailableVoices(true);

      const newVoice = voices.find(v => v.id === 'New_Voice');
      expect(newVoice).toBeDefined();
      expect(newVoice.name).toBe('New Voice');
      expect(newVoice.language).toBe('Unknown');
    });

    test('should handle schema response missing voice_id field', async () => {
      mockAxios.get.mockResolvedValue({
        data: {
          input_schema: {
            properties: {}
          }
        }
      });

      await ttsService.getAvailableVoices(true);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('missing expected')
      );
    });
  });

  describe('getVoicesGroupedByLanguage', () => {
    test('should return voices grouped by language', () => {
      const grouped = ttsService.getVoicesGroupedByLanguage();

      expect(grouped).toHaveProperty('English');
      expect(grouped).toHaveProperty('Spanish');
      expect(grouped.English).toHaveLength(1);
      expect(grouped.Spanish).toHaveLength(1);
    });

    test('should delegate to wavespeedVoices module', () => {
      ttsService.getVoicesGroupedByLanguage();

      expect(mockWavespeedVoices.getVoicesByLanguage).toHaveBeenCalled();
    });
  });
});

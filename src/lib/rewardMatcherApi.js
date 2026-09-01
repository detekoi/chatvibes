// src/lib/rewardMatcherApi.js
// The model half of rewardResolver.js: ask Gemini which reward a moderator
// meant when the deterministic match came up empty or ambiguous.
//
// Shares the client the emote describer initialises, so this is a no-op (null)
// on a deployment without GEMINI_API_KEY and the command degrades to exact
// and partial matching. The prompt tells the model to abstain rather than
// guess, and the resolver additionally refuses any answer outside the pool it
// was given, so a hallucinated ID cannot mute anything.
import { withTimeout } from './timeUtils.js';
import { getGeminiClient } from './emotes/emoteDescriberApi.js';
import config from '../config/index.js';
import logger from './logger.js';

const TIMEOUT_MS = 6000;

const SYSTEM_INSTRUCTION = `A Twitch moderator typed the name of a channel point reward from memory, and you are given the channel's actual rewards. Decide which one they meant.

Be strict. Answer with a reward only when the request clearly refers to exactly one entry: a typo, a different word order, a common abbreviation, or a paraphrase of the title or its description. If the request could mean more than one reward, or none of them, set confident to false and rewardId to null. Never guess, and never pick a reward merely because it is the closest.`;

/**
 * @param {string} query What the moderator typed.
 * @param {Array<{ id: string, title: string, prompt?: string }>} rewards
 * @returns {Promise<{ rewardId: string|null, confident: boolean }|null>} null when unavailable or failed.
 */
export async function pickRewardWithGemini(query, rewards) {
    const genAI = getGeminiClient();
    if (!genAI || !rewards?.length) return null;

    const payload = {
        request: String(query || ''),
        rewards: rewards.map(r => ({ id: r.id, title: r.title, description: r.prompt || '' })),
    };

    try {
        const response = await withTimeout(
            genAI.models.generateContent({
                model: config.emote.geminiModel,
                systemInstruction: SYSTEM_INSTRUCTION,
                contents: [{ text: JSON.stringify(payload) }],
                config: {
                    temperature: 0,
                    responseMimeType: 'application/json',
                    responseJsonSchema: {
                        type: 'object',
                        properties: {
                            rewardId: { type: ['string', 'null'], description: 'The id of the one reward the request refers to, or null.' },
                            confident: { type: 'boolean', description: 'true only when exactly one reward clearly matches.' },
                        },
                        required: ['rewardId', 'confident'],
                    },
                },
            }),
            TIMEOUT_MS,
            'Gemini timeout',
        );
        const parsed = JSON.parse(response.text);
        const result = {
            rewardId: typeof parsed?.rewardId === 'string' ? parsed.rewardId : null,
            confident: parsed?.confident === true,
        };
        logger.debug({ query, result }, 'Gemini reward match');
        return result;
    } catch (error) {
        logger.info({ err: error.message, query }, 'Gemini reward match failed');
        return null;
    }
}

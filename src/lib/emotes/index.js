// src/lib/emotes/index.js
// Public API barrel for the emote description subsystem.
// All external consumers import from this file; the internal module
// structure can change without touching callers.

export { initGeminiClient, isGeminiAvailable, describeSingleEmote, describeBatchEmotes } from './emoteDescriberApi.js';

export {
    initEmoteDescriptionStore,
    getCachedDescription,
    cacheDescription,
    invalidateEmoteDescription,
    setEmoteDescription,
    getStoredEmoteDescription,
    findEmoteDescriptionsByName,
    _descriptionCache,
} from './emoteCache.js';

export { getEmoteImageUrl, getAnimatedEmoteUrl } from './emoteImageFetcher.js';

export { processMessageWithEmoteDescriptions, describeEmoteFragments, groupFragments, _ownerNameCache } from './emoteProcessor.js';

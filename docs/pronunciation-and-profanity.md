# Pronunciation and Profanity

- **Pronunciation entries can be scoped by language.** An entry may carry `only` or `except`
  (BCP-47 lists); with neither it applies everywhere, which is true of all but four built-ins,
  so there was no migration. Channel overrides accept the same shape — a bare string is the
  legacy form and means "everywhere", as with the ignore list. Scoping exists because these
  are English acronyms matched as **whole words**, and a few are ordinary words elsewhere:
  `ty` is "you" in Polish, Czech and Slovak, and `af` is "off" in Afrikaans and Dutch, where it
  also injects profanity into a normal sentence. Word boundaries cannot help — being a whole
  word is exactly the problem. They use `except` rather than `only: ["en"]` deliberately:
  Twitch acronyms travel, and a German channel's chat is still full of `gg` and `brb`, so
  scope by demonstrated collision rather than by origin. `scripts/audit-pronunciation-collisions.js`
  shortlists candidates for a human; see `docs/pronunciation-probe-results.md`.
  **Scope only entries whose local meaning differs.** The audit also surfaces tokens whose
  local reading means the *same* thing (`gm` as "Guten Morgen", `np` as "nema problema") —
  those are English loanwords in the local chat, the expansion is faithful, and scoping them
  would leave the bare acronym to be read out as letters. `np` is both at once: "na przykład"
  in Polish is a real collision, "nema problema" in Croatian is not, and only `pl` is scoped.
- **`getPronunciationRules` caches by locale as well as by source object**, and that is
  load-bearing. Channels with no overrides share one rule set, so a cache keyed on the
  `pronunciations` object alone would hand every such channel whichever language compiled
  first. `src/lib/profanity/index.js` keys its cache on the language combination for the same
  reason. The locale is derived inside the function from the config, so no call site can
  forget to pass it.
- **Pronunciation dictionary** (`src/lib/textRewrite/`): a built-in list of Twitch acronyms
  (`PRONUNCIATION_DEFAULTS` in `tts-config.json`) merged with per-channel overrides stored in the
  `pronunciations` map on the channel config. A channel entry with an empty value switches off the
  built-in of the same name; deleting the key restores it.
  - The list was first made from a probe of MiniMax (`docs/pronunciation-probe-results.md`).
    It was checked against Gemini on 2026-11-14 with the `slang` group of
    `scripts/probe-gemini-tts.js`. Without the dictionary, Gemini spells most acronyms as
    letters ("T B H", "N G L") and misreads some (`hmu` as "harm you", `smh` as "smash",
    `wb` as "Duby"). It expands only a few correctly (`idk`, `wdym`, `nvm`, `omg`, `wtf`).
    The dictionary is thus still necessary.
  - The laugh acronyms are not in the list: `lol`, `lmao`, `lmfao`, `rofl` and `roflmao`.
    Gemini turns them into a real laugh, which sounds better than the words.
  - **Pin an acronym if its expansion carries profanity, even when the model expands it
    correctly.** The profanity filter runs on the text that the bot sends. When the model does
    the expansion, the profane words exist only in the audio, after the filter. Gemini reads
    `wtf` in full. The expansion by the model also changes between renders, so do not rely
    on it.
  - Matching is case-insensitive and single-pass, so an expansion is never re-scanned by another
    rule. Word boundaries use `\p{L}\p{N}` lookarounds rather than `\b`, which is ASCII-only.
    **A change of script is a boundary too**: Kana and Kanji are `\p{L}`, so without that a
    Latin term never matched inside Japanese text — and since Japanese has no spaces, that is
    how the language is written, meaning a Japanese-scoped entry would have fired only when a
    viewer happened to add spaces around it. `それkwskで` now expands; `xkwsk` still does not.
  - **Rules run on the gaps between URLs; the URLs are copied through untouched.** They used
    to be swapped for a sentinel-wrapped index and the whole string rewritten in one pass,
    which put that index in band with the text being matched — a rule whose key was a digit
    (`!tts pronounce 1 = one` is accepted, since a match key may start with `\p{N}`) rewrote
    the index inside its own placeholder, and both the URL and the restore were lost, leaving
    private-use characters in the audio. Splitting has no in-band encoding to corrupt.
  - Gemini has no pronunciation parameter. The dictionary is the only control.
- **Sound tags** (`src/lib/textRewrite/soundTags.js`): Gemini turns a tag such as `<laugh>`
  or `<scream>` into the real sound. It also acts on the older `(laughs)` spelling. Viewers
  can type these tags, and every tag works by default. A channel can turn single tags off
  (`disabledSoundTags`, `!tts tags off <tag>`, or the dashboard). `ttsQueue.enqueue` removes
  a disabled tag in both spellings before the profanity filter runs. The tag list is
  `SOUND_TAGS` in `tts-config.json`.
- **Profanity filter** (`src/lib/profanity/`): off by default, per channel. Word lists for all 40
  `languageBoost` values are hand-authored in `profanityLists.json` and validated by
  `tests/unit/profanityLists.test.js`. Substitution, not bleeping — an empty replacement would let
  a message reduce to `""`, which every caller drops silently instead of speaking.
  - Applied in `ttsQueue.enqueue`, not `formatTtsText`, because a viewer can override
    `languageBoost` for their own messages and that is only resolved there. When the viewer's
    language differs from the channel's, both lists apply.
  - **English is always in the active rule set**, whatever the channel language. The pronunciation
    dictionary is English-only and runs everywhere, so a Spanish channel still gets "let's fucking
    go" out of `lfg`; loading only the Spanish list would send that through untouched.
  - `languageBoost: 'auto'` (the default) uses the English list; language cannot be detected per
    message.
  - Slurs map to the literal word `"slur"` rather than a milder insult — a softened slur still
    lands as the thing it was. English only so far.
  - For scripts written without spaces (Han, Kana, Thai, Lao, Khmer, Myanmar) the `\p{L}`
    lookarounds are the wrong boundary test, since neighbouring characters are letters even at a
    real word edge. Those terms are matched bare and validated against `Intl.Segmenter` word
    boundaries instead, which is what separates 你在**操**什么 (filter it) from **操作**系统
    ("operating system", leave it). Segmentation is computed lazily, so English channels pay
    nothing for it.

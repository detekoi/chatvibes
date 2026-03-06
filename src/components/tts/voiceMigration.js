/**
 * Voice Migration Helper
 * Manages the migration of voices from Wavespeed (speech-02-turbo) to 302.ai (speech-2.6-turbo).
 */

// List of voice IDs supported by 302.ai / Minimax speech-2.6-turbo
// Source: https://platform.minimax.io/docs/faq/system-voice-id.md
export const T302_SUPPORTED_VOICE_IDS = [
    // English
    "English_expressive_narrator", "English_radiant_girl", "English_magnetic_voiced_man",
    "English_compelling_lady1", "English_Aussie_Bloke", "English_captivating_female1",
    "English_Upbeat_Woman", "English_Trustworth_Man", "English_CalmWoman", "English_UpsetGirl",
    "English_Gentle-voiced_man", "English_Whispering_girl", "English_Diligent_Man",
    "English_Graceful_Lady", "English_ReservedYoungMan", "English_PlayfulGirl",
    "English_ManWithDeepVoice", "English_MaturePartner", "English_FriendlyPerson",
    "English_MatureBoss", "English_Debator", "English_LovelyGirl", "English_Steadymentor",
    "English_Deep-VoicedGentleman", "English_Wiselady", "English_CaptivatingStoryteller",
    "English_DecentYoungMan", "English_SentimentalLady", "English_ImposingManner",
    "English_SadTeen", "English_PassionateWarrior", "English_WiseScholar",
    "English_Soft-spokenGirl", "English_SereneWoman", "English_ConfidentWoman",
    "English_PatientMan", "English_Comedian", "English_BossyLeader", "English_Strong-WilledBoy",
    "English_StressedLady", "English_AssertiveQueen", "English_AnimeCharacter",
    "English_Jovialman", "English_WhimsicalGirl", "English_Kind-heartedGirl",
    "English_intellect_female_1", "English_energetic_male_1", "English_witty_female_1",
    "English_Lucky_Robot", "English_Cute_Girl", "English_Sharp_Commentator", "English_Honest_Man",
    "English_Insightful_Speaker", "English_patient_man_v1", "English_Persuasive_Man",
    "English_Explanatory_Man", "English_Lively_Male_10", "English_Lively_Male_11",
    "English_Magnetic_Male_2", "English_Magnetic_Male_12", "English_Friendly_Female_3",
    "English_Steady_Female_1", "English_Steady_Female_5", "English_Sweet_Female_4",
    "English_Husky_MetalHead", "English_GentleTeacher", "English_AttractiveGirl",
    "English_ThoughtfulMan", "English_DecentBoy",

    // Chinese (Mandarin)
    "Chinese (Mandarin)_Reliable_Executive", "Chinese (Mandarin)_News_Anchor",
    "Chinese (Mandarin)_Unrestrained_Young_Man", "Chinese (Mandarin)_Mature_Woman",
    "Arrogant_Miss", "Robot_Armor", "Chinese (Mandarin)_Kind-hearted_Antie",
    "Chinese (Mandarin)_HK_Flight_Attendant", "Chinese (Mandarin)_Humorous_Elder",
    "Chinese (Mandarin)_Gentleman", "Chinese (Mandarin)_Warm_Bestie",
    "Chinese (Mandarin)_Stubborn_Friend", "Chinese (Mandarin)_Sweet_Lady",
    "Chinese (Mandarin)_Southern_Young_Man", "Chinese (Mandarin)_Wise_Women",
    "Chinese (Mandarin)_Gentle_Youth", "Chinese (Mandarin)_Warm_Girl",
    "Chinese (Mandarin)_Male_Announcer", "Chinese (Mandarin)_Kind-hearted_Elder",
    "Chinese (Mandarin)_Cute_Spirit", "Chinese (Mandarin)_Radio_Host",
    "Chinese (Mandarin)_Lyrical_Voice", "Chinese (Mandarin)_Straightforward_Boy",
    "Chinese (Mandarin)_Sincere_Adult", "Chinese (Mandarin)_Gentle_Senior",
    "Chinese (Mandarin)_Crisp_Girl", "Chinese (Mandarin)_Pure-hearted_Boy",
    "Chinese (Mandarin)_Soft_Girl", "Chinese (Mandarin)_IntellectualGirl",
    "Chinese (Mandarin)_Warm_HeartedGirl", "Chinese (Mandarin)_Laid_BackGirl",
    "Chinese (Mandarin)_ExplorativeGirl", "Chinese (Mandarin)_Warm-HeartedAunt",
    "Chinese (Mandarin)_BashfulGirl",

    // Japanese
    "Japanese_IntellectualSenior", "Japanese_DecisivePrincess", "Japanese_LoyalKnight",
    "Japanese_DominantMan", "Japanese_SeriousCommander", "Japanese_ColdQueen",
    "Japanese_DependableWoman", "Japanese_GentleButler", "Japanese_KindLady",
    "Japanese_CalmLady", "Japanese_OptimisticYouth", "Japanese_GenerousIzakayaOwner",
    "Japanese_SportyStudent", "Japanese_InnocentBoy", "Japanese_GracefulMaiden",

    // Cantonese
    "Cantonese_ProfessionalHost (F)", "Cantonese_ProfessionalHost（F)", "Cantonese_GentleLady",
    "Cantonese_ProfessionalHost (M)", "Cantonese_ProfessionalHost（M)",
    "Cantonese_PlayfulMan", "Cantonese_CuteGirl", "Cantonese_KindWoman",

    // Korean
    "Korean_AirheadedGirl", "Korean_AthleticGirl", "Korean_AthleticStudent",
    "Korean_BraveAdventurer", "Korean_BraveFemaleWarrior", "Korean_BraveYouth",
    "Korean_CalmGentleman", "Korean_CalmLady", "Korean_CaringWoman",
    "Korean_CharmingElderSister", "Korean_CharmingSister", "Korean_CheerfulBoyfriend",
    "Korean_CheerfulCoolJunior", "Korean_CheerfulLittleSister", "Korean_ChildhoodFriendGirl",
    "Korean_CockyGuy", "Korean_ColdGirl", "Korean_ColdYoungMan", "Korean_ConfidentBoss",
    "Korean_ConsiderateSenior", "Korean_DecisiveQueen", "Korean_DominantMan",
    "Korean_ElegantPrincess", "Korean_EnchantingSister", "Korean_EnthusiasticTeen",
    "Korean_FriendlyBigSister", "Korean_GentleBoss", "Korean_GentleWoman",
    "Korean_HaughtyLady", "Korean_InnocentBoy", "Korean_IntellectualMan",
    "Korean_IntellectualSenior", "Korean_LonelyWarrior", "Korean_MatureLady",
    "Korean_MysteriousGirl", "Korean_OptimisticYouth", "Korean_PlayboyCharmer",
    "Korean_PossessiveMan", "Korean_QuirkyGirl", "Korean_ReliableSister",
    "Korean_ReliableYouth", "Korean_SassyGirl", "Korean_ShyGirl", "Korean_SoothingLady",
    "Korean_StrictBoss", "Korean_SweetGirl", "Korean_ThoughtfulWoman", "Korean_WiseElf",
    "Korean_WiseTeacher",

    // Spanish
    "Spanish_SereneWoman", "Spanish_MaturePartner", "Spanish_CaptivatingStoryteller",
    "Spanish_Narrator", "Spanish_WiseScholar", "Spanish_Kind-heartedGirl",
    "Spanish_DeterminedManager", "Spanish_BossyLeader", "Spanish_ReservedYoungMan",
    "Spanish_ConfidentWoman", "Spanish_ThoughtfulMan", "Spanish_Strong-WilledBoy",
    "Spanish_SophisticatedLady", "Spanish_RationalMan", "Spanish_AnimeCharacter",
    "Spanish_Deep-tonedMan", "Spanish_Fussyhostess", "Spanish_SincereTeen",
    "Spanish_FrankLady", "Spanish_Comedian", "Spanish_Debator", "Spanish_ToughBoss",
    "Spanish_Wiselady", "Spanish_Steadymentor", "Spanish_Jovialman", "Spanish_SantaClaus",
    "Spanish_Rudolph", "Spanish_Intonategirl", "Spanish_Arnold", "Spanish_Ghost",
    "Spanish_HumorousElder", "Spanish_EnergeticBoy", "Spanish_WhimsicalGirl",
    "Spanish_StrictBoss", "Spanish_ReliableMan", "Spanish_SereneElder", "Spanish_AngryMan",
    "Spanish_AssertiveQueen", "Spanish_CaringGirlfriend", "Spanish_PowerfulSoldier",
    "Spanish_PassionateWarrior", "Spanish_ChattyGirl", "Spanish_RomanticHusband",
    "Spanish_CompellingGirl", "Spanish_PowerfulVeteran", "Spanish_SensibleManager",
    "Spanish_ThoughtfulLady",

    // Portuguese
    "Portuguese_SentimentalLady", "Portuguese_BossyLeader", "Portuguese_Wiselady",
    "Portuguese_Strong-WilledBoy", "Portuguese_Deep-VoicedGentleman", "Portuguese_UpsetGirl",
    "Portuguese_PassionateWarrior", "Portuguese_AnimeCharacter", "Portuguese_ConfidentWoman",
    "Portuguese_AngryMan", "Portuguese_CaptivatingStoryteller", "Portuguese_Godfather",
    "Portuguese_ReservedYoungMan", "Portuguese_SmartYoungGirl", "Portuguese_Kind-heartedGirl",
    "Portuguese_Pompouslady", "Portuguese_Grinch", "Portuguese_Debator", "Portuguese_SweetGirl",
    "Portuguese_AttractiveGirl", "Portuguese_ThoughtfulMan", "Portuguese_PlayfulGirl",
    "Portuguese_GorgeousLady", "Portuguese_LovelyLady", "Portuguese_SereneWoman",
    "Portuguese_SadTeen", "Portuguese_MaturePartner", "Portuguese_Comedian",
    "Portuguese_NaughtySchoolgirl", "Portuguese_Narrator", "Portuguese_ToughBoss",
    "Portuguese_Fussyhostess", "Portuguese_Dramatist", "Portuguese_Steadymentor",
    "Portuguese_Jovialman", "Portuguese_CharmingQueen", "Portuguese_SantaClaus",
    "Portuguese_Rudolph", "Portuguese_Arnold", "Portuguese_CharmingSanta",
    "Portuguese_CharmingLady", "Portuguese_Ghost", "Portuguese_HumorousElder",
    "Portuguese_CalmLeader", "Portuguese_GentleTeacher", "Portuguese_EnergeticBoy",
    "Portuguese_ReliableMan", "Portuguese_SereneElder", "Portuguese_GrimReaper",
    "Portuguese_AssertiveQueen", "Portuguese_WhimsicalGirl", "Portuguese_StressedLady",
    "Portuguese_FriendlyNeighbor", "Portuguese_CaringGirlfriend", "Portuguese_PowerfulSoldier",
    "Portuguese_FascinatingBoy", "Portuguese_RomanticHusband", "Portuguese_StrictBoss",
    "Portuguese_InspiringLady", "Portuguese_PlayfulSpirit", "Portuguese_ElegantGirl",
    "Portuguese_CompellingGirl", "Portuguese_PowerfulVeteran", "Portuguese_SensibleManager",
    "Portuguese_ThoughtfulLady", "Portuguese_TheatricalActor", "Portuguese_FragileBoy",
    "Portuguese_ChattyGirl", "Portuguese_Conscientiousinstructor", "Portuguese_RationalMan",
    "Portuguese_WiseScholar", "Portuguese_FrankLady", "Portuguese_DeterminedManager",

    // French
    "French_Male_Speech_New", "French_Female_News Anchor", "French_CasualMan",
    "French_MovieLeadFemale", "French_FemaleAnchor", "French_MaleNarrator",

    // Indonesian
    "Indonesian_SweetGirl", "Indonesian_ReservedYoungMan", "Indonesian_CharmingGirl",
    "Indonesian_CalmWoman", "Indonesian_ConfidentWoman", "Indonesian_CaringMan",
    "Indonesian_BossyLeader", "Indonesian_DeterminedBoy", "Indonesian_GentleGirl",

    // German
    "German_FriendlyMan", "German_SweetLady", "German_PlayfulMan",

    // Russian
    "Russian_HandsomeChildhoodFriend", "Russian_BrightHeroine", "Russian_AmbitiousWoman",
    "Russian_ReliableMan", "Russian_CrazyQueen", "Russian_PessimisticGirl",
    "Russian_AttractiveGuy", "Russian_Bad-temperedBoy",

    // Italian
    "Italian_BraveHeroine", "Italian_Narrator", "Italian_WanderingSorcerer",
    "Italian_DiligentLeader",

    // Dutch
    "Dutch_kindhearted_girl", "Dutch_bossy_leader",

    // Vietnamese
    "Vietnamese_kindhearted_girl",

    // Arabic
    "Arabic_CalmWoman", "Arabic_FriendlyGuy",

    // Turkish
    "Turkish_CalmWoman", "Turkish_Trustworthyman",

    // Ukrainian
    "Ukrainian_CalmWoman", "Ukrainian_WiseScholar",

    // Thai
    "Thai_male_1_sample8", "Thai_male_2_sample2", "Thai_female_1_sample1", "Thai_female_2_sample2",

    // Polish
    "Polish_male_1_sample4", "Polish_male_2_sample3", "Polish_female_1_sample1", "Polish_female_2_sample3",

    // Romanian
    "Romanian_male_1_sample2", "Romanian_male_2_sample1", "Romanian_female_1_sample4", "Romanian_female_2_sample1",

    // Greek
    "greek_male_1a_v1", "Greek_female_1_sample1", "Greek_female_2_sample3",

    // Czech
    "czech_male_1_v1", "czech_female_5_v7", "czech_female_2_v2",

    // Finnish
    "finnish_male_3_v1", "finnish_male_1_v2", "finnish_female_4_v1",

    // Hindi
    "hindi_male_1_v2", "hindi_female_2_v1", "hindi_female_1_v2"
];

/**
 * Determines which provider to use for a given voice ID.
 * @param {string} voiceId - The voice ID to check.
 * @returns {'302'|'wavespeed'} - The provider to use.
 */
export function getProviderForVoice(voiceId) {
    if (T302_SUPPORTED_VOICE_IDS.includes(voiceId)) {
        return '302';
    }
    return 'wavespeed';
}

// Supported language boost options for 302.ai (speech-2.6-turbo)
export const T302_LANGUAGE_BOOST_OPTIONS = [
    "Chinese", "Chinese,Yue", "English", "Arabic", "Russian", "Spanish", "French", "Portuguese",
    "German", "Turkish", "Dutch", "Ukrainian", "Vietnamese", "Indonesian", "Japanese", "Italian",
    "Korean", "Thai", "Polish", "Romanian", "Greek", "Czech", "Finnish", "Hindi", "Bulgarian",
    "Danish", "Hebrew", "Malay", "Persian", "Slovak", "Swedish", "Croatian", "Filipino",
    "Hungarian", "Norwegian", "Slovenian", "Catalan", "Nynorsk", "Tamil", "Afrikaans", "auto"
];

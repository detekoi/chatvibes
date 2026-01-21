// migrateBotMode.js
// Script to add botMode field to existing ttsChannelConfigs documents
// For existing channels: Sets to 'authenticated' (preserves current bot behavior)
// New channels will use 'anonymous' as the default from ttsConstants.js

// eslint-disable-next-line import/no-unresolved
import { initializeApp } from 'firebase-admin/app';
// eslint-disable-next-line import/no-unresolved
import { getFirestore } from 'firebase-admin/firestore';

// Use Application Default Credentials (ADC) from gcloud auth
initializeApp();

const db = getFirestore();

async function migrateBotMode() {
  console.log('Starting migration to add botMode field to existing channel configs...');
  console.log('Note: Existing channels will be set to "authenticated" to preserve current behavior.\n');

  const ttsConfigsRef = db.collection('ttsChannelConfigs');
  let migratedCount = 0;
  let skippedCount = 0;
  let checkedCount = 0;

  try {
    const snapshot = await ttsConfigsRef.get();
    if (snapshot.empty) {
      console.log('No documents found in ttsChannelConfigs collection. Nothing to migrate.');
      return;
    }

    const tasks = [];

    snapshot.forEach((doc) => {
      checkedCount += 1;
      const channelName = doc.id;
      const channelData = doc.data();

      if (!channelData.botMode) {
        // Channel doesn't have botMode field yet - these are existing users who have been using the bot
        console.log(`Channel [${channelName}] missing botMode field. Will add 'authenticated' to preserve existing behavior.`);

        tasks.push((async () => {
          await ttsConfigsRef.doc(channelName).set({
            botMode: 'authenticated', // Preserve existing authenticated bot behavior
            updatedAt: new Date(),
          }, { merge: true });
          console.log(`  ✅ Added botMode='authenticated' for [${channelName}].`);
          migratedCount += 1;
        })());
      } else {
        console.log(`Channel [${channelName}] already has botMode='${channelData.botMode}'. Skipping.`);
        skippedCount += 1;
      }
    });

    await Promise.all(tasks);

    console.log('\n--- Migration Summary ---');
    console.log(`Checked ${checkedCount} channels in 'ttsChannelConfigs'.`);
    console.log(`Added botMode field to ${migratedCount} channels.`);
    console.log(`Skipped ${skippedCount} channels (already had botMode).`);
    console.log('\nMigration complete!');
    console.log('\n📝 What changed:');
    console.log('   - Existing channels: Set to "authenticated" (keeps bot with chat commands)');
    console.log('   - New channels: Will default to "anonymous" (bot-free mode)');
    console.log('\n💡 To switch a channel to bot-free mode:');
    console.log('   Set botMode="anonymous" in Firestore for that channel');
  } catch (error) {
    console.error('An error occurred during migration:', error);
  }
}

migrateBotMode();

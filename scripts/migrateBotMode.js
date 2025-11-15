// migrateBotMode.js
// Script to add botMode field to existing ttsChannelConfigs documents
// Default: 'anonymous' (bot-free mode)

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Use Application Default Credentials (ADC) from gcloud auth
initializeApp();

const db = getFirestore();

async function migrateBotMode() {
  console.log('Starting migration to add botMode field to channel configs...');

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
        // Channel doesn't have botMode field yet
        console.log(`Channel [${channelName}] missing botMode field. Will add default 'anonymous'.`);

        tasks.push((async () => {
          await ttsConfigsRef.doc(channelName).set({
            botMode: 'anonymous', // Default to bot-free mode
            updatedAt: new Date(),
          }, { merge: true });
          console.log(`  ✅ Added botMode='anonymous' for [${channelName}].`);
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
    console.log('Migration complete!');
    console.log('\nNote: Default mode is "anonymous" (bot-free, read-only IRC).');
    console.log('To enable chat commands for a channel, set botMode="authenticated" in Firestore.');
  } catch (error) {
    console.error('An error occurred during migration:', error);
  }
}

migrateBotMode();

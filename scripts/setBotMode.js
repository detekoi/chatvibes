// setBotMode.js
// Script to set botMode for a specific channel in ttsChannelConfigs
// Usage: node scripts/setBotMode.js <channelName> <botMode>
// Example: node scripts/setBotMode.js parfaittest anonymous

// eslint-disable-next-line import/no-unresolved
import { initializeApp } from 'firebase-admin/app';
// eslint-disable-next-line import/no-unresolved
import { getFirestore } from 'firebase-admin/firestore';

// Use Application Default Credentials (ADC) from gcloud auth
initializeApp();

const db = getFirestore();

const VALID_BOT_MODES = ['anonymous', 'authenticated', 'auto'];

async function setBotMode(channelName, botMode) {
  if (!channelName) {
    console.error('Error: Channel name is required.');
    console.log('Usage: node scripts/setBotMode.js <channelName> <botMode>');
    console.log('Example: node scripts/setBotMode.js parfaittest anonymous');
    process.exit(1);
  }

  if (!botMode) {
    console.error('Error: botMode is required.');
    console.log('Valid values: anonymous, authenticated, auto');
    process.exit(1);
  }

  if (!VALID_BOT_MODES.includes(botMode)) {
    console.error(`Error: Invalid botMode "${botMode}".`);
    console.log(`Valid values: ${VALID_BOT_MODES.join(', ')}`);
    process.exit(1);
  }

  const normalizedChannelName = channelName.toLowerCase();
  const ttsConfigsRef = db.collection('ttsChannelConfigs');

  try {
    console.log(`Setting botMode='${botMode}' for channel '${normalizedChannelName}'...`);

    // Check if channel exists
    const docRef = ttsConfigsRef.doc(normalizedChannelName);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      console.log(`⚠️  Channel '${normalizedChannelName}' does not exist in Firestore.`);
      console.log('Creating new document with botMode...');
    } else {
      const currentData = docSnap.data();
      const currentBotMode = currentData.botMode || '(not set)';
      console.log(`Current botMode: ${currentBotMode}`);
    }

    // Update the document
    await docRef.set({
      botMode: botMode,
      updatedAt: new Date(),
    }, { merge: true });

    console.log(`✅ Successfully set botMode='${botMode}' for channel '${normalizedChannelName}'.`);

    // Verify the update
    const verifySnap = await docRef.get();
    if (verifySnap.exists) {
      const verifiedData = verifySnap.data();
      console.log(`Verified: botMode is now '${verifiedData.botMode}'`);
    }

  } catch (error) {
    console.error('An error occurred while setting botMode:', error);
    process.exit(1);
  }
}

// Get command line arguments
const args = process.argv.slice(2);
const channelName = args[0];
const botMode = args[1];

setBotMode(channelName, botMode);







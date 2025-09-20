// migrateSecrets.js
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Use Application Default Credentials (ADC) from gcloud auth
initializeApp();

const db = getFirestore();

async function migrateObsTokenSecrets() {
  console.log('Starting migration of OBS token secrets...');

  const managedChannelsRef = db.collection('managedChannels');
  const ttsConfigsRef = db.collection('ttsChannelConfigs');
  let migratedCount = 0;
  let checkedCount = 0;

  try {
    const snapshot = await managedChannelsRef.get();
    if (snapshot.empty) {
      console.log('No documents found in managedChannels collection. Nothing to migrate.');
      return;
    }

    const tasks = [];

    snapshot.forEach((doc) => {
      checkedCount += 1;
      const channelData = doc.data();
      const channelName = doc.id;

      if (channelData && channelData.obsTokenSecretName) {
        const sourceSecretName = channelData.obsTokenSecretName;
        console.log(`Found secret name for [${channelName}]: ${sourceSecretName}`);

        tasks.push((async () => {
          const ttsDocRef = ttsConfigsRef.doc(channelName);
          const ttsDoc = await ttsDocRef.get();

          let needsUpdate = false;
          if (!ttsDoc.exists) {
            console.log(`  -> Target ttsChannelConfigs doc for [${channelName}] does not exist. Will create it.`);
            needsUpdate = true;
          } else {
            const ttsData = ttsDoc.data();
            if (ttsData.obsSocketSecretName !== sourceSecretName) {
              console.log(`  -> Mismatch for [${channelName}]. Current: '${ttsData.obsSocketSecretName}', Source: '${sourceSecretName}'. Will update.`);
              needsUpdate = true;
            } else {
              console.log(`  -> Secret for [${channelName}] already in sync. No action.`);
            }
          }

          if (needsUpdate) {
            await ttsDocRef.set({
              obsSocketSecretName: sourceSecretName,
              updatedAt: new Date(),
            }, { merge: true });
            console.log(`  ✅ Migrated secret for [${channelName}].`);
            migratedCount += 1;
          }
        })());
      }
    });

    await Promise.all(tasks);

    console.log('\n--- Migration Summary ---');
    console.log(`Checked ${checkedCount} channels in 'managedChannels'.`);
    console.log(`Migrated/Updated ${migratedCount} secret names to 'ttsChannelConfigs'.`);
    console.log('Migration complete!');
  } catch (error) {
    console.error('An error occurred during migration:', error);
  }
}

migrateObsTokenSecrets();



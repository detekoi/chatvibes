#!/usr/bin/env node
// Debug script to check which Firestore instance we're connecting to

import { Firestore } from '@google-cloud/firestore';

const PROJECT_ID = process.env.GCP_PROJECT || 'chatvibestts';
const firestore = new Firestore({ projectId: PROJECT_ID });

async function main() {
    console.log('🔍 Debugging Firestore connection...\n');

    // List collections first to initialize the client
    console.log('🔍 Trying to list all collections...');
    try {
        const collections = await firestore.listCollections();
        console.log(`   Found ${collections.length} collections:`);
        collections.forEach(col => {
            console.log(`   - ${col.id}`);
        });
    } catch (error) {
        console.error('   ❌ Error listing collections:', error.message);
    }

    // Now show connection details (after client is initialized)
    console.log('\n📋 Connection Details:');
    console.log(`   Project ID: ${firestore.projectId}`);
    console.log(`   Database ID: ${firestore.databaseId || '(default)'}`);
    console.log(`   Environment GOOGLE_CLOUD_PROJECT: ${process.env.GOOGLE_CLOUD_PROJECT || 'not set'}`);
    console.log(`   Environment GCLOUD_PROJECT: ${process.env.GCLOUD_PROJECT || 'not set'}`);
    console.log(`   Environment GCP_PROJECT: ${process.env.GCP_PROJECT || 'not set'}`)

    // Try to read a specific document from your screenshots
    console.log('\n🔍 Trying to read specific documents from screenshots...');

    // From first screenshot: processedTtsEvents/0002c9d9783d2fa8cfa7b71c9744dc875c3438fd
    try {
        const doc1 = await firestore.collection('processedTtsEvents')
            .doc('0002c9d9783d2fa8cfa7b71c9744dc875c3438fd')
            .get();

        if (doc1.exists) {
            console.log('   ✓ Found processedTtsEvents/0002c9d...');
            console.log('   Data:', JSON.stringify(doc1.data(), null, 2));
        } else {
            console.log('   ✗ Document processedTtsEvents/0002c9d... does not exist');
        }
    } catch (error) {
        console.error('   ❌ Error reading processedTtsEvents doc:', error.message);
    }

    // Try to query for any documents
    console.log('\n🔍 Trying to query first 5 documents from processedTtsEvents...');
    try {
        const snapshot = await firestore.collection('processedTtsEvents').limit(5).get();
        console.log(`   Found ${snapshot.size} documents`);
        snapshot.forEach((doc, idx) => {
            console.log(`   [${idx + 1}] ${doc.id}`);
        });
    } catch (error) {
        console.error('   ❌ Error querying:', error.message);
    }

    console.log('\n🔍 Trying to query first 5 documents from processedEventSubMessages...');
    try {
        const snapshot = await firestore.collection('processedEventSubMessages').limit(5).get();
        console.log(`   Found ${snapshot.size} documents`);
        snapshot.forEach((doc, idx) => {
            console.log(`   [${idx + 1}] ${doc.id}`);
        });
    } catch (error) {
        console.error('   ❌ Error querying:', error.message);
    }
}

main();

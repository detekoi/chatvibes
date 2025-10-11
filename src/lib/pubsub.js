// src/lib/pubsub.js
import { PubSub } from '@google-cloud/pubsub';
import logger from './logger.js';
import config from '../config/index.js';

const TOPIC_NAME = 'chatvibes-tts-events';
const SUBSCRIPTION_PREFIX = 'chatvibes-tts-sub';

let pubsubClient = null;
let topic = null;
let subscription = null;
let messageHandler = null;

/**
 * Initialize Pub/Sub client and ensure topic exists
 */
export async function initializePubSub() {
    if (pubsubClient) {
        logger.debug('Pub/Sub client already initialized');
        return;
    }

    try {
        pubsubClient = new PubSub({
            projectId: config.gcp.projectId
        });

        // Get or create topic
        topic = pubsubClient.topic(TOPIC_NAME);
        const [topicExists] = await topic.exists();
        
        if (!topicExists) {
            logger.info(`Creating Pub/Sub topic: ${TOPIC_NAME}`);
            await pubsubClient.createTopic(TOPIC_NAME);
            logger.info(`Pub/Sub topic created: ${TOPIC_NAME}`);
        } else {
            logger.info(`Pub/Sub topic exists: ${TOPIC_NAME}`);
        }

        logger.info('Pub/Sub client initialized successfully');
    } catch (error) {
        logger.error({ err: error }, 'Failed to initialize Pub/Sub client');
        throw error;
    }
}

/**
 * Publish a TTS event to Pub/Sub
 * @param {string} channelName - Channel name
 * @param {object} eventData - Event data with text, user, type, voiceOptions
 */
export async function publishTtsEvent(channelName, eventData) {
    if (!topic) {
        logger.error('Pub/Sub not initialized, cannot publish TTS event');
        return;
    }

    try {
        const message = {
            channelName,
            eventData,
            timestamp: Date.now(),
            source: process.env.K_REVISION || 'local'
        };

        const dataBuffer = Buffer.from(JSON.stringify(message));
        const messageId = await topic.publishMessage({ data: dataBuffer });
        
        logger.debug({
            messageId,
            channel: channelName,
            user: eventData.user,
            textPreview: eventData.text?.substring(0, 30)
        }, `Published TTS event to Pub/Sub`);

        return messageId;
    } catch (error) {
        logger.error({ err: error, channel: channelName }, 'Failed to publish TTS event to Pub/Sub');
        throw error;
    }
}

/**
 * Subscribe to TTS events from Pub/Sub
 * @param {function} handler - Function to call when a message is received: (channelName, eventData) => Promise<void>
 */
export async function subscribeTtsEvents(handler) {
    if (!pubsubClient || !topic) {
        throw new Error('Pub/Sub not initialized. Call initializePubSub() first.');
    }

    if (subscription) {
        logger.warn('Pub/Sub subscription already active');
        return;
    }

    try {
        messageHandler = handler;
        
        // Create a unique subscription name for this instance
        // Each instance gets its own subscription so all instances receive all messages
        const instanceId = process.env.K_REVISION || 'local';
        const randomSuffix = Math.random().toString(36).substring(7);
        const subscriptionName = `${SUBSCRIPTION_PREFIX}-${instanceId}-${randomSuffix}`;

        logger.info(`Creating Pub/Sub subscription: ${subscriptionName}`);
        
        // Create subscription with auto-delete after 10 minutes of inactivity
        [subscription] = await topic.createSubscription(subscriptionName, {
            expirationPolicy: {
                ttl: {
                    seconds: 600 // 10 minutes
                }
            },
            messageRetentionDuration: {
                seconds: 600 // 10 minutes
            }
        });

        logger.info(`Pub/Sub subscription created: ${subscriptionName}`);

        // Set up message handler
        subscription.on('message', async (message) => {
            try {
                const data = JSON.parse(message.data.toString());
                const { channelName, eventData, source } = data;

                logger.debug({
                    messageId: message.id,
                    channel: channelName,
                    source,
                    currentRevision: process.env.K_REVISION || 'local'
                }, 'Received TTS event from Pub/Sub');

                // Call the handler
                await handler(channelName, eventData);

                // Acknowledge the message
                message.ack();
            } catch (error) {
                logger.error({ err: error, messageId: message.id }, 'Error processing Pub/Sub message');
                // Nack the message so it can be retried
                message.nack();
            }
        });

        subscription.on('error', (error) => {
            logger.error({ err: error }, 'Pub/Sub subscription error');
        });

        logger.info('Pub/Sub subscription handler registered');
    } catch (error) {
        logger.error({ err: error }, 'Failed to create Pub/Sub subscription');
        throw error;
    }
}

/**
 * Clean up Pub/Sub resources
 */
export async function closePubSub() {
    try {
        if (subscription) {
            logger.info('Closing Pub/Sub subscription');
            await subscription.close();
            
            // Delete the subscription to clean up
            try {
                await subscription.delete();
                logger.info('Deleted Pub/Sub subscription');
            } catch (deleteError) {
                logger.warn({ err: deleteError }, 'Failed to delete subscription (may not exist)');
            }
            
            subscription = null;
        }

        if (pubsubClient) {
            logger.info('Closing Pub/Sub client');
            await pubsubClient.close();
            pubsubClient = null;
            topic = null;
        }

        logger.info('Pub/Sub resources cleaned up');
    } catch (error) {
        logger.error({ err: error }, 'Error closing Pub/Sub resources');
    }
}


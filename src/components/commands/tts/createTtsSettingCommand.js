import { enqueueMessage } from '../../../lib/chatSender.js';
import logger from '../../../lib/logger.js';

export function createTtsSettingCommand({
    name,
    property,
    description,
    usage,
    permission = 'everyone',
    readCurrent,
    resetSetting,
    setSetting,
    parseFn = (str) => str,
    validateFn,
    transformFn = (val) => val,
    validationHint,
    formatCurrent,
    formatSet,
    formatReset,
    logSet,
    logReset,
    resetAliases = ['reset']
}) {
    const computedResetAliases = resetAliases.map(a => a.toLowerCase());

    return {
        name,
        description,
        usage,
        permission,
        execute: async (context) => {
            const { channel, args, replyToId } = context;

            if (args.length === 0) {
                const currentVal = await readCurrent(context);
                enqueueMessage(channel, formatCurrent(currentVal, usage), { replyToId });
                return;
            }

            const actionOrValue = args[0].toLowerCase();

            if (computedResetAliases.includes(actionOrValue)) {
                const success = await resetSetting(context);
                if (success) {
                    enqueueMessage(channel, formatReset(), { replyToId });
                    if (logReset) {
                        logger.info(logReset(context));
                    }
                } else {
                    enqueueMessage(channel, `Could not reset ${property}.`, { replyToId });
                }
                return;
            }

            const parsed = parseFn(actionOrValue);
            if (!validateFn(parsed)) {
                enqueueMessage(channel, `Invalid ${property}. ${validationHint}`, { replyToId });
                return;
            }

            const transformed = transformFn(parsed);
            const success = await setSetting(context, transformed);
            
            if (success) {
                enqueueMessage(channel, formatSet(transformed), { replyToId });
                if (logSet) {
                    logger.info(logSet(context, transformed));
                }
            } else {
                enqueueMessage(channel, `Could not set ${property} to ${transformed}.`, { replyToId });
            }
        }
    };
}

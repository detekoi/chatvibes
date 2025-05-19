// src/lib/logger.js
import pino from 'pino';
import config from '../config/index.js'; // Assuming config/index.js is in src/config/

const GcpSeverityLookup = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

const usePrettyPrint = config.app.nodeEnv === 'development' && config.app.prettyLog;

const commonOptions = {
  level: config.app.logLevel || 'info',
  // Standard serializers for errors, etc.
  serializers: {
    err: pino.stdSerializers.err, // Standard error serializer
    req: pino.stdSerializers.req, // Standard request serializer
    res: pino.stdSerializers.res, // Standard response serializer
  },
};

const jsonOptions = {
  ...commonOptions,
  formatters: {
    level: (label) => {
      return { severity: GcpSeverityLookup[label] || label.toUpperCase() };
    },
    log: (obj) => {
      // Pino uses 'msg', GCP prefers 'message'. This ensures 'message' key is present.
      if (obj.msg && !obj.message) {
           obj.message = obj.msg;
           // We can keep obj.msg for pino-pretty or remove it if desired for JSON.
           // delete obj.msg; // Optional: remove original 'msg' field for pure GCP format
      }
      // Ensure 'err' is properly formatted if it's an error object
      if (obj.err && obj.err instanceof Error && commonOptions.serializers.err) {
        obj.err = commonOptions.serializers.err(obj.err);
      }
      return obj;
    }
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'message', // Explicitly use 'message' key for GCP
  base: {
    pid: process.pid, // Add process ID
  },
};

// Add serviceContext only if not in test environment
if (config.app.nodeEnv !== 'test') {
    jsonOptions.base.serviceContext = { service: 'chatvibes-tts' }; // Updated service name
}


const prettyOptions = {
  ...commonOptions,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard', // More human-readable time for local dev
      ignore: 'pid,hostname,serviceContext,severity', // Hide fields less useful in local dev
      messageKey: 'message', // Tell pino-pretty to use 'message'
    },
  },
};

const logger = pino(usePrettyPrint ? prettyOptions : jsonOptions);

if (usePrettyPrint) {
    logger.info('ChatVibes: Pretty logging enabled for development.');
} else {
    logger.info({ configLogLevel: config.app.logLevel, serviceName: 'chatvibes-tts' }, // Updated name
     `ChatVibes: Logger initialized (JSON format) at level: ${config.app.logLevel}`);
}

export default logger;
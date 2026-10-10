/**
 * Winston logger configuration.
 */

import winston from 'winston';
import { config } from './config.js';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

export const logger = winston.createLogger({
  level: config.logLevel,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      ),
    }),
  ],
});

// Add file transport in production. When the host rotates the files
// (LOG_FILE_ROTATION=external, e.g. logrotate with copytruncate), the app must
// not rotate them too: the two schemes rename and delete each other's files.
if (config.nodeEnv === 'production') {
  const rotation = config.logFileRotation === 'external'
    ? {}
    : { maxsize: 5 * 1024 * 1024, maxFiles: 3 };
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      ...rotation,
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
      ...rotation,
    })
  );
}

/**
 * Loaded before the app with `node --import ./dist/instrument.js`, so the
 * Sentry SDK can instrument Express and the database client. Does nothing
 * unless SENTRY_DSN is set.
 */
import * as Sentry from '@sentry/node';
import { sentryOptions } from './services/error-reporting.js';

const options = sentryOptions(process.env);
if (options) Sentry.init(options);

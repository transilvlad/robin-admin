import express, { type RequestHandler } from 'express';
import { operationsPolicy } from '../services/operations-settings.js';

export const reportIngestionBody: RequestHandler = (req, res, next) => {
  const limit = operationsPolicy().reportingIngestMaxMiB * 1024 * 1024;
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > limit) {
    res.status(413).json({ success: false, error: 'Report payload exceeds the ingestion size limit' });
    return;
  }
  // Each request snapshots one policy for both parser stages. Body-parser also
  // bounds chunked and inflated bodies, not just the declared Content-Length.
  express.json({ limit })(req, res, error => {
    if (error) { next(error); return; }
    express.urlencoded({ extended: true, limit })(req, res, next);
  });
};

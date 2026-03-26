import express from 'express';
import path from 'path';
import matchesRouter from './routes/matches';
import weaponsRouter from './routes/weapons';
import clutchRouter from './routes/clutch';
import syncRouter from './routes/sync';
import authRouter from './routes/auth';

export function createServer(): express.Application {
  const app = express();

  app.use(express.json());

  // Serve the dashboard static files
  app.use(express.static(path.join(__dirname, '../dashboard')));

  // API routes
  app.use('/api/matches',  matchesRouter);
  app.use('/api/weapons',  weaponsRouter);
  app.use('/api/clutch',   clutchRouter);
  app.use('/api/sync',     syncRouter);
  app.use('/api/auth',     authRouter);

  // Fallback — serve dashboard for any non-API route
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard/index.html'));
  });

  return app;
}

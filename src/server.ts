import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { startWorkerLoop, stopWorkerLoop } from './worker';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3033;

// Security Hardening
app.use(helmet());
app.use(cors()); // Allow all by default or configure per requirements
app.use(express.json());

// Rate Limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Routes
app.use('/api', limiter); // Apply rate limiter to API routes

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Starting Background Worker...');
    startWorkerLoop();

    // Macro-Retry: Start supervisor to clear stuck jobs every 1 hour
    setInterval(async () => {
        const { db } = await import('./services/db');
        await db.clearStuckJobs();
    }, 60 * 60 * 1000);
});

// Graceful Shutdown
const shutdown = async (signal: string) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);

    // Stop worker and abort active scraper
    try {
        await stopWorkerLoop();
    } catch (e) {
        console.error('Error stopping worker loop:', e);
    }

    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });

    // Force close after 10s if not finished
    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));


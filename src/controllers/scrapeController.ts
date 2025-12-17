import { Request, Response } from 'express';
import { z } from 'zod';
import { ScraperService } from '../services/scraper';

// Queue Configuration
const MAX_CONCURRENCY = 3;
const TARGET_URL = process.env.TARGET_URL || "https://sei.univesp.br/index.xhtml";
let activeScrapes = 0;
const queue: (() => void)[] = [];

const scrapeSchema = z.object({
    email: z.string().min(1),
    password: z.string().min(1),
});

// Process Queue Helper
const processQueue = () => {
    if (activeScrapes < MAX_CONCURRENCY && queue.length > 0) {
        const nextTask = queue.shift();
        if (nextTask) {
            nextTask();
        }
    }
};

export const scrapeStreamController = async (req: Request, res: Response) => {
    // Input Validation
    const validationResult = scrapeSchema.safeParse(req.body);

    if (!validationResult.success) {
        return res.status(400).json({ error: validationResult.error });
    }

    // Setup SSE Headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    res.write(': keepalive\n\n');

    // Heartbeat
    const heartbeat = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 15000);

    let isClosed = false;

    // Helper for sending events
    const sendEvent = (event: string, data: any) => {
        if (isClosed) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (typeof (res as any).flush === 'function') {
            (res as any).flush();
        }
    };

    req.on('close', () => {
        isClosed = true;
        clearInterval(heartbeat);
    });

    // Validated Data - Mutable for security cleanup
    let { email, password } = validationResult.data;

    // Task Execution Logic
    const startScraping = async () => {
        // If client disconnected while in queue, skip and process next
        if (isClosed) {
            processQueue();
            return;
        }

        activeScrapes++;
        const scraper = new ScraperService();

        // Handle disconnect during execution
        const closeListener = async () => {
            console.log('Client disconnected, active scraper stopping...');
            await scraper.close();
        };
        req.on('close', closeListener);

        try {
            let questionCount = 0;

            await scraper.scrape({
                email,
                password,
                targetUrl: TARGET_URL,
                onStatus: (step, message) => {
                    sendEvent('status', { step, message });
                },
                onQuestion: (question) => {
                    questionCount++;
                    sendEvent('question', question);
                }
            });

            sendEvent('done', { total: questionCount });

        } catch (error: any) {
            console.error('Scrape execution failed:', error);
            sendEvent('error', {
                message: error.message || 'Unknown error',
                snapshot: null
            });
        } finally {
            // Secure Cleanup: Nullify sensitive vars
            (email as any) = null;
            (password as any) = null;

            req.off('close', closeListener);

            activeScrapes--;
            clearInterval(heartbeat);

            if (!isClosed) {
                res.end();
            }

            // Immediately trigger next task
            processQueue();
        }
    };

    // Queue Logic
    if (activeScrapes >= MAX_CONCURRENCY) {
        queue.push(startScraping);
        const position = queue.length; // Approximate position
        sendEvent('status', {
            step: 'QUEUED',
            message: `🚦 Você está na fila (Posição ${position})... Aguardando liberar recursos.`
        });
    } else {
        startScraping();
    }
};

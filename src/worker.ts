import { db } from './services/db';
import { decrypt } from './utils/crypto';
import { ScraperService } from './services/scraper';
import { generateTitle, formatQuestionBody } from './utils/text';
import crypto from 'crypto';

const ENVIRONMENT = process.env.ENVIRONMENT || "dev";
const TARGET_URL = process.env.TARGET_URL || "https://sei.univesp.br/index.xhtml";
const POLL_INTERVAL_MS = 10000; // 10 seconds

let isWorkerRunning = false;
let workerInterval: NodeJS.Timeout | null = null;
let activeScraper: ScraperService | null = null;

// Interface expected by the frontend
interface LogsData {
    logs: { id: string; time: string; msg: string; type: string }[];
    metrics: { found: number; imported: number; skipped: number; xp: number };
}

const generateLogId = () => crypto.randomUUID();

const formatTime = () => {
    const now = new Date();
    return now.toTimeString().split(' ')[0]; // "HH:MM:SS"
};

export async function processNextJob() {
    if (isWorkerRunning) return;
    isWorkerRunning = true;

    try {
        const job = await db.fetchAndLockJob();

        if (!job) {
            // No jobs pending
            return;
        }

        console.log(`[Worker] Started processing job ${job.id} for user ${job.userId}`);

        // Decrypt password
        const password = decrypt(job.password);

        // Prepare structured logs state
        const state: LogsData = {
            logs: [],
            metrics: {
                found: 0,
                imported: 0,
                skipped: 0,
                xp: 0
            }
        };

        const addLog = (msg: string, type: 'info' | 'success' | 'error' | 'warning' | 'PROCESSING' | 'FOUND' | 'SKIPPED' | 'DONE' | 'INIT') => {
            // Map scraper types to frontend types
            let mappedType = type.toLowerCase();
            if (['processing', 'init', 'navigate', 'login', 'analyzing', 'cleanup'].includes(mappedType)) mappedType = 'info';
            if (['found', 'exam_done', 'done'].includes(mappedType)) mappedType = 'success';

            state.logs.push({
                id: generateLogId(),
                time: formatTime(),
                msg,
                type: mappedType
            });
        };

        const scraper = new ScraperService(ENVIRONMENT);
        activeScraper = scraper;

        addLog('Iniciando captura em background...', 'info');
        await db.updateJobProgress(job.id, state); // Initial save

        // Busca os exames já finalizados para ignorar e poupar tempo (ScrapeHistory)
        const ignoredExams = await db.getUserIgnoredExams(job.userId);

        // Execute scraper
        try {
            await scraper.scrape({
                email: job.login,
                password,
                targetUrl: TARGET_URL,
                ignoredExams,
                checkActiveAbort: async () => {
                    const status = await db.getJobStatus(job.id);
                    return status === 'FAILED';
                },
                onStatus: async (step, message) => {
                    addLog(message, step as any);

                    if (step === 'SKIPPED') state.metrics.skipped++;

                    // Periodically update DB to avoid hammering it
                    // The job takes several minutes, we can update DB on every status change as it is not too frequent
                    await db.updateJobProgress(job.id, state).catch(console.error);
                },
                onQuestion: async (question) => {
                    try {
                        const mappedQuestion = {
                            subjectName: question.subjectName,
                            title: generateTitle(question.statement),
                            body: formatQuestionBody(question.statement, question.images),
                            metadata: question.metadata,
                            alternatives: question.alternatives,
                            justification: question.justification
                        };

                        // Database Retry: Exponential backoff for db inserts to prevent lock collision
                        let dbRetries = 0;
                        const maxDbRetries = 3;

                        while (dbRetries < maxDbRetries) {
                            try {
                                await db.saveScrapedQuestion(job.userId, mappedQuestion);
                                break;
                            } catch (error: any) {
                                dbRetries++;
                                if (dbRetries >= maxDbRetries) throw error;
                                const delay = Math.random() * 2000 + 500;
                                console.warn(`[Worker] DB Lock/Error on question insert. Retrying (${dbRetries}/${maxDbRetries}) in ${Math.round(delay)}ms...`);
                                await new Promise(r => setTimeout(r, delay));
                            }
                        }

                        state.metrics.found++;
                        state.metrics.imported++;
                        state.metrics.xp += 10;

                        addLog(`Questão ${question.id} salva com sucesso!`, 'success');

                        // To avoid large DB updates, update job progress every 2 items
                        if (state.metrics.found % 2 === 0) {
                            await db.updateJobProgress(job.id, state).catch(console.error);
                        }
                    } catch (e: any) {
                        addLog(`Erro ao salvar questão ${question.id}: ${e.message}`, 'error');
                        console.error(`Error saving question ${question.id}:`, e);
                    }
                },
                onExamDone: async (examData) => {
                    await db.saveScrapeHistory(job.userId, examData.year, examData.examId, examData.examName);
                    addLog(`Prova ${examData.examName} finalizada e salva no histórico`, 'success');
                    await db.updateJobProgress(job.id, state).catch(console.error);
                }
            });

            addLog('Finalizado com sucesso!', 'success');
            await db.completeJob(job.id, state);
            console.log(`[Worker] Completed job ${job.id}`);

        } catch (scraperError: any) {
            console.error(`[Worker] Scraper error on job ${job.id}:`, scraperError);

            // Tratamento de Erro Fatal (Falha no Login / AVA Fora do Ar)
            const errorMsg = scraperError.message || '';
            if (errorMsg.includes('Timeout') || errorMsg.includes('locator') || errorMsg.includes('Login')) {
                addLog(`Erro fatal: Credenciais inválidas ou AVA indisponível. (${errorMsg})`, 'error');
            } else {
                addLog(`Erro durante a captura: ${errorMsg}`, 'error');
            }

            await db.failJob(job.id, state);
        } finally {
            try {
                await scraper.abort();
            } catch (e) { }
            activeScraper = null;
        }

    } catch (e) {
        console.error(`[Worker] Critical error fetching or locked job:`, e);
    } finally {
        isWorkerRunning = false;
    }
}

export function startWorkerLoop() {
    console.log('[Worker] Starting polling loop...');
    workerInterval = setInterval(processNextJob, POLL_INTERVAL_MS);
    // Also trigger one immediately
    processNextJob();
}

export async function stopWorkerLoop() {
    console.log('[Worker] Stopping polling loop...');
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
    }

    if (activeScraper) {
        console.log('[Worker] Aborting active scraper...');
        await activeScraper.abort();
    }
}

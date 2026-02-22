import { Pool } from 'pg';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Adjust pool settings if needed
    max: 10,
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    process.exit(-1);
});

export const db = {
    /**
     * Busca um job PENDING e imediatamente o marca como PROCESSING (Locking Seguro)
     */
    async fetchAndLockJob() {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // SKIP LOCKED is critical to prevent multiple workers from grabbing the same job
            const { rows } = await client.query(`
                SELECT * FROM "ImportJob" 
                WHERE status = 'PENDING' 
                ORDER BY "createdAt" ASC 
                LIMIT 1 
                FOR UPDATE SKIP LOCKED
            `);

            if (rows.length === 0) {
                await client.query('COMMIT');
                return null;
            }

            const job = rows[0];

            // Mark as PROCESSING
            const updateResult = await client.query(`
                UPDATE "ImportJob" 
                SET status = 'PROCESSING', "updatedAt" = NOW() 
                WHERE id = $1 
                RETURNING *
            `, [job.id]);

            await client.query('COMMIT');
            return updateResult.rows[0];
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    },

    /**
     * Atualiza o progresso do scraping (logs e metrics)
     */
    async updateJobProgress(jobId: string, logsData: any) {
        try {
            await pool.query(`
                UPDATE "ImportJob"
                SET logs = $1::jsonb, "updatedAt" = NOW()
                WHERE id = $2
            `, [JSON.stringify(logsData), jobId]);
        } catch (e) {
            console.error(`Failed to update progress for job ${jobId}:`, e);
        }
    },

    /**
     * Finaliza o job com sucesso
     */
    async completeJob(jobId: string, logsData: any) {
        try {
            await pool.query(`
                UPDATE "ImportJob"
                SET status = 'COMPLETED', "completedAt" = NOW(), "updatedAt" = NOW(), logs = $1:: jsonb
                WHERE id = $2
                `, [JSON.stringify(logsData), jobId]);
        } catch (e) {
            console.error(`Failed to complete job ${jobId}:`, e);
        }
    },

    /**
     * Finaliza o job com falha
     */
    async failJob(jobId: string, logsData: any) {
        try {
            await pool.query(`
                UPDATE "ImportJob"
                SET status = 'FAILED', "updatedAt" = NOW(), logs = $1:: jsonb
                WHERE id = $2
                `, [JSON.stringify(logsData), jobId]);
        } catch (e) {
            console.error(`Failed to fail job ${jobId}:`, e);
        }
    },

    /**
     * Passo B e C: Insere a questão atrelada a uma disciplina (criando se necessário).
     * Inclui alternativas, e adiciona +10 xp.
     */
    async saveScrapedQuestion(userId: string, questionData: any) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Resolve Subject
            let subjectId;
            const subjectRes = await client.query(`
                SELECT id FROM "Subject" WHERE LOWER(name) = LOWER($1)
            `, [questionData.subjectName]);

            if (subjectRes.rows.length > 0) {
                subjectId = subjectRes.rows[0].id;
            } else {
                const newSubjRes = await client.query(`
                    INSERT INTO "Subject" (id, name, color, icon)
                    VALUES ($1, $2, '#3BB2F6', '📚')
                    ON CONFLICT (name) DO NOTHING
                    RETURNING id
                `, [crypto.randomUUID(), questionData.subjectName]);

                if (newSubjRes.rows.length > 0) {
                    subjectId = newSubjRes.rows[0].id;
                } else {
                    // Foi inserido por outro processo de background
                    const retrySubjRes = await client.query(`
                        SELECT id FROM "Subject" WHERE LOWER(name) = LOWER($1)
                    `, [questionData.subjectName]);
                    subjectId = retrySubjRes.rows[0].id;
                }
            }

            // 1.5. Check if Question already exists
            const existingQuestionRes = await client.query(`
                SELECT id FROM "Question" 
                WHERE text = $1 AND "subjectId" = $2
            `, [questionData.body, subjectId]);

            if (existingQuestionRes.rows.length > 0) {
                await client.query('ROLLBACK');
                return existingQuestionRes.rows[0].id;
            }

            // 2. Insert Question
            const questionId = crypto.randomUUID();
            const weekText = questionData.metadata?.semana || null;

            await client.query(`
                INSERT INTO "Question" (id, title, text, week, "createdAt", "updatedAt", views, "isVerified", "userId", "subjectId", "verificationRequested")
                VALUES ($1, $2, $3, $4, NOW(), NOW(), 0, true, $5, $6, false)
            `, [questionId, questionData.title, questionData.body, weekText, userId, subjectId]);

            // 3. Insert Alternatives
            for (const alt of questionData.alternatives) {
                await client.query(`
                    INSERT INTO "Alternative" (id, letter, text, "isCorrect", "questionId")
                    VALUES ($1, $2, $3, $4, $5)
                `, [crypto.randomUUID(), alt.letter, alt.content, alt.isCorrect, questionId]);
            }

            // 4. Insert Comment (Justification)
            if (questionData.justification && questionData.justification.trim() !== '') {
                const commentText = `**🎓 Gabarito Comentado (AVA):**\n\n${questionData.justification}`;
                await client.query(`
                    INSERT INTO "Comment" (id, text, "createdAt", "userId", "questionId", "isDeleted")
                    VALUES ($1, $2, NOW(), $3, $4, false)
                `, [crypto.randomUUID(), commentText, userId, questionId]);
            }

            // 5. Update Reputation Atomically
            await client.query(`
                UPDATE "User"
                SET reputation = reputation + 10
                WHERE id = $1
            `, [userId]);

            await client.query('COMMIT');
            return questionId;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    },

    /**
     * Passo 3: Salva o Histórico de Raspagem.
     */
    async saveScrapeHistory(userId: string, year: string, examId: string, examName: string) {
        try {
            await pool.query(`
                INSERT INTO "ScrapeHistory" (id, "userId", year, "examId", "examName", "completedAt")
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT ("userId", "examId") DO NOTHING
            `, [crypto.randomUUID(), userId, year, examId, examName]);
        } catch (e) {
            console.error('Failed to save scrape history:', e);
        }
    },

    /**
     * Busca os exames já finalizados pelo usuário
     */
    async getUserIgnoredExams(userId: string): Promise<string[]> {
        try {
            const { rows } = await pool.query(`
                SELECT "examName" FROM "ScrapeHistory" WHERE "userId" = $1
            `, [userId]);
            return rows.map((r: any) => r.examName);
        } catch (e) {
            console.error('Failed to get user ignored exams:', e);
            return [];
        }
    }

};


import { chromium, Browser } from 'playwright';
import { z } from "zod";

interface ScraperOptions {
    email: string;
    password: string;
    targetUrl: string;
    ignoredExams?: string[];
    onStatus: (step: string, message: string) => void;
    onQuestion: (question: any) => void;
    onExamDone: (examData: any) => void;
    checkActiveAbort?: () => Promise<boolean>;
}

export class ScraperService {
    private browser: Browser | null = null;
    private isAborted: boolean = false;
    private environment: string;

    constructor(environment: string) {
        console.log('Environment:', environment);
        this.environment = environment;
    }

    /**
     * Tenta executar uma função assíncrona até um limite de vezes,
     * aguardando entre as tentativas.
     */
    async withRetry<T>(fn: () => Promise<T>, maxRetries = 3, delayMs = 5000): Promise<T> {
        let attempts = 0;
        while (attempts < maxRetries) {
            try {
                return await fn();
            } catch (error: any) {
                attempts++;
                console.warn(`[Retry ${attempts}/${maxRetries}] Falha na execução: ${error.message}`);

                if (attempts >= maxRetries) {
                    throw new Error(`Falha após ${maxRetries} tentativas: ${error.message}`);
                }

                // Aguarda um tempo antes de tentar novamente (Exponential backoff simples)
                const waitTime = delayMs * attempts;
                console.log(`Aguardando ${waitTime}ms antes da próxima tentativa...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        throw new Error('Unreachable retry block');
    }

    async abort() {
        this.isAborted = true;
        if (this.browser) {
            try {
                console.log('🛑 Abortando navegador...');
                await this.browser.close();
            } catch (e) { /* Ignora erro se já fechou */ }
            this.browser = null;
        }
    }

    async scrape(options: ScraperOptions): Promise<void> {
        await this.withRetry(() => this._scrapeInner(options), 3, 10000);
    }

    private async _scrapeInner({ email, password, targetUrl, ignoredExams, onStatus, onQuestion, onExamDone, checkActiveAbort }: ScraperOptions): Promise<void> {
        try {
            onStatus('INIT', '🚀 Iniciando browser (Playwright)...');

            this.browser = await chromium.launch({
                headless: this.environment !== 'dev', // Use headless in production/WSL usually, or false for debug. 
                // Playwright handles headless much better.
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--window-size=1920,1080',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-popup-blocking',
                ]
            });

            // Create context with specific user agent
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1920, height: 1080 },
                locale: 'pt-BR',
                timezoneId: 'America/Sao_Paulo'
            });

            const page = await context.newPage();

            // Optimization - Block Resources via Route
            await page.route('**/*', (route) => {
                const resourceType = route.request().resourceType();
                if (['image', 'font'].includes(resourceType)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            // Simulate navigation to target
            onStatus('NAVIGATE', '🚗 Navegando para a URL...');
            await page.goto(targetUrl, { waitUntil: 'networkidle' });
            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
            if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

            onStatus('LOGIN', '🔐 Autenticando...');

            const emailSchema = z.string().email();
            const isValidEmail = emailSchema.safeParse(email);

            if (!isValidEmail.success) {
                await page.locator('#form\\:usuario').fill(email);
            } else {
                await page.locator('#form\\:email').fill(email);
            }

            await page.locator('#form\\:senha').fill(password);

            // Click and wait for navigation - Playwright handles this well, but explicit wait is safer for full page loads
            await Promise.all([
                page.waitForURL('**', { waitUntil: 'networkidle' }), // Wait for any URL change/load
                page.locator('#form\\:loginBtn\\:loginBtn').click(),
            ]);
            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
            if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

            // Optional stability delay
            await page.waitForTimeout(5000);

            onStatus('NAVIGATE', '🚗 Indo para a página de provas...');

            const btnProvas = page.locator('a[id$="botaoAcessoSistemaProvasMestreGR"]');


            // 3. Clique com FORCE: TRUE
            // O force: true é vital aqui porque o RichFaces as vezes coloca spans transparentes em cima dos botões.
            console.log('✅ Botão encontrado via seletor. Clicando...');

            // Tratamento de Nova Aba (Popup)
            const [newPage] = await Promise.all([
                page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
                btnProvas.click({ force: true }) // <--- O SEGREDO ESTÁ AQUI
            ]);

            // ... (lógica de verificar se abriu newPage ou continuou na mesma, igual antes)
            let activePage = newPage || page;

            if (newPage) await newPage.waitForLoadState('domcontentloaded');
            else await page.waitForLoadState('networkidle');

            console.log('📍 URL Pós-clique:', activePage.url());

            onStatus('NAVIGATE', 'Clicando para acessar sistema de provas...');

            // const [newPage] = await Promise.all([
            //     // 1. Mude de 'page' para 'popup'
            //     // 2. Reduza o timeout para 10s (10000ms). Se não abrir nesse tempo, assumimos que não abriu.
            //     page.waitForEvent('popup', { timeout: 10000 }).catch((e) => {
            //         console.log('⚠️ Nenhuma nova aba/popup detectada (timeout), continuando na mesma página.');
            //         return null;
            //     }),
            //     page.evaluate(() => {
            //         // @ts-ignore
            //         if (typeof window.RichFaces !== 'undefined') {
            //             // @ts-ignore
            //             window.RichFaces.ajax(
            //                 "form:j_idt577:botaoAcessoSistemaProvasMestreGR",
            //                 null,
            //                 { incId: "1" }
            //             );
            //         } else {
            //             console.error('RichFaces não encontrado no window!');
            //         }
            //     })
            // ]);

            // Se newPage existir, use-o. Se for null, continue na page atual.
            // let activePage = newPage || page;

            // Se for um popup, precisamos garantir que ele carregou
            // if (newPage) {
            //     await newPage.waitForLoadState('domcontentloaded');
            // } else {
            //     // Se continuou na mesma página, talvez tenha ocorrido apenas um redirect ou AJAX
            //     // Esperamos a rede acalmar para garantir
            //     await page.waitForLoadState('networkidle');
            // }

            console.log('URL Ativa:', activePage.url());

            onStatus('NAVIGATE', '🚗 Página de provas aberta...');

            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
            if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

            const menuResultados = activePage.locator('span').filter({ hasText: 'Resultados' }).first();
            await menuResultados.waitFor({ state: 'visible' });
            await menuResultados.hover();

            await menuResultados.dispatchEvent('mouseenter');
            await menuResultados.dispatchEvent('mouseover');

            const linkAvaliacoes = activePage.locator('a').filter({ hasText: 'Avaliações' }).first();
            await linkAvaliacoes.waitFor({ state: 'attached', timeout: 3000 });

            const hrefAvaliacoes = await linkAvaliacoes.getAttribute('href');

            if (!hrefAvaliacoes) {
                throw new Error('Href de Avaliações não encontrado');
            }

            if (hrefAvaliacoes.startsWith('http') || hrefAvaliacoes.startsWith('/')) {
                await activePage.goto(hrefAvaliacoes);
            } else {
                await linkAvaliacoes.click();
                await activePage.waitForLoadState('networkidle');
            }


            onStatus('ANALYZING', '📅 Mapeando anos letivos disponíveis...');

            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
            if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

            const yearSelectSelector = 'xpath=//h4[contains(., "Ano letivo:")]/../following-sibling::div//select';

            await activePage.locator(yearSelectSelector).waitFor({ state: 'attached' });

            const yearsData = await activePage.locator(yearSelectSelector).locator('option').evaluateAll((options) => {
                return options
                    .map(opt => ({
                        value: opt.getAttribute('value'), // É a URL: runner.php?...
                        label: opt.textContent?.trim() || ''       // Ex: 2021, 2022
                    }))
                    .filter(opt => opt.value && opt.value !== "" && opt.label !== "SELECIONE ANO");
            });

            console.log(`Anos encontrados: ${yearsData.map(y => y.label).join(', ')}`);

            for (const year of yearsData) {

                if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
                if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

                console.log(`Verificando ano: ${year.label}...`);

                onStatus('PROCESSING', `📂 Verificando ano: ${year.label}...`);

                const currentYearValue = await activePage.locator(yearSelectSelector).inputValue();

                console.log(`   -> Ano atual: ${currentYearValue}`);
                console.log(`   -> Ano alvo: ${year.value}`);
                if (currentYearValue !== year.value) {
                    await Promise.all([
                        activePage.waitForResponse(resp => resp.status() === 200, { timeout: 10000 }).catch(() => { }), // Tenta pegar o request XHR
                        activePage.waitForLoadState('networkidle'),
                        activePage.locator(yearSelectSelector).selectOption(year.value)
                    ]);

                    // Pequeno delay de estabilidade para garantir que o JS do select de Provas rodou
                    await activePage.waitForTimeout(5000);
                }

                const verifiedYear = await activePage.locator(yearSelectSelector).inputValue();
                if (verifiedYear !== year.value) {
                    console.error(`❌ Falha ao mudar para o ano ${year.label}. O sistema manteve ${verifiedYear}. Tentando novamente...`);
                    // Retry logic ou Skip
                    onStatus('ERROR', `❌ Falha ao mudar para o ano ${year.label}. O sistema manteve ${verifiedYear}. Tentando novamente...`);
                    continue;
                }

                // 4. Agora verificamos o select de Provas (name="PROVA")
                const provasSelectSelector = 'select[name="PROVA"]';
                await activePage.locator(provasSelectSelector).waitFor({ state: 'visible' });

                // Extrair as provas disponíveis neste ano
                const availableExams = await activePage.locator(`${provasSelectSelector} option`).evaluateAll((options) => {
                    return options
                        .map(opt => ({
                            value: opt.getAttribute('value'),
                            text: opt.textContent.trim()
                        }))
                        // Filtra a opção padrão "Nenhum registro encontrado" ou vazias
                        .filter(opt =>
                            opt.value !== "" &&
                            !opt.text.toLowerCase().includes("nenhum registro")
                        );
                });

                if (availableExams.length > 0) {
                    onStatus('FOUND', `✅ Encontradas ${availableExams.length} prova(s) em ${year.label}`);
                    console.log(`   -> Provas encontradas: ${availableExams.map(exam => exam.text).join(', ')}`);

                    // --- AQUI VOCÊ INICIA A EXTRAÇÃO DA PROVA ---
                    for (const exam of availableExams) {

                        if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
                        if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

                        console.log(`   -> Processando prova: ${exam.text} (${exam.value})`);
                        const disciplinas = ['INT100', 'LET100', 'MATE100', 'MMB002'];

                        // Exemplo de lógica para selecionar a prova (se ela também causar reload)
                        await Promise.all([
                            activePage.waitForLoadState('networkidle', { timeout: 120000 }),
                            activePage.locator(provasSelectSelector).selectOption(exam.value, { timeout: 120000 })
                        ]);

                        await activePage.waitForTimeout(5500);

                        console.log(`   -> Ambiente: ${this.environment}`);
                        if (this.environment === 'dev') {
                            if (disciplinas.some(disciplina => exam.text.includes(disciplina))) {
                                console.log(`   -> Prova ${exam.text} não pertence à disciplina ${disciplinas.join(', ')} Pula...`);
                                continue;
                            }
                        }

                        console.log(`Ignored exams: ${ignoredExams}`);
                        console.log(`Exam text: ${exam.text}`);
                        console.log(`Validating: ${exam.text && ignoredExams?.includes(exam.text)}`)
                        if (exam.text && ignoredExams?.includes(exam.text)) {
                            console.log(` ⏭️ Pulando prova já processada: ${exam.text}`);
                            onStatus('SKIPPED', `⏭️ Pulando prova já processada: ${exam.text}`);
                            continue; // Vai para a próxima prova imediatamente
                        }

                        try {
                            await activePage.locator('button').filter({ hasText: /^Q0?1/ }).first().waitFor({ state: 'visible', timeout: 10000 });
                        } catch (e) {
                            console.log("   ⚠️ Botões de questão não apareceram. Talvez a prova esteja vazia ou expirada.");
                            continue; // Pula para a próxima prova se não carregar
                        }

                        console.log(`Working on URL: ${activePage.url()}`);

                        // get subject name from exam text
                        const subjectRaw = exam.text.split(' - ');

                        const subjectName = subjectRaw[1].length > 6 ? subjectRaw[1].trim() : subjectRaw[2].trim();

                        const questionButtons = activePage.locator('button').filter({ hasText: /^Q\d+/ });

                        const totalQuestions = await questionButtons.count();
                        onStatus('INFO', `📝 Encontradas ${totalQuestions} questões para extrair.`);

                        console.log(`   -> Encontradas ${totalQuestions} questões para extrair.`);

                        for (let i = 0; i < totalQuestions; i++) {

                            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
                            if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

                            const currentButtons = await activePage.locator('button').filter({ hasText: /^Q\d+/ }).all();

                            // Verifica se o botão existe
                            if (i >= currentButtons.length) break;

                            const button = currentButtons[i];
                            const buttonText = await button.innerText(); // Ex: "Q01"

                            onStatus('PROCESSING', `👉 Processando questão ${buttonText}...`);
                            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
                            if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

                            await activePage.waitForTimeout(3500);

                            // Clicar e esperar navegação
                            await Promise.all([
                                activePage.waitForLoadState('networkidle'),
                                button.click()
                            ]);

                            await activePage.waitForTimeout(1500);

                            // --- 1. Extração do Enunciado ---
                            const statementEl = activePage.locator('.col-md-7.resposta > div').first();
                            try {
                                await statementEl.waitFor({ state: 'visible', timeout: 15000 });
                            } catch (e) {
                                console.log(`⚠️ Enunciado não carregou para a questão ${buttonText}. Tentando clicar novamente.`);
                                await button.click({ force: true });
                                await activePage.waitForTimeout(2000);
                                await statementEl.waitFor({ state: 'visible', timeout: 10000 });
                            }
                            const statementText = await statementEl.innerText();

                            // --- 2. Extração da Justificativa ---
                            const justificationEl = activePage.locator('blockquote');
                            let justificationText: string | null = null;

                            if (await justificationEl.count() > 0) {
                                const rawJustification = await justificationEl.innerText();
                                justificationText = rawJustification
                                    .replace('Justificativa sobre todas as alternativas (corretas e incorretas)', '')
                                    .trim();
                            }

                            // --- 3. Extração das Alternativas ---
                            const alternativesData = await activePage.locator('.col-md-5').first().evaluate((node) => {
                                const el = node as HTMLElement;
                                const cleanText = (t) => t.replace(/\s+/g, ' ').trim();

                                let correctLetter: string | null = null;
                                let selectedLetter: string | null = null;

                                const spans = el.querySelectorAll('span');
                                spans.forEach(span => {
                                    const style = span.getAttribute('style') || '';
                                    const text = span.innerText;

                                    if (style.includes('#00a000') || text.includes('CORRETA')) {
                                        const match = span.innerText.match(/([A-E])\)/);
                                        if (match) correctLetter = match[1];
                                    }

                                    if (style.includes('#ff0000') || text.includes('ERRADA')) {
                                        const match = span.innerText.match(/([A-E])\)/);
                                        if (match) selectedLetter = match[1];
                                    }
                                });

                                if (!selectedLetter && correctLetter) {
                                    selectedLetter = correctLetter;
                                }

                                let fullText = el.innerText;
                                fullText = fullText
                                    .replace(/Você marcou a alternativa ERRADA/g, '')
                                    .replace(/CORRETA/g, '')
                                    .replace(/Justificativa sobre todas as alternativas.*/g, '');

                                const optionsRegex = /([A-E])\)\s+([\s\S]+?)(?=(?:[A-E]\))|$)/g;
                                const results: { letter: string; content: string; isCorrect: boolean; isSelected: boolean; }[] = [];
                                let match;

                                while ((match = optionsRegex.exec(fullText)) !== null) {
                                    const letter = match[1];
                                    let text = cleanText(match[2]);

                                    if (letter === 'E') {
                                        const metaIndex = text.indexOf('Semana:');
                                        if (metaIndex !== -1) {
                                            text = text.substring(0, metaIndex).trim();
                                        }
                                    }

                                    let status = 'neutral';
                                    if (letter === correctLetter) status = 'correct';
                                    else if (letter === selectedLetter && selectedLetter !== correctLetter) status = 'wrong';

                                    results.push({
                                        letter,
                                        content: text,
                                        isCorrect: (letter === correctLetter),
                                        isSelected: (letter === selectedLetter)
                                    });
                                }

                                const metaText = el.innerText;
                                const semanaMatch = metaText.match(/Semana:\s*(.+?)(?:\/|$)/);
                                const dificuldadeMatch = metaText.match(/Nível de Dificuldade:\s*(.+?)(?:\n|$)/);
                                const objetivoMatch = metaText.match(/Objetivo de Aprendizado:\s*([\s\S]+?)$/);

                                return {
                                    alternatives: results,
                                    meta: {
                                        semana: semanaMatch ? cleanText(semanaMatch[1]) : null,
                                        dificuldade: dificuldadeMatch ? cleanText(dificuldadeMatch[1]) : null,
                                        objetivo: objetivoMatch ? cleanText(objetivoMatch[1]) : null
                                    }
                                };
                            });

                            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
                            if (checkActiveAbort && await checkActiveAbort()) throw new Error('ABORTED_BY_USER');

                            // 4. Montagem do Objeto Final
                            const questionObj = {
                                id: buttonText,
                                subjectName,
                                statement: statementText,
                                alternatives: alternativesData.alternatives,
                                justification: justificationText,
                                metadata: alternativesData.meta,
                                images: [] as string[]
                            };

                            const images = await activePage.locator('.resposta img').evaluateAll(imgs => imgs.map(img => (img as HTMLImageElement).src));
                            questionObj.images = images;

                            onQuestion(questionObj);
                            console.log(`   -> Questão ${buttonText} processada.`);
                        }

                        if (onExamDone) {
                            console.log(`   -> Exame ${exam.text} processado.`);
                            onStatus('EXAM_DONE', `Exame ${exam.text} processado.`);
                            onExamDone({
                                year: year.label,
                                examId: exam.value,
                                examName: exam.text
                            });
                        }

                        // Chamar sua função de extração de questões aqui...
                    }

                } else {
                    console.log(`   -> Nenhuma prova em ${year.label}.`);
                }
            }

            onStatus('DONE', '🏁 Verificação de todos os anos concluída.');

        } catch (error: any) {
            console.error('Scraper Inner Error:', error);
            if (this.isAborted || error.message === 'ABORTED_BY_USER') throw new Error('Processo cancelado pelo usuário.');
            throw error;
        } finally {
            if (this.browser) {
                onStatus('CLEANUP', '🧹 Fechando recursos para possível retentativa...');
                await this.browser.close();
                this.browser = null;
            }
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScraperService = void 0;
const playwright_1 = require("playwright");
const zod_1 = require("zod");
class ScraperService {
    constructor() {
        this.browser = null;
    }
    async scrape({ email, password, targetUrl, onStatus, onQuestion }) {
        try {
            onStatus('INIT', '🚀 Iniciando browser (Playwright)...');
            this.browser = await playwright_1.chromium.launch({
                headless: false, // Use headless in production/WSL usually, or false for debug. 
                // Playwright handles headless much better.
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                ]
            });
            // Create context with specific user agent
            const context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 720 }
            });
            const page = await context.newPage();
            // Optimization - Block Resources via Route
            await page.route('**/*', (route) => {
                const resourceType = route.request().resourceType();
                if (['image', 'font', 'media'].includes(resourceType)) {
                    route.abort();
                }
                else {
                    route.continue();
                }
            });
            // Simulate navigation to target
            onStatus('NAVIGATE', '🚗 Navegando para a URL...');
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
            onStatus('LOGIN', '🔐 Autenticando...');
            const emailSchema = zod_1.z.string().email();
            const isValidEmail = emailSchema.safeParse(email);
            if (!isValidEmail.success) {
                await page.locator('#form\\:usuario').fill(email);
            }
            else {
                await page.locator('#form\\:email').fill(email);
            }
            await page.locator('#form\\:senha').fill(password);
            // Click and wait for navigation - Playwright handles this well, but explicit wait is safer for full page loads
            await Promise.all([
                page.waitForURL('**', { waitUntil: 'domcontentloaded' }), // Wait for any URL change/load
                page.locator('#form\\:loginBtn\\:loginBtn').click(),
            ]);
            // Optional stability delay
            await page.waitForTimeout(2000);
            onStatus('NAVIGATE', '🚗 Indo para a página de provas...');
            const btnSistemaProvas = page.locator('a:has(span.tituloCampos:text("Sistema de Provas"))');
            await btnSistemaProvas.scrollIntoViewIfNeeded();
            const [popup] = await Promise.all([
                page.waitForEvent('popup', { timeout: 5000 }).catch(() => null),
                btnSistemaProvas.click({ force: true })
            ]);
            const activePage = popup || page;
            await activePage.waitForLoadState('domcontentloaded');
            console.log(`Working on URL: ${activePage.url()}`);
            onStatus('NAVIGATE', '🚗 Página de provas aberta...');
            const menuResultados = activePage.locator('span').filter({ hasText: 'Resultados' }).first();
            await menuResultados.waitFor({ state: 'visible' });
            await menuResultados.hover();
            await menuResultados.dispatchEvent('mouseenter');
            await menuResultados.dispatchEvent('mouseover');
            const linkAvaliacoes = activePage.locator('a').filter({ hasText: 'Avaliações' }).first();
            await linkAvaliacoes.waitFor({ state: 'attached', timeout: 10000 });
            const hrefAvaliacoes = await linkAvaliacoes.getAttribute('href');
            if (!hrefAvaliacoes) {
                throw new Error('Href de Avaliações não encontrado');
            }
            if (hrefAvaliacoes.startsWith('http') || hrefAvaliacoes.startsWith('/')) {
                await activePage.goto(hrefAvaliacoes);
            }
            else {
                await linkAvaliacoes.click();
                await activePage.waitForLoadState('domcontentloaded');
            }
            onStatus('ANALYZING', '📅 Mapeando anos letivos disponíveis...');
            const yearSelectSelector = 'xpath=//h4[contains(., "Ano letivo:")]/../following-sibling::div//select';
            await activePage.locator(yearSelectSelector).waitFor({ state: 'attached' });
            const yearsData = await activePage.locator(yearSelectSelector).locator('option').evaluateAll((options) => {
                return options
                    .map(opt => ({
                    value: opt.getAttribute('value'), // É a URL: runner.php?...
                    label: opt.textContent?.trim() || '' // Ex: 2021, 2022
                }))
                    .filter(opt => opt.value && opt.value !== "" && opt.label !== "SELECIONE ANO");
            });
            console.log(`Anos encontrados: ${yearsData.map(y => y.label).join(', ')}`);
            for (const year of yearsData) {
                console.log(`Verificando ano: ${year.label}...`);
                onStatus('PROCESSING', `📂 Verificando ano: ${year.label}...`);
                const currentYearValue = await activePage.locator(yearSelectSelector).inputValue();
                if (currentYearValue !== year.value) {
                    await Promise.all([
                        activePage.waitForLoadState('domcontentloaded'),
                        // activePage.waitForURL((url) => url.toString().includes(year.value)), 
                        activePage.locator(yearSelectSelector).selectOption(year.value)
                    ]);
                    // Pequeno delay de estabilidade para garantir que o JS do select de Provas rodou
                    await activePage.waitForTimeout(1000);
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
                        .filter(opt => opt.value !== "" &&
                        !opt.text.toLowerCase().includes("nenhum registro"));
                });
                if (availableExams.length > 0) {
                    onStatus('FOUND', `✅ Encontradas ${availableExams.length} prova(s) em ${year.label}`);
                    // --- AQUI VOCÊ INICIA A EXTRAÇÃO DA PROVA ---
                    for (const exam of availableExams) {
                        console.log(`   -> Processando prova: ${exam.text} (${exam.value})`);
                        // Exemplo de lógica para selecionar a prova (se ela também causar reload)
                        await Promise.all([
                            activePage.waitForLoadState('domcontentloaded'),
                            activePage.locator(provasSelectSelector).selectOption(exam.value)
                        ]);
                        const questionLinks = await activePage.locator('a:has(button:text-matches("Q\\d+"))').all();
                        const totalQuestions = questionLinks.length;
                        onStatus('INFO', `📝 Encontradas ${totalQuestions} questões para extrair.`);
                        for (let i = 0; i < totalQuestions; i++) {
                            const currentButtons = await activePage.locator('a:has(button:text-matches("Q\\d+"))').all();
                            // Verifica se o botão existe
                            if (i >= currentButtons.length)
                                break;
                            const button = currentButtons[i];
                            const buttonText = await button.innerText(); // Ex: "Q01"
                            onStatus('PROCESSING', `👉 Processando questão ${buttonText}...`);
                            // Clicar e esperar navegação
                            // Verificamos se já estamos na questão certa (se o botão tiver uma classe ativa, por exemplo btn-red vs btn-default)
                            // Mas por segurança, clicamos para garantir.
                            await Promise.all([
                                activePage.waitForLoadState('domcontentloaded'),
                                button.click()
                            ]);
                            await activePage.waitForTimeout(500);
                            // --- 1. Extração do Enunciado ---
                            // O enunciado está dentro de .col-md-7.resposta > div (com borda tracejada)
                            const statementEl = activePage.locator('.col-md-7.resposta > div').first();
                            const statementText = await statementEl.innerText();
                            // --- 2. Extração da Justificativa ---
                            // Está dentro de um blockquote, geralmente com a classe blockquote-green
                            const justificationEl = activePage.locator('blockquote');
                            let justificationText = null;
                            if (await justificationEl.count() > 0) {
                                const rawJustification = await justificationEl.innerText();
                                // Remove o título padrão que vem no texto
                                justificationText = rawJustification
                                    .replace('Justificativa sobre todas as alternativas (corretas e incorretas)', '')
                                    .trim();
                            }
                            // --- 3. Extração das Alternativas (Lógica Refinada) ---
                            // Aqui usamos evaluate para rodar JS no navegador, pois o HTML mistura nós de texto e spans
                            const alternativesData = await activePage.locator('.col-md-5').first().evaluate((node) => {
                                const el = node;
                                // Função auxiliar para limpar espaços extras
                                const cleanText = (t) => t.replace(/\s+/g, ' ').trim();
                                // 1. Identificar metadados visuais (Correta / Selecionada) antes de limpar o texto
                                const htmlContent = el.innerHTML;
                                // No HTML fornecido:
                                // Errada do usuário: <span style="color: #ff0000;">... <b>C) ...</b></span>
                                // Correta: <span style="color: #00a000;">CORRETA<br><b>D) ...</b></span>
                                // Vamos varrer os spans para achar as letras marcadas
                                let correctLetter = null;
                                let selectedLetter = null; // A que o usuário marcou (se errou) or acertou
                                const spans = el.querySelectorAll('span');
                                spans.forEach(span => {
                                    const style = span.getAttribute('style') || '';
                                    const text = span.innerText;
                                    // Identifica a VERDE (Gabarito Oficial)
                                    if (style.includes('#00a000') || text.includes('CORRETA')) {
                                        // Tenta achar a letra dentro deste span (Ex: "CORRETA D)")
                                        const match = span.innerText.match(/([A-E])\)/);
                                        if (match)
                                            correctLetter = match[1];
                                        // Se não houver marcação vermelha na questão, o usuário acertou esta
                                        // Mas vamos checar a vermelha para garantir
                                    }
                                    // Identifica a VERMELHA (Erro do usuário)
                                    if (style.includes('#ff0000') || text.includes('ERRADA')) {
                                        const match = span.innerText.match(/([A-E])\)/);
                                        if (match)
                                            selectedLetter = match[1];
                                    }
                                });
                                // Se o usuário acertou, não tem span vermelho, então a selecionada é a correta
                                if (!selectedLetter && correctLetter) {
                                    // Verificar se existe algum indicativo de que o usuário acertou, 
                                    // mas geralmente se não tem erro, é acerto.
                                    // No seu HTML, quando erra aparece "Você marcou...", quando acerta só aparece "CORRETA" (que vira a selecionada).
                                    // Vamos assumir logicamente:
                                    selectedLetter = correctLetter;
                                    // PORÉM: Precisamos ter cuidado. Se o aluno deixou em branco? 
                                    // O sistema da Univesp geralmente marca a correta em verde sempre.
                                }
                                // Caso de erro explícito: selectedLetter será diferente de correctLetter.
                                // 2. Extração e Limpeza do Texto das Alternativas
                                // Pegamos o texto completo do container e usamos Regex para separar
                                let fullText = el.innerText;
                                // Removemos as frases do sistema para não sujar o texto da alternativa
                                fullText = fullText
                                    .replace(/Você marcou a alternativa ERRADA/g, '')
                                    .replace(/CORRETA/g, '')
                                    .replace(/Justificativa sobre todas as alternativas.*/g, ''); // Caso o bloco pegue texto demais
                                // Regex para capturar "A) Texto... B) Texto..."
                                // O padrão é Letra, fecha parêntese, conteúdo, até a próxima Letra ou fim
                                const optionsRegex = /([A-E])\)\s+([\s\S]+?)(?=(?:[A-E]\))|$)/g;
                                const results = [];
                                let match;
                                while ((match = optionsRegex.exec(fullText)) !== null) {
                                    const letter = match[1];
                                    let text = cleanText(match[2]);
                                    // Remove metadados do final se vazaram (ex: infos de semana/dificuldade)
                                    if (letter === 'E') {
                                        // A última alternativa (E) geralmente vem seguida dos metadados da questão
                                        // Vamos cortar onde começam os metadados
                                        const metaIndex = text.indexOf('Semana:');
                                        if (metaIndex !== -1) {
                                            text = text.substring(0, metaIndex).trim();
                                        }
                                    }
                                    let status = 'neutral';
                                    if (letter === correctLetter)
                                        status = 'correct';
                                    else if (letter === selectedLetter && selectedLetter !== correctLetter)
                                        status = 'wrong';
                                    results.push({
                                        letter,
                                        content: text,
                                        isCorrect: (letter === correctLetter),
                                        isSelected: (letter === selectedLetter) // Aproximação
                                    });
                                }
                                // 3. Extrair Metadados Extras que ficam no rodapé da div col-md-5
                                const metaText = el.innerText; // Texto original sujo
                                const disciplina = 'INT100'; // Você pode passar isso via argumento se quiser
                                const semanaMatch = metaText.match(/Semana:\s*(.+?)(?:\/|$)/);
                                const dificuldadeMatch = metaText.match(/Nível de Dificuldade:\s*(.+?)(?:\n|$)/);
                                const objetivoMatch = metaText.match(/Objetivo de Aprendizado:\s*([\s\S]+?)$/); // Pega até o fim
                                return {
                                    alternatives: results,
                                    meta: {
                                        semana: semanaMatch ? cleanText(semanaMatch[1]) : null,
                                        dificuldade: dificuldadeMatch ? cleanText(dificuldadeMatch[1]) : null,
                                        objetivo: objetivoMatch ? cleanText(objetivoMatch[1]) : null
                                    }
                                };
                            });
                            // 4. Montagem do Objeto Final
                            const questionObj = {
                                id: buttonText, // Ex: "Q01"
                                statement: statementText,
                                alternatives: alternativesData.alternatives,
                                justification: justificationText,
                                metadata: alternativesData.meta,
                                images: [] // Implementar extração de imagens se houver tags <img> dentro de .resposta
                            };
                            // Extrair URLs de imagens se houver (Enunciado ou Justificativa)
                            const images = await activePage.locator('.resposta img').evaluateAll(imgs => imgs.map(img => img.src));
                            questionObj.images = images;
                            onQuestion(questionObj);
                            console.log(`   -> Questão ${buttonText} processada.`);
                        }
                        // Chamar sua função de extração de questões aqui...
                    }
                }
                else {
                    console.log(`   -> Nenhuma prova em ${year.label}.`);
                }
            }
            onStatus('DONE', '🏁 Verificação de todos os anos concluída.');
            // for (const q of mockQuestions) {
            //     await page.waitForTimeout(500);
            //     onQuestion(q);
            // }
        }
        catch (error) {
            console.error('Scraper Error:', error);
            throw error;
        }
        finally {
            if (this.browser) {
                onStatus('CLEANUP', '🧹 Fechando recursos...');
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
exports.ScraperService = ScraperService;

import { Builder, By, Key, until, WebDriver, WebElement } from 'selenium-webdriver';
import { Options as ChromeOptions } from 'selenium-webdriver/chrome';
import { z } from "zod";

interface ScraperOptions {
    email: string;
    password: string;
    targetUrl: string;
    ignoredExams?: string[];
    onStatus: (step: string, message: string) => void;
    onQuestion: (question: any) => void;
    onExamDone: (examData: any) => void;
}

const ENVIRONMENT = process.env.ENVIRONMENT || "prod";

export class ScraperServiceSelenium {
    private driver: WebDriver | null = null;
    private isAborted: boolean = false;

    async abort() {
        this.isAborted = true;
        if (this.driver) {
            try {
                console.log('🛑 Abortando navegador...');
                await this.driver.quit();
            } catch (e) { /* Ignora erro se já fechou */ }
            this.driver = null;
        }
    }

    async scrape({ email, password, targetUrl, ignoredExams, onStatus, onQuestion, onExamDone }: ScraperOptions): Promise<void> {
        try {
            onStatus('INIT', '🚀 Iniciando browser (Selenium)...');

            const options = new ChromeOptions();
            // Descomente headless se necessário
            // options.addArguments('--headless'); 
            options.addArguments('--no-sandbox');
            options.addArguments('--disable-dev-shm-usage');
            options.addArguments('--disable-gpu');
            options.addArguments('user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            options.addArguments('window-size=1280,720');

            this.driver = await new Builder()
                .forBrowser('chrome')
                .setChromeOptions(options)
                .build();

            // Navegação Inicial
            onStatus('NAVIGATE', '🚗 Navegando para a URL...');
            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');

            await this.driver.get(targetUrl);

            onStatus('LOGIN', '🔐 Autenticando...');

            const emailSchema = z.string().email();
            const isValidEmail = emailSchema.safeParse(email);

            // Wait for form to be present
            await this.driver.wait(until.elementLocated(By.id('form:loginBtn:loginBtn')), 15000);

            if (!isValidEmail.success) {
                const userField = await this.driver.findElement(By.id('form:usuario'));
                await userField.sendKeys(email);
            } else {
                const emailField = await this.driver.findElement(By.id('form:email'));
                await emailField.sendKeys(email);
            }

            const passField = await this.driver.findElement(By.id('form:senha'));
            await passField.sendKeys(password);

            const loginBtn = await this.driver.findElement(By.id('form:loginBtn:loginBtn'));
            await loginBtn.click();

            // Esperar navegar (check URL or element)
            await this.driver.wait(until.urlContains('visaoAluno'), 20000); // Exemplo de check

            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');

            // Espera estabilidade
            await this.driver.sleep(5000);

            onStatus('NAVIGATE', '🚗 Indo para a página de provas...');

            // DEBUG: List all links
            const allLinks = await this.driver.findElements(By.tagName('a'));
            const linkTexts = await Promise.all(allLinks.map(l => l.getText()));
            console.log('🔗 Links visíveis:', linkTexts.map(t => t.trim()).filter(t => t.length > 0));

            // Encontrar botão Sistema de Provas
            // XPath mais robusto para text contains
            const sistemaProvasBtn = await this.driver.findElement(By.xpath("//a[.//span[contains(@class, 'tituloCampos') and contains(text(), 'Sistema de Provas')]]"));

            // Scroll into view - center to avoid headers
            await this.driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", sistemaProvasBtn);
            await this.driver.sleep(1000);

            // Handle Popup
            const driver = this.driver!;
            const originalWindow = await driver.getWindowHandle();
            const existingWindows = await driver.getAllWindowHandles();

            // Try robust click strategy
            try {
                console.log("Attempting normal click...");
                await sistemaProvasBtn.click();
            } catch (e) {
                console.log("⚠️ Normal click failed/blocked. Attempting JS Click (force)...");
                await this.driver.executeScript("arguments[0].click();", sistemaProvasBtn);
            }

            // Wait for new window
            let newWindowHandle: string | null = null;
            try {
                await driver.wait(async () => {
                    const handles = await driver.getAllWindowHandles();
                    const newHandles = handles.filter(h => !existingWindows.includes(h));
                    if (newHandles.length > 0) {
                        newWindowHandle = newHandles[0];
                        return true;
                    }
                    return false;
                }, 30000);
            } catch (e) {
                console.log('⚠️ Nenhum popup detectado pelo Selenium, checando se houve navegação na mesma aba...');
            }

            if (newWindowHandle) {
                console.log('📢 Popup detectado (Selenium)! Switch to it.');
                await this.driver.switchTo().window(newWindowHandle);
            } else {
                console.log('⚠️ Assumindo navegação na mesma aba.');
            }

            console.log(`Working on URL: ${await this.driver.getCurrentUrl()}`);
            onStatus('NAVIGATE', '🚗 Página de provas aberta...');

            if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');

            // Wait for Resultados logic
            const menuResultados = await this.driver.wait(until.elementLocated(By.xpath("//span[contains(text(), 'Resultados')]")), 30000);
            await this.driver.wait(until.elementIsVisible(menuResultados), 10000);

            // Hover logic in Selenium
            const actions = this.driver.actions({ async: true });
            await actions.move({ origin: menuResultados }).perform();

            // Click Avaliações
            const linkAvaliacoes = await this.driver.wait(until.elementLocated(By.xpath("//a[contains(text(), 'Avaliações')]")), 5000);
            // Wait for href
            const hrefAvaliacoes = await linkAvaliacoes.getAttribute('href');

            if (hrefAvaliacoes && (hrefAvaliacoes.startsWith('http') || hrefAvaliacoes.startsWith('/'))) {
                await this.driver.get(hrefAvaliacoes);
            } else {
                await linkAvaliacoes.click();
            }

            // Wait for year select
            const yearSelectSelect = By.xpath('//h4[contains(., "Ano letivo:")]/../following-sibling::div//select');
            const yearSelectEl = await this.driver.wait(until.elementLocated(yearSelectSelect), 20000);

            // Map years
            const yearOptions = await yearSelectEl.findElements(By.tagName('option'));
            const yearsData: { value: string, label: string }[] = [];
            for (const opt of yearOptions) {
                const val = await opt.getAttribute('value');
                const txt = await opt.getText();
                if (val && val !== "" && txt !== "SELECIONE ANO") {
                    yearsData.push({ value: val, label: txt.trim() });
                }
            }

            console.log(`Anos encontrados: ${yearsData.map(y => y.label).join(', ')}`);

            for (const year of yearsData) {
                if (this.isAborted) throw new Error('Processo cancelado pelo usuário.');
                console.log(`Verificando ano: ${year.label}...`);
                onStatus('PROCESSING', `📂 Verificando ano: ${year.label}...`);

                // Re-locate select to avoid stale element
                const freshYearSelect = await this.driver.findElement(yearSelectSelect);
                const currentVal = await freshYearSelect.getAttribute('value');

                if (currentVal !== year.value) {
                    // Select option
                    // Using sendKeys or clicking option
                    // Best generic way:
                    await freshYearSelect.findElement(By.css(`option[value="${year.value}"]`)).click(); // May not work on all selects, but commonly does
                    // Or sendKeys
                    // await freshYearSelect.sendKeys(year.label); 

                    // Selenium wait for reload is tricky. Assuming page reload or AJAX?
                    // Let's wait for staleness of the select or a loading indicator
                    await this.driver.sleep(3000); // Simpler stability wait
                }

                // Check Provas
                const provasSelectSelector = By.name('PROVA');
                const provasSelect = await this.driver.wait(until.elementLocated(provasSelectSelector), 10000);

                const provaOptions = await provasSelect.findElements(By.tagName('option'));
                const availableExams: { value: string, text: string }[] = [];
                for (const opt of provaOptions) {
                    const val = await opt.getAttribute('value');
                    const txt = await opt.getText();
                    if (val !== "" && !txt.toLowerCase().includes("nenhum registro")) {
                        availableExams.push({ value: val, text: txt.trim() });
                    }
                }

                if (availableExams.length > 0) {
                    onStatus('FOUND', `✅ Encontradas ${availableExams.length} prova(s) em ${year.label}`);

                    for (const exam of availableExams) {
                        if (this.isAborted) throw new Error('Cancelado.');

                        // Select Exam
                        const freshProvasSelect = await this.driver.findElement(provasSelectSelector);
                        await freshProvasSelect.findElement(By.css(`option[value="${exam.value}"]`)).click();
                        await this.driver.sleep(1500);

                        const subjectName = exam.text.split(' - ')[1]?.trim() || exam.text;

                        onStatus('PROCESSING', `👉 Processando prova: ${exam.text}`);

                        // Detect buttons Q01...
                        // Wait for at least one button
                        try {
                            await this.driver.wait(until.elementLocated(By.xpath("//button[contains(text(), 'Q01') or contains(text(), 'Q1')]")), 10000);
                        } catch (e) {
                            console.log(" ⚠️ Botões de questão não apareceram.");
                            continue;
                        }

                        // Find all Q buttons
                        // Using XPath regex equivalent or strict verify
                        // let qButtons = await this.driver.findElements(By.xpath("//button[starts-with(text(), 'Q')]")); 
                        // Better filtering
                        const outputButtons = await this.driver.findElements(By.tagName('button'));
                        const qButtons: WebElement[] = [];
                        for (const btn of outputButtons) {
                            const t = await btn.getText();
                            if (/^Q\d+/.test(t)) qButtons.push(btn);
                        }

                        const totalQuestions = qButtons.length;
                        onStatus('INFO', `📝 ${totalQuestions} questões.`);

                        for (let i = 0; i < totalQuestions; i++) {
                            if (this.isAborted) throw new Error('Cancelado.');

                            // Re-fetch buttons to avoid stale reference
                            const freshButtonsAll = await this.driver.findElements(By.tagName('button'));
                            const freshQButtons: WebElement[] = [];
                            for (const btn of freshButtonsAll) {
                                const t = await btn.getText();
                                if (/^Q\d+/.test(t)) freshQButtons.push(btn);
                            }

                            if (i >= freshQButtons.length) break;

                            const button = freshQButtons[i];
                            const btnText = await button.getText();

                            onStatus('PROCESSING', `👉 Questão ${btnText}...`);

                            await button.click();
                            await this.driver.sleep(1500); // Wait for AJAX load of question content

                            // Extract Statement
                            let statementText = "";
                            try {
                                const stEl = await this.driver.findElement(By.css('.col-md-7.resposta > div'));
                                statementText = await stEl.getText();
                            } catch (e) { }

                            // Extract Justification
                            let justificationText: string | null = null;
                            try {
                                const justEl = await this.driver.findElement(By.tagName('blockquote'));
                                const rawJust = await justEl.getText();
                                justificationText = rawJust.replace('Justificativa sobre todas as alternativas (corretas e incorretas)', '').trim();
                            } catch (e) { }

                            // Extract Alternatives via Execute Script (easier for complex logic)
                            const alternativesData = await this.driver.executeScript(function () {
                                const el = document.querySelector('.col-md-5');
                                if (!el) return null;

                                const cleanText = (t: string) => t.replace(/\s+/g, ' ').trim();
                                const htmlContent = el.innerHTML;

                                let correctLetter: string | null = null;
                                let selectedLetter: string | null = null;

                                const spans = el.querySelectorAll('span');
                                spans.forEach(span => {
                                    const style = span.getAttribute('style') || '';
                                    const text = (span as HTMLElement).innerText;

                                    if (style.includes('#00a000') || text.includes('CORRETA')) {
                                        const match = (span as HTMLElement).innerText.match(/([A-E])\)/);
                                        if (match) correctLetter = match[1];
                                    }
                                    if (style.includes('#ff0000') || text.includes('ERRADA')) {
                                        const match = (span as HTMLElement).innerText.match(/([A-E])\)/);
                                        if (match) selectedLetter = match[1];
                                    }
                                });
                                if (!selectedLetter && correctLetter) selectedLetter = correctLetter;

                                let fullText = (el as HTMLElement).innerText;
                                fullText = fullText
                                    .replace(/Você marcou a alternativa ERRADA/g, '')
                                    .replace(/CORRETA/g, '')
                                    .replace(/Justificativa sobre todas as alternativas.*/g, '');

                                const optionsRegex = /([A-E])\)\s+([\s\S]+?)(?=(?:[A-E]\))|$)/g;
                                const results: any[] = [];
                                let match;
                                while ((match = optionsRegex.exec(fullText)) !== null) {
                                    const letter = match[1];
                                    let text = cleanText(match[2]);
                                    const metaIndex = text.indexOf('Semana:');
                                    if (metaIndex !== -1) text = text.substring(0, metaIndex).trim();

                                    results.push({
                                        letter,
                                        content: text,
                                        isCorrect: (letter === correctLetter),
                                        isSelected: (letter === selectedLetter)
                                    });
                                }

                                const metaText = (el as HTMLElement).innerText;
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
                            }) as { alternatives: any[], meta: any } | null;


                            // Images
                            const images = await this.driver.executeScript(function () {
                                return Array.from(document.querySelectorAll('.resposta img')).map(img => (img as HTMLImageElement).src);
                            });

                            const questionObj = {
                                id: btnText,
                                subjectName,
                                statement: statementText,
                                alternatives: alternativesData?.alternatives || [],
                                justification: justificationText,
                                metadata: alternativesData?.meta || {},
                                images: images || []
                            };

                            onQuestion(questionObj);
                        }

                        if (onExamDone) onExamDone({ year: year.label, examId: exam.value, examName: exam.text });
                    }
                }
            }

            onStatus('DONE', '🏁 Concluído.');

        } catch (error) {
            console.error('Selenium Error:', error);
            throw error;
        } finally {
            if (this.driver) {
                await this.driver.quit();
                this.driver = null;
            }
        }
    }
}

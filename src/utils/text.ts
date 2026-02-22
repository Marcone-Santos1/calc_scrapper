export function extractCleanTextFromMarkdown(md: string): string {
    return md
        .replace(/!\[.*?\]\(.*?\)/g, '')   // Remover imagens
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') // Substituir links apenas pelo texto
        .replace(/[#>*_`~\-]/g, '')         // Remover caracteres de marcação
        .replace(/\s+/g, ' ')               // Normalizar espaços
        .trim();
}

/**
 * Formata o título baseado no texto extraído.
 * Trunca inteligentemente aos 150 caracteres.
 */
export function generateTitle(statement: string): string {
    const cleanText = extractCleanTextFromMarkdown(statement);
    let title = cleanText.substring(0, 150);

    if (cleanText.length > 150) {
        const lastSpace = title.lastIndexOf(' ');
        if (lastSpace > 0) {
            title = title.substring(0, lastSpace) + '...';
        } else {
            title = title + '...';
        }
    }

    return title;
}

/**
 * Formata o corpo concatenando o enunciado e as imagens (se houver).
 */
export function formatQuestionBody(statement: string, images: string[]): string {
    let body = statement;
    if (images && images.length > 0) {
        images.forEach(img => {
            body += `\n\n![Imagem de Apoio](${img})`;
        });
    }
    return body;
}

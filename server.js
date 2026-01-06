const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json());

async function exportLookerPDF({ looker_url, client_name, start_date, end_date }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });

  const page = await context.newPage();

  try {
    // Aumentando o tempo de espera para a página carregar completamente
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 180000 }); // Aumentado para 3 minutos
    await page.waitForTimeout(5000); // Atraso adicional para aguardar o carregamento completo da página

    // Esperar o botão "Conta de Anúncio" aparecer e clicar
    await page.locator('text=Conta de Anúncio').waitFor({ state: 'visible', timeout: 180000 }); // Aumentado para 3 minutos
    await page.locator('text=Conta de Anúncio').click();

    // Esperar o campo de pesquisa de cliente aparecer e preencher
    const searchInput = page.locator('input[placeholder*="Digite para pesquisar"]').first();
    await searchInput.fill(client_name, { timeout: 30000 });
    await page.waitForTimeout(2000); // Espera adicional para garantir que o cliente foi filtrado

    // Esperar e clicar no cliente desejado
    const clientCheckbox = page.locator(`md-checkbox[aria-label="${client_name}"]`).first();
    await clientCheckbox.click();

    // Fechar o menu de seleção
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500); // Atraso extra para garantir que o menu de seleção foi fechado

    // Selecionar o período
    await page.locator('text=Selecionar período').click();
    await page.waitForTimeout(2000); // Atraso para carregar o seletor de data

    // Definir as datas
    const startDateInput = page.locator('text=Data de início');
    await startDateInput.fill(start_date);
    const endDateInput = page.locator('text=Data de término');
    await endDateInput.fill(end_date);

    await page.locator('button:has-text("Aplicar")').click();
    await page.waitForTimeout(3000); // Esperar a aplicação das datas

    // Esperar o menu de 3 pontos aparecer para iniciar o download
    const menuButton = page.locator('button:has(svg), button[aria-label*="Mais"], button[aria-label*="menu"]').first();
    await menuButton.click({ timeout: 30000 });

    await page.locator('text=Baixar o relatório').click({ timeout: 30000 });

    // Aguardar o modal de download e clicar para iniciar o download
    const downloadButton = page.locator('button:has-text("Fazer download")').first();
    await downloadButton.waitFor({ state: 'enabled', timeout: 60000 });

    const downloadPromise = page.waitForEvent('download');
    await downloadButton.click();

    const download = await downloadPromise;
    const path = await download.path();

    const buffer = fs.readFileSync(path);
    return buffer;
  } catch (error) {
    console.error('Erro durante a execução da automação:', error);
    throw new Error('Erro na automação');
  } finally {
    await browser.close();
  }
}

app.post('/export', async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date } = req.body;

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
    res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

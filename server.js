const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || '';

function requireKey(req, res, next) {
  if (!API_KEY) return next(); // se você não setou no Render, não bloqueia
  const sent = req.header('x-api-key');
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function parseBRDate(s) {
  // aceita "2025-12-01" ou "01/12/2025"
  if (!s) return null;
  if (s.includes('/')) {
    const [dd, mm, yyyy] = s.split('/').map(Number);
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split('-').map(Number);
  return { dd, mm, yyyy };
}

async function setDateInPicker(page, labelText, dateObj) {
  // labelText: "Data de início" ou "Data de término"
  // dateObj: {dd, mm, yyyy}
  const { dd, mm, yyyy } = dateObj;

  // abre o seletor (clica na área do lado do label)
  const box = page.locator(`text=${labelText}`).first();
  await box.waitFor({ state: 'visible', timeout: 60000 });

  // tenta clicar no dropdown do mês/ano na coluna correta
  // (na sua UI aparece "JAN. DE 2026" e setinhas)
  const container = box.locator('..').locator('..'); // sobe um pouco
  // clique no texto do mês/ano para abrir seleção (se existir)
  const monthYear = container.locator('text=/[A-Z]{3,}\\.?\\s+DE\\s+\\d{4}/').first();
  if (await monthYear.count()) {
    await monthYear.click({ timeout: 10000 }).catch(() => {});
  }

  // Como o componente pode variar, o método mais robusto:
  // navegar mês a mês com setinhas até chegar no mês/ano desejado.
  // (isso é o mais estável sem depender do HTML exato)
  const target = new Date(yyyy, mm - 1, 1);

  // tenta ler mês/ano atual visível próximo desse label
  for (let i = 0; i < 24; i++) {
    const header = container.locator('text=/DE\\s+\\d{4}/').first();
    const headerText = (await header.textContent().catch(() => '')) || '';
    // headerText exemplo: "JAN. DE 2026"
    const upper = headerText.toUpperCase();

    const monthMap = {
      'JAN': 1, 'FEV': 2, 'MAR': 3, 'ABR': 4, 'MAI': 5, 'JUN': 6,
      'JUL': 7, 'AGO': 8, 'SET': 9, 'OUT': 10, 'NOV': 11, 'DEZ': 12,
    };

    let curMonth = null;
    let curYear = null;
    const m = upper.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);
    if (m) {
      curMonth = monthMap[m[1]];
      curYear = Number(m[2]);
    }

    if (curMonth && curYear) {
      const cur = new Date(curYear, curMonth - 1, 1);
      if (cur.getTime() === target.getTime()) break;

      // decide direção
      const nextBtn = container.locator('button:has-text("›"), button:has-text(">")').first();
      const prevBtn = container.locator('button:has-text("‹"), button:has-text("<")').first();

      if (cur < target) {
        if (await nextBtn.count()) await nextBtn.click();
        else break;
      } else {
        if (await prevBtn.count()) await prevBtn.click();
        else break;
      }
    } else {
      break;
    }

    await page.waitForTimeout(400);
  }

  // clica no dia
  // (o day “4” no seu print é um botão/td clicável)
  const dayBtn = container.locator(`text="${dd}"`).first();
  await dayBtn.click({ timeout: 20000 });

  await page.waitForTimeout(400);
}

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
    // 1) abrir e esperar
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);

    // espera algum texto-chave aparecer (título)
    await page.locator('text=Relatório Clientes').first().waitFor({ timeout: 90000 }).catch(() => {});

    // 2) abrir filtro "Conta de Anúncio"
    await page.locator('text=Conta de Anúncio').first().click({ timeout: 60000 });
    await page.waitForTimeout(800);

    // 3) desmarcar todas (checkbox do topo)
    // no seu print é um checkbox no header do dropdown (coluna esquerda)
    const topCheckbox = page.locator('md-checkbox input[type="checkbox"]').first();
    if (await topCheckbox.count()) {
      await topCheckbox.click({ timeout: 20000 });
      await page.waitForTimeout(800);
    } else {
      // fallback: clicar no elemento clicável do checkbox
      const topMdCheckbox = page.locator('md-checkbox').first();
      await topMdCheckbox.click({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // 4) buscar e selecionar cliente
    // tem um input "Digite para pesquisar"
    const search = page.locator('input[placeholder*="Digite"]').first();
    if (await search.count()) {
      await search.fill(client_name, { timeout: 20000 });
      await page.waitForTimeout(800);
    }

    // item do cliente pelo título
    const clientItem = page.locator(`md-checkbox[aria-label="${client_name}"]`).first();
    if (await clientItem.count()) {
      await clientItem.click({ timeout: 20000 });
    } else {
      // fallback por texto visível
      await page.locator(`text=${client_name}`).first().click({ timeout: 20000 });
    }

    // fechar dropdown clicando fora
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1500);

    // 5) abrir período
    await page.locator('text=Selecionar período').first().click({ timeout: 60000 });
    await page.waitForTimeout(1200);

    // 6) setar datas
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);

    if (sd && ed) {
      await setDateInPicker(page, 'Data de início', sd);
      await setDateInPicker(page, 'Data de término', ed);
    }

    // clicar "Aplicar"
    await page.locator('button:has-text("Aplicar")').first().click({ timeout: 30000 });
    await page.waitForTimeout(4000);

    // espera carregar (quando muda cards/valores)
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // 7) menu (3 pontinhos) e baixar
    // pelo seu print, é o botão de menu "kebab"
    const menuBtn = page.locator('button:has(svg), button[aria-label*="Mais"], button[aria-label*="menu"]').first();
    await menuBtn.click({ timeout: 30000 }).catch(async () => {
      // fallback: clicar no ícone 3 pontos pela região top-right
      await page.mouse.click(1130, 150);
    });

    await page.waitForTimeout(800);

    await page.locator('text=Baixar o relatório').first().click({ timeout: 30000 });
    await page.waitForTimeout(1200);

    // 8) modal "Fazer download do relatório (PDF)"
    // clicar no botão "Fazer download"
    const downloadBtn = page.locator('button:has-text("Fazer download")').first();

    // o botão pode estar desabilitado enquanto prepara, então esperamos habilitar
    await downloadBtn.waitFor({ state: 'visible', timeout: 60000 });

    // aguardamos ficar habilitado
    for (let i = 0; i < 60; i++) {
      const disabled = await downloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
    await downloadBtn.click({ timeout: 30000 });
    const download = await downloadPromise;

    const path = await download.path();
    const fs = require('fs');
    const buffer = fs.readFileSync(path);

    return buffer;
  } finally {
    await browser.close();
  }
}

app.post('/export', requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date } = req.body || {};
    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({ error: 'Missing looker_url, client_name, start_date, end_date' });
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
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || '';

function requireKey(req, res, next) {
  if (!API_KEY) return next();
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

/**
 * Ajusta o calendário do Looker Studio (Data de início / Data de término)
 * Estratégia:
 * - clica no dia (dd) dentro da coluna referente ao label
 * - navega mês/ano usando setinhas até chegar no alvo (no máximo 36 cliques)
 */
async function setDateInPicker(page, labelText, dateObj) {
  const { dd, mm, yyyy } = dateObj;
  const target = new Date(yyyy, mm - 1, 1);

  const label = page.getByText(labelText, { exact: false }).first();
  await label.waitFor({ state: 'visible', timeout: 60000 });

  // container mais próximo do label (coluna do calendário)
  const container = label.locator('..').locator('..');

  // tenta ler header do mês/ano tipo "JAN. DE 2026"
  const header = container.locator('text=/[A-Z]{3}\\.?\\s+DE\\s+\\d{4}/').first();

  const monthMap = {
    JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
    JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  };

  for (let i = 0; i < 36; i++) {
    const headerText = ((await header.textContent().catch(() => '')) || '').toUpperCase();
    const m = headerText.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);

    if (m && monthMap[m[1]]) {
      const cur = new Date(Number(m[2]), monthMap[m[1]] - 1, 1);
      if (cur.getTime() === target.getTime()) break;

      // setinhas da coluna
      const nextBtn = container.locator('button:has-text("›"), button:has-text(">")').first();
      const prevBtn = container.locator('button:has-text("‹"), button:has-text("<")').first();

      if (cur < target) {
        if (await nextBtn.count()) await nextBtn.click({ timeout: 10000 });
        else break;
      } else {
        if (await prevBtn.count()) await prevBtn.click({ timeout: 10000 });
        else break;
      }

      await page.waitForTimeout(250);
    } else {
      // se não conseguiu ler header, sai do loop e tenta clicar no dia mesmo assim
      break;
    }
  }

  // clica no dia dentro da coluna
  // usar getByRole costuma ser mais estável quando existe
  const dayBtn = container.getByText(String(dd), { exact: true }).first();
  await dayBtn.scrollIntoViewIfNeeded();
  await dayBtn.click({ timeout: 30000 });

  await page.waitForTimeout(300);
}

async function exportLookerPDF({ looker_url, client_name, start_date, end_date }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    locale: 'pt-BR',
  });

  const page = await context.newPage();

  try {
    // 1) abrir e esperar renderizar de verdade
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(8000);

    // Detecta login/consent (se aparecer, o relatório não está público)
    const possibleLogin = page.locator('text=/Fazer login|Entrar|Sign in|Choose an account|Use another account/i').first();
    if (await possibleLogin.count()) {
      throw new Error('Parece que o Looker Studio está pedindo login/consent. Deixe o relatório público (qualquer pessoa com link pode ver).');
    }

    // 2) abrir filtro "Conta de Anúncio" (aceita truncado)
    const contaBtn = page.getByText(/Conta de Anúnc/i).first();
    await contaBtn.waitFor({ state: 'visible', timeout: 120000 });
    await contaBtn.scrollIntoViewIfNeeded();
    await contaBtn.click({ timeout: 120000 });
    await page.waitForTimeout(800);

    // 3) desmarcar todas (checkbox do topo do dropdown)
    const topMdCheckbox = page.locator('md-checkbox').first();
    await topMdCheckbox.waitFor({ state: 'visible', timeout: 60000 });
    await topMdCheckbox.click({ timeout: 60000 });
    await page.waitForTimeout(800);

    // 4) buscar e selecionar cliente
    const search = page.locator('input[placeholder*="Digite"]').first();
    await search.waitFor({ state: 'visible', timeout: 60000 });
    await search.fill(client_name, { timeout: 60000 });
    await page.waitForTimeout(800);

    // ✅ selector pelo title (igual seu DevTools)
    const clientCheckbox = page.locator('md-checkbox', {
      has: page.locator(`span[title="${client_name}"]`)
    }).first();

    await clientCheckbox.waitFor({ state: 'visible', timeout: 60000 });
    await clientCheckbox.scrollIntoViewIfNeeded();
    await clientCheckbox.click({ timeout: 60000 });

    // fecha dropdown
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1500);

    // 5) abrir período
    const periodoBtn = page.getByText(/Selecionar período/i).first();
    await periodoBtn.waitFor({ state: 'visible', timeout: 120000 });
    await periodoBtn.scrollIntoViewIfNeeded();
    await periodoBtn.click({ timeout: 120000 });
    await page.waitForTimeout(1200);

    // 6) setar datas
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error('Datas inválidas. Use "YYYY-MM-DD" ou "DD/MM/YYYY".');

    await setDateInPicker(page, 'Data de início', sd);
    await setDateInPicker(page, 'Data de término', ed);

    // aplicar
    const aplicarBtn = page.getByText('Aplicar', { exact: true }).first();
    await aplicarBtn.click({ timeout: 60000 });

    // esperar carregar após aplicar filtro
    await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // 7) abrir menu 3 pontinhos (kebab)
    // tenta: botão com svg/ícone, ou aria-label
    const kebabBtn =
      page.locator('button:has(svg)').filter({ hasText: '' }).first()
      .or(page.locator('button[aria-label*="Mais"]')).first()
      .or(page.locator('button[aria-label*="menu"]')).first();

    // em muitos relatórios o "kebab" fica perto do topo-direito
    await kebabBtn.click({ timeout: 30000 }).catch(async () => {
      // fallback por coordenada (ajuste se necessário)
      await page.mouse.click(1130, 135);
    });

    await page.waitForTimeout(800);

    // 8) clicar "Baixar o relatório"
    const baixarItem = page.getByText(/Baixar o relatório/i).first();
    await baixarItem.waitFor({ state: 'visible', timeout: 60000 });
    await baixarItem.click({ timeout: 60000 });

    // 9) modal "Fazer download do relatório (PDF)"
    const fazerDownloadBtn = page.getByText('Fazer download', { exact: true }).first();
    await fazerDownloadBtn.waitFor({ state: 'visible', timeout: 120000 });

    // esperar habilitar (o Looker prepara o PDF)
    for (let i = 0; i < 240; i++) { // até 2 minutos
      const disabled = await fazerDownloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    // capturar download
    const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
    await fazerDownloadBtn.click({ timeout: 60000 });
    const download = await downloadPromise;

    const filePath = await download.path();
    const fs = require('fs');
    const buffer = fs.readFileSync(filePath);

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
    res.status(500).json({
      error: 'Failed to export PDF',
      detail: String(e?.message || e),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

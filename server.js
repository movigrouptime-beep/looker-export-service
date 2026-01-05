const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || '';

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const sent = req.header('x-api-key');
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function parseBRDate(s) {
  if (!s) return null;
  if (typeof s !== 'string') return null;

  // aceita "2025-12-01" ou "01/12/2025"
  if (s.includes('/')) {
    const [dd, mm, yyyy] = s.split('/').map(Number);
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split('-').map(Number);
  return { dd, mm, yyyy };
}

/**
 * Espera um pouco até a página "ficar viva".
 * (Looker costuma demorar carregando e trocando valores)
 */
async function waitStable(page, { timeoutMs = 60000 } = {}) {
  const start = Date.now();
  let lastCount = -1;

  while (Date.now() - start < timeoutMs) {
    const count = await page.locator('text=/Não há dados|R\\$|\\d{1,3}\\.\\d{3}|\\d{1,3},\\d{2}/').count().catch(() => 0);
    if (count === lastCount && count > 0) return;
    lastCount = count;
    await page.waitForTimeout(800);
  }
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
    // 1) abrir e esperar carregar
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(4000);
    await waitStable(page, { timeoutMs: 90000 }).catch(() => {});

    // 2) abrir filtro "Conta de Anúncio"
    await page.getByText('Conta de Anúncio', { exact: false }).first().click({ timeout: 60000 });
    await page.waitForTimeout(1000);

    // 3) desmarcar todas (checkbox do topo)
    // no seu HTML aparece md-checkbox, então usamos isso
    const topMdCheckbox = page.locator('md-checkbox').first();
    await topMdCheckbox.click({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);

    // 4) buscar e selecionar cliente (campo "Digite para pesquisar")
    const search = page.locator('input[placeholder*="Digite"]').first();
    if (await search.count()) {
      await search.fill(client_name);
      await page.waitForTimeout(1200);
    }

    // Seleciona pelo aria-label do md-checkbox (no seu print aparece aria-label="CA 01 - Patricia Salmazo")
    const clientCheck = page.locator(`md-checkbox[aria-label="${client_name}"]`).first();
    if (await clientCheck.count()) {
      await clientCheck.click({ timeout: 30000 });
    } else {
      // fallback por texto
      await page.getByText(client_name, { exact: false }).first().click({ timeout: 30000 });
    }

    // fecha dropdown
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1500);

    // 5) abrir período
    await page.getByText('Selecionar período', { exact: false }).first().click({ timeout: 60000 });
    await page.waitForTimeout(1500);

    // 6) setar datas (clique no dia do calendário)
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error(`Datas inválidas: start_date=${start_date} end_date=${end_date}`);

    // Estratégia simples e robusta:
    // - clica no dia "dd" da coluna de início e depois no da coluna de término
    // (como no seu print aparece calendário duplo)
    await page.getByText('Data de início', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByText(String(sd.dd), { exact: true }).first().click({ timeout: 30000 });

    await page.waitForTimeout(700);
    await page.getByText('Data de término', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.getByText(String(ed.dd), { exact: true }).first().click({ timeout: 30000 });

    // aplicar
    await page.getByRole('button', { name: 'Aplicar' }).click({ timeout: 30000 });
    await page.waitForTimeout(5000);
    await waitStable(page, { timeoutMs: 90000 }).catch(() => {});

    // 7) menu (3 pontinhos) e "Baixar o relatório"
    // pelo seu print: botão com 3 pontos abre menu onde tem "Baixar o relatório"
    const kebab = page.locator('button:has(svg)').first();
    await kebab.click({ timeout: 30000 }).catch(async () => {
      // fallback: canto superior direito aproximado
      await page.mouse.click(1130, 150);
    });

    await page.waitForTimeout(800);
    await page.getByText('Baixar o relatório', { exact: false }).first().click({ timeout: 30000 });

    // 8) MODAL EXTRA (você mostrou essa “aba”)
    // Esperar o modal aparecer e o botão "Fazer download" ficar habilitado
    const downloadBtn = page.getByRole('button', { name: 'Fazer download' }).first();
    await downloadBtn.waitFor({ state: 'visible', timeout: 90000 });

    // esperar habilitar
    for (let i = 0; i < 120; i++) {
      const disabled = await downloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await downloadBtn.click({ timeout: 30000 });
    const download = await downloadPromise;

    const path = await download.path();
    const buffer = fs.readFileSync(path);

    return buffer;
  } finally {
    await browser.close();
  }
}

app.post('/export', requireKey, async (req, res) => {
  try {
    // ✅ aceita os 2 formatos:
    // - start_date / end_date
    // - period_start / period_end (do seu n8n)
    const body = req.body || {};

    const looker_url = body.looker_url;
    const client_name = body.client_name;
    const start_date = body.start_date || body.period_start;
    const end_date = body.end_date || body.period_end;

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({
        error: 'Missing looker_url, client_name, start_date, end_date',
        receivedKeys: Object.keys(body),
        receivedBody: body,
        hint: 'Envie start_date/end_date ou period_start/period_end no JSON.',
      });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error('EXPORT ERROR:', e);
    return res.status(500).json({ error: 'Failed to export PDF', detail: String(e?.message || e) });
  }
});

app.get('/health', (req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

'use strict';

const express = require('express');
const fs = require('fs');
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

app.get('/health', (_req, res) => res.status(200).send('ok'));

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase()
    .trim();
}

function parseBRDate(s) {
  if (!s) return null;
  if (String(s).includes('/')) {
    const [dd, mm, yyyy] = String(s).split('/').map(Number);
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = String(s).split('-').map(Number);
  return { dd, mm, yyyy };
}

/**
 * Looker Studio frequentemente renderiza os filtros dentro de IFRAME.
 * Essa função procura um frame que contenha um texto-chave.
 */
async function findFrameByText(page, text, timeoutMs = 60000) {
  const started = Date.now();
  const needle = String(text);

  while (Date.now() - started < timeoutMs) {
    for (const fr of page.frames()) {
      try {
        // tenta achar o texto no frame
        const loc = fr.locator(`text=${needle}`).first();
        if (await loc.count()) return fr;
      } catch (_) {}
    }
    await sleep(500);
  }
  throw new Error(`Timeout: não encontrei frame com o texto: ${text}`);
}

/**
 * Dentro do dropdown de "Conta de Anúncio", clicar no checkbox do cliente
 * mesmo que exista acento ou pequenas diferenças.
 */
async function clickClientInDropdown(frame, clientName, timeoutMs = 60000) {
  const target = normalizeText(clientName);

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // opções costumam ter span com title
    const titles = frame.locator('md-checkbox span[title]');
    const n = await titles.count();

    for (let i = 0; i < n; i++) {
      const el = titles.nth(i);
      const title = await el.getAttribute('title').catch(() => null);
      if (!title) continue;

      if (normalizeText(title) === target) {
        // clica no md-checkbox pai
        await el.locator('xpath=ancestor::md-checkbox').click({ timeout: 20000 });
        return true;
      }
    }

    // fallback: tentar achar por texto visível no item
    const byText = frame.locator('md-checkbox', { hasText: clientName }).first();
    if (await byText.count()) {
      await byText.click({ timeout: 20000 });
      return true;
    }

    await sleep(500);
  }

  throw new Error(`Não consegui achar o cliente no dropdown: "${clientName}"`);
}

async function setDateInPicker(frame, labelText, dateObj) {
  const { dd, mm, yyyy } = dateObj;

  // abre o calendário clicando no label
  const label = frame.locator(`text=${labelText}`).first();
  await label.waitFor({ state: 'visible', timeout: 60000 });
  await label.click({ timeout: 30000 });
  await sleep(500);

  // Navegação mês/ano (até 36 passos)
  const target = new Date(yyyy, mm - 1, 1);

  for (let i = 0; i < 36; i++) {
    // header do mês/ano do lado do calendário
    const header = frame.locator('text=/[A-Z]{3}\\.?\\s+DE\\s+\\d{4}/').first();
    const headerText = (await header.textContent().catch(() => '')) || '';
    const up = headerText.toUpperCase();

    const monthMap = {
      'JAN': 1, 'FEV': 2, 'MAR': 3, 'ABR': 4, 'MAI': 5, 'JUN': 6,
      'JUL': 7, 'AGO': 8, 'SET': 9, 'OUT': 10, 'NOV': 11, 'DEZ': 12,
    };

    const m = up.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);
    if (!m) break;

    const curMonth = monthMap[m[1]];
    const curYear = Number(m[2]);
    if (!curMonth || !curYear) break;

    const cur = new Date(curYear, curMonth - 1, 1);
    if (cur.getTime() === target.getTime()) break;

    // setas
    const nextBtn = frame.locator('button:has-text("›"), button:has-text(">")').first();
    const prevBtn = frame.locator('button:has-text("‹"), button:has-text("<")').first();

    if (cur < target) {
      if (await nextBtn.count()) await nextBtn.click();
      else break;
    } else {
      if (await prevBtn.count()) await prevBtn.click();
      else break;
    }

    await sleep(300);
  }

  // clica no dia
  // tenta um botão/célula com o número
  const day = String(dd);
  const dayBtn = frame.locator(`button:has-text("${day}")`).first();
  if (await dayBtn.count()) {
    await dayBtn.click({ timeout: 20000 });
  } else {
    // fallback
    await frame.locator(`text="${day}"`).first().click({ timeout: 20000 });
  }
  await sleep(300);
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
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(4000);

    // acha o frame onde estão os controles
    const frame = await findFrameByText(page, 'Conta de Anúncio', 90000);

    // 1) abrir dropdown Conta de Anúncio
    await frame.locator('text=Conta de Anúncio').first().click({ timeout: 60000 });
    await sleep(800);

    // 2) desmarcar todas (checkbox do topo)
    // costuma ser o primeiro md-checkbox dentro do dropdown
    const topCheckbox = frame.locator('md-checkbox').first();
    if (await topCheckbox.count()) {
      await topCheckbox.click({ timeout: 30000 }).catch(() => {});
      await sleep(600);
    }

    // 3) buscar no input "Digite para pesquisar"
    const search = frame.locator('input[placeholder*="Digite"]').first();
    if (await search.count()) {
      await search.fill(client_name, { timeout: 20000 });
      await sleep(800);
    }

    // 4) selecionar cliente (com tolerância a acento)
    await clickClientInDropdown(frame, client_name, 60000);

    // fecha dropdown
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(1500);

    // 5) abrir período
    await frame.locator('text=Selecionar período').first().click({ timeout: 60000 });
    await sleep(1200);

    // 6) setar datas
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error('Datas inválidas. Use "YYYY-MM-DD" ou "DD/MM/YYYY".');

    await setDateInPicker(frame, 'Data de início', sd);
    await setDateInPicker(frame, 'Data de término', ed);

    // aplicar
    await frame.locator('button:has-text("Aplicar")').first().click({ timeout: 30000 });
    await sleep(4000);

    // 7) abrir menu ⋮ (três pontinhos)
    // no seu print é um botão com svg e abre opções como "Baixar o relatório"
    const menuBtn = frame.locator('button:has(svg)').first();
    await menuBtn.click({ timeout: 60000 });
    await sleep(800);

    // 8) clicar Baixar o relatório
    await frame.locator('text=Baixar o relatório').first().click({ timeout: 60000 });
    await sleep(1200);

    // 9) modal: Fazer download do relatório (PDF)
    // botão fica desabilitado enquanto prepara
    const downloadBtn = page.locator('button:has-text("Fazer download")').first();
    await downloadBtn.waitFor({ state: 'visible', timeout: 90000 });

    for (let i = 0; i < 180; i++) {
      const disabled = await downloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await sleep(500);
    }

    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await downloadBtn.click({ timeout: 60000 });
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
    const { looker_url, client_name, start_date, end_date } = req.body || {};
    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({ error: 'Missing looker_url, client_name, start_date, end_date' });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to export PDF', detail: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

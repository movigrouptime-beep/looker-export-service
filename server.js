// server.js
const express = require('express');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || '';

function requireKey(req, res, next) {
  if (!API_KEY) return next(); // se não setou no Render, não bloqueia
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

function monthToPtAbbr(m) {
  const arr = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
  return arr[m - 1] || null;
}

async function waitDashboardReady(page) {
  // Aguarda o relatório ficar "utilizável"
  // (seu relatório carrega cards e filtros; esperamos alguns textos conhecidos)
  await page.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Tenta esperar um filtro existir
  await page.locator('text=Conta de Anúncio').first().waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
  await page.locator('text=Selecionar período').first().waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
}

async function openAccountFilter(page) {
  await page.locator('text=Conta de Anúncio').first().click({ timeout: 60000 });
  await page.waitForTimeout(600);
}

async function clearAllAccounts(page) {
  // Pelo seu DOM, há md-checkbox no topo e itens com aria-label
  // Vamos clicar no PRIMEIRO checkbox do dropdown (geralmente "Selecionar tudo")
  const topCheckboxInput = page.locator('md-checkbox input[type="checkbox"]').first();
  if (await topCheckboxInput.count()) {
    await topCheckboxInput.click({ timeout: 20000 }).catch(() => {});
  } else {
    await page.locator('md-checkbox').first().click({ timeout: 20000 }).catch(() => {});
  }
  await page.waitForTimeout(600);
}

async function selectClient(page, clientLabel) {
  // Usa busca "Digite para pesquisar" se existir
  const search = page.locator('input[placeholder*="Digite"]').first();
  if (await search.count()) {
    await search.fill(clientLabel, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
  }

  // Clica no checkbox do item pelo aria-label (mais estável)
  const itemByAria = page.locator(`md-checkbox[aria-label="${clientLabel}"]`).first();
  if (await itemByAria.count()) {
    await itemByAria.click({ timeout: 20000 });
  } else {
    // Fallback por texto visível (quando aria-label não bate 100%)
    await page.locator(`text=${clientLabel}`).first().click({ timeout: 20000 });
  }

  // Fecha dropdown
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1000);
}

async function openPeriodPicker(page) {
  await page.locator('text=Selecionar período').first().click({ timeout: 60000 });
  await page.waitForTimeout(800);
}

async function setDateColumn(page, columnTitleText, dateObj) {
  // columnTitleText: "Data de início" ou "Data de término"
  // dateObj: {dd, mm, yyyy}
  const { dd, mm, yyyy } = dateObj;

  // Acha o bloco da coluna (pai do texto "Data de início")
  const colTitle = page.locator(`text=${columnTitleText}`).first();
  await colTitle.waitFor({ state: 'visible', timeout: 60000 });

  // Sobe para o container da coluna do calendário
  const col = colTitle.locator('..').locator('..'); // robusto o suficiente pra esse layout

  const targetMonth = monthToPtAbbr(mm);
  const targetHeaderRegex = new RegExp(`${targetMonth}\\.?\\s+DE\\s+${yyyy}`, 'i');

  // Navega até o mês/ano correto clicando nas setas dentro da coluna
  for (let i = 0; i < 36; i++) {
    const header = col.locator('text=/DE\\s+\\d{4}/').first();
    const headerText = ((await header.textContent().catch(() => '')) || '').toUpperCase();

    if (targetMonth && headerText.includes(`DE ${yyyy}`) && headerText.includes(targetMonth)) {
      break;
    }

    // Decide direção baseada em comparação simples
    // Se não der pra parsear, tenta "próximo" algumas vezes
    const m = headerText.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);
    const map = { JAN:1, FEV:2, MAR:3, ABR:4, MAI:5, JUN:6, JUL:7, AGO:8, SET:9, OUT:10, NOV:11, DEZ:12 };

    let curMonth = null;
    let curYear = null;
    if (m) {
      curMonth = map[m[1]];
      curYear = Number(m[2]);
    }

    const nextBtn = col.locator('button:has-text("›"), button:has-text(">")').first();
    const prevBtn = col.locator('button:has-text("‹"), button:has-text("<")').first();

    if (curMonth && curYear) {
      const cur = new Date(curYear, curMonth - 1, 1);
      const tgt = new Date(yyyy, mm - 1, 1);
      if (cur < tgt) {
        if (await nextBtn.count()) await nextBtn.click().catch(() => {});
      } else {
        if (await prevBtn.count()) await prevBtn.click().catch(() => {});
      }
    } else {
      if (await nextBtn.count()) await nextBtn.click().catch(() => {});
    }

    await page.waitForTimeout(300);
  }

  // Clica no dia (melhor tentar botão/td com aria-label, se existir; fallback texto)
  // Muitos datepickers usam aria-label com data completa, mas aqui vamos no "text=dd" dentro da coluna
  const day = col.locator(`text="${dd}"`).first();
  await day.click({ timeout: 20000 });
  await page.waitForTimeout(300);
}

async function applyPeriod(page, start_date, end_date) {
  const sd = parseBRDate(start_date);
  const ed = parseBRDate(end_date);
  if (!sd || !ed) throw new Error('Datas inválidas');

  await setDateColumn(page, 'Data de início', sd);
  await setDateColumn(page, 'Data de término', ed);

  await page.locator('button:has-text("Aplicar")').first().click({ timeout: 30000 });
  await page.waitForTimeout(1500);

  // Espera a atualização do dashboard (Looker pode manter conexões abertas, então usamos um misto)
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

async function openMoreMenuAndDownload(page) {
  // Botão 3 pontinhos (kebab) do topo direito
  // Melhor tentar localizar o botão que abre o mat-menu; fallback por "..."
  const kebab = page.locator('button:has(svg[viewBox="0 0 24 24"])').first();
  await kebab.click({ timeout: 30000 }).catch(async () => {
    // fallback: tenta achar botão com aria-label de menu/mais opções
    await page.locator('button[aria-label*="Mais"], button[aria-label*="menu"]').first().click({ timeout: 30000 });
  });

  await page.waitForTimeout(500);

  // Clica em "Baixar o relatório"
  await page.locator('text=Baixar o relatório').first().click({ timeout: 30000 });
  await page.waitForTimeout(800);
}

async function clickFinalDownloadAndCapturePdf(page) {
  // Modal: "Fazer download do relatório (PDF)"
  const downloadBtn = page.locator('button:has-text("Fazer download")').first();
  await downloadBtn.waitFor({ state: 'visible', timeout: 60000 });

  // Espera habilitar (no seu print fica desabilitado enquanto prepara)
  for (let i = 0; i < 240; i++) {
    const disabled = await downloadBtn.isDisabled().catch(() => true);
    if (!disabled) break;
    await page.waitForTimeout(500);
  }

  // ✅ AQUI É A CORREÇÃO PRINCIPAL:
  // Looker Studio muitas vezes NÃO dispara "download" nativo; capturamos a resposta PDF.
  const [pdfResponse] = await Promise.all([
    page.waitForResponse(
      (res) => {
        const ct = res.headers()['content-type'] || '';
        return ct.includes('application/pdf');
      },
      { timeout: 180000 }
    ),
    downloadBtn.click({ timeout: 30000 }),
  ]);

  const buffer = await pdfResponse.body();
  return buffer;
}

async function exportLookerPDF({ looker_url, client_name, start_date, end_date }) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-setuid-sandbox',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });

  const page = await context.newPage();

  try {
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitDashboardReady(page);

    // 1) Conta de anúncio: abrir -> desmarcar tudo -> selecionar cliente
    await openAccountFilter(page);
    await clearAllAccounts(page);
    await selectClient(page, client_name);

    // 2) Período
    await openPeriodPicker(page);
    await applyPeriod(page, start_date, end_date);

    // 3) Download (menu 3 pontinhos -> Baixar o relatório -> modal -> Fazer download)
    await openMoreMenuAndDownload(page);
    const pdfBuffer = await clickFinalDownloadAndCapturePdf(page);

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

app.post('/export', requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date, file_name } = req.body || {};

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({
        error: 'Missing looker_url, client_name, start_date, end_date',
      });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    const safeName = (file_name || `relatorio_${client_name}`).toString().replace(/[^\w\-\.]+/g, '_');
    const finalName = safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${finalName}"`);
    return res.status(200).send(pdf);
  } catch (e) {
    console.error('EXPORT ERROR:', e);
    return res.status(500).json({ error: 'Failed to export PDF' });
  }
});

app.get('/health', (_req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

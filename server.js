const express = require("express");
const { chromium } = require("playwright");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "5mb" }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || "";

/**
 * Se EXPORT_SERVICE_API_KEY estiver setado, exige header x-api-key.
 * Se não estiver setado, deixa aberto (pra facilitar teste).
 */
function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const sent = req.header("x-api-key");
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

/** Aceita "2025-12-01" ou "01/12/2025" e devolve { dd, mm, yyyy } */
function parseBRDate(s) {
  if (!s) return null;
  if (s.includes("/")) {
    const [dd, mm, yyyy] = s.split("/").map(Number);
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split("-").map(Number);
  return { dd, mm, yyyy };
}

function monthPtToNumber(mon) {
  const map = {
    JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
    JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  };
  return map[(mon || "").toUpperCase()] || null;
}

async function waitNetworkQuiet(page, timeout = 60000) {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}

/**
 * Ajusta o calendário (coluna) até o mês/ano alvo e clica no dia.
 * columnRoot = um locator que representa a coluna do calendário (início ou término).
 */
async function setCalendarDate(page, columnRoot, { dd, mm, yyyy }) {
  const target = new Date(yyyy, mm - 1, 1);

  // tenta por até 36 cliques (3 anos) ajustar o mês/ano
  for (let i = 0; i < 36; i++) {
    // header tipo "JAN. DE 2026"
    const header = columnRoot.locator('text=/[A-Z]{3}\\.?\s+DE\s+\\d{4}/').first();
    const headerText = ((await header.textContent().catch(() => "")) || "").toUpperCase();
    const m = headerText.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);

    if (!m) break;

    const curMonth = monthPtToNumber(m[1]);
    const curYear = Number(m[2]);
    if (!curMonth || !curYear) break;

    const cur = new Date(curYear, curMonth - 1, 1);

    if (cur.getTime() === target.getTime()) break;

    // botões de navegação (tentamos vários padrões)
    const nextBtn =
      columnRoot.locator('button[aria-label*="Próximo"], button[aria-label*="Next"], button:has-text("›"), button:has-text(">")').first();
    const prevBtn =
      columnRoot.locator('button[aria-label*="Anterior"], button[aria-label*="Previous"], button:has-text("‹"), button:has-text("<")').first();

    if (cur < target) {
      if (await nextBtn.count()) await nextBtn.click({ timeout: 10000 });
      else break;
    } else {
      if (await prevBtn.count()) await prevBtn.click({ timeout: 10000 });
      else break;
    }

    await page.waitForTimeout(300);
  }

  // clica no dia (preferindo botão do calendário)
  // muitos calendários usam botão/td com o número visível
  const day = columnRoot.locator(`text="${dd}"`).first();
  await day.click({ timeout: 20000 });
  await page.waitForTimeout(200);
}

async function exportLookerPDF({ looker_url, client_name, start_date, end_date }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
  });

  const page = await context.newPage();

  try {
    // 1) abrir
    await page.goto(looker_url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitNetworkQuiet(page, 120000);
    await page.waitForTimeout(1500);

    // 2) abrir filtro "Conta de Anúncio"
    await page.locator("text=Conta de Anúncio").first().click({ timeout: 60000 });
    await page.waitForTimeout(600);

    // 3) desmarcar todas (checkbox do topo do dropdown)
    // O DOM que você mostrou usa md-checkbox + input checkbox.
    // Como às vezes tem mais de um, pegamos o primeiro dentro do popup visível.
    const popup = page.locator("md-select-menu, .md-select-menu-container, md-content").filter({ hasText: "Digite para pesquisar" }).first();

    // fallback: se não achar popup, usa a página inteira
    const scope = (await popup.count()) ? popup : page;

    const topCheckbox = scope.locator('md-checkbox input[type="checkbox"]').first();
    if (await topCheckbox.count()) {
      await topCheckbox.click({ timeout: 20000 }).catch(() => {});
    } else {
      await scope.locator("md-checkbox").first().click({ timeout: 20000 }).catch(() => {});
    }
    await page.waitForTimeout(600);

    // 4) buscar e selecionar cliente
    const search = scope.locator('input[placeholder*="Digite"]').first();
    if (await search.count()) {
      await search.fill(client_name, { timeout: 20000 });
      await page.waitForTimeout(600);
    }

    // pelo aria-label do md-checkbox (no seu print: aria-label="CA 01 - Patricia Salmazo")
    const clientCheckbox = scope.locator(`md-checkbox[aria-label="${client_name}"]`).first();
    if (await clientCheckbox.count()) {
      await clientCheckbox.click({ timeout: 20000 });
    } else {
      // fallback por texto visível
      await scope.locator(`text=${client_name}`).first().click({ timeout: 20000 });
    }

    // fecha dropdown
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1200);
    await waitNetworkQuiet(page, 90000);

    // 5) abrir período
    await page.locator("text=Selecionar período").first().click({ timeout: 60000 });
    await page.waitForTimeout(900);

    // 6) setar datas no modal
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error("start_date/end_date inválidos. Use YYYY-MM-DD ou DD/MM/YYYY.");

    // modal do calendário
    const dialog = page.locator(".md-dialog-container, .md-dialog-content, md-dialog").first();
    await dialog.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});

    // colunas do calendário: tentamos achar pela âncora "Data de início" e "Data de término"
    const startCol = page.locator("text=Data de início").first().locator("..").locator("..");
    const endCol = page.locator("text=Data de término").first().locator("..").locator("..");

    // clica um dia na coluna certa (o calendário normalmente já está focado)
    await setCalendarDate(page, startCol, sd);
    await setCalendarDate(page, endCol, ed);

    // aplicar
    await page.locator('button:has-text("Aplicar")').first().click({ timeout: 30000 });
    await page.waitForTimeout(1500);
    await waitNetworkQuiet(page, 120000);

    // 7) abrir menu de compartilhar (setinha) e clicar "Baixar o relatório"
    // você mostrou que o item aparece no dropdown do "Compartilhar"
    await page.locator('button:has-text("Compartilhar")').first().click({ timeout: 60000 });
    await page.waitForTimeout(500);

    await page.locator("text=Baixar o relatório").first().click({ timeout: 60000 });
    await page.waitForTimeout(800);

    // 8) modal "Fazer download do relatório (PDF)" e esperar botão habilitar
    const downloadDialog = page.locator('text=Fazer download do relatório (PDF)').first();
    await downloadDialog.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});

    const downloadBtn = page.locator('button:has-text("Fazer download")').first();
    await downloadBtn.waitFor({ state: "visible", timeout: 60000 });

    // espera habilitar (enquanto aparece "Preparando PDF...")
    for (let i = 0; i < 180; i++) { // até 90s
      const disabled = await downloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await downloadBtn.click({ timeout: 30000 });
    const download = await downloadPromise;

    const tempPath = await download.path();
    if (!tempPath) throw new Error("Não consegui obter o path do download.");
    const buffer = fs.readFileSync(tempPath);

    return buffer;
  } finally {
    await browser.close().catch(() => {});
  }
}

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/export", requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date } = req.body || {};

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({
        error: "Missing looker_url, client_name, start_date, end_date",
        received: { looker_url: !!looker_url, client_name: !!client_name, start_date: !!start_date, end_date: !!end_date },
      });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error("EXPORT ERROR:", e);
    return res.status(500).json({ error: "Failed to export PDF", detail: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

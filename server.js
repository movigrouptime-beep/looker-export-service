const express = require("express");
const fs = require("fs");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || "";

// Health check (Render usa muito isso)
app.get("/health", (req, res) => res.status(200).send("ok"));

// Middleware opcional de API key
function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const sent = req.header("x-api-key");
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function parseBRDate(s) {
  // aceita "2025-12-01" ou "01/12/2025"
  if (!s) return null;
  if (s.includes("/")) {
    const [dd, mm, yyyy] = s.split("/").map(Number);
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split("-").map(Number);
  return { dd, mm, yyyy };
}

/**
 * Acha o container do datepicker aberto e escolhe um dia (número).
 * Como Looker/Material muda o HTML, a estratégia é:
 * - Garantir que o modal/datepicker esteja visível
 * - Navegar mês a mês pelo header (JAN. DE 2026) usando setas
 * - Clicar no dia
 */
async function setDateInOpenPicker(page, which /* "start"|"end" */, dateObj) {
  const { dd, mm, yyyy } = dateObj;
  const target = new Date(yyyy, mm - 1, 1);

  // O datepicker do print tem duas colunas: esquerda (início) e direita (término).
  // Vamos pegar todos os headers tipo "JAN. DE 2026" e escolher pelo índice.
  // 0 = início, 1 = término (normalmente).
  const colIndex = which === "start" ? 0 : 1;

  // Espera o datepicker aparecer
  const pickerRoot = page.locator('mat-dialog-container, .md-dialog-container, [role="dialog"]').first();
  await pickerRoot.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});

  const header = page.locator('text=/\\b[A-Z]{3}\\.?\\s+DE\\s+\\d{4}\\b/i').nth(colIndex);
  await header.waitFor({ state: "visible", timeout: 60000 });

  const monthMap = {
    JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
    JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  };

  // tenta navegar até o mês/ano desejado
  for (let i = 0; i < 36; i++) {
    const headerText = ((await header.textContent()) || "").toUpperCase();
    const m = headerText.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);
    if (!m) break;

    const curMonth = monthMap[m[1]];
    const curYear = Number(m[2]);
    if (!curMonth || !curYear) break;

    const cur = new Date(curYear, curMonth - 1, 1);
    if (cur.getTime() === target.getTime()) break;

    // As setas costumam existir perto de cada coluna.
    // Vamos pegar botões de seta visíveis dentro do dialog e clicar o mais provável.
    const dialog = pickerRoot;

    const nextCandidates = dialog.locator('button:has-text("›"), button:has-text(">"), [aria-label*="Próximo"], [aria-label*="Next"]');
    const prevCandidates = dialog.locator('button:has-text("‹"), button:has-text("<"), [aria-label*="Anterior"], [aria-label*="Previous"]');

    if (cur < target) {
      // tenta clicar na seta "próximo" referente à coluna
      const btn = nextCandidates.nth(colIndex).or(nextCandidates.first());
      await btn.click({ timeout: 10000 }).catch(() => {});
    } else {
      const btn = prevCandidates.nth(colIndex).or(prevCandidates.first());
      await btn.click({ timeout: 10000 }).catch(() => {});
    }

    await page.waitForTimeout(300);
  }

  // clicar no dia (para evitar clicar em "4" de outras áreas, limitamos ao dialog)
  const dayBtn = pickerRoot.locator(`text="${dd}"`).first();
  await dayBtn.click({ timeout: 20000 });
  await page.waitForTimeout(250);
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
    // 1) abrir report
    await page.goto(looker_url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(2000);

    // aguarda algum elemento típico do relatório carregar
    await page.locator('text=/Relatório Clientes|Relatorio Clientes|Relatório Clientes Movi/i').first()
      .waitFor({ timeout: 120000 })
      .catch(() => {});

    // 2) abrir filtro "Conta de Anúncio"
    await page.locator('text=/Conta de Anúncio/i').first().click({ timeout: 60000 });
    await page.waitForTimeout(700);

    // 3) desmarcar todas no checkbox do topo (o “quadradinho”)
    // Geralmente existe um checkbox no topo da lista.
    // Tentamos o primeiro checkbox visível dentro do dropdown.
    const dropdown = page.locator('md-select-menu, .md-select-menu-container, .md-select-menu, [role="listbox"]').first();
    await dropdown.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});

    // checkbox topo (pode ser md-checkbox)
    const topCheckbox = dropdown.locator('md-checkbox').first();
    if (await topCheckbox.count()) {
      await topCheckbox.click({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // 4) buscar e selecionar cliente
    const search = dropdown.locator('input[placeholder*="Digite"], input[type="search"], input').first();
    if (await search.count()) {
      await search.fill(client_name, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(700);
    }

    // Preferência: checkbox pelo aria-label exato
    const clientCheckbox = dropdown.locator(`md-checkbox[aria-label="${client_name}"]`).first();
    if (await clientCheckbox.count()) {
      await clientCheckbox.click({ timeout: 20000 });
    } else {
      // fallback: clicar no texto do item
      await dropdown.locator(`text=${client_name}`).first().click({ timeout: 20000 });
    }

    // fechar dropdown
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1200);

    // 5) abrir "Selecionar período"
    await page.locator('text=/Selecionar período/i').first().click({ timeout: 60000 });
    await page.waitForTimeout(900);

    // 6) setar datas no datepicker (modal)
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error("Invalid start_date/end_date format");

    // Alguns datepickers já abrem direto; outros precisam clicar nos campos "Data de início/término".
    const startLabel = page.locator('text=/Data de início/i').first();
    if (await startLabel.count()) {
      await startLabel.click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    await setDateInOpenPicker(page, "start", sd);

    const endLabel = page.locator('text=/Data de término/i').first();
    if (await endLabel.count()) {
      await endLabel.click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    await setDateInOpenPicker(page, "end", ed);

    // aplicar
    await page.locator('button:has-text("Aplicar")').first().click({ timeout: 30000 });
    await page.waitForTimeout(2500);

    // esperar “carregar”
    await page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // 7) menu 3 pontinhos (kebab) e “Baixar o relatório”
    // No seu print o menu é o ícone de 3 pontos no topo direito.
    const kebab = page.locator('button:has-text("⋮"), button[aria-label*="Mais"], button[aria-label*="menu"], button:has(svg)').first();
    await kebab.click({ timeout: 30000 }).catch(async () => {
      // fallback: clique por coordenada (último recurso)
      await page.mouse.click(1130, 150);
    });

    await page.waitForTimeout(600);

    // item “Baixar o relatório”
    await page.locator('text=/Baixar o relatório/i').first().click({ timeout: 30000 });
    await page.waitForTimeout(900);

    // 8) modal “Fazer download do relatório (PDF)” -> botão “Fazer download”
    const downloadBtn = page.locator('button:has-text("Fazer download")').first();
    await downloadBtn.waitFor({ state: "visible", timeout: 90000 });

    // esperar habilitar
    for (let i = 0; i < 180; i++) {
      const disabled = await downloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    // capturar download
    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await downloadBtn.click({ timeout: 30000 });
    const download = await downloadPromise;

    const path = await download.path();
    if (!path) throw new Error("Download path is null");
    const buffer = fs.readFileSync(path);

    return buffer;
  } finally {
    await browser.close();
  }
}

app.post("/export", requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date } = req.body || {};

    // log básico (ajuda MUITO no Render)
    console.log("REQ /export", {
      looker_url: !!looker_url,
      client_name,
      start_date,
      end_date,
    });

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({ error: "Missing looker_url, client_name, start_date, end_date" });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
    res.status(200).send(pdf);
  } catch (e) {
    console.error("EXPORT ERROR:", e?.message || e, e?.stack || "");
    res.status(500).json({
      error: "Failed to export PDF",
      detail: e?.message || String(e),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

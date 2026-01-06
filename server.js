const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || "";

function requireKey(req, res, next) {
  if (!API_KEY) return next(); // se não setou no Render, não bloqueia
  const sent = req.header("x-api-key");
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function parseBRDate(s) {
  // aceita "2025-12-01" ou "01/12/2025"
  if (!s) return null;
  if (s.includes("/")) {
    const [dd, mm, yyyy] = s.split("/").map((v) => Number(v));
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split("-").map((v) => Number(v));
  return { dd, mm, yyyy };
}

function monthAbbrToNumber(upper) {
  const monthMap = {
    JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
    JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  };
  const m = upper.match(/(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\.?\s+DE\s+(\d{4})/);
  if (!m) return null;
  return { mm: monthMap[m[1]], yyyy: Number(m[2]) };
}

async function setDateInPickerColumn(page, columnTitle, dateObj) {
  // columnTitle: "Data de início" ou "Data de término"
  const { dd, mm, yyyy } = dateObj;
  const target = new Date(yyyy, mm - 1, 1);

  const col = page.locator(`text=${columnTitle}`).first().locator(".."); // container da coluna
  await col.waitFor({ state: "visible", timeout: 60000 });

  // tenta achar o header do mês/ano dentro da coluna (ex: "JAN. DE 2026")
  const header = col.locator('text=/((JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\\.?\\s+DE\\s+\\d{4})/').first();
  await header.waitFor({ state: "visible", timeout: 60000 });

  // setinhas próximas da coluna (tentamos achar botões clicáveis perto do header)
  const nextBtn = col.locator('button:has-text("›"), button:has-text(">")').first();
  const prevBtn = col.locator('button:has-text("‹"), button:has-text("<")').first();

  for (let i = 0; i < 36; i++) {
    const text = ((await header.textContent()) || "").toUpperCase();
    const curMY = monthAbbrToNumber(text);
    if (!curMY) break;

    const cur = new Date(curMY.yyyy, curMY.mm - 1, 1);
    if (cur.getTime() === target.getTime()) break;

    if (cur < target) {
      if (await nextBtn.count()) await nextBtn.click();
      else break;
    } else {
      if (await prevBtn.count()) await prevBtn.click();
      else break;
    }
    await page.waitForTimeout(250);
  }

  // clicar no dia (dentro da coluna)
  // IMPORTANT: usamos :has-text e filtramos por elemento clicável
  const day = col.locator(`button:has-text("${dd}"), td:has-text("${dd}"), div:has-text("${dd}")`).first();
  await day.click({ timeout: 30000 });
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
    // 1) abrir relatório
    await page.goto(looker_url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(2500);

    // 2) abrir filtro Conta de Anúncio
    await page.locator("text=Conta de Anúncio").first().click({ timeout: 60000 });
    await page.waitForTimeout(800);

    // 3) desmarcar todas (checkbox do topo)
    // no seu print é um checkbox no topo esquerdo do dropdown
    const topCheckbox = page.locator("md-checkbox input[type='checkbox']").first();
    if (await topCheckbox.count()) {
      await topCheckbox.click({ timeout: 20000 });
    } else {
      await page.locator("md-checkbox").first().click({ timeout: 20000 });
    }
    await page.waitForTimeout(700);

    // 4) pesquisar e selecionar cliente
    const search = page.locator('input[placeholder*="Digite"]').first();
    if (await search.count()) {
      await search.fill(client_name, { timeout: 20000 });
      await page.waitForTimeout(800);
    }

    // tenta clicar no checkbox do item filtrado
    // o aria-label geralmente é o nome completo
    const clientCheckbox = page.locator(`md-checkbox[aria-label="${client_name}"]`).first();
    if (await clientCheckbox.count()) {
      await clientCheckbox.click({ timeout: 20000 });
    } else {
      // fallback: clica no texto
      await page.locator(`text=${client_name}`).first().click({ timeout: 20000 });
    }

    // fecha dropdown
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1200);

    // 5) abrir seletor de período
    await page.locator("text=Selecionar período").first().click({ timeout: 60000 });
    await page.waitForTimeout(1000);

    // 6) setar datas
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error("Invalid dates");

    await setDateInPickerColumn(page, "Data de início", sd);
    await setDateInPickerColumn(page, "Data de término", ed);

    // aplicar
    await page.locator('button:has-text("Aplicar")').first().click({ timeout: 30000 });

    // aguarda recalcular
    await page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // 7) menu de 3 pontos (kebab) e baixar relatório
    // tenta pegar pelo botão com ícone (bem no topo)
    const menuBtn = page.locator('button:has(svg), button[aria-label*="Mais"]').first();
    await menuBtn.click({ timeout: 30000 }).catch(async () => {
      // fallback posição aproximada (ajuste se precisar)
      await page.mouse.click(1130, 150);
    });

    await page.waitForTimeout(600);
    await page.locator("text=Baixar o relatório").first().click({ timeout: 30000 });

    // 8) modal do download + botão "Fazer download" (esperar habilitar)
    const downloadBtn = page.locator('button:has-text("Fazer download")').first();
    await downloadBtn.waitFor({ state: "visible", timeout: 90000 });

    // espera habilitar
    for (let i = 0; i < 180; i++) {
      const disabled = await downloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
    await downloadBtn.click({ timeout: 30000 });
    const download = await downloadPromise;

    const path = await download.path();
    const fs = require("fs");
    const buffer = fs.readFileSync(path);

    return buffer;
  } finally {
    await browser.close();
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
    res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to export PDF", detail: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

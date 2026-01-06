// server.js (pronto) — com seleção de cliente tolerante a acentos + fallback
const express = require("express");
const fs = require("fs");
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
    const [dd, mm, yyyy] = s.split("/").map(Number);
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split("-").map(Number);
  return { dd, mm, yyyy };
}

async function setDateInPicker(page, labelText, dateObj) {
  // labelText: "Data de início" ou "Data de término"
  const { dd, mm, yyyy } = dateObj;

  const label = page.getByText(labelText, { exact: false }).first();
  await label.waitFor({ state: "visible", timeout: 60000 });

  // container perto do label (coluna do calendário)
  const container = label.locator("..").locator("..");

  // header tipo "JAN. DE 2026"
  const header = container.locator("text=/[A-Z]{3}\\.?\\s+DE\\s+\\d{4}/").first();

  const monthMap = {
    JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
    JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
  };

  const target = new Date(yyyy, mm - 1, 1);

  for (let i = 0; i < 36; i++) {
    const headerText = ((await header.textContent().catch(() => "")) || "").toUpperCase();
    const m = headerText.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);

    if (!m || !monthMap[m[1]]) break;

    const cur = new Date(Number(m[2]), monthMap[m[1]] - 1, 1);
    if (cur.getTime() === target.getTime()) break;

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
  }

  // clica no dia dentro da coluna
  const dayBtn = container.getByText(String(dd), { exact: true }).first();
  await dayBtn.scrollIntoViewIfNeeded();
  await dayBtn.click({ timeout: 30000 });

  await page.waitForTimeout(300);
}

function normalizeStr(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

async function exportLookerPDF({ looker_url, client_name, start_date, end_date }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1400, height: 900 },
    locale: "pt-BR",
  });

  const page = await context.newPage();

  try {
    // 1) abrir e esperar renderizar
    await page.goto(looker_url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(8000);

    // Detecta login/consent (se aparecer, o relatório não está público)
    const possibleLogin = page
      .locator("text=/Fazer login|Entrar|Sign in|Choose an account|Use another account/i")
      .first();
    if (await possibleLogin.count()) {
      throw new Error(
        "O Looker Studio parece estar pedindo login/consent. Deixe o relatório público (qualquer pessoa com link pode ver)."
      );
    }

    // 2) abrir filtro "Conta de Anúncio" (texto pode estar truncado)
    const contaBtn = page.getByText(/Conta de Anúnc/i).first();
    await contaBtn.waitFor({ state: "visible", timeout: 120000 });
    await contaBtn.scrollIntoViewIfNeeded();
    await contaBtn.click({ timeout: 120000 });
    await page.waitForTimeout(800);

    // 3) desmarcar todas (checkbox topo do dropdown)
    const topMdCheckbox = page.locator("md-checkbox").first();
    await topMdCheckbox.waitFor({ state: "visible", timeout: 60000 });
    await topMdCheckbox.click({ timeout: 60000 });
    await page.waitForTimeout(800);

    // 4) buscar e selecionar cliente (TOLERANTE A ACENTOS)
    const search = page.locator('input[placeholder*="Digite"]').first();
    await search.waitFor({ state: "visible", timeout: 60000 });

    await search.fill("");
    await search.type(client_name, { delay: 20 });
    await page.waitForTimeout(1200);

    const targetNorm = normalizeStr(client_name);
    const titleSpans = page.locator("span[title]");
    const spanCount = await titleSpans.count().catch(() => 0);

    let clicked = false;

    // 4.1) tenta achar por title normalizado (sem acento)
    for (let i = 0; i < Math.min(spanCount, 80); i++) {
      const t = await titleSpans.nth(i).getAttribute("title").catch(() => null);
      if (!t) continue;

      if (normalizeStr(t) === targetNorm) {
        const cb = page.locator("md-checkbox", { has: titleSpans.nth(i) }).first();
        await cb.scrollIntoViewIfNeeded();
        await cb.click({ timeout: 30000 });
        clicked = true;
        break;
      }
    }

    // 4.2) fallback: clicar por texto visível (regex)
    if (!clicked) {
      const escaped = client_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const byText = page.getByText(new RegExp(escaped, "i")).first();

      if (await byText.count()) {
        await byText.scrollIntoViewIfNeeded();
        await byText.click({ timeout: 30000 });
        clicked = true;
      }
    }

    // 4.3) fallback final: loga amostras de titles para diagnóstico
    if (!clicked) {
      const sample = [];
      for (let i = 0; i < Math.min(spanCount, 12); i++) {
        const t = await titleSpans.nth(i).getAttribute("title").catch(() => null);
        if (t) sample.push(t);
      }
      console.log("❌ Não encontrei o cliente. Exemplos de títulos no dropdown:", sample);
      throw new Error(`Não encontrei o cliente no dropdown: ${client_name}`);
    }

    // fechar dropdown
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1500);

    // 5) abrir período
    const periodoBtn = page.getByText(/Selecionar período/i).first();
    await periodoBtn.waitFor({ state: "visible", timeout: 120000 });
    await periodoBtn.scrollIntoViewIfNeeded();
    await periodoBtn.click({ timeout: 120000 });
    await page.waitForTimeout(1200);

    // 6) setar datas
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error('Datas inválidas. Use "YYYY-MM-DD" ou "DD/MM/YYYY".');

    await setDateInPicker(page, "Data de início", sd);
    await setDateInPicker(page, "Data de término", ed);

    // aplicar
    const aplicarBtn = page.getByText("Aplicar", { exact: true }).first();
    await aplicarBtn.click({ timeout: 60000 });

    await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(5000);

    // 7) menu 3 pontinhos (kebab)
    const kebabBtn = page
      .locator('button:has(svg)')
      .first()
      .or(page.locator('button[aria-label*="Mais"]').first())
      .or(page.locator('button[aria-label*="menu"]').first());

    await kebabBtn.click({ timeout: 30000 }).catch(async () => {
      // fallback por coordenada (ajuste se necessário)
      await page.mouse.click(1130, 135);
    });

    await page.waitForTimeout(800);

    // 8) clicar "Baixar o relatório"
    const baixarItem = page.getByText(/Baixar o relatório/i).first();
    await baixarItem.waitFor({ state: "visible", timeout: 60000 });
    await baixarItem.click({ timeout: 60000 });

    // 9) modal "Fazer download do relatório (PDF)" -> botão "Fazer download"
    const fazerDownloadBtn = page.getByText("Fazer download", { exact: true }).first();
    await fazerDownloadBtn.waitFor({ state: "visible", timeout: 120000 });

    // espera habilitar (preparando PDF)
    for (let i = 0; i < 240; i++) {
      const disabled = await fazerDownloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
    await fazerDownloadBtn.click({ timeout: 60000 });
    const download = await downloadPromise;

    const filePath = await download.path();
    const buffer = fs.readFileSync(filePath);

    return buffer;
  } finally {
    await browser.close();
  }
}

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/export", requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date, file_name } = req.body || {};

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({ error: "Missing looker_url, client_name, start_date, end_date" });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    const safe = String(file_name || "report.pdf").replace(/[^\w\-\.]+/g, "_");
    const finalName = safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${finalName}"`);
    res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Failed to export PDF",
      detail: String(e?.message || e),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

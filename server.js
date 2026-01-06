const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || "";

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const sent = req.header("x-api-key");
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function parseBRDate(s) {
  // "2025-12-01" ou "01/12/2025"
  if (!s) return null;
  if (s.includes("/")) {
    const [dd, mm, yyyy] = s.split("/").map((x) => Number(x));
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split("-").map((x) => Number(x));
  return { dd, mm, yyyy };
}

const MONTH_MAP = {
  JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6,
  JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12,
};

async function gotoMonth(page, root, targetMonth, targetYear) {
  // root = container do datepicker (a coluna do início ou do término)
  const target = new Date(targetYear, targetMonth - 1, 1);

  for (let i = 0; i < 36; i++) {
    const header = root.locator("text=/[A-Z]{3}\\.?(\\s+DE)?\\s+\\d{4}/").first();
    const headerText = ((await header.textContent().catch(() => "")) || "").toUpperCase();

    const m = headerText.match(/([A-Z]{3})\.?\s*(DE\s*)?(\d{4})/);
    if (!m) break;

    const curMonth = MONTH_MAP[m[1]];
    const curYear = Number(m[3]);
    if (!curMonth || !curYear) break;

    const cur = new Date(curYear, curMonth - 1, 1);
    if (cur.getTime() === target.getTime()) return true;

    // setinhas do calendário (você mostrou no print)
    const nextBtn = root.locator('button:has-text("›"), button:has-text(">")').first();
    const prevBtn = root.locator('button:has-text("‹"), button:has-text("<")').first();

    if (cur < target) {
      if (await nextBtn.count()) await nextBtn.click();
      else break;
    } else {
      if (await prevBtn.count()) await prevBtn.click();
      else break;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function setDateInPicker(page, labelText, dateObj) {
  // labelText: "Data de início" ou "Data de término"
  const { dd, mm, yyyy } = dateObj;

  const label = page.locator(`text=${labelText}`).first();
  await label.waitFor({ state: "visible", timeout: 60000 });

  // pega a COLUNA do datepicker correspondente ao label
  // (normalmente o label está dentro do container da coluna)
  const col = label.locator("xpath=ancestor::div[contains(@class,'md-datepicker') or contains(@class,'date')][1]")
    .first();

  // fallback: sobe alguns níveis se o acima não existir
  const root = (await col.count()) ? col : label.locator("xpath=ancestor::div[1]").first();

  await gotoMonth(page, root, mm, yyyy);

  // clica no dia (no seu print o dia é clicável)
  // tenta como botão; se não, tenta texto simples dentro da coluna
  const dayBtn = root.locator(`button:has-text("${dd}")`).first();
  if (await dayBtn.count()) {
    await dayBtn.click({ timeout: 20000 });
  } else {
    await root.locator(`text="${dd}"`).first().click({ timeout: 20000 });
  }

  await page.waitForTimeout(200);
}

async function exportLookerPDF({ looker_url, client_name, start_date, end_date }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    locale: "pt-BR",
  });

  const page = await context.newPage();

  // helper: screenshot para debug quando der ruim
  const debugShot = async (name) => {
    try {
      const p = `/tmp/${name}.png`;
      await page.screenshot({ path: p, fullPage: true });
      return p;
    } catch {
      return null;
    }
  };

  try {
    // 1) abrir
    await page.goto(looker_url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(2500);

    // 2) abrir filtro "Conta de Anúncio"
    const filtroConta = page.locator('text=Conta de Anúncio').first();
    await filtroConta.waitFor({ state: "visible", timeout: 90000 });
    await filtroConta.click({ timeout: 60000 });
    await page.waitForTimeout(600);

    // 3) desmarcar todas (checkbox do topo do dropdown)
    // no seu HTML aparece md-checkbox com input type checkbox
    const topCheckboxInput = page.locator("md-virtual-repeat-container md-checkbox input[type='checkbox']").first();
    if (await topCheckboxInput.count()) {
      await topCheckboxInput.click({ timeout: 20000 });
    } else {
      // fallback: clica no md-checkbox do topo
      await page.locator("md-virtual-repeat-container md-checkbox").first().click({ timeout: 20000 });
    }
    await page.waitForTimeout(400);

    // 4) buscar e selecionar o cliente
    const search = page.locator('input[placeholder*="Digite"]').first();
    if (await search.count()) {
      await search.fill(client_name);
      await page.waitForTimeout(500);
    }

    // melhor seletor (você mostrou aria-label exatamente com o nome)
    const clientCheckbox = page.locator(`md-checkbox[aria-label="${client_name}"]`).first();
    if (await clientCheckbox.count()) {
      await clientCheckbox.click({ timeout: 20000 });
    } else {
      // fallback por texto visível
      await page.locator(`text=${client_name}`).first().click({ timeout: 20000 });
    }

    // fecha dropdown
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1200);

    // 5) abrir período
    await page.locator("text=Selecionar período").first().click({ timeout: 60000 });
    await page.waitForTimeout(900);

    // 6) setar datas
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error("Datas inválidas: start_date/end_date");

    await setDateInPicker(page, "Data de início", sd);
    await setDateInPicker(page, "Data de término", ed);

    // aplicar
    await page.locator('button:has-text("Aplicar")').first().click({ timeout: 30000 });

    // espera carregar dados (looker é lento mesmo)
    await page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // 7) menu 3 pontinhos (kebab)
    // no seu print é um botão com ícone e abre menu com "Baixar o relatório"
    const kebab = page.locator("button:has(svg)").filter({ hasText: "" }).first();
    await kebab.click({ timeout: 30000 }).catch(async () => {
      // fallback: tenta achar pelo mat-icon/menu
      await page.locator("button[aria-label*='Mais'], button[aria-label*='menu']").first().click({ timeout: 30000 });
    });

    await page.waitForTimeout(600);

    // 8) clicar "Baixar o relatório"
    await page.locator("text=Baixar o relatório").first().click({ timeout: 30000 });

    // 9) modal "Fazer download do relatório (PDF)"
    const downloadBtn = page.locator('button:has-text("Fazer download")').first();
    await downloadBtn.waitFor({ state: "visible", timeout: 90000 });

    // espera habilitar (no seu print fica cinza um tempo)
    for (let i = 0; i < 200; i++) {
      const disabled = await downloadBtn.isDisabled().catch(() => true);
      if (!disabled) break;
      await page.waitForTimeout(500);
    }

    const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
    await downloadBtn.click({ timeout: 30000 });
    const download = await downloadPromise;

    const outPath = `/tmp/report-${Date.now()}.pdf`;
    await download.saveAs(outPath);

    const buffer = fs.readFileSync(outPath);
    return buffer;
  } catch (err) {
    const shot = await debugShot("debug_error");
    const detail = `${err?.message || err}`;
    const extra = shot ? ` | screenshot: ${shot}` : "";
    throw new Error(detail + extra);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

app.post("/export", requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date } = req.body || {};

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({
        error: "Missing looker_url, client_name, start_date, end_date",
        got: { looker_url: !!looker_url, client_name: !!client_name, start_date: !!start_date, end_date: !!end_date },
      });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to export PDF", detail: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

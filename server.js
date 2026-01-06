const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || "";
const PORT = process.env.PORT || 3000;

// Middleware de autenticação com API_KEY
function requireKey(req, res, next) {
  if (!API_KEY) return next(); // Se não setado no Render, não bloqueia
  const sent = req.header("x-api-key");
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Normaliza texto removendo acentos e espaços extras
function norm(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Converte a data no formato brasileiro (DD/MM/YYYY ou YYYY-MM-DD) para o objeto de data
function parseBRDate(s) {
  if (!s) return null;
  if (s.includes("/")) {
    const [dd, mm, yyyy] = s.split("/").map(Number);
    return { dd, mm, yyyy };
  }
  const [yyyy, mm, dd] = s.split("-").map(Number);
  return { dd, mm, yyyy };
}

// Função para tirar screenshots de erro e salvar HTML para debug
async function safeScreenshot(page, label = "erro") {
  try {
    const p = `/tmp/${label}-${Date.now()}.png`;
    await page.screenshot({ path: p, fullPage: true });
    console.log("📸 Screenshot:", p);
  } catch {}
}

async function safeSaveHTML(frameOrPage, label = "frame") {
  try {
    const p = `/tmp/${label}-${Date.now()}.html`;
    const html = await frameOrPage.content();
    fs.writeFileSync(p, html);
    console.log("🧾 HTML salvo:", p);
  } catch {}
}

// Espera até encontrar o frame correto com base no conteúdo
async function getReportFrame(page) {
  const deadline = Date.now() + 120000;  // Aumentando o timeout para 2 minutos
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const f of frames) {
      try {
        const body = f.locator("body");
        if (!(await body.count())) continue;
        const txt = await body.innerText({ timeout: 1500 }).catch(() => "");
        if (!txt) continue;
        const t = norm(txt);
        if (t.includes("conta de anuncio") || t.includes("selecionar periodo") || t.includes("relatorio clientes")) {
          return f;
        }
      } catch {}
    }
    await page.waitForTimeout(1200);
  }
  return page.mainFrame();
}

// Clica no texto no frame utilizando expressão regular
async function clickByTextRegex(frame, regex, timeout = 120000) {  // Aumentando para 120s
  const loc = frame.locator(`text=${regex}`).first();
  await loc.waitFor({ state: "visible", timeout });
  await loc.click({ timeout });
}

// Espera até o filtro "Conta de Anúncio" e clica
async function openAccountDropdown(frame) {
  const candidates = [
    frame.locator('text=/Conta\\s+de\\s+Anúncio/i').first(),
    frame.locator('text=/Conta\\s+de\\s+Anuncio/i').first(), // sem acento
  ];

  for (const c of candidates) {
    try {
      if (await c.count()) {
        await c.waitFor({ state: "visible", timeout: 120000 });  // 120 segundos de espera
        await c.click({ timeout: 120000 });
        return;
      }
    } catch {}
  }

  const fallback = frame.locator('div:has-text("Conta de Anúncio")').first();
  if (await fallback.count()) {
    await fallback.click({ timeout: 120000 });
    return;
  }

  throw new Error('Timeout: não encontrei "Conta de Anúncio" no frame do relatório.');
}

// Desmarcar todas as contas no filtro dropdown
async function uncheckAllInDropdown(frame) {
  const topInput = frame.locator('md-checkbox input[type="checkbox"]').first();
  if (await topInput.count()) {
    await topInput.click({ timeout: 30000 }).catch(() => {});
    await frame.waitForTimeout(500);
    return;
  }
  const topMd = frame.locator("md-checkbox").first();
  if (await topMd.count()) {
    await topMd.click({ timeout: 30000 }).catch(() => {});
    await frame.waitForTimeout(500);
    return;
  }
}

// Seleciona o cliente pelo nome, com acento ou sem acento
async function selectClient(frame, clientName) {
  const search = frame.locator('input[placeholder*="Digite"]').first();
  await search.waitFor({ state: "visible", timeout: 120000 });  // 120 segundos de espera
  await search.fill("");
  await search.fill(clientName);
  await frame.waitForTimeout(800);

  const target = norm(clientName);
  const spans = frame.locator("span[title]");
  const count = await spans.count();

  const limit = Math.min(count, 300);
  for (let i = 0; i < limit; i++) {
    const title = await spans.nth(i).getAttribute("title").catch(() => "");
    if (!title) continue;
    if (norm(title) === target) {
      const checkbox = spans.nth(i).locator("xpath=ancestor::md-checkbox[1]");
      await checkbox.click({ timeout: 30000 });
      return;
    }
  }

  const escaped = clientName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fallback = frame.locator(`text=/${escaped}/i`).first();
  if (await fallback.count()) {
    await fallback.click({ timeout: 30000 });
    return;
  }

  throw new Error(`Não consegui achar o cliente no menu suspenso: "${clientName}"`);
}

// Abre a escolha do período
async function openPeriodPicker(frame) {
  const candidates = [
    frame.locator('text=/Selecionar\\s+período/i').first(),
    frame.locator('text=/Selecionar\\s+periodo/i').first(),
  ];

  for (const c of candidates) {
    try {
      if (await c.count()) {
        await c.waitFor({ state: "visible", timeout: 120000 });  // 120 segundos de espera
        await c.click({ timeout: 120000 });
        return;
      }
    } catch {}
  }

  throw new Error('Timeout: não encontrei "Selecionar período" no frame do relatório.');
}

// Define as datas no picker
async function setDateInPicker(frame, labelText, dateObj) {
  const { dd, mm, yyyy } = dateObj;
  const label = frame.locator(`text=${labelText}`).first();
  await label.waitFor({ state: "visible", timeout: 120000 });  // 120 segundos de espera

  const container = label.locator("xpath=ancestor::div[contains(@class,'mat') or contains(@class,'md')][1]").first();
  const scope = (await container.count()) ? container : frame;

  const monthMap = {
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  };

  const target = new Date(yyyy, mm - 1, 1);

  for (let i = 0; i < 36; i++) {
    const header = scope.locator('text=/DE\\s+\\d{4}/').first();
    const headerText = await header.textContent() || "";
    const u = headerText.toUpperCase();

    let curMonth = null;
    let curYear = null;

    const m = u.match(/([A-Z]{3})\.?\s+DE\s+(\d{4})/);
    if (m) {
      const mon3 = m[1];
      const year = Number(m[2]);
      const mon = monthMap[mon3.toLowerCase()];
      if (mon && year) {
        curMonth = mon;
        curYear = year;
      }
    }

    if (curMonth && curYear) {
      const cur = new Date(curYear, curMonth - 1, 1);
      if (cur.getTime() === target.getTime()) break;

      const nextBtn = scope.locator('button:has-text("›"), button:has-text(">")').first();
      const prevBtn = scope.locator('button:has-text("‹"), button:has-text("<")').first();

      if (cur < target) {
        if (await nextBtn.count()) await nextBtn.click().catch(() => {});
        else break;
      } else {
        if (await prevBtn.count()) await prevBtn.click().catch(() => {});
        else break;
      }
    }
    await frame.waitForTimeout(250);
  }

  const dayBtn = scope.locator(`text="${dd}"`).first();
  await dayBtn.click({ timeout: 20000 });
}

// Função para abrir o menu de 3 pontos (kebab)
async function openKebabMenu(frame) {
  const btnCandidates = [
    frame.locator('button:has(svg)').first(),
    frame.locator('button[aria-label*="Mais"]').first(),
    frame.locator('button[aria-label*="menu"]').first(),
  ];

  for (const b of btnCandidates) {
    try {
      if (await b.count()) {
        await b.click({ timeout: 30000 });
        return;
      }
    } catch {}
  }

  throw new Error("Não consegui abrir o menu (3 pontinhos).");
}

// Função para clicar no botão de download
async function clickDownloadReport(frame) {
  const item = frame.locator('text=/Baixar\\s+o\\s+relatório/i').first();
  await item.waitFor({ state: "visible", timeout: 120000 });  // 120 segundos de espera
  await item.click({ timeout: 120000 });
}

// Função que espera pelo download e o salva
async function waitDownloadModalAndDownload(frame, page) {
  const modalTitle = frame.locator('text=/Fazer\\s+download\\s+do\\s+relatório\\s*\\(PDF\\)/i').first();
  await modalTitle.waitFor({ state: "visible", timeout: 120000 });  // 120 segundos de espera

  const btn = frame.locator('button:has-text("Fazer download")').first();
  await btn.waitFor({ state: "visible", timeout: 120000 });  // 120 segundos de espera

  for (let i = 0; i < 180; i++) {
    const disabled = await btn.isDisabled().catch(() => true);
    if (!disabled) break;
    await page.waitForTimeout(500);
  }

  const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
  await btn.click({ timeout: 60000 });
  const download = await downloadPromise;

  const outPath = `/tmp/report-${Date.now()}.pdf`;
  await download.saveAs(outPath);

  const buffer = fs.readFileSync(outPath);
  return buffer;
}

// Função principal para exportar o PDF
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
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 120000 });  // 120 segundos de espera
    await page.waitForTimeout(6000);  // Tempo extra para o carregamento do iframe

    // Obter o frame do relatório
    const frame = await getReportFrame(page);
    await openAccountDropdown(frame);

    await uncheckAllInDropdown(frame);
    await selectClient(frame, client_name);

    await page.keyboard.press("Escape").catch(() => {});
    await openPeriodPicker(frame);

    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error("Datas inválidas.");

    await setDateInPicker(frame, "Data de início", sd);
    await setDateInPicker(frame, "Data de término", ed);

    const applyBtn = frame.locator('button:has-text("Aplicar")').first();
    await applyBtn.click({ timeout: 120000 });  // 120 segundos de espera
    await page.waitForLoadState("networkidle", { timeout: 120000 });  // 120 segundos de espera

    await openKebabMenu(frame);
    await clickDownloadReport(frame);
    const pdfBuffer = await waitDownloadModalAndDownload(frame, page);

    return pdfBuffer;
  } catch (error) {
    console.error("Erro ao exportar PDF:", error.message || error);
    await safeScreenshot(page, "erro");
    throw error;
  } finally {
    await browser.close();
  }
}

// Endpoint de exportação de PDF
app.post("/export", requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date } = req.body || {};

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({ error: "Missing looker_url, client_name, start_date, end_date" });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to export PDF", detail: e?.message || String(e) });
  }
});

// Roda o servidor na porta definida
app.listen(PORT, () => {
  console.log(`==> Serviço detectado em execução na porta ${PORT}`);
});

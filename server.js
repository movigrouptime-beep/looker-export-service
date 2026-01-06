/* server.js - Looker Studio Export Service (Playwright)
   - Robust iframe detection
   - Robust filter click (Conta de Anúncio / Selecionar período)
   - Client selection with search + accent-insensitive matching
   - Waits for download modal "Fazer download do relatório (PDF)"
   - Saves screenshot/html on error for debugging
*/

const express = require("express");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.EXPORT_SERVICE_API_KEY || "";
const PORT = process.env.PORT || 3000;

function requireKey(req, res, next) {
  if (!API_KEY) return next();
  const sent = req.header("x-api-key");
  if (!sent || sent !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function norm(s = "") {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

async function getReportFrame(page) {
  // tenta achar um frame que contenha textos do relatório
  // (Looker Studio costuma usar iframes)
  const deadline = Date.now() + 90000;

  while (Date.now() < deadline) {
    const frames = page.frames();

    for (const f of frames) {
      try {
        // pega um trecho de texto (rápido)
        const body = f.locator("body");
        if (!(await body.count())) continue;

        const txt = await body.innerText({ timeout: 1500 }).catch(() => "");
        if (!txt) continue;

        const t = norm(txt);
        if (
          t.includes("conta de anuncio") ||
          t.includes("selecionar periodo") ||
          t.includes("movi group") ||
          t.includes("relatorio clientes")
        ) {
          return f;
        }
      } catch {}
    }

    await page.waitForTimeout(1200);
  }

  // fallback: main frame (pode funcionar se não houver iframe)
  return page.mainFrame();
}

async function clickByTextRegex(frame, regex, timeout = 60000) {
  const loc = frame.locator(`text=${regex}`).first();
  await loc.waitFor({ state: "visible", timeout });
  await loc.click({ timeout });
}

async function openAccountDropdown(frame) {
  // tenta achar e clicar no filtro "Conta de Anúncio" (com ou sem ":" e com seleção já aplicada)
  const candidates = [
    frame.locator('text=/Conta\\s+de\\s+Anúncio/i').first(),
    frame.locator('text=/Conta\\s+de\\s+Anuncio/i').first(), // sem acento
    frame.locator('text=/Conta\\s+de\\s+Anúncio\\s*:/i').first(),
    frame.locator('text=/Conta\\s+de\\s+Anuncio\\s*:/i').first(),
  ];

  for (const c of candidates) {
    try {
      if (await c.count()) {
        await c.waitFor({ state: "visible", timeout: 60000 });
        await c.click({ timeout: 60000 });
        return;
      }
    } catch {}
  }

  // fallback: tenta clicar num "dropdown" no topo que contenha "Conta de Anúncio"
  const fallback = frame.locator('div:has-text("Conta de Anúncio")').first();
  if (await fallback.count()) {
    await fallback.click({ timeout: 60000 });
    return;
  }

  throw new Error('Timeout: não encontrei "Conta de Anúncio" no frame do relatório.');
}

async function uncheckAllInDropdown(frame) {
  // no seu print: checkbox do topo do dropdown (primeiro md-checkbox)
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

async function selectClient(frame, clientName) {
  // melhor estratégia:
  // 1) usa a busca "Digite para pesquisar"
  // 2) clica no item pelo span[title] comparando com norm()
  const search = frame.locator('input[placeholder*="Digite"]').first();
  await search.waitFor({ state: "visible", timeout: 60000 });
  await search.fill(""); // limpa
  await search.fill(clientName);
  await frame.waitForTimeout(800);

  const target = norm(clientName);

  // pega os spans com title (item da lista)
  const spans = frame.locator("span[title]");
  const count = await spans.count();

  // como pode ser lista virtual, tentamos os primeiros N
  const limit = Math.min(count, 300);
  for (let i = 0; i < limit; i++) {
    const title = await spans.nth(i).getAttribute("title").catch(() => "");
    if (!title) continue;
    if (norm(title) === target) {
      // clica no md-checkbox "pai" do span
      const checkbox = spans.nth(i).locator("xpath=ancestor::md-checkbox[1]");
      await checkbox.click({ timeout: 30000 });
      return;
    }
  }

  // fallback: contains sem igualdade total
  // (escapa regex)
  const escaped = clientName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fallback = frame.locator(`text=/${escaped}/i`).first();
  if (await fallback.count()) {
    await fallback.click({ timeout: 30000 });
    return;
  }

  throw new Error(`Não consegui achar o cliente no menu suspenso: "${clientName}"`);
}

async function openPeriodPicker(frame) {
  const candidates = [
    frame.locator('text=/Selecionar\\s+período/i').first(),
    frame.locator('text=/Selecionar\\s+periodo/i').first(), // sem acento
  ];

  for (const c of candidates) {
    try {
      if (await c.count()) {
        await c.waitFor({ state: "visible", timeout: 60000 });
        await c.click({ timeout: 60000 });
        return;
      }
    } catch {}
  }

  throw new Error('Timeout: não encontrei "Selecionar período" no frame do relatório.');
}

async function setDateInPicker(frame, labelText, dateObj) {
  // labelText: "Data de início" ou "Data de término"
  const { dd, mm, yyyy } = dateObj;

  const label = frame.locator(`text=${labelText}`).first();
  await label.waitFor({ state: "visible", timeout: 60000 });

  // tenta achar o "bloco" da coluna referente ao label
  // subimos alguns pais
  const container = label.locator("xpath=ancestor::div[contains(@class,'mat') or contains(@class,'md')][1]").first();

  // fallback: usa o frame inteiro se não achar container
  const scope = (await container.count()) ? container : frame;

  // navegar até mês/ano usando setinhas
  const monthMap = {
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  };

  const target = new Date(yyyy, mm - 1, 1);

  for (let i = 0; i < 36; i++) {
    // tenta ler header tipo "JAN. DE 2026"
    const header = scope.locator('text=/DE\\s+\\d{4}/').first();
    const headerText = (await header.textContent().catch(() => "")) || "";
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

      // botões de navegação (setas)
      const nextBtn = scope.locator('button:has-text("›"), button:has-text(">")').first();
      const prevBtn = scope.locator('button:has-text("‹"), button:has-text("<")').first();

      if (cur < target) {
        if (await nextBtn.count()) await nextBtn.click().catch(() => {});
        else break;
      } else {
        if (await prevBtn.count()) await prevBtn.click().catch(() => {});
        else break;
      }
    } else {
      // se não conseguiu ler, tenta só clicar no dia e sair
      break;
    }

    await frame.waitForTimeout(250);
  }

  // clicar no dia
  // cuidado: existem dois calendários (início e término), então restringimos ao scope
  const dayBtn = scope.locator(`text="${dd}"`).first();
  await dayBtn.click({ timeout: 30000 });

  await frame.waitForTimeout(250);
}

async function openKebabMenu(frame) {
  // O menu de 3 pontos no topo (kebab) às vezes é um botão com svg
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

  // fallback: click coordenada aproximada no topo direito
  // (pode variar, mas ajuda como último recurso)
  throw new Error("Não consegui abrir o menu (3 pontinhos).");
}

async function clickDownloadReport(frame) {
  const item = frame.locator('text=/Baixar\\s+o\\s+relatório/i').first();
  await item.waitFor({ state: "visible", timeout: 60000 });
  await item.click({ timeout: 60000 });
}

async function waitDownloadModalAndDownload(frame, page) {
  // modal: "Fazer download do relatório (PDF)"
  const modalTitle = frame.locator('text=/Fazer\\s+download\\s+do\\s+relatório\\s*\\(PDF\\)/i').first();
  await modalTitle.waitFor({ state: "visible", timeout: 90000 });

  const btn = frame.locator('button:has-text("Fazer download")').first();
  await btn.waitFor({ state: "visible", timeout: 90000 });

  // aguarda habilitar (Looker prepara o PDF)
  for (let i = 0; i < 180; i++) {
    const disabled = await btn.isDisabled().catch(() => true);
    if (!disabled) break;
    await page.waitForTimeout(500);
  }

  // dispara download e salva em /tmp
  const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
  await btn.click({ timeout: 60000 });
  const download = await downloadPromise;

  const outPath = `/tmp/report-${Date.now()}.pdf`;
  await download.saveAs(outPath);

  const buffer = fs.readFileSync(outPath);
  return buffer;
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
    console.log("Abrindo URL:", looker_url);
    await page.goto(looker_url, { waitUntil: "domcontentloaded", timeout: 120000 });

    // dá tempo dos iframes carregarem
    await page.waitForTimeout(6000);

    // pega o frame do relatório
    const frame = await getReportFrame(page);
    console.log("Frame selecionado:", frame.url());

    // 1) abrir filtro Conta de Anúncio
    await openAccountDropdown(frame);
    await frame.waitForTimeout(800);

    // 2) desmarcar todas
    await uncheckAllInDropdown(frame);

    // 3) selecionar cliente (usa busca)
    await selectClient(frame, client_name);

    // fechar dropdown
    await page.keyboard.press("Escape").catch(() => {});
    await frame.waitForTimeout(1200);

    // 4) abrir período
    await openPeriodPicker(frame);
    await frame.waitForTimeout(1200);

    // 5) setar datas
    const sd = parseBRDate(start_date);
    const ed = parseBRDate(end_date);
    if (!sd || !ed) throw new Error("Datas inválidas (start_date/end_date).");

    await setDateInPicker(frame, "Data de início", sd);
    await setDateInPicker(frame, "Data de término", ed);

    // 6) aplicar
    const applyBtn = frame.locator('button:has-text("Aplicar")').first();
    await applyBtn.click({ timeout: 60000 });

    // espera atualizar
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    // 7) abrir menu e baixar relatório
    // o kebab pode estar no frame ou no page; tentamos no frame primeiro
    try {
      await openKebabMenu(frame);
    } catch {
      // tenta no page inteiro
      await openKebabMenu(page.mainFrame());
    }

    await frame.waitForTimeout(800);

    await clickDownloadReport(frame);
    await frame.waitForTimeout(1200);

    // 8) modal -> fazer download
    const pdfBuffer = await waitDownloadModalAndDownload(frame, page);

    return pdfBuffer;
  } catch (e) {
    console.error("ERRO exportLookerPDF:", e?.message || e);
    await safeScreenshot(page, "export-error");
    await safeSaveHTML(page.mainFrame(), "mainframe");
    // tenta salvar também o frame do relatório
    try {
      const frame = await getReportFrame(page);
      await safeSaveHTML(frame, "reportframe");
    } catch {}
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Healthcheck
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Export endpoint
app.post("/export", requireKey, async (req, res) => {
  try {
    const { looker_url, client_name, start_date, end_date } = req.body || {};

    if (!looker_url || !client_name || !start_date || !end_date) {
      return res.status(400).json({
        error: "Missing looker_url, client_name, start_date, end_date",
      });
    }

    const pdf = await exportLookerPDF({ looker_url, client_name, start_date, end_date });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="report.pdf"');
    return res.status(200).send(pdf);
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Failed to export PDF",
      detail: e?.message || String(e),
    });
  }
});

app.listen(PORT, () => {
  console.log(`==> Serviço detectado em execução na porta ${PORT}`);
});

const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

const API_KEY = process.env.API_KEY;

app.get("/health", (req, res) => res.json({ ok: true }));

function assertKey(req, res) {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.post("/export", async (req, res) => {
  if (!assertKey(req, res)) return;

  const { looker_url, client_name, start_date, end_date } = req.body || {};
  if (!looker_url) return res.status(400).json({ error: "looker_url is required" });
  if (!client_name) return res.status(400).json({ error: "client_name is required" });
  if (!start_date || !end_date) return res.status(400).json({ error: "start_date and end_date are required" });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    // Logs úteis no Render
    page.on("console", (msg) => console.log("PAGE LOG:", msg.type(), msg.text()));

    // 1) Abrir relatório
    await page.goto(looker_url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(4000);

    // 2) Selecionar cliente no filtro "Conta de Anúncio"
    // tenta achar o controle pelo texto visível
    await page.getByText("Conta de Anúncio", { exact: false }).first().click({ timeout: 30000 });
    await page.waitForTimeout(800);

    // se abrir lista, usar busca (quando existe)
    const searchBox = page.getByPlaceholder(/digite para pesquisar/i);
    if (await searchBox.count()) {
      await searchBox.first().fill(client_name);
      await page.waitForTimeout(500);
      // clica no item que contém o nome
      await page.getByText(client_name, { exact: false }).first().click({ timeout: 30000 });
    } else {
      // fallback: clicar direto no item na lista
      await page.getByText(client_name, { exact: false }).first().click({ timeout: 30000 });
    }

    // fechar dropdown clicando fora
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(2500);

    // 3) Selecionar período no controle "Selecionar período"
    await page.getByText("Selecionar período", { exact: false }).first().click({ timeout: 30000 });
    await page.waitForTimeout(800);

    // Muitos date pickers do Looker permitem digitar datas.
    // Vamos tentar achar inputs por "Data de início" e "Data de término".
    const startInput = page.getByLabel(/data de início/i);
    const endInput = page.getByLabel(/data de término/i);

    if (await startInput.count() && await endInput.count()) {
      await startInput.first().fill(start_date); // formato AAAA-MM-DD
      await endInput.first().fill(end_date);
    } else {
      // fallback: procurar inputs genéricos (quando o Looker não expõe label)
      const inputs = page.locator('input[type="text"]');
      if (await inputs.count() >= 2) {
        await inputs.nth(0).fill(start_date);
        await inputs.nth(1).fill(end_date);
      }
    }

    // clicar "Aplicar"
    await page.getByText("Aplicar", { exact: false }).first().click({ timeout: 30000 });
    await page.waitForTimeout(6000);

    // 4) Esperar renderizar (mais tempo porque tem gráfico)
    await page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(6000);

    // 5) Gerar PDF
    const pdf = await page.pdf({ format: "A4", printBackground: true });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=report.pdf");
    res.send(pdf);
  } catch (err) {
    console.error("EXPORT ERROR:", err);
    res.status(500).json({ error: "Failed to export PDF", details: String(err?.message || err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exportador em execução na porta ${PORT}`));

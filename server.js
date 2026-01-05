// export-looker.js
// npm i playwright
// node export-looker.js

const { chromium } = require("playwright");
const path = require("path");

async function waitForReportReady(page) {
  // Looker costuma carregar “meio vazio” e depois preencher.
  // Aqui a gente espera algum card sair de "2.1" / "Não há dados" trocar ou estabilizar.
  // Ajuste se quiser.
  await page.waitForTimeout(2000);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(4000);
}

async function openAccountDropdown(page) {
  // “Conta de Anúncio” é um controle no topo. Tentamos por texto visível.
  const header = page.getByText(/Conta de Anúncio/i).first();
  await header.scrollIntoViewIfNeeded();
  await header.click({ timeout: 30000 });
}

async function clearAllAccounts(page) {
  // No dropdown aparece um “checkbox” geral no topo (selecionar tudo / limpar tudo).
  // Pela sua imagem ele fica no canto superior esquerdo da lista.
  // Tentativa 1: clicar no primeiro checkbox visível dentro do popup.
  const popup = page.locator('mat-option, [role="listbox"], .mat-mdc-select-panel, .cdk-overlay-pane').last();

  // às vezes o overlay é outro container; então também tentamos pelo checkbox “genérico”
  const firstCheckbox = popup.locator('input[type="checkbox"], [role="checkbox"]').first();
  await firstCheckbox.click({ timeout: 15000 });

  // Pequena pausa pro Looker aplicar filtro
  await page.waitForTimeout(800);
}

async function selectClientAccount(page, clientLabel) {
  // Você comentou que na lista aparece "CA 01 - Nome"
  // então passe clientLabel já no mesmo formato, ex: "CA 01 - Patricia Salmazo"

  const overlay = page.locator(".cdk-overlay-pane, .mat-mdc-select-panel, [role='dialog']").last();

  // campo “Digite para pesquisar”
  const search = overlay.getByPlaceholder(/Digite para pesquisar/i).or(
    overlay.locator("input").first()
  );

  await search.fill("");
  await search.type(clientLabel, { delay: 30 });

  // clica no item que contém o texto do cliente
  const item = overlay.getByText(new RegExp(clientLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first();
  await item.click({ timeout: 20000 });

  // aguarda aplicar
  await page.waitForTimeout(1200);

  // fecha o dropdown (ESC costuma funcionar)
  await page.keyboard.press("Escape").catch(() => {});
}

async function openPeriodPicker(page) {
  const period = page.getByText(/Selecionar período/i).first();
  await period.scrollIntoViewIfNeeded();
  await period.click({ timeout: 30000 });
}

async function setPeriodDates(page, startDay, endDay) {
  // O date picker do Looker abre com “Data de início” e “Data de término”
  // e dias clicáveis. Seu fluxo: clicar dia início + clicar dia fim + Aplicar.

  const dialog = page.locator("[role='dialog'], .mat-mdc-dialog-container, .cdk-overlay-pane").last();

  // clica no dia inicial (ex: "1")
  await dialog.getByRole("gridcell", { name: String(startDay) }).first().click({ timeout: 15000 });

  // clica no dia final (ex: "31")
  await dialog.getByRole("gridcell", { name: String(endDay) }).first().click({ timeout: 15000 });

  // botão “Aplicar”
  await dialog.getByRole("button", { name: /Aplicar/i }).click({ timeout: 15000 });

  // aguarda o relatório recarregar
  await page.waitForTimeout(6000);
}

async function downloadReport(page, saveAs = "report.pdf") {
  // Clique no menu ⋮ (3 pontinhos) ao lado de compartilhar
  // e depois “Baixar o relatório”

  // abre o menu de 3 pontos
  const menuBtn = page.locator("button").filter({ has: page.locator("svg") }).filter({ hasText: "" });
  // mais confiável: procurar o botão com aria-label que geralmente existe
  const dots = page.locator("button[aria-label*='Mais'], button[aria-label*='mais'], button[aria-label*='More'], button[aria-label*='more']").first();

  if (await dots.count()) {
    await dots.click({ timeout: 15000 });
  } else {
    // fallback: tenta achar pelo ícone “more_vert” do Material
    await page.getByRole("button").filter({ hasText: "" }).locator("svg").first().click({ timeout: 15000 });
  }

  // clica “Baixar o relatório”
  const downloadItem = page.getByText(/Baixar o relatório/i).first();

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    downloadItem.click({ timeout: 15000 }),
  ]);

  const outPath = path.resolve(process.cwd(), saveAs);
  await download.saveAs(outPath);
  return outPath;
}

async function main() {
  // >>>>>>>>>>>> CONFIGURE AQUI
  const lookerUrl = process.env.LOOKER_URL || "COLE_A_URL_DO_LOOKER_AQUI";
  const clientName = process.env.CLIENT_NAME || "CA 01 - Patricia Salmazo";
  const startDay = Number(process.env.START_DAY || "1");
  const endDay = Number(process.env.END_DAY || "31");
  const outputName = process.env.OUTPUT || "Relatorio.pdf";
  // <<<<<<<<<<<<

  const browser = await chromium.launch({
    headless: true, // no Render deve ser true
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1366, height: 768 },
    locale: "pt-BR",
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    console.log("Abrindo:", lookerUrl);
    await page.goto(lookerUrl, { waitUntil: "domcontentloaded" });
    await waitForReportReady(page);

    console.log("Abrindo filtro Conta de Anúncio...");
    await openAccountDropdown(page);

    console.log("Limpando seleção...");
    await clearAllAccounts(page);

    console.log("Selecionando cliente:", clientName);
    await selectClientAccount(page, clientName);
    await waitForReportReady(page);

    console.log("Abrindo período...");
    await openPeriodPicker(page);

    console.log("Selecionando dias:", startDay, "até", endDay);
    await setPeriodDates(page, startDay, endDay);
    await waitForReportReady(page);

    console.log("Baixando relatório...");
    const saved = await downloadReport(page, outputName);
    console.log("✅ Salvo em:", saved);
  } catch (err) {
    console.error("❌ ERRO:", err?.message || err);
    await page.screenshot({ path: "debug.png", fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

main();

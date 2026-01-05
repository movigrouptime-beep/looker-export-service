// server.js (trecho da função export)
// Playwright já está no container (mcr.microsoft.com/playwright)

const { chromium } = require('playwright');
const fs = require('fs');

async function exportLookerPDF({ looker_url, client_name, start_date, end_date }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // helper: click com retry
  async function clickRetry(locator, name, tries = 5) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        await locator.waitFor({ state: 'visible', timeout: 20000 });
        await locator.click({ timeout: 20000 });
        return;
      } catch (e) {
        lastErr = e;
        await page.waitForTimeout(800 + i * 300);
      }
    }
    throw new Error(`Falha ao clicar: ${name} -> ${lastErr?.message}`);
  }

  // helper: espera “recalcular”
  // (ajuste o seletor de loading conforme seu Looker)
  async function waitRecalc() {
    // 1) espera um pouco para disparar requests
    await page.waitForTimeout(1500);

    // 2) tenta esperar sumir spinner/loading (se existir)
    // exemplo genérico - você pode trocar pelo spinner real
    const spinner = page.locator('[role="progressbar"], text=Carregando');
    try {
      if (await spinner.first().isVisible({ timeout: 2000 })) {
        await spinner.first().waitFor({ state: 'hidden', timeout: 60000 });
      }
    } catch (_) {
      // se não existir spinner, seguimos
    }

    // 3) “assenta” a UI
    await page.waitForTimeout(1500);
  }

  try {
    // A) abrir
    await page.goto(looker_url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // espera algo “marcante” do relatório existir
    // ajuste: pode ser o texto "Conta de Anúncio" ou "Selecionar período"
    await page.locator('text=Conta de Anúncio').waitFor({ timeout: 90000 });
    await page.locator('text=Selecionar período').waitFor({ timeout: 90000 });
    await page.waitForTimeout(2000);

    // B) Conta de Anúncio
    const btnConta = page.locator('text=Conta de Anúncio').first();
    await clickRetry(btnConta, 'Conta de Anúncio');

    // caixa de busca dentro do dropdown
    const buscaConta = page.locator('input[placeholder*="Digite para pesquisar"]').first();
    await buscaConta.waitFor({ timeout: 20000 });

    // checkbox do topo (marcar/desmarcar todos)
    // ⚠️ você precisa ajustar esse seletor: pode ser um checkbox com role=checkbox no topo
    const checkboxTopo = page.locator('[role="checkbox"]').first();
    await clickRetry(checkboxTopo, 'Checkbox topo (desmarcar tudo)');

    // digita o cliente e seleciona
    await buscaConta.fill(client_name);
    await page.waitForTimeout(800);

    // item do cliente na lista (texto)
    const itemCliente = page.locator(`text=${client_name}`).first();
    await clickRetry(itemCliente, `Selecionar cliente: ${client_name}`);

    // fecha dropdown
    await page.keyboard.press('Escape');
    await waitRecalc();

    // C) Período
    const btnPeriodo = page.locator('text=Selecionar período').first();
    await clickRetry(btnPeriodo, 'Selecionar período');

    // Se existir um dropdown "Período automático", você pode trocar pra "Personalizado"
    // Ajuste conforme seu looker:
    const modoPeriodo = page.locator('text=Período automático').first();
    if (await modoPeriodo.isVisible().catch(() => false)) {
      await clickRetry(modoPeriodo, 'Período automático');
      // exemplo: escolher "Personalizado"
      const personalizado = page.locator('text=Personalizado').first();
      if (await personalizado.isVisible().catch(() => false)) {
        await clickRetry(personalizado, 'Personalizado');
      }
    }

    // ⚠️ Aqui é o ponto mais variável:
    // O seu calendário mostra "Data de início" e "Data de término".
    // Existem 2 jeitos:
    // 1) se tiver input de data (melhor)
    // 2) clicar nos dias no calendário (mais chato)

    // tentativa 1: achar inputs (se existirem)
    const inputInicio = page.locator('input[aria-label*="Data de início"], input[placeholder*="Data de início"]').first();
    const inputFim = page.locator('input[aria-label*="Data de término"], input[placeholder*="Data de término"]').first();

    if (await inputInicio.isVisible().catch(() => false) && await inputFim.isVisible().catch(() => false)) {
      await inputInicio.fill(start_date);
      await inputFim.fill(end_date);
    } else {
      // tentativa 2: clicar no calendário
      // Você precisa adaptar: converter start_date/end_date em dia/mês e clicar nos botões do calendário.
      // Como seu calendário é mensal, é comum usar:
      // page.locator('text=4').click() etc (mas precisa escopo correto do calendário)
      throw new Error('Não encontrei inputs de data. Precisa mapear cliques no calendário com seletores do seu Looker.');
    }

    // clicar Aplicar
    const btnAplicar = page.locator('text=Aplicar').first();
    await clickRetry(btnAplicar, 'Aplicar período');
    await waitRecalc();

    // D) baixar
    // seta ao lado de "Compartilhar"
    // ajuste: pode ser um botão com aria-label ou o menu de 3 pontos dependendo do tema
    const btnMenuCompartilhar = page.locator('text=Compartilhar').first();
    await clickRetry(btnMenuCompartilhar, 'Compartilhar');

    const baixar = page.locator('text=Baixar o relatório').first();
    await clickRetry(baixar, 'Baixar o relatório');

    // Captura download
    const download = await page.waitForEvent('download', { timeout: 90000 });
    const path = await download.path();

    if (!path) throw new Error('Download não gerou arquivo (path null).');

    const buffer = fs.readFileSync(path);

    await browser.close();
    return buffer;

  } catch (err) {
    // debug forte: screenshot + html
    try { await page.screenshot({ path: '/tmp/erro.png', fullPage: true }); } catch {}
    try {
      const html = await page.content();
      fs.writeFileSync('/tmp/erro.html', html);
    } catch {}
    await browser.close();
    throw err;
  }
}

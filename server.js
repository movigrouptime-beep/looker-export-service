const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "10mb" }));

const API_KEY = process.env.API_KEY;

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/export", async (req, res) => {
  try {
    if (req.headers["x-api-key"] !== API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { looker_url } = req.body;
    if (!looker_url) {
      return res.status(400).json({ error: "looker_url is required" });
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(looker_url, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=report.pdf");
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export PDF" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Exporter running on port ${PORT}`);
});

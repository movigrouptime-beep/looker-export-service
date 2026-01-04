# Looker Export Service (Playwright)

## Rodar com Docker
```bash
docker compose up --build
```

## Teste
```bash
curl -sS -X POST "http://localhost:3000/export" \
  -H "x-api-key: COLOQUE_UMA_CHAVE_FORTE_AQUI" \
  -H "Content-Type: application/json" \
  --data '{"looker_url":"https://lookerstudio.google.com/u/0/reporting/..."}' \
  --output report.pdf
```

## No n8n Cloud
Configure:
- `EXPORT_SERVICE_URL` = `https://SEU-DOMINIO/export`
- `EXPORT_SERVICE_API_KEY` = mesma chave do container

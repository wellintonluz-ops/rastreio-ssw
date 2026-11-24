# Rastreio de Entregas SSW — Grupo TBX

Painel para acompanhar entregas da transportadora BNR pela WebAPI da SSW.

- `index.html` — painel (GitHub Pages). Login Google restrito a @grupotbx.com.br (Firebase "Rastreio SSW", id `teste-30bbd`).
- `worker.js` — Cloudflare Worker `rastreio-ssw` (conta da empresa, `rastreio-ssw.grupotbx.workers.dev`) que guarda as credenciais da SSW e consulta a API. As credenciais ficam só nas variáveis/segredos do Worker, nunca neste repositório.

## Ocorrências via webservice SSW (SSW2181)
As transportadoras enviam as ocorrências para `https://rastreio-ssw.grupotbx.workers.dev/ssw/ocorrencias/<token>`.
Elas ficam no banco D1 `rastreio-ssw` (esquema em `schema.sql`) e o painel sincroniza a cada 2 minutos.

## LGPD
- CPF do cliente e documento do recebedor não são guardados.
- Ocorrências com mais de 90 dias são apagadas diariamente (gatilho Cron do Worker).
- O painel remove da lista NFs entregues há mais de 90 dias.
- Acesso restrito a contas @grupotbx.com.br.

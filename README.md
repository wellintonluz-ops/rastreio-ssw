# Rastreio de Entregas SSW — Grupo TBX

Painel para acompanhar entregas da transportadora BNR pela WebAPI da SSW.

- `index.html` — painel (GitHub Pages). Login Google restrito a @grupotbx.com.br (Firebase "Rastreio SSW", id `teste-30bbd`).
- `worker.js` — Cloudflare Worker `rastreio-ssw` que guarda as credenciais da SSW e consulta a API. As credenciais ficam só nas variáveis/segredos do Worker, nunca neste repositório.

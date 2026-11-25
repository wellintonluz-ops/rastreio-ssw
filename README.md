# Rastreio de Entregas SSW — Grupo TBX

Painel para acompanhar entregas da transportadora BNR pela WebAPI da SSW.

- `index.html` — painel (GitHub Pages). Login Google restrito a @grupotbx.com.br (Firebase "Rastreio SSW", id `teste-30bbd`).
- `worker.js` — Cloudflare Worker `rastreio-ssw` (conta da empresa, `rastreio-ssw.grupotbx.workers.dev`) que guarda as credenciais da SSW e consulta a API. As credenciais ficam só nas variáveis/segredos do Worker, nunca neste repositório.

## Ocorrências via webservice SSW (SSW2181)
As transportadoras enviam as ocorrências para `https://rastreio-ssw.grupotbx.workers.dev/ssw/ocorrencias/<token>`.
Elas ficam no banco D1 `rastreio-ssw` (esquema em `schema.sql`) e o painel sincroniza a cada 2 minutos.

## LGPD
- CPF do cliente e documento do recebedor não são guardados.
- Histórico mantido (base para o OTIF): nada é apagado automaticamente. O painel só escolhe quais meses carregar na tela.
- Acesso restrito a contas @grupotbx.com.br.

## Base no Firebase (projeto "Rastreio SSW", id teste-30bbd)
- `rastreio_baldes/{AAAAMM-NN}`: NFs agrupadas em baldes (campo `nfs`, mapa chave→resumo). O balde de uma NF é
  fixo (mês de emissão da chave + hash), então a mesma chave nunca vira dois registros.
- Importar: NF nova é criada; NF já existente só tem atualizados os campos que mudaram. 1 gravação por balde.
- Abrir o painel: cache local do navegador + leitura só dos baldes alterados desde a última visita.
- `rastreio_importacoes`: histórico de cada importação (arquivos, novas, atualizadas, sem mudança).
- `rastreio_config/ws`: cursor compartilhado das ocorrências do webservice (só um navegador grava cada lote).
- Regras do Firestore: leitura/gravação só para contas @grupotbx.com.br com e-mail verificado.
- Nada sensível no código do site: a senha da SSW fica só no Worker; o documento do recebedor é removido.

### Comprovante de entrega
O link do comprovante vem só pela integração SSW2181 (a API pública não traz). Quando a transportadora reenvia uma ocorrência com informação nova (link, recebedor, complemento, agendamento), o Worker grava a atualização com um `seq` novo e `versao`+1, e o painel recebe de novo sem contar a ocorrência duas vezes. Um reenvio sem link nunca apaga o link já recebido.

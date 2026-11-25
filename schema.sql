-- Banco D1 "rastreio-ssw" — ocorrências recebidas pelo webservice SSW2181
CREATE TABLE IF NOT EXISTS ocorrencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recebido_em TEXT NOT NULL,
  cnpj_transp TEXT, cnpj_pagador TEXT,
  nf INTEGER, serie TEXT, chave TEXT, pedido TEXT,
  cte_numero INTEGER, cte_chave TEXT,
  data_evento TEXT, codigo TEXT, descricao TEXT, complemento TEXT,
  recebedor TEXT, doc_recebedor TEXT, latitude TEXT, longitude TEXT,
  agendamento TEXT, link_comprovante TEXT, tem_imagem INTEGER DEFAULT 0,
  versao INTEGER DEFAULT 0,  -- quantas vezes a ocorrência foi atualizada por reenvio
  seq INTEGER,  -- ordem de entrega ao painel (muda quando a ocorrência é atualizada)
  chave_nf TEXT GENERATED ALWAYS AS (CASE WHEN chave <> '' THEN chave ELSE cnpj_transp || ':' || nf END) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ocorrencia ON ocorrencias (chave_nf, data_evento, codigo);
CREATE INDEX IF NOT EXISTS ix_chave ON ocorrencias (chave);
CREATE INDEX IF NOT EXISTS ix_nf ON ocorrencias (nf);
CREATE INDEX IF NOT EXISTS ix_seq ON ocorrencias (seq);

-- Migração (banco criado antes da coluna seq):
-- ALTER TABLE ocorrencias ADD COLUMN seq INTEGER;
-- ALTER TABLE ocorrencias ADD COLUMN versao INTEGER DEFAULT 0;
-- UPDATE ocorrencias SET seq = id;
-- CREATE INDEX IF NOT EXISTS ix_seq ON ocorrencias (seq);

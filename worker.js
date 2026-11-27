/**
 * Rastreio SSW — Cloudflare Worker (proxy seguro)
 * ------------------------------------------------
 * Guarda as credenciais da SSW como SEGREDOS e consulta as WebAPIs de
 * rastreamento da SSW em nome do painel. Só aceita chamadas de quem fez
 * login Google com e-mail @grupotbx.com.br (token do Firebase).
 *
 * Variáveis / segredos (Settings > Variables and Secrets no Cloudflare):
 *   SSW_DOMINIO   = BNR                (texto)
 *   SSW_USUARIO   = TBX                (texto)
 *   SSW_SENHA     = ****               (SEGREDO)
 *   SSW_CNPJ      = CNPJ do remetente, só números (texto)
 *   SSW_SENHA_RASTREIO = opcional — senha de rastreamento do remetente, se a
 *                        transportadora exigir uma diferente (SEGREDO)
 *   SSW_SIGLA_EMP = opcional — filtra a empresa no rastreamento (ex.: BNR)
 *   FIREBASE_PROJECT_ID = teste-30bbd (projeto "Rastreio SSW") (texto)
 *   ALLOWED_DOMAIN = grupotbx.com.br   (texto, opcional)
 *   ALLOWED_ORIGINS = https://wellintonluz-ops.github.io (texto, opcional, separado por vírgula)
 *
 * Rotas:
 *   GET  /status            -> diz quais configurações existem (sem mostrar valores)
 *   POST /rastrear          -> { itens: [{ id, nf, chave, pedido, cpf }] }  (máx. 12 por chamada)
 *   POST /ssw/ocorrencias/<token>  -> recebe as ocorrências enviadas pelo SSW das
 *                             transportadoras (EDI SSW2181). Sem login; protegido pelo token da URL.
 *   GET  /ocorrencias?apos_id=N&limite=2000 -> ocorrências recebidas (para o painel, com login)
 *   GET  /ocorrencias?chave=...  (ou nf=...) -> histórico de uma NF
 *   GET  /transportadora?cnpj=...  -> nome da transportadora (BrasilAPI / CNPJ.ws / ReceitaWS)
 *   GET  /integradas            -> transportadoras que enviam ocorrências pelo SSW2181 (resumo por CNPJ)
 *
 * Banco: Cloudflare D1, vinculado ao Worker com o nome DB (tabela "ocorrencias").
 *
 * LGPD: o documento (CPF/RG) de quem recebeu NÃO é gravado; a imagem do comprovante
 * não é gravada (só o link). O histórico é mantido (base para o OTIF); só é apagado
 * algo se a variável RETENCAO_DIAS for criada no Worker.
 *
 * Ordem de tentativa para cada item:
 *   1. chave_nfe  -> /api/trackingdanfe   (pública, não precisa senha)
 *   2. CNPJ do remetente -> /api/tracking (nro_nf, pedido ou chave)
 *   3. CPF do destinatário -> /api/trackingpf (domínio + usuário + senha)
 */

const SSW = 'https://ssw.inf.br/api/';
// SHA-256 do token da URL do webservice (o token em si não fica no código)
const WEBHOOK_TOKEN_SHA256 = '0706284c04bf4e5db7adb47eca8718e5ab1fc504fd7ce719fce19be5ea01fdf7';
const MAX_ITENS = 12; // plano grátis: 50 sub-requisições por chamada

export default {
  // Histórico é guardado (base para o OTIF): só apaga algo se a variável RETENCAO_DIAS for criada no Worker
  async scheduled(event, env, ctx) {
    if (!env.DB || !Number(env.RETENCAO_DIAS)) return;
    const dias = Math.max(30, Number(env.RETENCAO_DIAS));
    ctx.waitUntil(env.DB.prepare(
      "DELETE FROM ocorrencias WHERE recebido_em < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"
    ).bind(`-${dias} days`).run());
  },

  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // Recebimento das ocorrências enviadas pelo SSW (sem login do Firebase)
    if (url.pathname.startsWith('/ssw/ocorrencias/')) {
      return receberOcorrenciasSSW(request, env, url.pathname.split('/')[3] || '');
    }

    try {
      const user = await autenticar(request, env);

      if (url.pathname === '/status' && request.method === 'GET') {
        return json({
          ok: true,
          usuario: user.email,
          config: {
            dominio: env.SSW_DOMINIO || null,
            usuario_ssw: env.SSW_USUARIO ? 'configurado' : null,
            senha_ssw: env.SSW_SENHA ? 'configurada' : null,
            cnpj_remetente: env.SSW_CNPJ ? mascaraCnpj(env.SSW_CNPJ) : null,
            senha_rastreio: env.SSW_SENHA_RASTREIO ? 'configurada' : null,
            sigla_emp: env.SSW_SIGLA_EMP || null,
          },
        }, 200, cors);
      }

      if (url.pathname === '/rastrear' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const itens = Array.isArray(body.itens) ? body.itens.slice(0, MAX_ITENS) : [];
        if (!itens.length) return json({ ok: false, erro: 'Envie { itens: [...] }' }, 400, cors);
        const resultados = await poolMap(itens, 4, (it) => rastrearItem(it, env));
        return json({ ok: true, resultados }, 200, cors);
      }

      // Nome da transportadora pelo CNPJ (dado público, BrasilAPI) — o painel guarda o resultado no Firebase
      if (url.pathname === '/transportadora' && request.method === 'GET') {
        const cnpj = soDigitos(url.searchParams.get('cnpj'));
        if (cnpj.length !== 14) return json({ ok: false, erro: 'CNPJ inválido' }, 400, cors);
        const dados = await buscarCnpj(cnpj);
        if (!dados) return json({ ok: false, erro: 'Não consegui consultar o CNPJ agora (fontes públicas ocupadas). Tente mais tarde ou informe o nome manualmente.' }, 200, cors);
        return json({ ok: true, cnpj, ...dados }, 200, cors);
      }

      // transportadoras integradas: quem já enviou ocorrências pelo webservice SSW2181
      if (url.pathname === '/integradas' && request.method === 'GET') {
        if (!env.DB) return json({ ok: false, erro: 'Banco D1 (DB) não vinculado ao Worker.' }, 500, cors);
        const desde24h = new Date(Date.now() - 864e5).toISOString();
        const desde7d = new Date(Date.now() - 7 * 864e5).toISOString();
        const { results } = await env.DB.prepare(
          `SELECT cnpj_transp,
                  MIN(recebido_em) AS primeira, MAX(recebido_em) AS ultima,
                  COUNT(*) AS ocorrencias,
                  COUNT(DISTINCT chave_nf) AS nfs,
                  SUM(recebido_em >= ?) AS ult24h,
                  COUNT(DISTINCT CASE WHEN recebido_em >= ? THEN chave_nf END) AS nfs7d,
                  COUNT(DISTINCT CASE WHEN CAST(codigo AS INTEGER) = 1 THEN chave_nf END) AS entregues,
                  COUNT(DISTINCT CASE WHEN link_comprovante <> '' THEN chave_nf END) AS comprovantes
             FROM ocorrencias WHERE cnpj_transp <> '' GROUP BY cnpj_transp ORDER BY ultima DESC`
        ).bind(desde24h, desde7d).all();
        return json({ ok: true, agora: new Date().toISOString(), transportadoras: results }, 200, cors);
      }

      if (url.pathname === '/ocorrencias' && request.method === 'GET') {
        if (!env.DB) return json({ ok: false, erro: 'Banco D1 (DB) não vinculado ao Worker.' }, 500, cors);
        const campos = 'id, recebido_em, cnpj_transp, cnpj_pagador, nf, serie, chave, pedido, cte_numero, cte_chave, data_evento, codigo, descricao, complemento, recebedor, latitude, longitude, agendamento, link_comprovante, tem_imagem';
        // histórico de UMA NF (detalhe do painel)
        const chaveQ = soDigitos(url.searchParams.get('chave')), nfQ = Number(soDigitos(url.searchParams.get('nf'))) || 0;
        if (chaveQ.length === 44 || nfQ) {
          const { results } = chaveQ.length === 44
            ? await env.DB.prepare(`SELECT ${campos} FROM ocorrencias WHERE chave = ? OR (chave = '' AND nf = ?) ORDER BY data_evento LIMIT 500`).bind(chaveQ, nfQ).all()
            : await env.DB.prepare(`SELECT ${campos} FROM ocorrencias WHERE nf = ? ORDER BY data_evento LIMIT 500`).bind(nfQ).all();
          return json({ ok: true, ocorrencias: results }, 200, cors);
        }
        const aposId = Math.max(0, Number(url.searchParams.get('apos_id')) || 0);
        const limite = Math.min(5000, Math.max(1, Number(url.searchParams.get('limite')) || 2000));
        // o cursor do painel (apos_id) é o seq: traz ocorrências novas e as atualizadas depois da última leitura
        const { results } = await env.DB.prepare(
          `SELECT ${campos}, seq, versao FROM ocorrencias WHERE seq > ? ORDER BY seq LIMIT ?`
        ).bind(aposId, limite).all();
        return json({ ok: true, ocorrencias: results, ultimo_id: results.length ? results[results.length - 1].seq : aposId, mais: results.length === limite }, 200, cors);
      }

      return json({ ok: false, erro: 'Rota não encontrada' }, 404, cors);
    } catch (e) {
      const status = e.status || 500;
      return json({ ok: false, erro: e.message || String(e) }, status, cors);
    }
  },
};

// Consulta pública de CNPJ com fontes de reserva (cada uma tem limite de uso)
async function buscarCnpj(cnpj) {
  const fontes = [
    async () => { const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + cnpj, { cf: { cacheTtl: 2592000, cacheEverything: true } }); if (!r.ok) return null; const j = await r.json();
      return { razao_social: j.razao_social || '', nome_fantasia: j.nome_fantasia || '', municipio: j.municipio || '', uf: j.uf || '' }; },
    async () => { const r = await fetch('https://publica.cnpj.ws/cnpj/' + cnpj, { cf: { cacheTtl: 2592000, cacheEverything: true } }); if (!r.ok) return null; const j = await r.json(); const e = j.estabelecimento || {};
      return { razao_social: j.razao_social || '', nome_fantasia: e.nome_fantasia || '', municipio: (e.cidade && e.cidade.nome) || '', uf: (e.estado && e.estado.sigla) || '' }; },
    async () => { const r = await fetch('https://receitaws.com.br/v1/cnpj/' + cnpj, { cf: { cacheTtl: 2592000, cacheEverything: true } }); if (!r.ok) return null; const j = await r.json(); if (j.status === 'ERROR') return null;
      return { razao_social: j.nome || '', nome_fantasia: j.fantasia || '', municipio: j.municipio || '', uf: j.uf || '' }; },
  ];
  for (const f of fontes) { try { const d = await f(); if (d && (d.razao_social || d.nome_fantasia)) return d; } catch (e) {} }
  return null;
}

/* ----------------------------- SSW ----------------------------- */

async function rastrearItem(it, env) {
  const nf = soDigitos(it.nf);
  const chave = soDigitos(it.chave);
  const pedido = (it.pedido || '').toString().trim();
  const cpf = soDigitos(it.cpf);
  const tentativas = [];

  // 1) Chave da NF-e — API pública
  if (chave.length === 44) {
    const r = await chamarSSW('trackingdanfe', { chave_nfe: chave });
    tentativas.push({ api: 'trackingdanfe', status: r.status, mensagem: r.json.message, temporario: !!r.json.temporario });
    if (r.json.success) return { id: it.id, ok: true, fonte: 'trackingdanfe', resposta: r.json, tentativas };
  }

  // 2) Remetente (CNPJ da Grupo TBX)
  if (env.SSW_CNPJ && (nf || pedido || chave.length === 44)) {
    const body = { cnpj: soDigitos(env.SSW_CNPJ) };
    const senhaRast = env.SSW_SENHA_RASTREIO || env.SSW_SENHA;
    if (senhaRast) body.senha = senhaRast;
    if (env.SSW_SIGLA_EMP) body.sigla_emp = env.SSW_SIGLA_EMP;
    if (chave.length === 44) body.chave_nfe = chave;
    else if (nf) body.nro_nf = Number(nf);
    else body.pedido = pedido;
    let r = await chamarSSW('tracking', body);
    // se a senha não for aceita, tenta sem senha (algumas transportadoras não exigem)
    if (!r.json.success && body.senha && /senha/i.test(r.json.message || '')) {
      const semSenha = { ...body }; delete semSenha.senha;
      const r2 = await chamarSSW('tracking', semSenha);
      tentativas.push({ api: 'tracking', status: r.status, mensagem: r.json.message });
      r = r2;
    }
    tentativas.push({ api: 'tracking', status: r.status, mensagem: r.json.message, temporario: !!r.json.temporario });
    if (r.json.success) return { id: it.id, ok: true, fonte: 'tracking', resposta: r.json, tentativas };
  }

  // 3) Destinatário pessoa física (domínio + usuário + senha)
  if (cpf.length === 11 && env.SSW_DOMINIO && env.SSW_USUARIO && env.SSW_SENHA) {
    const body = { dominio: env.SSW_DOMINIO, usuario: env.SSW_USUARIO, senha: env.SSW_SENHA, cpf };
    if (chave.length === 44) body.chave_nfe = chave;
    else if (nf) body.nro_nf = Number(nf);
    else if (pedido) body.pedido = pedido;
    const r = await chamarSSW('trackingpf', body);
    tentativas.push({ api: 'trackingpf', status: r.status, mensagem: r.json.message, temporario: !!r.json.temporario });
    if (r.json.success) return { id: it.id, ok: true, fonte: 'trackingpf', resposta: r.json, tentativas };
  }

  if (!tentativas.length) {
    return { id: it.id, ok: false, mensagem: 'Sem dados suficientes: informe a chave da NF-e, ou configure o CNPJ do remetente, ou informe o CPF do destinatário.', tentativas };
  }
  // resposta definitiva (ex.: "Nenhum documento localizado") vale mais que falha passageira da SSW
  const definitiva = tentativas.filter((t) => !t.temporario);
  if (definitiva.length) return { id: it.id, ok: false, mensagem: definitiva[definitiva.length - 1].mensagem || 'Não localizado', tentativas };
  return { id: it.id, ok: false, temporario: true, mensagem: tentativas[tentativas.length - 1].mensagem || 'SSW fora do ar no momento', tentativas };
}

// Chama a WebAPI da SSW. Se a SSW responder com página de erro (HTML), erro 5xx/429 ou cair a conexão,
// é falha passageira: tenta de novo até 2 vezes. Se continuar, marca temporario: true (não é "não localizado").
async function chamarSSW(rota, body) {
  let ultimo = null;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (tentativa) await new Promise((res) => setTimeout(res, tentativa * 1200));
    try {
      const r = await fetch(SSW + rota, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch { /* HTML ou vazio */ }
      if (j && typeof j === 'object' && r.status < 500 && r.status !== 429) return { status: r.status, json: limparDocumentos(j) };
      ultimo = { status: r.status, json: { success: false, temporario: true, message: `SSW fora do ar no momento (HTTP ${r.status}${j ? '' : ', resposta não era JSON'}). Consulte de novo em alguns minutos.` } };
    } catch (e) {
      ultimo = { status: 0, json: { success: false, temporario: true, message: 'Falha ao acessar a SSW: ' + e.message } };
    }
  }
  return ultimo;
}

// LGPD: tira CPF/CNPJ/RG de pessoas (recebedor, destinatário) da resposta antes de ir ao navegador
const CAMPOS_DOC = /^(cpf|rg|cpf_cnpj|cpf_destinatario|cpf_recebedor|rg_recebedor|doc_recebedor|nro_doc_recebedor|documento_recebedor|nro_documento_recebedor)$/i;
function limparDocumentos(o) {
  if (Array.isArray(o)) return o.map(limparDocumentos);
  if (o && typeof o === 'object') {
    const n = {};
    for (const [k, v] of Object.entries(o)) { if (CAMPOS_DOC.test(k) && (v == null || typeof v !== 'object')) continue; n[k] = limparDocumentos(v); }
    return n;
  }
  return o;
}

/* ------------- Webservice de ocorrências (SSW2181) -------------- */

// a ocorrência reenviada trouxe informação nova? (link do comprovante, recebedor, complemento, agendamento)
const MUDOU = `((excluded.link_comprovante <> '' AND excluded.link_comprovante IS NOT link_comprovante)
  OR (excluded.recebedor <> '' AND excluded.recebedor IS NOT recebedor)
  OR (excluded.complemento <> '' AND excluded.complemento IS NOT complemento)
  OR (excluded.agendamento <> '' AND excluded.agendamento IS NOT agendamento))`;

async function receberOcorrenciasSSW(request, env, token) {
  const agora = new Date();
  const dataHora = fmtSSW(agora);
  const resposta = (codigo, descricao, nf, pedido, protocolo) =>
    new Response(JSON.stringify([{ retorno: { codigo, descricao, numeroNFe: nf || 0, pedido: pedido || '', dataHora, protocolo: protocolo || '' } }]),
      { status: codigo, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });

  if (request.method !== 'POST') return resposta(405, 'METODO NAO PERMITIDO');
  if (!token || (await sha256(token)) !== WEBHOOK_TOKEN_SHA256) return resposta(401, 'TOKEN INVALIDO');
  if (!env.DB) return resposta(500, 'BANCO NAO CONFIGURADO');

  let corpo;
  try { corpo = JSON.parse(await request.text()); } catch { return resposta(400, 'JSON INVALIDO'); }
  const lista = Array.isArray(corpo) ? corpo : [corpo];
  let ultimoProtocolo = '', nfResp = 0, pedidoResp = '', gravadas = 0;
  try {
    for (const o of lista) {
      const nf = o.nf || {}, cte = o.cte || {}, oc = o.ocorrencia || {};
      if (!oc.codigo && !oc.descricao) continue;
      nfResp = Number(nf.numeroNFe) || 0; pedidoResp = nf.pedido || '';
      const r = await env.DB.prepare(
        // seq: ordem de entrega ao painel. Ocorrência nova ou ATUALIZADA (ex.: o link do comprovante chegou depois)
        // ganha um seq novo e versao+1, para o painel receber a atualização sem contar o evento de novo.
        // Reenvio sem link não apaga o link já recebido.
        `INSERT INTO ocorrencias (recebido_em, cnpj_transp, cnpj_pagador, nf, serie, chave, pedido, cte_numero, cte_chave,
          data_evento, codigo, descricao, complemento, recebedor, doc_recebedor, latitude, longitude, agendamento, link_comprovante, tem_imagem, seq)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ocorrencias))
         ON CONFLICT(chave_nf, data_evento, codigo) DO UPDATE SET
           seq = CASE WHEN ${MUDOU} THEN (SELECT COALESCE(MAX(seq), 0) + 1 FROM ocorrencias) ELSE seq END,
           versao = CASE WHEN ${MUDOU} THEN versao + 1 ELSE versao END,
           complemento = CASE WHEN excluded.complemento <> '' THEN excluded.complemento ELSE complemento END,
           recebedor = CASE WHEN excluded.recebedor <> '' THEN excluded.recebedor ELSE recebedor END,
           agendamento = CASE WHEN excluded.agendamento <> '' THEN excluded.agendamento ELSE agendamento END,
           link_comprovante = CASE WHEN excluded.link_comprovante <> '' THEN excluded.link_comprovante ELSE link_comprovante END,
           tem_imagem = MAX(tem_imagem, excluded.tem_imagem)
         RETURNING id`
      ).bind(
        agora.toISOString(), soDigitos(o.cnpjTransportadora), soDigitos(o.cnpjPagador),
        nfResp, String(nf.serieNFe || ''), soDigitos(nf.chaveNFe), pedidoResp,
        Number(cte.numeroSSW || cte.numeroCTe) || null, soDigitos(cte.chaveSSW || cte.chaveCTe),
        isoSSW(oc.dataHoraEvento), String(oc.codigo ?? ''), String(oc.descricao || ''), String(oc.complemento || ''),
        String(oc.nomeRecebedor || ''), '' /* documento do recebedor não é gravado (LGPD) */, String(oc.latitude ?? ''), String(oc.longitude ?? ''),
        isoSSW(oc.dataHoraAgendamento), decodeLink(oc.linkComprovante), oc.imagemComprovante ? 1 : 0
      ).first();
      ultimoProtocolo = String(r && r.id ? r.id : '');
      gravadas++;
    }
  } catch (e) {
    return resposta(500, 'ERRO AO GRAVAR: ' + String(e.message || e).slice(0, 120), nfResp, pedidoResp);
  }
  if (!gravadas) return resposta(400, 'NENHUMA OCORRENCIA NO CORPO DA REQUISICAO');
  return resposta(200, 'OCORRENCIA PROCESSADA COM SUCESSO', nfResp, pedidoResp, ultimoProtocolo || 'OK');
}

// "13-06-2019 16:59:39" ou "13/06/2019 16:59" -> "2019-06-13T16:59:39"
function isoSSW(v) {
  if (!v) return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  return s;
}
function fmtSSW(d) {
  const p = (n) => String(n).padStart(2, '0');
  const br = new Date(d.getTime() - 3 * 3600 * 1000);
  return `${p(br.getUTCDate())}-${p(br.getUTCMonth() + 1)}-${br.getUTCFullYear()} ${p(br.getUTCHours())}:${p(br.getUTCMinutes())}:${p(br.getUTCSeconds())}`;
}
function decodeLink(v) { if (!v) return ''; try { return decodeURIComponent(String(v)).replace(/&amp;/g, '&'); } catch { return String(v); } }
async function sha256(t) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------ Autenticação ------------------------- */

let JWKS = { keys: null, exp: 0 };

async function autenticar(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw httpErr(401, 'Faça login para consultar.');
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw httpErr(500, 'FIREBASE_PROJECT_ID não configurado no Worker.');

  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw httpErr(401, 'Token inválido.');
  const header = JSON.parse(dec(b64url(h)));
  const payload = JSON.parse(dec(b64url(p)));

  const keys = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw httpErr(401, 'Token com chave desconhecida — faça login de novo.');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valido = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(h + '.' + p));
  if (!valido) throw httpErr(401, 'Assinatura do token inválida.');

  const agora = Math.floor(Date.now() / 1000);
  if (payload.exp < agora) throw httpErr(401, 'Sessão expirada — recarregue a página.');
  if (payload.aud !== projectId || payload.iss !== 'https://securetoken.google.com/' + projectId) throw httpErr(401, 'Token de outro projeto.');
  const dominio = (env.ALLOWED_DOMAIN || 'grupotbx.com.br').toLowerCase();
  const email = (payload.email || '').toLowerCase();
  if (!payload.email_verified || !email.endsWith('@' + dominio)) throw httpErr(403, 'Acesso restrito a e-mails @' + dominio);
  return { email };
}

async function getJwks() {
  if (JWKS.keys && Date.now() < JWKS.exp) return JWKS.keys;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const j = await r.json();
  const m = (r.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  JWKS = { keys: j.keys || [], exp: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
  return JWKS.keys;
}

/* --------------------------- Utilitários ----------------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const permitidas = (env.ALLOWED_ORIGINS || 'https://wellintonluz-ops.github.io').split(',').map((s) => s.trim());
  const ok = permitidas.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : permitidas[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function soDigitos(v) { return (v == null ? '' : String(v)).replace(/\D/g, ''); }
function mascaraCnpj(c) { const d = soDigitos(c); return d.length === 14 ? d.slice(0, 2) + '.***.***/' + d.slice(8, 12) + '-' + d.slice(12) : 'configurado'; }
function b64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function dec(u8) { return new TextDecoder().decode(u8); }
async function poolMap(arr, n, fn) {
  const out = new Array(arr.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); }
  }));
  return out;
}

// ═══════════════════════════════════════════════════════════════
//  FLASH v3 — disciplined low-cap radar (Base + Solana)
//  Node 20+ · zero dependencies · free APIs only · RADAR ONLY
//  It alerts. Your trading bot executes. Nothing here signs a tx.
// ═══════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT  = String(process.env.TG_CHAT_ID || '');   // allowlist
const API      = `https://telegram.org{TG_TOKEN}`;

// ── TUNABLES — edit only this block ────────────────────────────
const CFG = {
  chains: ['base', 'solana'],
  minLiquidity: 6000,      // $ — below this you can't exit
  maxFdv: 800_000,         // low-cap ceiling
  minTxns: 40,
  minAgeMin: 3,
  maxAgeMin: 360,
  patienceRuns: 2,         // must survive N scans before alerting
  maxDumpPct: 25,          // reject if it dumps this % since first seen
  minScore: 62,
  maxSellTax: 10,          // %
  maxTop10: 0.55,          // holder concentration ceiling
  maxAlertsPerRun: 3,
  maxAlertsPerDay: 8,
  seenTtlH: 48,
  maxSeen: 3000,
  maxPapers: 400,
  paper: true,             // label only — FLASH never executes
};
// ───────────────────────────────────────────────────────────────

const STATE_FILE = 'state.json';
const S = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
S.watch ??= {}; S.seen ??= {}; S.papers ??= []; S.offset ??= 0;
S.day ??= ''; S.alertsToday ??= 0; S.paused ??= false;
S.blacklist ??= {}; S.gates ??= {};

function prune() {
  const cut = Date.now() - CFG.seenTtlH * 3600e3;
  for (const [k, v] of Object.entries(S.seen)) if (v < cut) delete S.seen[k];
  const keys = Object.keys(S.seen);
  if (keys.length > CFG.maxSeen) keys.slice(0, keys.length - CFG.maxSeen).forEach(k => delete S.seen[k]);
  S.papers = S.papers.slice(-CFG.maxPapers);
}
const save = () => { prune(); writeFileSync(STATE_FILE, JSON.stringify(S)); };
const today = () => new Date().toISOString().slice(0, 10);
const bump = (g) => { S.gates[g] = (S.gates[g] || 0) + 1; };

// ── TELEGRAM ───────────────────────────────────────────────────
async function tg(method, body) {
  try {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  } catch { return {}; }
}
const send = (t) => tg('sendMessage', { chat_id: TG_CHAT, text: t, disable_web_page_preview: false });

// ── RISK DATA (all keyless, all free) ──────────────────────────
async function goplus(chain, addr) {
  try {
    const url = chain === 'base'
      ? `https://gopluslabs.io{addr}`
      : `https://gopluslabs.io{addr}`;
    const j = await (await fetch(url)).json();
    const keys = Object.keys(j.result || {});
    return keys.length ? j.result[keys] : null;
  } catch { return null; }
}
async function honeypotIs(addr, symbol) {           // EVM only — needs symbol
  try {
    const j = await (await fetch(
      `https://honeypot.is{addr}&chainID=8453&tokenSymbol=${encodeURIComponent(symbol || 'TOKEN')}`
    )).json();
    return { isHoneypot: j.honeypotResult?.isHoneypot === true, risk: j.summary?.riskLevel || 'unknown' };
  } catch { return null; }
}
async function rugcheck(mint) {                     // Solana only
  try {
    const j = await (await fetch(`https://rugcheck.xyz{mint}/report/summary`)).json();
    return { score: j.score ?? null, locked: j.lpLockedPct ?? null };
  } catch { return null; }
}
// LP lock must be read from holder tags, not a boolean that often doesn't exist
function lpLocked(sec) {
  const h = sec?.lp_holders || [];
  if (!h.length) return null;                        // unknown
  const tags = h.map(x => `${x.tag || ''} ${x.is_locked || ''}`).join(' ').toLowerCase();
  return /lock|team ?finance|uncx|unlock|pinklock|burn/.test(tags);
}

// ── DISCOVERY ──────────────────────────────────────────────────
async function newPools(chain) {
  try {
    const j = await (await fetch(
      `https://geckoterminal.com{chain}/new_pools?page=1`,
      { headers: { accept: 'application/json' } })).json();
    return (j.data || []).map(p => ({
      chain, name: p.attributes.name,
      sym: p.attributes.name?.split('/')?.[0]?.trim() || '',
      addr: (p.relationships?.base_token?.data?.id || '').split('_').slice(1).join('_'),
      liq: +p.attributes.reserve_in_usd || 0,
      fdv: +(p.attributes.fdv_usd || p.attributes.market_cap_usd) || 0,
      txns: (p.attributes.transactions?.h24?.buys || 0) + (p.attributes.transactions?.h24?.sells || 0),
      ageMin: (Date.now() - new Date(p.attributes.pool_created_at).getTime()) / 60000,
      price: +p.attributes.base_token_price_usd || 0,
    }));
  } catch { return []; }
}

// ── STAGE 2: PRE-GATE (cheap, no API) ──────────────────────────
function preGate(t) {
  if (!t.addr) return false;
  if (t.liq < CFG.minLiquidity) return false;
  if (t.fdv <= 0 || t.fdv > CFG.maxFdv) return false;
  if (t.txns < CFG.minTxns) return false;
  if (t.ageMin < CFG.minAgeMin || t.ageMin > CFG.maxAgeMin) return false;
  return true;
}

// ── STAGE 4/5: RISK ENGINE + SCORE ─────────────────────────────
function evaluate(t, sec, extra) {
  const flags = [];
  if (sec) {
    if (sec.is_honeypot === '1') { bump('honeypot'); return null; }
    if (sec.cannot_sell_all === '1') { bump('cant-sell'); return null; }
    if (+(sec.sell_tax || 0) * 100 > CFG.maxSellTax) { bump('tax'); return null; }
    if (sec.creator_address && S.blacklist[sec.creator_address.toLowerCase()]) { bump('dev-blacklist'); return null; }
  }
  if (extra?.honeypot === true) { bump('honeypot-sim'); return null; }

  let s = 0;
  s += t.liq > 25000 ? 18 : 8;
  s += t.fdv < 150000 ? 18 : t.fdv < 400000 ? 10 : 4;
  s += t.txns > 300 ? 14 : t.txns > 100 ? 8 : 3;
  s += (t.ageMin > 5 && t.ageMin < 90) ? 12 : 5;

  if (sec) {
    const top10 = +(sec.top_10_holder_rate || 0);
    s += sec.is_open_source === '1' ? 8 : 0;
    s += sec.is_mintable !== '1' ? 8 : 0;
    const lpl = lpLocked(sec);
    s += lpl === true ? 8 : lpl === null ? 3 : 0;
    s += top10 < 0.40 ? 10 : top10 < CFG.maxTop10 ? 5 : 0;
    s += (+(sec.holder_count || 0) > 200) ? 8 : 0;
    s += sec.transfer_pausable === '1' ? 0 : 4;
    s += sec.is_blacklisted === '1' ? 0 : 4;
    if (sec.slippage_modifiable === '1') { s -= 6; flags.push('tax-mutable'); }
    if (sec.hidden_owner === '1')        { s -= 6; flags.push('hidden-owner'); }
    if (sec.is_proxy === '1')            { s -= 5; flags.push('proxy'); }
    if (sec.external_call === '1')       { s -= 4; flags.push('external-call'); }
    if (top10 >= CFG.maxTop10) flags.push('whales');
    if (sec.is_mintable === '1') flags.push('mintable');
  } else { s += 18; flags.push('no-sec-data'); }

  if (extra?.rugscore != null && extra.rugscore > 500) { bump('rugcheck'); return null; }
  if (extra?.locked != null && extra.locked < 30) flags.push('lp-unlocked');

  s = Math.max(0, Math.min(100, s));
  if (s < CFG.minScore) { bump('low-score'); return null; }
  return { s, flags };
}

const sizeFor = (s) => s >= 85 ? 'FULL (50%)' : s >= 70 ? 'MEDIUM (33%)' : 'SMALL (20%)';
const link = (h) => `https://dexscreener.com{h.chain}/${h.addr}`;

// ── STAGE 3: PATIENCE GATE + HUNT ──────────────────────────────
async function hunt() {
  if (S.paused) return 0;
  if (S.day !== today()) { S.day = today(); S.alertsToday = 0; }
  let fired = 0;
  for (const chain of CFG.chains) {
    for (const t of await newPools(chain)) {
      if (fired >= CFG.maxAlertsPerRun || S.alertsToday >= CFG.maxAlertsPerDay) break;
      if (!preGate(t)) { bump('pre-gate'); continue; }

      const w = S.watch[t.addr];
      if (!w) { S.watch[t.addr] = { first: Date.now(), price: t.price, runs: 1 }; bump('watch'); continue; }
      if (t.price > 0 && w.price > 0 && ((t.price / w.price) - 1) * 100 < -CFG.maxDumpPct) {
        delete S.watch[t.addr]; bump('dump'); continue;
      }
      w.runs++;
      if (w.runs < CFG.patienceRuns) continue;

      const sec = await goplus(chain, t.addr);
      const extra = {};
      if (chain === 'base') extra.honeypot = (await honeypotIs(t.addr, t.sym))?.isHoneypot ?? null;
      else { const r = await rugcheck(t.addr); extra.rugscore = r?.score ?? null; extra.locked = r?.locked ?? null; }

      const v = evaluate(t, sec, extra);
      delete S.watch[t.addr];
      if (!v) continue;

      fired++; S.alertsToday++;
      S.papers.push({ addr: t.addr, chain, name: t.name, score: v.s, entry: t.price, ts: Date.now() });
      await send(
`⚡ FLASH ${v.s}/100 ${CFG.paper ? '· PAPER' : ''}
${t.name}
MCap $${Math.round(t.fdv).toLocaleString()} · Liq $${Math.round(t.liq).toLocaleString()}
Txns ${t.txns} · ${Math.round(t.ageMin)}m old
${v.flags.length ? '⚠ ' + v.flags.join(', ') : '✅ clean'}
SIZE: ${sizeFor(v.s)}
${link(t)}`);
    }
  }
  return fired;
}

// ── SCOREBOARD ─────────────────────────────────────────────────
async function resolvePapers() {
  const out = [];
  for (const p of S.papers) {
    if (p.result !== undefined || Date.now() - p.ts < 6 * 3600e3) continue;
    try {
      const j = await (await fetch(`https://dexscreener.com{p.addr}`)).json();
      const price = +j.pairs?.[0]?.priceUsd || 0;
      if (price > 0 && p.entry > 0) p.result = price / p.entry;
    } catch {}
    if (Date.now() - p.ts > 24 * 3600e3 && p.result === undefined) p.result = 0;
    if (p.result !== undefined) out.push(p);
  }
  if (out.length) {
    const w = out.filter(p => p.result >= 1.5).length;
    await send(`📊 Scoreboard\nResolved: ${out.length}\nWinners ≥1.5x: ${w}\nHit rate: ${Math.round(w / out.length * 100)}%`);
  }
}
function statsText() {
  const d = S.papers.filter(p => p.result !== undefined);

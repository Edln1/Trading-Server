import "dotenv/config";
import express from "express";
import { z } from "zod";
import ccxt from "ccxt";
import { Connection, Keypair, VersionedTransaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// ---- config: CEX (Binance, Bybit, Kraken, etc via ccxt) ----
const EXCHANGE_ID = process.env.EXCHANGE_ID || "binance"; // any ccxt id
const DRY_RUN = process.env.DRY_RUN !== "false"; // default TRUE — must explicitly set DRY_RUN=false to trade live
const MAX_POSITION_USD = Number(process.env.MAX_POSITION_USD || 50);

const ExchangeClass = ccxt[EXCHANGE_ID];
if (!ExchangeClass) throw new Error(`Unknown exchange id: ${EXCHANGE_ID}`);

const exchange = new ExchangeClass({
  apiKey: process.env.API_KEY,
  secret: process.env.API_SECRET,
  enableRateLimit: true,
});

// ---- config: Solana memecoins via Jupiter ----
const SOL_DRY_RUN = process.env.SOL_DRY_RUN !== "false"; // separate default-TRUE switch
const MAX_SOL_PER_TRADE = Number(process.env.MAX_SOL_PER_TRADE || 0.1); // hard cap, in SOL
const SOL_MAX_SLIPPAGE_BPS = Number(process.env.SOL_MAX_SLIPPAGE_BPS || 100); // 1%
const SOL_RPC_URL = process.env.SOL_RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_MINT = "So11111111111111111111111111111111111111112"; // native SOL wrapped mint

const connection = new Connection(SOL_RPC_URL, "confirmed");
// Burner wallet only. Never point this at a wallet holding real funds you can't lose.
const solWallet = process.env.SOL_PRIVATE_KEY
  ? Keypair.fromSecretKey(bs58.decode(process.env.SOL_PRIVATE_KEY))
  : null;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ---- MCP server + tools ----
function buildServer() {
  const server = new McpServer({ name: "trading-bot", version: "1.0.0" });

  server.tool(
    "get_price",
    "Get current price for a symbol, e.g. BTC/USDT",
    { symbol: z.string() },
    async ({ symbol }) => {
      const ticker = await exchange.fetchTicker(symbol);
      return { content: [{ type: "text", text: JSON.stringify({ symbol, last: ticker.last, bid: ticker.bid, ask: ticker.ask }) }] };
    }
  );

  server.tool(
    "get_ohlcv",
    "Get candle data for analysis",
    {
      symbol: z.string(),
      timeframe: z.string().default("1h"),
      limit: z.number().default(100),
    },
    async ({ symbol, timeframe, limit }) => {
      const data = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );

  server.tool(
    "get_balance",
    "Get account balance (requires API keys)",
    {},
    async () => {
      const bal = await exchange.fetchBalance();
      return { content: [{ type: "text", text: JSON.stringify(bal.total) }] };
    }
  );

  server.tool(
    "get_positions",
    "Get open positions (for margin/futures exchanges that support it)",
    {},
    async () => {
      if (!exchange.has["fetchPositions"]) {
        return { content: [{ type: "text", text: "This exchange/market type has no position concept (spot)." }] };
      }
      const positions = await exchange.fetchPositions();
      return { content: [{ type: "text", text: JSON.stringify(positions.filter(p => p.contracts > 0)) }] };
    }
  );

  server.tool(
    "place_order",
    "Place a market or limit order. Blocked in DRY_RUN mode unless dry-run env explicitly disabled.",
    {
      symbol: z.string(),
      side: z.enum(["buy", "sell"]),
      amount: z.number(),
      price: z.number().optional(),
      confirm: z.boolean().default(false).describe("Must be true to actually submit the order"),
    },
    async ({ symbol, side, amount, price, confirm }) => {
      const ticker = await exchange.fetchTicker(symbol);
      const notionalUsd = amount * (price || ticker.last);

      if (notionalUsd > MAX_POSITION_USD) {
        return {
          content: [{
            type: "text",
            text: `BLOCKED: order notional $${notionalUsd.toFixed(2)} exceeds MAX_POSITION_USD ($${MAX_POSITION_USD}). Adjust amount or raise the limit in env.`,
          }],
        };
      }

      if (DRY_RUN || !confirm) {
        const reason = DRY_RUN ? "DRY_RUN mode is on" : "confirm=false";
        log("DRY RUN order:", { symbol, side, amount, price, notionalUsd });
        return {
          content: [{
            type: "text",
            text: `SIMULATED (not sent — ${reason}): ${side} ${amount} ${symbol} @ ${price || "market"} (~$${notionalUsd.toFixed(2)})`,
          }],
        };
      }

      const order = price
        ? await exchange.createLimitOrder(symbol, side, amount, price)
        : await exchange.createMarketOrder(symbol, side, amount);

      log("LIVE order placed:", order.id, symbol, side, amount);
      return { content: [{ type: "text", text: JSON.stringify(order) }] };
    }
  );

  server.tool(
    "cancel_order",
    "Cancel an open order by id",
    { orderId: z.string(), symbol: z.string() },
    async ({ orderId, symbol }) => {
      if (DRY_RUN) {
        return { content: [{ type: "text", text: `SIMULATED cancel (DRY_RUN): ${orderId}` }] };
      }
      const result = await exchange.cancelOrder(orderId, symbol);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "get_memecoin_price",
    "Get USD price of a Solana token by mint address",
    { mint: z.string() },
    async ({ mint }) => {
      const r = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`).then(r => r.json());
      const p = r.data?.[mint];
      return { content: [{ type: "text", text: p ? JSON.stringify({ mint, priceUsd: Number(p.price) }) : "no price found" }] };
    }
  );

  server.tool(
    "place_memecoin_order",
    "Swap SOL for a memecoin (buy) or back to SOL (sell) via Jupiter. Blocked unless SOL_DRY_RUN=false AND confirm=true AND under MAX_SOL_PER_TRADE.",
    {
      mint: z.string().describe("token mint address"),
      side: z.enum(["buy", "sell"]),
      amountSol: z.number(),
      confirm: z.boolean().default(false),
    },
    async ({ mint, side, amountSol, confirm }) => {
      if (amountSol > MAX_SOL_PER_TRADE) {
        return { content: [{ type: "text", text: `BLOCKED: ${amountSol} SOL exceeds MAX_SOL_PER_TRADE (${MAX_SOL_PER_TRADE})` }] };
      }
      const lamports = Math.round(amountSol * 1e9);
      const [inputMint, outputMint] = side === "buy" ? [SOL_MINT, mint] : [mint, SOL_MINT];
      const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${lamports}&slippageBps=${SOL_MAX_SLIPPAGE_BPS}`;
      const quote = await fetch(url).then(r => r.json());

      if (SOL_DRY_RUN || !confirm) {
        const reason = SOL_DRY_RUN ? "SOL_DRY_RUN mode is on" : "confirm=false";
        return { content: [{ type: "text", text: `SIMULATED (not sent — ${reason}): ${side} ${amountSol} SOL <-> ${mint}, est out ${quote.outAmount}` }] };
      }
      if (!solWallet) return { content: [{ type: "text", text: "No SOL_PRIVATE_KEY configured — can't send live." }] };

      const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: solWallet.publicKey.toBase58(), wrapAndUnwrapSol: true }),
      }).then(r => r.json());
      const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
      tx.sign([solWallet]);
      const signature = await connection.sendTransaction(tx);
      log("LIVE sol order (MCP):", signature, mint, side, amountSol);
      return { content: [{ type: "text", text: JSON.stringify({ signature, mint, side, amountSol }) }] };
    }
  );

  server.tool(
    "get_memecoin_screener",
    "List currently active Solana memecoins ranked by a transparent activity score (volume, 24h change, liquidity). This ranks current activity, it does NOT predict future price — most listed tokens are still high-risk.",
    {},
    async () => {
      const boosts = await fetch("https://api.dexscreener.com/token-boosts/latest/v1").then(r => r.json());
      const solTokens = (Array.isArray(boosts) ? boosts : []).filter(b => b.chainId === "solana");
      const addresses = [...new Set(solTokens.map(b => b.tokenAddress))].slice(0, 30);
      if (!addresses.length) return { content: [{ type: "text", text: "[]" }] };
      const pairsRes = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${addresses.join(",")}`).then(r => r.json());
      const pairs = Array.isArray(pairsRes) ? pairsRes : [];
      const byToken = {};
      for (const p of pairs) {
        const addr = p.baseToken?.address;
        if (!addr) continue;
        if (!byToken[addr] || (p.liquidity?.usd || 0) > (byToken[addr].liquidity?.usd || 0)) byToken[addr] = p;
      }
      const ranked = Object.values(byToken)
        .filter(p => (p.liquidity?.usd || 0) > 5000)
        .map(p => ({
          mint: p.baseToken.address, symbol: p.baseToken.symbol, priceUsd: Number(p.priceUsd),
          change24h: p.priceChange?.h24 || 0, volume24h: p.volume?.h24 || 0, liquidityUsd: p.liquidity?.usd || 0,
        }))
        .sort((a, b) => (b.volume24h - a.volume24h))
        .slice(0, 15);
      return { content: [{ type: "text", text: JSON.stringify(ranked) }] };
    }
  );

  return server;
}

// ---- HTTP/SSE transport (deployable, e.g. on Render) ----
const app = express();
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>trading-mcp</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0a0b0d;
    --panel:#111318;
    --panel-2:#161922;
    --line:#22262f;
    --text:#e7e9ee;
    --muted:#7b8291;
    --buy:#3ddc84;
    --sell:#ff5c5c;
    --warn:#e8a33d;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--text);
    font-family:'Inter',system-ui,sans-serif;}
  .mono{font-family:'IBM Plex Mono',monospace;}
  body{min-height:100vh;display:flex;flex-direction:column;}

  header{
    display:flex;align-items:center;justify-content:space-between;
    padding:14px 20px;border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,#0d0f13,#0a0b0d);
  }
  header .brand{display:flex;align-items:center;gap:10px;}
  header .brand .dot{width:8px;height:8px;border-radius:50%;background:var(--buy);
    box-shadow:0 0 8px var(--buy);}
  header h1{font-size:15px;font-weight:600;margin:0;letter-spacing:.2px;}
  header .mode{
    font-family:'IBM Plex Mono',monospace;font-size:12px;padding:4px 10px;
    border-radius:4px;border:1px solid var(--warn);color:var(--warn);
  }
  header .mode.live{border-color:var(--sell);color:var(--sell);}

  .tabs{display:flex;gap:2px;padding:0 20px;background:var(--bg);border-bottom:1px solid var(--line);}
  .tab{padding:12px 18px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;
    border-bottom:2px solid transparent;}
  .tab.active{color:var(--text);border-bottom-color:var(--buy);}
  .panel{display:none;}
  .panel.active{display:contents;}

  main{
    flex:1;display:grid;grid-template-columns:280px 1fr 320px;gap:1px;
    background:var(--line);
  }
  @media (max-width:900px){ main{grid-template-columns:1fr; grid-auto-rows:min-content;} }

  section{background:var(--bg);padding:18px 20px;}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted);
     margin:0 0 14px 0;font-weight:600;}

  /* left: balance + positions */
  .bal-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);
    font-size:13px;}
  .bal-row:last-child{border-bottom:none;}
  .bal-row .amt{font-family:'IBM Plex Mono',monospace;color:var(--text);}
  .pos-card{padding:10px 0;border-bottom:1px solid var(--line);font-size:13px;}
  .pos-card:last-child{border-bottom:none;}
  .pos-card .sym{font-weight:600;}
  .empty{color:var(--muted);font-size:13px;padding:6px 0;}

  /* center: price + order */
  .price-block{margin-bottom:26px;}
  .price-big{font-family:'IBM Plex Mono',monospace;font-size:42px;font-weight:500;
    letter-spacing:-1px;line-height:1;}
  .price-sym{color:var(--muted);font-size:13px;margin-top:6px;}
  .price-change{font-family:'IBM Plex Mono',monospace;font-size:14px;margin-left:10px;}
  .up{color:var(--buy);} .down{color:var(--sell);}

  .symbol-input{
    background:var(--panel);border:1px solid var(--line);color:var(--text);
    padding:8px 10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;
    font-size:13px;width:140px;
  }

  .quick-picks{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;}
  .quick-picks button{
    background:var(--panel);border:1px solid var(--line);color:var(--muted);
    padding:5px 10px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;
  }
  .quick-picks button:hover, .quick-picks button.active{border-color:var(--buy);color:var(--buy);}

  form.order{display:flex;flex-direction:column;gap:10px;max-width:360px;}
  .side-toggle{display:flex;gap:8px;}
  .side-toggle button{
    flex:1;padding:10px;border-radius:6px;border:1px solid var(--line);
    background:var(--panel);color:var(--muted);font-weight:600;font-size:13px;
    cursor:pointer;transition:border-color .15s, color .15s;
  }
  .side-toggle button.active[data-side="buy"]{border-color:var(--buy);color:var(--buy);}
  .side-toggle button.active[data-side="sell"]{border-color:var(--sell);color:var(--sell);}

  label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;}
  input[type=number]{
    background:var(--panel);border:1px solid var(--line);color:var(--text);
    padding:10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:14px;width:100%;
  }
  .field{display:flex;flex-direction:column;gap:5px;}
  .confirm-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:2px;}
  .amount-presets{display:flex;gap:6px;margin-bottom:6px;}
  .amount-presets button{
    background:var(--panel);border:1px solid var(--line);color:var(--muted);
    padding:6px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
  }
  .amount-presets button.active,.amount-presets button:hover{border-color:var(--buy);color:var(--buy);}

  button.submit{
    margin-top:6px;padding:12px;border:none;border-radius:6px;font-weight:600;font-size:13px;
    cursor:pointer;background:var(--panel-2);color:var(--text);border:1px solid var(--line);
  }
  button.submit:hover{border-color:var(--muted);}

  /* right: log */
  .log{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--muted);
    display:flex;flex-direction:column-reverse;gap:6px;height:calc(100vh - 100px);overflow-y:auto;}
  .log .entry{padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);}
  .log .entry.sim{border-left:3px solid var(--warn);}
  .log .entry.err{border-left:3px solid var(--sell);}
  .log .entry.live{border-left:3px solid var(--sell);color:var(--text);}
  .log .entry .t{color:var(--muted);font-size:10px;display:block;margin-bottom:3px;}

  .refresh-note{font-size:11px;color:var(--muted);margin-top:10px;}

  .scr-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;
    border-bottom:1px solid var(--line);cursor:pointer;font-size:12px;}
  .scr-row:last-child{border-bottom:none;}
  .scr-row:hover{background:var(--panel);}
  .scr-row .sym{font-weight:600;}
  .scr-row .stats{color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:11px;text-align:right;}
  .scr-row .stats .chg.up{color:var(--buy);}
  .scr-row .stats .chg.down{color:var(--sell);}
</style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="dot" id="statusDot"></div>
      <h1>trading-mcp</h1>
      <span class="mono" id="exchangeLabel" style="color:var(--muted);font-size:12px;"></span>
    </div>
    <div class="mode" id="modeLabel">…</div>
  </header>

  <div class="tabs">
    <div class="tab active" data-tab="cex">Exchange (CEX)</div>
    <div class="tab" data-tab="sol">Solana Memecoins</div>
  </div>

  <div class="panel active" id="panel-cex">
  <main>
    <section>
      <h2>Balance</h2>
      <div id="balanceBox"><div class="empty">loading…</div></div>

      <h2 style="margin-top:22px;">Positions</h2>
      <div id="positionsBox"><div class="empty">loading…</div></div>
    </section>

    <section>
      <div class="price-block">
        <input class="symbol-input mono" id="symbolInput" value="BTC/USDT" />
        <div class="quick-picks" id="cexQuickPicks">
          <button type="button" data-symbol="BTC/USDT">BTC</button>
          <button type="button" data-symbol="ETH/USDT">ETH</button>
          <button type="button" data-symbol="SOL/USDT">SOL</button>
          <button type="button" data-symbol="XRP/USDT">XRP</button>
          <button type="button" data-symbol="DOGE/USDT">DOGE</button>
          <button type="button" data-symbol="ADA/USDT">ADA</button>
        </div>
        <div class="price-big" id="priceBig">—</div>
        <div class="price-sym">
          <span id="priceSymLabel">BTC/USDT</span>
          <span class="price-change" id="priceChange"></span>
        </div>
      </div>

      <h2>Place order</h2>
      <form class="order" id="orderForm">
        <div class="side-toggle">
          <button type="button" data-side="buy" class="active">BUY</button>
          <button type="button" data-side="sell">SELL</button>
        </div>
        <div class="field">
          <label>Amount</label>
          <input type="number" step="any" id="amountInput" placeholder="0.001" required />
        </div>
        <div class="field">
          <label>Limit price (optional — blank = market)</label>
          <input type="number" step="any" id="priceInput" placeholder="market" />
        </div>
        <div class="confirm-row">
          <input type="checkbox" id="confirmCheck" />
          <span>Send live (unchecked = simulate only)</span>
        </div>
        <button type="submit" class="submit">Submit order</button>
      </form>
      <div class="refresh-note">Orders route through your server's DRY_RUN / MAX_POSITION_USD limits regardless of this toggle.</div>
    </section>

    <section>
      <h2>Activity</h2>
      <div class="log" id="logBox"></div>
    </section>
  </main>
  </div>

  <div class="panel" id="panel-sol">
  <main>
    <section>
      <h2>Your Wallet</h2>
      <div id="solWalletBox">
        <div class="empty" id="solWalletEmpty">No wallet connected yet.</div>
        <div id="solWalletConnected" style="display:none;">
          <div class="bal-row"><span>address</span><span class="amt" id="solWalletAddr">—</span></div>
          <button type="button" class="submit" style="margin-top:8px;background:transparent;border:1px solid var(--line);" id="solDisconnectBtn">Disconnect</button>
        </div>
      </div>
      <form id="solConnectForm" style="margin-top:10px;">
        <div class="field">
          <label>Paste wallet private key (base58)</label>
          <input type="password" id="solPrivateKeyInput" placeholder="paste here — stays in this browser only" />
        </div>
        <button type="submit" class="submit" style="margin-top:8px;">Connect</button>
      </form>
      <div class="refresh-note" style="margin-top:10px;">Use a brand-new burner wallet only — never one holding money you'd miss. This key is kept in your browser and sent only when you swap; it is never saved on the server.</div>

      <h2 style="margin-top:22px;">Screener</h2>
      <div class="refresh-note" style="margin-bottom:8px;">Ranked by current volume/liquidity/momentum — not a prediction. Click one to load it.</div>
      <div id="screenerBox"><div class="empty">loading…</div></div>
    </section>

    <section>
      <div class="price-block">
        <input class="symbol-input mono" id="mintInput" placeholder="token mint address" style="width:100%;" />
        <div class="price-big" id="solPriceBig">—</div>
        <div class="price-sym"><span id="mintLabel">paste a Solana token mint above, or tap one from the Screener</span></div>
      </div>

      <h2>Buy / Sell this token</h2>
      <form class="order" id="solOrderForm">
        <div class="side-toggle">
          <button type="button" data-side="buy" class="active">BUY (SOL→token)</button>
          <button type="button" data-side="sell">SELL (token→SOL)</button>
        </div>

        <div class="field">
          <label>When</label>
          <div class="side-toggle" id="solWhenToggle">
            <button type="button" data-when="now" class="active">Right now</button>
            <button type="button" data-when="later">At a price I set</button>
          </div>
        </div>

        <div class="field" id="solTargetField" style="display:none;">
          <label>Trigger price (USD)</label>
          <input type="number" step="any" id="solTargetPrice" placeholder="e.g. 0.0004" />
          <div class="refresh-note" style="margin-top:4px;" id="solConditionNote">Will buy once the price rises to or above this.</div>
        </div>

        <div class="field">
          <label>Amount (SOL)</label>
          <div class="amount-presets" id="solAmountPresets">
            <button type="button" data-amt="0.01">0.01</button>
            <button type="button" data-amt="0.05" class="active">0.05</button>
            <button type="button" data-amt="0.1">0.1</button>
            <button type="button" data-amt="0.25">0.25</button>
          </div>
          <input type="number" step="any" id="solAmountInput" value="0.05" />
        </div>
        <div class="confirm-row">
          <input type="checkbox" id="solConfirmCheck" />
          <span>Actually send this trade (unchecked = practice run, nothing real happens)</span>
        </div>
        <button type="submit" class="submit" id="solSubmitBtn">Buy / Sell</button>
      </form>
      <div class="refresh-note">Swaps route through MAX_SOL_PER_TRADE and slippage limits regardless of this toggle. No strategy here guarantees profit — memecoins can go to zero. Price rules only work while this server is running — a sleeping free-tier Render instance won't catch a trigger.</div>

      <h2 style="margin-top:22px;">Active price rules</h2>
      <div id="solRulesBox"><div class="empty">none yet</div></div>
    </section>

    <section>
      <h2>Activity</h2>
      <div class="log" id="solLogBox"></div>
    </section>
  </main>
  </div>

<script>
const API = "";
let currentSide = "buy";
let currentSymbol = "BTC/USDT";

function logEntry(text, cls) {
  const box = document.getElementById("logBox");
  const el = document.createElement("div");
  el.className = "entry " + (cls || "");
  const time = new Date().toLocaleTimeString();
  el.innerHTML = \`<span class="t">\${time}</span>\${text}\`;
  box.prepend(el);
}

async function loadStatus() {
  try {
    const r = await fetch(API + "/api/status").then(r => r.json());
    document.getElementById("exchangeLabel").textContent = r.exchange;
    const modeEl = document.getElementById("modeLabel");
    modeEl.textContent = r.dryRun ? "DRY RUN" : "LIVE";
    modeEl.classList.toggle("live", !r.dryRun);
    logEntry(\`connected — \${r.exchange}, \${r.dryRun ? "dry run" : "LIVE"}, cap $\${r.maxPositionUsd}\`, "sim");
  } catch (e) {
    logEntry("status check failed: " + e.message, "err");
  }
}

async function loadPrice() {
  try {
    const r = await fetch(API + "/api/price?symbol=" + encodeURIComponent(currentSymbol)).then(r => r.json());
    if (r.error) throw new Error(r.error);
    document.getElementById("priceBig").textContent = r.last?.toLocaleString(undefined, {maximumFractionDigits:6}) ?? "—";
    document.getElementById("priceSymLabel").textContent = r.symbol;
    const chEl = document.getElementById("priceChange");
    if (r.change != null) {
      chEl.textContent = (r.change >= 0 ? "+" : "") + r.change.toFixed(2) + "%";
      chEl.className = "price-change " + (r.change >= 0 ? "up" : "down");
    }
  } catch (e) {
    document.getElementById("priceBig").textContent = "err";
  }
}

async function loadBalance() {
  try {
    const r = await fetch(API + "/api/balance").then(r => r.json());
    const box = document.getElementById("balanceBox");
    const entries = Object.entries(r);
    if (r.error) { box.innerHTML = \`<div class="empty">no keys / \${r.error}</div>\`; return; }
    if (!entries.length) { box.innerHTML = \`<div class="empty">no balances</div>\`; return; }
    box.innerHTML = entries.map(([k,v]) =>
      \`<div class="bal-row"><span>\${k}</span><span class="amt">\${Number(v).toFixed(6)}</span></div>\`
    ).join("");
  } catch (e) {
    document.getElementById("balanceBox").innerHTML = \`<div class="empty">unavailable</div>\`;
  }
}

async function loadPositions() {
  try {
    const r = await fetch(API + "/api/positions").then(r => r.json());
    const box = document.getElementById("positionsBox");
    if (!Array.isArray(r) || !r.length) { box.innerHTML = \`<div class="empty">no open positions</div>\`; return; }
    box.innerHTML = r.map(p =>
      \`<div class="pos-card"><div class="sym">\${p.symbol}</div>
       <div style="color:var(--muted)">\${p.side} · \${p.contracts} contracts</div></div>\`
    ).join("");
  } catch (e) {
    document.getElementById("positionsBox").innerHTML = \`<div class="empty">unavailable</div>\`;
  }
}

document.querySelectorAll(".side-toggle button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".side-toggle button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentSide = btn.dataset.side;
  });
});

document.getElementById("symbolInput").addEventListener("change", (e) => {
  currentSymbol = e.target.value.trim() || "BTC/USDT";
  loadPrice();
});

document.querySelectorAll("#cexQuickPicks button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#cexQuickPicks button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentSymbol = btn.dataset.symbol;
    document.getElementById("symbolInput").value = currentSymbol;
    loadPrice();
  });
});

document.getElementById("orderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const amount = parseFloat(document.getElementById("amountInput").value);
  const priceVal = document.getElementById("priceInput").value;
  const price = priceVal ? parseFloat(priceVal) : undefined;
  const confirm = document.getElementById("confirmCheck").checked;

  logEntry(\`sending \${currentSide} \${amount} \${currentSymbol}\${price ? " @ " + price : " @ market"}…\`);
  try {
    const r = await fetch(API + "/api/order", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ symbol: currentSymbol, side: currentSide, amount, price, confirm })
    }).then(r => r.json());

    if (r.error) { logEntry("error: " + r.error, "err"); return; }
    if (r.blocked) { logEntry("blocked: " + r.reason, "err"); return; }
    if (r.simulated) {
      logEntry(\`SIMULATED \${r.side} \${r.amount} \${r.symbol} @ \${r.price} (~$\${r.notionalUsd.toFixed(2)})\`, "sim");
    } else {
      logEntry(\`LIVE order placed: \${r.order.id}\`, "live");
    }
    loadBalance(); loadPositions();
  } catch (e) {
    logEntry("request failed: " + e.message, "err");
  }
});

loadStatus();
loadPrice();
loadBalance();
loadPositions();
setInterval(loadPrice, 5000);
setInterval(loadBalance, 15000);
setInterval(loadPositions, 15000);

// ---- Tabs ----
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-" + tab.dataset.tab).classList.add("active");
  });
});

// ---- Solana memecoin panel ----
let solSide = "buy";
let currentMint = "";
const SOL_KEY_STORAGE = "syn_sol_wallet_key";

function solLog(text, cls) {
  const box = document.getElementById("solLogBox");
  const el = document.createElement("div");
  el.className = "entry " + (cls || "");
  el.innerHTML = \`<span class="t">\${new Date().toLocaleTimeString()}</span>\${text}\`;
  box.prepend(el);
}

function getSavedWalletKey() {
  try { return localStorage.getItem(SOL_KEY_STORAGE) || ""; } catch (e) { return ""; }
}

function renderWalletBox() {
  const key = getSavedWalletKey();
  const emptyBox = document.getElementById("solWalletEmpty");
  const connectedBox = document.getElementById("solWalletConnected");
  const form = document.getElementById("solConnectForm");
  if (key) {
    emptyBox.style.display = "none";
    connectedBox.style.display = "";
    form.style.display = "none";
    document.getElementById("solWalletAddr").textContent = "connected · key stored in this browser";
  } else {
    emptyBox.style.display = "";
    connectedBox.style.display = "none";
    form.style.display = "";
  }
}

document.getElementById("solConnectForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = document.getElementById("solPrivateKeyInput").value.trim();
  if (!key) return;
  try { localStorage.setItem(SOL_KEY_STORAGE, key); } catch (err) {}
  document.getElementById("solPrivateKeyInput").value = "";
  renderWalletBox();
  solLog("wallet connected (stored in this browser only)", "sim");
});

document.getElementById("solDisconnectBtn").addEventListener("click", () => {
  try { localStorage.removeItem(SOL_KEY_STORAGE); } catch (err) {}
  renderWalletBox();
  solLog("wallet disconnected");
});

async function loadSolPrice() {
  if (!currentMint) return;
  try {
    const r = await fetch("/api/sol/price?mint=" + encodeURIComponent(currentMint)).then(r => r.json());
    if (r.error) { document.getElementById("solPriceBig").textContent = "—"; document.getElementById("mintLabel").textContent = r.error; return; }
    lastKnownPrice = r.priceUsd;
    document.getElementById("solPriceBig").textContent = "$" + r.priceUsd.toLocaleString(undefined,{maximumFractionDigits:8});
    document.getElementById("mintLabel").textContent = currentMint.slice(0,4) + "…" + currentMint.slice(-4);
  } catch (e) { /* leave last known price on screen */ }
}

document.getElementById("mintInput").addEventListener("change", (e) => {
  currentMint = e.target.value.trim();
  loadSolPrice();
});

document.querySelectorAll("#solOrderForm .side-toggle button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#solOrderForm .side-toggle button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    solSide = btn.dataset.side;
  });
});

document.querySelectorAll("#solAmountPresets button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#solAmountPresets button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("solAmountInput").value = btn.dataset.amt;
  });
});
document.getElementById("solAmountInput").addEventListener("input", () => {
  document.querySelectorAll("#solAmountPresets button").forEach(b => b.classList.remove("active"));
});

// ---- "Right now" vs "At a price I set" ----
let solWhen = "now";
let lastKnownPrice = null;

document.querySelectorAll("#solWhenToggle button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#solWhenToggle button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    solWhen = btn.dataset.when;
    document.getElementById("solTargetField").style.display = solWhen === "later" ? "" : "none";
    document.getElementById("solSubmitBtn").textContent = solWhen === "later" ? "Set price rule" : "Buy / Sell";
  });
});

document.getElementById("solTargetPrice").addEventListener("input", (e) => {
  const target = parseFloat(e.target.value);
  const note = document.getElementById("solConditionNote");
  if (!target || lastKnownPrice == null) { note.textContent = "Will trigger once the price crosses this."; return; }
  note.textContent = target < lastKnownPrice
    ? \`Currently $\${lastKnownPrice} — will trigger once it drops to this.\`
    : \`Currently $\${lastKnownPrice} — will trigger once it rises to this.\`;
});

document.getElementById("solOrderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentMint) { solLog("pick a token first — tap one in the Screener list", "err"); return; }
  const amountSol = parseFloat(document.getElementById("solAmountInput").value);
  const confirm = document.getElementById("solConfirmCheck").checked;
  const walletPrivateKey = getSavedWalletKey();
  if (confirm && !walletPrivateKey) { solLog("connect a wallet first to send a real trade", "err"); return; }

  if (solWhen === "later") {
    const targetPrice = parseFloat(document.getElementById("solTargetPrice").value);
    if (!targetPrice) { solLog("enter a trigger price first", "err"); return; }
    const condition = (lastKnownPrice != null && targetPrice < lastKnownPrice) ? "below" : "above";
    try {
      const r = await fetch("/api/sol/rules", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          mint: currentMint, symbol: document.getElementById("mintLabel").textContent,
          side: solSide, condition, targetPrice, amountSol, confirm, walletPrivateKey
        })
      }).then(r => r.json());
      if (r.error) { solLog("error: " + r.error, "err"); return; }
      solLog(\`Rule set — will \${solSide} when price goes \${condition} $\${targetPrice}\`, "sim");
      loadSolRules();
    } catch (e) { solLog("request failed: " + e.message, "err"); }
    return;
  }

  solLog(\`sending \${solSide} \${amountSol} SOL ↔ \${currentMint.slice(0,4)}…\`);
  try {
    const r = await fetch("/api/sol/order", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ mint: currentMint, side: solSide, amountSol, confirm, walletPrivateKey })
    }).then(r => r.json());

    if (r.error) { solLog("error: " + r.error, "err"); return; }
    if (r.blocked) { solLog("blocked: " + r.reason, "err"); return; }
    if (r.simulated) {
      solLog(\`Practice run — nothing real sent (\${r.side} \${r.amountSol} SOL, est out \${r.estimatedOut})\`, "sim");
    } else {
      solLog(\`Sent: \${r.signature}\`, "live");
    }
  } catch (e) { solLog("request failed: " + e.message, "err"); }
});

async function loadSolRules() {
  const box = document.getElementById("solRulesBox");
  try {
    const rules = await fetch("/api/sol/rules").then(r => r.json());
    if (!Array.isArray(rules) || !rules.length) { box.innerHTML = \`<div class="empty">none yet</div>\`; return; }
    box.innerHTML = rules.map(r => {
      const statusColor = r.status === "pending" ? "" : (r.status === "filled" ? "up" : "down");
      return \`<div class="bal-row" style="align-items:flex-start;">
        <span>\${r.symbol} · \${r.side} \${r.amountSol} SOL @ \${r.condition} $\${r.targetPrice}</span>
        <span class="amt \${statusColor}">\${r.status}\${r.status === "pending" ? \` <a href="#" data-rule-id="\${r.id}" class="cancel-rule" style="color:var(--muted);text-decoration:underline;margin-left:6px;">cancel</a>\` : ""}</span>
      </div>\`;
    }).join("");
    box.querySelectorAll(".cancel-rule").forEach(a => {
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        await fetch("/api/sol/rules/" + a.dataset.ruleId, { method: "DELETE" });
        loadSolRules();
      });
    });
  } catch (e) { box.innerHTML = \`<div class="empty">can't load rules right now</div>\`; }
}
loadSolRules();
setInterval(loadSolRules, 15000);

renderWalletBox();
setInterval(loadSolPrice, 5000);

// ---- Screener ----
async function loadScreener() {
  try {
    const list = await fetch("/api/sol/screener").then(r => r.json());
    const box = document.getElementById("screenerBox");
    if (!Array.isArray(list) || !list.length) { box.innerHTML = \`<div class="empty">nothing active right now</div>\`; return; }
    box.innerHTML = list.map(t => {
      const chgCls = t.change24h >= 0 ? "up" : "down";
      const chgTxt = (t.change24h >= 0 ? "+" : "") + t.change24h.toFixed(1) + "%";
      return \`<div class="scr-row" data-mint="\${t.mint}">
        <span class="sym">\${t.symbol}</span>
        <span class="stats">$\${t.priceUsd < 0.01 ? t.priceUsd.toExponential(2) : t.priceUsd.toFixed(4)}
          <span class="chg \${chgCls}">\${chgTxt}</span>
          · liq $\${Math.round(t.liquidityUsd/1000)}k</span>
      </div>\`;
    }).join("");
    box.querySelectorAll(".scr-row").forEach(row => {
      row.addEventListener("click", () => {
        currentMint = row.dataset.mint;
        document.getElementById("mintInput").value = currentMint;
        loadSolPrice();
        solLog(\`loaded \${row.querySelector(".sym").textContent} from screener\`);
      });
    });
  } catch (e) {
    document.getElementById("screenerBox").innerHTML = \`<div class="empty">screener unavailable</div>\`;
  }
}
loadScreener();
setInterval(loadScreener, 30000);
</script>
</body>
</html>
`;
app.get("/", (req, res) => { res.type("html").send(DASHBOARD_HTML); });
const transports = {};

// ---- REST API for the dashboard (same-origin, no auth beyond your deploy) ----
app.get("/api/status", (req, res) => {
  res.json({ exchange: EXCHANGE_ID, dryRun: DRY_RUN, maxPositionUsd: MAX_POSITION_USD });
});

app.get("/api/price", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTC/USDT";
    const ticker = await exchange.fetchTicker(symbol);
    res.json({ symbol, last: ticker.last, bid: ticker.bid, ask: ticker.ask, change: ticker.percentage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/balance", async (req, res) => {
  try {
    const bal = await exchange.fetchBalance();
    const nonZero = Object.fromEntries(Object.entries(bal.total || {}).filter(([, v]) => v > 0));
    res.json(nonZero);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/positions", async (req, res) => {
  try {
    if (!exchange.has["fetchPositions"]) return res.json([]);
    const positions = await exchange.fetchPositions();
    res.json(positions.filter(p => p.contracts > 0));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function executeCexTrade({ symbol, side, amount, price, confirm }) {
  const ticker = await exchange.fetchTicker(symbol);
  const notionalUsd = amount * (price || ticker.last);
  if (notionalUsd > MAX_POSITION_USD) {
    return { blocked: true, reason: `Notional $${notionalUsd.toFixed(2)} exceeds MAX_POSITION_USD ($${MAX_POSITION_USD})` };
  }
  if (DRY_RUN || !confirm) {
    log("DRY RUN order:", { symbol, side, amount, price, notionalUsd });
    return { simulated: true, symbol, side, amount, price: price || ticker.last, notionalUsd };
  }
  const order = price
    ? await exchange.createLimitOrder(symbol, side, amount, price)
    : await exchange.createMarketOrder(symbol, side, amount);
  log("LIVE order placed:", order.id, symbol, side, amount);
  return { simulated: false, order };
}

app.post("/api/order", express.json(), async (req, res) => {
  try {
    const { symbol, side, amount, price, confirm } = req.body;
    const result = await executeCexTrade({ symbol, side, amount, price, confirm });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Indicators (mirrors the paper-bot math on the Synapses side) ─────────
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Live bots: real-money automated strategies, running server-side so ──
// they keep working even with no browser tab open. Off by default in every
// way that matters: global DRY_RUN still gates everything, each bot also
// needs its own confirm:true, and a tripped circuit breaker never re-arms
// itself.
let liveBots = [];
let liveBotSeq = 1;
let liveBotState = { peakEquityUsd: null, breakerTripped: false, breakerReason: null };
const MAX_CONCURRENT_LIVE_BOTS = Number(process.env.MAX_CONCURRENT_LIVE_BOTS || 5);
const LIVE_PORTFOLIO_DD_LIMIT_PCT = Number(process.env.LIVE_PORTFOLIO_DD_LIMIT_PCT || 10);

app.get("/api/live-bots", (req, res) => {
  res.json({
    bots: liveBots.map(b => ({
      id: b.id, name: b.name, symbol: b.symbol, timeframe: b.timeframe,
      entry: b.entry, exit: b.exit, amountUsd: b.amountUsd, maxDailyLossPct: b.maxDailyLossPct,
      confirm: b.confirm, running: b.running, status: b.status, lastSignal: b.lastSignal || null,
      lastError: b.lastError || null, openPosition: b.openPosition || null, createdAt: b.createdAt,
    })),
    breaker: liveBotState,
    maxConcurrent: MAX_CONCURRENT_LIVE_BOTS,
    runningCount: liveBots.filter(b => b.running).length,
  });
});

app.post("/api/live-bots", express.json(), (req, res) => {
  const { name, symbol, timeframe, entry, exit, amountUsd, maxDailyLossPct, confirm } = req.body;
  if (!symbol || !entry || !exit || !amountUsd) {
    return res.status(400).json({ error: "symbol, entry, exit, amountUsd required" });
  }
  const runningCount = liveBots.filter(b => b.running).length;
  if (runningCount >= MAX_CONCURRENT_LIVE_BOTS) {
    return res.status(400).json({ error: `cap reached — ${MAX_CONCURRENT_LIVE_BOTS} live bots already running` });
  }
  const bot = {
    id: String(liveBotSeq++), name: name || `${symbol} bot`, symbol, timeframe: timeframe || "1h",
    entry, exit, amountUsd: Number(amountUsd), maxDailyLossPct: Number(maxDailyLossPct || 5),
    confirm: !!confirm, running: true, status: "running", createdAt: Date.now(),
    dayPnlUsd: 0, dayStamp: new Date().toDateString(), openPosition: null, lastCandleTs: null,
  };
  liveBots.push(bot);
  log("live bot created:", bot.id, bot.symbol, bot.entry, "->", bot.exit, bot.confirm ? "LIVE" : "practice");
  res.json({ id: bot.id, status: bot.status });
});

app.post("/api/live-bots/:id/stop", (req, res) => {
  const bot = liveBots.find(b => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: "not found" });
  bot.running = false; bot.status = "stopped";
  res.json({ stopped: true });
});

app.delete("/api/live-bots/:id", (req, res) => {
  liveBots = liveBots.filter(b => b.id !== req.params.id);
  res.json({ deleted: true });
});

app.post("/api/live-bots/reset-breaker", (req, res) => {
  liveBotState.breakerTripped = false;
  liveBotState.breakerReason = null;
  liveBotState.peakEquityUsd = null; // re-measured fresh on next check
  res.json({ ok: true });
});

async function estimateLiveEquityUsd() {
  // Rough estimate: cash-like balances + open bot positions marked at current price.
  // Good enough for a circuit breaker, not meant as an accounting statement.
  let total = 0;
  try {
    const bal = await exchange.fetchBalance();
    for (const [asset, amt] of Object.entries(bal.total || {})) {
      if (["USDT", "USD", "USDC", "BUSD"].includes(asset)) total += amt;
    }
  } catch (e) { /* balance fetch can fail without keys — fine, just less accurate */ }
  for (const bot of liveBots) {
    if (bot.openPosition) {
      try {
        const ticker = await exchange.fetchTicker(bot.symbol);
        total += bot.openPosition.qty * ticker.last;
      } catch (e) {}
    }
  }
  return total;
}

async function checkLiveBots() {
  if (!liveBots.some(b => b.running)) return;

  // Portfolio-wide circuit breaker check first — same shape as the Synapses side.
  const eq = await estimateLiveEquityUsd();
  if (eq > 0) {
    if (liveBotState.peakEquityUsd == null || eq > liveBotState.peakEquityUsd) liveBotState.peakEquityUsd = eq;
    const dd = ((liveBotState.peakEquityUsd - eq) / liveBotState.peakEquityUsd) * 100;
    if (dd >= LIVE_PORTFOLIO_DD_LIMIT_PCT && !liveBotState.breakerTripped) {
      liveBotState.breakerTripped = true;
      liveBotState.breakerReason = `Portfolio down ${dd.toFixed(1)}% from peak — all live bots stopped.`;
      liveBots.forEach(b => { if (b.running) { b.running = false; b.status = "stopped (circuit breaker)"; } });
      log("LIVE BOT CIRCUIT BREAKER TRIPPED:", liveBotState.breakerReason);
      return;
    }
  }
  if (liveBotState.breakerTripped) return; // stays off until manually reset

  for (const bot of liveBots) {
    if (!bot.running) continue;
    try {
      const today = new Date().toDateString();
      if (bot.dayStamp !== today) { bot.dayStamp = today; bot.dayPnlUsd = 0; }
      const dailyCap = -(bot.amountUsd * (bot.maxDailyLossPct / 100));
      if (bot.dayPnlUsd <= dailyCap) {
        bot.running = false; bot.status = "stopped (daily loss cap)"; continue;
      }

      const candles = await exchange.fetchOHLCV(bot.symbol, bot.timeframe, undefined, 60);
      if (!candles || candles.length < 25) { bot.lastError = "not enough candle history yet"; continue; }
      const closed = candles[candles.length - 2]; // last fully-closed candle
      if (!closed) continue;
      if (bot.lastCandleTs === closed[0]) continue; // already acted on this candle
      bot.lastCandleTs = closed[0];

      const closes = candles.slice(0, -1).map(c => c[4]);
      const price = closed[4];
      const rsiVal = computeRSI(closes, 14);
      const smaVal = computeSMA(closes, 20);
      bot.lastError = null;

      const condTrue = (cond) => {
        if (cond === "rsi_below") return rsiVal != null && rsiVal < 32;
        if (cond === "rsi_above") return rsiVal != null && rsiVal > 68;
        if (cond === "price_below_sma") return smaVal != null && price < smaVal;
        if (cond === "price_above_sma") return smaVal != null && price > smaVal;
        return false;
      };

      if (!bot.openPosition && condTrue(bot.entry)) {
        const amount = bot.amountUsd / price;
        const result = await executeCexTrade({ symbol: bot.symbol, side: "buy", amount, confirm: bot.confirm });
        bot.lastSignal = "buy @ " + price;
        if (result.error) { bot.lastError = result.error; }
        else if (result.blocked) { bot.lastError = "blocked: " + result.reason; }
        else { bot.openPosition = { qty: amount, entryPrice: price, openedAt: Date.now() }; }
      } else if (bot.openPosition && condTrue(bot.exit)) {
        const result = await executeCexTrade({ symbol: bot.symbol, side: "sell", amount: bot.openPosition.qty, confirm: bot.confirm });
        bot.lastSignal = "sell @ " + price;
        if (result.error) { bot.lastError = result.error; }
        else if (result.blocked) { bot.lastError = "blocked: " + result.reason; }
        else {
          const pnl = (price - bot.openPosition.entryPrice) * bot.openPosition.qty;
          bot.dayPnlUsd += pnl;
          bot.openPosition = null;
        }
      } else {
        bot.lastSignal = bot.openPosition ? "holding, waiting for exit" : "waiting for entry";
      }
    } catch (e) {
      bot.lastError = e.message;
    }
  }
}
setInterval(checkLiveBots, 60000);

// ---- Solana / Jupiter memecoin endpoints ----
// mint = the token's Solana address (paste from pump.fun / dexscreener / birdeye etc)
app.get("/api/sol/status", (req, res) => {
  res.json({
    walletConnected: !!solWallet,
    walletAddress: solWallet ? solWallet.publicKey.toBase58() : null,
    dryRun: SOL_DRY_RUN,
    maxSolPerTrade: MAX_SOL_PER_TRADE,
  });
});


app.get("/api/sol/price", async (req, res) => {
  try {
    const mint = req.query.mint;
    if (!mint) return res.status(400).json({ error: "mint required" });
    const r = await fetch(`https://api.jup.ag/price/v2?ids=${mint}`).then(r => r.json());
    const p = r.data?.[mint];
    if (!p) return res.status(404).json({ error: "no price — check the mint address" });
    res.json({ mint, priceUsd: Number(p.price) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function getJupQuote(inputMint, outputMint, amountLamports) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountLamports}&slippageBps=${SOL_MAX_SLIPPAGE_BPS}`;
  const r = await fetch(url).then(r => r.json());
  if (r.error) throw new Error(r.error);
  return r;
}

async function executeSolTrade({ mint, side, amountSol, confirm, walletPrivateKey }) {
  if (amountSol > MAX_SOL_PER_TRADE) {
    return { blocked: true, reason: `${amountSol} SOL exceeds MAX_SOL_PER_TRADE (${MAX_SOL_PER_TRADE})` };
  }
  const lamports = Math.round(amountSol * 1e9);
  const [inputMint, outputMint] = side === "buy" ? [SOL_MINT, mint] : [mint, SOL_MINT];
  const quote = await getJupQuote(inputMint, outputMint, lamports);

  if (SOL_DRY_RUN || !confirm) {
    const reason = SOL_DRY_RUN ? "SOL_DRY_RUN mode is on" : "confirm=false";
    log("DRY RUN sol order:", { mint, side, amountSol, reason });
    return { simulated: true, side, mint, amountSol, estimatedOut: quote.outAmount, priceImpactPct: quote.priceImpactPct };
  }

  let activeWallet = solWallet;
  if (walletPrivateKey) {
    try { activeWallet = Keypair.fromSecretKey(bs58.decode(walletPrivateKey)); }
    catch (e) { return { error: "that wallet key doesn't look valid" }; }
  }
  if (!activeWallet) return { error: "no wallet connected — paste one in the Solana tab, or set SOL_PRIVATE_KEY" };

  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: activeWallet.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  }).then(r => r.json());

  const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
  tx.sign([activeWallet]);
  const signature = await connection.sendTransaction(tx);
  log("LIVE sol order sent:", signature, mint, side, amountSol);
  return { simulated: false, signature, mint, side, amountSol };
}

app.post("/api/sol/order", express.json(), async (req, res) => {
  try {
    const { mint, side, amountSol, confirm, walletPrivateKey } = req.body;
    if (!mint || !side || !amountSol) return res.status(400).json({ error: "mint, side, amountSol required" });
    const result = await executeSolTrade({ mint, side, amountSol, confirm, walletPrivateKey });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Price rules: "buy/sell this token when it hits $X" ──────────────────
// In-memory only — resets if the server restarts or Render spins it down.
// A rule's wallet key lives in memory only for as long as the rule is pending;
// dropped the moment it fires, errors out, or gets cancelled.
let solRules = [];
let solRuleSeq = 1;

app.get("/api/sol/rules", (req, res) => {
  res.json(solRules.map(r => ({
    id: r.id, mint: r.mint, symbol: r.symbol, side: r.side, condition: r.condition,
    targetPrice: r.targetPrice, amountSol: r.amountSol, confirm: r.confirm,
    status: r.status, createdAt: r.createdAt, result: r.result || null,
  }))); // never send walletPrivateKey back to the browser
});

app.post("/api/sol/rules", express.json(), (req, res) => {
  const { mint, symbol, side, condition, targetPrice, amountSol, confirm, walletPrivateKey } = req.body;
  if (!mint || !side || !condition || !targetPrice || !amountSol) {
    return res.status(400).json({ error: "mint, side, condition, targetPrice, amountSol required" });
  }
  if (condition !== "above" && condition !== "below") {
    return res.status(400).json({ error: "condition must be 'above' or 'below'" });
  }
  const rule = {
    id: String(solRuleSeq++), mint, symbol: symbol || mint.slice(0, 4), side, condition,
    targetPrice: Number(targetPrice), amountSol: Number(amountSol), confirm: !!confirm,
    walletPrivateKey: walletPrivateKey || null, status: "pending", createdAt: Date.now(),
  };
  solRules.push(rule);
  log("price rule created:", rule.id, rule.mint, rule.condition, rule.targetPrice);
  res.json({ id: rule.id, status: rule.status });
});

app.delete("/api/sol/rules/:id", (req, res) => {
  const before = solRules.length;
  solRules = solRules.filter(r => r.id !== req.params.id);
  res.json({ deleted: solRules.length < before });
});

async function checkSolRules() {
  const pending = solRules.filter(r => r.status === "pending");
  if (!pending.length) return;
  for (const rule of pending) {
    try {
      const priceRes = await fetch(`https://api.jup.ag/price/v2?ids=${rule.mint}`).then(r => r.json());
      const priceUsd = Number(priceRes.data?.[rule.mint]?.price);
      if (!priceUsd) continue;

      const hit = rule.condition === "above" ? priceUsd >= rule.targetPrice : priceUsd <= rule.targetPrice;
      if (!hit) continue;

      log("price rule triggered:", rule.id, rule.mint, "@", priceUsd);
      const result = await executeSolTrade({
        mint: rule.mint, side: rule.side, amountSol: rule.amountSol,
        confirm: rule.confirm, walletPrivateKey: rule.walletPrivateKey,
      });
      rule.status = result.error ? "error" : (result.blocked ? "blocked" : "filled");
      rule.result = result;
      rule.walletPrivateKey = null; // drop the key from memory once we're done with it
    } catch (e) {
      rule.status = "error";
      rule.result = { error: e.message };
      rule.walletPrivateKey = null;
    }
  }
}
setInterval(checkSolRules, 20000);

app.get("/api/sol/screener", async (req, res) => {
  try {
    const boosts = await fetch("https://api.dexscreener.com/token-boosts/latest/v1").then(r => r.json());
    const solTokens = (Array.isArray(boosts) ? boosts : []).filter(b => b.chainId === "solana");
    const addresses = [...new Set(solTokens.map(b => b.tokenAddress))].slice(0, 30);
    if (!addresses.length) return res.json([]);

    const pairsRes = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${addresses.join(",")}`).then(r => r.json());
    const pairs = Array.isArray(pairsRes) ? pairsRes : [];

    // keep the highest-liquidity pair per token
    const byToken = {};
    for (const p of pairs) {
      const addr = p.baseToken?.address;
      if (!addr) continue;
      if (!byToken[addr] || (p.liquidity?.usd || 0) > (byToken[addr].liquidity?.usd || 0)) byToken[addr] = p;
    }

    const ranked = Object.values(byToken)
      .filter(p => (p.liquidity?.usd || 0) > 5000) // filter obvious dust/thin pools, not a safety guarantee
      .map(p => {
        const vol = p.volume?.h24 || 0;
        const chg = p.priceChange?.h24 || 0;
        const liq = p.liquidity?.usd || 0;
        // transparent composite of current activity — NOT a prediction of future price
        const score = Math.log10(vol + 1) * 2 + Math.max(chg, 0) / 10 + Math.log10(liq + 1);
        return {
          mint: p.baseToken.address,
          symbol: p.baseToken.symbol,
          priceUsd: Number(p.priceUsd),
          change24h: chg,
          volume24h: vol,
          liquidityUsd: liq,
          pairAgeHours: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3.6e6 : null,
          score: Math.round(score * 10) / 10,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    res.json(ranked);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/sse", async (req, res) => {
  const server = buildServer();
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(400).send("No transport for sessionId");
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (req, res) => res.json({ ok: true, exchange: EXCHANGE_ID, dryRun: DRY_RUN }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`trading-mcp listening on :${PORT} | exchange=${EXCHANGE_ID} | DRY_RUN=${DRY_RUN} | maxPos=$${MAX_POSITION_USD}`);
});

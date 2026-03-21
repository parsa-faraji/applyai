[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

# PredictBot — AI-Powered Prediction Market Trading

A web app that uses Claude to analyze Polymarket prediction markets and execute trades on your behalf.

## Features

- **Live Markets** — Browse active Polymarket markets with real-time prices and volume
- **Claude Analysis** — Get AI-powered market analysis and trading recommendations
- **One-Click Trading** — Execute trades directly from the dashboard
- **Portfolio Tracking** — Monitor your positions, P&L, and trade history
- **Auto-Trade Mode** — Let Claude automatically execute its recommendations
- **Risk Controls** — Configurable position sizes and risk tolerance levels

## Architecture

```
Frontend (Vanilla JS)  →  Vercel Serverless Functions  →  Polymarket Gamma API
                                                       →  Anthropic Claude API
                                                       →  Polymarket CLOB API
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/markets` | GET | Proxy to Polymarket Gamma API for market data |
| `/api/analyze` | POST | Send market data to Claude for analysis |
| `/api/trade` | POST | Execute trades via Polymarket CLOB API |

## Setup

1. Clone and install:
   ```bash
   npm install
   ```

2. Set environment variables (or configure in the app's Settings page):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   POLYMARKET_API_KEY=...
   POLYMARKET_API_SECRET=...
   POLYMARKET_PASSPHRASE=...
   ```

3. Run locally:
   ```bash
   npm run dev
   ```

4. Deploy:
   ```bash
   npm run deploy
   ```

## Configuration

All settings can be configured in the app's Settings page:

- **API Keys** — Anthropic and Polymarket credentials
- **Max Position Size** — Maximum USDC per trade
- **Risk Tolerance** — Conservative / Moderate / Aggressive
- **Auto-Trade** — Automatically execute Claude's recommendations

## How It Works

1. Markets are fetched from Polymarket's Gamma API
2. Select a market and click "Analyze" to get Claude's take
3. Claude evaluates the question, estimates probabilities, and identifies mispricings
4. Place trades directly or enable auto-trade for hands-free operation
5. Track your portfolio performance over time

## Disclaimer

This is an experimental trading tool. Prediction market trading involves risk of loss. Use at your own risk. Not financial advice.

## License

MIT

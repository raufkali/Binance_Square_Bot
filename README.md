# Combined Social Media Bot Server (Binance Square + LinkedIn)

This is a Node.js server that runs two independent AI-powered bots:

- Binance Square Bot – Posts short, punchy crypto trade ideas to Binance Square with generated chart images.
- LinkedIn Bot – Posts professional job/internship/scholarship opportunities to your personal LinkedIn profile with custom-generated images.

Both bots share the same HTTP server, MongoDB for state, and Groq for content generation. Each bot has its own state, history, and posting limits.

---

## Features

### Binance Square Bot
- Real-time market data – fetches the hottest trending coin (by volume * price change) from Binance.
- Technical signals – calculates SMA (9/21) and RSI (14) to generate a directional signal (Bullish/Bearish/Neutral).
- AI-generated posts – uses Groq to create short, engaging trade setups with the ticker, price, and a clear action.
- AI-generated chart images – uses Cloudflare Workers AI (Flux) to produce realistic trading chart screenshots.
- Daily limit – configurable (default: 36 posts/day).
- State persistence – MongoDB tracks topics, history, and daily counters.

### LinkedIn Bot
- Personal profile posting – uses w_member_social scope (no company page required).
- Research-driven content – scrapes Google News RSS for real job/internship/scholarship openings.
- AI post generation – Groq produces structured posts (organisation + opportunity, requirements, how to apply, hashtags).
- Image generation – Cloudflare Flux creates professional, non-branded career-related images.
- Daily limit – configurable (default: 3 posts/day).
- OAuth 2.0 – secure token storage for LinkedIn.

---

## Requirements

- Node.js 18+
- MongoDB (Atlas or self-hosted)
- Groq API key (groq.com)
- Cloudflare Account ID & API Token (for image generation)
- LinkedIn Developer App (for OAuth)
- Binance Square API key (for posting to Binance Square)

---

## Installation

```bash
git clone https://github.com/yourusername/combined-bot.git
cd combined-bot
npm install

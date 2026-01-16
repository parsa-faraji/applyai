# ApplyAI

AI-powered job application generator. Paste a job posting, get a perfectly tailored resume, cover letter, and interview prep in seconds.

## Features

- **Tailored Resume** - AI rewrites your resume to match job requirements and pass ATS
- **Cover Letter** - Personalized cover letters that highlight relevant experience
- **Interview Tips** - Specific questions and talking points for each application
- **Resume Memory** - Saves your resume locally for quick reuse
- **Usage Tracking** - Track your application generation history

## Tech Stack

- Vanilla JavaScript (no framework bloat)
- Vercel Serverless Functions
- OpenAI GPT-4o-mini API
- Pure CSS

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/parsa-faraji/applyai.git
cd applyai
```

### 2. Install Vercel CLI

```bash
npm i -g vercel
```

### 3. Set up environment variables

```bash
vercel env add OPENAI_API_KEY
# Enter your OpenAI API key when prompted
```

### 4. Deploy

```bash
vercel --prod
```

## Local Development

```bash
# Set environment variable locally
export OPENAI_API_KEY=your_key_here

# Run local dev server
vercel dev
```

Open http://localhost:3000

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Your OpenAI API key (get one at platform.openai.com) |

## API Endpoint

`POST /api/generate`

**Request Body:**
```json
{
  "jobDescription": "Full job posting text...",
  "resume": "Your current resume text...",
  "type": "resume" | "cover" | "tips"
}
```

**Response:**
```json
{
  "content": "Generated content...",
  "usage": { "prompt_tokens": 500, "completion_tokens": 800 }
}
```

## Costs

Using GPT-4o-mini:
- ~$0.002 per application (3 API calls)
- 1000 applications ≈ $2

## Monetization Ideas

1. **Freemium** - 3 free/month, then $12/month unlimited
2. **Pay-per-use** - $2 per application
3. **Credits** - Buy 10 for $15, 50 for $50
4. **B2B** - Sell to career services, bootcamps, universities

## Roadmap

- [ ] PDF resume parsing
- [ ] Application tracker dashboard
- [ ] Chrome extension for LinkedIn
- [ ] Email follow-up generator
- [ ] Stripe integration for payments
- [ ] User accounts with Supabase

## License

MIT

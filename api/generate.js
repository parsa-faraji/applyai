// Vercel Serverless Function - OpenAI Integration
// Deploy with: vercel deploy

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { jobDescription, resume, type } = req.body;

    if (!jobDescription || !resume) {
        return res.status(400).json({ error: 'Missing jobDescription or resume' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    try {
        const prompts = {
            resume: `You are an expert resume writer and ATS optimization specialist.

Given the following job description and resume, create a tailored version of the resume that:
1. Highlights relevant experience and skills that match the job requirements
2. Uses keywords from the job description naturally
3. Quantifies achievements where possible
4. Maintains professional tone
5. Is optimized for ATS (Applicant Tracking Systems)

JOB DESCRIPTION:
${jobDescription}

ORIGINAL RESUME:
${resume}

Return ONLY the tailored resume content, formatted cleanly. Do not include any explanations or meta-commentary.`,

            cover: `You are an expert cover letter writer.

Write a compelling, personalized cover letter for this job application:

JOB DESCRIPTION:
${jobDescription}

CANDIDATE'S RESUME:
${resume}

The cover letter should:
1. Be 3-4 paragraphs
2. Open with a strong hook (not "I am writing to apply")
3. Highlight 2-3 most relevant experiences/skills
4. Show genuine interest in the company/role
5. End with a clear call to action

Return ONLY the cover letter. Do not include explanations.`,

            tips: `You are a career coach and interview preparation expert.

Based on this job description and candidate resume, provide specific interview preparation tips:

JOB DESCRIPTION:
${jobDescription}

CANDIDATE'S RESUME:
${resume}

Provide:
1. 5 likely interview questions they'll be asked (specific to this role)
2. Key talking points to emphasize from their background
3. Potential weaknesses to prepare for
4. 3 smart questions to ask the interviewer
5. One insider tip for this type of role

Format clearly with headers. Be specific, not generic.`
        };

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a professional career assistant helping job seekers create tailored applications.'
                    },
                    {
                        role: 'user',
                        content: prompts[type] || prompts.resume
                    }
                ],
                temperature: 0.7,
                max_tokens: 2000
            })
        });

        if (!response.ok) {
            const error = await response.json();
            console.error('OpenAI Error:', error);
            return res.status(500).json({ error: 'AI generation failed' });
        }

        const data = await response.json();
        const content = data.choices[0]?.message?.content;

        return res.status(200).json({
            content,
            usage: data.usage
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

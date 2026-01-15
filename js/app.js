/**
 * ApplyAI - Main Application Logic
 */

(function() {
    'use strict';

    const elements = {
        jobInput: document.getElementById('job-input'),
        resumeInput: document.getElementById('resume-input'),
        fileInput: document.getElementById('file-input'),
        generateBtn: document.getElementById('generate-btn'),
        outputSection: document.getElementById('output-section'),
        resumeContent: document.getElementById('resume-content'),
        coverContent: document.getElementById('cover-content'),
        tipsContent: document.getElementById('tips-content'),
        copyBtn: document.getElementById('copy-btn'),
        downloadBtn: document.getElementById('download-btn'),
        tabs: document.querySelectorAll('.tab'),
        tabContents: document.querySelectorAll('.tab-content')
    };

    function init() {
        elements.generateBtn.addEventListener('click', handleGenerate);
        elements.fileInput.addEventListener('change', handleFileUpload);
        elements.copyBtn?.addEventListener('click', handleCopy);
        elements.downloadBtn?.addEventListener('click', handleDownload);

        elements.tabs.forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });
    }

    async function handleGenerate() {
        const jobDesc = elements.jobInput.value.trim();
        const resume = elements.resumeInput.value.trim();

        if (!jobDesc || !resume) {
            alert('Please fill in both the job description and your resume.');
            return;
        }

        // Show loading
        const btnText = elements.generateBtn.querySelector('.btn-text');
        const btnLoading = elements.generateBtn.querySelector('.btn-loading');
        btnText.style.display = 'none';
        btnLoading.style.display = 'inline';
        elements.generateBtn.disabled = true;

        // Simulate AI processing (replace with actual API call)
        await simulateProcessing(jobDesc, resume);

        // Show output
        elements.outputSection.style.display = 'block';
        elements.outputSection.scrollIntoView({ behavior: 'smooth' });

        // Reset button
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
        elements.generateBtn.disabled = false;
    }

    async function simulateProcessing(jobDesc, resume) {
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Extract some keywords from job description for personalization
        const keywords = extractKeywords(jobDesc);
        const jobTitle = extractJobTitle(jobDesc);

        // Generate mock tailored content
        elements.resumeContent.innerHTML = generateTailoredResume(resume, keywords, jobTitle);
        elements.coverContent.innerHTML = generateCoverLetter(resume, keywords, jobTitle);
        elements.tipsContent.innerHTML = generateInterviewTips(keywords, jobTitle);
    }

    function extractKeywords(text) {
        const commonKeywords = [
            'JavaScript', 'Python', 'React', 'Node.js', 'AWS', 'SQL', 'Machine Learning',
            'TypeScript', 'Git', 'Agile', 'REST API', 'Docker', 'Kubernetes', 'CI/CD',
            'leadership', 'communication', 'problem-solving', 'teamwork', 'analytical'
        ];

        return commonKeywords.filter(keyword =>
            text.toLowerCase().includes(keyword.toLowerCase())
        ).slice(0, 6);
    }

    function extractJobTitle(text) {
        const titles = ['Software Engineer', 'Developer', 'Data Scientist', 'Product Manager',
                       'Designer', 'Analyst', 'Engineer', 'Manager'];
        for (const title of titles) {
            if (text.toLowerCase().includes(title.toLowerCase())) {
                return title;
            }
        }
        return 'the position';
    }

    function generateTailoredResume(resume, keywords, jobTitle) {
        return `
            <h4>Professional Summary</h4>
            <p>Results-driven professional with proven expertise in ${keywords.slice(0, 3).join(', ') || 'relevant technologies'}.
            Seeking to leverage technical skills and experience as a ${jobTitle}.
            Track record of delivering high-impact solutions and collaborating effectively with cross-functional teams.</p>

            <h4>Key Skills (Optimized for ATS)</h4>
            <ul>
                ${keywords.map(k => `<li><strong>${k}</strong> - Highlighted based on job requirements</li>`).join('')}
                ${keywords.length === 0 ? '<li>Skills will be extracted from your resume and matched to the job</li>' : ''}
            </ul>

            <h4>Experience Highlights</h4>
            <p><em>Your experience has been reworded to emphasize:</em></p>
            <ul>
                <li>Quantifiable achievements (added metrics where possible)</li>
                <li>Keywords from the job description</li>
                <li>Action verbs that demonstrate impact</li>
                <li>Relevant technical skills prominently featured</li>
            </ul>

            <p style="background: #f0f9ff; padding: 12px; border-radius: 6px; margin-top: 20px; font-size: 13px;">
                <strong>ATS Score: 87/100</strong><br>
                Your tailored resume matches 87% of the job requirements. Key improvements: Added 4 missing keywords,
                restructured bullet points for better scanning, optimized formatting.
            </p>
        `;
    }

    function generateCoverLetter(resume, keywords, jobTitle) {
        return `
            <p>Dear Hiring Manager,</p>

            <p>I am writing to express my strong interest in the ${jobTitle} position at your company.
            With my background in ${keywords.slice(0, 2).join(' and ') || 'relevant technologies'},
            I am confident in my ability to contribute meaningfully to your team.</p>

            <p>In my previous roles, I have demonstrated expertise in:</p>
            <ul>
                ${keywords.slice(0, 4).map(k => `<li>Applying ${k} to solve complex business challenges</li>`).join('')}
                ${keywords.length === 0 ? '<li>Delivering results in fast-paced environments</li>' : ''}
            </ul>

            <p>What excites me most about this opportunity is the chance to work on challenging problems
            while growing alongside a talented team. I am particularly drawn to your company's focus on
            innovation and impact.</p>

            <p>I would welcome the opportunity to discuss how my skills and experience align with your needs.
            Thank you for considering my application.</p>

            <p>Best regards,<br>
            [Your Name]</p>

            <p style="background: #f0fdf4; padding: 12px; border-radius: 6px; margin-top: 20px; font-size: 13px;">
                <strong>Personalization Score: 92%</strong><br>
                This cover letter includes 6 job-specific keywords and addresses key requirements mentioned in the posting.
            </p>
        `;
    }

    function generateInterviewTips(keywords, jobTitle) {
        return `
            <h4>Prepare for These Questions</h4>
            <p>Based on the job description, you're likely to be asked about:</p>
            <ul>
                ${keywords.map(k => `<li>"Tell me about your experience with <strong>${k}</strong>"</li>`).join('')}
                <li>"Describe a challenging project and how you handled it"</li>
                <li>"Why are you interested in this ${jobTitle} role?"</li>
            </ul>

            <h4>Key Points to Emphasize</h4>
            <ul>
                <li>Your hands-on experience with the required technologies</li>
                <li>Specific metrics and achievements from past roles</li>
                <li>How you've collaborated with teams and stakeholders</li>
                <li>Your enthusiasm for the company's mission</li>
            </ul>

            <h4>Questions to Ask Them</h4>
            <ul>
                <li>"What does success look like in this role after 6 months?"</li>
                <li>"How does the team approach ${keywords[0] || 'technical challenges'}?"</li>
                <li>"What are the biggest priorities for this position right now?"</li>
            </ul>

            <p style="background: #fefce8; padding: 12px; border-radius: 6px; margin-top: 20px; font-size: 13px;">
                <strong>Pro tip:</strong> Review the company's recent news and mention something specific
                during your interview to show genuine interest.
            </p>
        `;
    }

    function switchTab(tabId) {
        elements.tabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabId);
        });

        elements.tabContents.forEach(content => {
            content.classList.toggle('active', content.id === `${tabId}-content`);
        });
    }

    function handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(event) {
            // For simplicity, just show filename.
            // In production, you'd parse PDF/DOCX
            elements.resumeInput.value = `[Uploaded: ${file.name}]\n\nFile contents would be extracted here. For now, please paste your resume text.`;
        };
        reader.readAsText(file);
    }

    function handleCopy() {
        const activeContent = document.querySelector('.tab-content.active');
        const text = activeContent.innerText;

        navigator.clipboard.writeText(text).then(() => {
            elements.copyBtn.textContent = 'Copied!';
            setTimeout(() => {
                elements.copyBtn.textContent = 'Copy to clipboard';
            }, 2000);
        });
    }

    function handleDownload() {
        const activeContent = document.querySelector('.tab-content.active');
        const text = activeContent.innerText;

        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'applyai-document.txt';
        a.click();
        URL.revokeObjectURL(url);
    }

    init();
})();

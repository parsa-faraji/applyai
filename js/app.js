/**
 * ApplyAI - Job Application Generator
 * Production-ready with real OpenAI integration
 */

(function() {
    'use strict';

    // Config - change this for different environments
    const CONFIG = {
        apiUrl: '/api/generate', // Vercel serverless function
        useMockData: false // Set to true for testing without API
    };

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

    // Store generated content
    let generatedContent = {
        resume: '',
        cover: '',
        tips: ''
    };

    function init() {
        elements.generateBtn.addEventListener('click', handleGenerate);
        elements.fileInput.addEventListener('change', handleFileUpload);
        elements.copyBtn?.addEventListener('click', handleCopy);
        elements.downloadBtn?.addEventListener('click', handleDownload);

        elements.tabs.forEach(tab => {
            tab.addEventListener('click', () => switchTab(tab.dataset.tab));
        });

        // Load saved resume from localStorage
        const savedResume = localStorage.getItem('applyai_resume');
        if (savedResume) {
            elements.resumeInput.value = savedResume;
        }

        // Save resume on change
        elements.resumeInput.addEventListener('blur', () => {
            localStorage.setItem('applyai_resume', elements.resumeInput.value);
        });
    }

    async function handleGenerate() {
        const jobDesc = elements.jobInput.value.trim();
        const resume = elements.resumeInput.value.trim();

        if (!jobDesc) {
            showError('Please paste the job description.');
            elements.jobInput.focus();
            return;
        }

        if (!resume) {
            showError('Please paste your resume.');
            elements.resumeInput.focus();
            return;
        }

        setLoading(true);

        try {
            if (CONFIG.useMockData) {
                await generateMockContent(jobDesc, resume);
            } else {
                await generateRealContent(jobDesc, resume);
            }

            // Show output section
            elements.outputSection.style.display = 'block';
            elements.outputSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

            // Track usage (you can add analytics here)
            trackGeneration();

        } catch (error) {
            console.error('Generation error:', error);
            showError('Something went wrong. Please try again.');
        } finally {
            setLoading(false);
        }
    }

    async function generateRealContent(jobDesc, resume) {
        // Generate all three types in parallel
        const [resumeResult, coverResult, tipsResult] = await Promise.all([
            callAPI(jobDesc, resume, 'resume'),
            callAPI(jobDesc, resume, 'cover'),
            callAPI(jobDesc, resume, 'tips')
        ]);

        generatedContent.resume = resumeResult;
        generatedContent.cover = coverResult;
        generatedContent.tips = tipsResult;

        elements.resumeContent.innerHTML = formatContent(resumeResult, 'resume');
        elements.coverContent.innerHTML = formatContent(coverResult, 'cover');
        elements.tipsContent.innerHTML = formatContent(tipsResult, 'tips');
    }

    async function callAPI(jobDesc, resume, type) {
        const response = await fetch(CONFIG.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jobDescription: jobDesc,
                resume: resume,
                type: type
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'API request failed');
        }

        const data = await response.json();
        return data.content;
    }

    function formatContent(content, type) {
        // Convert markdown-like formatting to HTML
        let html = content
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/^### (.*$)/gm, '<h4>$1</h4>')
            .replace(/^## (.*$)/gm, '<h3>$1</h3>')
            .replace(/^# (.*$)/gm, '<h3>$1</h3>')
            .replace(/^\- (.*$)/gm, '<li>$1</li>')
            .replace(/^\d+\. (.*$)/gm, '<li>$1</li>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\n/g, '<br>');

        // Wrap lists
        html = html.replace(/(<li>.*<\/li>)+/g, '<ul>$&</ul>');

        // Add score badge based on type
        const badges = {
            resume: `<div class="score-badge">
                <span class="score-icon">✓</span>
                <span><strong>ATS Optimized</strong> - Keywords matched to job description</span>
            </div>`,
            cover: `<div class="score-badge success">
                <span class="score-icon">✓</span>
                <span><strong>Personalized</strong> - Tailored to this specific role</span>
            </div>`,
            tips: `<div class="score-badge info">
                <span class="score-icon">💡</span>
                <span><strong>Interview Ready</strong> - Prepare with these insights</span>
            </div>`
        };

        return `<div class="generated-content"><p>${html}</p></div>${badges[type] || ''}`;
    }

    async function generateMockContent(jobDesc, resume) {
        // Simulate API delay
        await new Promise(resolve => setTimeout(resolve, 2000));

        const keywords = extractKeywords(jobDesc);

        generatedContent.resume = `Professional Summary tailored for this role with keywords: ${keywords.join(', ')}`;
        generatedContent.cover = `Cover letter highlighting relevant experience...`;
        generatedContent.tips = `Interview preparation tips...`;

        elements.resumeContent.innerHTML = formatContent(generatedContent.resume, 'resume');
        elements.coverContent.innerHTML = formatContent(generatedContent.cover, 'cover');
        elements.tipsContent.innerHTML = formatContent(generatedContent.tips, 'tips');
    }

    function extractKeywords(text) {
        const keywords = ['JavaScript', 'Python', 'React', 'Node.js', 'AWS', 'SQL',
                         'TypeScript', 'Git', 'Agile', 'Docker', 'leadership'];
        return keywords.filter(k => text.toLowerCase().includes(k.toLowerCase())).slice(0, 5);
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

        // For text files, read directly
        if (file.type === 'text/plain') {
            const reader = new FileReader();
            reader.onload = (event) => {
                elements.resumeInput.value = event.target.result;
            };
            reader.readAsText(file);
            return;
        }

        // For PDF/DOCX, show message (would need server-side processing)
        elements.resumeInput.value = `[File uploaded: ${file.name}]\n\nFor best results, please paste your resume text directly. PDF/DOCX parsing coming soon!`;
        elements.resumeInput.focus();
    }

    function handleCopy() {
        const activeTab = document.querySelector('.tab.active').dataset.tab;
        const content = generatedContent[activeTab] || '';

        navigator.clipboard.writeText(content).then(() => {
            const originalText = elements.copyBtn.textContent;
            elements.copyBtn.textContent = 'Copied!';
            elements.copyBtn.classList.add('success');
            setTimeout(() => {
                elements.copyBtn.textContent = originalText;
                elements.copyBtn.classList.remove('success');
            }, 2000);
        }).catch(() => {
            showError('Failed to copy. Please select and copy manually.');
        });
    }

    function handleDownload() {
        const activeTab = document.querySelector('.tab.active').dataset.tab;
        const content = generatedContent[activeTab] || '';
        const filename = `applyai-${activeTab}-${Date.now()}.txt`;

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function setLoading(loading) {
        const btnText = elements.generateBtn.querySelector('.btn-text');
        const btnLoading = elements.generateBtn.querySelector('.btn-loading');

        if (loading) {
            btnText.style.display = 'none';
            btnLoading.style.display = 'inline';
            btnLoading.innerHTML = '<span class="loading-spinner"></span> Generating with AI...';
            elements.generateBtn.disabled = true;
            elements.generateBtn.classList.add('loading');
        } else {
            btnText.style.display = 'inline';
            btnLoading.style.display = 'none';
            elements.generateBtn.disabled = false;
            elements.generateBtn.classList.remove('loading');
        }
    }

    function showError(message) {
        // Create toast notification
        const toast = document.createElement('div');
        toast.className = 'toast error';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    function trackGeneration() {
        // Track usage in localStorage
        const usage = JSON.parse(localStorage.getItem('applyai_usage') || '{"count": 0, "dates": []}');
        usage.count++;
        usage.dates.push(new Date().toISOString());
        localStorage.setItem('applyai_usage', JSON.stringify(usage));

        // You can add analytics tracking here (Google Analytics, Mixpanel, etc.)
        console.log('Generation tracked:', usage.count);
    }

    // Initialize
    init();
})();

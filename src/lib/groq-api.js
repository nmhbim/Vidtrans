/**
 * Groq API Client for STT (Whisper) and Translation (Llama)
 */
export class GroqClient {
    apiKey;
    targetLang;
    constructor(apiKey, targetLang = 'vi') {
        if (!apiKey)
            throw new Error('API Key is required');
        this.apiKey = apiKey;
        this.targetLang = targetLang;
    }
    async transcribe(audioBlob) {
        const formData = new FormData();
        formData.append('file', audioBlob, 'audio.webm');
        formData.append('model', 'whisper-large-v3-turbo');
        formData.append('response_format', 'json');
        const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.apiKey}` },
            body: formData
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error?.message || `Transcription failed with status ${res.status}`);
        }
        const data = await res.json();
        return data.text || '';
    }
    async translate(prompt) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 1024
            })
        });
        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error?.message || `Translation failed with status ${res.status}`);
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || '';
    }
    async translateWithRetry(text, sourceLang, retries = 2) {
        const prompt = `Translate this from ${sourceLang} to ${this.targetLang}: "${text}"\nOutput only the translation.`;
        for (let i = 0; i < retries; i++) {
            try {
                return await this.translate(prompt);
            }
            catch (err) {
                if (i === retries - 1)
                    throw err;
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
            }
        }
        return '';
    }
}

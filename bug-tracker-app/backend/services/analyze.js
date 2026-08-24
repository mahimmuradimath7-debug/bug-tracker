const { GoogleGenAI } = require('@google/genai');

const SYSTEM_PROMPT = `You are a precise code reviewer. Respond with ONLY a JSON array, no markdown fences, no preamble. Each element: {"line": number|null, "severity": "critical"|"high"|"medium"|"low", "title": string (max 8 words), "description": string (max 30 words, plain explanation of the bug and why it matters)}. Report at most 4 real, concrete issues (bugs, crashes, logic errors, security problems, resource leaks) - do not invent issues or nitpick style. If the file looks fine, return [].`;

async function analyzeFile(path, content) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set on the backend (see backend/.env.example)');
  }

  const ai = new GoogleGenAI({ apiKey });
  const userMsg = `File: ${path}\n\n\`\`\`\n${content}\n\`\`\``;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userMsg,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.2
      }
    });

    const text = response.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Gemini API Error:', e);
    return [];
  }
}

module.exports = { analyzeFile };

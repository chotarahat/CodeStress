import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

export class AIClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.OLLAMA_API || process.env.OLLAMA_API_KEY || '';
    this.baseUrl = (options.baseUrl || process.env.OLLAMA_BASE_URL || 'https://ollama.com').replace(/\/+$/, '');
    this.model = options.model || process.env.OLLAMA_MODEL || 'gpt-oss:120b';
    this.engineName = `IBM Bob 2.0 (${this.model})`;
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Send a chat prompt to Ollama Cloud
   */
  async chat(messages, options = {}) {
    if (!this.hasCredentials()) {
      return null;
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey.trim()}`
    };

    // Try standard Ollama Cloud /api/chat endpoint first
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages,
          stream: false,
          ...options
        },
        { headers, timeout: 45000 }
      );

      if (response.data?.message?.content) {
        return response.data.message.content;
      }
      if (typeof response.data === 'string') {
        return response.data;
      }
    } catch (err) {
      // If /api/chat fails, try OpenAI-compatible /v1/chat/completions endpoint
      try {
        const response = await axios.post(
          `${this.baseUrl}/v1/chat/completions`,
          {
            model: this.model,
            messages,
            stream: false
          },
          { headers, timeout: 45000 }
        );

        if (response.data?.choices?.[0]?.message?.content) {
          return response.data.choices[0].message.content;
        }
      } catch (fallbackErr) {
        // Log debug warning and return null to trigger smart fallback
        return null;
      }
    }

    return null;
  }

  /**
   * Generate an understanding summary of the application
   */
  async summarizeCodebase(analysis) {
    const { routes = [], routeGroups = 0, endpoints = 0, middlewares = [], dbQueries = [] } = analysis;

    const prompt = `You are IBM Bob 2.0 adversarial security reasoning engine.
Analyze this application summary discovered by CodeStress:
- Route groups: ${routeGroups}
- Total endpoints: ${endpoints}
- Endpoints detail: ${JSON.stringify(routes.slice(0, 15), null, 2)}
- Middlewares: ${JSON.stringify(middlewares)}
- DB touchpoints: ${dbQueries.length}

Provide a concise 2-sentence adversarial understanding summary:
1. Identify the framework and key business logic (e.g. auth, data transfer, user management).
2. Highlight the most critical logic-level attack surfaces to investigate.`;

    const response = await this.chat([
      { role: 'system', content: 'You are IBM Bob 2.0, an adversarial security testing AI.' },
      { role: 'user', content: prompt }
    ]);

    if (response) {
      return response.trim();
    }

    // Heuristic summary fallback if API is not reachable
    const routeNames = routes.map(r => r.path).join(', ');
    return `Detected Node/Express application architecture with ${routeGroups} route groups (${routeNames || 'endpoints'}). Primary attack surfaces include parameter validation, authentication middleware verification, and database query sanitization.`;
  }
}

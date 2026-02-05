class OllamaProvider {
  constructor(config) {
    this.id = 'ollama';
    this.endpoint = config.endpoint || 'http://localhost:11434';
    this.model = config.model || 'qwen3:8b';
    this.type = 'local';
  }

  async generate(task, content, options = {}) {
    const prompt = this.buildPrompt(task, content, options.systemPrompt || '');
    const startTime = Date.now();
    try {
      const response = await fetch(this.endpoint + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: prompt,
          stream: false,
          options: { num_predict: options.maxTokens || 1024, temperature: options.temperature || 0.7 }
        })
      });
      if (!response.ok) throw new Error('Ollama error ' + response.status);
      const data = await response.json();
      return {
        success: true, provider: this.id, content: data.response,
        usage: { promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0, totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0) },
        timing: { totalMs: Date.now() - startTime }, cost: 0
      };
    } catch (error) {
      return { success: false, provider: this.id, error: error.message, timing: { totalMs: Date.now() - startTime } };
    }
  }

  async isAvailable() {
    try {
      const response = await fetch(this.endpoint + '/api/tags', { method: 'GET', signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch { return false; }
  }

  async listModels() {
    try {
      const response = await fetch(this.endpoint + '/api/tags');
      const data = await response.json();
      return data.models || [];
    } catch { return []; }
  }

  buildPrompt(task, content, systemPrompt) {
    let prompt = '';
    if (systemPrompt) prompt += systemPrompt + '\n\n';
    if (task) prompt += 'Task: ' + task + '\n\n';
    prompt += typeof content === 'string' ? content : JSON.stringify(content);
    return prompt;
  }

  getRateLimitStatus() { return { provider: this.id, unlimited: true }; }
}

module.exports = OllamaProvider;

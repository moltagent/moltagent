class DeepSeekProvider {
  constructor(config, credentialBroker) {
    this.id = 'deepseek';
    this.endpoint = config.endpoint || 'https://api.deepseek.com/v1/chat/completions';
    this.model = config.model || 'deepseek-chat';
    this.credentialName = config.credentialName || 'deepseek-api-key';
    this.credentialBroker = credentialBroker;
    this.type = 'api';
    this.inputCostPer1M = config.costModel?.inputPer1M || 0.14;
    this.outputCostPer1M = config.costModel?.outputPer1M || 0.28;
    this.rateLimits = { requestsRemaining: null, resetTime: null };
  }

  async generate(task, content, options = {}) {
    const messages = [
      { role: 'system', content: options.systemPrompt || 'You are a helpful assistant.' },
      { role: 'user', content: this.buildUserMessage(task, content) }
    ];
    const startTime = Date.now();
    try {
      const apiKey = await this.getApiKey();
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model: this.model, messages: messages, max_tokens: options.maxTokens || 1024, temperature: options.temperature || 0.7, stream: false })
      });
      if (response.status === 429) return { success: false, provider: this.id, error: 'rate_limit', isRateLimit: true };
      if (!response.ok) throw new Error('DeepSeek error ' + response.status);
      const data = await response.json();
      const usage = { promptTokens: data.usage?.prompt_tokens || 0, completionTokens: data.usage?.completion_tokens || 0, totalTokens: data.usage?.total_tokens || 0 };
      return {
        success: true, provider: this.id, content: data.choices?.[0]?.message?.content || '',
        usage: usage, timing: { totalMs: Date.now() - startTime },
        cost: (usage.promptTokens / 1000000) * this.inputCostPer1M + (usage.completionTokens / 1000000) * this.outputCostPer1M
      };
    } catch (error) {
      return { success: false, provider: this.id, error: error.message, timing: { totalMs: Date.now() - startTime } };
    }
  }

  async getApiKey() {
    if (this.credentialBroker) return await this.credentialBroker.get(this.credentialName);
    return process.env.DEEPSEEK_API_KEY;
  }

  buildUserMessage(task, content) {
    let msg = '';
    if (task) msg += 'Task: ' + task + '\n\n';
    msg += typeof content === 'string' ? content : JSON.stringify(content);
    return msg;
  }

  async isAvailable() { return true; }
  getRateLimitStatus() { return { provider: this.id, ...this.rateLimits }; }
}

module.exports = DeepSeekProvider;

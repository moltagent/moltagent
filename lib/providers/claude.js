class ClaudeProvider {
  constructor(config, credentialBroker) {
    this.id = 'claude';
    this.endpoint = config.endpoint || 'https://api.anthropic.com/v1/messages';
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.credentialName = config.credentialName || 'claude-api-key';
    this.credentialBroker = credentialBroker;
    this.type = 'api';
    this.inputCostPer1M = config.costModel?.inputPer1M || 3.00;
    this.outputCostPer1M = config.costModel?.outputPer1M || 15.00;
    this.rateLimits = { requestsRemaining: null, tokensRemaining: null, resetTime: null };
  }

  async generate(task, content, options = {}) {
    const messages = [{ role: 'user', content: this.buildUserMessage(task, content) }];
    const startTime = Date.now();
    try {
      const apiKey = await this.getApiKey();
      const body = { model: this.model, max_tokens: options.maxTokens || 1024, messages: messages };
      if (options.systemPrompt) body.system = options.systemPrompt;
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      if (response.status === 429) return { success: false, provider: this.id, error: 'rate_limit', isRateLimit: true };
      if (!response.ok) throw new Error('Claude error ' + response.status);
      const data = await response.json();
      const usage = { promptTokens: data.usage?.input_tokens || 0, completionTokens: data.usage?.output_tokens || 0, totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0) };
      const text = data.content?.filter(b => b.type === 'text')?.map(b => b.text)?.join('\n') || '';
      return {
        success: true, provider: this.id, content: text,
        usage: usage, timing: { totalMs: Date.now() - startTime },
        cost: (usage.promptTokens / 1000000) * this.inputCostPer1M + (usage.completionTokens / 1000000) * this.outputCostPer1M
      };
    } catch (error) {
      return { success: false, provider: this.id, error: error.message, timing: { totalMs: Date.now() - startTime } };
    }
  }

  async getApiKey() {
    if (this.credentialBroker) return await this.credentialBroker.get(this.credentialName);
    return process.env.ANTHROPIC_API_KEY;
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

module.exports = ClaudeProvider;

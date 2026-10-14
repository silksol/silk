// Optional cited answers from a hosted model. Silk only sends the top
// passages and the question; nothing else leaves the machine.
//   Anthropic: POST {ANTHROPIC_BASE_URL}/v1/messages
//   OpenAI:    POST {OPENAI_BASE_URL}/chat/completions

const DEFAULT_MODELS = { anthropic: 'claude-haiku-5-5', openai: 'gpt-4o-mini' };

/** Which provider `--llm` would use with this environment, or null. */
export function llmProvider(env = process.env) {
  const forced = (env.SILK_LLM_PROVIDER || '').toLowerCase();
  if (forced === 'anthropic' || forced === 'openai') {
    return (forced === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) ? forced : null;
  }
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return null;
}

export function buildPrompt(question, passages) {
  const sources = passages
    .map((p, i) => `[${i + 1}] ${p.title}${p.heading_path?.length ? ' > ' + p.heading_path.join(' > ') : ''}\nURL: ${p.url}\n${p.text}`)
    .join('\n\n');
  return {
    system:
      'You answer questions using only the numbered sources provided. Cite every claim with the source number in ' +
      'square brackets, like [1] or [2][3]. If the sources do not contain the answer, say so plainly. Be concise.',
    user: `Sources:\n\n${sources}\n\nQuestion: ${question}`,
  };
}

/**
 * Ask a hosted model to write a cited answer from the passages.
 * @returns {Promise<{ provider, model, text }>}
 */
export async function llmAnswer(question, passages, { env = process.env, fetch = globalThis.fetch, timeout = 60000 } = {}) {
  const provider = llmProvider(env);
  if (!provider) throw new Error('--llm needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment');
  const model = env.SILK_LLM_MODEL || DEFAULT_MODELS[provider];
  const { system, user } = buildPrompt(question, passages);
  const signal = AbortSignal.timeout(timeout);
  let res;
  if (provider === 'anthropic') {
    const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
    });
  } else {
    const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, max_tokens: 700, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${provider} API error ${res.status}: ${body.error?.message || res.statusText}`);
  const text = provider === 'anthropic'
    ? (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
    : body.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`${provider} API returned an empty answer`);
  return { provider, model, text: text.trim() };
}

// AI writing assist for the newsletter (NWS-07). Drafts short summaries and
// subject-line options from the collected source items only; the editor sees
// which text is machine-drafted until a person edits or accepts it.
// Without ANTHROPIC_API_KEY (or an `ant auth login` profile) the newsletter
// falls back to deterministic template text, which is not marked as AI.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const LANG_NAME = { hy: 'Armenian', en: 'English', ru: 'Russian' };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject_options', 'preheader', 'lead', 'block_summaries'],
  properties: {
    subject_options: { type: 'array', items: { type: 'string' } },
    preheader: { type: 'string' },
    lead: {
      type: 'object', additionalProperties: false, required: ['title', 'text'],
      properties: { title: { type: 'string' }, text: { type: 'string' } },
    },
    block_summaries: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['block_type', 'text'],
        properties: { block_type: { type: 'string' }, text: { type: 'string' } },
      },
    },
  },
};

const SYSTEM = `You draft the monthly email newsletter of an IT academy (Picsart Academy, Yerevan) for a human editor, who will review and edit it before anything is sent.
Rules:
- Use only facts present in the items you are given. Never invent numbers, names, dates, companies or quotes.
- Write in the requested language, in a warm, plain, concise voice. No emoji. No exclamation marks in subject lines.
- Subject lines: 3 options, each at most 60 characters.
- Preheader: one sentence, at most 90 characters.
- Lead: a short title and 2-3 sentences introducing the issue's main story, based on the highest-ranked item.
- One summary per block type you are given: 1-2 sentences that introduce the items in that block.`;

let client = null;
export function aiAvailable() {
  return !!(config.anthropicApiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.MH_AI_ENABLED === '1');
}

export async function draftNewsletterCopy({ language, blocks }) {
  if (!aiAvailable()) return null;
  client ||= new Anthropic(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {});
  const payload = blocks.map((b) => ({ block_type: b.type, items: b.items.map((i) => ({ title: i.title, details: i.summary || null, date: i.occurred_at || null })) }));
  const response = await client.beta.messages.create({
    model: config.anthropicModel,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `Language: ${LANG_NAME[language] || 'English'}\nItems collected since the last issue, grouped by block (highest ranked first):\n${JSON.stringify(payload, null, 2)}`,
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error(`AI assist declined${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`);
  if (response.stop_reason === 'max_tokens') throw new Error('AI assist response was cut off');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = JSON.parse(text);
  out.subject_options = (out.subject_options || []).slice(0, 3);
  return out;
}

export function describeAiError(error) {
  if (error instanceof Anthropic.AuthenticationError) return 'AI assist is not configured: the API key was rejected';
  if (error instanceof Anthropic.RateLimitError) return 'AI assist is rate limited; template text was used instead';
  if (error instanceof Anthropic.APIError) return `AI assist error ${error.status}; template text was used instead`;
  return `AI assist unavailable (${error.message}); template text was used instead`;
}

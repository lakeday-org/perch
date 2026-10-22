import { appliesToLanguage, compile, questionSet, questionsFor } from './ask.js';
import { excerpt, spanOf } from './questions.js';
import { sourceChunks } from './chunks.js';
import { estimateTokens, TOKEN_LIMITS, questionBatches, ContextLimitError } from './tokens.js';

export const isReviewQuestion = question => ['change', 'contracts'].includes(question.sees);

/** Route independent checks from source and available evidence, never another model score. */
export function reviewQuestions({ language, source, callers = [], callees = [], change, filters = [], rules = [] }) {
  return questionsFor([...questionSet().filter(q => !q.kind), ...rules].filter(q => isReviewQuestion(q) && appliesToLanguage(q, language)
    && (q.sees !== 'change' || change)
    && (q.name !== 'review_security' || /auth|tenant|permission|shell|exec|spawn|sql|query|token|path|buffer|memcpy|password|escape|render/i.test(source))
    && (q.name !== 'review_edge_case' || /\b(if|else|switch|case|match|when|null|nil|None|undefined|length|size|count|limit|index|offset|empty|zero)\b/.test(source))
    && (q.name !== 'review_caller_contract' || callers.length)
    && (q.name !== 'review_return_contract' || callers.length || callees.length)
    && (q.name !== 'review_cleanup' || /\b(await|throw|catch|finally|defer|dispose|close|release|delete|remove|rollback|commit|cancel)\b/i.test(source))
    && (q.name !== 'review_access_scope' || /auth|tenant|permission|owner|privilege|scope|session|credential/i.test(source))), filters);
}

/** The same two readings for every provider: current change, then contracts. */
export function reviewSteps({ node, lines, change, asked, callers = [], callees = [], budget = TOKEN_LIMITS.state }) {
  const steps = [], source = spanOf(node, lines).map(text => text ?? '').join('\n');
  const clip = source => source.slice(0, Math.max(32, Math.floor(budget / 4)));
  const changes = change && Object.fromEntries(Object.entries(change).map(([key, value]) => [key, { ...value, source: clip(value.source), partial: value.partial || clip(value.source) !== value.source }]));
  const evidence = [...callers.slice(0, 1).map(n => ({ ...n, role: 'caller' })), ...callees.slice(0, 1).map(n => ({ ...n, role: 'callee' }))]
    .map(n => { const source = excerpt(n.node, n.lines, 55, n.site ?? null); return { path: n.node.path, role: n.role, source: clip(source), partial: clip(source) !== source }; });
  for (const phase of ['change', 'contracts']) {
    const selected = asked.filter(q => phase === 'change' ? q.sees === 'change' : q.sees !== 'change');
    if (!selected.length) continue;
    const questions = compile(selected);
    for (const chunk of sourceChunks(source, { path: node.path, maxTokens: Math.max(128, Math.floor(budget / 3)) })) {
      const start = node.line + chunk.line - 1;
      const state = { target: { path: node.path, name: node.qualified_name, source: chunk.source, start_line: start },
        ...(phase === 'change' ? { change: changes } : { evidence }),
        reading: { start_byte: chunk.startByte, end_byte: chunk.endByte, partial: chunk.startByte !== 0 || chunk.endByte < Buffer.byteLength(source) } };
      if (estimateTokens(state) > budget) throw new ContextLimitError(`${node.path}: ${phase} context exceeds the token budget`, budget / 2);
      questionBatches(state, questions);
      steps.push({ state, questions, asked: selected, calls: [], calledBy: [], neighbors: [], covers: { line: start, end_line: start + chunk.source.split('\n').length - 1 } });
    }
  }
  return steps;
}

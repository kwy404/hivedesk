// The commands of the domains (registered next to the library's, src/index.js):
//   crew.answer     { questionId, answers?, decide? }   answer the open question card (or "Decide for me")
//   crew.questions  {}                                   the open cards (a desktop that reconnects, the voice orb)
//   crew.match      { questionId, question, text }       what a spoken or typed answer picks ("the second one")
//   security.audit  {}                                   a read only audit of the workspace, nothing is written
// Guests cannot use any of them (src/collab/policy.js allows only its own list).
import { answerQuestion, openQuestions } from './flow.js';
import { matchSpoken } from './questions.js';
import { auditProject } from './security/scan.js';
import { redact } from './security/fixes.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function attachDomains({ hive, server }) {
  if (!server?.command || !hive) return;
  server.command('crew.answer', (d) => {
    if (typeof d.questionId !== 'string' || !d.questionId) fail('bad_request', 'questionId is required');
    if (d.answers !== undefined && (typeof d.answers !== 'object' || Array.isArray(d.answers) || d.answers === null)) fail('bad_request', 'answers must be an object');
    return answerQuestion(hive, d.questionId, { answers: d.answers || {}, decide: d.decide === true });
  });
  server.command('crew.questions', () => ({ questions: openQuestions(hive) }));
  server.command('crew.match', (d) => {
    const card = openQuestions(hive).find((c) => c.id === d.questionId);
    if (!card) fail('not_found', 'that question is no longer open');
    const q = card.questions.find((x) => x.id === d.question) || card.questions[0];
    return { question: q.id, match: matchSpoken(q, String(d.text || '').slice(0, 400)) };
  });
  server.command('security.audit', () => {
    const r = auditProject({ root: hive.toolbox.ws.root });
    return { ...r, findings: r.findings.map((f) => ({ id: f.id, severity: f.severity, category: f.category, title: f.title, file: f.file, line: f.line, snippet: redact(f.snippet || ''), fix: f.fix })) };
  });
}

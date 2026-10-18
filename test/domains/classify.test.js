import { describe, it, expect } from 'vitest';
import { classifyDomain, decideDomain, detectDomain, reasonOf, DOMAIN_SCHEMA } from '../../src/crew/domains/classify.js';
import { reasonText } from '../../src/crew/domains/flow.js';
import { DOMAINS, DOMAIN_IDS, domainNotes } from '../../src/crew/domains/index.js';
import { topicOf } from '../../src/crew/talk.js';
import { validate } from '../../src/brain/schema.js';

const CASES = [
  ['crie um app de receitas para celular', 'mobile'],
  ['Build me a recipe app that works on phones', 'mobile'],
  ['um aplicativo android para controlar meus gastos', 'mobile'],
  ['make an iOS app with Capacitor for my gym', 'mobile'],
  ['faca um programa para windows que organiza fotos', 'desktop'],
  ['a desktop app to rename my photos', 'desktop'],
  ['create a REST API for a todo list with users', 'backend'],
  ['crie uma api rest com rotas de produtos e banco de dados', 'backend'],
  ['write a CLI that renames files', 'cli'],
  ['uma ferramenta de linha de comando para converter imagens', 'cli'],
  ['build a chrome extension that hides ads', 'extension'],
  ['crie uma extensao do chrome que salva notas por site', 'extension'],
  ['make a platformer game with three levels', 'game'],
  ['um jogo da cobrinha com pontuacao', 'game'],
  ['parse this csv and make a report of sales per month', 'data'],
  ['um script que le uma planilha csv e soma os gastos', 'data'],
  ['audit my project for leaked keys and vulnerabilities', 'security'],
  ['faca uma auditoria de seguranca no projeto', 'security'],
  ['write a Dockerfile and a CI pipeline for my node service', 'devops'],
  ['crie um site para minha padaria', 'web'],
  ['a landing page for my coffee shop', 'web']
];

describe('the domain classifier', () => {
  for (const [text, want] of CASES) {
    it(`"${text}" is ${want}`, () => {
      expect(classifyDomain(text).domain).toBe(want);
    });
  }

  it('questions and small talk are chat, with the field they are about', () => {
    expect(classifyDomain('what is a service worker?').domain).toBe('chat');
    expect(classifyDomain('oi, tudo bem?').domain).toBe('chat');
    expect(classifyDomain('how do I sign an android apk?').topic).toBe('mobile');
    expect(topicOf('what is SQL injection?')).toBe('security');
    expect(topicOf('como faço deploy com docker?')).toBe('devops');
    expect(topicOf('oi tudo bem?')).toBe(null);
  });

  it('one weak word does not change the kind of project, and the workspace files count', () => {
    expect(classifyDomain('run a script').domain).toBe('web');
    expect(classifyDomain('add a settings screen', { files: ['capacitor.config.json', 'www/index.html'] }).domain).toBe('mobile');
    expect(classifyDomain('add an options page', { files: ['manifest.json'], manifest: { manifest_version: 3 } }).domain).toBe('extension');
    const c = classifyDomain('add a dark theme', { files: ['neutralino.config.json'] });
    expect(c.domain).toBe('desktop');
    expect(c.files).toContain('neutralino.config.json');
  });

  it('an API for a phone app is a backend, a phone game is a game', () => {
    expect(classifyDomain('create a backend api for my mobile app').domain).toBe('backend');
    expect(classifyDomain('a snake game for phones').domain).toBe('game');
  });

  it('confident keywords win, a confident model settles a doubt, the schema is strict', () => {
    const kw = classifyDomain('write a CLI that renames files');
    expect(kw.confidence).toBe('high');
    expect(decideDomain({ domain: 'web', confidence: 'high' }, kw).domain).toBe('cli');
    const doubt = { domain: 'web', confidence: 'low', score: 3, scores: { web: 3, data: 3 }, words: ['report'], files: [] };
    expect(decideDomain({ domain: 'data', confidence: 'high' }, doubt)).toMatchObject({ domain: 'data', source: 'model' });
    expect(decideDomain({ domain: 'nope', confidence: 'high' }, doubt).domain).toBe('web');
    expect(validate(DOMAIN_SCHEMA, { domain: 'mobile', confidence: 'high' })).toEqual([]);
    expect(validate(DOMAIN_SCHEMA, { domain: 'chat', confidence: 'high' }).length).toBeGreaterThan(0);
  });

  it('asks the model only when the keywords saw two kinds and are not sure', async () => {
    let asked = 0;
    const ask = async () => { asked++; return { domain: 'data', confidence: 'high' }; };
    await detectDomain({ text: 'write a CLI that renames files', ask });
    await detectDomain({ text: 'a page', ask });
    expect(asked).toBe(0);
    const r = await detectDomain({ text: 'an api that reads csv files', ask });
    expect(asked).toBe(1);
    expect(DOMAIN_IDS).toContain(r.domain);
  });

  it('says why, in the user words, and every domain has a label, a stack and notes', () => {
    const c = classifyDomain('crie um app de receitas para celular');
    expect(reasonOf(c).kind).toBe('words');
    const r = reasonText('en', c);
    expect(r.text).toMatch(/^Mobile app: an installable PWA with a Capacitor config for Android and iOS, because the request mentions "/);
    expect(reasonText('en', { domain: 'cli', source: 'answer' }).why).toBe('you picked it');
    for (const id of DOMAIN_IDS) {
      expect(DOMAINS[id].label.length).toBeGreaterThan(2);
      expect(DOMAINS[id].stack.length).toBeGreaterThan(5);
    }
    expect(domainNotes('mobile', { skeleton: ['www/index.html'] }).join('\n')).toMatch(/skeleton[\s\S]*mobile/);
    expect(domainNotes('web')).toEqual([]);
  });
});

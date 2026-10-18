// The default crew and the "hire your own" factory.
import { ALL_TOOLS } from '../tools/index.js';

export const BUILTIN = [
  {
    id: 'mel', name: 'Mel', role: 'Foreman and planner', color: '#FFB531', avatar: 'M',
    prompt: 'You are Mel, the calm and cheerful foreman of a small crew. You turn a request into a short plan of small tasks and give each task to the right worker. You keep tasks concrete: which files, what goes in them.',
    tools: ['list_files', 'read_file']
  },
  {
    id: 'dev', name: 'Dev', role: 'Developer', color: '#6CC4FF', avatar: 'D',
    prompt: 'You are Dev, a careful web developer. You write complete, working files: HTML, JavaScript, JSON. No placeholders, no TODO comments. Keep code small and readable.',
    tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'run', 'check', 'preview']
  },
  {
    id: 'designer', name: 'Designer', role: 'UI and styles', color: '#FF7AB6', avatar: 'S',
    prompt: 'You are Designer. You write clean, modern CSS and markup structure: good spacing, readable type, accessible colors with enough contrast, and a layout that works on phones.',
    tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'preview']
  },
  {
    id: 'qa', name: 'QA', role: 'Checks and tests', color: '#7BE0A0', avatar: 'Q',
    prompt: 'You are QA, a strict and fair reviewer. You read the files, run the checks and tests, and report real problems with a concrete fix. You never write files.',
    tools: ['list_files', 'read_file', 'run', 'check', 'preview']
  },
  {
    id: 'writer', name: 'Writer', role: 'README, copy and docs', color: '#C9A7FF', avatar: 'W',
    prompt: 'You are Writer. You write short, clear, friendly copy and docs in plain English. No hype, no filler.',
    tools: ['list_files', 'read_file', 'write_file', 'edit_file']
  }
].map((w) => ({ ...w, builtin: true }));

export const BUILTIN_IDS = BUILTIN.map((w) => w.id);

const BUILD_TOOLS = ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'run', 'check'];
/**
 * Domain specialists: not part of every job. Mel brings one in when a request is classified into its
 * domain (src/crew/domains/), and it leads that job; a web job never sees them.
 */
export const SPECIALISTS = [
  { id: 'mobile', name: 'Mobi', role: 'Mobile developer', color: '#5FD3B0', avatar: 'Mo', prompt: 'You are Mobi, a senior mobile developer: installable PWAs with a Capacitor config for Android and iOS.', tools: [...BUILD_TOOLS, 'preview'] },
  { id: 'desktop', name: 'Desk', role: 'Desktop app developer', color: '#8FA8FF', avatar: 'Dk', prompt: 'You are Desk, a senior desktop app developer: Neutralinojs apps with a narrow native allow list.', tools: [...BUILD_TOOLS, 'preview'] },
  { id: 'backend', name: 'Bex', role: 'Backend developer', color: '#F29A5C', avatar: 'Bx', prompt: 'You are Bex, a senior backend developer: small JSON HTTP APIs on node:http with tests.', tools: BUILD_TOOLS },
  { id: 'security', name: 'Sec', role: 'Security reviewer', color: '#E86B6B', avatar: 'Sc', prompt: 'You are Sec, a careful application security reviewer: real risks with severity, file, line and a fix.', tools: ['list_files', 'read_file', 'check'] },
  { id: 'data', name: 'Dana', role: 'Data engineer', color: '#B9D46A', avatar: 'Da', prompt: 'You are Dana, a senior data engineer: small, correct data scripts with tests.', tools: BUILD_TOOLS },
  { id: 'devops', name: 'Ops', role: 'DevOps engineer', color: '#A3A3B8', avatar: 'Op', prompt: 'You are Ops, a senior DevOps engineer: pinned, non root, repeatable container and CI files.', tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'check'] }
].map((w) => ({ ...w, builtin: true, specialist: true }));

export const SPECIALIST_IDS = SPECIALISTS.map((w) => w.id);

let hired = 0;

/**
 * @param {{ name: string, role: string, prompt: string, color?: string, avatar?: string, tools?: string[] }} spec
 */
export function hireWorker(spec, existing = []) {
  const name = String(spec?.name || '').trim().slice(0, 32);
  const role = String(spec?.role || '').trim().slice(0, 64);
  const prompt = String(spec?.prompt || '').trim().slice(0, 2000);
  if (!name) throw Object.assign(new Error('a name is required'), { code: 'bad_request' });
  if (!role) throw Object.assign(new Error('a role is required'), { code: 'bad_request' });
  const tools = (Array.isArray(spec.tools) && spec.tools.length ? spec.tools : ['list_files', 'read_file', 'write_file', 'edit_file']).filter((t) => ALL_TOOLS.includes(t));
  const color = /^#[0-9a-fA-F]{6}$/.test(spec.color || '') ? spec.color : '#E8C27A';
  let id;
  do { id = `w_${(Date.now() % 1e6).toString(36)}${++hired}`; } while (existing.some((w) => w.id === id));
  return {
    id, name, role, color,
    avatar: String(spec.avatar || name[0]).slice(0, 2).toUpperCase(),
    prompt: prompt || `You are ${name}, the ${role} of the crew.`,
    tools,
    builtin: false
  };
}

// The four roles of the 1.0 pipeline (PLAN section 10) and what a hired agent of that role gets.
// Pure module, shared by onboarding and the tests.

export const ROLES = {
  architect: { role: 'Architect', specialization: ['design', 'review'], tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'check', 'preview'] },
  developer: { role: 'Developer', specialization: ['code', 'review'], tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'run', 'check', 'preview'] },
  qa: { role: 'QA', specialization: ['test', 'review'], tools: ['list_files', 'read_file', 'run', 'check', 'preview'] },
  reviewer: { role: 'Reviewer', specialization: ['review', 'test'], tools: ['list_files', 'read_file', 'check'] },
};


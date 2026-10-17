// Wizard strings in English and Portuguese.

export const STRINGS = {
  en: {
    welcome: 'A crew of AI workers that plan, talk and build real files on your machine, with a local model.',
    pressEnter: 'Press Enter to start. Arrows move, Space ticks, Enter confirms, Ctrl+C quits.',
    lang: 'Language',
    folder: 'Project folder (files go to <folder>/.hivedesk/)',
    folderHere: 'This folder',
    folderOther: 'Another folder...',
    folderPath: 'Folder path',
    hardware: 'Your machine',
    noGpu: 'no usable GPU',
    brain: 'Which brain should the crew use?',
    recommended: 'recommended',
    downloaded: 'downloaded',
    download: 'download',
    otherSize: 'other size',
    ollama: 'Ollama (running on this machine)',
    lmstudio: 'LM Studio (running on this machine)',
    key: 'An OpenAI compatible endpoint with a key',
    demo: 'Demo mode: no model, a scripted crew to look around',
    keyUrl: 'Endpoint base URL',
    keyModel: 'Model name at that endpoint',
    keySecret: 'API key (hidden, saved only on this machine)',
    confirmDownload: 'Download it now?',
    size: 'Size',
    source: 'Source',
    destination: 'Saved to',
    mode: 'How should the crew work?',
    modeApprove: 'Approve each risky step (commands, deletes, changes to existing files)',
    modeAuto: 'Automatic: the crew acts without asking',
    crew: 'Crew',
    crewDefault: 'The default crew: Mel, Dev, Designer, QA, Writer',
    crewPick: 'Pick the roles...',
    crewRoles: 'Roles (Mel always plans)',
    summary: 'Summary',
    openBrowser: 'Open hivedesk now?',
    openApp: 'Open as an app (its own window)?',
    reuse: 'Use the same setup as last time?',
    yes: 'Y/n',
    no: 'y/N',
    required: 'This one is needed.',
    warning: 'Note'
  },
  pt: {
    welcome: 'Uma equipe de agentes de IA que planejam, conversam e criam arquivos de verdade no seu computador, com um modelo local.',
    pressEnter: 'Aperte Enter para começar. Setas movem, Espaço marca, Enter confirma, Ctrl+C sai.',
    lang: 'Idioma',
    folder: 'Pasta do projeto (os arquivos vão para <pasta>/.hivedesk/)',
    folderHere: 'Esta pasta',
    folderOther: 'Outra pasta...',
    folderPath: 'Caminho da pasta',
    hardware: 'Seu computador',
    noGpu: 'sem placa de vídeo utilizável',
    brain: 'Qual cérebro a equipe deve usar?',
    recommended: 'recomendado',
    downloaded: 'já baixado',
    download: 'download',
    otherSize: 'outro tamanho',
    ollama: 'Ollama (rodando neste computador)',
    lmstudio: 'LM Studio (rodando neste computador)',
    key: 'Um endpoint compatível com OpenAI, com chave',
    demo: 'Modo demo: sem modelo, uma equipe com roteiro para conhecer',
    keyUrl: 'URL base do endpoint',
    keyModel: 'Nome do modelo nesse endpoint',
    keySecret: 'Chave de API (oculta, salva só neste computador)',
    confirmDownload: 'Baixar agora?',
    size: 'Tamanho',
    source: 'Origem',
    destination: 'Salvo em',
    mode: 'Como a equipe deve trabalhar?',
    modeApprove: 'Aprovar cada passo arriscado (comandos, exclusões, mudanças em arquivos existentes)',
    modeAuto: 'Automático: a equipe age sem perguntar',
    crew: 'Equipe',
    crewDefault: 'A equipe padrão: Mel, Dev, Designer, QA, Writer',
    crewPick: 'Escolher os papéis...',
    crewRoles: 'Papéis (Mel sempre planeja)',
    summary: 'Resumo',
    openBrowser: 'Abrir o hivedesk agora?',
    openApp: 'Abrir como app (janela própria)?',
    reuse: 'Usar a mesma configuração da última vez?',
    yes: 'S/n',
    no: 's/N',
    required: 'Este campo é necessário.',
    warning: 'Aviso'
  }
};

/** "pt" when the OS locale is Portuguese, otherwise "en". */
export function detectLang(env = process.env) {
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || '';
  let locale = fromEnv;
  if (!locale) {
    try { locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { locale = ''; }
  }
  return /^pt/i.test(locale) ? 'pt' : 'en';
}

export function t(lang) {
  return STRINGS[lang] || STRINGS.en;
}

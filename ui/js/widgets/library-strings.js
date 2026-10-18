// Strings of the prompt library windows (Library, and "Playbooks used" in Brief and report). The shared
// tables in i18n/<locale>.json win when they carry a library.* key; until then the tables below are used.

import { t, has, locale } from '../i18n.js';
import { format } from '/i18n/index.js';

const TABLES = {
  en: {
    'library.title': 'Library', 'library.dock': 'Prompt library', 'library.search': 'Search the library',
    'library.allCategories': 'All categories', 'library.favoritesOnly': 'Favorites only',
    'library.count': '{count, plural, one {# entry} other {# entries}}', 'library.favorite': 'Favorite', 'library.unfavorite': 'Remove favorite',
    'library.add': 'Add your own', 'library.back': 'Back', 'library.when': 'When to use', 'library.inputs': 'Inputs',
    'library.prompt': 'Instructions', 'library.checks': 'Automatic checks', 'library.example': 'Example', 'library.roles': 'Used by',
    'library.tokens': '{count} tokens', 'library.yours': 'Yours', 'library.remove': 'Remove', 'library.empty': 'Nothing matches',
    'library.form.title': 'Title', 'library.form.category': 'Category', 'library.form.roles': 'Workers who use it', 'library.form.tags': 'Tags, separated by commas',
    'library.form.when': 'When should the crew use it?', 'library.form.prompt': 'Instructions with Goal, Steps, Quality bar, Pitfalls, Verify and Output',
    'library.form.save': 'Save to the library', 'library.saved': 'Saved in ~/.hivedesk/library', 'library.error.save': 'Could not save the entry',
    'library.error.load': 'Could not load the library', 'library.used': 'Playbooks used', 'library.planned': 'Picked for this job',
    'library.swap': 'Swap', 'library.swapFor': 'Swap {title} for', 'library.swapped': 'Playbook swapped', 'library.locked': 'The task has started',
    'library.why': 'score {score}: {terms}', 'library.none': 'No playbook for this task', 'library.cancel': 'Cancel', 'library.open': 'Open in the library',
    'library.addTo': 'Add a playbook'
  },
  'pt-BR': {
    'library.title': 'Biblioteca', 'library.dock': 'Biblioteca de prompts', 'library.search': 'Buscar na biblioteca',
    'library.allCategories': 'Todas as categorias', 'library.favoritesOnly': 'Só favoritos',
    'library.count': '{count, plural, one {# item} other {# itens}}', 'library.favorite': 'Favoritar', 'library.unfavorite': 'Tirar dos favoritos',
    'library.add': 'Adicionar o seu', 'library.back': 'Voltar', 'library.when': 'Quando usar', 'library.inputs': 'Entradas',
    'library.prompt': 'Instruções', 'library.checks': 'Verificações automáticas', 'library.example': 'Exemplo', 'library.roles': 'Usado por',
    'library.tokens': '{count} tokens', 'library.yours': 'Seu', 'library.remove': 'Remover', 'library.empty': 'Nada encontrado',
    'library.form.title': 'Título', 'library.form.category': 'Categoria', 'library.form.roles': 'Quem usa', 'library.form.tags': 'Tags, separadas por vírgula',
    'library.form.when': 'Quando a equipe deve usar?', 'library.form.prompt': 'Instruções com Goal, Steps, Quality bar, Pitfalls, Verify e Output',
    'library.form.save': 'Salvar na biblioteca', 'library.saved': 'Salvo em ~/.hivedesk/library', 'library.error.save': 'Não foi possível salvar',
    'library.error.load': 'Não foi possível carregar a biblioteca', 'library.used': 'Playbooks usados', 'library.planned': 'Escolhidos para este trabalho',
    'library.swap': 'Trocar', 'library.swapFor': 'Trocar {title} por', 'library.swapped': 'Playbook trocado', 'library.locked': 'A tarefa já começou',
    'library.why': 'pontuação {score}: {terms}', 'library.none': 'Nenhum playbook para esta tarefa', 'library.cancel': 'Cancelar', 'library.open': 'Abrir na biblioteca',
    'library.addTo': 'Adicionar um playbook'
  },
  es: {
    'library.title': 'Biblioteca', 'library.dock': 'Biblioteca de prompts', 'library.search': 'Buscar en la biblioteca',
    'library.allCategories': 'Todas las categorías', 'library.favoritesOnly': 'Solo favoritos',
    'library.count': '{count, plural, one {# entrada} other {# entradas}}', 'library.favorite': 'Favorito', 'library.unfavorite': 'Quitar de favoritos',
    'library.add': 'Añadir el tuyo', 'library.back': 'Volver', 'library.when': 'Cuándo usarlo', 'library.inputs': 'Entradas',
    'library.prompt': 'Instrucciones', 'library.checks': 'Comprobaciones automáticas', 'library.example': 'Ejemplo', 'library.roles': 'Lo usan',
    'library.tokens': '{count} tokens', 'library.yours': 'Tuyo', 'library.remove': 'Quitar', 'library.empty': 'Nada coincide',
    'library.form.title': 'Título', 'library.form.category': 'Categoría', 'library.form.roles': 'Quién lo usa', 'library.form.tags': 'Etiquetas, separadas por comas',
    'library.form.when': '¿Cuándo debe usarlo el equipo?', 'library.form.prompt': 'Instrucciones con Goal, Steps, Quality bar, Pitfalls, Verify y Output',
    'library.form.save': 'Guardar en la biblioteca', 'library.saved': 'Guardado en ~/.hivedesk/library', 'library.error.save': 'No se pudo guardar',
    'library.error.load': 'No se pudo cargar la biblioteca', 'library.used': 'Playbooks usados', 'library.planned': 'Elegidos para este trabajo',
    'library.swap': 'Cambiar', 'library.swapFor': 'Cambiar {title} por', 'library.swapped': 'Playbook cambiado', 'library.locked': 'La tarea ya empezó',
    'library.why': 'puntuación {score}: {terms}', 'library.none': 'Ningún playbook para esta tarea', 'library.cancel': 'Cancelar', 'library.open': 'Abrir en la biblioteca',
    'library.addTo': 'Añadir un playbook'
  },
  fr: {
    'library.title': 'Bibliothèque', 'library.dock': 'Bibliothèque de prompts', 'library.search': 'Chercher dans la bibliothèque',
    'library.allCategories': 'Toutes les catégories', 'library.favoritesOnly': 'Favoris seulement',
    'library.count': '{count, plural, one {# entrée} other {# entrées}}', 'library.favorite': 'Favori', 'library.unfavorite': 'Retirer des favoris',
    'library.add': 'Ajouter le vôtre', 'library.back': 'Retour', 'library.when': 'Quand l’utiliser', 'library.inputs': 'Entrées',
    'library.prompt': 'Instructions', 'library.checks': 'Vérifications automatiques', 'library.example': 'Exemple', 'library.roles': 'Utilisé par',
    'library.tokens': '{count} jetons', 'library.yours': 'À vous', 'library.remove': 'Retirer', 'library.empty': 'Aucun résultat',
    'library.form.title': 'Titre', 'library.form.category': 'Catégorie', 'library.form.roles': 'Qui l’utilise', 'library.form.tags': 'Étiquettes, séparées par des virgules',
    'library.form.when': 'Quand l’équipe doit-elle l’utiliser ?', 'library.form.prompt': 'Instructions avec Goal, Steps, Quality bar, Pitfalls, Verify et Output',
    'library.form.save': 'Enregistrer dans la bibliothèque', 'library.saved': 'Enregistré dans ~/.hivedesk/library', 'library.error.save': 'Enregistrement impossible',
    'library.error.load': 'Impossible de charger la bibliothèque', 'library.used': 'Playbooks utilisés', 'library.planned': 'Choisis pour ce travail',
    'library.swap': 'Changer', 'library.swapFor': 'Remplacer {title} par', 'library.swapped': 'Playbook remplacé', 'library.locked': 'La tâche a commencé',
    'library.why': 'score {score} : {terms}', 'library.none': 'Aucun playbook pour cette tâche', 'library.cancel': 'Annuler', 'library.open': 'Ouvrir dans la bibliothèque',
    'library.addTo': 'Ajouter un playbook'
  },
  de: {
    'library.title': 'Bibliothek', 'library.dock': 'Prompt-Bibliothek', 'library.search': 'Bibliothek durchsuchen',
    'library.allCategories': 'Alle Kategorien', 'library.favoritesOnly': 'Nur Favoriten',
    'library.count': '{count, plural, one {# Eintrag} other {# Einträge}}', 'library.favorite': 'Favorit', 'library.unfavorite': 'Aus Favoriten entfernen',
    'library.add': 'Eigenen hinzufügen', 'library.back': 'Zurück', 'library.when': 'Wann verwenden', 'library.inputs': 'Eingaben',
    'library.prompt': 'Anleitung', 'library.checks': 'Automatische Prüfungen', 'library.example': 'Beispiel', 'library.roles': 'Genutzt von',
    'library.tokens': '{count} Tokens', 'library.yours': 'Eigener', 'library.remove': 'Entfernen', 'library.empty': 'Keine Treffer',
    'library.form.title': 'Titel', 'library.form.category': 'Kategorie', 'library.form.roles': 'Wer es nutzt', 'library.form.tags': 'Schlagwörter, durch Kommas getrennt',
    'library.form.when': 'Wann soll die Crew es nutzen?', 'library.form.prompt': 'Anleitung mit Goal, Steps, Quality bar, Pitfalls, Verify und Output',
    'library.form.save': 'In der Bibliothek speichern', 'library.saved': 'Gespeichert in ~/.hivedesk/library', 'library.error.save': 'Speichern fehlgeschlagen',
    'library.error.load': 'Bibliothek konnte nicht geladen werden', 'library.used': 'Verwendete Playbooks', 'library.planned': 'Für diesen Auftrag gewählt',
    'library.swap': 'Tauschen', 'library.swapFor': '{title} tauschen gegen', 'library.swapped': 'Playbook getauscht', 'library.locked': 'Die Aufgabe hat begonnen',
    'library.why': 'Wert {score}: {terms}', 'library.none': 'Kein Playbook für diese Aufgabe', 'library.cancel': 'Abbrechen', 'library.open': 'In der Bibliothek öffnen',
    'library.addTo': 'Playbook hinzufügen'
  },
  it: {
    'library.title': 'Libreria', 'library.dock': 'Libreria di prompt', 'library.search': 'Cerca nella libreria',
    'library.allCategories': 'Tutte le categorie', 'library.favoritesOnly': 'Solo preferiti',
    'library.count': '{count, plural, one {# voce} other {# voci}}', 'library.favorite': 'Preferito', 'library.unfavorite': 'Togli dai preferiti',
    'library.add': 'Aggiungi il tuo', 'library.back': 'Indietro', 'library.when': 'Quando usarlo', 'library.inputs': 'Input',
    'library.prompt': 'Istruzioni', 'library.checks': 'Controlli automatici', 'library.example': 'Esempio', 'library.roles': 'Usato da',
    'library.tokens': '{count} token', 'library.yours': 'Tuo', 'library.remove': 'Rimuovi', 'library.empty': 'Nessun risultato',
    'library.form.title': 'Titolo', 'library.form.category': 'Categoria', 'library.form.roles': 'Chi lo usa', 'library.form.tags': 'Tag, separati da virgole',
    'library.form.when': 'Quando deve usarlo la squadra?', 'library.form.prompt': 'Istruzioni con Goal, Steps, Quality bar, Pitfalls, Verify e Output',
    'library.form.save': 'Salva nella libreria', 'library.saved': 'Salvato in ~/.hivedesk/library', 'library.error.save': 'Impossibile salvare',
    'library.error.load': 'Impossibile caricare la libreria', 'library.used': 'Playbook usati', 'library.planned': 'Scelti per questo lavoro',
    'library.swap': 'Cambia', 'library.swapFor': 'Sostituisci {title} con', 'library.swapped': 'Playbook sostituito', 'library.locked': 'Il compito è iniziato',
    'library.why': 'punteggio {score}: {terms}', 'library.none': 'Nessun playbook per questo compito', 'library.cancel': 'Annulla', 'library.open': 'Apri nella libreria',
    'library.addTo': 'Aggiungi un playbook'
  },
  ja: {
    'library.title': 'ライブラリ', 'library.dock': 'プロンプトライブラリ', 'library.search': 'ライブラリを検索',
    'library.allCategories': 'すべてのカテゴリ', 'library.favoritesOnly': 'お気に入りのみ',
    'library.count': '{count} 件', 'library.favorite': 'お気に入り', 'library.unfavorite': 'お気に入りから外す',
    'library.add': '自分のものを追加', 'library.back': '戻る', 'library.when': '使う場面', 'library.inputs': '入力',
    'library.prompt': '手順', 'library.checks': '自動チェック', 'library.example': '例', 'library.roles': '使う人',
    'library.tokens': '{count} トークン', 'library.yours': '自分用', 'library.remove': '削除', 'library.empty': '一致するものがありません',
    'library.form.title': 'タイトル', 'library.form.category': 'カテゴリ', 'library.form.roles': '使うワーカー', 'library.form.tags': 'タグ (カンマ区切り)',
    'library.form.when': 'クルーはいつ使うべきですか?', 'library.form.prompt': 'Goal, Steps, Quality bar, Pitfalls, Verify, Output を含む手順',
    'library.form.save': 'ライブラリに保存', 'library.saved': '~/.hivedesk/library に保存しました', 'library.error.save': '保存できませんでした',
    'library.error.load': 'ライブラリを読み込めませんでした', 'library.used': '使ったプレイブック', 'library.planned': 'このジョブ用に選択',
    'library.swap': '入れ替え', 'library.swapFor': '{title} を入れ替え', 'library.swapped': 'プレイブックを入れ替えました', 'library.locked': 'タスクは開始済みです',
    'library.why': 'スコア {score}: {terms}', 'library.none': 'このタスクのプレイブックはありません', 'library.cancel': 'キャンセル', 'library.open': 'ライブラリで開く',
    'library.addTo': 'プレイブックを追加'
  },
  ko: {
    'library.title': '라이브러리', 'library.dock': '프롬프트 라이브러리', 'library.search': '라이브러리 검색',
    'library.allCategories': '모든 카테고리', 'library.favoritesOnly': '즐겨찾기만',
    'library.count': '{count}개 항목', 'library.favorite': '즐겨찾기', 'library.unfavorite': '즐겨찾기 해제',
    'library.add': '직접 추가', 'library.back': '뒤로', 'library.when': '사용 시점', 'library.inputs': '입력',
    'library.prompt': '지침', 'library.checks': '자동 검사', 'library.example': '예시', 'library.roles': '사용하는 역할',
    'library.tokens': '{count} 토큰', 'library.yours': '내 항목', 'library.remove': '삭제', 'library.empty': '일치하는 항목이 없습니다',
    'library.form.title': '제목', 'library.form.category': '카테고리', 'library.form.roles': '사용하는 작업자', 'library.form.tags': '태그 (쉼표로 구분)',
    'library.form.when': '크루가 언제 사용해야 하나요?', 'library.form.prompt': 'Goal, Steps, Quality bar, Pitfalls, Verify, Output을 포함한 지침',
    'library.form.save': '라이브러리에 저장', 'library.saved': '~/.hivedesk/library에 저장됨', 'library.error.save': '저장할 수 없습니다',
    'library.error.load': '라이브러리를 불러올 수 없습니다', 'library.used': '사용한 플레이북', 'library.planned': '이 작업을 위해 선택됨',
    'library.swap': '바꾸기', 'library.swapFor': '{title} 바꾸기', 'library.swapped': '플레이북을 바꿨습니다', 'library.locked': '작업이 이미 시작되었습니다',
    'library.why': '점수 {score}: {terms}', 'library.none': '이 작업의 플레이북이 없습니다', 'library.cancel': '취소', 'library.open': '라이브러리에서 열기',
    'library.addTo': '플레이북 추가'
  },
  'zh-CN': {
    'library.title': '资料库', 'library.dock': '提示词资料库', 'library.search': '搜索资料库',
    'library.allCategories': '全部类别', 'library.favoritesOnly': '仅收藏',
    'library.count': '{count} 条', 'library.favorite': '收藏', 'library.unfavorite': '取消收藏',
    'library.add': '添加自己的', 'library.back': '返回', 'library.when': '使用时机', 'library.inputs': '输入',
    'library.prompt': '说明', 'library.checks': '自动检查', 'library.example': '示例', 'library.roles': '使用者',
    'library.tokens': '{count} 个令牌', 'library.yours': '我的', 'library.remove': '删除', 'library.empty': '没有匹配项',
    'library.form.title': '标题', 'library.form.category': '类别', 'library.form.roles': '使用的成员', 'library.form.tags': '标签,用逗号分隔',
    'library.form.when': '团队应在何时使用?', 'library.form.prompt': '包含 Goal、Steps、Quality bar、Pitfalls、Verify 和 Output 的说明',
    'library.form.save': '保存到资料库', 'library.saved': '已保存到 ~/.hivedesk/library', 'library.error.save': '无法保存',
    'library.error.load': '无法加载资料库', 'library.used': '使用的剧本', 'library.planned': '为此任务选择',
    'library.swap': '替换', 'library.swapFor': '将 {title} 替换为', 'library.swapped': '剧本已替换', 'library.locked': '任务已开始',
    'library.why': '得分 {score}: {terms}', 'library.none': '此任务没有剧本', 'library.cancel': '取消', 'library.open': '在资料库中打开',
    'library.addTo': '添加剧本'
  },
  ru: {
    'library.title': 'Библиотека', 'library.dock': 'Библиотека промптов', 'library.search': 'Поиск в библиотеке',
    'library.allCategories': 'Все категории', 'library.favoritesOnly': 'Только избранное',
    'library.count': '{count, plural, one {# запись} few {# записи} many {# записей} other {# записи}}', 'library.favorite': 'В избранное', 'library.unfavorite': 'Убрать из избранного',
    'library.add': 'Добавить свой', 'library.back': 'Назад', 'library.when': 'Когда использовать', 'library.inputs': 'Входные данные',
    'library.prompt': 'Инструкции', 'library.checks': 'Автоматические проверки', 'library.example': 'Пример', 'library.roles': 'Кто использует',
    'library.tokens': '{count} токенов', 'library.yours': 'Ваш', 'library.remove': 'Удалить', 'library.empty': 'Ничего не найдено',
    'library.form.title': 'Название', 'library.form.category': 'Категория', 'library.form.roles': 'Кто использует', 'library.form.tags': 'Теги через запятую',
    'library.form.when': 'Когда команде его использовать?', 'library.form.prompt': 'Инструкции с разделами Goal, Steps, Quality bar, Pitfalls, Verify и Output',
    'library.form.save': 'Сохранить в библиотеку', 'library.saved': 'Сохранено в ~/.hivedesk/library', 'library.error.save': 'Не удалось сохранить',
    'library.error.load': 'Не удалось загрузить библиотеку', 'library.used': 'Использованные плейбуки', 'library.planned': 'Выбраны для этой работы',
    'library.swap': 'Заменить', 'library.swapFor': 'Заменить {title} на', 'library.swapped': 'Плейбук заменен', 'library.locked': 'Задача уже началась',
    'library.why': 'оценка {score}: {terms}', 'library.none': 'Для этой задачи нет плейбука', 'library.cancel': 'Отмена', 'library.open': 'Открыть в библиотеке',
    'library.addTo': 'Добавить плейбук'
  }
};

/** Category names for the filter (English names of the folders, in every language for now). */
export const CATEGORY_KEYS = ['web-pages', 'ui-components', 'app-types', 'stacks', 'practices', 'git-docs', 'design', 'data', 'review-qa', 'planning', 'roles', 'custom'];

/** Translates a library.* key with ICU style parameters. */
export function tr(key, params) {
  if (has(key)) return t(key, params);
  const code = locale();
  const own = TABLES[code]?.[key];
  const msg = own ?? TABLES.en[key];
  if (msg == null) return key;
  try { return format(own != null ? code : 'en', msg, params); } catch { return msg; }
}

export { TABLES };

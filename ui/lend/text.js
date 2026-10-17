// Every string the lend screens show, in one place. Each member reads the current language when
// it is used (getters and functions over t()), so nothing freezes English at import time.
// Keys live under lend.* (i18n/parts/lend.en.json).

import { t, tmap, fmtNumber } from '/js/i18n.js';

const statusMap = tmap('lend.status');

export const T = {
  get lendTitle() { return t('lend.title'); },
  get lendLead() { return t('lend.lead'); },
  lendRelays: (n, total) => t('lend.relays', { n, total }),
  get lendRelaysWait() { return t('lend.relaysWait'); },
  get lendRelaysFail() { return t('lend.relaysFail'); },
  get lendWordsHelp() { return t('lend.wordsHelp'); },
  lendExpires: (s) => t('lend.expires', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }),
  get lendExpired() { return t('lend.expired'); },
  get copyLink() { return t('lend.copyLink'); },
  get copyWords() { return t('lend.copyWords'); },
  get copied() { return t('lend.copied'); },
  get newWords() { return t('lend.newWords'); },
  get shareLink() { return t('lend.shareLink'); },
  get confirmTitle() { return t('lend.confirm.title'); },
  get confirmHelp() { return t('lend.confirm.help'); },
  get confirmYes() { return t('lend.confirm.yes'); },
  get confirmNo() { return t('lend.confirm.no'); },
  get confirmWaitFriend() { return t('lend.confirm.waitFriend'); },
  get confirmMismatch() { return t('lend.confirm.mismatch'); },
  lendingTo: (who) => t('lend.lending.to', { who }),
  lendingModel: (model) => t('lend.lending.model', { model }),
  get lendingNoModel() { return t('lend.lending.noModel'); },
  get yourFriend() { return t('lend.yourFriend'); },
  get friend() { return t('lend.friend'); },
  get stopLending() { return t('lend.stopLending'); },
  get stopped() { return t('lend.stopped'); },
  get lendAgain() { return t('lend.lendAgain'); },
  get served() { return t('lend.status.done'); },
  get refused() { return t('lend.status.refused'); },
  perMinute: (used, max) => t('lend.perMinute', { used, max }),
  counters: (served, refused, used, max) => t('lend.counters', { served, refused, used, max }),
  get logTitle() { return t('lend.log.title'); },
  get logEmpty() { return t('lend.log.empty'); },
  get logHead() {
    return [t('lend.log.head.time'), t('lend.log.head.status'), t('lend.log.head.messages'), t('lend.log.head.prompt'), t('lend.log.head.answer'), t('lend.log.head.took')];
  },
  logChars: (count) => t('lend.log.chars', { count }),
  logTokens: (count) => t('lend.log.tokens', { count }),
  get showPrompt() { return t('lend.showPrompt'); },
  limitsNote: (l) => t('lend.limits', { perMinute: fmtNumber(l.perMinute), promptChars: fmtNumber(l.promptChars), maxTokens: fmtNumber(l.maxTokens) }),

  get joinTitle() { return t('lend.join.title'); },
  get joinLead() { return t('lend.join.lead'); },
  joinWord: (n) => t('lend.join.word', { n }),
  get joinGo() { return t('lend.join.go'); },
  get joinScan() { return t('lend.join.scan'); },
  get joinScanStop() { return t('lend.join.scanStop'); },
  get joinIncomplete() { return t('lend.join.incomplete'); },
  get joinUnknown() { return t('lend.join.unknown'); },
  get joinKnocking() { return t('lend.join.knocking'); },
  get joinTimeout() { return t('lend.join.timeout'); },
  borrowing: (who, model) => (model ? t('lend.borrow.usingModel', { who, model }) : t('lend.borrow.using', { who })),
  get borrowingNote() { return t('lend.borrow.note'); },
  get stopBorrowing() { return t('lend.borrow.stop'); },
  get borrowLog() { return t('lend.borrow.log'); },
  borrowEnded: (reason) => t('lend.borrow.ended', { reason }),
  get joinAgain() { return t('lend.join.again'); },

  /** Why a connection did not open, by the codes core/rtc.js and core/session.js report. */
  get failed() {
    return {
      offline: t('lend.failed.offline'),
      blocked: t('lend.failed.blocked'),
      'no-stun': t('lend.failed.noStun'),
      'strict-nat': t('lend.failed.strictNat'),
      timeout: t('lend.failed.timeout'),
      failed: t('lend.failed.failed'),
      closed: t('lend.failed.closed'),
    };
  },
  /** Request log statuses: running, done, refused, failed, cancelled, stopped, sent, answered, rejected. */
  status: statusMap,
};

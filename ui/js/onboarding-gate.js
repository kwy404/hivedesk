// One onboarding layer at a time on first run: the profile and City card ("Who are you?") comes first,
// the desktop tour starts only after it is closed or skipped. Pure module, no DOM: the tour asks it.
//   dialogOpen         a modal dialog is open
//   onboardingOpen     the profile and City card is on screen
//   onboardingDecided  the City has decided whether the card is needed (false while it does not know yet)
//   waitedMs           how long the tour has waited; after maxWaitMs it starts anyway when nothing is open

export const TOUR_MAX_WAIT_MS = 10_000;

/** May the first run tour start now? */
export function tourMayStart({ dialogOpen = false, onboardingOpen = false, onboardingDecided = true, waitedMs = 0, maxWaitMs = TOUR_MAX_WAIT_MS } = {}) {
  if (dialogOpen || onboardingOpen) return false;
  if (onboardingDecided === false && waitedMs < maxWaitMs) return false;
  return true;
}

/** The shared flag the City sets: { decided } (absent when the City is not loaded: nothing to wait for). */
export function onboardingState() {
  const g = globalThis.hivedeskOnboarding;
  return g && typeof g === 'object' ? g : { decided: true };
}

// First run: never two onboarding layers at once. The profile and City card comes first; the tour waits.
import { describe, it, expect, afterEach } from 'vitest';
import { tourMayStart, onboardingState, TOUR_MAX_WAIT_MS } from '../../ui/js/onboarding-gate.js';

afterEach(() => { delete globalThis.hivedeskOnboarding; });

describe('the first run tour gate', () => {
  it('waits while the card is open or undecided, and starts once it is closed or skipped', () => {
    expect(tourMayStart({ onboardingDecided: false, waitedMs: 900 })).toBe(false);
    expect(tourMayStart({ onboardingDecided: true, onboardingOpen: true, waitedMs: 5000 })).toBe(false);
    expect(tourMayStart({ onboardingDecided: true, onboardingOpen: false })).toBe(true);
    expect(tourMayStart({ dialogOpen: true })).toBe(false);
  });

  it('does not wait forever for a City that never decides, but never starts over an open card', () => {
    expect(tourMayStart({ onboardingDecided: false, waitedMs: TOUR_MAX_WAIT_MS })).toBe(true);
    expect(tourMayStart({ onboardingDecided: false, onboardingOpen: true, waitedMs: TOUR_MAX_WAIT_MS * 3 })).toBe(false);
  });

  it('reads the flag the City sets, and has nothing to wait for without a City', () => {
    expect(onboardingState()).toEqual({ decided: true });
    globalThis.hivedeskOnboarding = { decided: false };
    expect(onboardingState().decided).toBe(false);
  });
});

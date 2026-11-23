// The line between what the platform requires and what is the game's own design.
//
//   Platform requirements are mandatory. A version that misses one does not go live: publish refuses it and says what to
//   fix (src/release-gate.ts holds the rules). They are about the platform keeping its promises to players and creators:
//   every game on it plays on every kind of device the platform supports, runs safely in the browser, is the creator's
//   own work, declares what it shows, and has the store metadata players rely on.
//
//   Design recommendations are advice. How the game looks, which way up it is played (landscape, portrait or both), how
//   it lays out its interface, its cover, its loading screen and its sound are the game's own decisions. The platform
//   says how its own surfaces behave (src/standards.js) and recommends how to fit around them; no recommendation ever
//   stops a version.
//
// This module holds the device requirement, which is checked on the version's declared requirements and touch controls,
// and the wording every agent-facing surface uses for the split. Plain JavaScript so the Worker, scripts and node tests
// share it.

/** The kinds of device the platform supports. Every game must be playable on all of them. */
export const REQUIRED_DEVICES = ['desktop', 'tablet', 'mobile'];
const DEVICE_NAME = { desktop: 'computers (desktop)', tablet: 'tablets (tablet)', mobile: 'phones (mobile)' };

/** One sentence each, used by get_started, the standards guide, game_standards and the docs. */
export const SPLIT = {
  requirements: 'Platform requirements are mandatory: a version that misses one cannot go live, and publish says exactly what to fix. Every game must boot and play in the browser without errors, react to the player\'s input, keep running through bot play (a score or an ending is optional; reporting one with GCP.score or GCP.gameOver lifts its ranking a little), be playable on computers, tablets and phones (keyboard or mouse on a computer, touch on a phone or tablet), pass the content and originality checks, fit its storage, and have its store metadata on record.',
  recommendations: 'Design recommendations are advice: how the game looks, which way up it is played (landscape, portrait or both), how it lays out its interface, its cover, loading screen and sound are the game\'s own decisions. The platform says how its own surfaces behave and recommends how to fit around them; no recommendation ever stops a version.',
};

/**
 * The device requirement for one version: playable on computers, tablets and phones. Reads what the version will ship
 * with (manifest.compat.requirements and manifest.controls). Returns one problem per thing to fix, each with the exact
 * fix; an empty list means the requirement is met.
 *
 * Touch screens are covered when the game declares touch input, or when the platform's on-screen controls stand in for
 * its keys or the finger stands in for its mouse (gcp.json "controls" touch not "none"). Computers are covered by a
 * keyboard or a mouse.
 */
export function deviceProblems(manifest) {
  const req = (manifest && manifest.compat && manifest.compat.requirements) || null;
  if (!req) return [{ id: 'requirements', message: 'The version has no requirements on record, so the platform cannot tell which devices it plays on.', fix: 'Call deploy_preview again: every new version records them.' }];
  const devices = Array.isArray(req.devices) ? req.devices : [], input = Array.isArray(req.input) ? req.input : [];
  const controls = (manifest && manifest.controls) || null, overlayOff = !!controls && controls.mode === 'none';
  const out = [];
  const missing = REQUIRED_DEVICES.filter((d) => !devices.includes(d));
  if (missing.length) out.push({
    id: 'devices',
    message: `requirements.devices leaves out ${missing.map((d) => DEVICE_NAME[d]).join(' and ')}. Every game on the platform must be playable on computers, tablets and phones.`,
    fix: `Make the game playable there (debug_preview with a ${missing.includes('mobile') ? 'phone' : missing.includes('tablet') ? 'tablet' : 'computer'} viewport shows what happens), then call compatibility {project, action: "declare", requirements: {devices: ["desktop", "tablet", "mobile"]}} and deploy_preview again.`,
  });
  if (!input.includes('keyboard') && !input.includes('mouse')) out.push({
    id: 'computer-input',
    message: `requirements.input is ${input.length ? input.join(', ') : 'empty'}: nothing a computer player can use. Computers must be playable with a keyboard or a mouse.`,
    fix: 'Use pointer events (pointerdown, pointermove, pointerup) so a mouse plays the game as a finger does, or add keyboard controls; then declare them with compatibility {project, action: "declare", requirements: {input: ["keyboard", "mouse", "touch"]}} (only what the game really answers to) and deploy_preview again.',
  });
  const viaPlatform = !overlayOff && (input.includes('keyboard') || input.includes('mouse'));
  if (!input.includes('touch') && !viaPlatform) out.push({
    id: 'touch-input',
    message: overlayOff
      ? 'touch is not in requirements.input, and gcp.json "controls" turns the platform\'s on-screen controls off ("touch": "none"), so a phone or tablet player has no way to play.'
      : 'touch is not in requirements.input and the game has no keyboard or mouse controls the platform can stand in for, so a phone or tablet player has no way to play.',
    fix: overlayOff
      ? 'Either give the game touch controls of its own and declare touch (compatibility {project, action: "declare", requirements: {input: [..., "touch"]}}), or remove "touch": "none" from gcp.json "controls" so the platform\'s on-screen stick and buttons press the game\'s keys. Then deploy_preview again.'
      : 'Give the game touch controls (pointer events work for touch and mouse) and declare touch under requirements.input with compatibility {action: "declare"}. Then deploy_preview again.',
  });
  return out;
}

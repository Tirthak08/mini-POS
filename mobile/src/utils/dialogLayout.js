/**
 * How tall a centred dialog may be, and how far the screen must be padded, for
 * a given window and keyboard.
 *
 * This is a pure function on purpose. The bug it fixes -- the keyboard sitting
 * on top of the field being typed into -- cannot be reproduced in the browser
 * harness at all: there is no soft keyboard on web, so `keyboardDidShow` never
 * fires and every layout looks correct. Testing the COMPONENT would therefore
 * prove nothing, exactly as the splash-flash test once did.
 *
 * So the arithmetic lives here where a test can hand it a keyboard height and
 * check the answer, and the component is left with only the wiring.
 */

/** Never let the card grow past this share of the space actually visible. */
export const MAX_HEIGHT_RATIO = 0.86;

/**
 * A keyboard shorter than this is almost certainly a bad reading -- some
 * Android skins report a few pixels for the gesture bar as the keyboard
 * hides. Treating that as a real keyboard would jitter the dialog.
 */
export const MIN_CREDIBLE_KEYBOARD = 80;

/**
 * @param windowHeight    the full window height
 * @param keyboardHeight  0 when closed
 * @returns { available, maxHeight, paddingBottom }
 *
 * `paddingBottom` shrinks the flex container the dialog is centred inside, so
 * the card re-centres in the space ABOVE the keyboard rather than behind it.
 * Reducing the box is what does the work -- `justify-center` then puts the
 * card in the middle of what is left, with no transforms to fight.
 */
export function dialogBox(windowHeight, keyboardHeight = 0) {
  const height = Number(windowHeight) > 0 ? Number(windowHeight) : 0;
  const raw = Number(keyboardHeight);
  const keyboard = Number.isFinite(raw) && raw >= MIN_CREDIBLE_KEYBOARD ? raw : 0;

  // A keyboard taller than the window is nonsense; clamp so `available` can
  // never go negative and collapse the dialog to nothing.
  const available = Math.max(0, height - Math.min(keyboard, height));

  return {
    available,
    maxHeight: Math.round(available * MAX_HEIGHT_RATIO),
    paddingBottom: Math.min(keyboard, height),
  };
}

/**
 * True when the keyboard leaves too little room for a dialog to be usable --
 * a small phone in landscape with a keyboard up. The caller drops the vertical
 * centring and lets the card sit against the top instead, so the first field
 * stays reachable rather than the whole card being squeezed.
 */
export function isCramped(windowHeight, keyboardHeight = 0) {
  return dialogBox(windowHeight, keyboardHeight).available < 420;
}

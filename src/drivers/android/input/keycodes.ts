// why: scrcpy has no table from USB HID usages (what serve-sim sends, F18) to Android keycodes; its
// own client maps SDL keys. The keycode numbers are Android's (scrcpy v5.0.1 app/src/android/keycodes.h,
export const KEYCODE_HOME = 3;
export const KEYCODE_BACK = 4;
export const KEYCODE_POWER = 26;
export const KEYCODE_APP_SWITCH = 187;

const KEYCODE_0 = 7;
const KEYCODE_1 = 8;
const KEYCODE_A = 29;

const HID_A = 0x04;
const HID_1 = 0x1e;
const HID_0 = 0x27;

const OTHER_KEYS: ReadonlyMap<number, number> = new Map([
  [0x28, 66],
  [0x29, 111],
  [0x2a, 67],
  [0x2b, 61],
  [0x2c, 62],
  [0x2d, 69],
  [0x2e, 70],
  [0x2f, 71],
  [0x30, 72],
  [0x31, 73],
  [0x33, 74],
  [0x34, 75],
  [0x35, 68],
  [0x36, 55],
  [0x37, 56],
  [0x38, 76],
  [0x4f, 22],
  [0x50, 21],
  [0x51, 20],
  [0x52, 19],
]);

// why: the modifiers 0xe0-0xe7 go out as their own key events and are also held in the meta state of
// every later key until released, with the bits Android sets for each side.
const SHIFT_ON = 0x01;
const ALT_ON = 0x02;
const CTRL_ON = 0x1000;
const META_ON = 0x10000;
const MODIFIERS: ReadonlyMap<number, { readonly keycode: number; readonly meta: number }> = new Map(
  [
    [0xe0, { keycode: 113, meta: CTRL_ON | 0x2000 }],
    [0xe1, { keycode: 59, meta: SHIFT_ON | 0x40 }],
    [0xe2, { keycode: 57, meta: ALT_ON | 0x10 }],
    [0xe3, { keycode: 117, meta: META_ON | 0x20000 }],
    [0xe4, { keycode: 114, meta: CTRL_ON | 0x4000 }],
    [0xe5, { keycode: 60, meta: SHIFT_ON | 0x80 }],
    [0xe6, { keycode: 58, meta: ALT_ON | 0x20 }],
    [0xe7, { keycode: 118, meta: META_ON | 0x40000 }],
  ],
);

export function modifierOf(usage: number): { keycode: number; meta: number } | undefined {
  return MODIFIERS.get(usage);
}

// why: undefined for a usage outside the table (function keys, the keypad), which the caller drops.
export function keycodeOf(usage: number): number | undefined {
  if (usage >= HID_A && usage < HID_A + 26) return KEYCODE_A + (usage - HID_A);
  if (usage >= HID_1 && usage < HID_0) return KEYCODE_1 + (usage - HID_1);
  if (usage === HID_0) return KEYCODE_0;
  return OTHER_KEYS.get(usage) ?? MODIFIERS.get(usage)?.keycode;
}

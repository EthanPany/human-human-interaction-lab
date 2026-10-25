/**
 * Avatar defaults. The app draws the avatar (shape + two eyes) procedurally,
 * so the server only stores the shape name and a color.
 */

export const AVATAR_SHAPES = ["blob", "puzzle", "circle", "triangle", "square", "pill", "flower"] as const;

/** The designer's palette (Figma "Profile final"). */
export const AVATAR_COLORS = ["#FF6C6E", "#FFEA82", "#EB8FFF", "#A9F48E", "#87D9FB", "#509DF8", "#3BB52D", "#45D0DD"];

export const BADGE_LAYOUTS = ["avatar", "photo", "photoText"] as const;

/** Stable but varied defaults for a new person. */
export function defaultAvatar(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    avatarShape: AVATAR_SHAPES[h % AVATAR_SHAPES.length],
    avatarColor: AVATAR_COLORS[(h >>> 8) % AVATAR_COLORS.length],
  };
}

export function avatarOf(u: { _id: string; avatarShape?: string; avatarColor?: string }) {
  const d = defaultAvatar(u._id);
  return { shape: u.avatarShape ?? d.avatarShape, color: u.avatarColor ?? d.avatarColor };
}

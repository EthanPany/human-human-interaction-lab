import { defaultAvatar } from "./avatar";

/**
 * What the agent may say about someone you have not met yet. Before you meet,
 * a suggested person is described only by what you can see at the event:
 * their badge (avatar color and shape), the look they chose to share, and one
 * broad topic. Never their name, company, school, exact role or other details.
 * Gender is not a profile field, so it is mentioned only when it is part of
 * the look they wrote themselves.
 */

type Profile = {
  id: string;
  avatarShape?: string;
  avatarColor?: string;
  badgeLayout?: string;
  appearance?: string;
  tags?: string[];
  headline?: string;
  offers?: string;
  lookingFor?: string;
  hobbies?: string[];
};

const COLOR_NAMES: Record<string, string> = {
  "#FF6C6E": "red",
  "#FFEA82": "yellow",
  "#EB8FFF": "pink",
  "#A9F48E": "light green",
  "#87D9FB": "light blue",
  "#509DF8": "blue",
  "#3BB52D": "green",
  "#45D0DD": "teal",
};

const SHAPE_NAMES: Record<string, string> = {
  blob: "blob",
  puzzle: "puzzle piece",
  circle: "circle",
  triangle: "triangle",
  square: "square",
  pill: "pill",
  flower: "flower",
};

/** A plain color word for a hex color (the palette first, then by hue). */
export function colorName(hex: string | undefined): string {
  if (!hex) return "colorful";
  const known = COLOR_NAMES[hex.toUpperCase()];
  if (known) return known;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "colorful";
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.12) return max > 0.8 ? "white" : max < 0.25 ? "black" : "gray";
  let h = 0;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return "red";
  if (h < 40) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 250) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

/** Broad topics only: a whole field, never a company, school or title. */
const TOPICS: [string, RegExp][] = [
  ["robotics", /robot|drone|autonom|humanoid/i],
  ["hardware", /hardware|chip|silicon|fpga|embedded|firmware|electronic|pcb|circuit|sensor|iot/i],
  ["AI", /\bai\b|machine learning|\bml\b|llm|deep learning|neural|agent|computer vision|nlp/i],
  ["design", /design|\bux\b|\bui\b|figma|illustrat|creative|\bart\b|\bartist/i],
  ["startups", /founder|startup|entrepreneur|\bceo\b|cofounder|co-founder/i],
  ["investing", /invest|venture|\bvc\b|angel/i],
  ["health", /health|medic|bio|clinic|neuro|fitness/i],
  ["climate", /climate|energy|solar|sustainab|carbon/i],
  ["education", /educat|teach|learning|student/i],
  ["security", /security|crypto(graphy)?\b|privacy/i],
  ["web3", /web3|blockchain|ethereum|defi/i],
  ["games", /game|gaming|unity|unreal/i],
  ["music", /music|audio|guitar|piano|dj\b/i],
  ["data", /data|analytics|statistic/i],
  ["mobile apps", /ios|android|mobile|swift/i],
  ["software", /software|engineer|developer|backend|frontend|full ?stack|coding|programm/i],
  ["product", /product/i],
  ["marketing", /marketing|growth|brand|sales/i],
  ["research", /research|phd|scien/i],
];

export function broadTopic(p: Profile): string | undefined {
  const fields = [...(p.tags ?? []), p.headline, p.offers, p.lookingFor, ...(p.hobbies ?? [])].filter(Boolean).join(" | ");
  for (const [topic, re] of TOPICS) if (re.test(fields)) return topic;
  return undefined;
}

/** "a green flower avatar" (or the photo badge), from the avatar defaults when unset. */
export function badgeLook(p: Profile): string {
  if (p.badgeLayout === "photo") return "a badge with a photo on it";
  const d = defaultAvatar(p.id);
  const shape = SHAPE_NAMES[p.avatarShape ?? d.avatarShape] ?? "blob";
  return `a ${colorName(p.avatarColor ?? d.avatarColor)} ${shape} avatar on a badge`;
}

/** Their own words about how to spot them, trimmed. Optional. */
export function statedLook(p: Profile): string | undefined {
  const look = p.appearance?.trim().replace(/\s+/g, " ").replace(/[.!]+$/, "");
  if (!look) return undefined;
  return look.length > 90 ? `${look.slice(0, 87)}...` : look;
}

/** Everything the agent may know about a suggested person before you meet them. */
export function anonymousHint(p: Profile) {
  return { badge: badgeLook(p), look: statedLook(p), topic: broadTopic(p) };
}

/**
 * The heads up text. Example:
 * "Someone nearby might be worth a hello: look for a green flower avatar on a badge. They are into hardware."
 */
export function headsUpText(p: Profile): string {
  const hint = anonymousHint(p);
  return [
    `Someone nearby might be worth a hello: look for ${hint.badge}.`,
    hint.look ? `They described themselves as: ${hint.look}.` : undefined,
    hint.topic ? `They are into ${hint.topic}.` : undefined,
    "Your badges will glow when you get close.",
  ]
    .filter(Boolean)
    .join(" ");
}

// Coarse location ---------------------------------------------------------------

/** Round to a grid of about 110 m (3 decimals), so the server never keeps a precise spot. */
export function coarse(deg: number) {
  return Math.round(deg * 1000) / 1000;
}

/** Great circle distance in meters. */
export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

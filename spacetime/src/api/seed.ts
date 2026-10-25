import { DEFAULT_RUBRIC } from "../lib/constants";
import { newId, nowMs, scheduleRescoreAll } from "../lib/db";
import type { Tx } from "../schema";
import { blankUser } from "./users";

/**
 * Demo attendees (same as backend/convex/seed.ts). Phones use the fictional
 * 555-01xx range, so no texts are ever sent to them.
 * Run: spacetime call <db> seed_demo
 */
export const DEMO = [
  { name: "Maya", company: "Ramp", location: "San Francisco, CA", avatarShape: "blob", avatarColor: "#FF6C6E", headline: "Product designer at a fintech startup", tags: ["Product designer", "Figma", "Startup founder"], lookingFor: "engineers who want to build a consumer app", offers: "UX research, design systems", hobbies: ["climbing", "film photography"], appearance: "short curly hair, yellow jacket" },
  { name: "Jordan", company: "Berkeley Robotics", location: "Berkeley, CA", avatarShape: "square", avatarColor: "#87D9FB", headline: "Hardware engineer, robotics", tags: ["Hardware engineer", "Robotics", "Student"], lookingFor: "AI people for a robotics startup", offers: "embedded systems, PCB design, 3D printing", hobbies: ["skateboarding", "synths"], appearance: "tall, black hair, gray hoodie" },
  { name: "Priya", company: "Stanford", location: "Palo Alto, CA", avatarShape: "flower", avatarColor: "#EB8FFF", headline: "ML researcher, multiagent systems", tags: ["ML researcher", "Multiagent systems", "PhD student"], lookingFor: "product people to turn research into a product", offers: "LLM agents, evaluation", hobbies: ["running", "board games"], appearance: "glasses, green beanie" },
  { name: "Leo", company: "StudyPal", location: "Oakland, CA", avatarShape: "triangle", avatarColor: "#FFEA82", headline: "Founder building an AI study tool", tags: ["Startup founder", "Edtech", "Fundraising"], lookingFor: "a technical cofounder, iOS", offers: "go to market, fundraising intros", hobbies: ["basketball", "podcasts"], appearance: "red cap, white sneakers" },
  { name: "Sofia", company: "Freelance", location: "Vancouver, BC", avatarShape: "pill", avatarColor: "#A9F48E", headline: "iOS engineer, SwiftUI", tags: ["iOS engineer", "SwiftUI", "Accessibility"], lookingFor: "designers and founders with a consumer idea", offers: "SwiftUI, App Store launches", hobbies: ["pottery", "hiking"], appearance: "long braid, denim jacket" },
  { name: "Ken", company: "Convex", location: "San Francisco, CA", avatarShape: "circle", avatarColor: "#509DF8", headline: "Backend engineer, realtime systems", tags: ["Backend engineer", "Convex", "Realtime"], lookingFor: "hackathon teammates for a health app", offers: "databases, APIs, infra", hobbies: ["chess", "cooking"], appearance: "black t-shirt, silver headphones" },
  { name: "Ava", company: "UC Berkeley", location: "Berkeley, CA", avatarShape: "puzzle", avatarColor: "#45D0DD", headline: "HCI researcher studying social technology", tags: ["HCI researcher", "User studies", "Student"], lookingFor: "builders who care about in-person connection", offers: "study design, interviews", hobbies: ["dance", "journaling"], appearance: "pink sweater, tote bag" },
  { name: "Omar", company: "Scout Fund", location: "Menlo Park, CA", avatarShape: "blob", avatarColor: "#3BB52D", headline: "VC scout, early stage consumer", tags: ["Investor", "Consumer apps", "Angel"], lookingFor: "student founders building consumer AI", offers: "fundraising advice, investor intros", hobbies: ["soccer", "travel"], appearance: "navy blazer over a hoodie" },
];

export function seedDemo(tx: Tx) {
  const now = nowMs(tx);
  let i = 0;
  for (const p of DEMO) {
    const phone = `+1415555${(100 + i++).toString().padStart(4, "0")}`; // +1 415 555 01xx
    const existing = tx.db.users.phone.find(phone);
    const doc = { ...p, phone, badgeLayout: "avatar", californiaMode: true, recordConversations: true, lastSeenAt: now };
    if (existing) tx.db.users.id.update({ ...existing, ...doc });
    else tx.db.users.insert({ ...blankUser(newId(tx), phone), ...doc });
  }
  if (!tx.db.rubric.name.find("global")) tx.db.rubric.insert({ name: "global", ...DEFAULT_RUBRIC });
  scheduleRescoreAll(tx);
}

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

/**
 * Two hand written test attendees built to match each other strongly (both
 * directions), for testing Nearby Interaction / UWB with two phones. Sign in on
 * one phone as (585) 210 6589 (Ethan) and on the other as (760) 582 2423 (Carl).
 * These are the team's real phones, so the agent can text them once they text it.
 */
export const TEST_PAIR = [
  {
    phone: "+15852106589",
    name: "Ethan",
    company: "UC Berkeley",
    location: "Berkeley, CA",
    avatarShape: "blob",
    avatarColor: "#87D9FB",
    headline: "iOS engineer building wearable social tech",
    tags: ["iOS engineer", "SwiftUI", "Hardware hacker"],
    lookingFor:
      "a product designer to team up with for this hackathon and maybe cofound a startup about meeting people in person",
    offers: "SwiftUI apps, Nearby Interaction and UWB, 3D printing enclosures, shipping to the App Store",
    hobbies: ["Climbing", "Film photography", "Synths"],
    appearance: "green beanie, gray hoodie, a phone on a lanyard",
  },
  {
    phone: "+17605822423",
    name: "Carl",
    company: "Stanford d.school",
    location: "Palo Alto, CA",
    avatarShape: "flower",
    avatarColor: "#FF6C6E",
    headline: "Product designer who prototypes social hardware",
    tags: ["Product designer", "Interaction design", "Startup founder"],
    lookingFor:
      "an iOS engineer who can build with UWB and hardware, as a hackathon teammate and possible cofounder for a social app",
    offers: "interaction design, Figma prototyping, user research, pitching to investors",
    hobbies: ["Climbing", "Film photography", "Ceramics"],
    appearance: "yellow jacket, short curly hair, a phone on a lanyard",
  },
];

export function seedTestPair(tx: Tx) {
  const now = nowMs(tx);
  for (const p of TEST_PAIR) {
    const existing = tx.db.users.phone.find(p.phone);
    const doc = { ...p, badgeLayout: "avatar", californiaMode: false, recordConversations: true, lastSeenAt: now };
    if (existing) tx.db.users.id.update({ ...existing, ...doc });
    else tx.db.users.insert({ ...blankUser(newId(tx), p.phone), ...doc });
  }
  if (!tx.db.rubric.name.find("global")) tx.db.rubric.insert({ name: "global", ...DEFAULT_RUBRIC });
  scheduleRescoreAll(tx);
}

export function seedDemo(tx: Tx) {
  const now = nowMs(tx);
  let i = 0;
  for (const p of DEMO) {
    const phone = `+1415555${(100 + i++).toString().padStart(4, "0")}`; // +1 415 555 01xx
    const existing = tx.db.users.phone.find(phone);
    const doc = { ...p, phone, badgeLayout: "avatar", californiaMode: false, recordConversations: true, lastSeenAt: now };
    if (existing) tx.db.users.id.update({ ...existing, ...doc });
    else tx.db.users.insert({ ...blankUser(newId(tx), phone), ...doc });
  }
  if (!tx.db.rubric.name.find("global")) tx.db.rubric.insert({ name: "global", ...DEFAULT_RUBRIC });
  scheduleRescoreAll(tx);
}

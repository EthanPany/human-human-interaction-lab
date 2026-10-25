import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { DEFAULT_RUBRIC } from "./lib/constants";

/**
 * Demo attendees. Phones use the fictional 555-01xx range, so no texts are
 * ever sent to them. Run: npx convex run seed:demo
 */
const DEMO = [
  { name: "Maya", headline: "Product designer at a fintech startup", tags: ["Product designer", "Figma", "Startup founder"], lookingFor: "engineers who want to build a consumer app", offers: "UX research, design systems", hobbies: ["climbing", "film photography"], appearance: "short curly hair, yellow jacket" },
  { name: "Jordan", headline: "Hardware engineer, robotics", tags: ["Hardware engineer", "Robotics", "Student"], lookingFor: "AI people for a robotics startup", offers: "embedded systems, PCB design, 3D printing", hobbies: ["skateboarding", "synths"], appearance: "tall, black hair, gray hoodie" },
  { name: "Priya", headline: "ML researcher, multiagent systems", tags: ["ML researcher", "Multiagent systems", "PhD student"], lookingFor: "product people to turn research into a product", offers: "LLM agents, evaluation", hobbies: ["running", "board games"], appearance: "glasses, green beanie" },
  { name: "Leo", headline: "Founder building an AI study tool", tags: ["Startup founder", "Edtech", "Fundraising"], lookingFor: "a technical cofounder, iOS", offers: "go to market, fundraising intros", hobbies: ["basketball", "podcasts"], appearance: "red cap, white sneakers" },
  { name: "Sofia", headline: "iOS engineer, SwiftUI", tags: ["iOS engineer", "SwiftUI", "Accessibility"], lookingFor: "designers and founders with a consumer idea", offers: "SwiftUI, App Store launches", hobbies: ["pottery", "hiking"], appearance: "long braid, denim jacket" },
  { name: "Ken", headline: "Backend engineer, realtime systems", tags: ["Backend engineer", "Convex", "Realtime"], lookingFor: "hackathon teammates for a health app", offers: "databases, APIs, infra", hobbies: ["chess", "cooking"], appearance: "black t-shirt, silver headphones" },
  { name: "Ava", headline: "HCI researcher studying social technology", tags: ["HCI researcher", "User studies", "Student"], lookingFor: "builders who care about in-person connection", offers: "study design, interviews", hobbies: ["dance", "journaling"], appearance: "pink sweater, tote bag" },
  { name: "Omar", headline: "VC scout, early stage consumer", tags: ["Investor", "Consumer apps", "Angel"], lookingFor: "student founders building consumer AI", offers: "fundraising advice, investor intros", hobbies: ["soccer", "travel"], appearance: "navy blazer over a hoodie" },
];

export const demo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let i = 0;
    for (const p of DEMO) {
      const phone = `+1415555${(100 + i++).toString().padStart(4, "0")}`; // +1 415 555 01xx
      const existing = await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", phone)).unique();
      const doc = { ...p, phone, californiaMode: true, recordConversations: true, lastSeenAt: now };
      if (existing) await ctx.db.patch(existing._id, doc);
      else await ctx.db.insert("users", doc);
    }
    const rubric = await ctx.db.query("rubric").withIndex("by_name", (q) => q.eq("name", "global")).unique();
    if (!rubric) await ctx.db.insert("rubric", { name: "global", ...DEFAULT_RUBRIC });
    await ctx.scheduler.runAfter(0, internal.matching.rescoreAll, {});
  },
});

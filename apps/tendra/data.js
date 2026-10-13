// Demo data for the bid pipeline. Every figure is made up.

/** The signed-in user. */
export const me = { initials: "DO", name: "Dana Ortiz", role: "Capture lead" };

/**
 * @typedef {"gonogo" | "drafting" | "review" | "submitted" | "awarded"} StageId
 * @typedef {"neutral" | "amber" | "blue" | "green" | "red" | "orange"} Tone
 * @typedef {{
 *   id: string, stage: StageId, tag: string, tone: Tone, due: string,
 *   agency: string, kind: string, number: string, project: string,
 *   status?: string, progress?: number, owners: string[], value: number,
 *   stuck?: boolean,
 * }} Bid
 */

/** @type {{ id: StageId, label: string, summary: string }[]} */
export const stages = [
  { id: "gonogo", label: "Go / no-go", summary: "GO / NO-GO" },
  { id: "drafting", label: "Drafting", summary: "DRAFTING" },
  { id: "review", label: "In review", summary: "IN REVIEW" },
  { id: "submitted", label: "Submitted", summary: "SUBMITTED" },
  { id: "awarded", label: "Awarded", summary: "AWARDED" },
];

/** Stages counted as active work in the headline. */
export const activeStages = ["gonogo", "drafting", "review"];

/** @type {Bid[]} */
export const seedBids = [
  { id: "b1", stage: "gonogo", tag: "DECIDE BY FRI", tone: "amber", due: "19 days", agency: "City of Johnson City", kind: "ITB", number: "1194", project: "Tweetsie Trail extension", status: "Not started", owners: ["DO"], value: 640_000 },
  { id: "b2", stage: "gonogo", tag: "FIT 92", tone: "green", due: "26 days", agency: "Sevier County", kind: "ITB", number: "26-31", project: "Culvert replacement, Route 4", status: "Not started", owners: [], value: 1_300_000 },

  { id: "b3", stage: "drafting", tag: "AI DRAFTING", tone: "blue", due: "13 days", agency: "Chattanooga Authority", kind: "RFP", number: "26-08", project: "Apron drainage rehabilitation", progress: 38, owners: ["LS", "DO"], value: 1_100_000 },
  { id: "b4", stage: "drafting", tag: "DRAFTING", tone: "neutral", due: "16 days", agency: "Town of Greeneville", kind: "RFQ", number: "26-114", project: "Downtown stormwater upgrades", progress: 24, owners: ["RJ"], value: 1_400_000 },
  { id: "b5", stage: "drafting", tag: "OVER BOND LIMIT", tone: "red", due: "41 days", agency: "Tennessee Valley Authority", kind: "RFP", number: "7731", project: "Access road resurfacing", progress: 9, owners: ["MK", "DO"], value: 4_000_000, stuck: true },

  { id: "b6", stage: "review", tag: "BOND MISSING", tone: "red", due: "Tomorrow", agency: "City of Kingsport, TN", kind: "RFP", number: "24-117", project: "Stormwater outfall repairs", progress: 90, owners: ["DO", "MK", "RJ"], value: 2_400_000, stuck: true },
  { id: "b7", stage: "review", tag: "CHECKING", tone: "neutral", due: "4 days", agency: "Tennessee DOT", kind: "IFB", number: "4410", project: "Bridge deck overlay, I-26", progress: 86, owners: ["MK", "LS"], value: 5_800_000 },
  { id: "b8", stage: "review", tag: "PARTNER", tone: "orange", due: "6 days", agency: "Knox County Schools", kind: "RFQ", number: "26-031", project: "Site paving and lots", progress: 82, owners: ["RJ"], value: 780_000 },
  { id: "b9", stage: "review", tag: "CHECKING", tone: "neutral", due: "9 days", agency: "City of Morristown", kind: "ITB", number: "26-019", project: "Sidewalk ADA retrofits", progress: 70, owners: ["LS"], value: 620_000 },

  { id: "b10", stage: "submitted", tag: "SEALED", tone: "neutral", due: "Oct 16", agency: "City of Bristol, TN", kind: "RFP", number: "26-14", project: "Beaver Creek bank stabilisation", status: "All answers approved", owners: ["RJ"], value: 1_600_000 },
  { id: "b11", stage: "submitted", tag: "LOW BID", tone: "green", due: "Oct 22", agency: "Sullivan County", kind: "ITB", number: "2611", project: "Bluff City culvert replacement", status: "All answers approved", owners: ["MK"], value: 920_000 },
  { id: "b12", stage: "submitted", tag: "SHORTLISTED", tone: "blue", due: "Oct 15", agency: "City of Elizabethton", kind: "RFP", number: "26-031", project: "Elk Avenue streetscape", status: "All answers approved", owners: ["DO", "RJ"], value: 2_200_000 },
  { id: "b13", stage: "submitted", tag: "SEALED", tone: "neutral", due: "Oct 19", agency: "Carter County", kind: "IFB", number: "26-07", project: "Watauga River boat ramp", status: "All answers approved", owners: ["LS"], value: 1_380_000 },

  { id: "b14", stage: "awarded", tag: "WON", tone: "neutral", due: "NTP Nov 1", agency: "City of Johnson City", kind: "RFP", number: "26-07", project: "Brush Creek greenway", status: "Handed to the project team", owners: ["RJ", "DO"], value: 2_800_000 },
  { id: "b15", stage: "awarded", tag: "WON", tone: "neutral", due: "Started", agency: "Washington County", kind: "ITB", number: "26-22", project: "Gray Station Road widening", status: "Handed to the project team", owners: ["LS"], value: 1_100_000 },
];

/** Cards shown per column before "N more". */
export const columnLimit = 3;

/** @param {number} value */
export function money(value) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(value / 1000)}K`;
}

/** @param {Bid[]} bids */
export function total(bids) {
  return bids.reduce((sum, bid) => sum + bid.value, 0);
}

/** Average readiness of the bids that report progress. @param {Bid[]} bids */
export function averageProgress(bids) {
  const tracked = bids.filter((bid) => typeof bid.progress === "number");
  if (tracked.length === 0) return 0;
  return Math.round(tracked.reduce((sum, bid) => sum + (bid.progress ?? 0), 0) / tracked.length);
}

/** The footnote under each summary tile. @param {StageId} stage @param {Bid[]} bids */
export function stageNote(stage, bids) {
  const stuck = bids.filter((bid) => bid.stuck).length;
  const stuckText = stuck ? `${stuck} stuck · ` : "";
  switch (stage) {
    case "gonogo": return `${bids.length} waiting for a decision`;
    case "drafting":
    case "review": return `${stuckText}${averageProgress(bids)}% ready on average`;
    case "submitted": {
      const days = bids.map((bid) => Number(bid.due.replace(/\D/g, ""))).filter(Boolean).sort((a, b) => a - b);
      if (days.length === 0) return "No openings scheduled";
      const [first, last] = [days[0], days[days.length - 1]];
      return first === last ? `Opening Oct ${first}` : `Openings Oct ${first} to ${last}`;
    }
    case "awarded": return "Won this quarter";
  }
}

/** "Thu, Oct 8, 2026 · 10:42 AM ET", from a UTC instant. @param {Date} now */
export function easternTime(now) {
  // US Eastern is UTC-4 from the second Sunday of March to the first Sunday of November.
  const year = now.getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const dstStart = Date.UTC(year, 2, nthSunday(2, 2), 7);
  const dstEnd = Date.UTC(year, 10, nthSunday(10, 1), 6);
  const offset = now.getTime() >= dstStart && now.getTime() < dstEnd ? -4 : -5;
  const et = new Date(now.getTime() + offset * 3_600_000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hours = et.getUTCHours();
  const minutes = String(et.getUTCMinutes()).padStart(2, "0");
  const clock = `${hours % 12 || 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
  return `${days[et.getUTCDay()]}, ${months[et.getUTCMonth()]} ${et.getUTCDate()}, ${year} · ${clock} ET`;
}

// @ts-check
// Demo helpdesk data. Every customer, person and ticket here is made up.

/** @typedef {"open" | "pending" | "resolved" | "closed"} Status */
/** @typedef {"urgent" | "high" | "medium" | "low" | "none"} Priority */
/** @typedef {"billing" | "technical" | "account" | "subscription" | "other"} Category */
/** @typedef {"email" | "chat" | "web"} Channel */
/** @typedef {"on_track" | "warning" | "breached"} Sla */
/** @typedef {"question" | "incident" | "problem" | "task"} TicketType */

export const ticketTypes = /** @type {const} */ ([
  { id: "question", label: "Question" },
  { id: "incident", label: "Incident" },
  { id: "problem", label: "Problem" },
  { id: "task", label: "Task" },
]);

/** Shared inboxes a reply can be sent from. */
export const senders = ["Support Ops", "Billing Desk", "Customer Success"];

/** Canned replies for the composer. */
export const templates = [
  { id: "ack", label: "Acknowledge", text: "Thanks for reaching out — we've picked this up and will update you within the day." },
  { id: "request-id", label: "Ask for a request ID", text: "Could you send one recent request ID? It lets engineering trace the exact call." },
  { id: "workaround", label: "Share a workaround", text: "While we work on a fix, you can export from Reports → Scheduled exports as a fallback." },
  { id: "resolved", label: "Confirm resolution", text: "This should be resolved now. Let us know if anything still looks off and we'll reopen it." },
];

/**
 * @typedef {object} Activity
 * @property {number} at       epoch milliseconds
 * @property {string} who      a person id, or the customer's contact name
 * @property {"note" | "reply" | "event"} kind
 * @property {string} text
 */

/**
 * @typedef {object} Ticket
 * @property {number} number
 * @property {string} subject
 * @property {string} customer
 * @property {string} contact
 * @property {Channel} channel
 * @property {Category} category
 * @property {Priority} priority
 * @property {Status} status
 * @property {string | null} assignee  a person id
 * @property {boolean} escalated
 * @property {number} createdAt
 * @property {number} dueAt
 * @property {string} description
 * @property {Activity[]} activity
 * @property {TicketType} [type]
 * @property {number} [snoozedUntil]  hidden from the inbox until then
 * @property {number} [seenAt]        when an agent last read the conversation
 */

export const statuses = /** @type {const} */ ([
  { id: "open", label: "Open", icon: "circle-dot" },
  { id: "pending", label: "Pending", icon: "clock" },
  { id: "resolved", label: "Resolved", icon: "check" },
  { id: "closed", label: "Closed", icon: "lock" },
]);

export const priorities = /** @type {const} */ ([
  { id: "urgent", label: "Urgent", icon: "arrow-up", rank: 0 },
  { id: "high", label: "High", icon: "arrow-up", rank: 1 },
  { id: "medium", label: "Medium", icon: "minus", rank: 2 },
  { id: "low", label: "Low", icon: "arrow-down", rank: 3 },
  { id: "none", label: "Todo", icon: "circle-dashed", rank: 4 },
]);

export const categories = /** @type {const} */ ([
  { id: "billing", label: "Billing" },
  { id: "technical", label: "Technical Issue" },
  { id: "account", label: "Account & Login" },
  { id: "subscription", label: "Subscription" },
  { id: "other", label: "Other" },
]);

export const channels = /** @type {const} */ ([
  { id: "email", label: "Email", icon: "mail" },
  { id: "chat", label: "Chat", icon: "message" },
  { id: "web", label: "Web form", icon: "globe" },
]);

export const people = [
  { id: "jl", name: "Jason Lee", initials: "JL" },
  { id: "np", name: "Nina Park", initials: "NP" },
  { id: "mh", name: "Marcus Hale", initials: "MH" },
  { id: "lt", name: "Leah Tran", initials: "LT" },
];

/** The signed-in agent. */
export const me = people[0];

/** Counts a week ago, for the "vs last week" line on each summary tile. */
export const lastWeek = { total: 17, open: 10, pending: 6, resolved: 2 };

/** @param {string | null} id */
export const person = (id) => people.find((p) => p.id === id) ?? null;
/** @param {string} id */
export const statusOf = (id) => statuses.find((s) => s.id === id) ?? statuses[0];
/** @param {string} id */
export const priorityOf = (id) => priorities.find((p) => p.id === id) ?? priorities[4];
/** @param {string} id */
export const categoryOf = (id) => categories.find((c) => c.id === id) ?? categories[4];
/** @param {string} id */
export const channelOf = (id) => channels.find((c) => c.id === id) ?? channels[0];

/** @param {number} number */
export const code = (number) => `#-${String(number).padStart(3, "0")}`;

const hour = 3_600_000;

/** Whether the ticket still waits on the team. */
export const isActive = (/** @type {{ status: Status }} */ t) => t.status === "open" || t.status === "pending";

/** @param {Ticket} t @param {number} now @returns {Sla} */
export function slaOf(t, now) {
  if (!isActive(t)) return "on_track";
  if (t.dueAt < now) return "breached";
  if (t.dueAt - now < 24 * hour) return "warning";
  return "on_track";
}

export const slaLabels = { on_track: "On track", warning: "Warning", breached: "Breached" };

/** "in 5h", "3d ago", … @param {number} at @param {number} now */
export function relative(at, now) {
  const diff = at - now;
  const abs = Math.abs(diff);
  const text = abs < hour ? `${Math.max(1, Math.round(abs / 60_000))}m`
    : abs < 48 * hour ? `${Math.round(abs / hour)}h`
    : `${Math.round(abs / (24 * hour))}d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** "Oct 15, 14:05" @param {number} at */
export function stamp(at) {
  const d = new Date(at);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// [number, status, channel, priority, category, assignee, escalated, created h ago, due in h, customer, contact, subject, description]
/** @type {[number, Status, Channel, Priority, Category, string | null, boolean, number, number, string, string, string, string][]} */
const rows = [
  [1, "open", "email", "high", "other", "jl", false, 30, 10, "Pine & Peak", "Dana Whitfield",
    "Low activation in week-one onboarding cohort for Pine & Peak",
    "Only 31% of the seats invited last Monday have completed setup. Dana would like a walkthrough for their team leads before Friday's review."],
  [2, "open", "web", "urgent", "technical", "jl", true, 20, 40, "Northwind", "Omar Reyes",
    "Expansion review blocked by delayed Salesforce health sync",
    "Account health scores stopped updating on Oct 11. The expansion review is waiting on fresh numbers from the Salesforce sync."],
  [4, "open", "email", "medium", "account", null, false, 26, -5, "Prism Health", "Aiden Bell",
    "SSO login loop for users on the EU tenant",
    "Users on eu.prismhealth.org are redirected back to the login page after the Okta assertion. US tenant is unaffected."],
  [5, "open", "chat", "urgent", "billing", "mh", true, 9, -2, "Blueforge Labs", "Mina Alavi",
    "Invoice shows a duplicate charge for the annual plan",
    "Invoice INV-20931 lists the annual plan twice. Finance needs a corrected invoice before the month-end close."],
  [8, "open", "email", "low", "technical", null, false, 12, 70, "Atlas Health", "Rosa Lindqvist",
    "Request to export audit logs as CSV",
    "Compliance wants the last 90 days of audit events in CSV for an internal review."],
  [12, "open", "web", "high", "technical", "np", true, 50, -20, "Polar Banking", "Marcus Lind",
    "Webhook deliveries failing with 502 since Monday",
    "Shipment webhooks to hooks.polarbanking.fi return 502 on roughly 40% of deliveries. Retries eventually succeed."],
  [14, "open", "chat", "none", "billing", null, false, 4, 48, "Lumen Retail", "Ava Moreno",
    "Question about seat-based pricing for nonprofits",
    "Ava asks whether the nonprofit discount applies to seats added mid-term."],
  [16, "open", "email", "medium", "account", "lt", false, 60, -30, "Lattice Cloud", "Amelia Chen",
    "Password reset emails landing in spam",
    "Reset emails for latticecloud.io addresses go to spam in Google Workspace. SPF passes; DKIM alignment looks off."],
  [3, "pending", "email", "high", "subscription", "jl", true, 70, -8, "Acme Corp", "Grace Liu",
    "Need admin ownership model before enterprise rollout",
    "Acme wants to split billing ownership from workspace administration before rolling out to 1,200 seats."],
  [9, "pending", "email", "high", "technical", "np", true, 44, 6, "Summit Grid", "Leah Morgan",
    "CSV import adoption stalled for the multilingual customer segment",
    "Imports with accented characters fail validation. Waiting on a sample file from the customer."],
  [11, "pending", "chat", "medium", "billing", "jl", false, 90, -50, "Brightline", "Ken Ito",
    "Plan downgrade did not prorate remaining credit",
    "After moving from Business to Team the remaining credit was not applied to the next invoice."],
  [15, "pending", "web", "low", "technical", "mh", false, 36, -3, "Polar Banking", "Marcus Lind",
    "Calendar sync drops recurring events",
    "Recurring meetings created in Outlook appear only once in the shared calendar."],
  [18, "pending", "email", "none", "subscription", "jl", false, 16, 96, "Northwind", "Omar Reyes",
    "Confirm renewal date after mid-term upgrade",
    "Omar asks whether the upgrade on Sep 30 moved the renewal date."],
  [6, "resolved", "chat", "low", "other", "jl", false, 120, 30, "Pine & Peak", "Dana Whitfield",
    "Customer asks for a rollout plan for conditional workflows",
    "Shared the phased rollout template and booked a follow-up session."],
  [10, "resolved", "email", "low", "billing", "mh", false, 100, 20, "Atlas Health", "Rosa Lindqvist",
    "Need a credit summary for the canceled onboarding add-on",
    "Sent the credit memo for the onboarding add-on cancelled on Oct 2."],
  [13, "resolved", "email", "medium", "account", "np", false, 80, 10, "Ferro Logistics", "Theo Grant",
    "Two-factor codes delayed for Australian numbers",
    "SMS provider route for +61 numbers was switched; codes now arrive within seconds."],
  [19, "resolved", "web", "high", "technical", "lt", false, 40, 2, "Orbit Studio", "Felix Baum",
    "Dashboard charts blank after switching workspace",
    "Cached workspace id caused empty queries. Fixed in 4.18.2."],
  [7, "closed", "chat", "none", "subscription", "lt", false, 200, -100, "Acme Corp", "Grace Liu",
    "Close out unused seats after the regional team restructure",
    "Removed 46 unused seats and confirmed the prorated credit."],
  [17, "closed", "chat", "none", "other", "np", false, 160, -60, "Pine & Peak", "Dana Whitfield",
    "Broken help article is slowing onboarding conversion",
    "The article link was fixed and the docs team added a redirect."],
  [20, "closed", "email", "none", "billing", "np", false, 150, -40, "Northwind", "Omar Reyes",
    "Remove former admin from billing contacts",
    "Billing contacts updated; former admin no longer receives invoices."],
];

/** Fresh demo tickets with dates relative to `now`. @param {number} now @returns {Ticket[]} */
export function seedTickets(now) {
  return rows.map(([number, status, channel, priority, category, assignee, escalated, ago, due, customer, contact, subject, description]) => {
    const createdAt = now - ago * hour;
    /** @type {Activity[]} */
    const activity = [
      { at: createdAt, who: contact, kind: "reply", text: description },
      { at: createdAt + 0.4 * hour, who: "system", kind: "event", text: `Created from ${channelOf(channel).label.toLowerCase()}` },
    ];
    if (assignee) activity.push({ at: createdAt + 0.6 * hour, who: "system", kind: "event", text: `Assigned to ${person(assignee)?.name}` });
    if (status === "pending") activity.push({ at: createdAt + 3 * hour, who: assignee ?? "jl", kind: "reply", text: "Thanks — we're looking into this and will follow up shortly." });
    if (escalated) activity.push({ at: createdAt + 4 * hour, who: "system", kind: "event", text: "Escalated to tier 2" });
    return {
      number, subject, customer, contact, channel, category, priority, status, assignee, escalated,
      createdAt, dueAt: now + due * hour, description, activity,
      type: category === "technical" ? (priority === "urgent" || priority === "high" ? "incident" : "problem") : category === "other" ? "task" : "question",
      // The newest urgent and high-priority conversations start unread.
      snoozedUntil: number === 18 ? now + 20 * hour : 0,
      seenAt: isActive({ status }) && (priority === "urgent" || priority === "high") && ago < 60 ? 0 : now,
    };
  });
}

// ------------------------------------------------------------- notifications

/** @typedef {"mention" | "sla" | "reply" | "assign" | "automation"} NoticeKind */

/**
 * @typedef {object} Notice
 * @property {string} id
 * @property {NoticeKind} kind
 * @property {string} actor     shown bold
 * @property {string} action
 * @property {string} target    shown bold
 * @property {string} body
 * @property {number | null} ticket  the ticket it opens
 * @property {number} at
 * @property {boolean} read
 */

export const noticeIcons = { mention: "at", sla: "warning", reply: "bubble", assign: "user-check", automation: "zap-off" };

/** @param {number} now @returns {Notice[]} */
export function seedNotices(now) {
  const min = 60_000;
  /** @type {[NoticeKind, string, string, string, string, number | null, number, boolean][]} */
  const items = [
    ["mention", "Nina Park", "mentioned you in", "Ticket #-001", "Can you confirm the onboarding handoff?", 1, 5, false],
    ["sla", "SLA monitor", "reported a breach on", "Ticket #-003", "Enterprise rollout is waiting on an ownership decision.", 3, 12, false],
    ["reply", "Pine & Peak", "replied to", "your assigned conversation", "We can share the activation cohort export today.", 1, 24, false],
    ["assign", "Marcus Hale", "assigned you to", "Ticket #-002", "Salesforce health sync escalation", 2, 42, false],
    ["automation", "Automation", "failed to run", "VIP escalation routing", "The ticket remains unchanged. Review the rule configuration.", null, 60, false],
    ["reply", "Brightline", "replied to", "Ticket #-011", "Any update on the prorated credit?", 11, 26 * 60, true],
    ["assign", "Leah Tran", "assigned you to", "Ticket #-018", "Renewal date question from Northwind", 18, 28 * 60, true],
    ["sla", "SLA monitor", "warned about", "Ticket #-009", "Response due within 6 hours.", 9, 30 * 60, true],
  ];
  return items.map(([kind, actor, action, target, body, ticket, ago, read], index) =>
    ({ id: `seed-${index}`, kind, actor, action, target, body, ticket, at: now - ago * min, read }));
}

/** Quotes a CSV field. @param {unknown} value */
const field = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** @param {Ticket[]} tickets @param {number} now */
export function toCsv(tickets, now) {
  const header = ["ID", "Subject", "Customer", "Status", "Priority", "Category", "Channel", "Assignee", "SLA", "Created", "Due"];
  const lines = tickets.map((t) => [
    code(t.number), t.subject, t.customer, statusOf(t.status).label, priorityOf(t.priority).label,
    categoryOf(t.category).label, channelOf(t.channel).label, person(t.assignee)?.name ?? "Unassigned",
    slaLabels[slaOf(t, now)], new Date(t.createdAt).toISOString(), new Date(t.dueAt).toISOString(),
  ].map(field).join(","));
  return [header.join(","), ...lines].join("\n");
}

// ------------------------------------------------------------------ customers

/** @typedef {"strategic" | "enterprise" | "growth" | "midmarket" | "smb"} Segment */
/** @typedef {"onboarding" | "active" | "renewal" | "paused" | "archived"} Lifecycle */
/** @typedef {"at_risk" | "watch" | "healthy"} Health */

/**
 * @typedef {object} Customer
 * @property {string} id
 * @property {string} name       the primary contact
 * @property {string} email
 * @property {string} organization
 * @property {string} tier       the plan
 * @property {Segment} segment
 * @property {Lifecycle} lifecycle
 * @property {Health} health
 * @property {string | null} owner  a person id
 * @property {number} csat
 */

export const segments = /** @type {const} */ ([
  { id: "strategic", label: "Strategic" },
  { id: "enterprise", label: "Enterprise" },
  { id: "growth", label: "Growth" },
  { id: "midmarket", label: "Mid-market" },
  { id: "smb", label: "SMB" },
]);

export const lifecycles = /** @type {const} */ ([
  { id: "onboarding", label: "Onboarding" },
  { id: "active", label: "Active" },
  { id: "renewal", label: "Renewal" },
  { id: "paused", label: "Paused" },
  { id: "archived", label: "Archived" },
]);

export const healths = /** @type {const} */ ([
  { id: "at_risk", label: "At risk", rank: 0 },
  { id: "watch", label: "Watch", rank: 1 },
  { id: "healthy", label: "Healthy", rank: 2 },
]);

/** @param {string} id */
export const segmentOf = (id) => segments.find((s) => s.id === id) ?? segments[4];
/** @param {string} id */
export const lifecycleOf = (id) => lifecycles.find((l) => l.id === id) ?? lifecycles[1];
/** @param {string} id */
export const healthOf = (id) => healths.find((h) => h.id === id) ?? healths[2];

/** @param {string} text */
export const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Up to two initials. @param {string} name */
export const initialsOf = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("").slice(0, 2);

// [organization, contact, domain, tier, segment, lifecycle, health, owner, csat]
/** @type {[string, string, string, string, Segment, Lifecycle, Health, string | null, number][]} */
const accounts = [
  ["Polar Banking", "Marcus Lind", "polarbanking.fi", "Enterprise", "strategic", "active", "at_risk", "jl", 3.8],
  ["Blueforge Labs", "Mina Alavi", "blueforge.ai", "Scale", "growth", "renewal", "at_risk", "np", 4.0],
  ["Summit Grid", "Leah Morgan", "summitgrid.energy", "Enterprise", "strategic", "renewal", "at_risk", "jl", 3.9],
  ["Prism Health", "Aiden Bell", "prismhealth.org", "Enterprise", "strategic", "onboarding", "at_risk", "mh", 4.1],
  ["Lattice Cloud", "Amelia Chen", "latticecloud.io", "Enterprise", "strategic", "active", "watch", "lt", 4.3],
  ["Riverbank Insure", "Talia Moore", "riverbankinsure.com", "Scale", "enterprise", "renewal", "watch", "np", 4.4],
  ["AeroLoft", "Nina Foster", "aeroloft.co", "Growth", "midmarket", "active", "watch", "mh", 4.5],
  ["Maple Security", "Evelyn Clarke", "maplesecurity.ca", "Enterprise", "enterprise", "active", "watch", "jl", 4.2],
  ["CloudMint Finance", "Sienna Walsh", "cloudmintfinance.com", "Growth", "growth", "paused", "watch", "lt", 4.6],
  ["Fieldhouse Retail", "Jared Wong", "fieldhouse-retail.com", "Growth", "midmarket", "active", "watch", "np", 4.4],
  ["Acme Corp", "Grace Liu", "acme.com", "Enterprise", "enterprise", "renewal", "healthy", "jl", 4.7],
  ["Northwind", "Omar Reyes", "northwind.com", "Enterprise", "enterprise", "active", "healthy", "jl", 4.6],
  ["Pine & Peak", "Dana Whitfield", "pineandpeak.com", "Scale", "growth", "onboarding", "healthy", "np", 4.8],
  ["Helio Labs", "Priya Shah", "helio-labs.com", "Scale", "midmarket", "active", "healthy", "mh", 4.5],
  ["Brightline", "Ken Ito", "brightline.io", "Growth", "midmarket", "active", "healthy", "mh", 4.3],
  ["Atlas Health", "Rosa Lindqvist", "atlashealth.com", "Enterprise", "enterprise", "active", "healthy", "lt", 4.9],
  ["Ferro Logistics", "Theo Grant", "ferro.io", "Growth", "midmarket", "onboarding", "healthy", "np", 4.4],
  ["Lumen Retail", "Ava Moreno", "lumenretail.com", "Starter", "smb", "active", "healthy", "lt", 4.7],
  ["Orbit Studio", "Felix Baum", "orbit.studio", "Starter", "smb", "archived", "healthy", "mh", 4.6],
];

/** @returns {Customer[]} */
export function seedCustomers() {
  return accounts.map(([organization, name, domain, tier, segment, lifecycle, health, owner, csat]) => ({
    id: slug(organization), name, email: `${name.split(" ")[0].toLowerCase()}@${domain}`,
    organization, tier, segment, lifecycle, health, owner, csat,
  }));
}

/** @param {Customer[]} customers @param {(c: Customer) => number} openTickets */
export function customersCsv(customers, openTickets) {
  const header = ["Name", "Email", "Organization", "Plan", "Segment", "Lifecycle", "Health", "Owner", "CSAT", "Open tickets"];
  const lines = customers.map((c) => [
    c.name, c.email, c.organization, c.tier, segmentOf(c.segment).label, lifecycleOf(c.lifecycle).label,
    healthOf(c.health).label, person(c.owner)?.name ?? "", c.csat.toFixed(1), openTickets(c),
  ].map(field).join(","));
  return [header.join(","), ...lines].join("\n");
}

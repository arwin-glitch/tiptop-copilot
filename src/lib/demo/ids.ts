/**
 * Stable, human-readable identifiers for demo records.
 *
 * Fixed UUIDs (rather than generated ones) mean demo URLs are stable across
 * resets, so documentation and e2e tests can link directly to a record.
 */

const NS = '00000000-0000-4000-8000-';

function id(n: number): string {
  return `${NS}${n.toString(16).padStart(12, '0')}`;
}

export const DEMO_IDS = {
  org: id(1),
  user: id(2),
  // A second person on the team, so tasks can be assigned and filtered.
  userTeammate: id(3),

  // Deals
  dealVetrix: id(100),
  dealGirder: id(101),
  dealPlumbline: id(102),
  dealLoomstack: id(103),
  dealHalyard: id(104),
  // Deals the deal-sorter routine posted (sample relay data)
  dealQuarrystone: id(105),
  dealTidewell: id(106),
  dealFernhollow: id(107),
  dealBrightkiln: id(108),
  dealMossgate: id(109),

  // Portfolio
  pcLedgerly: id(200),
  pcStonebridge: id(201),

  // Email threads
  threadVetrix: id(300),
  threadGirder: id(301),
  threadLedgerly: id(302),
  threadLoomstack: id(303),
  threadLpUpdate: id(304),
  threadStonebridge: id(305),
  threadNewsletter: id(306),
  threadCoInvestor: id(307),
  threadPlumbline: id(308),

  // Email messages
  msgVetrixIntro: id(400),
  msgVetrixFollowUp: id(401),
  msgGirderUpdate: id(402),
  msgLedgerlyRequest: id(403),
  msgLoomstackPitch: id(404),
  msgLpQuestion: id(405),
  msgStonebridgeHiring: id(406),
  msgNewsletter: id(407),
  msgCoInvestor: id(408),
  msgPlumblineIntro: id(409),

  // Attachments
  attVetrixDeck: id(500),
  attLedgerlyMetrics: id(501),

  // Knowledge
  docThesis: id(600),
  docPassNotes: id(601),
  docNetworkCsv: id(602),
  docMarketMap: id(603),

  // Network contacts
  contactRivera: id(700),
  contactOkafor: id(701),
  contactLindqvist: id(702),
  contactBaptiste: id(703),

  // Calendar
  eventStandup: id(800),
  eventGirderCall: id(801),
  eventLedgerlyBoard: id(802),
  eventLpCoffee: id(803),

  // Tasks
  taskVetrixDiligence: id(900),
  taskGirderRefs: id(901),
  taskLedgerlyIntros: id(902),
  taskLoomstackPass: id(903),
  taskStonebridgeJd: id(904),
  taskGirderOnboarding: id(905),
  taskLpTimeline: id(906),
  auditLpTimelineClosed: id(907),
  // Money and legal tasks (Tasks → Money & legal)
  taskSideLetter: id(908),
  taskWireCheck: id(909),
  auditWireNeedsProof: id(910),
  // Ticked by hand, with the proof check's verdicts (Tasks → Completed, Today)
  taskProofSeen: id(911),
  auditProofSeenExpected: id(912),
  auditProofSeen: id(913),
  taskProofFlaggedDone: id(914),
  auditProofFlaggedDoneExpected: id(915),
  taskProofFlaggedReopen: id(916),
  auditProofFlaggedReopenExpected: id(917),

  // Thesis
  thesisV1: id(1000),

  // Analyses / decisions
  analysisGirder: id(1100),
  analysisLoomstack: id(1101),
  decisionHalyard: id(1200),
  decisionLoomstack: id(1201),

  // Portfolio updates
  updateLedgerly: id(1300),
  updateStonebridge: id(1301),

  // Meeting notes (Granola)
  noteGirderDebrief: id(1500),
  noteLedgerlyBoard: id(1501),

  // Integrations
  integrationGoogle: id(1400),

  // CRM lists (records, entries and notes are numbered: see demoCrmId)
  crmListDeals: id(1600),
  crmListLps: id(1601),
  crmListPortfolio: id(1602),
  // One small list per destination the rules know (lib/crm/destinations.ts).
  crmListWatch: id(1603),
  crmListAngel: id(1604),
  crmListFounders: id(1605),
  crmListCoinvestors: id(1606),
  crmListProviders: id(1607),
  crmListOperators: id(1608),
  crmListSponsors: id(1609),
  crmListNewsletter: id(1610),
  crmListMisc: id(1611),
  // Lists the Records pages read alongside Copilot's own data: a second deal
  // list matching Copilot deals, an LP pipeline with a likelihood column, and
  // an event invite list.
  crmListSeedDeals: id(1612),
  crmListHnwi: id(1613),
  crmListInvites: id(1614),

  // Campaigns (recipients and events are numbered: see demoCampaignId)
  campaignQ3Update: id(2000),
  campaignDraft: id(2001),
} as const;

/** CRM fixture ids, by kind and index: records 1700–1799, entries 1800–1899, notes 1900–1999. */
export function demoCrmId(kind: 'record' | 'entry' | 'note', n: number): string {
  return id({ record: 1700, entry: 1800, note: 1900 }[kind] + n);
}

/** "At a glance" fixture ids, by kind and index: tasks 920–939, their glance rows 940–959. */
export function demoGlanceId(kind: 'task' | 'audit', n: number): string {
  return id((kind === 'task' ? 920 : 940) + n);
}

/** Campaign fixture ids, by kind and index: recipients 2100–2199, events 2200–2299. */
export function demoCampaignId(kind: 'recipient' | 'event', n: number): string {
  return id({ recipient: 2100, event: 2200 }[kind] + n);
}

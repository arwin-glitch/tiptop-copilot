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

  // Deals
  dealVetrix: id(100),
  dealGirder: id(101),
  dealPlumbline: id(102),
  dealLoomstack: id(103),
  dealHalyard: id(104),

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

  // Integrations
  integrationGoogle: id(1400),
} as const;

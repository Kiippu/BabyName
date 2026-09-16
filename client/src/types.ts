export interface NameCard {
  id: number;
  name: string;
  origin: string;
  meaning: string;
}

// CO-4 §3/§5: the PIN gate replaces the picker -- there's nothing to pick
// from any more, the PIN itself is the claim. candidates is gone from the
// payload accordingly.
export interface Me {
  userId: number | null;
  label: string | null;
  surname: string | null;
  claimed: boolean;
}

// Change Order 1 ("Shortlist"): dropped the Elo/duel/veto model entirely —
// a row's standing is now just how many rounds it has survived, plus a
// selectivity tiebreaker computed server-side (server/src/list.js). "Out"
// names carry the round number they fell in instead of a "match"/"vetoedBy"
// pair, since there's no strike-out any more — a name leaves by failing to
// be kept in a sealed round.
export type ListTab = "in" | "out";

export interface ListRow {
  id: number;
  name: string;
  origin: string;
  meaning: string;
  roundsSurvived: number;
  eliminatedIn: number | null;
}

export interface Stats {
  rounds: number;
  stillIn: number;
  totalNames: number;
  agreement: number;
}

export interface PersonSettings {
  name: string;
  surname: string;
}

export type BabySurnameMode = "father" | "mother" | "both" | "undecided";

export interface Settings {
  father: PersonSettings;
  mother: PersonSettings;
  babySurname: BabySurnameMode;
  setupDone: boolean;
}

// Change Order 1 (Rounds): a round is 5 sets of 6 names. See server/src/rounds.js.
// heldCount is deliberately absent here (owner's live call, post-launch
// testing) — the server's toLiveCard withholds it while a name is actively
// being judged in a new round, so prior survival can't anchor the decision.
// It reappears once the round is sealed, on RoundResultName below.
export interface RoundName {
  id: number;
  name: string;
  origin: string;
  meaning: string;
}

export interface RoundPayload {
  roundId: number;
  number: number;
  setIndex: number;
  setsTotal: number;
  names: RoundName[] | null; // null while waiting on partner, or once resultReady
  waiting: boolean;
  partnerSetsDone?: number; // only present while waiting: 0-5, drives the progress meter
  resultReady?: boolean; // this round is sealed and this person hasn't seen its recap yet
  // Change Order 2 §2: the theme this round's newcomers were drawn from, or
  // null (no newcomers needed, or the deck was exhausted for a themed draw).
  themeTitle: string | null;
}

// Build order step 4 ("Seal -> waiting -> round result"). See
// server/src/rounds.js's getRoundResult and nameplate-change-order.md's
// "The round result — build this properly" section.
export interface RoundResultName {
  id: number;
  name: string;
  origin: string;
  meaning: string;
  heldCount: number; // rounds_survived AFTER this round settled
}

export interface RoundResultChip {
  id: number;
  name: string;
  origin?: string;
  meaning?: string;
}

export interface RoundResultPayload {
  roundId: number;
  number: number;
  totalNames: number;
  through: RoundResultName[]; // both parents kept — the brass group
  mineOnly: RoundResultChip[]; // this viewer kept it, partner didn't
  theirsOnly: RoundResultChip[]; // partner kept it, this viewer didn't
  out: RoundResultChip[]; // neither kept it
  partnerLabel: string;
  // Change Order 2 §2: teases the next round's likely theme(s), or the
  // actual committed one if that round has already been assembled. Null
  // when no theme applies (e.g. no newcomers needed, or deck exhausted).
  nextThemeHint: string | null;
}

export interface SetLockResult {
  sealed?: boolean;
  nextSet?: RoundPayload;
}

// Change Order 3 build order step 6 (themes screen). nameCount is inherited
// for a region (server/src/themes.js) since names never link to one directly
// -- see change-order-3-packs.md. children is only ever populated for a
// region (its cultures); toggling a theme's `enabled` never touches children.
export interface ThemeNode {
  id: number;
  slug: string;
  title: string;
  kind: "region" | "culture" | "collection";
  enabled: boolean;
  nameCount: number;
  children: ThemeNode[];
}

export interface ThemePack {
  id: number;
  slug: string;
  title: string;
  blurb: string | null;
  themes: ThemeNode[];
}

// Backs the name detail sheet (build spec §6 "Shortlist" — server/src/detail.js).
// Change Order 2 §1 replaced the round-by-round history list with plain
// counts; only sealed rounds count toward them (blind reveal).
export interface NameDetail {
  id: number;
  name: string;
  origin: string;
  meaning: string;
  auRank: number | null;
  fullNames: string[];
  roundsSurvived: number;
  eliminatedIn: number | null;
  youKeptCount: number;
  partnerLabel: string;
  partnerKeptCount: number;
  firstSeenRound: number | null;
}

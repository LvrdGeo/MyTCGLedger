/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - recognition-source-fixture.js
   ────────────────────────────────────────────────────────────────────────────
   MyTCG VISION — BATCH B: deterministic source adapter for TESTS ONLY.

   WHY THIS EXISTS: the build sandbox blocks every external host, so the real
   provider could not be called and its terms could not be read. This adapter
   emits data in the PROVIDER'S response shape so the importer, validator,
   staging and commit paths are exercised exactly as they will be against the
   live API — only the transport differs.

   ⚠ THIS IS NOT REAL CARD DATA. Values are synthetic and clearly marked with a
   'FIXTURE' set name. It deliberately includes the awkward shapes a real set
   contains — secret rares where number > total, alphanumeric numbers, leading
   zeros, a duplicate provider row, and malformed rows — so validation and
   idempotency are proven against realistic input rather than a tidy sample.
   ════════════════════════════════════════════════════════════════════════════ */

const FIXTURE_SET_ID = 'fixtureset1';
// printedTotal (60) is what a card physically shows; total (72) additionally
// counts secret rares — mirroring how the real provider reports a set with
// secret rares. The importer must index on printedTotal.
const _FIXTURE_SET = { id: FIXTURE_SET_ID, name: 'FIXTURE Test Set',
                       printedTotal: 60, total: 72,
                       ptcgoCode: 'FIX', releaseDate: '2021/08/27' };

function _fx(id, name, number, rarity, hp, extra){
  return Object.assign({ id: FIXTURE_SET_ID + '-' + id, name, number, rarity, hp,
    supertype: 'Pokémon', set: _FIXTURE_SET,
    images: { small: 'https://example.invalid/' + id + '.png' } }, extra || {});
}

// mutate=true returns a CHANGED source, to prove update-detection works.
function fixtureCards(mutate){
  return [
    _fx('1',   'Alpha Bird',    '1',        'Common',      60),
    _fx('7',   'Beta Beast',    '007',      'Uncommon',    90),          // leading zeros
    _fx('25',  'Gamma Cat',     '25',       'Rare Holo',   120),
    _fx('44',  'Delta Mime',    '44',       'Common',      70),
    _fx('45',  'Delta Mime Jr', '45',       'Common',      50),          // similar name
    _fx('60',  'Epsilon Drake', '60',       'Rare',        mutate ? 180 : 150),  // CHANGES on mutate
    _fx('61',  'Zeta Secret',   '61',       'Secret Rare', 220),         // 61/60 -> number > total
    _fx('TG05','Eta Gallery',   'TG05',     'Ultra Rare',  200),         // alphanumeric
    _fx('SV9', 'Theta Shiny',   'SV9',      'Shiny Rare',  110),         // alphanumeric
    _fx('P1',  'Iota Promo',    'P1',       'Promo',       130)
  ];
}

const fixtureSourceAdapter = {
  id: 'fixture/deterministic',
  async fetchSet(setId, opts){
    const o = opts || {};
    if (o.simulateFetchFailure) throw new Error('simulated network failure');
    let cards = fixtureCards(!!o.mutate);
    if (o.includeDuplicate) cards = cards.concat([cards[0]]);          // same provider row twice
    if (o.includeMalformed) cards = cards.concat([
      _fx('bad1', '',      '99', 'Common', 10),                        // empty name
      Object.assign(_fx('bad2','Nameless','', 'Common', 10), { number:'' }),  // no number
      { id:'', name:'No Id', number:'98', set:_FIXTURE_SET }           // missing canonical id
    ]);
    return { setId, sourceVersion: adapterSourceVersion(cards), cards, reportedTotal: cards.length };
  },
  normalizeCard(raw){ return ptcgSourceAdapter.normalizeCard(raw); }   // SAME normalizer as production
};

/* ════════════════════════════════════════════════════════════════════════════
   MyTCG Ledger V6 - recognition-fixtures.js
   ────────────────────────────────────────────────────────────────────────────
   MyTCG VISION — BATCH A fixture seeder. DEVELOPMENT AND TESTS ONLY.

   These 24 Pokémon cards were chosen to CREATE the hard cases, not to make the
   ranker look good. A fixture set of unrelated cards would prove nothing.

   Deliberate traps built in:
     · same Pokémon across sets      Charizard in base1 / swsh45 / xy2
     · SAME number, DIFFERENT sets   "4" appears in base1, xy2, sm1
     · similar names                 Rayquaza VMAX / Rayquaza V / Rayquaza-GX
     · promo + stamped promo         swshp SWSH123, and a stamped variant
     · alphanumeric numbers          TG23/TG30, GG44/GG70, SV107/SV122, SWSH123
     · secret rare denominator       199/165 (number > denominator — real)
     · multi-variant same printing   swsh7-215 normal / reverse / alt_art
     · Japanese language variant     same cardId, language 'ja'
     · metadata-insoluble case       swsh7-215 variants share name+set+number,
                                     so metadata ALONE cannot pick one. That is
                                     the case Batch D/E visual matching exists
                                     for, and Batch A must report it honestly
                                     as ambiguous rather than guess.
   ════════════════════════════════════════════════════════════════════════════ */

const RECOGNITION_FIXTURES = [
  // ── same Pokémon, three different sets, three different numbers ──────────
  { cardId:'base1-4',    name:'Charizard',      setId:'base1',  setName:'Base',            setAbbr:'BS',   number:'4/102',      year:1999, rarity:'Rare Holo',   cardType:'Pokémon', hp:120, variant:'holo' },
  { cardId:'swsh45-25',  name:'Charizard',      setId:'swsh45', setName:'Shining Fates',   setAbbr:'SHF',  number:'25/72',      year:2021, rarity:'Rare',        cardType:'Pokémon', hp:170, variant:'normal' },
  { cardId:'xy2-4',      name:'Charizard',      setId:'xy2',    setName:'Flashfire',       setAbbr:'FLF',  number:'4/106',      year:2014, rarity:'Rare',        cardType:'Pokémon', hp:150, variant:'normal' },

  // ── SAME collector number "4", different sets — number alone is ambiguous ─
  { cardId:'sm1-4',      name:'Decidueye-GX',   setId:'sm1',    setName:'Sun & Moon',      setAbbr:'SUM',  number:'4/149',      year:2017, rarity:'Ultra Rare',  cardType:'Pokémon', hp:240, variant:'holo' },

  // ── similar names, same Pokémon line ─────────────────────────────────────
  { cardId:'swsh7-218',  name:'Rayquaza VMAX',  setId:'swsh7',  setName:'Evolving Skies',  setAbbr:'EVS',  number:'218/203',    year:2021, rarity:'Secret Rare', cardType:'Pokémon', hp:320, variant:'alt_art' },
  { cardId:'swsh7-110',  name:'Rayquaza V',     setId:'swsh7',  setName:'Evolving Skies',  setAbbr:'EVS',  number:'110/203',    year:2021, rarity:'Ultra Rare',  cardType:'Pokémon', hp:210, variant:'normal' },
  { cardId:'sm7-177a',   name:'Rayquaza-GX',    setId:'sm7',    setName:'Celestial Storm',  setAbbr:'CES', number:'177a/168',   year:2018, rarity:'Secret Rare', cardType:'Pokémon', hp:180, variant:'alt_art' },

  // ── THE METADATA-INSOLUBLE CASE: one printing, three presentations ───────
  //     identical name + set + number; only variant differs.
  { cardId:'swsh7-215',  name:'Umbreon VMAX',   setId:'swsh7',  setName:'Evolving Skies',  setAbbr:'EVS',  number:'215/203',    year:2021, rarity:'Secret Rare', cardType:'Pokémon', hp:320, variant:'alt_art' },
  { cardId:'swsh7-215',  name:'Umbreon VMAX',   setId:'swsh7',  setName:'Evolving Skies',  setAbbr:'EVS',  number:'215/203',    year:2021, rarity:'Secret Rare', cardType:'Pokémon', hp:320, variant:'normal' },
  { cardId:'swsh7-215',  name:'Umbreon VMAX',   setId:'swsh7',  setName:'Evolving Skies',  setAbbr:'EVS',  number:'215/203',    year:2021, rarity:'Secret Rare', cardType:'Pokémon', hp:320, variant:'reverse' },

  // ── Japanese language variant of an existing printing ────────────────────
  { cardId:'swsh7-215',  name:'ブラッキーVMAX',  setId:'swsh7',  setName:'Evolving Skies',  setAbbr:'EVS',  number:'215/203',    year:2021, rarity:'Secret Rare', cardType:'Pokémon', hp:320, variant:'alt_art', language:'ja' },

  // ── alphanumeric collector numbers ───────────────────────────────────────
  { cardId:'swsh9-TG23', name:'Giratina V',     setId:'swsh9',  setName:'Brilliant Stars', setAbbr:'BRS',  number:'TG23/TG30',  year:2022, rarity:'Ultra Rare',  cardType:'Pokémon', hp:220, variant:'holo' },
  { cardId:'swsh12-GG44',name:'Mewtwo V',       setId:'swsh12', setName:'Crown Zenith',    setAbbr:'CRZ',  number:'GG44/GG70',  year:2023, rarity:'Ultra Rare',  cardType:'Pokémon', hp:220, variant:'holo' },
  { cardId:'sv1-SV107',  name:'Pikachu',        setId:'sv1',    setName:'Scarlet & Violet',setAbbr:'SVI',  number:'SV107/SV122',year:2023, rarity:'Shiny Rare',  cardType:'Pokémon', hp:60,  variant:'holo' },

  // ── promo, and a stamped promo of the SAME printing ──────────────────────
  { cardId:'swshp-SWSH123', name:'Charizard V',  setId:'swshp', setName:'SWSH Black Star Promos', setAbbr:'PR', number:'SWSH123', year:2021, rarity:'Promo', cardType:'Pokémon', hp:220, variant:'promo' },
  { cardId:'swshp-SWSH123', name:'Charizard V',  setId:'swshp', setName:'SWSH Black Star Promos', setAbbr:'PR', number:'SWSH123', year:2021, rarity:'Promo', cardType:'Pokémon', hp:220, variant:'stamped_promo' },

  // ── secret rare: number GREATER than denominator (not a typo) ────────────
  { cardId:'sm3-199',    name:'Gardevoir-GX',   setId:'sm3',    setName:'Burning Shadows', setAbbr:'BUS',  number:'199/165',    year:2017, rarity:'Secret Rare', cardType:'Pokémon', hp:230, variant:'holo' },

  // ── vintage 1st edition vs unlimited, same printing ──────────────────────
  { cardId:'base1-58',   name:'Pikachu',        setId:'base1',  setName:'Base',            setAbbr:'BS',   number:'58/102',     year:1999, rarity:'Common',      cardType:'Pokémon', hp:40,  variant:'first_edition' },
  { cardId:'base1-58',   name:'Pikachu',        setId:'base1',  setName:'Base',            setAbbr:'BS',   number:'58/102',     year:1999, rarity:'Common',      cardType:'Pokémon', hp:40,  variant:'unlimited' },

  // ── names that normalize close but must stay distinct ────────────────────
  { cardId:'base1-1',    name:'Alakazam',       setId:'base1',  setName:'Base',            setAbbr:'BS',   number:'1/102',      year:1999, rarity:'Rare Holo',   cardType:'Pokémon', hp:80,  variant:'holo' },
  { cardId:'neo1-1',     name:'Ampharos',       setId:'neo1',   setName:'Neo Genesis',     setAbbr:'N1',   number:'1/111',      year:2000, rarity:'Rare Holo',   cardType:'Pokémon', hp:90,  variant:'holo' },
  { cardId:'swsh4-44',   name:'Mr. Mime',       setId:'swsh4',  setName:'Vivid Voltage',   setAbbr:'VIV',  number:'44/185',     year:2020, rarity:'Common',      cardType:'Pokémon', hp:70,  variant:'normal' },
  { cardId:'swsh4-45',   name:'Mime Jr.',       setId:'swsh4',  setName:'Vivid Voltage',   setAbbr:'VIV',  number:'45/185',     year:2020, rarity:'Common',      cardType:'Pokémon', hp:50,  variant:'normal' },
  { cardId:'xy11-51',    name:"Farfetch'd",     setId:'xy11',   setName:'Steam Siege',     setAbbr:'STS',  number:'51/114',     year:2016, rarity:'Common',      cardType:'Pokémon', hp:70,  variant:'normal' }
];

// Seeds the local store. Idempotent: seeding twice yields the same record count.
async function seedRecognitionFixtures(){
  const recs = RECOGNITION_FIXTURES.map(function(f){
    return makeRecognitionRecord(Object.assign({}, f, { sourceVersion:'fixture-a', updatedAt: Date.now() }));
  });
  const res = await rcPutRecords(recs);
  await rcSetMeta('catalogVersion', 'batch-a-fixtures-1');
  await rcSetMeta('schemaVersion', RECOGNITION_SCHEMA_VERSION);
  await rcSetMeta('sourceVersion', 'fixture-a');
  await rcSetMeta('updatedAt', Date.now());
  return Object.assign({}, res, { fixtures: RECOGNITION_FIXTURES.length, unique: new Set(recs.map(rcRecordKey)).size });
}

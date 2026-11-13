// The 5e Ranger, as dnd5e.wikidot.com/ranger lays it out: the class table, the choices it asks for at each level,
// and the eight official conclaves (subclasses) with their features at 3, 7, 11 and 15. Optional and Unearthed Arcana
// rules are left out. Pure data: the game reads it, the Adventure view draws it.

export type ClassOption = { id: string; name: string; blurb: string }
export type ClassChoice = {
  id: string
  level: number
  title: string
  /** What the choice is for, in a line. */
  why: string
  options: ClassOption[]
  /** Only for this conclave. */
  conclave?: string
}
export type ClassFeature = { name: string; blurb: string }
export type Conclave = {
  id: string
  name: string
  source: string
  link: string
  flavor: string
  /** Its features by ranger level (3, 7, 11, 15). */
  features: Record<number, ClassFeature[]>
}

/** The class table's features by level. "Ranger Conclave" and "Conclave feature" become the chosen conclave's own. */
export const FEATURES: Record<number, string[]> = {
  1: ['Favored Enemy', 'Natural Explorer'],
  2: ['Fighting Style', 'Spellcasting'],
  3: ['Primeval Awareness', 'Ranger Conclave'],
  4: ['Ability Score Improvement'],
  5: ['Extra Attack'],
  6: ['Favored Enemy Improvement', 'Natural Explorer Improvement'],
  7: ['Conclave feature'],
  8: ['Ability Score Improvement', "Land's Stride"],
  10: ['Natural Explorer Improvement', 'Hide in Plain Sight'],
  11: ['Conclave feature'],
  12: ['Ability Score Improvement'],
  14: ['Favored Enemy Improvement', 'Vanish'],
  15: ['Conclave feature'],
  16: ['Ability Score Improvement'],
  18: ['Feral Senses'],
  19: ['Ability Score Improvement'],
  20: ['Foe Slayer'],
}

export const CONCLAVE_LEVELS = [3, 7, 11, 15]

const ENEMIES: ClassOption[] = [
  ['aberrations', 'Aberrations', 'Alien minds from beyond the planes'],
  ['beasts', 'Beasts', 'Natural animals, great and small'],
  ['celestials', 'Celestials', 'Angels and creatures of the upper planes'],
  ['constructs', 'Constructs', 'Golems, animated armor, made things'],
  ['dragons', 'Dragons', 'Wyrms, drakes and their kin'],
  ['elementals', 'Elementals', 'Living fire, earth, air and water'],
  ['fey', 'Fey', 'Tricksters of the Feywild'],
  ['fiends', 'Fiends', 'Demons and devils'],
  ['giants', 'Giants', 'Ogres, trolls and true giants'],
  ['monstrosities', 'Monstrosities', 'Unnatural beasts: owlbears, hydras'],
  ['oozes', 'Oozes', 'Puddings, jellies and cubes'],
  ['plants', 'Plants', 'Shambling mounds and blights'],
  ['undead', 'Undead', 'Zombies, ghouls, vampires'],
  ['humanoids', 'Two humanoid races', 'Say, gnolls and orcs'],
].map(([id, name, blurb]) => ({ id: id as string, name: name as string, blurb: blurb as string }))

const TERRAINS: ClassOption[] = [
  ['arctic', 'Arctic', 'Ice fields and frozen tundra'],
  ['coast', 'Coast', 'Shores, cliffs and tide pools'],
  ['desert', 'Desert', 'Dunes and badlands'],
  ['forest', 'Forest', 'Deep woods and old growth'],
  ['grassland', 'Grassland', 'Plains and open steppe'],
  ['mountain', 'Mountain', 'Peaks, passes and screes'],
  ['swamp', 'Swamp', 'Bogs, fens and mire'],
  ['underdark', 'Underdark', 'The caverns beneath the world'],
].map(([id, name, blurb]) => ({ id: id as string, name: name as string, blurb: blurb as string }))

const ABILITIES: ClassOption[] = [
  ['str', '+2 Strength', 'Hit harder in melee, carry more'],
  ['dex', '+2 Dexterity', 'Bows, armor class, stealth'],
  ['con', '+2 Constitution', 'More hit points, steadier concentration'],
  ['int', '+2 Intelligence', 'Investigation and lore'],
  ['wis', '+2 Wisdom', 'Ranger spells, perception, survival'],
  ['cha', '+2 Charisma', 'Persuasion and presence'],
].map(([id, name, blurb]) => ({ id: id as string, name: name as string, blurb: blurb as string }))

export const CONCLAVES: Conclave[] = [
  {
    id: 'hunter',
    name: 'Hunter',
    source: "Player's Handbook",
    link: 'dnd5e.wikidot.com/ranger:hunter',
    flavor: 'Trains to defend settlements against the most dangerous monsters of the wild.',
    features: {
      3: [{ name: "Hunter's Prey", blurb: 'A hunting technique of your choice' }],
      7: [{ name: 'Defensive Tactics', blurb: 'A defense of your choice' }],
      11: [{ name: 'Multiattack', blurb: 'Strike many foes at once, your way' }],
      15: [{ name: "Superior Hunter's Defense", blurb: 'A last line of defense of your choice' }],
    },
  },
  {
    id: 'beast-master',
    name: 'Beast Master',
    source: "Player's Handbook",
    link: 'dnd5e.wikidot.com/ranger:beast-master',
    flavor: 'Fights as one with a beast companion.',
    features: {
      3: [{ name: "Ranger's Companion", blurb: 'A beast fights at your side and gains your proficiency' }],
      7: [{ name: 'Exceptional Training', blurb: 'Your beast can Dash, Disengage or Help, and its attacks count as magical' }],
      11: [{ name: 'Bestial Fury', blurb: 'Your beast attacks twice when you command it' }],
      15: [{ name: 'Share Spells', blurb: 'Spells you cast on yourself also reach your beast' }],
    },
  },
  {
    id: 'gloom-stalker',
    name: 'Gloom Stalker',
    source: "Xanathar's Guide to Everything",
    link: 'dnd5e.wikidot.com/ranger:gloom-stalker',
    flavor: 'At home in the darkest places, ambushing threats before they reach the world.',
    features: {
      3: [
        { name: 'Dread Ambusher', blurb: 'Wisdom to initiative, an extra attack and speed on your first turn' },
        { name: 'Umbral Sight', blurb: 'Darkvision, and invisible in darkness to those who rely on it' },
        { name: 'Gloom Stalker Magic', blurb: 'Bonus spells: Disguise Self, Rope Trick, Fear…' },
      ],
      7: [{ name: 'Iron Mind', blurb: 'Proficiency in Wisdom saving throws' }],
      11: [{ name: "Stalker's Flurry", blurb: 'A miss earns another attack, once per turn' }],
      15: [{ name: 'Shadowy Dodge', blurb: 'Your reaction gives an attacker disadvantage' }],
    },
  },
  {
    id: 'horizon-walker',
    name: 'Horizon Walker',
    source: "Xanathar's Guide to Everything",
    link: 'dnd5e.wikidot.com/ranger:horizon-walker',
    flavor: 'Guards the world against threats from other planes.',
    features: {
      3: [
        { name: 'Planar Warrior', blurb: 'Your marked foe takes force damage and an extra 1d8' },
        { name: 'Detect Portal', blurb: 'Sense the nearest planar portal within a mile' },
        { name: 'Horizon Walker Magic', blurb: 'Bonus spells: Protection from Evil and Good, Misty Step, Haste…' },
      ],
      7: [{ name: 'Ethereal Step', blurb: 'Step into the Ethereal Plane for a turn' }],
      11: [{ name: 'Distant Strike', blurb: 'Teleport 10 feet before each attack' }],
      15: [{ name: 'Spectral Defense', blurb: 'Resist all damage from one attack' }],
    },
  },
  {
    id: 'monster-slayer',
    name: 'Monster Slayer',
    source: "Xanathar's Guide to Everything",
    link: 'dnd5e.wikidot.com/ranger:monster-slayer',
    flavor: 'Hunts creatures of the night and wielders of grim magic.',
    features: {
      3: [
        { name: "Slayer's Prey", blurb: 'Your marked prey takes an extra 1d6 each turn' },
        { name: "Hunter's Sense", blurb: 'Learn a creature’s immunities, resistances and weaknesses' },
        { name: 'Monster Slayer Magic', blurb: 'Bonus spells: Protection from Evil and Good, Zone of Truth…' },
      ],
      7: [{ name: 'Supernatural Defense', blurb: '+1d6 to saves your prey forces' }],
      11: [{ name: "Magic-User's Nemesis", blurb: 'Your reaction can waste a spell or a teleport' }],
      15: [{ name: "Slayer's Counter", blurb: 'Strike your prey first; a hit wins your save' }],
    },
  },
  {
    id: 'fey-wanderer',
    name: 'Fey Wanderer',
    source: "Tasha's Cauldron of Everything",
    link: 'dnd5e.wikidot.com/ranger:fey-wanderer',
    flavor: 'Walks between the mortal world and the Feywild.',
    features: {
      3: [
        { name: 'Dreadful Strikes', blurb: 'Extra psychic damage once per turn' },
        { name: 'Otherworldly Glamour', blurb: 'Wisdom added to Charisma checks, and a social skill' },
        { name: 'Feywild Gifts', blurb: 'A minor fey blessing' },
        { name: 'Fey Wanderer Magic', blurb: 'Bonus spells: Charm Person, Misty Step, Dispel Magic…' },
      ],
      7: [{ name: 'Beguiling Twist', blurb: 'Resist charm and fear, and turn them on another' }],
      11: [{ name: 'Fey Reinforcements', blurb: 'Summon Fey, once a day for free' }],
      15: [{ name: 'Misty Wanderer', blurb: 'Free Misty Steps, bringing a friend along' }],
    },
  },
  {
    id: 'swarmkeeper',
    name: 'Swarmkeeper',
    source: "Tasha's Cauldron of Everything",
    link: 'dnd5e.wikidot.com/ranger:swarmkeeper',
    flavor: 'Bonded with a swarm of nature spirits.',
    features: {
      3: [
        { name: 'Gathered Swarm', blurb: 'Your swarm stings, shoves foes, or moves you after a hit' },
        { name: 'Swarmkeeper Magic', blurb: 'Mage Hand and bonus spells: Faerie Fire, Web…' },
      ],
      7: [{ name: 'Writhing Tide', blurb: 'Your swarm lifts you: a 10-foot fly speed' }],
      11: [{ name: 'Mighty Swarm', blurb: 'The swarm hits harder and can knock foes prone' }],
      15: [{ name: 'Swarming Dispersal', blurb: 'Dissolve into the swarm: resist and teleport 30 feet' }],
    },
  },
  {
    id: 'drakewarden',
    name: 'Drakewarden',
    source: "Fizban's Treasury of Dragons",
    link: 'dnd5e.wikidot.com/ranger:drakewarden',
    flavor: 'Bonded to a drake that grows into a winged mount.',
    features: {
      3: [
        { name: 'Drake Companion', blurb: 'A drake fights beside you and empowers allies’ hits' },
        { name: 'Draconic Gift', blurb: 'Thaumaturgy and a new language' },
      ],
      7: [{ name: 'Bond of Fang and Scale', blurb: 'Your drake grows wings and carries you' }],
      11: [{ name: "Drake's Breath", blurb: 'A 30-foot cone of breath, yours or your drake’s' }],
      15: [{ name: 'Perfected Bond', blurb: 'A Large drake with a fiercer bite' }],
    },
  },
]

const options = (list: [string, string, string][]): ClassOption[] => list.map(([id, name, blurb]) => ({ id, name, blurb }))

/** Every choice the class asks for, in level order. */
export const CHOICES: ClassChoice[] = [
  { id: 'enemy-1', level: 1, title: 'Favored Enemy', why: 'A kind of foe you know how to track and study', options: ENEMIES },
  { id: 'terrain-1', level: 1, title: 'Natural Explorer', why: 'The land you know best', options: TERRAINS },
  {
    id: 'style',
    level: 2,
    title: 'Fighting Style',
    why: 'How you fight',
    options: options([
      ['archery', 'Archery', '+2 to ranged attack rolls'],
      ['blind', 'Blind Fighting', 'See invisible foes within 10 feet'],
      ['defense', 'Defense', '+1 armor class while armored'],
      ['druidic', 'Druidic Warrior', 'Two druid cantrips, cast with Wisdom'],
      ['dueling', 'Dueling', '+2 damage with one weapon in one hand'],
      ['thrown', 'Thrown Weapon Fighting', 'Draw as you throw; +2 thrown damage'],
      ['two-weapon', 'Two-Weapon Fighting', 'Your ability bonus on the off-hand hit'],
    ]),
  },
  { id: 'conclave', level: 3, title: 'Ranger Conclave', why: 'Your subclass: it shapes your features at 3, 7, 11 and 15', options: CONCLAVES.map(one => ({ id: one.id, name: one.name, blurb: one.flavor })) },
  {
    id: 'hunter-3',
    level: 3,
    conclave: 'hunter',
    title: "Hunter's Prey",
    why: 'Your hunting technique',
    options: options([
      ['colossus', 'Colossus Slayer', 'Extra damage to a wounded target, once a turn'],
      ['giant', 'Giant Killer', 'Strike back at a Large foe that attacks you'],
      ['horde', 'Horde Breaker', 'Hit a second foe beside the first'],
    ]),
  },
  {
    id: 'companion',
    level: 3,
    conclave: 'beast-master',
    title: 'Companion',
    why: 'The beast at your side',
    options: options([
      ['land', 'Beast of the Land', 'Fast, climbs, its charge knocks foes prone'],
      ['sea', 'Beast of the Sea', 'Swims and breathes water, grapples'],
      ['sky', 'Beast of the Sky', 'Flies, slips away after striking'],
      ['hawk', 'Hawk', 'A classic companion'],
      ['mastiff', 'Mastiff', 'A classic companion'],
      ['panther', 'Panther', 'A classic companion'],
    ]),
  },
  {
    id: 'glamour',
    level: 3,
    conclave: 'fey-wanderer',
    title: 'Otherworldly Glamour',
    why: 'The social skill the fey teach you',
    options: options([
      ['deception', 'Deception', 'Lie with a fey smile'],
      ['performance', 'Performance', 'Hold a crowd'],
      ['persuasion', 'Persuasion', 'Win others over'],
    ]),
  },
  {
    id: 'swarm',
    level: 3,
    conclave: 'swarmkeeper',
    title: 'Gathered Swarm',
    why: 'What your swarm looks like',
    options: options([
      ['insects', 'Swarming insects', 'A buzzing cloud'],
      ['blights', 'Twig blights', 'Tiny walking twigs'],
      ['birds', 'Fluttering birds', 'A flurry of wings'],
      ['pixies', 'Playful pixies', 'Giggling lights'],
    ]),
  },
  {
    id: 'essence',
    level: 3,
    conclave: 'drakewarden',
    title: 'Drake Essence',
    why: "Your drake's damage type",
    options: options([
      ['acid', 'Acid', 'A green, hissing drake'],
      ['cold', 'Cold', 'A frost-white drake'],
      ['fire', 'Fire', 'An ember-red drake'],
      ['lightning', 'Lightning', 'A crackling blue drake'],
      ['poison', 'Poison', 'A venomous drake'],
    ]),
  },
  { id: 'asi-4', level: 4, title: 'Ability Score Improvement', why: 'Grow one ability', options: ABILITIES },
  { id: 'enemy-6', level: 6, title: 'Favored Enemy (2nd)', why: 'Another foe you know', options: ENEMIES },
  { id: 'terrain-6', level: 6, title: 'Natural Explorer (2nd)', why: 'Another land you know', options: TERRAINS },
  {
    id: 'hunter-7',
    level: 7,
    conclave: 'hunter',
    title: 'Defensive Tactics',
    why: 'Your defense',
    options: options([
      ['escape', 'Escape the Horde', 'Opportunity attacks against you have disadvantage'],
      ['multiattack', 'Multiattack Defense', '+4 armor class against a foe that just hit you'],
      ['steel', 'Steel Will', 'Advantage on saves against fear'],
    ]),
  },
  { id: 'asi-8', level: 8, title: 'Ability Score Improvement', why: 'Grow one ability', options: ABILITIES },
  { id: 'terrain-10', level: 10, title: 'Natural Explorer (3rd)', why: 'A third land you know', options: TERRAINS },
  {
    id: 'hunter-11',
    level: 11,
    conclave: 'hunter',
    title: 'Multiattack',
    why: 'How you strike many foes',
    options: options([
      ['volley', 'Volley', 'Arrows at every foe near one point'],
      ['whirlwind', 'Whirlwind Attack', 'A swing at every foe around you'],
    ]),
  },
  { id: 'asi-12', level: 12, title: 'Ability Score Improvement', why: 'Grow one ability', options: ABILITIES },
  { id: 'enemy-14', level: 14, title: 'Favored Enemy (3rd)', why: 'A third foe you know', options: ENEMIES },
  {
    id: 'hunter-15',
    level: 15,
    conclave: 'hunter',
    title: "Superior Hunter's Defense",
    why: 'Your last line of defense',
    options: options([
      ['evasion', 'Evasion', 'No damage from area effects you dodge'],
      ['tide', 'Stand Against the Tide', 'Turn a missed blow onto another foe'],
      ['uncanny', 'Uncanny Dodge', 'Halve the damage of a hit'],
    ]),
  },
  { id: 'asi-16', level: 16, title: 'Ability Score Improvement', why: 'Grow one ability', options: ABILITIES },
  { id: 'asi-19', level: 19, title: 'Ability Score Improvement', why: 'Grow one ability', options: ABILITIES },
]

export const conclaveOf = (id?: string) => CONCLAVES.find(one => one.id === id || one.name === id)

/** The choices that apply to this hero: the class's own, and those of the conclave chosen (none of another's). */
export const choicesFor = (conclave?: string) => CHOICES.filter(choice => !choice.conclave || choice.conclave === conclaveOf(conclave)?.id)

/** Choices reached but not yet made, in level order. */
export function pendingChoices(level: number, picks: Record<string, string>): ClassChoice[] {
  return choicesFor(picks.conclave).filter(choice => choice.level <= level && !picks[choice.id])
}

/** The option picked for a choice, by name. */
export const pickedName = (choiceId: string, picks: Record<string, string>) => CHOICES.find(one => one.id === choiceId)?.options.find(option => option.id === picks[choiceId])?.name

/** What a level gives, with the chosen conclave's own features in place of the table's placeholders. */
export function featuresAt(level: number, conclave?: string): string[] {
  const own = conclaveOf(conclave)
  const theirs = own?.features[level]?.map(feature => feature.name) ?? []

  return (FEATURES[level] ?? []).flatMap(name => {
    if (name === 'Ranger Conclave') return own ? [`Ranger Conclave: ${own.name}`, ...theirs] : [name]
    if (name === 'Conclave feature') return theirs.length ? theirs : [name]

    return [name]
  })
}

const gameSupport = {
  skyrim: {
    nexusSection: 'skyrim',
    fnisModId: 11811,
  },
  skyrimse: {
    nexusSection: 'skyrimspecialedition',
    fnisModId: 3038,
  },
  skyrimvr: {
    nexusSection: 'skyrimspecialedition',
    fnisModId: 3038,
  }
}

export function isSupported(gameMode: string): boolean {
  return gameSupport[gameMode] !== undefined;
}

export function nexusPageURL(gameMode: string): string {
  const supp = gameSupport[gameMode];
  return `https://www.nexusmods.com/${supp.nexusSection}/mods/${supp.fnisModId}`;
}

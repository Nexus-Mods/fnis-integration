import { IDeployment } from './types';

import * as path from 'path';
import { fs, types, util } from 'vortex-api';

export function fnisDataMod(profileName: string): string {
  return `FNIS Data (${profileName})`;
}

function createFNISMod(api: types.IExtensionApi, modName: string, profile: types.IProfile): Promise<void> {
  const mod: types.IMod = {
    id: modName,
    state: 'installed',
    attributes: {
      name: modName,
    },
    installationPath: modName,
    type: '',
  };

  return new Promise<void>((resolve, reject) => {
    api.events.emit('create-mod', profile.gameId, mod, async (error) => {
      if (error !== null) {
        return reject(error);
      }
      resolve();
    });
  });
}

async function ensureFNISMod(api: types.IExtensionApi, profile: types.IProfile): Promise<string> {
  const state: types.IState = api.store.getState();
  const modName = fnisDataMod(profile.name);
  if (util.getSafe(state, ['persistent', 'mods', profile.gameId, modName], undefined) === undefined) {
    await createFNISMod(api, modName, profile);
  }
  return modName;
}

export function fileChecksum(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    try {
      const { createHash } = require('crypto');
      const hash = createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => {
        hash.update(data);
      });
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

export function stringChecksum(data: string): string {
  const { createHash } = require('crypto');
  const hash = createHash('md5');
  hash.update(data);
  return hash.digest('hex');
}

const expressions = [
  new RegExp(/\\FNIS_.*_List\.txt$/i),
  new RegExp(/\\FNIS.*Behavior\.txt$/i),
  new RegExp(/\\PatchList\.txt$/i),
  new RegExp(/\\skeleton.*\.hkx$/i),
  new RegExp(/\\animations\\.*\.hkx$/i),
];

export async function calcChecksum(basePath: string, deployment: IDeployment): Promise<string> {
  const animationFiles = deployment[''].filter(file =>
    expressions.find(expr => expr.test(file.relPath)) !== undefined);
  
  return stringChecksum(JSON.stringify(animationFiles.map(async file => ({
    name: file.relPath,
    checksum: await fileChecksum(path.join(basePath, 'data', file.relPath)),
  }))));
}

export function fnisTool(state: types.IState, gameId: string): any {
  const tools: { [id: string]: any } = util.getSafe(state,
                            ['settings', 'gameMode', 'discovered', gameId, 'tools'], {});
  return Object.keys(tools).map(id => tools[id]).find(iter => 
      path.basename(iter.path).toLowerCase() === 'generatefnisforusers.exe'
    );
}

async function runFNIS(api: types.IExtensionApi, profile: types.IProfile, interactive: boolean): Promise<void> {
  const state: types.IState = api.store.getState();

  const tool = fnisTool(state, profile.gameId);
  if (tool === undefined) {
    return Promise.reject(new Error('FNIS not installed or not configured'));
  }

  const installPath = util.resolvePath('install', state.settings.mods.paths, profile.gameId);
  const modId = await ensureFNISMod(api, profile);
  const modPath = path.join(installPath, modId);
  const args = [ `RedirectFiles="${modPath}"` ];
  if (!interactive) {
    args.push('InstantExecute=1');
  }
  await api.runExecutable(tool.path, args, { suggestDeploy: false });
}

export default runFNIS;
